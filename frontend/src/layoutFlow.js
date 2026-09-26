// Two pure graph-order primitives shared by the grid-based flow layout
// (layoutGrid.js): cycle-breaking and longest-path depth. Both used
// purely as RANKING functions there (a sort key and a loss-function
// input), not to assign rows the way an earlier version of this file's
// own assignLayers/orderWithinLayers/assignFlowCoordinates did -- that
// whole layered-row coordinate model is gone, replaced by a fixed grid
// with alternation enforced structurally (see layoutGrid.js's own
// module comment). Kept as their own file (rather than folded into
// layoutGrid.js directly) for the same testing/reuse rationale as
// layoutScore.js/layoutSeed.js: pure, no React/backend deps,
// independently testable from a bare `node script.mjs`.
//
// Deliberately generic over "nodes + directed edges", not specific to
// the pool/non-pool bipartite schema -- layoutGrid.js's own callers own
// which edges count as "flow" for a given level.

// Real reaction networks routinely have feedback loops (autoinhibition,
// feedback phosphorylation, the repressilator's own 3-node cycle) --
// longest-path depth needs an acyclic graph to work on, so this picks
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

// Longest-path depth over the acyclic (forward-edges-only) graph --
// depth(v) = 0 for a source, else 1 + max(depth(predecessor)). Taking
// the *longest* incoming path (not shortest, not first-found) is what
// keeps every edge pointing toward increasing depth instead of
// occasionally skipping backward -- a node with dependencies at very
// different depths always settles below its deepest one. Purely a
// ranking output now (a sort key and a loss-function input for
// layoutGrid.js -- see its own flowTerm/initial-placement comments), not
// a row assignment -- callers needing "push this node toward the front/
// back" (an isolated node, a detected output boundary, ...) adjust the
// returned depth value directly afterward rather than pinning it during
// the computation, since nothing downstream needs the recursion itself
// to respect that override.
export function computeFlowDepth(ids, edges, backEdgeIndices) {
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
  // the acyclic pass itself -- floor its depth at one past whatever that
  // predecessor's own (first-pass) depth already was, rather than leaving
  // it stranded at 0 as if it were a true source. A second full pass --
  // not just patching the affected nodes in isolation -- lets that
  // corrected floor cascade to everything downstream of it too, using
  // `firstPass` (not the being-built `depthOf`) as the floor's own
  // source so this can never cycle back on itself.
  const floors = new Map();
  edges.forEach((e, i) => {
    if (!backEdgeIndices.has(i)) return;
    if (!idSet.has(e.source) || !idSet.has(e.target)) return;
    if (preds.get(e.target).length > 0) return; // has a real forward predecessor; this back edge adds nothing
    const floor = firstPass.get(e.source) + 1;
    if ((floors.get(e.target) ?? -1) < floor) floors.set(e.target, floor);
  });

  const depthOf = new Map();
  topoOrder.forEach((id) => {
    const ps = preds.get(id);
    depthOf.set(id, ps.length === 0 ? floors.get(id) ?? 0 : Math.max(...ps.map((p) => depthOf.get(p) ?? 0)) + 1);
  });
  return depthOf;
}
