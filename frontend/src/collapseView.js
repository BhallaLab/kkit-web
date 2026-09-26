// Pure, frontend-only computation of the "displayed" view from the full
// model graph once groups/compartments can be collapsed -- see the design
// discussion this shipped from. Never mutates flowGraph; App.jsx renders
// whatever this returns *instead of* the raw nodes/edges, while every
// other piece of state (selection, editing, add/remove) keeps working
// against the full underlying graph exactly as before.
//
// The core idea: an entity (pool/reac/enz/concchan/stim) is never itself
// collapsible, only the group/compartment *containing* it is -- so
// visibility only ever depends on walking a node's ancestor chain looking
// for a collapsed one. A group collapsing hides everything inside it
// recursively (including nested sub-groups, regardless of *their* own
// collapsed flag -- moot until the parent re-expands), which falls out for
// free by always resolving to the *outermost* collapsed ancestor, not the
// nearest one.

import { resolveGroupColor } from './colorUtils';

// How much clearance a route keeps from any group's border it isn't
// actually departing from (the crossing-test inflation), and the diameter
// every connector knob is drawn at (see nodes.jsx's data.knobSize) -- a
// single fixed pixel count read as "too narrow" on a sparse, widely-spaced
// layout and "way too wide" on a tight one, so this is instead a fraction
// of however far apart this *particular* model's own collapsed groups
// actually sit, computed fresh each time from the real nearest-neighbor
// gaps between them. Falls back to MIN_PAVEMENT when there's nothing to
// measure (0 or 1 collapsed group -- no neighbor gap exists at all).
const PAVEMENT_FRACTION = 0.22;
const MIN_PAVEMENT = 4;
const MAX_PAVEMENT = 40;

// The gap between two boxes along whichever axis they're actually
// *neighbors* on -- only meaningful (and only returned) when their extent
// on the OTHER axis overlaps at all; two boxes that don't line up in
// either row or column aren't "next to" each other in any sense a
// pavement measurement should care about.
function neighborGap(a, b) {
  const gaps = [];
  const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (yOverlap > 0) {
    const gap = a.x < b.x ? b.x - (a.x + a.width) : a.x - (b.x + b.width);
    if (gap > 0) gaps.push(gap);
  }
  const xOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  if (xOverlap > 0) {
    const gap = a.y < b.y ? b.y - (a.y + a.height) : a.y - (b.y + b.height);
    if (gap > 0) gaps.push(gap);
  }
  return gaps;
}

// The median nearest-neighbor row/column gap across every pair of
// *collapsed* boxes (an expanded container's box can be huge, which would
// badly skew a raw average -- only collapsed ones read as discrete,
// evenly-spaced "blocks" the way this measurement assumes), times
// PAVEMENT_FRACTION, clamped to a sane range. O(n^2) over the collapsed
// count, which is normally small (tens, not hundreds).
function computePavement(collapsedBoxes) {
  const gaps = [];
  for (let i = 0; i < collapsedBoxes.length; i++) {
    for (let j = i + 1; j < collapsedBoxes.length; j++) {
      gaps.push(...neighborGap(collapsedBoxes[i].box, collapsedBoxes[j].box));
    }
  }
  if (gaps.length === 0) return MIN_PAVEMENT;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.min(MAX_PAVEMENT, Math.max(MIN_PAVEMENT, median * PAVEMENT_FRACTION));
}

// Grows `box` by `margin` on every side -- used only for the *crossing
// test* (so a route within `margin` of a third group's edge counts as
// "too close", not just one that actually enters it), never for the box
// used to compute where a detour should clear to (orthogonalDetour keeps
// its own separate margin for that).
function inflateBox(box, margin) {
  return { x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2 };
}

function isGroupOrCompartment(node) {
  return node.data.type === 'group' || node.data.type === 'compartment';
}

// The outermost collapsed ancestor of `nodeId`, or null if none of its
// ancestors are collapsed. Walks bottom-up (child to root) but keeps
// overwriting `found` on every collapsed ancestor seen, so the *last*
// write -- the one furthest up the chain -- wins.
function outermostCollapsedAncestor(nodeId, byId, collapsedIds) {
  let cur = byId[nodeId];
  let found = null;
  while (cur && cur.parentId) {
    const parent = byId[cur.parentId];
    if (!parent) break;
    if (collapsedIds.has(parent.id)) found = parent.id;
    cur = parent;
  }
  return found;
}

// The generic style every consolidated inter-group edge uses, deliberately
// dropping the substrate/product/enzyme color-coding a direct edge
// carries -- collapsing is about *reducing* visual detail, and mixing
// several different line styles into one aggregate arrow would fight
// that. A case-5/5.1 edge (only one side collapsed) keeps its own real
// style, since it's still fundamentally one real connection, not a
// summary of several.
const AGGREGATE_EDGE_STYLE = { stroke: '#555', strokeWidth: 4 };

// `collapsedIds`: Set of currently-collapsed group/compartment node ids.
// Returns the node/edge lists to actually render -- collapsed groups
// themselves stay in the node list (rendered as an icon instead of a full
// box, a rendering choice ContainerNode itself makes off data.collapsed),
// only their *descendants* (entities and nested groups alike) are removed.
export function computeCollapsedView(nodes, edges, collapsedIds) {
  if (collapsedIds.size === 0) {
    return { nodes, edges };
  }
  const byId = {};
  nodes.forEach((n) => {
    byId[n.id] = n;
  });

  const visibleNodes = nodes.filter((n) => outermostCollapsedAncestor(n.id, byId, collapsedIds) === null);

  const resolve = (id) => outermostCollapsedAncestor(id, byId, collapsedIds) ?? id;

  // Aggregated by resolved (source, target) *unordered* pair only when
  // BOTH sides resolve to a collapsed group (section 4/4.1 -- "at most one
  // line... between any two groups"); kept individually, just with the
  // collapsed side's endpoint redirected, when only one side does (section
  // 5/5.1 -- each real connection converges on the same point, but stays
  // its own line).
  const aggregated = new Map();
  const individual = [];
  edges.forEach((e) => {
    const from = resolve(e.source);
    const to = resolve(e.target);
    // Both ends landed inside the very same collapsed group -- a purely
    // internal connection, not shown at all (matches "does not display
    // any of its contained entities").
    if (from === to) return;

    const fromIsGroup = collapsedIds.has(from);
    const toIsGroup = collapsedIds.has(to);
    if (fromIsGroup && toIsGroup) {
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      let agg = aggregated.get(key);
      if (!agg) {
        agg = { a: from < to ? from : to, b: from < to ? to : from, count: 0, aToB: false, bToA: false };
        aggregated.set(key, agg);
      }
      agg.count += 1;
      if (from === agg.a) agg.aToB = true;
      else agg.bToA = true;
    } else {
      // A collapsed group's box only ever exposes a plain, unnamed
      // Handle (see nodes.jsx's ContainerNode) -- it has no
      // "substrate"/"product"/etc. named handle the way the real
      // entity being redirected away from did, so keeping the original
      // sourceHandle/targetHandle id here would have React Flow look for
      // a handle that simply doesn't exist on the group and drop the
      // edge entirely (verified directly). Cleared on whichever side
      // actually got redirected; the other side's real handle id (when
      // that side wasn't touched) is left alone.
      const redirected = { ...e, source: from, target: to };
      if (fromIsGroup) delete redirected.sourceHandle;
      if (toIsGroup) delete redirected.targetHandle;
      individual.push(redirected);
    }
  });

  // The full obstacle list (every visible collapsed container's box), so
  // assignAggregatePorts' own routing can check a pair's connector against
  // *third* groups sitting between them -- not just each other -- the same
  // way avoidObstacles already does for individual/real edges below.
  const allObstacles = nodes
    .filter(isGroupOrCompartment)
    .map((n) => ({ id: n.id, box: absoluteBox(n.id, byId) }))
    .filter((o) => o.box);
  const pavement = computePavement(allObstacles.filter((o) => byId[o.id]?.data?.collapsed));

  const { portsByContainer, routeByPair } = assignAggregatePorts([...aggregated.values()], byId, allObstacles, pavement);

  const aggregatedEdges = [...aggregated.values()].map((agg) => {
    const route = routeByPair.get(`${agg.a}|${agg.b}`);
    return {
      id: `aggregate-${agg.a}-${agg.b}`,
      source: agg.a,
      target: agg.b,
      sourceHandle: route?.sourceHandle,
      targetHandle: route?.targetHandle,
      style: route?.style ?? AGGREGATE_EDGE_STYLE,
      markerEnd: 'arrowclosed',
      markerStart: agg.aToB && agg.bToA ? 'arrowclosed' : undefined,
      data: { type: 'aggregate', stoich: agg.count, via: route?.via },
    };
  });

  // Attach each collapsed container's assigned knobs (if any) to its own
  // node -- a fresh object, never mutating the node App.jsx handed in. Also
  // declares them via the node's own `handles` property (not just
  // data.ports, which only drives what ContainerNode actually renders) --
  // the same escape hatch computeIsolateView's proxy nodes already rely on
  // (see its own block comment on initialWidth/handles): a freshly-added
  // named handle otherwise has no bounds until its own Handle element
  // mounts *and* is measured, which under onlyRenderVisibleElements can be
  // delayed indefinitely (or race a container's own remeasure effect) --
  // verified directly, without this a large collapsed model logged a wave
  // of "Couldn't create edge for ... handle id" warnings on every
  // render pass, not just a one-time settling blip. Declaring the exact
  // geometry up front sidesteps the race entirely; real measurement still
  // silently corrects it moments later same as for a proxy.
  const nodesWithPorts = visibleNodes.map((n) => {
    if (!collapsedIds.has(n.id)) return n;
    const ports = portsByContainer.get(n.id) ?? [];
    const w = n.style?.width ?? 0;
    const h = n.style?.height ?? 0;
    const handles = [
      { type: 'target', position: 'left', x: 0, y: h / 2 },
      { type: 'source', position: 'right', x: w, y: h / 2 },
      ...ports.map((p) => ({ id: p.id, type: p.type, position: p.side, x: p.x, y: p.y })),
    ];
    // The dynamic pavement value doubles as every connector knob's own
    // diameter (see nodes.jsx's PortKnob/fallback-handle styling) -- a
    // model-wide constant would either look gigantic on a tightly-packed
    // model or vanishingly small on a sparse one, so this carries the same
    // number that governs routing clearance straight through to the visual
    // size, keeping the two proportionate to each other.
    return { ...n, data: { ...n.data, ports, knobSize: pavement }, handles };
  });

  return { nodes: nodesWithPorts, edges: [...individual, ...aggregatedEdges] };
}

// -- Aggregated-edge port assignment (design section: connector knobs) ----
//
// A plain single fixed Left/Right handle pair (ContainerNode's own default,
// still used for the "one side is a real entity" case below) put every
// aggregate connector at the exact same two anchor points regardless of
// which direction the other group actually sat in -- BendableEdge's spline
// then had to bend however necessary to reach it, reading as "a confusing
// mix of x/y lines and arbitrary angles" for anything not directly left/
// right of its partner. This instead picks, per aggregated group-to-group
// edge, whichever of the container's four sides faces the other group most
// directly (the shortest-routing side), gives it its own knob on that side
// (spread out along the side when more than one connector lands there so
// they don't all leave from the same point -- the multiple-lines-on-top-of-
// each-other complaint), and always renders the connector as a strict
// 2-bend orthogonal polyline between the two chosen knobs.

function pickSide(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

const OPPOSITE_SIDE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

// Node-local (0..width, 0..height) coordinates for a port -- the form
// React Flow's own declared-`handles` node property expects (see
// computeIsolateView's PROXY_LAYOUT above), as opposed to portPoint's
// absolute flow-space point used for the actual route geometry. Sits
// exactly ON the box's own edge -- the knob drawn there (see nodes.jsx's
// PortKnob) is what visually "stands off" from the border now, via its own
// diameter (data.knobSize), rather than the line's actual attachment point
// being offset outward past it.
function localPortXY(box, side, frac) {
  switch (side) {
    case 'right':
      return { x: box.width, y: frac * box.height };
    case 'top':
      return { x: frac * box.width, y: 0 };
    case 'bottom':
      return { x: frac * box.width, y: box.height };
    default:
      return { x: 0, y: frac * box.height };
  }
}

function portPoint(box, side, frac) {
  switch (side) {
    case 'right':
      return { x: box.x + box.width, y: box.y + frac * box.height };
    case 'top':
      return { x: box.x + frac * box.width, y: box.y };
    case 'bottom':
      return { x: box.x + frac * box.width, y: box.y + box.height };
    default:
      return { x: box.x, y: box.y + frac * box.height };
  }
}

// The perpendicular-axis coordinate of `otherPoint`, used only to order
// several knobs sharing one side so they read left-to-right/top-to-bottom
// in the same order their real partners sit in, rather than an arbitrary
// insertion order that would make the connectors cross each other right at
// the box edge.
function perpCoord(side, otherPoint) {
  return side === 'left' || side === 'right' ? otherPoint.y : otherPoint.x;
}

// A strict 2-bend, axis-aligned polyline between two ports whose sides are
// always exact opposites by construction (pickSide is evaluated from each
// container's own center toward the other's, so a and b's choices are
// always mirror images) -- always returns two points (even when the ports
// already share the coordinate that would make one bend a no-op), so the
// caller can treat every aggregate connector as multi-bend/polyline
// uniformly rather than special-casing the already-straight case.
function orthogonalPortRoute(aPoint, aSide, bPoint) {
  if (aSide === 'left' || aSide === 'right') {
    const midX = (aPoint.x + bPoint.x) / 2;
    return [
      { x: midX, y: aPoint.y },
      { x: midX, y: bPoint.y },
    ];
  }
  const midY = (aPoint.y + bPoint.y) / 2;
  return [
    { x: aPoint.x, y: midY },
    { x: bPoint.x, y: midY },
  ];
}

// The color rule: "the group to the left, or if in the same column, the
// upper group" -- read directly off whichever container's center sorts
// first on the axis that actually distinguishes the pair.
function leftOrUpperColor(aCenter, aColor, bCenter, bColor) {
  if (aCenter.x !== bCenter.x) return aCenter.x < bCenter.x ? aColor : bColor;
  return aCenter.y <= bCenter.y ? aColor : bColor;
}

function containerColor(id, byId) {
  return resolveGroupColor(byId[id]?.data?.color, id) ?? '#555';
}

function assignAggregatePorts(aggPairs, byId, allObstacles, pavement) {
  const portsByContainer = new Map();
  const routeByPair = new Map();
  if (aggPairs.length === 0) return { portsByContainer, routeByPair };

  const boxes = new Map();
  aggPairs.forEach((agg) => {
    if (!boxes.has(agg.a)) boxes.set(agg.a, absoluteBox(agg.a, byId));
    if (!boxes.has(agg.b)) boxes.set(agg.b, absoluteBox(agg.b, byId));
  });

  // One attachment record per pair-end (two per pair: a's end and b's end).
  const attachments = [];
  aggPairs.forEach((agg) => {
    const boxA = boxes.get(agg.a);
    const boxB = boxes.get(agg.b);
    if (!boxA || !boxB) return;
    const centerA = { x: boxA.cx, y: boxA.cy };
    const centerB = { x: boxB.cx, y: boxB.cy };
    const sideA = pickSide(centerB.x - centerA.x, centerB.y - centerA.y);
    const sideB = OPPOSITE_SIDE[sideA];
    attachments.push({ pairKey: `${agg.a}|${agg.b}`, containerId: agg.a, side: sideA, otherCenter: centerB, role: 'a' });
    attachments.push({ pairKey: `${agg.a}|${agg.b}`, containerId: agg.b, side: sideB, otherCenter: centerA, role: 'b' });
  });

  // Group by (container, side), order to match the real geometry, then
  // spread evenly along that side.
  const bySideKey = new Map();
  attachments.forEach((att) => {
    const key = `${att.containerId}|${att.side}`;
    if (!bySideKey.has(key)) bySideKey.set(key, []);
    bySideKey.get(key).push(att);
  });

  const portByAttachment = new Map();
  bySideKey.forEach((group, key) => {
    const [containerId, side] = key.split('|');
    group.sort((x, y) => perpCoord(side, x.otherCenter) - perpCoord(side, y.otherCenter));
    group.forEach((att, i) => {
      const frac = (i + 1) / (group.length + 1);
      const portId = `port-${containerId}-${side}-${i}`;
      portByAttachment.set(att, { id: portId, side, frac });
      if (!portsByContainer.has(containerId)) portsByContainer.set(containerId, []);
    });
  });

  attachments.forEach((att) => {
    const port = portByAttachment.get(att);
    const box = boxes.get(att.containerId);
    const local = localPortXY(box, port.side, port.frac);
    portsByContainer.get(att.containerId).push({
      id: port.id,
      side: port.side,
      frac: port.frac,
      type: att.role === 'a' ? 'source' : 'target',
      x: local.x,
      y: local.y,
    });
  });

  aggPairs.forEach((agg) => {
    const pairKey = `${agg.a}|${agg.b}`;
    const attA = attachments.find((att) => att.pairKey === pairKey && att.role === 'a');
    const attB = attachments.find((att) => att.pairKey === pairKey && att.role === 'b');
    if (!attA || !attB) return;
    const portA = portByAttachment.get(attA);
    const portB = portByAttachment.get(attB);
    const boxA = boxes.get(agg.a);
    const boxB = boxes.get(agg.b);
    const pointA = portPoint(boxA, portA.side, portA.frac);
    const pointB = portPoint(boxB, portB.side, portB.frac);
    const color = leftOrUpperColor(
      { x: boxA.cx, y: boxA.cy },
      containerColor(agg.a, byId),
      { x: boxB.cx, y: boxB.cy },
      containerColor(agg.b, byId)
    );
    // A third group sitting geometrically between this pair would
    // otherwise get sliced right through by the plain 2-bend Z-route below
    // (that route only ever considers the two endpoints) -- checked here
    // against the straight A-to-B line the same way avoidObstacles checks
    // any other edge, and only when something's actually in the way does
    // the more roundabout clearing detour replace the simple shelf route.
    // Excludes not just A and B themselves but any of *their* ancestors
    // too -- an uncollapsed outer compartment containing both (almost
    // always true: the root compartment typically stays expanded while
    // its child groups collapse) would otherwise "block" via its own
    // giant bounding box, since the direct A-to-B line trivially lies
    // entirely inside it. Mirrors avoidObstacles' own exclusion below.
    // Inflated by the pavement value before the crossing test -- a route
    // that merely grazes within that same distance a knob keeps clear of
    // its *own* box should keep that same clearance from any *other* box
    // it passes near, not just ones it would otherwise cut straight
    // through.
    const candidates = (allObstacles ?? [])
      .filter((o) => o.id !== agg.a && o.id !== agg.b && !isAncestorOf(o.id, agg.a, byId) && !isAncestorOf(o.id, agg.b, byId))
      .map((o) => ({ ...o, box: inflateBox(o.box, pavement) }));
    const via =
      unionDetour(pointA.x, pointA.y, pointB.x, pointB.y, candidates, pavement * 2) ?? orthogonalPortRoute(pointA, portA.side, pointB);
    routeByPair.set(pairKey, {
      sourceHandle: portA.id,
      targetHandle: portB.id,
      via,
      style: { stroke: color, strokeWidth: 4 },
    });
  });

  const laneGap = pavement * 2;
  deconflictLanes(routeByPair, 'x', laneGap);
  deconflictLanes(routeByPair, 'y', laneGap);

  return { portsByContainer, routeByPair };
}

// Two different connectors can each independently land on the exact same
// (or a barely-different) "shelf"/"lane" coordinate -- their own 2-bend
// routes never consider each other, only their own two endpoints -- and
// then visibly run right on top of each other for however long their
// lanes overlap. Clusters routes sharing an axis (`axisKey`: 'x' for a
// vertical lane, i.e. via[0].x === via[1].x; 'y' for a horizontal shelf)
// whose lane coordinate is within `laneGap` *and* whose span on the other
// axis actually overlaps (not just any two routes that happen to share a
// coordinate -- two lanes far apart on the other axis were never going to
// visually collide), then re-spreads each cluster's members out from their
// own shared average, evenly separated by `laneGap` (the same dynamic
// pavement-derived value everything else here uses, not a fixed pixel
// count -- see computePavement). Mutates the route objects' own via points
// in place -- they're freshly built by this same function, never shared
// with anything else yet.
function deconflictLanes(routeByPair, axisKey, laneGap) {
  const otherKey = axisKey === 'x' ? 'y' : 'x';
  const items = [...routeByPair.values()]
    .filter((r) => Array.isArray(r.via) && r.via.length === 2 && r.via[0][axisKey] === r.via[1][axisKey])
    .map((r) => ({
      r,
      coord: r.via[0][axisKey],
      lo: Math.min(r.via[0][otherKey], r.via[1][otherKey]),
      hi: Math.max(r.via[0][otherKey], r.via[1][otherKey]),
    }));
  items.sort((a, b) => a.coord - b.coord);

  const clusters = [];
  let current = [];
  items.forEach((item) => {
    if (current.length > 0) {
      const last = current[current.length - 1];
      const near = Math.abs(item.coord - last.coord) < laneGap;
      const overlaps = item.lo <= last.hi && last.lo <= item.hi;
      if (!near || !overlaps) {
        clusters.push(current);
        current = [];
      }
    }
    current.push(item);
  });
  if (current.length > 0) clusters.push(current);

  clusters.forEach((cluster) => {
    if (cluster.length < 2) return;
    const base = cluster.reduce((sum, it) => sum + it.coord, 0) / cluster.length;
    cluster.forEach((it, i) => {
      const newCoord = base + (i - (cluster.length - 1) / 2) * laneGap;
      it.r.via[0][axisKey] = newCoord;
      it.r.via[1][axisKey] = newCoord;
    });
  });
}

// -- Isolate mode (design section 6) -----------------------------------
//
// A second, more drastic view on top of the same collapsed flags: instead
// of a collapsed group rendering as an icon, isolate mode drops every
// collapsed group entirely -- "there is a toggle to display only the
// expanded group(s); all others become invisible" -- and, per 6.1,
// replaces each connection that crossed into now-invisible territory with
// a small per-entity proxy node standing in for whichever specific hidden
// entity is on the far end, positioned just outside whichever expanded
// group the *visible* side lives in. No separate group-selection UI is
// needed for "the expanded group(s)" -- it's exactly the same per-group
// collapsed flag every other view already reads.
//
// A connection entirely within invisible territory (both ends hidden)
// still shows nothing at all, matching "no lines connect to them"; one
// entirely within visible territory (6.2) renders exactly as it always
// does, untouched by any of this.
//
// A proxy renders as the *real* node type it stands in for -- same
// component, same data, same on-screen size (see nodes.jsx's ProxyNode)
// -- rather than a generic placeholder, so it reads as "the actual thing,
// just relocated" instead of a vague stub. That in turn means it exposes
// the exact same named Handles the real component does (SubstrateHandle/
// ProductHandle and friends), so a redirected edge keeps its *original*
// sourceHandle/targetHandle id rather than needing it stripped the way
// the collapsed-group-icon case above does (that icon's Handles really
// are generic/unnamed).

// Per-real-type size and Handle geometry for a *freshly created* proxy --
// used only until React Flow's own measurement of the real rendered
// component (whichever one nodes.jsx's ProxyNode dispatches to) takes
// over and silently corrects both, moments later. Close enough to each
// type's actual nodes.jsx geometry to avoid a visible jump when that
// happens, but doesn't need to be exact: seeding a value at all (even an
// approximate one) is what actually matters -- see the initialWidth/
// initialHeight/handles block comment below for why.
const PROXY_LAYOUT = {
  pool: {
    // A Pool's real width is text-driven (see nodes.jsx's baseStyle --
    // padding plus a 28px font, no fixed box) -- estimated from the name
    // length here purely as a plausible starting guess; nothing pins the
    // rendered box to this value, so a real Pool's own natural auto-sizing
    // still applies once mounted (verified directly: declaring `handles`
    // up front means handleBounds is defined from the very first render,
    // which is what actually determines whether an explicit width gets
    // forced onto the node -- see @xyflow/react's own
    // getNodeInlineStyleDimensions).
    size: (name) => ({ width: Math.max(56, 24 + name.length * 15), height: 36 }),
    handles: (w, h) => [
      { type: 'target', position: 'left', x: 0, y: h / 2 },
      { type: 'source', position: 'right', x: w, y: h / 2 },
    ],
  },
  reac: {
    size: () => ({ width: 90, height: 90 }),
    handles: (w, h) => [
      { id: 'substrate', type: 'target', position: 'left', x: 0, y: h / 2 },
      { id: 'product', type: 'source', position: 'right', x: w, y: h / 2 },
    ],
  },
  enz: {
    // Matches nodes.jsx's EnzNode own text-driven width estimate -- an
    // enzyme's name is rendered at the same rough size/weight as a Pool's.
    size: (name) => ({ width: Math.max(110, 24 + name.length * 15), height: 80 }),
    handles: (w, h) => [
      { id: 'substrate', type: 'target', position: 'left', x: 0, y: h / 2 },
      { id: 'product', type: 'source', position: 'right', x: w, y: h / 2 },
      { id: 'enzSite', type: 'target', position: 'bottom', x: w * 0.3, y: h },
    ],
  },
  concchan: {
    size: () => ({ width: 128, height: 60 }),
    handles: (w, h) => [
      { id: 'chanParent', type: 'target', position: 'bottom', x: w / 2, y: h },
      { id: 'chanIn', type: 'target', position: 'left', x: 0, y: h / 2 },
      { id: 'chanOut', type: 'source', position: 'right', x: w, y: h / 2 },
    ],
  },
  stim: {
    size: () => ({ width: 46, height: 56 }),
    handles: (w, h) => [{ id: 'stimTip', type: 'source', position: 'bottom', x: w * 0.38, y: h }],
  },
  // A summation Function renders as a circle, same shape/size class as
  // a Reac (nodes.jsx's FuncNode shares ReacNode's exact baseStyle/48px-
  // font circle) -- NOT stim's own lightning-bolt box, even though it
  // shares stim's bottom stimTip handle (centered, matching FuncNode's
  // own `left: '50%'` CSS, unlike stim's own off-center 0.38). Missing
  // this entry fell back to DEFAULT_PROXY_SIZE (90x36 -- a genuinely
  // flat rectangle) with generic left/right handles that don't match
  // FuncNode's real left-target/bottom-stimTip handles at all -- this is
  // what read as "a large flat rectangle with no Sigma inside" once a
  // func node's own group got collapsed under isolate mode.
  func: {
    size: () => ({ width: 90, height: 90 }),
    handles: (w, h) => [
      { type: 'target', position: 'left', x: 0, y: h / 2 },
      { id: 'stimTip', type: 'source', position: 'bottom', x: w / 2, y: h },
    ],
  },
};
const DEFAULT_PROXY_SIZE = { width: 90, height: 36 };

// How far a proxy sits beyond its anchor group's own bounding circle
// (half-diagonal), and the minimum on-screen gap kept between two
// proxies' *centers* around that same group's perimeter, so several
// external connections landing at similar angles fan out along the arc
// instead of piling on top of each other (a fixed radial stacking step
// doesn't work here: two same-angle boxes only stop overlapping once
// they're spaced by roughly their own width, not a small fixed offset).
const PROXY_BASE_MARGIN = 50;
const PROXY_MIN_GAP_PX = 24;

// Resolves `nodeId`'s absolute flow-pixel position by summing `position`
// up its parentId chain -- node.position is only ever relative to its
// immediate parent (see App.jsx's buildFlowNodes), the same reason
// App.jsx's own absoluteFlowPosition exists; reimplemented locally here
// since this module has no access to that (App-local) helper and the
// computation itself is only a few lines.
function absolutePosition(nodeId, byId) {
  let x = 0;
  let y = 0;
  let cur = byId[nodeId];
  while (cur) {
    x += cur.position.x;
    y += cur.position.y;
    cur = cur.parentId ? byId[cur.parentId] : null;
  }
  return { x, y };
}

// A container's absolute on-screen box -- its own node.style is always
// {width, height} in flow-pixels (see App.jsx's buildFlowNodes, which
// keeps a collapsed container's box the same size as its expanded one),
// so only the position needs the same parentId-chain resolution as above.
function absoluteBox(containerId, byId) {
  const node = byId[containerId];
  if (!node) return null;
  const pos = absolutePosition(containerId, byId);
  const { width, height } = node.style ?? { width: 0, height: 0 };
  return { ...pos, width, height, cx: pos.x + width / 2, cy: pos.y + height / 2 };
}

// A short, deterministic angle from a proxy's own id -- used only for the
// degenerate case where the real entity it's standing in for sits exactly
// at its anchor group's center (direction otherwise undefined), so it
// still lands *somewhere* distinct rather than always due east.
function hashAngle(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return (((hash % 360) + 360) % 360) * (Math.PI / 180);
}

export function computeIsolateView(nodes, edges, collapsedIds) {
  const byId = {};
  nodes.forEach((n) => {
    byId[n.id] = n;
  });

  const isHidden = (id) => collapsedIds.has(id) || outermostCollapsedAncestor(id, byId, collapsedIds) !== null;

  const visibleNodes = nodes.filter((n) => !isHidden(n.id));

  // One proxy per (hidden entity, anchor group) pair -- several edges from
  // the same hidden entity into the same group converge on the one proxy
  // ("per-entity", not per-edge); the same entity connecting into two
  // *different* visible groups gets a separate proxy near each, since a
  // single shared position wouldn't sit "on the outside" of either one.
  const proxiesByKey = new Map();
  const resultEdges = [];

  edges.forEach((e) => {
    const sourceHidden = isHidden(e.source);
    const targetHidden = isHidden(e.target);
    if (sourceHidden && targetHidden) return;
    if (!sourceHidden && !targetHidden) {
      resultEdges.push(e);
      return;
    }

    const hiddenId = sourceHidden ? e.source : e.target;
    const visibleId = sourceHidden ? e.target : e.source;
    const visibleNode = byId[visibleId];
    // Every real entity lives inside at least the root compartment, so
    // parentId should always be set here; the fallback just keeps a proxy
    // from silently vanishing in case some future node type doesn't.
    const anchorGroupId = visibleNode?.parentId ?? visibleId;
    const key = `${hiddenId}|${anchorGroupId}`;
    let proxy = proxiesByKey.get(key);
    if (!proxy) {
      const hiddenNode = byId[hiddenId];
      proxy = {
        id: `proxy-${key}`,
        anchorGroupId,
        anchorVisibleId: visibleId,
        hiddenData: hiddenNode?.data ?? {},
        realId: hiddenId,
        realType: hiddenNode?.data?.type,
      };
      proxiesByKey.set(key, proxy);
    }
    // The redirected side keeps its *original* handle id -- the proxy
    // renders the real component (see nodes.jsx's ProxyNode), which
    // exposes the exact same named Handles that component always does,
    // so there's no mismatch to strip the way there is for the generic
    // collapsed-group icon (computeCollapsedView, above).
    resultEdges.push({ ...e, source: sourceHidden ? proxy.id : e.source, target: targetHidden ? proxy.id : e.target });
  });

  // Position every proxy anchored to a given group together, in one pass,
  // so overlap-avoidance can see the *whole* set around that group rather
  // than deciding one at a time.
  const byGroup = new Map();
  proxiesByKey.forEach((p) => {
    (byGroup.get(p.anchorGroupId) ?? byGroup.set(p.anchorGroupId, []).get(p.anchorGroupId)).push(p);
  });

  const proxyNodes = [];
  byGroup.forEach((proxiesForGroup, anchorGroupId) => {
    const box = absoluteBox(anchorGroupId, byId);
    const cx = box ? box.cx : 0;
    const cy = box ? box.cy : 0;
    const halfDiagonal = box ? Math.hypot(box.width / 2, box.height / 2) : 0;
    const radius = halfDiagonal + PROXY_BASE_MARGIN;

    const withAngle = proxiesForGroup.map((p) => {
      const layout = PROXY_LAYOUT[p.realType];
      const size = layout ? layout.size(p.hiddenData.name ?? '') : DEFAULT_PROXY_SIZE;
      const anchorPos = absolutePosition(p.anchorVisibleId, byId);
      const dx = anchorPos.x - cx;
      const dy = anchorPos.y - cy;
      const desiredAngle = dx === 0 && dy === 0 ? hashAngle(p.id) : Math.atan2(dy, dx);
      return { p, size, desiredAngle };
    });

    // Minimum angular separation so two proxies sharing this group's
    // perimeter never overlap: converts "keep centers at least (own
    // width + neighbor's) / 2 + a small gap apart" into an angle at the
    // shared radius (arc length ~= radius * angle), using the wider of
    // any two neighbors so asymmetric sizes (e.g. a Pool next to an Enz)
    // still clear each other.
    const maxWidth = Math.max(...withAngle.map((w) => w.size.width), DEFAULT_PROXY_SIZE.width);
    const minGapAngle = radius > 0 ? (maxWidth + PROXY_MIN_GAP_PX) / radius : (2 * Math.PI) / Math.max(withAngle.length, 1);

    // Sorting by each proxy's own *desired* angle keeps the fan-out
    // reading left-to-right/around in the same order their real
    // counterparts would suggest, rather than an arbitrary insertion
    // order; a forward-only sweep then nudges each one just far enough
    // past the previous to guarantee separation (wrapping means the
    // *last* one may still end up closer than minGapAngle to the first
    // if there isn't room for everyone on one ring -- acceptable for the
    // handful of external connections a real model has per group, and
    // still strictly better than the fixed-radius stacking this replaced,
    // which overlapped even in the two-proxy case).
    withAngle.sort((a, b) => a.desiredAngle - b.desiredAngle);
    let placedAngle = withAngle.length > 0 ? withAngle[0].desiredAngle : 0;
    withAngle.forEach((entry, i) => {
      if (i === 0) {
        entry.angle = placedAngle;
        return;
      }
      placedAngle = Math.max(placedAngle + minGapAngle, entry.desiredAngle);
      entry.angle = placedAngle;
    });

    withAngle.forEach(({ p, size, angle }) => {
      const px = cx + Math.cos(angle) * radius;
      const py = cy + Math.sin(angle) * radius;
      const layout = PROXY_LAYOUT[p.realType];
      const handles = layout
        ? layout.handles(size.width, size.height)
        : [
            { type: 'target', position: 'left', x: 0, y: size.height / 2 },
            { type: 'source', position: 'right', x: size.width, y: size.height / 2 },
          ];
      proxyNodes.push({
        id: p.id,
        type: 'proxy',
        position: { x: px - size.width / 2, y: py - size.height / 2 },
        // React Flow only ever considers a node "has dimensions" (and so
        // paints it, rather than leaving it visibility:hidden) once it's
        // been measured via its own ResizeObserver *or* initialWidth/
        // initialHeight is set up front (verified directly against
        // nodeHasDimensions/getNodeDimensions in @xyflow/system). A
        // brand-new proxy popping in fresh every time isolate mode (or a
        // fresh collapse) recomputes the view otherwise sat invisible
        // indefinitely under onlyRenderVisibleElements: its first-ever
        // position can easily land outside the current viewport, and a
        // not-yet-measured node there is excluded from the rendered set
        // entirely (falls back to a zero-size point, see MainDisplay's
        // own FitViewOnLoad comment) -- so it never mounts long enough for
        // the observer to fire and never gets a second chance.
        //
        // That turns out not to be the whole story, though: an edge won't
        // render to/from a node at all until React Flow considers that
        // node "initialized" (see @xyflow/system's isNodeInitialized),
        // which separately requires *handle* bounds -- either measured
        // (the normal path, via each Handle's own registration once
        // mounted) or declared up front here, the same kind of escape
        // hatch. Verified directly this was the actual remaining cause of
        // a proxy's edge never appearing at all (not just rendering
        // invisibly), even once the icon itself showed up fine and was
        // fully clickable: normal handle measurement plainly never
        // completed for a node this fresh, at least not within any bound
        // worth waiting on.
        initialWidth: size.width,
        initialHeight: size.height,
        handles,
        draggable: false,
        data: { ...p.hiddenData, type: 'proxy', realId: p.realId, realType: p.realType },
      });
    });
  });

  return { nodes: [...visibleNodes, ...proxyNodes], edges: resultEdges };
}

// -- Obstacle-avoiding default bend point ---------------------------------
//
// A straight line between two entities in different, unrelated groups can
// end up slicing right through some *third* group's box along the way --
// purely an accident of where things happen to sit on the canvas, nothing
// about the connection itself. BendableEdge already supports a manual
// bend point (data.via, user-draggable) for exactly this; this computes a
// *default* one automatically, only for an edge that doesn't already have
// one (a user-dragged point, or an aggregate edge's own -- see App.jsx's
// aggregateVia -- always wins), so the common case already reads
// sensibly without the user needing to find and drag every offending edge
// by hand. A cheap sampled-points check, not exact line/rectangle
// geometry -- good enough to catch "this line visibly cuts through that
// box", which is what actually matters for a default worth having, not a
// mathematically pure collision test.
function isAncestorOf(candidateId, nodeId, byId) {
  let cur = byId[nodeId];
  while (cur && cur.parentId) {
    if (cur.parentId === candidateId) return true;
    cur = byId[cur.parentId];
  }
  return false;
}

function lineCrossesBox(x1, y1, x2, y2, box, steps = 40) {
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return true;
  }
  return false;
}

// Every obstacle from `candidates` the direct line from (x1,y1) to (x2,y2)
// actually cuts through, folded into one union box and cleared with a
// single 2-bend orthogonalDetour -- shared between avoidObstacles (real
// edges) and assignAggregatePorts (group-to-group connectors) so "does
// this route need to dodge a third box" and "how" are answered identically
// in both places. Returns null when nothing blocks, so callers can fall
// back to whatever simpler route they'd otherwise use.
function unionDetour(x1, y1, x2, y2, candidates, margin) {
  const blocking = candidates.filter((o) => lineCrossesBox(x1, y1, x2, y2, o.box));
  if (blocking.length === 0) return null;
  const unionBox = blocking.reduce(
    (acc, o) => ({
      x: Math.min(acc.x, o.box.x),
      y: Math.min(acc.y, o.box.y),
      x2: Math.max(acc.x2, o.box.x + o.box.width),
      y2: Math.max(acc.y2, o.box.y + o.box.height),
    }),
    { x: Infinity, y: Infinity, x2: -Infinity, y2: -Infinity }
  );
  return orthogonalDetour(
    x1,
    y1,
    x2,
    y2,
    {
      x: unionBox.x,
      y: unionBox.y,
      width: unionBox.x2 - unionBox.x,
      height: unionBox.y2 - unionBox.y,
    },
    margin
  );
}

// Where an edge's endpoint actually attaches, in absolute flow-space --
// `pos` is that node's own absolute top-left (from absolutePosition). A
// plain entity's real Handle sits near its own center regardless of which
// specific one is in play (adequate for a routing decision, not meant to
// match BendableEdge's own precise per-handle anchor) -- but a collapsed
// group/compartment redirected onto its generic fallback pair (see
// computeCollapsedView's "individual" edges, the only case a container
// ever appears as a real edge endpoint here) attaches at its own LEFT edge
// as a target or RIGHT edge as a source, never its center (ContainerNode's
// own default Handles, Position.Left/Position.Right). Using the box center
// there instead -- the old, entity-shaped formula applied uniformly --
// put the computed route's own start/end point visibly off from where the
// line actually renders, reading as "oddly angular, doesn't terminate on
// the knob" until the first manual drag (which uses React Flow's own
// accurate sourceX/sourceY) silently snapped it back into place.
function anchorPoint(node, pos, role) {
  const w = node.style?.width ?? node.initialWidth ?? 0;
  const h = node.style?.height ?? node.initialHeight ?? 0;
  if (isGroupOrCompartment(node)) {
    return { x: pos.x + (role === 'source' ? w : 0), y: pos.y + h / 2 };
  }
  return { x: pos.x + w / 2, y: pos.y + h / 2 };
}

export function avoidObstacles(nodes, edges) {
  const byId = {};
  nodes.forEach((n) => {
    byId[n.id] = n;
  });
  const obstacles = nodes
    .filter((n) => n.data?.type === 'group' || n.data?.type === 'compartment')
    .map((n) => ({ id: n.id, box: absoluteBox(n.id, byId) }))
    .filter((o) => o.box);
  if (obstacles.length === 0) return edges;
  // Same dynamic pavement as assignAggregatePorts (see computePavement) --
  // computed independently here since this runs as a separate pass over a
  // possibly-different node set, only from whichever of these obstacles
  // are actually collapsed (an expanded box's "gap" to its neighbors isn't
  // a meaningful spacing measurement -- see computePavement's own comment).
  const pavement = computePavement(obstacles.filter((o) => byId[o.id]?.data?.collapsed));

  return edges.map((e) => {
    // A user-dragged point (or an aggregate edge's own, merged in by
    // App.jsx before this ever runs) always wins -- this only ever fills
    // in a default, never overrides a deliberate choice.
    if (e.data?.via) return e;
    const sourceNode = byId[e.source];
    const targetNode = byId[e.target];
    if (!sourceNode || !targetNode) return e;

    const sourcePos = absolutePosition(e.source, byId);
    const targetPos = absolutePosition(e.target, byId);
    const { x: sx, y: sy } = anchorPoint(sourceNode, sourcePos, 'source');
    const { x: tx, y: ty } = anchorPoint(targetNode, targetPos, 'target');

    // Every obstacle the direct line actually cuts through, not just the
    // first one found -- a line spanning several sibling groups in a row
    // can cross more than one of them, and detouring around only the first
    // (the old `.find()`) left it still slicing through whichever others
    // happened to sit further along the same line. unionDetour folds them
    // into a single union box so the result stays one clean 2-bend
    // polyline that clears all of them at once. Inflated by the pavement
    // value so a route that merely runs close alongside a group's border
    // -- not actually through it -- still gets routed clear, the same
    // margin a connector's own knob keeps from its box.
    const candidates = obstacles
      .filter((o) => o.id !== e.source && o.id !== e.target && !isAncestorOf(o.id, e.source, byId) && !isAncestorOf(o.id, e.target, byId))
      .map((o) => ({ ...o, box: inflateBox(o.box, pavement) }));
    const via = unionDetour(sx, sy, tx, ty, candidates, pavement * 2);
    if (!via) return e;

    return { ...e, data: { ...e.data, via } };
  });
}

// A two-bend, three-straight-segment detour around `box`, staying purely
// horizontal/vertical throughout ("aligned to a rectangular grid", the
// circuit-board-trace look multi-bend routing is meant to read as, rather
// than a single smooth diagonal bow around the obstacle). Two candidate
// routes -- a horizontal "shelf" above or below the box, or a vertical
// one left or right of it -- and whichever needs the smaller detour
// distance from the direct line is used, so a pair of entities mostly
// stacked vertically (say) doesn't get routed the long way around just
// because one particular axis happened to be tried first.
function orthogonalDetour(sx, sy, tx, ty, box, margin = 30) {
  const clearAbove = box.y - margin;
  const clearBelow = box.y + box.height + margin;
  const midY = (sy + ty) / 2;
  const yDetour = Math.min(Math.abs(midY - clearAbove), Math.abs(midY - clearBelow));
  const clearY = Math.abs(midY - clearAbove) <= Math.abs(midY - clearBelow) ? clearAbove : clearBelow;

  const clearLeft = box.x - margin;
  const clearRight = box.x + box.width + margin;
  const midX = (sx + tx) / 2;
  const xDetour = Math.min(Math.abs(midX - clearLeft), Math.abs(midX - clearRight));
  const clearX = Math.abs(midX - clearLeft) <= Math.abs(midX - clearRight) ? clearLeft : clearRight;

  if (yDetour <= xDetour) {
    return [
      { x: sx, y: clearY },
      { x: tx, y: clearY },
    ];
  }
  return [
    { x: clearX, y: sy },
    { x: clearX, y: ty },
  ];
}

export { isGroupOrCompartment, outermostCollapsedAncestor };
