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
