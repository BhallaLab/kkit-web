// Pure, frontend-only helpers for laying out one container's direct
// children -- shared by App.jsx's onAutoLayoutGroup (single level) and
// computeLocalLayouts (recursive, per level) so both read as the same
// underlying layout, and kept apart from App.jsx itself (like
// collapseView.js/layoutScore.js) so the actual placement math is
// independently testable without any of App.jsx's own React/backend
// machinery.
//
// The first several exports (AUTO_LAYOUT_CELL through computeFlipUpdates)
// are moved here verbatim from App.jsx -- a pure refactor, not a behavior
// change; App.jsx now imports them instead of defining them locally. The
// two new seeding strategies (radialSeed, forceDirectedSeed) and the
// orchestrator that scores and picks between them (chooseBestOrder) are
// additions -- not yet wired into App.jsx's own auto-layout actions (that
// integration, alongside the simulated-annealing refinement pass, is the
// next stage of the same planning discussion this shipped from).

import { computeLayoutScore, scoreRatio, DEFAULT_SCORE_WEIGHTS } from './layoutScore';
import { greedyFeedbackArcSet, assignLayers, orderWithinLayers, assignFlowCoordinates } from './layoutFlow';

export const AUTO_LAYOUT_CELL = 3;

// Packs a set of already-sized children into a simple grid, sized
// per-axis (a separate column width and row height, not one uniform
// square cell) -- a uniform cell sized to the single largest child in
// *either* dimension wastes space for every other child in whichever
// axis it isn't actually that large in, which is exactly backwards from
// "plenty of spare space" still somehow not being enough room: the axis
// that's actually tight never got any extra from the space being wasted
// in the other one.
export function computeGridCells(sizes) {
  const colWidth = Math.max(AUTO_LAYOUT_CELL, ...sizes.map((s) => s.width));
  const rowHeight = Math.max(AUTO_LAYOUT_CELL, ...sizes.map((s) => s.height));
  const cols = Math.ceil(Math.sqrt(sizes.length));
  return { colWidth, rowHeight, cols };
}

// Only counts an edge when *both* ends are among the same set of children
// -- a connection leaving this group entirely (to a sibling group, or up
// to a parent) has no comparable position to pull toward without also
// knowing that group's own final layout, which doesn't exist yet at this
// point in a (possibly recursive) pass.
export function buildLocalAdjacency(ids, edges) {
  const idSet = new Set(ids);
  const adjacency = new Map(ids.map((id) => [id, []]));
  edges.forEach((e) => {
    if (e.source === e.target) return;
    if (idSet.has(e.source) && idSet.has(e.target)) {
      adjacency.get(e.source).push(e.target);
      adjacency.get(e.target).push(e.source);
    }
  });
  return adjacency;
}

const RELAX_ITERATIONS = 40;
const RELAX_DAMPING = 0.5;

// A locked child (see App.jsx's data.locked -- set whenever the user
// manually drags, resizes, or flips something) stays a fixed anchor
// throughout relaxation -- it still pulls its own unlocked neighbors
// toward it, since that's real connectivity information worth using, but
// its own position is never updated by this loop; excluded from the
// grid-cell assignment entirely afterward, by the caller, since it isn't
// being repositioned at all.
export function relaxPositions(ids, adjacency, initialPos, lockedIds) {
  let pos = new Map(ids.map((id) => [id, { ...initialPos.get(id) }]));
  for (let iter = 0; iter < RELAX_ITERATIONS; iter++) {
    const next = new Map();
    ids.forEach((id) => {
      if (lockedIds.has(id)) {
        next.set(id, pos.get(id));
        return;
      }
      const neighbors = adjacency.get(id) ?? [];
      if (neighbors.length === 0) {
        next.set(id, pos.get(id));
        return;
      }
      let sx = 0;
      let sy = 0;
      neighbors.forEach((nid) => {
        const p = pos.get(nid);
        sx += p.x;
        sy += p.y;
      });
      const avg = { x: sx / neighbors.length, y: sy / neighbors.length };
      const cur = pos.get(id);
      next.set(id, { x: cur.x + (avg.x - cur.x) * RELAX_DAMPING, y: cur.y + (avg.y - cur.y) * RELAX_DAMPING });
    });
    pos = next;
  }
  return pos;
}

// Greedy nearest-open-cell assignment -- O(n^2), fine for the sizes a
// single group's own direct children (or one recursive layout's own
// level) actually reach in practice. The candidate cells are anchored at
// the relaxed cluster's own top-left corner (not a fixed (0,0)) so
// distance comparisons are meaningful regardless of where in the model
// this particular group actually sits.
export function assignNearestCells(orderedIds, relaxedPos, cols, colWidth, rowHeight) {
  const xs = orderedIds.map((id) => relaxedPos.get(id).x);
  const ys = orderedIds.map((id) => relaxedPos.get(id).y);
  const originX = Math.min(...xs);
  const originY = Math.max(...ys);
  const open = orderedIds.map((_, i) => ({
    col: i % cols,
    row: Math.floor(i / cols),
    x: originX + (i % cols) * colWidth,
    y: originY - Math.floor(i / cols) * rowHeight,
  }));

  const assignment = new Map();
  orderedIds.forEach((id) => {
    const p = relaxedPos.get(id);
    let bestI = 0;
    let bestDist = Infinity;
    open.forEach((c, i) => {
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bestDist) {
        bestDist = d;
        bestI = i;
      }
    });
    assignment.set(id, open[bestI]);
    open.splice(bestI, 1);
  });
  return assignment;
}

// Reorders `children` (raw node objects, each with .id/.x/.y) so that
// placing them index-by-index into a plain (i % cols, floor(i / cols))
// grid reads as connectivity-aware instead of insertion-order. Locked
// children are dropped from the returned order entirely (callers leave
// them wherever they already are) -- this only ever orders the ones
// actually being packed, though a locked sibling still shapes *their*
// placement via relaxation.
export function connectivityAwareOrder(children, edges, cols, colWidth, rowHeight) {
  const unlocked = children.filter((c) => !c.locked);
  if (unlocked.length <= 1) return unlocked;
  const ids = children.map((c) => c.id);
  const lockedIds = new Set(children.filter((c) => c.locked).map((c) => c.id));
  const adjacency = buildLocalAdjacency(ids, edges);
  const initialPos = new Map(children.map((c) => [c.id, { x: c.x, y: c.y }]));
  const relaxed = relaxPositions(ids, adjacency, initialPos, lockedIds);
  const unlockedIds = unlocked.map((c) => c.id);
  const assignment = assignNearestCells(unlockedIds, relaxed, cols, colWidth, rowHeight);
  const byId = new Map(children.map((c) => [c.id, c]));
  return [...assignment.entries()]
    .sort((a, b) => a[1].row - b[1].row || a[1].col - b[1].col)
    .map(([id]) => byId.get(id));
}

// The same substrate-vs-product-average-X rule computeInitialFlips (in
// App.jsx) uses at load time, run again after auto-layout actually moves
// things -- an auto-layout that leaves a connector needlessly crossing
// itself because the substrate/product sides never got re-checked against
// the *new* positions is only half fixing "minimize connector lengths".
// Only reac/enz/concchan (the types with a substrate/product-style flip,
// not a Pool's own less centrally-relevant one) are re-evaluated, and only
// among `candidateIds` (whatever this particular layout operation
// actually affected); a locked node's own flip is left alone regardless
// -- a user's manual choice there is exactly what data.locked exists to
// protect. `xById` must already reflect every *new* position this
// operation just assigned, not just the ones being flip-checked -- a
// reac's own substrates/products can easily live outside the immediate
// scope being laid out.
export function computeFlipUpdates(candidateIds, rawById, edges, xById, lockedIds) {
  const subXs = {};
  const prodXs = {};
  edges.forEach((e) => {
    const type = e.data?.type;
    const sourceType = rawById[e.source]?.type;
    const targetType = rawById[e.target]?.type;
    if ((type === 'substrate' || type === 'chanIn') && sourceType === 'pool' && xById[e.source] !== undefined) {
      (subXs[e.target] ??= []).push(xById[e.source]);
    } else if ((type === 'product' || type === 'chanOut') && targetType === 'pool' && xById[e.target] !== undefined) {
      (prodXs[e.source] ??= []).push(xById[e.target]);
    }
  });
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const flips = {};
  candidateIds.forEach((id) => {
    if (lockedIds.has(id)) return;
    const type = rawById[id]?.type;
    if (type !== 'reac' && type !== 'enz' && type !== 'concchan') return;
    const subs = subXs[id];
    const prods = prodXs[id];
    if (subs && prods) flips[id] = avg(subs) > avg(prods);
  });
  return flips;
}

// -- Seeding strategies (new) -----------------------------------------------
//
// Two independent ways to guess a good *starting* arrangement before any
// score-driven refinement runs -- chooseBestOrder (below) tries both,
// scores each with layoutScore.js's own computeLayoutScore, and keeps
// whichever wins. Deliberately not just one "best" strategy: connectivity
// structure varies enough between groups (a tight cluster of mutually-
// connected molecules vs. a hub-and-spoke reaction with many substrates)
// that neither approach dominates the other in general.

// Repulsion pushes any two nodes closer than `cellSize` apart (roughly one
// packed grid cell's own footprint) back apart, proportional to how much
// closer than that they are -- without it, plain attraction-only
// relaxation (relaxPositions, above) can leave several disconnected or
// lightly-connected nodes collapsed on top of each other, since nothing
// was ever pushing them apart again. Combined with attraction into a
// single net displacement per node per iteration, scaled by one damping
// factor -- summing two independently-damped forces tends to overshoot/
// oscillate more than damping their sum once. O(n^2) per iteration (every
// node checks every other node for repulsion) -- fine for the sizes a
// single group's own direct children reach in practice; the caller
// (chooseBestOrder, and eventually the search stage) is responsible for
// keeping the overall per-click time budget in check on very large groups.
const FORCE_DAMPING = 0.3;

export function forceDirectedSeed(ids, adjacency, initialPos, lockedIds, cellSize) {
  let pos = new Map(ids.map((id) => [id, { ...initialPos.get(id) }]));
  for (let iter = 0; iter < RELAX_ITERATIONS; iter++) {
    const next = new Map();
    ids.forEach((id) => {
      if (lockedIds.has(id)) {
        next.set(id, pos.get(id));
        return;
      }
      const cur = pos.get(id);
      let fx = 0;
      let fy = 0;
      const neighbors = adjacency.get(id) ?? [];
      if (neighbors.length > 0) {
        let sx = 0;
        let sy = 0;
        neighbors.forEach((nid) => {
          const p = pos.get(nid);
          sx += p.x;
          sy += p.y;
        });
        fx += sx / neighbors.length - cur.x;
        fy += sy / neighbors.length - cur.y;
      }
      ids.forEach((otherId) => {
        if (otherId === id) return;
        const other = pos.get(otherId);
        const dx = cur.x - other.x;
        const dy = cur.y - other.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        if (dist < cellSize) {
          const push = (cellSize - dist) / dist;
          fx += dx * push;
          fy += dy * push;
        }
      });
      next.set(id, { x: cur.x + fx * FORCE_DAMPING, y: cur.y + fy * FORCE_DAMPING });
    });
    pos = next;
  }
  return pos;
}

// A cheap, purely topological seed -- no reference to any node's current
// position at all (unlike forceDirectedSeed, which starts from wherever
// things already are), so it has no way to account for a locked sibling's
// actual location; only ever meant to be compared against
// forceDirectedSeed's own result via chooseBestOrder, not used alone.
// Places the highest-degree node first, then walks outward from it ring
// by ring (a plain BFS, not true shortest-path distance -- a node
// reachable two different ways still only gets placed once, at whichever
// ring reaches it first), spreading each ring's members evenly by angle
// around their own parent from the previous ring. A node with no
// unplaced neighbors left to walk into is picked up again by the outer
// loop as a fresh hub for a whole new cluster -- keeps disconnected
// components (or ones only reachable from a much lower-degree node) from
// silently never being placed.
export function radialSeed(ids, adjacency, cellSize) {
  const degreeDesc = [...ids].sort((a, b) => (adjacency.get(b) ?? []).length - (adjacency.get(a) ?? []).length);
  const placed = new Map();
  const ringGap = cellSize * 1.5;
  let freshClusterX = 0;

  degreeDesc.forEach((id) => {
    if (placed.has(id)) return;
    placed.set(id, { x: freshClusterX, y: 0 });
    freshClusterX += ringGap * 6;

    let frontier = [id];
    let ring = 1;
    while (frontier.length > 0) {
      const next = [];
      frontier.forEach((centerId) => {
        const center = placed.get(centerId);
        const unplacedNeighbors = (adjacency.get(centerId) ?? []).filter((nid) => !placed.has(nid));
        unplacedNeighbors.forEach((nid, i) => {
          const angle = (2 * Math.PI * i) / unplacedNeighbors.length;
          placed.set(nid, {
            x: center.x + Math.cos(angle) * ringGap * ring,
            y: center.y + Math.sin(angle) * ringGap * ring,
          });
          next.push(nid);
        });
      });
      frontier = next;
      ring += 1;
    }
  });

  return placed;
}

// A candidate seed's own continuous positions, turned into the row-major
// child order the caller actually applies to the grid -- the same
// nearest-open-cell assignment connectivityAwareOrder already used,
// factored out so both seeding strategies (and, later, the search stage)
// share it.
function seedToOrder(unlockedIds, seedPositions, cols, colWidth, rowHeight) {
  const assignment = assignNearestCells(unlockedIds, seedPositions, cols, colWidth, rowHeight);
  return [...assignment.entries()].sort((a, b) => a[1].row - b[1].row || a[1].col - b[1].col).map(([id]) => id);
}

// Real grid positions for a given order, anchored so a *locked* sibling's
// own unchanged absolute position stays directly comparable -- not a
// synthetic (0,0)-based frame, which would read a locked child sitting
// far from a fresh (0,0)-anchored grid as impossibly distant regardless of
// how good the actual layout is. Matches App.jsx's own convention
// (effectiveContainerBox et al.) of anchoring a fresh grid at the group's
// real current top-left, not an arbitrary origin.
function currentOrigin(children) {
  return { x: Math.min(...children.map((c) => c.x)), y: Math.max(...children.map((c) => c.y)) };
}

function orderToPositions(order, origin, cols, colWidth, rowHeight) {
  const positions = new Map();
  order.forEach((id, i) => {
    positions.set(id, {
      x: origin.x + (i % cols) * colWidth,
      y: origin.y - Math.floor(i / cols) * rowHeight,
    });
  });
  return positions;
}

// The plain {id,x,y,width,height,flipped,type} node list layoutScore.js's
// computeLayoutScore expects, for one candidate `order` (unlocked ids,
// row-major grid sequence) -- a locked child keeps its own real, current
// position regardless of `order` (it isn't part of the grid being
// packed); `flips` overrides a node's own current `flipped` only where
// the caller actually computed a fresh one (computeFlipUpdates only ever
// returns entries for the reac/enz/concchan types it evaluates, so every
// other node correctly falls through to its own existing value). Shared
// by chooseBestOrder and the simulated-annealing refinement below so a
// seed candidate and a mid-search candidate are scored identically.
function buildScoreNodes(order, children, sizes, flips, origin, cols, colWidth, rowHeight) {
  const gridPositions = orderToPositions(order, origin, cols, colWidth, rowHeight);
  return children.map((c) => {
    const size = sizes.get(c.id) ?? { width: AUTO_LAYOUT_CELL, height: AUTO_LAYOUT_CELL };
    const pos = c.locked ? { x: c.x, y: c.y } : gridPositions.get(c.id);
    const flipped = flips[c.id] !== undefined ? flips[c.id] : !!c.flipped;
    return { id: c.id, x: pos.x, y: pos.y, width: size.width, height: size.height, flipped, parentSide: c.parentSide, type: c.type };
  });
}

// All `children` (locked and unlocked alike) at their own real *current*
// position -- what a candidate layout is ultimately measured against
// (see optimizeGroupLayout's own final 10%-worse gate), never itself
// touched by anything else in this module.
function buildCurrentScoreNodes(children, sizes) {
  return children.map((c) => {
    const size = sizes.get(c.id) ?? { width: AUTO_LAYOUT_CELL, height: AUTO_LAYOUT_CELL };
    return { id: c.id, x: c.x, y: c.y, width: size.width, height: size.height, flipped: !!c.flipped, parentSide: c.parentSide, type: c.type };
  });
}

function toScoreEdges(edges) {
  return edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.data?.type }));
}

// Tries both seeding strategies, fixes flips or each candidate's own
// resulting positions (see computeFlipUpdates -- run once per candidate,
// not per iteration of anything, so the score it feeds is stable), scores
// both with layoutScore.js's computeLayoutScore, and returns whichever
// won. Drop-in replacement for connectivityAwareOrder's own return shape
// (an ordered array of *child* objects, unlocked only) plus extra
// `strategy`/`score` fields a caller can surface for debugging/telemetry
// but doesn't have to use.
//
// `sizes` must be a Map covering every id in `children` (locked and
// unlocked alike -- a locked sibling's own footprint still matters for
// the overlap/area terms) with {width, height}; `rawById` an id -> raw
// node lookup covering the *whole* model, not just this group (needed by
// computeFlipUpdates for a reac/enz whose substrate/product lives outside
// this immediate scope). `edges` are React-Flow-shaped (source/target/
// data.type), matching what App.jsx already has on hand as flowGraph.edges
// -- adapted internally to layoutScore.js's own plain {source,target,type}
// shape only at the point of scoring.
export function chooseBestOrder({ children, edges, rawById, sizes, cols, colWidth, rowHeight, weights = DEFAULT_SCORE_WEIGHTS }) {
  const unlocked = children.filter((c) => !c.locked);
  if (unlocked.length <= 1) return { order: unlocked, strategy: 'trivial', score: null };

  const ids = children.map((c) => c.id);
  const unlockedIds = unlocked.map((c) => c.id);
  const lockedIds = new Set(children.filter((c) => c.locked).map((c) => c.id));
  const adjacency = buildLocalAdjacency(ids, edges);
  const unlockedAdjacency = buildLocalAdjacency(unlockedIds, edges);
  const cellSize = Math.max(colWidth, rowHeight);
  const origin = currentOrigin(children);
  const initialPos = new Map(children.map((c) => [c.id, { x: c.x, y: c.y }]));

  const seeds = [
    { strategy: 'force-directed', positions: forceDirectedSeed(ids, adjacency, initialPos, lockedIds, cellSize) },
    { strategy: 'radial', positions: radialSeed(unlockedIds, unlockedAdjacency, cellSize) },
  ];

  const scoreEdges = toScoreEdges(edges);

  let best = null;
  seeds.forEach(({ strategy, positions }) => {
    const order = seedToOrder(unlockedIds, positions, cols, colWidth, rowHeight);
    const gridPositions = orderToPositions(order, origin, cols, colWidth, rowHeight);

    const xById = {};
    Object.keys(rawById).forEach((id) => {
      xById[id] = rawById[id].x;
    });
    gridPositions.forEach((p, id) => {
      xById[id] = p.x;
    });
    const flips = computeFlipUpdates(unlockedIds, rawById, edges, xById, lockedIds);

    const scoreNodes = buildScoreNodes(order, children, sizes, flips, origin, cols, colWidth, rowHeight);
    const score = computeLayoutScore(scoreNodes, scoreEdges, weights);

    if (!best || score.weighted < best.score.weighted) {
      best = { strategy, order, score, flips };
    }
  });

  const byId = new Map(children.map((c) => [c.id, c]));
  return { order: best.order.map((id) => byId.get(id)), strategy: best.strategy, score: best.score, flips: best.flips };
}

// -- Score-driven refinement (simulated annealing) --------------------------
//
// Takes chooseBestOrder's own winning seed and searches for a better
// permutation of the SAME grid cells via simulated annealing -- occasionally
// accepting a move that makes things worse (within the 50%-per-move reject
// rule below) is what lets the search escape whatever local optimum a
// purely-greedy hill-climb from the seed would otherwise get stuck in.
// Operates entirely on which *unlocked* child occupies which cell -- a
// swap can never introduce a new overlap, so nothing here needs its own
// separate overlap-avoidance logic the way a free-continuous-coordinate
// search would.
//
// Flips stay fixed for the whole search (whatever chooseBestOrder's
// winning seed already computed) -- re-deriving them on every single
// swap would make the score landscape jump around (a flip changes which
// side a connector leaves from, hence the length/crossing terms) instead
// of responding smoothly to the swap actually being evaluated, which is
// what a search like this needs to be able to climb at all. One more
// flip fix-up runs after the search settles (see optimizeGroupLayout) --
// the optimal flip for a reac/enz can genuinely shift once its neighbors
// have moved during the search, not just at the seed.
// Deliberately well under the <1s target, not right up against it -- this
// runs synchronously on the main thread (no worker), so overshooting the
// budget doesn't just mean a slower click, it means a visibly frozen tab
// for however long it overshoots by; the gap also has to absorb real
// browser variability (GC pauses, a busy tab, a slower device) that a
// Node.js timing measurement during development doesn't fully capture.
const SA_TIME_BUDGET_MS = 550;
const SA_HARD_ITERATION_CAP = 20000;
// "More than 50% worse than the *current* accepted state" -- always
// rejected outright, at any temperature; a move within this band is
// accepted or not per the usual temperature-scaled probability below.
const SA_REJECT_RATIO = 1.5;
const SA_TARGETED_MOVE_PROB = 0.5;

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// A tiny deterministic-if-seeded PRNG (mulberry32) -- not for
// cryptographic purposes, just so a test can pass a fixed seed and get a
// reproducible search instead of a different random walk on every run.
function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every child's *current* position under this candidate order -- a locked
// one at its own real, fixed spot; an unlocked one at whatever grid cell
// `order` currently assigns it.
function orderPositionsMap(order, children, origin, cols, colWidth, rowHeight) {
  const gridPositions = orderToPositions(order, origin, cols, colWidth, rowHeight);
  const positions = new Map();
  children.forEach((c) => {
    positions.set(c.id, c.locked ? { x: c.x, y: c.y } : gridPositions.get(c.id));
  });
  return positions;
}

// "The worst object by max mean distance to all its targets" -- the node
// whose own connections are, on average, the most stretched-out right
// now. Only ever used to pick one *end* of a targeted swap (see
// proposeSwap below); the index into `order` (not the id) is returned
// since that's what a swap actually needs, and only unlocked (hence
// swappable) nodes are ever candidates in the first place.
function findWorstNodeIndex(order, adjacency, positions) {
  let worstIdx = -1;
  let worstMean = -Infinity;
  order.forEach((id, idx) => {
    const neighbors = adjacency.get(id) ?? [];
    if (neighbors.length === 0) return;
    const p = positions.get(id);
    let sum = 0;
    let count = 0;
    neighbors.forEach((nid) => {
      const np = positions.get(nid);
      if (!np) return;
      sum += Math.hypot(p.x - np.x, p.y - np.y);
      count += 1;
    });
    if (count === 0) return;
    const mean = sum / count;
    if (mean > worstMean) {
      worstMean = mean;
      worstIdx = idx;
    }
  });
  return worstIdx;
}

// A move proposal is just two indices into `order` to swap. Half the time
// (SA_TARGETED_MOVE_PROB) one end is deliberately the current worst node
// (see above) paired with a uniformly-random partner; the rest of the
// time both ends are uniformly random -- a blend of the plan's own
// "targeted worst-node swap" and "pairwise random swap" ideas, rather
// than committing to only one of them.
function proposeSwap(order, adjacency, positions, rng) {
  const n = order.length;
  if (n < 2) return null;
  let i;
  if (rng() < SA_TARGETED_MOVE_PROB) {
    i = findWorstNodeIndex(order, adjacency, positions);
    if (i === -1) i = Math.floor(rng() * n);
  } else {
    i = Math.floor(rng() * n);
  }
  let j = Math.floor(rng() * n);
  while (j === i) j = Math.floor(rng() * n);
  return [i, j];
}

function swapAt(order, i, j) {
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// `initialOrder`: the seed's own winning order (unlocked ids, row-major).
// `flips`: fixed for the whole search (see the block comment above).
// `timeBudgetMs`: a *wall-clock* budget, not an iteration count -- how
// many iterations that buys varies a lot with group size (crossing/
// overlap checks are O(edges^2) and O(edges*nodes) per score, see
// layoutScore.js), so a fixed iteration count would either waste the
// budget on a small group or blow it on a large one. The cooling
// schedule is time-fraction-based for the same reason: `temperature`
// reads as "how far through this wall-clock budget are we", not "how
// many iterations have run".
export function simulatedAnnealingRefine({
  children,
  edges,
  sizes,
  cols,
  colWidth,
  rowHeight,
  origin,
  initialOrder,
  flips,
  weights = DEFAULT_SCORE_WEIGHTS,
  timeBudgetMs = SA_TIME_BUDGET_MS,
  rng = makeRng(),
}) {
  const scoreEdges = toScoreEdges(edges);
  const unlockedAdjacency = buildLocalAdjacency(children.map((c) => c.id), edges);

  const scoreOrder = (order) => computeLayoutScore(buildScoreNodes(order, children, sizes, flips, origin, cols, colWidth, rowHeight), scoreEdges, weights);

  let currentOrder = [...initialOrder];
  let currentScore = scoreOrder(currentOrder);
  let bestOrder = currentOrder;
  let bestScore = currentScore;

  if (currentOrder.length < 2) return { order: currentOrder, score: currentScore, iterations: 0 };

  const start = nowMs();
  const deadline = start + timeBudgetMs;
  let iterations = 0;

  while (iterations < SA_HARD_ITERATION_CAP && nowMs() < deadline) {
    iterations += 1;
    const progress = Math.min(1, (nowMs() - start) / timeBudgetMs);
    const temperature = Math.max(0.001, 1 - progress);

    const positions = orderPositionsMap(currentOrder, children, origin, cols, colWidth, rowHeight);
    const move = proposeSwap(currentOrder, unlockedAdjacency, positions, rng);
    if (!move) break;
    const candidateOrder = swapAt(currentOrder, move[0], move[1]);
    const candidateScore = scoreOrder(candidateOrder);
    const ratio = scoreRatio(candidateScore.weighted, currentScore.weighted);

    // Always rejected, regardless of temperature -- this is the "reject
    // outright" half of the plan's own 50%-worse-per-move rule.
    if (ratio > SA_REJECT_RATIO) continue;

    // Anything at or below the current score is always accepted; anything
    // worse (but within the 50% band above) is accepted with a
    // temperature-scaled probability -- standard simulated-annealing
    // acceptance, using (ratio - 1) as "how much worse" and temperature
    // cooling from 1 toward 0 across the wall-clock budget.
    const accept = ratio <= 1 || rng() < Math.exp(-(ratio - 1) / temperature);
    if (!accept) continue;

    currentOrder = candidateOrder;
    currentScore = candidateScore;
    if (currentScore.weighted < bestScore.weighted) {
      bestOrder = currentOrder;
      bestScore = currentScore;
    }
  }

  return { order: bestOrder, score: bestScore, iterations };
}

// -- Top-level entry point ---------------------------------------------------
//
// The single function App.jsx's own onAutoLayoutGroup/computeLocalLayouts
// call instead of connectivityAwareOrder: seed (chooseBestOrder) ->
// simulated-annealing refinement -> one final flip fix-up against the
// search's own settled positions -> compare against the pre-operation
// baseline (see the module's own planning discussion: "if the score gets
// more than 10% worse discard"). A `discarded: true` result means the
// caller should apply nothing at all -- not even fall back to the seed --
// and leave the group exactly as it was.
//
// The planning discussion also raised a dedicated 2-opt de-crossing
// cleanup pass as a fast final step targeting the crossing-count score
// term specifically. Left out of this v1 deliberately -- SA's own score
// already weights crossings directly, so every accepted move is already
// biased against introducing them, and a separate pass would need its own
// access to the actual crossing *pairs* (not just layoutScore.js's own
// aggregate count) to know what to target. Worth adding later if live
// testing shows SA's own time budget isn't enough to clear residual
// crossings on its own, but not before that's actually observed.
const FINAL_GATE_RATIO = 1.1;

export function optimizeGroupLayout({
  children,
  edges,
  rawById,
  sizes,
  cols,
  colWidth,
  rowHeight,
  weights = DEFAULT_SCORE_WEIGHTS,
  timeBudgetMs = SA_TIME_BUDGET_MS,
  rng = makeRng(),
}) {
  const unlocked = children.filter((c) => !c.locked);
  const scoreEdges = toScoreEdges(edges);
  const baselineScore = computeLayoutScore(buildCurrentScoreNodes(children, sizes), scoreEdges, weights);

  if (unlocked.length <= 1) {
    return { order: unlocked, flips: {}, strategy: 'trivial', discarded: false, score: baselineScore, baselineScore, scoreRatio: 1, iterations: 0 };
  }

  const seedStart = nowMs();
  const seed = chooseBestOrder({ children, edges, rawById, sizes, cols, colWidth, rowHeight, weights });
  const seedElapsed = nowMs() - seedStart;
  // Whatever's left of the overall budget after seeding -- seeding's own
  // cost (dominated by forceDirectedSeed's O(n^2) repulsion loop) grows
  // with group size too, so a fixed SA budget regardless of how long
  // seeding just took could blow the *overall* <1s target on a large
  // group even though the SA phase alone stayed within its own budget.
  const saTimeBudget = Math.max(100, timeBudgetMs - seedElapsed);

  const origin = currentOrigin(children);
  const refined = simulatedAnnealingRefine({
    children,
    edges,
    sizes,
    cols,
    colWidth,
    rowHeight,
    origin,
    initialOrder: seed.order.map((c) => c.id),
    flips: seed.flips,
    weights,
    timeBudgetMs: saTimeBudget,
    rng,
  });

  const lockedIds = new Set(children.filter((c) => c.locked).map((c) => c.id));
  const finalPositions = orderToPositions(refined.order, origin, cols, colWidth, rowHeight);
  const xById = {};
  Object.keys(rawById).forEach((id) => {
    xById[id] = rawById[id].x;
  });
  finalPositions.forEach((p, id) => {
    xById[id] = p.x;
  });
  const finalFlips = computeFlipUpdates(refined.order, rawById, edges, xById, lockedIds);
  const finalScore = computeLayoutScore(buildScoreNodes(refined.order, children, sizes, finalFlips, origin, cols, colWidth, rowHeight), scoreEdges, weights);

  const ratio = scoreRatio(finalScore.weighted, baselineScore.weighted);
  const discarded = ratio > FINAL_GATE_RATIO;

  const byId = new Map(children.map((c) => [c.id, c]));
  return {
    order: discarded ? unlocked : refined.order.map((id) => byId.get(id)),
    flips: discarded ? {} : finalFlips,
    strategy: seed.strategy,
    discarded,
    score: finalScore,
    baselineScore,
    scoreRatio: ratio,
    iterations: refined.iterations,
  };
}

// Which edge types represent actual material/information flow, for
// computeFlowGroupLayout below -- excludes the purely structural
// "enzyme"/"chanParent" links (an enzyme's or ConcChan's own attachment
// to its host molecule, never a step material passes through), the same
// way layoutScore.js's own EDGE_ATTACHMENT table treats them as a fixed
// geometric link rather than a flow step.
const FLOW_EDGE_TYPES = new Set(['substrate', 'product', 'chanIn', 'chanOut', 'stimTarget']);

// Cell spacing for a flow-laid-out group -- reuses AUTO_LAYOUT_CELL as
// its unit (so a flow-laid-out group still reads at the same visual
// scale as everything else on the canvas) rather than inventing a new
// constant from scratch. Kept equal on both axes -- an earlier version
// gave rows noticeably more room than columns on the theory that tiers
// deserved clearer separation, but that read as roughly double the
// expected gap once actually seen live; the hex stagger itself already
// does the job of visually separating tiers, so it doesn't need help
// from an oversized gap too.
const FLOW_COL_GAP = AUTO_LAYOUT_CELL * 0.5;
const FLOW_ROW_GAP = AUTO_LAYOUT_CELL * 0.5;

// A very long, narrow chain (many tiers, only one or two items each)
// reads badly stacked top-to-bottom -- rotating the same layering
// sideways (flow left-to-right, tiers as columns) keeps every bit of the
// same information but produces a far more usable shape. `numLayers`
// clearly dominating the widest tier is the signal for that: a tall
// layering has lots of tiers and not much in any one of them, while a
// wide one has few tiers each holding a lot. 1.5x is a mild bias toward
// the conventional top-to-bottom reading -- only actually switches when
// the vertical result would clearly be the worse shape, not for every
// layering that's merely a little taller than it is wide.
const FLOW_ORIENTATION_ASPECT_THRESHOLD = 1.5;

const FLOW_REFINE_TIME_BUDGET_MS = 400;
const FLOW_REFINE_ITERATION_CAP = 4000;

// Strict alternation is a hard invariant, not a best-effort one -- two
// tiers of the SAME parity ending up adjacent (nothing of the other type
// between them) reads as a real structural mistake, not a stylistic
// imperfection, however it happens to arise. And it arises more than one
// way: an isolated pool (see isolatedLayerPins) is pinned to a fixed
// literal layer (0) that has no relationship whatsoever to wherever a
// separate, genuinely-connected local chain's own pools happen to land
// (verified directly against Kholodenko.g: 6 isolated pools sat pinned
// at layer 0 while the model's real reaction chain's own pools
// independently computed to layer 5 -- nothing else ever occupies the
// gap in between, so the two show up as two back-to-back, functionally
// unrelated pool rows). A previous version of this file tried to solve
// long rows by deliberately splitting one into two same-parity tiers,
// which is exactly what this invariant forbids -- removed in favor of
// merging here instead: row *length* is still worth managing (see
// refineFlowOrder's own relocation move, which redistributes movable
// nodes among tiers that already legitimately alternate), but never by
// breaking alternation to do it.
//
// Implementation: walk the sorted list of tiers actually in use; whenever
// two consecutive ones share a parity, fold the later one into the
// earlier one's own layer value. Runs as a single left-to-right pass --
// each tier's merge target is resolved from its already-settled
// predecessor, so a run of 3+ consecutive same-parity tiers collapses
// transitively into one, not just pairwise.
function mergeAdjacentSameParityRows(ids, layerOf, rawById) {
  const layerType = new Map();
  ids.forEach((id) => {
    const l = layerOf.get(id) ?? 0;
    if (!layerType.has(l)) layerType.set(l, rawById[id]?.type === 'pool' ? 'pool' : 'nonpool');
  });
  const sortedLayers = [...layerType.keys()].sort((a, b) => a - b);
  const mergeTarget = new Map();
  sortedLayers.forEach((l, i) => {
    if (i === 0) {
      mergeTarget.set(l, l);
      return;
    }
    const prevTarget = mergeTarget.get(sortedLayers[i - 1]);
    mergeTarget.set(l, layerType.get(l) === layerType.get(prevTarget) ? prevTarget : l);
  });
  const mergedLayerOf = new Map();
  ids.forEach((id) => {
    const l = layerOf.get(id) ?? 0;
    mergedLayerOf.set(id, mergeTarget.get(l));
  });
  return mergedLayerOf;
}

// A node with zero LOCAL flow edges -- every connection it has, if any,
// crosses this group's own boundary -- gives longest-path layering
// nothing to place it by, so it falls back to layer 0 regardless of its
// own type. Left alone, that can mix a genuinely isolated non-pool in
// with real input pools at the very top row (verified directly: a
// reaction whose only substrate/product partners live in a different
// group reads, from this group's own local graph, as having no edges at
// all -- exactly the "pools and non-pools mixed on the same row" bug).
// Pinning it explicitly to the correct PARITY for its own type (pools
// even, non-pools odd) keeps the bipartite alternation intact everywhere,
// not just on the rows a real local edge chain happens to cover.
function isolatedLayerPins(ids, rawById, flowEdges) {
  const connected = new Set();
  flowEdges.forEach((e) => {
    connected.add(e.source);
    connected.add(e.target);
  });
  const pins = new Map();
  ids.forEach((id) => {
    if (connected.has(id)) return;
    pins.set(id, rawById[id]?.type === 'pool' ? 0 : 1);
  });
  return pins;
}

// A stimulus/Function node can never have an incoming flow edge by
// construction -- stimTarget is the only edge type it ever takes part in,
// and it's always that edge's SOURCE, never its target (it's the
// schema's own designated external driver, not something anything else
// in the model produces). Plain longest-path layering therefore always
// computes it as a graph "source" -- layer 0 -- exactly matching what
// its own target pool would also naturally compute to, regardless of how
// connected it is. That's not the isolated-node case isolatedLayerPins
// handles (a stim with a real local target isn't isolated at all) -- a
// stim being a non-pool type that always lands on pools' own layer is
// baked into what a stim *is*. Pinned to a dedicated layer ahead of
// everything else (a driving stimulus reads as "upstream of the whole
// cascade", which is exactly right regardless of which specific molecule
// it happens to perturb) rather than derived from connectivity at all.
const STIM_LAYER = -1;
function pinStims(pins, ids, rawById) {
  ids.forEach((id) => {
    if (rawById[id]?.type === 'stim') pins.set(id, STIM_LAYER);
  });
}

// A reac/enz/concchan whose substrate/product (or chanIn/chanOut) BOTH
// lie outside this group entirely isn't merely isolated the way a node
// with no real connections at all is -- it has a genuine role, just one
// that only ever touches this group's own boundary: something external
// feeds it, and it hands off to something else external. That's this
// group's own output interface, so it belongs at the bottom (the
// deepest non-pool row) rather than defaulting near the top the way a
// truly disconnected node does. Generalized to reac/concchan alongside
// enz -- the user's own example was an enzyme, but the same "both ends
// cross the boundary" structure means the same thing regardless of
// which of the three flow-through types it is.
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
// likely this group's own output too -- a single external consumer could
// just be incidental sharing, but feeding several reads as "this is the
// thing the group hands off," the same role detectOutputEntities' own
// pass-through entities play from the other side of the boundary.
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
// -- "MAPK" -> "MAPK_P" -> "MAPK_PP" (a phosphorylation series), "CaM" ->
// "CaM_Ca" -> "CaM_Ca2" (a binding series). Requiring the underscore
// boundary (not just a plain prefix) matters: plain-prefix matching would
// also catch "Ca" as a "prefix" of unrelated names like "CaMKII" that
// merely happen to start the same way, which is not a modification
// series of "Ca" at all -- the underscore is this codebase's own
// consistent compound-name delimiter throughout (verified against every
// model used this session), so requiring it is a cheap, reliable filter.
function isSeriesExtension(shorter, longer) {
  if (shorter.length === 0 || !longer.startsWith(shorter)) return false;
  const suffix = longer.slice(shorter.length);
  return suffix.startsWith('_') && suffix.length > 1;
}

// Clusters pools into phosphorylation/binding series by name (see
// isSeriesExtension) via union-find, so a 3+ step series (MAPK/MAPK_P/
// MAPK_PP) ends up as one cluster transitively, not two separate
// overlapping pairs. Only clusters with more than one member are
// returned -- a pool with no series partner needs no special handling.
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

// See FLOW_ORIENTATION_ASPECT_THRESHOLD's own comment.
function chooseFlowOrientation(ids, layerOf) {
  const counts = new Map();
  ids.forEach((id) => {
    const l = layerOf.get(id) ?? 0;
    counts.set(l, (counts.get(l) ?? 0) + 1);
  });
  const numLayers = counts.size;
  const maxRowSize = Math.max(1, ...counts.values());
  return numLayers > maxRowSize * FLOW_ORIENTATION_ASPECT_THRESHOLD ? 'horizontal' : 'vertical';
}

// A tier down to just one or two members reads as accidental
// fragmentation, not a deliberate grouping choice, in any group large
// enough to do better -- see mergeAdjacentSameParityRows above for the
// hard alternation invariant this builds on top of (this is a *soft*
// preference, folded into the score, not a further hard rule). Folding
// it into scoreFlowCandidate's own return value -- rather than a
// separate merge pass -- is what lets refineFlowOrder's existing
// relocate move do the actual merging: once an under-sized row is
// expensive, hill-climbing naturally drains it into whichever bigger
// same-parity row the real score prefers.
//
// A parity with FLOW_SHORT_ROW_EXEMPT_TOTAL (3) or fewer members total
// is exempt outright -- a 3-pool group simply cannot do better than a
// couple of near-empty rows, so penalizing it would only fight the graph
// for no visual gain (verified directly against Repressillator.g's own
// small groups). `stim` nodes are ignored entirely: pinStims always
// gives every stim its own permanent, singleton layer, so a lone stim
// "row" is a deliberate structural feature, not fragmentation.
// Safe to dominate the real score outright: refineFlowOrder's own
// `restrictedIds` mechanism (see its comment) already confines which
// tiers a short-row member can even relocate ONTO to ones that were
// already adequately sized to begin with -- a genuine single-file
// dependency chain (this file's own "10-tier single-file chain" test)
// never has any such tier available at all, so no magnitude of this
// penalty can touch it; there's nothing left here to protect against by
// keeping the constant small, so it's set high enough to always win for
// every case that IS eligible.
const FLOW_SHORT_ROW_EXEMPT_TOTAL = 3;
const FLOW_SINGLE_ROW_PENALTY = 300;
const FLOW_PAIR_ROW_PENALTY = 60;

function computeShortRowPenalty(ids, layerOf, rawById, totals) {
  if (!totals) return 0;
  const rows = new Map();
  ids.forEach((id) => {
    const type = rawById[id]?.type;
    if (type === 'stim') return;
    const parity = type === 'pool' ? 'pool' : 'nonpool';
    const l = layerOf.get(id) ?? 0;
    const key = `${parity}:${l}`;
    rows.set(key, { parity, count: (rows.get(key)?.count ?? 0) + 1 });
  });
  let penalty = 0;
  rows.forEach(({ parity, count }) => {
    if ((totals[parity] ?? 0) <= FLOW_SHORT_ROW_EXEMPT_TOTAL) return;
    if (count === 1) penalty += FLOW_SINGLE_ROW_PENALTY;
    else if (count === 2) penalty += FLOW_PAIR_ROW_PENALTY;
  });
  return penalty;
}

// Scores one candidate ordering by actually laying it out (via
// assignFlowCoordinates -- the same function the real result goes
// through) and running it through layoutScore.js's own connector-length/
// crossing/overlap score, re-deriving flip per candidate first
// (computeFlipUpdates, off each reac/enz/concchan's real connected
// pools' position under THIS candidate) the same way optimizeGroupLayout's
// own SA phase does -- otherwise a candidate would be judged by whatever
// flip happened to already be set, not what it would actually look like
// once flips settle to match it. `totals`, when given, adds
// computeShortRowPenalty's own score on top (see its own comment) --
// omitted entirely by any caller that doesn't care about row-size
// fragmentation.
function scoreFlowCandidate({ ids, layerOf, orderOf, sizes, hexOffset, colGap, rowGap, orientation, edges, rawById, weights, totals }) {
  const positions = assignFlowCoordinates({ ids, layerOf, orderOf, sizes, hexOffset, colGap, rowGap, orientation });
  const xById = {};
  Object.keys(rawById).forEach((id) => {
    xById[id] = rawById[id].x;
  });
  ids.forEach((id) => {
    xById[id] = positions.get(id).x;
  });
  const lockedIds = new Set(Object.values(rawById).filter((n) => n.locked).map((n) => n.id));
  const flips = computeFlipUpdates(ids, rawById, edges, xById, lockedIds);
  const scoreEdges = edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.data?.type }));
  const scoreNodes = ids.map((id) => {
    const p = positions.get(id);
    const size = sizes.get(id);
    const raw = rawById[id];
    return {
      id,
      x: p.x,
      y: p.y,
      width: size.width,
      height: size.height,
      flipped: flips[id] !== undefined ? flips[id] : !!raw.flipped,
      parentSide: raw.parentSide,
      type: raw.type,
    };
  });
  return computeLayoutScore(scoreNodes, scoreEdges, weights).weighted + computeShortRowPenalty(ids, layerOf, rawById, totals);
}

// Greedy local search answering "are you doing any optimization for
// layout score within the flow framework, and iteratively?" -- the
// deterministic FAS+layering+barycenter pipeline alone never looks at
// connector length at all (only at crossing counts via barycenter's own
// averaging, a proxy not the real objective), and every node's row was
// fixed the moment layering finished. Two move types, both kept only
// when they don't make layoutScore.js's own real score worse:
//
// - a SWAP of two items within the same tier (never across tiers for a
//   node whose tier came from a genuine graph dependency -- that's the
//   hard flow constraint this whole layout exists to keep);
// - a RELOCATION of one `movableIds` node to a *different* tier of its
//   own parity. Only nodes whose current tier came from a heuristic, not
//   a real edge (isolated defaults, detectOutputEntities/Pools) are ever
//   eligible -- moving a node that's actually mid-chain would violate the
//   dependency its neighbors relied on. This is also this round's fix
//   for "some rows end up very long, others very short": those same
//   heuristics currently dump every match onto one shared tier
//   regardless of how crowded it already is, and relocation gives the
//   search room to spread them back out wherever the real score prefers.
//
// Plain hill-climbing rather than the grid-based simulated annealing
// elsewhere in this file (see simulatedAnnealingRefine) -- deliberately
// simpler: this search space is far smaller than the whole-group
// free-for-all grid case that machinery was built to escape local optima
// in, so there's much less need for SA's own temperature-scaled
// acceptance to justify its extra complexity here.
function refineFlowOrder({
  ids,
  edges,
  rawById,
  sizes,
  layerOf,
  orderOf,
  movableIds = [],
  hexOffset,
  colGap,
  rowGap,
  orientation,
  weights = DEFAULT_SCORE_WEIGHTS,
  timeBudgetMs = FLOW_REFINE_TIME_BUDGET_MS,
  rng = makeRng(),
  totals,
  restrictedIds = new Set(),
}) {
  // The set of tiers eligible as relocation targets is fixed up front
  // (from the layering this refinement started with), one list per
  // parity -- a relocated node can land on any tier its own type already
  // legitimately occupies, but this search never invents a brand new
  // tier or empties out the only remaining one of a parity.
  const poolLayers = [...new Set(ids.filter((id) => rawById[id]?.type === 'pool').map((id) => layerOf.get(id) ?? 0))];
  const nonPoolLayers = [
    ...new Set(ids.filter((id) => rawById[id]?.type !== 'pool' && rawById[id]?.type !== 'stim').map((id) => layerOf.get(id) ?? 0)),
  ];
  // `restrictedIds` (computeFlowGroupLayout's own shortRowMembers -- a
  // node whose current tier is already small, but genuinely graph-
  // connected, not merely heuristic-pinned) only ever relocates onto a
  // tier that was ALREADY adequately sized (>= 3) before this search
  // began -- draining an accidental small offshoot into a real, already-
  // substantial row is the whole point (see computeShortRowPenalty's own
  // comment), but letting it relocate onto any OTHER small tier too would
  // reward two small rows quietly consolidating into each other purely to
  // shrink the row-count penalty, with no real structural reason to sit
  // together -- verified directly against this file's own "10-tier
  // single-file chain" test, a maximally tight, real dependency chain
  // with nothing to merge into: without this restriction, adjacent
  // singleton tiers kept pairing off regardless of cost, unrecognizably
  // reshaping a layout the graph never asked for.
  const bigPoolLayers = poolLayers.filter((l) => ids.filter((id) => rawById[id]?.type === 'pool' && (layerOf.get(id) ?? 0) === l).length >= 3);
  const bigNonPoolLayers = nonPoolLayers.filter(
    (l) => ids.filter((id) => rawById[id]?.type !== 'pool' && rawById[id]?.type !== 'stim' && (layerOf.get(id) ?? 0) === l).length >= 3
  );
  function targetLayersFor(id) {
    const isPool = rawById[id]?.type === 'pool';
    if (restrictedIds.has(id)) return isPool ? bigPoolLayers : bigNonPoolLayers;
    return isPool ? poolLayers : nonPoolLayers;
  }
  const relocatable = movableIds.filter((id) => targetLayersFor(id).length > 0);

  function rowsOf(layerOfMap) {
    const byLayer = new Map();
    ids.forEach((id) => {
      const l = layerOfMap.get(id) ?? 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l).push(id);
    });
    return byLayer;
  }

  if (relocatable.length === 0 && [...rowsOf(layerOf).values()].every((row) => row.length < 2)) {
    return { layerOf, orderOf };
  }

  const scoreArgs = { ids, sizes, hexOffset, colGap, rowGap, orientation, edges, rawById, weights, totals };
  let currentLayerOf = new Map(layerOf);
  let currentOrderOf = new Map(orderOf);
  let currentScore = scoreFlowCandidate({ ...scoreArgs, layerOf: currentLayerOf, orderOf: currentOrderOf });

  const start = nowMs();
  let iterations = 0;
  while (nowMs() - start < timeBudgetMs && iterations < FLOW_REFINE_ITERATION_CAP) {
    iterations++;
    const tryRelocate = relocatable.length > 0 && rng() < 0.3;
    let candidateLayerOf = currentLayerOf;
    let candidateOrderOf;

    if (tryRelocate) {
      const id = relocatable[Math.floor(rng() * relocatable.length)];
      const own = currentLayerOf.get(id) ?? 0;
      const candidates = targetLayersFor(id).filter((l) => l !== own);
      if (candidates.length === 0) continue;
      const targetLayer = candidates[Math.floor(rng() * candidates.length)];
      candidateLayerOf = new Map(currentLayerOf);
      candidateLayerOf.set(id, targetLayer);
      const targetRowSize = ids.filter((other) => other !== id && (candidateLayerOf.get(other) ?? 0) === targetLayer).length;
      candidateOrderOf = new Map(currentOrderOf);
      candidateOrderOf.set(id, targetRowSize);
    } else {
      const rows = [...rowsOf(currentLayerOf).values()].filter((row) => row.length >= 2);
      if (rows.length === 0) continue;
      const row = rows[Math.floor(rng() * rows.length)];
      const i = Math.floor(rng() * row.length);
      let j = Math.floor(rng() * row.length);
      if (j === i) j = (j + 1) % row.length;
      const a = row[i];
      const b = row[j];
      candidateOrderOf = new Map(currentOrderOf);
      candidateOrderOf.set(a, currentOrderOf.get(b));
      candidateOrderOf.set(b, currentOrderOf.get(a));
    }

    const candidateScore = scoreFlowCandidate({ ...scoreArgs, layerOf: candidateLayerOf, orderOf: candidateOrderOf });
    if (candidateScore <= currentScore) {
      currentLayerOf = candidateLayerOf;
      currentOrderOf = candidateOrderOf;
      currentScore = candidateScore;
    }
  }
  return { layerOf: currentLayerOf, orderOf: currentOrderOf };
}

// refineFlowOrder's own swap move (see its own comment) picks any two
// items in a row purely by score, with no notion of "these came from the
// same series cluster" at all -- verified directly against Kholodenko.g's
// own MAPK group: MKK/MKK_P/MKK_PP (already correctly anchored onto the
// SAME row by detectSeriesClusters/Round 1's own anchor pin) ended up
// scattered across that row instead of sitting next to each other, since
// nothing in the score rewards contiguity specifically. Run as the very
// last ordering step, after both refinement and the final merge, so
// nothing downstream of it can re-scatter a cluster it just consolidated.
//
// Every cluster sharing a row is placed in ONE simultaneous pass per row
// (not cluster-by-cluster) -- an earlier version inserted each cluster's
// block into the row one at a time, which reads as safe in isolation but
// isn't: the second cluster's own insertion point is computed by index
// into "everything else", and "everything else" still contains the FIRST
// cluster's just-consolidated block -- an index-based splice has no idea
// that block needs to stay intact, so it can (and, verified directly
// against Kholodenko.g's own MAPK group, reliably did) land its insertion
// point straight through the middle of it. Building every row's final
// order from "units" (a lone item, or one whole cluster-block) sorted
// once by each unit's own average original position sidesteps this
// entirely -- nothing is ever spliced into something still being placed.
// Each cluster's own members are ordered shortest-name-first (MKK,
// MKK_P, MKK_PP), matching this file's own shorter-name-is-upstream
// convention.
function groupSeriesClustersContiguously(ids, layerOf, orderOf, rawById, seriesClusters) {
  const clusterIndexById = new Map();
  seriesClusters.forEach((cluster, i) => cluster.forEach((id) => clusterIndexById.set(id, i)));

  const rowMembers = new Map();
  ids.forEach((id) => {
    const l = layerOf.get(id) ?? 0;
    if (!rowMembers.has(l)) rowMembers.set(l, []);
    rowMembers.get(l).push(id);
  });

  const newOrderOf = new Map(orderOf);
  rowMembers.forEach((row) => {
    const rowClusterIdxs = new Set(row.map((id) => clusterIndexById.get(id)).filter((i) => i !== undefined));
    if (rowClusterIdxs.size === 0) return;
    const rowSorted = [...row].sort((a, b) => (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0));
    const rankOf = new Map(rowSorted.map((id, i) => [id, i]));
    const seenClusters = new Set();
    const units = [];
    rowSorted.forEach((id) => {
      const ci = clusterIndexById.get(id);
      if (ci === undefined) {
        units.push({ key: rankOf.get(id), members: [id] });
        return;
      }
      if (seenClusters.has(ci)) return; // this cluster's unit was already emitted
      seenClusters.add(ci);
      const members = seriesClusters[ci].filter((m) => rankOf.has(m));
      const avg = members.reduce((sum, m) => sum + rankOf.get(m), 0) / members.length;
      const sortedMembers = [...members].sort((a, b) => (rawById[a]?.name?.length ?? 0) - (rawById[b]?.name?.length ?? 0));
      units.push({ key: avg, members: sortedMembers });
    });
    units.sort((a, b) => a.key - b.key);
    let i = 0;
    units.forEach((u) => u.members.forEach((id) => newOrderOf.set(id, i++)));
  });
  return newOrderOf;
}

// "If ever the aspect ratio becomes more than 2.5 horizontal vs 1
// vertical, break the rows" -- a group with few tiers and many members
// per tier (Kholodenko.g's own MAPK group: just 3 tiers, one 12-wide)
// reads as an unusably wide strip rather than the readable top-to-bottom
// flow this feature exists for. Splitting the widest row into two
// adjacent, SAME-type sub-rows is the one move that fixes width without
// ever touching alternation: both halves are still the one tier, split
// only for its own sake, never a second, unrelated tier landing next to
// it -- exactly the case mergeAdjacentSameParityRows's own invariant
// guards against for a DIFFERENT tier, so that merge is deliberately
// never re-run after this (it would just fold the split straight back
// together). The split uses a fractional layer key -- an epsilon strictly
// between the row's own layer and its neighbor -- purely because
// assignFlowCoordinates only ever reads layer keys by relative SORT
// ORDER, never their literal value: the same trick
// mergeAdjacentSameParityRows itself relies on, just run in reverse.
//
// Deliberately the LAST transform in the whole pipeline -- after the
// final merge and the series-contiguity pass -- since it's the one step
// whose entire job is to locally violate what every earlier step spent
// its effort establishing (one tier, one row). The plain midpoint split
// still has to dodge series-cluster boundaries, though (`clusterIndexById`)
// -- otherwise it would happily cut MKK/MKK_P away from MKK_PP right
// after groupSeriesClustersContiguously just put them together
// (verified directly against Kholodenko.g's own MAPK group: a 12-wide
// pool row wide enough to trigger a split cut straight through the
// MKK series at its own midpoint).
const FLOW_TARGET_ASPECT = 2.5;
const FLOW_WRAP_MAX_PASSES = 8;
const FLOW_WRAP_MIN_ROW_SIZE = 4; // below this, a further split would only trade one small row for two smaller ones

// The valid split index closest to `mid` that never falls strictly
// inside a run of same-cluster members -- searched outward from `mid` in
// both directions at once so the result stays close to an even split
// whenever more than one valid point exists. Falls back to `mid` itself
// on the (pathological) case where literally every boundary in the row
// cuts through a cluster.
function nearestClusterSafeSplit(members, mid, clusterIndexById) {
  const isSafe = (i) => {
    if (i <= 0 || i >= members.length) return true;
    const a = clusterIndexById.get(members[i - 1]);
    const b = clusterIndexById.get(members[i]);
    return a == null || a !== b;
  };
  if (isSafe(mid)) return mid;
  for (let d = 1; d < members.length; d++) {
    if (mid - d >= 1 && isSafe(mid - d)) return mid - d;
    if (mid + d <= members.length - 1 && isSafe(mid + d)) return mid + d;
  }
  return mid;
}

function wrapWideRows(ids, layerOf, orderOf, sizes, orientation, colGap, rowGap, hexOffset, clusterIndexById = new Map()) {
  let curLayerOf = new Map(layerOf);
  let curOrderOf = new Map(orderOf);
  let epsilon = 0;
  for (let pass = 0; pass < FLOW_WRAP_MAX_PASSES; pass++) {
    const positions = assignFlowCoordinates({ ids, layerOf: curLayerOf, orderOf: curOrderOf, sizes, hexOffset, colGap, rowGap, orientation });
    const rights = ids.map((id) => positions.get(id).x + (sizes.get(id)?.width ?? 0));
    const lefts = ids.map((id) => positions.get(id).x);
    const tops = ids.map((id) => positions.get(id).y);
    const bottoms = ids.map((id) => positions.get(id).y - (sizes.get(id)?.height ?? 0));
    const width = Math.max(...rights) - Math.min(...lefts);
    const height = Math.max(...tops) - Math.min(...bottoms);
    if (height <= 0 || width / height <= FLOW_TARGET_ASPECT) break;

    const rows = new Map();
    ids.forEach((id) => {
      const l = curLayerOf.get(id) ?? 0;
      if (!rows.has(l)) rows.set(l, []);
      rows.get(l).push(id);
    });
    let widestLayer = null;
    let widestSize = 0;
    rows.forEach((members, l) => {
      if (members.length > widestSize) {
        widestSize = members.length;
        widestLayer = l;
      }
    });
    if (widestLayer === null || widestSize < FLOW_WRAP_MIN_ROW_SIZE) break; // nothing left worth splitting

    const members = [...rows.get(widestLayer)].sort((a, b) => (curOrderOf.get(a) ?? 0) - (curOrderOf.get(b) ?? 0));
    const mid = nearestClusterSafeSplit(members, Math.ceil(members.length / 2), clusterIndexById);
    if (mid <= 0 || mid >= members.length) break; // the whole row is one cluster -- nothing safe to split
    epsilon += 1e-4;
    const newLayer = widestLayer + epsilon;
    members.slice(mid).forEach((id, i) => {
      curLayerOf.set(id, newLayer);
      curOrderOf.set(id, i);
    });
    members.slice(0, mid).forEach((id, i) => curOrderOf.set(id, i));
  }
  return { layerOf: curLayerOf, orderOf: curOrderOf };
}

// Lays out one container's direct children by information flow (see the
// planning discussion this shipped from -- points 2/3: pool<->non-pool
// alternation falls straight out of layering, since every flow edge type
// has exactly one pool endpoint and one non-pool endpoint; reactions
// nearer their inputs land above ones nearer their outputs). Deterministic,
// not a scored candidate the way optimizeGroupLayout's SA search is --
// there's no discard-if-worse gate here, since there's no meaningful
// fallback arrangement if a user explicitly asked for a flow layout
// specifically (though the ordering *within* that structure is still
// refined against the real score -- see refineFlowOrder above).
//
// A locked child (see App.jsx's data.locked) is excluded from the flow
// graph entirely -- not merely pinned to its current row -- the same way
// it's already excluded from optimizeGroupLayout's own packing: it keeps
// its own current position outright, and this app's one existing "leave
// this alone" flag (already covering drag/resize/flip) doubles as the
// flow layout's own manual-override mechanism, with no new UI concept
// needed. Its edges to/from unlocked neighbors are dropped along with it
// (layoutFlow.js's own edge filtering already ignores anything touching
// an id outside the set it's given), rather than distorting their layers
// to route around a fixed point that isn't participating.
//
// `rawById` must cover the whole model (not just this group) -- both
// computeFlipUpdates and scoring a reac/enz whose substrate/product
// partner lives outside this group need that neighbor's own real
// position, same requirement optimizeGroupLayout already has. It's also
// what lets detectOutputEntities/detectOutputPools tell a real external
// connection apart from no connection at all -- `edges` (unfiltered, not
// flowEdges) is passed to them for the same reason.
//
// Layering runs twice. The first (baseline) pass only applies the
// isolated-node parity pins above -- "the bottom" that a detected output
// entity/pool belongs at, and the "anchor" layer a detected series
// clusters onto, aren't known until *something* has already been
// layered. The second pass folds in the refined pins from all three
// heuristics (output entities/pools override a series pin on the same
// node where both apply -- the user's own framing called 1/2 "strong"
// heuristics and 3 only "ideally", so a conflict resolves toward the
// stronger signal) and produces the layering actually used.
export function computeFlowGroupLayout({ children, edges, rawById, sizes, weights = DEFAULT_SCORE_WEIGHTS, timeBudgetMs = FLOW_REFINE_TIME_BUDGET_MS, rng = makeRng() }) {
  // Shorter names first -- see point 5's own heuristic: a short name is
  // more often an upstream/input species (a bare ligand or ion, "Ca",
  // "DAG") while composite/derived states accumulate long compound names
  // deeper in a pathway ("PIP2_Ca_PLA2_p"). Real structural edges always
  // take priority over this -- it only ever breaks ties the graph itself
  // can't resolve (which isolated child defaults nearer the top, and
  // which node gets sacrificed when greedyFeedbackArcSet has to pick one
  // out of a genuine cycle) -- feeding it in as the base order before any
  // graph algorithm runs is what makes it act as the tie-break wherever
  // ties come up, rather than a separate rule bolted on afterward.
  const unlocked = [...children.filter((c) => !c.locked)].sort((a, b) => (a.name?.length ?? 0) - (b.name?.length ?? 0));
  const ids = unlocked.map((c) => c.id);
  const idSet = new Set(ids);
  const flowEdges = edges
    .filter((e) => FLOW_EDGE_TYPES.has(e.data?.type) && idSet.has(e.source) && idSet.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const { backEdgeIndices } = greedyFeedbackArcSet(ids, flowEdges);
  const baselinePins = isolatedLayerPins(ids, rawById, flowEdges);
  pinStims(baselinePins, ids, rawById);
  const baselineLayerOf = assignLayers(ids, flowEdges, backEdgeIndices, baselinePins);

  const outputEntities = detectOutputEntities(ids, rawById, edges);
  const outputPools = detectOutputPools(ids, rawById, edges);
  const seriesClusters = detectSeriesClusters(ids, rawById);
  const seriesMemberIds = new Set(seriesClusters.flat());

  // Round 1: apply series-cluster anchors alone (using the pre-anything
  // baseline) and re-layer. This has to happen BEFORE measuring "the
  // bottom" below -- pulling a cluster's shallowest member's whole
  // downstream chain up to its anchor can make what used to be a deep
  // reaction/pool row become much shallower than the group's own
  // baseline computation ever assumed (verified directly against
  // synSynth7.g's own PKC group: two reactions downstream of a
  // series-clustered pool dropped from baseline layer 5 to a final layer
  // of 3 once their substrate's own cluster anchor took effect). Measuring
  // "the deepest real row" from the stale pre-cluster baseline instead of
  // this pinned exactly the output floor two layers too deep, leaving an
  // entire pool row's worth of empty gap between it and the real chain
  // above it -- which is what actually produced the "very long pool row,
  // then two non-alternating reaction/enzyme rows" layout this was
  // tracked down from.
  const seriesOnlyPins = new Map(baselinePins);
  seriesClusters.forEach((cluster) => {
    const anchor = Math.min(...cluster.map((id) => baselineLayerOf.get(id) ?? 0));
    cluster.forEach((id) => seriesOnlyPins.set(id, anchor));
  });
  const postSeriesLayerOf = assignLayers(ids, flowEdges, backEdgeIndices, seriesOnlyPins);

  // The deepest REAL (non-output) row of each parity, now measured
  // against the POST-series-shift layering -- what "the bottom" means
  // for pinning a detected output entity/pool onto. Math.max's own seed
  // (1 for non-pools, 0 for pools) is each parity's natural minimum, so
  // an all-output group still pins to a parity-correct layer instead of
  // collapsing to 0 for everything.
  const maxNonPoolLayer = Math.max(
    1,
    ...ids.filter((id) => rawById[id]?.type !== 'pool' && !outputEntities.has(id)).map((id) => postSeriesLayerOf.get(id) ?? 0)
  );
  const maxPoolLayer = Math.max(
    0,
    ...ids.filter((id) => rawById[id]?.type === 'pool' && !outputPools.has(id)).map((id) => postSeriesLayerOf.get(id) ?? 0)
  );

  // Round 2: reconcile a series cluster with output-pool detection using
  // the now-accurate post-series depths (see the cluster-splitting
  // comment this carries forward from last round -- a series cluster and
  // an individually-detected output pool can disagree about the SAME
  // node, e.g. a phosphorylation series' own middle members each
  // independently feeding 2+ external consumers). Resolved at the
  // CLUSTER level, not per-member: if any member is an output pool, the
  // whole cluster moves to the output floor together (never shallower
  // than its own already-settled anchor, only deeper), instead of
  // letting the two heuristics fight over individual members.
  const pinnedLayers = new Map(seriesOnlyPins);
  seriesClusters.forEach((cluster) => {
    if (!cluster.some((id) => outputPools.has(id))) return;
    const current = postSeriesLayerOf.get(cluster[0]) ?? 0; // every member already shares this, from round 1's own pin
    const anchor = Math.max(current, maxPoolLayer);
    cluster.forEach((id) => pinnedLayers.set(id, anchor));
  });
  outputEntities.forEach((id) => pinnedLayers.set(id, maxNonPoolLayer));
  outputPools.forEach((id) => {
    if (seriesMemberIds.has(id)) return; // already resolved above, at the whole cluster's level
    if ((postSeriesLayerOf.get(id) ?? 0) < maxPoolLayer) pinnedLayers.set(id, maxPoolLayer);
  });

  // Merged immediately, before orientation/ordering/refinement ever see
  // it -- otherwise chooseFlowOrientation would count phantom extra
  // tiers, and orderWithinLayers/refineFlowOrder would both be working
  // from a tier structure this whole layout is about to collapse anyway.
  const seedLayerOf = mergeAdjacentSameParityRows(ids, assignLayers(ids, flowEdges, backEdgeIndices, pinnedLayers), rawById);
  const orientation = chooseFlowOrientation(ids, seedLayerOf);
  const seedOrderOf = orderWithinLayers(ids, seedLayerOf, flowEdges, 4);

  // Per-parity totals for computeShortRowPenalty's own exemption rule
  // (see its comment) -- `stim` never counts toward either side, the same
  // way it's excluded from the penalty's own row accounting.
  const totals = {
    pool: ids.filter((id) => rawById[id]?.type === 'pool').length,
    nonpool: ids.filter((id) => rawById[id]?.type !== 'pool' && rawById[id]?.type !== 'stim').length,
  };

  // Only nodes whose tier came from a heuristic (never a real graph
  // dependency) were ORIGINALLY eligible for refineFlowOrder's relocation
  // move -- moving anything else could put it on the wrong side of an
  // edge its neighbors actually rely on. Series-cluster members are
  // excluded even when also output-flagged (already resolved as a whole
  // cluster above, and relocating one member alone would re-fragment it
  // right back apart).
  //
  // Also movable now: any node whose seed row is already too small to
  // survive computeShortRowPenalty (see its own comment) -- a real, if
  // small, part of the graph (Repressillator.g's own lac-operator binding
  // cascade, verified live: a genuine 2-hop pool/reac/pool chain, not an
  // isolated default) can land in an under-sized row just as easily as a
  // heuristic pin can, and relocating ONE of its members never breaks a
  // dependency -- the edge it has to its row-mates simply gets longer,
  // which is exactly what the real score is already free to weigh against
  // the row-size penalty relocating it removes.
  const seedRowSize = new Map();
  ids.forEach((id) => {
    const type = rawById[id]?.type;
    if (type === 'stim') return;
    const parity = type === 'pool' ? 'pool' : 'nonpool';
    const l = seedLayerOf.get(id) ?? 0;
    const key = `${parity}:${l}`;
    seedRowSize.set(key, (seedRowSize.get(key) ?? 0) + 1);
  });
  const shortRowMembers = ids.filter((id) => {
    const type = rawById[id]?.type;
    if (type === 'stim' || seriesMemberIds.has(id)) return false;
    const parity = type === 'pool' ? 'pool' : 'nonpool';
    if (totals[parity] <= FLOW_SHORT_ROW_EXEMPT_TOTAL) return false;
    const l = seedLayerOf.get(id) ?? 0;
    return (seedRowSize.get(`${parity}:${l}`) ?? 0) <= 2;
  });

  const movableIds = [
    ...new Set([
      ...ids.filter((id) => baselinePins.has(id) && rawById[id]?.type !== 'stim'),
      ...outputEntities,
      ...[...outputPools].filter((id) => !seriesMemberIds.has(id)),
      ...shortRowMembers,
    ]),
  ];

  const { layerOf: refinedLayerOf, orderOf: refinedOrderOf } = refineFlowOrder({
    ids,
    edges,
    rawById,
    sizes,
    layerOf: seedLayerOf,
    orderOf: seedOrderOf,
    movableIds,
    hexOffset: true,
    colGap: FLOW_COL_GAP,
    rowGap: FLOW_ROW_GAP,
    orientation,
    weights,
    timeBudgetMs,
    rng,
    totals,
    restrictedIds: new Set(shortRowMembers),
  });
  // Merged again after refinement -- relocation can legitimately empty a
  // tier out completely (every one of its members moved elsewhere), and
  // if that tier was the only thing separating two same-parity tiers,
  // they're now adjacent too.
  const layerOf = mergeAdjacentSameParityRows(ids, refinedLayerOf, rawById);
  // Series clusters re-consolidated (see groupSeriesClustersContiguously's
  // own comment) now that neither refinement nor the merge can scatter
  // them again, then the whole thing wrapped for aspect ratio (see
  // wrapWideRows) -- deliberately the last two steps, in this order.
  const orderOf = groupSeriesClustersContiguously(ids, layerOf, refinedOrderOf, rawById, seriesClusters);
  const clusterIndexById = new Map();
  seriesClusters.forEach((cluster, i) => cluster.forEach((id) => clusterIndexById.set(id, i)));
  const wrapped = wrapWideRows(ids, layerOf, orderOf, sizes, orientation, FLOW_COL_GAP, FLOW_ROW_GAP, true, clusterIndexById);
  const positions = assignFlowCoordinates({
    ids,
    layerOf: wrapped.layerOf,
    orderOf: wrapped.orderOf,
    sizes,
    hexOffset: true,
    colGap: FLOW_COL_GAP,
    rowGap: FLOW_ROW_GAP,
    orientation,
  });
  return { positions, layerOf: wrapped.layerOf };
}
