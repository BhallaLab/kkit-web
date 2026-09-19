// Pure, frontend-only scoring for "how good is this candidate layout" --
// used by the intra-group auto-layout optimizer (see App.jsx's
// onAutoLayoutGroup/computeLocalLayouts, and the planning discussion this
// shipped from) to compare candidate arrangements of one container's
// direct children. Never touches React state, the backend, or App.jsx's
// own node/edge shapes directly -- every function here takes plain
// {id,x,y,width,height,flipped,type} node objects and {source,target,type}
// edge objects and returns plain data, so it's independently testable
// (including from a bare `node script.mjs`, no React/bundler needed) and
// safe to call many times inside a tight search loop without dragging in
// any of App.jsx's own machinery.
//
// Coordinate convention: raw kkit units, Y-up -- the same space App.jsx's
// own layout functions (onAutoLayoutGroup, computeLocalLayouts,
// effectiveContainerBox) already work in, not React Flow's flow-pixel/
// Y-down space. A node's own x/y is its top-left corner (matching
// effectiveContainerBox's own convention: the "bottom" edge is
// `y - height`, not `y + height`).
//
// Callers own node sizing -- this module never guesses a node's width/
// height itself (falling back to a small constant only if one is
// missing/falsy, purely so a slightly-underspecified node doesn't crash
// scoring rather than as a real sizing strategy); App.jsx's own
// childFootprint (or a more precise per-type estimate) is the right place
// to resolve real sizes before calling in here.

const DEFAULT_NODE_SIZE = 3;

// Which side of the SOURCE node, and which side of the TARGET node, a
// given edge type attaches to -- 'auto-source'/'auto-target' mean "use
// that node's own flip via the generic outgoing/incoming rule", mirroring
// nodes.jsx's own PoolNode/SubstrateHandle/ProductHandle geometry exactly
// (every type's plain "outgoing" and "incoming" handle sides are governed
// by the identical flipped ? ... : ... rule, whether it's a Pool's own
// generic source/target pair or a Reac/Enz's substrate/product one); a
// literal 'bottom' is a fixed structural link (a stimulus's own tip) that
// never moves; 'auto-parent' is also a structural link (an enzyme's own
// enzSite, or a ConcChan's own chanParent) but one that -- unlike
// 'bottom' -- picks whichever of top/bottom is actually closer to the
// real host molecule (see App.jsx's computeInitialParentSides, which
// computes and persists the same node.parentSide this reads), since
// substrate/product (or chanIn/chanOut) already own the left/right sides
// and a fixed side would otherwise route a long way around whenever the
// real parent pool sits on the "wrong" side.
//
// A candidate score built off plain node-center distances would be
// flip-blind -- flipping a reac/enz never changes its center, so that
// score could never reward getting a flip right, which defeats the whole
// point of fixing flips before scoring (see App.jsx's computeFlipUpdates,
// meant to run immediately before this). Real per-edge-type attachment
// points make the score actually respond to flip decisions.
const EDGE_ATTACHMENT = {
  substrate: { source: 'auto-source', target: 'auto-target' },
  product: { source: 'auto-source', target: 'auto-target' },
  chanIn: { source: 'auto-source', target: 'auto-target' },
  chanOut: { source: 'auto-source', target: 'auto-target' },
  enzyme: { source: 'auto-source', target: 'auto-parent' },
  chanParent: { source: 'auto-source', target: 'auto-parent' },
  stimTarget: { source: 'bottom', target: 'auto-target' },
};

function resolveSide(spec, node) {
  if (spec === 'bottom') return 'bottom';
  if (spec === 'auto-parent') return node.parentSide === 'top' ? 'top' : 'bottom';
  if (spec === 'auto-target') return node.flipped ? 'right' : 'left';
  return node.flipped ? 'left' : 'right'; // 'auto-source'
}

function nodeWidth(n) {
  return n.width > 0 ? n.width : DEFAULT_NODE_SIZE;
}
function nodeHeight(n) {
  return n.height > 0 ? n.height : DEFAULT_NODE_SIZE;
}

function centerOf(n) {
  return { x: n.x + nodeWidth(n) / 2, y: n.y - nodeHeight(n) / 2 };
}

function attachmentPoint(n, side) {
  switch (side) {
    case 'left':
      return { x: n.x, y: centerOf(n).y };
    case 'right':
      return { x: n.x + nodeWidth(n), y: centerOf(n).y };
    case 'top':
      return { x: centerOf(n).x, y: n.y };
    case 'bottom':
      return { x: centerOf(n).x, y: n.y - nodeHeight(n) };
    default:
      return centerOf(n);
  }
}

// Standard orientation-based segment intersection test -- cheap and exact
// for the straight-line proxy every segment here uses (see the module
// comment above on why a straight line between attachment points, not the
// actual rendered bezier, is what gets scored).
function ccw(a, b, c) {
  return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
}
function segmentsIntersect(p1, p2, p3, p4) {
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

// Sampled-points box crossing test (not exact segment/rectangle geometry,
// but cheap and good enough to catch "this line visibly cuts through that
// icon", which is what actually matters for a score worth optimizing --
// the same trade-off collapseView.js's own lineCrossesBox makes, for the
// same reason; duplicated rather than imported since the two live in
// different domains -- inter-group collapsed-view routing there,
// intra-group molecule layout here -- that only coincidentally share a
// geometry primitive).
function lineCrossesBox(p1, p2, box, steps = 20) {
  const left = box.x;
  const right = box.x + nodeWidth(box);
  const top = box.y;
  const bottom = box.y - nodeHeight(box);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = p1.x + (p2.x - p1.x) * t;
    const y = p1.y + (p2.y - p1.y) * t;
    if (x >= left && x <= right && y <= top && y >= bottom) return true;
  }
  return false;
}

// Tunable per-component weights combining four very differently-scaled
// quantities (a length in kkit units, two small integer counts, an area
// in squared kkit units) into one scalar. Crossings and connector/icon
// overlaps are weighted well above a single unit's swing in the length ratio
// -- both read as much more visually disruptive than a merely-longer
// connector -- and area stays the "weak factor" the layout planning
// discussion called for.
export const DEFAULT_SCORE_WEIGHTS = { length: 1, crossing: 0.75, overlap: 1, area: 0.1 };

// `nodes`: [{id, x, y, width, height, flipped, type}], already positioned
// AND already sized by the caller for this candidate -- this module makes
// no layout decisions of its own, purely evaluates one.
// `edges`: [{id, source, target, type}] -- `type` one of EDGE_ATTACHMENT's
// own keys; an edge of any other type, or whose source/target isn't among
// `nodes` (it leaves this group entirely, e.g. to a sibling group), is
// silently skipped rather than guessed at -- there's no comparable
// attachment-point geometry to score for either case.
//
// Returns the per-component breakdown alongside the single combined
// `weighted` scalar -- callers doing simulated annealing or the final
// discard-gate only need `weighted` (via scoreRatio below), but the
// breakdown is worth keeping around for debugging/tuning the weights
// themselves.
export function computeLayoutScore(nodes, edges, weights = DEFAULT_SCORE_WEIGHTS) {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const segments = [];
  edges.forEach((e) => {
    const spec = EDGE_ATTACHMENT[e.type];
    if (!spec) return;
    const sourceNode = byId.get(e.source);
    const targetNode = byId.get(e.target);
    if (!sourceNode || !targetNode) return;
    const sourceSide = resolveSide(spec.source, sourceNode);
    const targetSide = resolveSide(spec.target, targetNode);
    segments.push({
      source: e.source,
      target: e.target,
      p1: attachmentPoint(sourceNode, sourceSide),
      p2: attachmentPoint(targetNode, targetSide),
    });
  });

  let length = 0;
  segments.forEach((s) => {
    length += Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y);
  });

  // Only counted between edges that don't share an endpoint -- two edges
  // meeting AT a shared node trivially touch there, not a meaningful
  // visual crossing.
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i];
      const b = segments[j];
      if (a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target) continue;
      if (segmentsIntersect(a.p1, a.p2, b.p1, b.p2)) crossings++;
    }
  }

  // A segment cutting through some OTHER node's own box, never either of
  // its own two endpoints.
  let overlaps = 0;
  segments.forEach((s) => {
    nodes.forEach((n) => {
      if (n.id === s.source || n.id === s.target) return;
      if (lineCrossesBox(s.p1, s.p2, n)) overlaps++;
    });
  });

  let area = 0;
  if (nodes.length > 0) {
    const xs = nodes.flatMap((n) => [n.x, n.x + nodeWidth(n)]);
    const ys = nodes.flatMap((n) => [n.y, n.y - nodeHeight(n)]);
    area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  }

  const weighted = weights.length * length + weights.crossing * crossings + weights.overlap * overlaps + weights.area * area;

  return { length, crossings, overlaps, area, weighted };
}

// The single number both the simulated-annealing per-move rule (reject
// outright above 1.5 -- "more than 50% worse than the current state") and
// the final discard gate (revert the whole run above 1.1 -- "more than
// 10% worse than what was on screen before") actually compare against.
// Lower is better -- this is a cost, not a fitness -- so a ratio of 1.2
// reads as "20% worse than the reference", 0.8 as "20% better".
// referenceWeighted <= 0 (an edge-free or perfectly-scored reference) is
// the one case a plain ratio can't express meaningfully -- treated as "any
// non-negative candidate cost is already as good as it gets".
export function scoreRatio(candidateWeighted, referenceWeighted) {
  if (referenceWeighted <= 0) return candidateWeighted <= 0 ? 1 : Infinity;
  return candidateWeighted / referenceWeighted;
}
