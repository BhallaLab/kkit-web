// Sugiyama-style layered/hierarchical layout: greedy feedback-arc-set
// (cycle breaking) -> longest-path layering -> barycenter within-layer
// ordering -> coordinate assignment. Pure, no React/backend deps -- same
// testing/reuse rationale as layoutScore.js/layoutSeed.js (independently
// testable from a bare `node script.mjs`, safe to call from a tight loop).
//
// Coordinate convention matches layoutScore.js exactly: raw kkit units,
// Y-up, a node's x/y is its top-left corner.
//
// Deliberately generic over "nodes + directed edges" -- the same four
// functions serve both the molecule-level layout (pool <-> reac/enz/
// concchan/stim is an exactly bipartite graph by schema, so alternating
// rows fall straight out of layering with no special-casing) and,
// eventually, the group-level layout (a collapsed group-to-group
// digraph). Callers own which edges count as "flow" for a given level --
// e.g. an enzyme's own structural link to its host pool is not a flow
// edge and should be filtered out before calling in here, the same way
// layoutScore.js's own module comment leaves node sizing to its callers.

const DEFAULT_NODE_SIZE = 3;

function nodeWidth(size) {
  return size?.width > 0 ? size.width : DEFAULT_NODE_SIZE;
}
function nodeHeight(size) {
  return size?.height > 0 ? size.height : DEFAULT_NODE_SIZE;
}

// Real reaction networks routinely have feedback loops (autoinhibition,
// feedback phosphorylation, the repressilator's own 3-node cycle) --
// longest-path layering needs an acyclic graph to work on, so this picks
// which edges to treat as "backward" (against the flow) first. Eades-Lin-
// Smyth greedy heuristic: repeatedly strip every current sink to the back
// of the order and every current source to the front; when neither
// exists (the remaining graph is a genuine cycle with no sink or source),
// remove whichever node has the most lopsided out-minus-in degree and
// treat it as a source. O(V+E), no backtracking -- good enough for a
// heuristic layout, not trying to find the *minimum* feedback arc set
// (that's NP-hard).
export function greedyFeedbackArcSet(ids, edges) {
  const idSet = new Set(ids);
  const outEdgeIdx = new Map(ids.map((id) => [id, []]));
  const inEdgeIdx = new Map(ids.map((id) => [id, []]));
  edges.forEach((e, i) => {
    if (e.source === e.target) return; // a self-loop can never be "forward" either way; ignored for ordering
    if (!idSet.has(e.source) || !idSet.has(e.target)) return;
    outEdgeIdx.get(e.source).push(i);
    inEdgeIdx.get(e.target).push(i);
  });
  const outDeg = new Map(ids.map((id) => [id, outEdgeIdx.get(id).length]));
  const inDeg = new Map(ids.map((id) => [id, inEdgeIdx.get(id).length]));
  const remaining = new Set(ids);
  const removed = new Set();
  const front = []; // sources, growing forward
  const back = []; // sinks, growing backward (reversed once at the end)

  function removeNode(id) {
    removed.add(id);
    remaining.delete(id);
    outEdgeIdx.get(id).forEach((i) => {
      const t = edges[i].target;
      if (!removed.has(t)) inDeg.set(t, inDeg.get(t) - 1);
    });
    inEdgeIdx.get(id).forEach((i) => {
      const s = edges[i].source;
      if (!removed.has(s)) outDeg.set(s, outDeg.get(s) - 1);
    });
  }

  while (remaining.size > 0) {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of [...remaining]) {
        if (outDeg.get(id) === 0) {
          back.push(id);
          removeNode(id);
          progressed = true;
        }
      }
    }
    progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of [...remaining]) {
        if (inDeg.get(id) === 0) {
          front.push(id);
          removeNode(id);
          progressed = true;
        }
      }
    }
    if (remaining.size > 0) {
      let best = null;
      let bestScore = -Infinity;
      for (const id of remaining) {
        const score = outDeg.get(id) - inDeg.get(id);
        if (score > bestScore) {
          bestScore = score;
          best = id;
        }
      }
      front.push(best);
      removeNode(best);
    }
  }

  const order = [...front, ...back.reverse()];
  const positionOf = new Map(order.map((id, i) => [id, i]));
  const backEdgeIndices = new Set();
  edges.forEach((e, i) => {
    if (e.source === e.target) return;
    if (!idSet.has(e.source) || !idSet.has(e.target)) return;
    if (positionOf.get(e.source) > positionOf.get(e.target)) backEdgeIndices.add(i);
  });
  return { order, backEdgeIndices };
}

// Longest-path layering over the acyclic (forward-edges-only) graph --
// layer(v) = 0 for a source, else 1 + max(layer(predecessor)). Taking the
// *longest* incoming path (not shortest, not first-found) is what keeps
// every edge pointing strictly downward instead of occasionally skipping
// backward -- a node with dependencies at very different depths always
// settles below its deepest one. `pinnedLayers` (nodeId -> layer number)
// lets a locked node's layer stand as a fixed point instead of being
// computed -- its own successors still layer normally off of it, only its
// own value is overridden (mirrors how `locked` already means "trust the
// user" everywhere else in this app).
export function assignLayers(ids, edges, backEdgeIndices, pinnedLayers = new Map()) {
  const idSet = new Set(ids);
  const preds = new Map(ids.map((id) => [id, []]));
  const succs = new Map(ids.map((id) => [id, []]));
  edges.forEach((e, i) => {
    if (e.source === e.target) return;
    if (!idSet.has(e.source) || !idSet.has(e.target)) return;
    if (backEdgeIndices.has(i)) return;
    preds.get(e.target).push(e.source);
    succs.get(e.source).push(e.target);
  });

  // Kahn's algorithm to get a valid topological order of the (now
  // acyclic) forward graph -- needed because `ids` itself carries no
  // ordering guarantee.
  const inDegWork = new Map(ids.map((id) => [id, preds.get(id).length]));
  const queue = ids.filter((id) => inDegWork.get(id) === 0);
  const topoOrder = [];
  while (queue.length > 0) {
    const id = queue.shift();
    topoOrder.push(id);
    succs.get(id).forEach((t) => {
      inDegWork.set(t, inDegWork.get(t) - 1);
      if (inDegWork.get(t) === 0) queue.push(t);
    });
  }
  // Every node should appear via Kahn's algorithm once back edges are
  // excluded -- this only guards against a caller passing inconsistent
  // backEdgeIndices (a genuine remaining cycle), appending whatever's
  // left in its original order rather than silently dropping it.
  const seen = new Set(topoOrder);
  ids.forEach((id) => {
    if (!seen.has(id)) topoOrder.push(id);
  });

  // First pass: plain longest-path over the forward-only graph.
  const firstPass = new Map();
  topoOrder.forEach((id) => {
    if (pinnedLayers.has(id)) {
      firstPass.set(id, pinnedLayers.get(id));
      return;
    }
    const ps = preds.get(id);
    firstPass.set(id, ps.length === 0 ? 0 : Math.max(...ps.map((p) => firstPass.get(p) ?? 0)) + 1);
  });

  // A node with no FORWARD predecessor isn't necessarily a genuine root --
  // it may simply have lost its only real predecessor edge to
  // greedyFeedbackArcSet's own cycle-breaking. That's not a rare edge
  // case: any reversible reaction, or any phosphorylation/
  // dephosphorylation pair (an extremely common kkit pattern -- verified
  // directly against Kholodenko.g's own MAPK cascade, built entirely out
  // of exactly this), forms a cycle with its own shared pools, and FAS
  // has to cut *something* to break it. A back edge into such a node
  // still carries real information even though it couldn't be used for
  // the acyclic pass itself -- floor its layer at one past whatever that
  // predecessor's own (first-pass) layer already was, rather than leaving
  // it stranded at 0 as if it were a true source (which, left uncorrected,
  // mixes a non-pool in with genuine layer-0 input pools). A second full
  // pass -- not just patching the affected nodes in isolation -- lets
  // that corrected floor cascade to everything downstream of it too,
  // using `firstPass` (not the being-built `layerOf`) as the floor's own
  // source so this can never cycle back on itself.
  const floors = new Map();
  edges.forEach((e, i) => {
    if (!backEdgeIndices.has(i)) return;
    if (!idSet.has(e.source) || !idSet.has(e.target)) return;
    if (preds.get(e.target).length > 0) return; // has a real forward predecessor; this back edge adds nothing
    const floor = firstPass.get(e.source) + 1;
    if ((floors.get(e.target) ?? -1) < floor) floors.set(e.target, floor);
  });

  const layerOf = new Map();
  topoOrder.forEach((id) => {
    if (pinnedLayers.has(id)) {
      layerOf.set(id, pinnedLayers.get(id));
      return;
    }
    const ps = preds.get(id);
    layerOf.set(id, ps.length === 0 ? floors.get(id) ?? 0 : Math.max(...ps.map((p) => layerOf.get(p) ?? 0)) + 1);
  });
  return layerOf;
}

// Classic median/barycenter crossing-reduction sweep: within each row,
// reorder nodes by the average position (in its own current order) of
// their neighbors in the adjacent row, alternating top-down and
// bottom-up passes over several iterations. Uses *every* edge (including
// back edges) for this, not just the forward ones layering used -- a
// feedback edge still draws a real line on screen that benefits from
// being kept short/uncrossed, even though it doesn't get a say in which
// row anything lands on. A node with no neighbors in the reference row
// keeps its current position (stable sort), so unrelated nodes don't get
// shuffled for no reason.
export function orderWithinLayers(ids, layerOf, edges, iterations = 4) {
  const idSet = new Set(ids);
  const byLayer = new Map();
  ids.forEach((id) => {
    const l = layerOf.get(id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(id);
  });
  const layers = [...byLayer.keys()].sort((a, b) => a - b);

  const orderOf = new Map();
  layers.forEach((l) => {
    byLayer.get(l).forEach((id, i) => orderOf.set(id, i));
  });

  const neighbors = new Map(ids.map((id) => [id, []]));
  edges.forEach((e) => {
    if (e.source === e.target) return;
    if (!idSet.has(e.source) || !idSet.has(e.target)) return;
    neighbors.get(e.source).push(e.target);
    neighbors.get(e.target).push(e.source);
  });

  function sweepLayer(l, refLayer) {
    const row = [...byLayer.get(l)].sort((a, b) => orderOf.get(a) - orderOf.get(b));
    const scored = row.map((id) => {
      const neigh = neighbors.get(id).filter((n) => (layerOf.get(n) ?? -1) === refLayer);
      const key = neigh.length === 0 ? orderOf.get(id) : neigh.reduce((sum, n) => sum + orderOf.get(n), 0) / neigh.length;
      return { id, key };
    });
    scored.sort((a, b) => a.key - b.key);
    scored.forEach((s, i) => orderOf.set(s.id, i));
  }

  for (let iter = 0; iter < iterations; iter++) {
    for (let li = 1; li < layers.length; li++) sweepLayer(layers[li], layers[li - 1]);
    for (let li = layers.length - 2; li >= 0; li--) sweepLayer(layers[li], layers[li + 1]);
  }
  return orderOf;
}

// Turns (layer, order-within-layer) into real positions.
//
// The cross axis (left-right for a top-to-bottom flow, or up-down for a
// left-to-right one -- see `orientation`) uses ONE uniform pitch for
// EVERY tier, not each tier's own content width -- this is what makes a
// hex/brick pattern actually interlock: every tier shares the same
// rhythm, so an odd tier shifted by exactly half that pitch nestles
// between the tier above and below it regardless of how many items
// either one holds. A per-tier content-driven width (the original
// design) breaks this the moment two tiers have different item counts --
// each tier ends up independently centered/left-packed at its own scale,
// so the "offset" stops meaning anything consistent and reads as
// arbitrary rather than a grid (verified directly against a real,
// unevenly-populated group). No centering is applied for the same
// reason: every tier already shares the same slot 0 origin, so a shorter
// tier is simply shorter, not re-centered against the longest one.
//
// `orientation: 'horizontal'` swaps which axis is "layer" (flow
// direction) and which is "position within a tier" -- for a graph that
// naturally layers into many tiers with few items each, stacking tiers
// top-to-bottom produces an unusably tall, narrow result; turning the
// same layering sideways (tiers become columns, flow runs left-to-right)
// keeps the same information and reads far better. Which orientation to
// pick is the caller's call (it depends on the layer count vs. typical
// tier size, which this module has no opinion on) -- this only executes
// the choice once made.
export function assignFlowCoordinates({ ids, layerOf, orderOf, sizes, hexOffset = false, colGap = 2, rowGap = 3, orientation = 'vertical' }) {
  const byLayer = new Map();
  ids.forEach((id) => {
    const l = layerOf.get(id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(id);
  });
  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  layers.forEach((l) => {
    byLayer.get(l).sort((a, b) => (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0));
  });

  const vertical = orientation !== 'horizontal';
  const crossSize = (id) => (vertical ? nodeWidth(sizes.get(id)) : nodeHeight(sizes.get(id)));
  const mainSize = (id) => (vertical ? nodeHeight(sizes.get(id)) : nodeWidth(sizes.get(id)));

  const crossPitch = Math.max(...ids.map(crossSize)) + colGap;
  const hexShift = hexOffset ? crossPitch / 2 : 0;

  const positions = new Map();
  let mainPos = 0;
  layers.forEach((l, li) => {
    const row = byLayer.get(l);
    const crossOffset = li % 2 === 1 ? hexShift : 0;
    row.forEach((id, i) => {
      const cross = crossOffset + i * crossPitch;
      positions.set(id, vertical ? { x: cross, y: mainPos } : { x: mainPos, y: -cross });
    });
    const extent = Math.max(...row.map(mainSize));
    mainPos += vertical ? -(extent + rowGap) : extent + rowGap;
  });
  return positions;
}

// Top-level orchestrator wiring all four stages together -- see each
// stage's own comment for why it exists. `edges` should already be
// filtered by the caller to whatever this level considers a "flow" edge
// (e.g. an enzyme's structural link to its host pool is excluded at the
// molecule level; a group's structural containment has no analogue at
// all). `pinnedLayers` carries forward a locked node's fixed row, if any.
export function computeFlowLayout({ ids, edges, sizes, pinnedLayers = new Map(), hexOffset = false, colGap = 2, rowGap = 3, orientation = 'vertical', iterations = 4 }) {
  const { backEdgeIndices } = greedyFeedbackArcSet(ids, edges);
  const layerOf = assignLayers(ids, edges, backEdgeIndices, pinnedLayers);
  const orderOf = orderWithinLayers(ids, layerOf, edges, iterations);
  const positions = assignFlowCoordinates({ ids, layerOf, orderOf, sizes, hexOffset, colGap, rowGap, orientation });
  return { positions, layerOf, backEdgeIndices };
}
