// Grid-based flow layout: replaces an earlier Sugiyama-style layered
// approach (assignLayers/orderWithinLayers/refineFlowOrder/
// enforceRowParity/assignFlowCoordinates, all now removed) that
// regressed the pool/non-pool row-alternation invariant three times in a
// row, each time in the seam between "keep rows strictly alternating"
// and "manage aspect ratio." This design sidesteps that seam entirely:
// a fixed-size grid is populated up front, alternation is a STRUCTURAL
// property of the grid itself (row `r` can only ever hold pools if `r`
// is odd, non-pools if `r` is even -- see rowCategory), and every
// optimization move (a swap) only ever exchanges two cells that already
// agree on category (or a blank), so there is no separate "did I keep
// alternation" check to get wrong -- it's true by construction.
//
// Pure, no React/backend deps -- same testing/reuse rationale as
// layoutScore.js/layoutFlow.js (independently testable from a bare
// `node script.mjs`, safe to call from a tight loop).
//
// Coordinate convention matches layoutScore.js/layoutFlow.js exactly:
// raw kkit units, Y-up, a node's x/y is its top-left corner.

import { greedyFeedbackArcSet, computeFlowDepth } from './layoutFlow.js';
import { computeLayoutScore, DEFAULT_SCORE_WEIGHTS, refineFlips } from './layoutScore.js';
import { AUTO_LAYOUT_CELL, computeFlipUpdates } from './layoutSeed.js';

// Which edge types represent actual material/information flow -- same
// scope the previous layered design used, plus funcInput (a summation
// function's own real incoming connections -- see moose_graph.py's
// describe_stim/_function_inputs split, and nodes.jsx's FuncNode).
const FLOW_EDGE_TYPES = new Set(['substrate', 'product', 'chanIn', 'chanOut', 'stimTarget', 'funcInput']);

// Item 3: grid spacing calibrated to fit an icon plus a typical name with
// 50% to spare. Rather than inventing a fresh calibration from scratch,
// this reuses AUTO_LAYOUT_CELL/the "long name gets double width" idea
// App.jsx's own childFootprint already established for the regular
// (non-flow) grid auto-layout -- same visual scale across both actions,
// same already-proven "a really long name gets a second cell" escape
// hatch (a caller's own `sizes` map, built the same way, is what tells
// this module which ids need two cells -- see derivePitches' own
// longNameWidth below).
//
// NOT a fixed module constant -- see computeFlowGroupLayout's own
// `cellUnit` parameter and derivePitches below. AUTO_LAYOUT_CELL (and
// everything scaled off it here) is a plain "kkit unit" count, with no
// idea what a kkit unit maps to in actual screen pixels -- that mapping
// is `scale` (App.jsx), computed FRESH per model file since different
// .g files use wildly different native coordinate spacing (see
// App.jsx's own computeAutoScale). A model whose native coordinates are
// unusually large (verified directly against a real file, Vinu_23Sep_
// with_gr.g: median nearest-neighbor spacing ~591 units, vs.
// Kholodenko.g's own 3.0) drives `scale` down to its own floor -- but a
// FIXED kkit-unit cell pitch, unaware of that, keeps reserving the same
// small number of kkit units regardless, which now maps to far FEWER
// pixels than usual, while an icon's own rendered CSS size doesn't
// shrink to match -- exactly what read as icons "crammed too close...
// in relation to their size and text size." Deriving the pitch from the
// SAME per-model `cellUnit` App.jsx already computes (see its own
// AUTO_LAYOUT_CELL_PX_TARGET) keeps a roughly constant ON-SCREEN cell
// size regardless of a file's own native unit convention, instead of a
// constant kkit-unit one.
function derivePitches(cellUnit) {
  const cellPitch = cellUnit * 1.5;
  return {
    cellPitch,
    // Rows sit half as far apart (vertically) as columns do (horizontally)
    // -- the user's own later feedback, after seeing the layout live: rows
    // read as too spread out. Only the Y axis changes; cellPitch itself
    // (column spacing, and the horizontal hex/brick stagger between rows,
    // which is a horizontal quantity -- see gridToPixels' own comment) is
    // untouched.
    rowPitch: cellPitch / 2,
    longNameWidth: cellUnit * 1.9, // childFootprint's own "long pool name" width is cellUnit*2; a bit of slack for float compare
  };
}

// Item 4: hard cap, width:height.
const ASPECT_RATIO_CAP = 1.1;

// Item 5's loss-function weights -- all start at 1 per the user's own
// instruction, PhosphoWeight raised to 2 (their own answer: "soft, but
// we can increase its weight term to 2"), then raised again to 6 (the
// user's own later feedback: "further increase the weight... for
// sequential placement of successive items like MAPK, MAPK_P, MAPK_PP")
// -- a series cluster's own pairwise distance can otherwise lose out to
// plain connector-length minimization (DistanceWeight's own weight-1
// term) whenever the two pull in different directions, since both terms
// are sums of the same kind of pixel distance and so sit on comparable
// scales; this pushes contiguity to matter meaningfully more than that.
// InputWeight a separate constant (their own answer: not folded into
// FlowWeight). AspectWeight is new (the user's own later feedback item
// 1): a term penalizing max-row-length/numRows, on top of
// ASPECT_RATIO_CAP's own hard backstop in computeGridDimensions -- the
// cap only grows numRows until the CAP is met, it doesn't otherwise
// favor a squarer layout among candidates that already clear it, which
// is what this loss term is for.
export const DEFAULT_FLOW_WEIGHTS = {
  FlowWeight: 1,
  PhosphoWeight: 6,
  DistanceWeight: 1,
  CrossingWeight: 1,
  InputWeight: 1,
  AspectWeight: 1,
};

// The user's own later feedback item 4: "redo Square... almost same
// algorithm, just force the pool vs non-pool row structure." The old
// Square action (layoutSeed.js's optimizeGroupLayout) packed a plain,
// uniform grid with no notion of pool/non-pool rows at all. Rather than
// retrofitting that alternation constraint onto a second, separate grid
// model, Square now reuses this SAME grid/swap engine Flow already has
// (identical alternation guarantee, identical verified-improvement swap
// search, identical discard-if-worse gate, identical refineFlips pass)
// with only its own top-to-bottom DIRECTION bias switched off: FlowWeight
// and InputWeight are the only two terms specifically about flow
// direction (depth-ordered rows; input/output corner bias) -- zeroing
// just those two leaves a compact, connector-length/crossing/overlap/
// area-driven packing (Square's own original goal) that now also
// structurally alternates rows, "almost the same algorithm" in the most
// literal sense: the exact same code, a different weights object.
export const SQUARE_FLOW_WEIGHTS = {
  ...DEFAULT_FLOW_WEIGHTS,
  FlowWeight: 0,
  InputWeight: 0,
};

// Item 10's outer loop.
const MAX_CYCLES = 10;
const TERMINATION_CRITERION = 0.05; // 5%
// A safety ceiling, not the real inner-loop termination -- since every
// accepted swap is now verified to be a genuine improvement (see
// attemptSwapFor), the loop's own natural stopping point is simply
// "trySwapStep found nothing left to improve" (already its own `if
// (!swapped) break`), not a fixed step count. A small fixed cap (this
// used to be 10) cut the search off long before it ran out of real,
// available improvements -- verified directly against Repressilator.g:
// a per-step score trace showed the inner loop still finding genuine
// gains well past step 10 on a freshly-randomized group. This cap only
// exists to bound the rare pathological case (a large group where many
// small improving moves chain together); real runs converge and stop on
// their own well before it.
const MAX_INNER_STEPS_SAFETY_CAP = (idsLength) => Math.max(40, idsLength * 4);

// Item 2's own evaluation: is the full weighted computeLayoutScore
// (length+crossings+overlaps+area) too expensive to run per swap
// candidate, instead of the cheap distance-only proxy? Measured
// directly against this app's own real model fixtures (Kholodenko.g's
// MAPK group, 26 nodes; synSynth7.g's PKC group, 29; Repressilator.g's
// lac_gene, 17): full scoring took 39-421ms end to end and found
// MEANINGFULLY better layouts every time (e.g. MAPK: 703 -> 300) --
// the cheap proxy is genuinely "insufficient information," exactly as
// suspected. But a synthetic worst-case group (every reaction densely
// chained to two pools, far more connected than a typical real
// network) showed the cost balloons fast past ~30-40 total nodes: 30
// nodes ~0.6s, 40 ~1.5s, 50 ~4.8s, 80 ~48s -- full scoring's own
// crossing-detection is quadratic in edge count, evaluated at every
// candidate cell for every candidate entity, so it does NOT scale
// gracefully to a much larger group. Below this limit, use the full
// score (worth the cost, per the timing above); at or above it, fall
// back to the cheap distance-only proxy so an unusually large group
// still gets an answer in a reasonable time instead of the UI hanging.
const FULL_SCORE_SIZE_LIMIT = 40;

// ---------------------------------------------------------------------
// Reused as-is from the previous design (moved here verbatim -- these
// were never about row/layer assignment, only about detecting which
// entities deserve a heuristic nudge in the loss function/sort order).
// ---------------------------------------------------------------------

// A reac/enz/concchan whose substrate/product (or chanIn/chanOut) BOTH
// lie outside this group entirely isn't merely isolated -- it has a
// genuine role, just one that only ever touches this group's own
// boundary: something external feeds it, and it hands off to something
// else external. That's this group's own output interface, so it's
// biased toward the bottom-right in the loss function's inputTerm
// (see computeInputBias) rather than defaulting near the top the way a
// truly disconnected node does.
function detectOutputEntities(ids, rawById, edges) {
  const idSet = new Set(ids);
  const inTypes = new Set(['substrate', 'chanIn']); // pool -> this entity
  const outTypes = new Set(['product', 'chanOut']); // this entity -> pool
  const hasLocalIn = new Set();
  const hasLocalOut = new Set();
  const hasExternalIn = new Set();
  const hasExternalOut = new Set();
  edges.forEach((e) => {
    const type = e.data?.type;
    if (inTypes.has(type) && idSet.has(e.target)) {
      (idSet.has(e.source) ? hasLocalIn : hasExternalIn).add(e.target);
    }
    if (outTypes.has(type) && idSet.has(e.source)) {
      (idSet.has(e.target) ? hasLocalOut : hasExternalOut).add(e.source);
    }
  });
  const outputs = new Set();
  ids.forEach((id) => {
    const type = rawById[id]?.type;
    if (type !== 'reac' && type !== 'enz' && type !== 'concchan') return;
    if (hasLocalIn.has(id) || hasLocalOut.has(id)) return; // has a real local connection -- not purely a boundary pass-through
    if (hasExternalIn.has(id) && hasExternalOut.has(id)) outputs.add(id);
  });
  return outputs;
}

// A pool feeding multiple different reactions/enzymes in OTHER groups is
// likely this group's own output too.
function detectOutputPools(ids, rawById, edges) {
  const idSet = new Set(ids);
  const externalConsumerCount = new Map();
  edges.forEach((e) => {
    const type = e.data?.type;
    if ((type === 'substrate' || type === 'chanIn') && idSet.has(e.source) && !idSet.has(e.target)) {
      externalConsumerCount.set(e.source, (externalConsumerCount.get(e.source) ?? 0) + 1);
    }
  });
  const outputs = new Set();
  ids.forEach((id) => {
    if (rawById[id]?.type !== 'pool') return;
    if ((externalConsumerCount.get(id) ?? 0) >= 2) outputs.add(id);
  });
  return outputs;
}

// True when `longer` extends `shorter` by an underscore-delimited suffix
// -- "MAPK" -> "MAPK_P" -> "MAPK_PP" (a phosphorylation series).
function isSeriesExtension(shorter, longer) {
  if (shorter.length === 0 || !longer.startsWith(shorter)) return false;
  const suffix = longer.slice(shorter.length);
  return suffix.startsWith('_') && suffix.length > 1;
}

// Clusters pools into phosphorylation/binding series by name via
// union-find, so a 3+ step series ends up as one cluster transitively.
function detectSeriesClusters(ids, rawById) {
  const pools = ids.filter((id) => rawById[id]?.type === 'pool');
  const parent = new Map(pools.map((id) => [id, id]));
  function find(id) {
    while (parent.get(id) !== id) id = parent.get(id);
    return id;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (let i = 0; i < pools.length; i++) {
    for (let j = i + 1; j < pools.length; j++) {
      const nameA = rawById[pools[i]]?.name ?? '';
      const nameB = rawById[pools[j]]?.name ?? '';
      const [shorter, longer] = nameA.length <= nameB.length ? [nameA, nameB] : [nameB, nameA];
      if (isSeriesExtension(shorter, longer)) union(pools[i], pools[j]);
    }
  }
  const clusters = new Map();
  pools.forEach((id) => {
    const root = find(id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(id);
  });
  return [...clusters.values()].filter((c) => c.length > 1);
}

// ---------------------------------------------------------------------
// Grid dimensions (items 4 & 6)
// ---------------------------------------------------------------------

// Item 6, verbatim: enough columns/rows that there's always room to
// place something at the edge of the layout -- a floor, not a cap (see
// fitRowCounts below, which can grow numRows further if the floor isn't
// actually enough to hold everything).
function baselineGridSize(numPools, numNonPools) {
  const numCols = Math.ceil(Math.max(Math.sqrt(numPools), Math.sqrt(numNonPools))) + 2;
  const numRows = 2 * numCols - 2;
  return { numCols, numRows };
}

// How many pool-rows/non-pool-rows are actually needed to hold `count`
// items at up to `capacityPerRow` per row (capacity already accounts for
// the mid-row blank and any double-width long names via the caller's own
// `wideCount` -- an extra half-slot per wide item).
function neededRows(count, wideCount, capacityPerRow) {
  const effectiveSlots = count + wideCount; // a wide item costs one extra slot
  return Math.max(1, Math.ceil(effectiveSlots / Math.max(1, capacityPerRow)));
}

// Items 4 & 6 combined. `numRows = 2*rowsPerSide` and rowPitch =
// cellPitch/2 (see derivePitches' own comment) together mean the
// realized PIXEL aspect ratio reduces to a simple ratio: (effective
// columns used) / rowsPerSide -- effective columns used, NOT numCols
// itself.
//
// numCols only sets a CAPACITY ceiling per row (capacityPerRow =
// numCols-2), used to decide how many rows are NEEDED -- it is not a
// promise that every row actually reaches that width. fillSide's own
// distributeSlotCounts spreads each side's real content EVENLY across
// however many rows that side ends up with, so the widest row is
// typically ceil(totalSlots/rowsPerSide), which is routinely well below
// capacityPerRow whenever rowsPerSide was rounded up to satisfy the
// OTHER (denser) side, or simply because an even split rarely lands
// exactly on the capacity ceiling. Using numCols itself for the aspect
// target systematically overestimates the real rendered width -- verified
// directly: a real 26-node group's own numCols/rowsPerSide came out to
// an exact, on-target 1:1, but the group's REAL rendered bounding box
// still measured 0.59 (much taller than wide), because its widest actual
// row only ever used half of numCols' own nominal capacity.
//
// effectiveColsFor(numCols, rowsPerSide) below is what actually answers
// "how wide will this render" -- the same distributeSlotCounts spread
// fillSide itself will use, plus 1 for the mid-row blank every row
// reserves (see fillSide's own comment) -- and is what both directions
// of the search actually target now, instead of the nominal numCols.
function computeGridDimensions(numPools, numNonPools, numWidePools, numWideNonPools) {
  const { numCols: baselineCols } = baselineGridSize(numPools, numNonPools);
  const poolSlots = numPools + numWidePools;
  const nonPoolSlots = numNonPools + numWideNonPools;

  // A row genuinely needs at least one real item to avoid becoming an
  // empty gap (see fillSide's own distributeSlotCounts comment) -- so
  // rowsPerSide can never legitimately exceed the SPARSER side's own
  // total count, no matter how large the denser side's own need is.
  // When the two counts are this far apart (typically only a handful of
  // total nodes), a square-ish aspect just isn't fully achievable --
  // better to accept a wider-than-ideal result than to manufacture a
  // phantom empty row that reads as an alternation violation once
  // rendered (verified directly: a 3-pool/1-non-pool group needing 2
  // pool rows forced the single non-pool item into 2 rows too, leaving
  // one of them empty).
  const rowsPerSideCeiling = Math.max(1, Math.min(numPools || 1, numNonPools || 1));

  function rowsPerSideFor(numCols) {
    const capacityPerRow = Math.max(1, numCols - 2);
    const poolRowsNeeded = neededRows(numPools, numWidePools, capacityPerRow);
    const nonPoolRowsNeeded = neededRows(numNonPools, numWideNonPools, capacityPerRow);
    return Math.min(Math.max(poolRowsNeeded, nonPoolRowsNeeded, 1), rowsPerSideCeiling);
  }

  // +1 for the mid-row blank -- every row reserves one regardless of how
  // few real items it holds, so it's part of the real rendered width too.
  function effectiveColsFor(rowsPerSide) {
    const poolMaxRow = Math.max(...distributeSlotCounts(poolSlots, rowsPerSide));
    const nonPoolMaxRow = Math.max(...distributeSlotCounts(nonPoolSlots, rowsPerSide));
    return Math.max(poolMaxRow, nonPoolMaxRow) + 1;
  }

  let numCols = baselineCols;
  let rowsPerSide = rowsPerSideFor(numCols);
  let aspect = effectiveColsFor(rowsPerSide) / rowsPerSide;

  if (aspect > ASPECT_RATIO_CAP) {
    // Too WIDE at the baseline (the common case for a small/sparse
    // group, which fits in very few rows regardless of numCols) --
    // grow rows to bring the ratio down, exactly as before.
    for (let guard = 0; guard < 20 && rowsPerSide < rowsPerSideCeiling; guard++) {
      rowsPerSide += 1;
      aspect = effectiveColsFor(rowsPerSide) / rowsPerSide;
      if (aspect <= ASPECT_RATIO_CAP) break;
    }
  } else {
    // Too TALL (or already fine) -- grow columns toward the cap without
    // ever exceeding it. Growing numCols can only ever raise capacityPerRow
    // (so rowsPerSide only shrinks or holds steady) while never reducing
    // how many real items there are, so effectiveCols/rowsPerSide is
    // monotonically non-decreasing in numCols here too -- a forward scan
    // is still valid, just measured against the REAL rendered width
    // instead of the nominal one.
    let bestCols = numCols;
    let bestRowsPerSide = rowsPerSide;
    let bestAspect = aspect;
    for (let guard = 0; guard < 60 && bestAspect < ASPECT_RATIO_CAP; guard++) {
      const candidateCols = bestCols + 1;
      const candidateRows = rowsPerSideFor(candidateCols);
      const candidateAspect = effectiveColsFor(candidateRows) / candidateRows;
      if (candidateAspect > ASPECT_RATIO_CAP) break; // stepped past it -- the PREVIOUS candidate was the best one under the cap
      bestCols = candidateCols;
      bestRowsPerSide = candidateRows;
      bestAspect = candidateAspect;
    }
    numCols = bestCols;
    rowsPerSide = bestRowsPerSide;
  }
  return { numCols, numRows: 2 * rowsPerSide, rowsPerSide };
}

// ---------------------------------------------------------------------
// Flow order + input/output bias (feeds both the initial sort key and
// the loss function's inputTerm/flowTerm)
// ---------------------------------------------------------------------

// Primary sort key (flow depth, output-boundary entities/pools pushed to
// the deep end, a genuine zero-input stim pulled to the shallow end) and
// per-node input/output bias for the loss function's inputTerm, computed
// once and reused by both initial placement and scoring.
function computeFlowOrderAndBias(ids, edges, rawById) {
  const flowEdges = edges.filter((e) => FLOW_EDGE_TYPES.has(e.data?.type));
  const { backEdgeIndices } = greedyFeedbackArcSet(ids, flowEdges);
  const depth = computeFlowDepth(ids, flowEdges, backEdgeIndices);
  const outputEntities = detectOutputEntities(ids, rawById, edges);
  const outputPools = detectOutputPools(ids, rawById, edges);
  const maxDepth = Math.max(0, ...ids.map((id) => depth.get(id) ?? 0));

  const flowOrder = new Map();
  const inputBias = new Map();
  ids.forEach((id) => {
    const isOutput = outputEntities.has(id) || outputPools.has(id);
    const isGenuineStim = rawById[id]?.type === 'stim';
    if (isOutput) {
      flowOrder.set(id, maxDepth + 1);
      inputBias.set(id, -1); // wants to be FAR from top-left
    } else if (isGenuineStim) {
      flowOrder.set(id, -1);
      inputBias.set(id, 1); // wants to be NEAR top-left
    } else {
      flowOrder.set(id, depth.get(id) ?? 0);
      inputBias.set(id, 0);
    }
  });
  return { flowOrder, inputBias };
}

// Secondary sort key: position within a phospho/binding series (shorter
// name first), 0 for anything not in a multi-member cluster -- "two
// competing sort keys," per the user's own answer, no anchoring.
function computePhosphoKey(ids, rawById, seriesClusters) {
  const key = new Map(ids.map((id) => [id, 0]));
  seriesClusters.forEach((cluster) => {
    const sorted = [...cluster].sort((a, b) => (rawById[a]?.name?.length ?? 0) - (rawById[b]?.name?.length ?? 0));
    sorted.forEach((id, i) => key.set(id, i + 1));
  });
  return key;
}

// ---------------------------------------------------------------------
// Grid data structure
// ---------------------------------------------------------------------

// Row `r` holds pools when `r` is odd, non-pools when `r` is even --
// item 1 ("row zero is even, should always be non-pools") as a
// STRUCTURAL property of the grid itself, not something derived and
// re-checked after placement: buildInitialGrid only ever generates pool
// row indices via `2*i+1` and non-pool row indices via `2*i` (see
// poolRowIndices/nonPoolRowIndices below), and every later move
// (trySwapStep) only ever relocates an entity among rows of its own
// already-fixed category. There is no code path that could put a pool
// on an even row or a non-pool on an odd one, rather than a check that
// catches it after the fact.
function categoryOf(id, rawById) {
  return rawById[id]?.type === 'pool' ? 'pool' : 'nonpool';
}

// A tiny wrapper around a Map<'row,col', cell> plus a reverse id->{row,col}
// index -- cheap enough for the group sizes this app deals with (tens to
// low hundreds of children) that a flat Map beats a real 2D array for
// how much simpler it makes "is this row/col in bounds" (nothing to
// bounds-check; an absent key just means blank).
function makeGrid() {
  const cells = new Map(); // key "r,c" -> { id } | { blank: true } | { overflowOf: id }
  const posOf = new Map(); // id -> { row, col } (primary cell only)
  const key = (r, c) => `${r},${c}`;
  return {
    get(r, c) {
      return cells.get(key(r, c));
    },
    setEntity(r, c, id, wide) {
      cells.set(key(r, c), { id });
      posOf.set(id, { row: r, col: c });
      if (wide) cells.set(key(r, c + 1), { overflowOf: id });
    },
    setBlank(r, c) {
      cells.set(key(r, c), { blank: true });
    },
    clear(r, c) {
      cells.delete(key(r, c));
    },
    posOf(id) {
      return posOf.get(id);
    },
    isWide(id) {
      const p = posOf.get(id);
      if (!p) return false;
      return cells.get(key(p.row, p.col + 1))?.overflowOf === id;
    },
    // Every occupied (non-blank, non-overflow) cell's own id, in
    // insertion order -- used by the optimizer to iterate candidates.
    entityIds() {
      return [...posOf.keys()];
    },
  };
}

// ---------------------------------------------------------------------
// Initial placement (items 7 & 8)
// ---------------------------------------------------------------------

// Fills one "side" of the grid (all pool rows, or all non-pool rows)
// left to right in `sortedIds` order, wrapping to a new row once
// position exceeds numCols-2, with one blank inserted at the row's own
// midpoint. `isWide(id)` marks a long-named pool as needing two cells.
// Distributes `totalSlots` as evenly as possible across `numRows` rows --
// every row gets floor(totalSlots/numRows) or one more, with the extra
// handed to the first `totalSlots % numRows` rows. Guarantees every row
// gets at least one slot whenever totalSlots >= numRows -- a flat
// ceil(totalSlots/numRows) capacity-per-row threshold does NOT guarantee
// this (verified live against Repressillator.g's own lac_gene group: 8
// non-pool items at a flat capacity of ceil(8/5)=2 filled only 4 of the
// 5 allocated rows, leaving the 5th genuinely empty -- which, like the
// Kholodenko.g case computeGridDimensions' own comment describes, reads
// as an alternation violation once rendered, since an empty row
// contributes no visible content between two real rows of the same
// category).
function distributeSlotCounts(totalSlots, numRows) {
  const base = Math.floor(totalSlots / numRows);
  const extra = totalSlots % numRows;
  return Array.from({ length: numRows }, (_, i) => base + (i < extra ? 1 : 0));
}

function fillSide(grid, sortedIds, rows, numCols, isWide) {
  // One blank reserved at the same column (the OVERALL grid's own
  // midpoint, shared by every row regardless of which side it belongs
  // to, for a visually consistent "blank column" down the whole grid)
  // in every row of this side BEFORE any entity is placed -- item 7/8's
  // "intersperse a blank in the middle of each row, to simplify
  // shuffling." Reserving it up front (rather than inserting it after
  // the fact once a row's real content is known) means placement only
  // ever has to skip over an already-blank cell, never overwrite one
  // that was already given to a real entity.
  const blankCol = Math.floor(numCols / 2);
  rows.forEach((row) => grid.setBlank(row, blankCol));

  const totalSlots = sortedIds.reduce((sum, id) => sum + (isWide(id) ? 2 : 1), 0);
  const rowTargets = distributeSlotCounts(totalSlots, rows.length);

  let rowIdx = 0;
  let row = rows[0];
  let col = 0;
  let placedInRow = 0;

  function skipBlank() {
    if (col === blankCol) col += 1;
  }

  sortedIds.forEach((id) => {
    const wide = isWide(id);
    skipBlank();
    if (placedInRow >= rowTargets[rowIdx] && rowIdx < rows.length - 1) {
      rowIdx += 1;
      row = rows[rowIdx];
      col = 0;
      placedInRow = 0;
      skipBlank();
    }
    // A wide entity's own SECOND cell landing exactly on the reserved
    // blank would silently overwrite it -- shift one more column first.
    if (wide && col + 1 === blankCol) col += 1;
    grid.setEntity(row, col, id, wide);
    col += wide ? 2 : 1;
    placedInRow += wide ? 2 : 1;
  });
}

// Item 8: for each already-placed pool (in sort order), find its first
// not-yet-placed connected non-pool and place it next; once placed, a
// non-pool is out of contention for later pools (the user's own answer
// to Q4). Leftover, unconnected non-pools fill remaining slots in
// sort-key order afterward, same as pools' own "rest at random"
// treatment.
function orderNonPoolsByPoolConnection(sortedPoolIds, sortedNonPoolIds, edges) {
  const idSet = new Set([...sortedPoolIds, ...sortedNonPoolIds]);
  const neighborsOf = new Map(sortedNonPoolIds.map((id) => [id, []]));
  edges.forEach((e) => {
    if (!FLOW_EDGE_TYPES.has(e.data?.type)) return;
    if (!idSet.has(e.source) || !idSet.has(e.target)) return;
    if (neighborsOf.has(e.target)) neighborsOf.get(e.target).push(e.source);
    if (neighborsOf.has(e.source)) neighborsOf.get(e.source).push(e.target);
  });
  const placed = new Set();
  const ordered = [];
  sortedPoolIds.forEach((poolId) => {
    for (const nonPoolId of sortedNonPoolIds) {
      if (placed.has(nonPoolId)) continue;
      if (!neighborsOf.get(nonPoolId).includes(poolId)) continue;
      placed.add(nonPoolId);
      ordered.push(nonPoolId);
      break;
    }
  });
  sortedNonPoolIds.forEach((id) => {
    if (!placed.has(id)) ordered.push(id);
  });
  return ordered;
}

function buildInitialGrid({ ids, edges, rawById, sizes, longNameWidth }) {
  const pools = ids.filter((id) => rawById[id]?.type === 'pool');
  const nonPools = ids.filter((id) => rawById[id]?.type !== 'pool');
  const isWide = (id) => (sizes.get(id)?.width ?? 0) > longNameWidth;
  const numWidePools = pools.filter(isWide).length;
  const numWideNonPools = nonPools.filter(isWide).length;

  const { numCols, rowsPerSide } = computeGridDimensions(pools.length, nonPools.length, numWidePools, numWideNonPools);

  const { flowOrder } = computeFlowOrderAndBias(ids, edges, rawById);
  const seriesClusters = detectSeriesClusters(ids, rawById);
  const phosphoKey = computePhosphoKey(ids, rawById, seriesClusters);
  const sortKey = (id) => [flowOrder.get(id) ?? 0, phosphoKey.get(id) ?? 0];
  const compareSortKey = (a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1];
  };

  const sortedPools = [...pools].sort(compareSortKey);
  const sortedNonPools = orderNonPoolsByPoolConnection(sortedPools, [...nonPools].sort(compareSortKey), edges);

  const grid = makeGrid();
  const poolRowIndices = Array.from({ length: rowsPerSide }, (_, i) => 2 * i + 1);
  const nonPoolRowIndices = Array.from({ length: rowsPerSide }, (_, i) => 2 * i);
  fillSide(grid, sortedPools, poolRowIndices, numCols, isWide);
  // A long-named entity gets the same double-cell treatment on EITHER
  // side, not just pools -- an enzyme's own real rendered width also
  // grows with name length (see App.jsx's childFootprint, which now
  // gives a long-named enzyme's `sizes` entry the same doubled width a
  // long-named pool already gets); this used to hardcode `() => false`
  // for the non-pool side, so a long-named enzyme's neighbor got no
  // extra room at all and visibly overlapped it once rendered.
  fillSide(grid, sortedNonPools, nonPoolRowIndices, numCols, isWide);

  return { grid, numCols, numRows: Math.max(...poolRowIndices, ...nonPoolRowIndices, 0) + 1 };
}

// ---------------------------------------------------------------------
// Grid cell -> pixel coordinates
// ---------------------------------------------------------------------

// Item 2: successive rows offset by half the COLUMN pitch (a horizontal
// quantity -- see derivePitches' own comment on why this stays tied to
// column spacing, not row spacing, even though the two used to be the
// same value), the same hex/brick pattern the previous design used --
// one uniform pitch for the whole grid (not content-driven per row) is
// what makes an odd row's half-shift actually nestle consistently
// between the rows above and below it regardless of how full any
// particular row is.
function gridToPixels(grid, numRows, cellPitch, rowPitch) {
  const positions = new Map();
  for (let row = 0; row < numRows; row++) {
    const shift = row % 2 === 1 ? cellPitch / 2 : 0;
    const y = -row * rowPitch;
    for (const id of grid.entityIds()) {
      const p = grid.posOf(id);
      if (p.row !== row) continue;
      positions.set(id, { x: shift + p.col * cellPitch, y });
    }
  }
  return positions;
}

// ---------------------------------------------------------------------
// Loss function (item 5)
// ---------------------------------------------------------------------

function buildScoreNodes(ids, positions, sizes, rawById, flips, lockedFlipped) {
  return ids.map((id) => {
    const p = positions.get(id);
    const size = sizes.get(id) ?? { width: AUTO_LAYOUT_CELL, height: AUTO_LAYOUT_CELL };
    const raw = rawById[id];
    return {
      id,
      x: p.x,
      y: p.y,
      width: size.width,
      height: size.height,
      flipped: flips[id] !== undefined ? flips[id] : lockedFlipped(id),
      parentSide: raw?.parentSide,
      type: raw?.type,
    };
  });
}

// flowTerm: penalizes a real edge that doesn't point strictly toward a
// deeper row (top-to-bottom is the expected reading direction) --
// row index increases downward (see gridToPixels), so "deeper" means a
// strictly larger row index.
function computeFlowTerm(edges, grid) {
  let penalty = 0;
  edges.forEach((e) => {
    if (!FLOW_EDGE_TYPES.has(e.data?.type)) return;
    const sp = grid.posOf(e.source);
    const tp = grid.posOf(e.target);
    if (!sp || !tp) return;
    if (tp.row <= sp.row) penalty += sp.row - tp.row + 1;
  });
  return penalty;
}

// phosphoTerm: sum of pairwise pixel distance within each series cluster
// -- soft pull toward contiguity, not a guarantee (the user's own
// answer to Q2).
function computePhosphoTerm(seriesClusters, positions) {
  let total = 0;
  seriesClusters.forEach((cluster) => {
    for (let i = 0; i < cluster.length; i++) {
      for (let j = i + 1; j < cluster.length; j++) {
        const a = positions.get(cluster[i]);
        const b = positions.get(cluster[j]);
        if (!a || !b) continue;
        total += Math.hypot(a.x - b.x, a.y - b.y);
      }
    }
  });
  return total;
}

// inputTerm: distance from the top-left corner, signed by inputBias --
// positive bias (a genuine input-like stim) is penalized for being far;
// negative bias (a detected output boundary) is REWARDED for being far
// (see computeFlowOrderAndBias's own comment) -- one symmetric term
// covers both ends instead of needing a separate "output" weight.
function computeInputTerm(ids, positions, inputBias, originX, originY) {
  let total = 0;
  ids.forEach((id) => {
    const bias = inputBias.get(id) ?? 0;
    if (bias === 0) return;
    const p = positions.get(id);
    if (!p) return;
    const dist = Math.hypot(p.x - originX, p.y - originY);
    total += bias * dist;
  });
  return total;
}

// Item 1 (later feedback): max row length (largest item-count in any
// single row) divided by number of rows -- a soft preference for a
// squarer layout among candidates that already clear ASPECT_RATIO_CAP's
// own hard backstop (see computeGridDimensions), penalizing a layout
// that's technically within the cap but still lopsided row-to-row.
function computeAspectTerm(grid, numRows) {
  const counts = new Array(numRows).fill(0);
  grid.entityIds().forEach((id) => {
    const p = grid.posOf(id);
    if (p && p.row < numRows) counts[p.row] += 1;
  });
  const maxRowLength = Math.max(0, ...counts);
  return maxRowLength / Math.max(1, numRows);
}

function computeTotalLoss({ ids, edges, rawById, sizes, grid, numRows, seriesClusters, inputBias, lockedFlipped, weights, cellPitch, rowPitch }) {
  const positions = gridToPixels(grid, numRows, cellPitch, rowPitch);
  const xById = {};
  ids.forEach((id) => {
    xById[id] = positions.get(id)?.x ?? 0;
  });
  const lockedIds = new Set(); // locked children are excluded from `ids` entirely by the caller
  const flips = computeFlipUpdates(ids, rawById, edges, xById, lockedIds);
  const scoreEdges = edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.data?.type }));
  // A pass through the layout for useful flips BEFORE estimating the
  // full layout score -- computeFlipUpdates' own heuristic (above,
  // "which side do my connected pools average out to") is a good, cheap
  // starting guess but was never actually checked against the real
  // score, so it can (and, verified directly against this app's own real
  // model fixtures, regularly did) leave a flip on the table that would
  // provably reduce the score, or apply one that doesn't actually help.
  // layoutScore.js's own refineFlips tries each flippable node's other
  // orientation and keeps it only when the full score genuinely
  // improves -- exact, not another heuristic, since one node's own flip
  // never affects any other node's own attachment points (see
  // EDGE_ATTACHMENT/resolveSide), so evaluating them one at a time has
  // no cross-node interaction to get wrong. Gated by the same size limit
  // as the swap search's own full-score mode (see its own comment) for
  // the same reason: this is O(flippable nodes) additional
  // computeLayoutScore calls, worth it for a realistically-sized group,
  // not for a pathologically large one.
  const useRefinedFlips = ids.length <= FULL_SCORE_SIZE_LIMIT;
  const preRefineNodes = buildScoreNodes(ids, positions, sizes, rawById, flips, lockedFlipped).map((n) => ({
    ...n,
    canFlip: n.type === 'reac' || n.type === 'enz' || n.type === 'concchan',
  }));
  const refinedFlips = useRefinedFlips ? refineFlips(preRefineNodes, scoreEdges, DEFAULT_SCORE_WEIGHTS) : flips;
  const scoreNodes = buildScoreNodes(ids, positions, sizes, rawById, refinedFlips, lockedFlipped);
  // Item 7 fix: keep BOTH the internal search score (this module's own
  // richer Flow/Phospho/Distance/Crossing/Input/Aspect terms, used only
  // to drive which swaps the optimizer accepts as "progress") and the
  // plain display score (length+crossings+overlaps+area via
  // DEFAULT_SCORE_WEIGHTS, no other weighting) -- the SAME metric
  // App.jsx's own selectedGroupScore shows the user as "Layout score",
  // and the same one optimizeGroupLayout's own discard gate already
  // compares against. The two are different formulas over different
  // terms, so a run that improves the first can still look worse on the
  // second -- computeFlowGroupLayout's own final discard-if-worse gate
  // (item 11) needs the SECOND number, not this one, to actually protect
  // what the user is watching.
  const displayScore = computeLayoutScore(scoreNodes, scoreEdges, DEFAULT_SCORE_WEIGHTS);
  const { length, crossings, weighted: displayWeighted } = displayScore;

  const flowTerm = computeFlowTerm(edges, grid);
  const phosphoTerm = computePhosphoTerm(seriesClusters, positions);
  const minX = Math.min(...ids.map((id) => positions.get(id)?.x ?? 0));
  const maxY = Math.max(...ids.map((id) => positions.get(id)?.y ?? 0)); // Y-up: top-left is the MAX y
  const inputTerm = computeInputTerm(ids, positions, inputBias, minX, maxY);
  const aspectTerm = computeAspectTerm(grid, numRows);

  const total =
    weights.FlowWeight * flowTerm +
    weights.PhosphoWeight * phosphoTerm +
    weights.DistanceWeight * length +
    weights.CrossingWeight * crossings +
    weights.InputWeight * inputTerm +
    weights.AspectWeight * aspectTerm;
  return { total, positions, flips: refinedFlips, displayWeighted };
}

// ---------------------------------------------------------------------
// Optimization loop (item 10)
// ---------------------------------------------------------------------

// Cheap, distance-only gradient direction for `id`: the vector from its
// current pixel position to the (unweighted) centroid of its real
// FLOW_EDGE_TYPES neighbors' current pixel positions -- per the user's
// own instruction, only the distance term drives the gradient's
// direction; the full loss (computeTotalLoss) is what decides whether a
// candidate move is actually kept.
function buildNeighborIndex(ids, edges) {
  const idSet = new Set(ids);
  const neighbors = new Map(ids.map((id) => [id, []]));
  edges.forEach((e) => {
    if (!FLOW_EDGE_TYPES.has(e.data?.type)) return;
    if (!idSet.has(e.source) || !idSet.has(e.target)) return;
    neighbors.get(e.source).push(e.target);
    neighbors.get(e.target).push(e.source);
  });
  return neighbors;
}

function gradientFor(id, positions, neighborsOf) {
  const own = positions.get(id);
  const neigh = neighborsOf.get(id) ?? [];
  if (!own || neigh.length === 0) return { dx: 0, dy: 0, mag: 0 };
  let sx = 0;
  let sy = 0;
  neigh.forEach((n) => {
    const p = positions.get(n);
    if (p) {
      sx += p.x;
      sy += p.y;
    }
  });
  const cx = sx / neigh.length;
  const cy = sy / neigh.length;
  const dx = cx - own.x;
  const dy = cy - own.y;
  return { dx, dy, mag: Math.hypot(dx, dy) };
}

// One inner step: find the largest-gradient entity NOT already tried
// this cycle, find its best legal swap partner (same category, or
// blank), swap. Mutates `grid` in place. Returns the swapped ids (for
// the caller's own localized gradient-cache update) or null if nothing
// was worth swapping.
//
// `excludeIds` is what actually makes each step in one cycle (there can
// now be many -- see MAX_INNER_STEPS_SAFETY_CAP) sample a DIFFERENT
// object, per the user's own instruction ("the inner loop is expected to
// pick different
// X and Ys each time... skip [the] termination criterion" for it) --
// without this, a swap that only partially closes an entity's own
// gradient (its best available partner isn't exactly at its neighbors'
// centroid, which is the common case) leaves it the largest-gradient
// entity again on the very next step, so it keeps winning and the same
// one or two entities just shuffle between themselves for the whole
// inner loop while everything else in the group -- including a plain
// pool or reaction sitting right next to an available blank, a genuinely
// easy improving move -- never gets examined at all (verified directly
// against Repressilator.g: several such simple, clearly-improving
// blank-adjacent moves were never attempted before this fix). The
// caller resets this fresh each OUTER cycle, not just once for the whole
// run, since a full cycle's worth of swaps changes enough of the
// geometry that every object deserves a fresh look next cycle.
function trySwapStep(grid, ids, rawById, lockedIds, positions, neighborsOf, numCols, excludeIds, scoreCtx) {
  // Deliberately NOT flip-aware: an earlier version of this fix threaded
  // a live-refreshed flip map into fullScoreGain's own per-candidate
  // scoring, on the theory that a swap decision should see accurate
  // flip info. Measured directly against this app's own real model
  // fixtures (same starting scatter, same code otherwise), that
  // consistently produced a WORSE final layout on 2 of 3 -- baking a
  // flip-dependent term into a position search's own step-by-step gain
  // estimate makes the scoring landscape shift mid-search as flips
  // change, which destabilizes the greedy search's own trajectory (a
  // real, general risk: optimizing against a moving target). The
  // correct place for flips is a separate, VERIFIED pass run once right
  // before a score is actually estimated/compared -- see layoutScore.js's
  // own refineFlips, used by computeTotalLoss -- not folded into the
  // position search that produces the candidate in the first place.

  // Every untried, unlocked, nonzero-gradient candidate's OWN best legal
  // move is evaluated exactly once this step, and the single largest
  // genuine gain across ALL of them wins -- not "try in gradient-
  // magnitude order, take the first one that has any legal move at all."
  // That earlier design had two real problems: (1) it wasn't actually
  // "longest swap first" -- gradient magnitude is a proxy for how far an
  // entity wants to move, not for how much its best LEGAL move actually
  // gains, so a lower-magnitude entity sitting right next to an ideal
  // blank could easily have a bigger real gain than the top-magnitude
  // entity, and never got the chance since the top one succeeding first
  // ended the step; (2) whenever few or no candidates had ANY legal
  // improving move (the common case as a cycle nears convergence), the
  // old code kept trying candidate after candidate until one worked or
  // all were exhausted -- effectively rescanning most of the group on
  // MANY steps in a row, which is what made a single cycle scale as
  // roughly (group size)^3 for a large group. Evaluating every candidate
  // exactly once per step is consistently one linear pass (each still
  // O(candidateRows*numCols) internally), no worse than the old code's
  // typical case and far better than its worst case -- verified directly:
  // this alone made Kholodenko.g's own MAPK group run 51ms -> 22ms, with
  // a BETTER final score, not just a faster one.
  const candidateIds = ids.filter((id) => !lockedIds.has(id) && !excludeIds.has(id) && gradientFor(id, positions, neighborsOf).mag > 0);

  let globalBest = null; // { id, key: {row,col}, isBlank }
  let globalBestGain = 0;
  candidateIds.forEach((id) => {
    const found = bestCandidateFor(id);
    if (found && found.gain > globalBestGain) {
      globalBestGain = found.gain;
      globalBest = { id, key: found.key, isBlank: found.isBlank };
    }
  });
  if (!globalBest) return null;

  const { id: bestId, key, isBlank } = globalBest;
  const own = grid.posOf(bestId);
  const { row: pRow, col: pCol } = key;
  const wide = grid.isWide(bestId);
  if (isBlank) {
    grid.clear(own.row, own.col);
    if (wide) grid.clear(own.row, own.col + 1);
    grid.setBlank(own.row, own.col);
    grid.setEntity(pRow, pCol, bestId, wide);
    return [bestId];
  }
  const partnerCell = grid.get(pRow, pCol);
  const partnerId = partnerCell.id;
  const partnerWide = grid.isWide(partnerId);
  grid.clear(own.row, own.col);
  if (wide) grid.clear(own.row, own.col + 1);
  grid.clear(pRow, pCol);
  if (partnerWide) grid.clear(pRow, pCol + 1);
  grid.setEntity(pRow, pCol, bestId, wide);
  grid.setEntity(own.row, own.col, partnerId, partnerWide);
  return [bestId, partnerId];

  function shift(row) {
    return row % 2 === 1 ? scoreCtx.cellPitch / 2 : 0;
  }

  // Sum of distance from `pos` to each of `neighborIds`' own CURRENT
  // pixel position -- the same distance-only measure gradientFor's own
  // magnitude is built from, just evaluated at an arbitrary candidate
  // point instead of only at an entity's own current position. Used as
  // the gain metric for a group at or above FULL_SCORE_SIZE_LIMIT (see
  // its own comment); below that, fullScoreGain is used instead.
  function costAt(pos, neighborIds) {
    let sum = 0;
    neighborIds.forEach((n) => {
      const p = positions.get(n);
      if (p) sum += Math.hypot(p.x - pos.x, p.y - pos.y);
    });
    return sum;
  }

  // Item 2's evaluation, now the default for any group small enough to
  // afford it (see FULL_SCORE_SIZE_LIMIT): the SAME gain concept, but
  // measured with the full weighted computeLayoutScore (length+
  // crossings+overlaps+area) instead of local distance-only cost --
  // `overrides` maps id -> the position it would have AFTER the
  // candidate swap (only the 1-2 moved ids; every other id keeps its
  // current position). Verified directly against this app's own real
  // fixtures that this finds MEANINGFULLY better layouts than the cheap
  // proxy (e.g. Kholodenko.g's MAPK group: final score 703 -> 300) --
  // the cheap distance-only measure is blind to crossings/overlaps/area
  // entirely, so a swap that clearly removes a crossing but doesn't
  // shorten any one connector never looked like an improvement to it.
  function fullScoreGain(overrides) {
    const { sizes, lockedFlipped, localEdges } = scoreCtx;
    const scoreNodes = ids.map((id) => {
      const p = overrides.get(id) ?? positions.get(id);
      const size = sizes.get(id) ?? { width: AUTO_LAYOUT_CELL, height: AUTO_LAYOUT_CELL };
      const raw = rawById[id];
      return { id, x: p.x, y: p.y, width: size.width, height: size.height, flipped: lockedFlipped(id), parentSide: raw?.parentSide, type: raw?.type };
    });
    const scoreEdges = localEdges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.data?.type }));
    return computeLayoutScore(scoreNodes, scoreEdges, DEFAULT_SCORE_WEIGHTS).weighted;
  }

  // Pure evaluation, no mutation: this entity's own single best legal
  // candidate cell (same category, or a blank), scored by its real net
  // effect, or null if nothing available actually improves anything for
  // this entity.
  function bestCandidateFor(bestId) {
    const own = grid.posOf(bestId);
    const category = categoryOf(bestId, rawById);
    const ownPos = positions.get(bestId);
    const ownNeighbors = neighborsOf.get(bestId) ?? [];
    const ownCostBefore = costAt(ownPos, ownNeighbors);
    const useFullScore = ids.length <= FULL_SCORE_SIZE_LIMIT;
    const baselineFullScore = useFullScore ? fullScoreGain(new Map()) : 0;
    // If bestId is the ONLY real entity left in its own row, a move to a
    // blank elsewhere would drain that row to zero real content -- legal
    // per the swap rule itself (still the same category, or a blank), but
    // it silently breaks the "every row has real content" property the
    // whole strict-alternation rendering relies on: an empty row still
    // reserves its own row-pitch of vertical space (see gridToPixels), so
    // two OTHER same-category rows on either side of it read as adjacent
    // once rendered (verified live against Kholodenko.g's own MAPK group --
    // every one of a nonpool row's 3 starting occupants individually
    // swapped out to blanks elsewhere over several optimization cycles,
    // nothing ever swapped back in, and the row silently emptied out).
    // Blank moves stay available for every OTHER entity -- only the sole
    // remaining occupant of a row is barred from vacating it this way.
    const ownRowCount = ids.filter((i) => grid.posOf(i)?.row === own.row).length;
    const canMoveToBlank = ownRowCount > 1;

    // Legal partners: every other cell of the SAME category (occupied by
    // another entity of that category, or blank) -- see rowCategory's own
    // comment: a pool can only ever be at an odd row, so every candidate
    // considered here already IS that category by construction, nothing
    // to filter beyond "not bestId's own cell."
    const candidateRows = category === 'pool'
      ? [...new Set(ids.filter((i) => categoryOf(i, rawById) === 'pool').map((i) => grid.posOf(i)?.row).filter((r) => r !== undefined))]
      : [...new Set(ids.filter((i) => categoryOf(i, rawById) !== 'pool').map((i) => grid.posOf(i)?.row).filter((r) => r !== undefined))];

    let bestKey = null;
    let bestGain = 0;
    let bestIsBlank = false;
    candidateRows.forEach((row) => {
      for (let col = 0; col < numCols + 2; col++) {
        const cell = grid.get(row, col);
        if (!cell) continue; // past the end of this row's real content
        if (row === own.row && col === own.col) continue;
        if (cell.overflowOf) continue; // the second half of a wide neighbor, not a real slot
        const candPos = { x: shift(row) + col * scoreCtx.cellPitch, y: -row * scoreCtx.rowPitch };
        if (cell.blank) {
          if (!canMoveToBlank) continue;
          const gain = useFullScore
            ? baselineFullScore - fullScoreGain(new Map([[bestId, candPos]]))
            : ownCostBefore - costAt(candPos, ownNeighbors);
          if (gain > bestGain) {
            bestGain = gain;
            bestKey = { row, col };
            bestIsBlank = true;
          }
          continue;
        }
        if (lockedIds.has(cell.id)) continue;
        const partnerId = cell.id;
        const gain = useFullScore
          ? baselineFullScore - fullScoreGain(new Map([[bestId, candPos], [partnerId, ownPos]]))
          : (() => {
              const partnerNeighbors = neighborsOf.get(partnerId) ?? [];
              const partnerPos = positions.get(partnerId);
              const partnerCostBefore = costAt(partnerPos, partnerNeighbors);
              const ownCostAfter = costAt(candPos, ownNeighbors);
              const partnerCostAfter = costAt(ownPos, partnerNeighbors); // partner would land on bestId's own old spot
              return (ownCostBefore + partnerCostBefore) - (ownCostAfter + partnerCostAfter);
            })();
        if (gain > bestGain) {
          bestGain = gain;
          bestKey = { row, col };
          bestIsBlank = false;
        }
      }
    });

    if (!bestKey) return null;
    return { gain: bestGain, key: bestKey, isBlank: bestIsBlank };
  }
}

// Copies both real entities AND blank markers -- a clone missing blanks
// would still render identically (blanks carry no id-position pairs
// gridToPixels/computeTotalLoss consult), but the optimizer's own
// trySwapStep reads grid.get(row, col) to find legal swap partners, so a
// snapshot ever reused as the LIVE grid (not just returned for pixel
// conversion) would silently lose every blank-swap option.
// Item 7 fix, continued: the TRUE floor a re-run must never go below is
// whatever is already on screen the moment the button is clicked -- not
// this module's own freshly-regenerated starting grid (buildInitialGrid
// throws away any existing arrangement and starts over from scratch
// every time, so on a SECOND click, "the starting grid" is a brand-new
// candidate, not "what a first click already produced" -- comparing
// only against IT can't catch a re-run that's worse than what the user
// is currently looking at, which is exactly the user's own "700 then
// 750 on repeated clicks" report). `rawById[id].x/.y/.flipped` are each
// child's own CURRENT position/orientation (same raw graph node objects
// buildFlowNodes/onAutoLayoutGroupByFlow already read these from) --
// re-anchored to their own natural top-left corner (min x, max y --
// Y-up) rather than kept in absolute model coordinates, matching every
// other positions map this module returns (the caller always adds its
// own group-relative origin on top); a pure translation doesn't change
// any pairwise distance/crossing/overlap/area computeLayoutScore
// measures, so this re-anchoring can't itself affect the comparison.
function currentPositions(ids, rawById) {
  const raw = new Map(ids.map((id) => [id, { x: rawById[id]?.x ?? 0, y: rawById[id]?.y ?? 0 }]));
  // NOT seeded with 0 -- ids is always non-empty here (the caller already
  // bails out on an empty unlocked-children set before this ever runs).
  // A stray 0 candidate silently breaks this re-anchoring whenever the
  // group's real absolute coordinates don't already straddle zero (the
  // normal case: a group sitting somewhere else in the model's own
  // coordinate space) -- min(0, realMinX) or max(0, realMaxY) then just
  // returns 0 instead of the true anchor, leaving a large leftover
  // absolute offset baked into the "unchanged" positions this returns.
  // The caller adds its own group-relative origin on top of THAT
  // uncorrected offset, so every repeated run landing on this fallback
  // compounds the same residual offset again -- verified directly as the
  // cause of a group visibly creeping into the bottom-right corner over
  // repeated flow-layout clicks on Repressilator.g, even though the
  // *score* stayed flat the whole time (translation-invariant, so the
  // same relative arrangement scores identically regardless of where the
  // bug has dragged it on screen).
  const minX = Math.min(...ids.map((id) => raw.get(id).x));
  const maxY = Math.max(...ids.map((id) => raw.get(id).y));
  return new Map(ids.map((id) => [id, { x: raw.get(id).x - minX, y: raw.get(id).y - maxY }]));
}

function computeCurrentDisplayScore(ids, rawById, sizes, localEdges, lockedFlipped) {
  const positions = currentPositions(ids, rawById);
  const scoreNodes = buildScoreNodes(ids, positions, sizes, rawById, {}, lockedFlipped);
  const scoreEdges = localEdges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.data?.type }));
  return { positions, weighted: computeLayoutScore(scoreNodes, scoreEdges, DEFAULT_SCORE_WEIGHTS).weighted };
}

function cloneGrid(grid, ids, numRows, numCols) {
  const copy = makeGrid();
  ids.forEach((id) => {
    const p = grid.posOf(id);
    if (p) copy.setEntity(p.row, p.col, id, grid.isWide(id));
  });
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (grid.get(r, c)?.blank) copy.setBlank(r, c);
    }
  }
  return copy;
}

// ---------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------

export function computeFlowGroupLayout({ children, edges, rawById, sizes, weights = DEFAULT_FLOW_WEIGHTS, maxCycles = MAX_CYCLES, force = false, cellUnit = AUTO_LAYOUT_CELL }) {
  const unlocked = children.filter((c) => !c.locked);
  const ids = unlocked.map((c) => c.id);
  const idSet = new Set(ids);
  const localEdges = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
  const seriesClusters = detectSeriesClusters(ids, rawById);
  const { inputBias } = computeFlowOrderAndBias(ids, localEdges, rawById);
  const lockedIds = new Set(); // already excluded from `ids` entirely, matching the previous design's own locked-node treatment
  const lockedFlipped = (id) => !!rawById[id]?.flipped;
  // `cellUnit` defaults to the plain AUTO_LAYOUT_CELL constant for any
  // caller that doesn't (yet) pass App.jsx's own per-model, scale-aware
  // value -- see derivePitches' own comment on why a fixed kkit-unit
  // pitch stops being right once a model's own native coordinate
  // convention pushes `scale` far from its usual range.
  const { cellPitch, rowPitch, longNameWidth } = derivePitches(cellUnit);

  const { grid, numRows, numCols } = buildInitialGrid({ ids, edges: localEdges, rawById, sizes, longNameWidth });
  const startingGrid = cloneGrid(grid, ids, numRows, numCols);
  // Item 9's own flip pass now happens inside computeTotalLoss itself
  // (see its own comment, and layoutScore.js's refineFlips) -- every
  // call already estimates a full layout score, which is exactly what a
  // flip pass needs to happen before, so there's nothing left to do
  // here first.

  const scoreArgs = { ids, edges: localEdges, rawById, sizes, seriesClusters, inputBias, lockedFlipped, weights, cellPitch, rowPitch };
  const startingResult = computeTotalLoss({ ...scoreArgs, grid, numRows });
  let startingLoss = startingResult.total;
  const startingDisplayScore = startingResult.displayWeighted;
  const startingFlips = startingResult.flips;

  // Item 7 fix: track the best-so-far grid by the DISPLAY score (the
  // same "Layout score" metric shown in the UI), independently of
  // whichever grid the internal search loss (below) happens to prefer --
  // see computeTotalLoss's own comment on why the two can disagree.
  // bestFlips travels alongside bestGrid -- computeTotalLoss's own
  // refineFlips pass (see its comment) is what actually decided this
  // score, so whichever grid ends up returned needs ITS OWN matching
  // flips returned too, not left for the caller to recompute with the
  // plain, unverified heuristic (which is exactly the gap that let a
  // verified flip improvement never reach what's actually applied --
  // computeTotalLoss finding a better score internally is useless to
  // the user if nothing downstream ever sees which flips produced it).
  let bestGrid = cloneGrid(grid, ids, numRows, numCols);
  let bestNumRows = numRows;
  let bestDisplayScore = startingDisplayScore;
  let bestFlips = startingFlips;

  let previousCycleLoss = startingLoss;
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    const positions = gridToPixels(grid, numRows, cellPitch, rowPitch);
    const neighborsOf = buildNeighborIndex(ids, localEdges);
    // Fresh every cycle (not once for the whole run) -- see
    // trySwapStep's own comment on why this is what actually guarantees
    // every object in the group gets sampled, not just whichever one or
    // two keep winning the largest-gradient contest.
    const triedThisCycle = new Set();
    const innerStepsCap = MAX_INNER_STEPS_SAFETY_CAP(ids.length);
    const scoreCtx = { sizes, lockedFlipped, localEdges, cellPitch, rowPitch };
    for (let step = 0; step < innerStepsCap; step++) {
      const swapped = trySwapStep(grid, ids, rawById, lockedIds, positions, neighborsOf, numCols, triedThisCycle, scoreCtx);
      if (!swapped) break; // nothing left this cycle actually improves anything
      swapped.forEach((id) => triedThisCycle.add(id));
      const updated = gridToPixels(grid, numRows, cellPitch, rowPitch);
      swapped.forEach((id) => positions.set(id, updated.get(id)));
    }

    // computeTotalLoss's own flip pass (see its comment) covers this
    // cycle's own positions right before it estimates the score below --
    // nothing to do here first.
    const { total, displayWeighted, flips: cycleFlips } = computeTotalLoss({ ...scoreArgs, grid, numRows });
    if (displayWeighted < bestDisplayScore) {
      bestDisplayScore = displayWeighted;
      bestGrid = cloneGrid(grid, ids, numRows, numCols);
      bestNumRows = numRows;
      bestFlips = cycleFlips;
    }
    const improvement = previousCycleLoss > 0 ? (previousCycleLoss - total) / previousCycleLoss : 0;
    previousCycleLoss = total;
    if (improvement < TERMINATION_CRITERION) break;
  }

  // Item 11 (fixed for the later item 7): the true floor is whatever's
  // already on screen right now (see computeCurrentDisplayScore's own
  // comment) -- prefer the optimized result if it beats that, else this
  // run's own starting grid if THAT beats it, else genuinely change
  // nothing. This is what actually guarantees a re-run can never regress
  // the number the user is watching, on the first click or the tenth.
  //
  // Skipped when every child shares the exact same (x, y) -- a group
  // that's never been positioned at all (every entity still sitting at
  // its own creation-time default) collapses to zero length/crossings/
  // area once scored, which reads as an unbeatably PERFECT layout rather
  // than a real one worth protecting; there's nothing meaningful on
  // screen yet in that case, so this falls back to the plain starting-
  // grid comparison (item 11 as originally specified).
  // `force`: the user's own later request -- a plain compact packing
  // (Square) can score deceptively well on the SAME length/crossings/
  // overlap/area metric this gate compares against purely by being
  // cramped, not because it's actually a better layout; that can make
  // this gate wrongly protect a cramped Square result against a Flow
  // result that's clearly better by every OTHER measure (readability,
  // alternating structure). Force Flow skips this gate entirely and
  // always applies the search's own best result, exactly like every
  // other guard in this function still applies (verified flips, real
  // improving swaps only, etc.) -- only the FINAL "would this actually
  // help" comparison is bypassed.
  let finalGrid = null;
  let finalNumRows = null;
  let onScreenPositions = null;
  if (force) {
    finalGrid = bestGrid;
    finalNumRows = bestNumRows;
  } else {
    const hasRealOnScreenLayout = new Set(ids.map((id) => `${rawById[id]?.x ?? 0},${rawById[id]?.y ?? 0}`)).size > 1;
    const onScreen = hasRealOnScreenLayout ? computeCurrentDisplayScore(ids, rawById, sizes, localEdges, lockedFlipped) : null;
    const floorScore = onScreen ? onScreen.weighted : Infinity;
    if (bestDisplayScore <= floorScore) {
      finalGrid = bestGrid;
      finalNumRows = bestNumRows;
    } else if (startingDisplayScore <= floorScore) {
      finalGrid = startingGrid;
      finalNumRows = numRows;
    } else {
      onScreenPositions = onScreen.positions; // only reachable when onScreen is real and beats both candidates
    }
  }
  const positions = finalGrid ? gridToPixels(finalGrid, finalNumRows, cellPitch, rowPitch) : onScreenPositions;
  // Whichever branch won, its OWN matching flips travel with it -- see
  // bestFlips' own comment on why this can't just be recomputed
  // downstream with the plain heuristic without losing the improvement
  // computeTotalLoss's own refineFlips pass already found. The "genuinely
  // change nothing" branch (finalGrid === null) returns each id's own
  // CURRENT flip, matching "change nothing" literally.
  let flips;
  if (finalGrid === bestGrid) flips = bestFlips;
  else if (finalGrid === startingGrid) flips = startingFlips;
  else flips = Object.fromEntries(ids.map((id) => [id, lockedFlipped(id)]));
  return { positions, flips };
}
