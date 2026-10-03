import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Snackbar, Alert } from '@mui/material';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import { buildStandaloneSvg } from './exportSvg';
import AppLayout from './AppLayout';
import { RAINBOW_16, resolveGroupColor } from './colorUtils';
import {
  computeCollapsedView,
  computeDetailedConnectView,
  computeIsolatedView,
  computeDecoratedView,
  avoidObstacles,
} from './collapseView';
import {
  AUTO_LAYOUT_CELL,
  computeGridCells,
  computeFlipUpdates,
  optimizeGroupLayout,
} from './layoutSeed';
import {
  computeFlowGroupLayout,
  computeUniformFlowLayout,
  DEFAULT_FLOW_WEIGHTS,
  SQUARE_FLOW_WEIGHTS,
  categoryOf,
  nearestGridCell,
  derivePitches,
} from './layoutGrid';
import { computeLayoutScore } from './layoutScore';
import {
  DEFAULT_TIME_UNIT,
  DEFAULT_CONC_UNIT,
  DEFAULT_VOLUME_UNIT,
  DEFAULT_LENGTH_UNIT,
} from './unitConversions';

const API_BASE = `http://${window.location.hostname}:5001`;

// px per kkit layout unit -- no single fixed value works across models,
// since different .g files use wildly different native coordinate spacing
// (verified directly: kholodenko.g's median nearest-neighbor spacing is 3.0
// layout units, feedback.g's is 1.41). Computed fresh per model instead (see
// computeAutoScale) so node spacing lands at a consistent, readable pixel
// distance regardless of a given file's own unit convention.
const TARGET_NEIGHBOR_SPACING_PX = 180;
const DEFAULT_SCALE = 50;
const MIN_SCALE = 15;
const MAX_SCALE = 200;
// Rendered pool node height in px (see nodes.jsx's baseStyle) -- used to
// auto-offset a newly-created enzyme two pool-heights above its parent.
const POOL_HEIGHT_PX = 28;

// Median (not minimum) nearest-neighbor distance across all node positions.
// Minimum would be thrown off by deliberately-tight pairs that are common in
// kkit layouts (our own create_enz places an enzyme only ~0.5-1 unit from
// its parent pool, and legacy .g files use similar tight diagonal offsets
// for enz/reac icons next to their substrate pool) -- those pairs shouldn't
// dictate the overall scale, but they would if we took the true minimum.
function computeAutoScale(graph) {
  // Groups/compartments aren't point-like molecules -- their spacing from
  // everything else would skew this heuristic, and their own size is
  // governed by their stored/auto-fit width & height instead (see
  // effectiveContainerBox), not by neighbor spacing.
  const points = graph.nodes
    .filter((n) => n.type !== 'group' && n.type !== 'compartment')
    .map((n) => ({ x: n.x, y: n.y }));
  if (points.length < 2) return DEFAULT_SCALE;

  // Grid-bucketed nearest-neighbor search rather than an all-pairs scan --
  // the latter is O(n^2), which turned into real, measurable seconds of
  // pure JS work on a several-hundred-pool model (and only gets worse from
  // there). Cell size is a rough guess from the point cloud's own bounding
  // box, sized for a handful of points per cell on average; checking only
  // a point's own cell and its 8 neighbors finds the true nearest neighbor
  // for any reasonably-spread layout -- this is a heuristic for picking a
  // *display scale*, not a value anything downstream depends on being
  // exact, so an unusual clustering giving a slightly-off candidate isn't
  // a correctness concern.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  points.forEach((p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });
  const cellSize = Math.max(Math.sqrt(((maxX - minX || 1) * (maxY - minY || 1)) / points.length), 1e-6);
  const cellOf = (p) => [Math.floor((p.x - minX) / cellSize), Math.floor((p.y - minY) / cellSize)];

  const grid = new Map();
  points.forEach((p) => {
    const [cx, cy] = cellOf(p);
    const key = `${cx},${cy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  });

  const nearestDistances = points
    .map((p) => {
      const [cx, cy] = cellOf(p);
      let min = Infinity;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${cx + dx},${cy + dy}`);
          if (!bucket) continue;
          bucket.forEach((q) => {
            if (q === p) return;
            const d = Math.hypot(p.x - q.x, p.y - q.y);
            if (d > 0 && d < min) min = d;
          });
        }
      }
      return min;
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (nearestDistances.length === 0) return DEFAULT_SCALE;

  const median = nearestDistances[Math.floor(nearestDistances.length / 2)];
  if (!median || median <= 0) return DEFAULT_SCALE;

  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, TARGET_NEIGHBOR_SPACING_PX / median));
}

// The 4 visualization modes (see the visualMode state below) in cycling
// order -- also, as this exact ordering, what the floating panel's own
// 4-way toggle button steps through.
const VISUAL_MODES = ['groupConnect', 'detailedConnect', 'isolated', 'decorated'];

const EDGE_STYLE = {
  substrate: { stroke: 'green', strokeWidth: 1.75 },
  product: { stroke: '#333', strokeWidth: 1.75 },
  enzyme: { stroke: 'orange', strokeDasharray: '4 2', strokeWidth: 1.75 },
  chanParent: { stroke: 'orange', strokeDasharray: '4 2', strokeWidth: 1.75 },
  chanIn: { stroke: 'green', strokeWidth: 1.75 },
  chanOut: { stroke: '#333', strokeWidth: 1.75 },
  stimTarget: { stroke: '#e63946', strokeDasharray: '2 2', strokeWidth: 1.75 },
  funcInput: { stroke: 'green', strokeWidth: 1.75 },
};

// Which named Handle (see nodes.jsx) each edge type terminates on, on the
// Reac/Enz side -- the Pool side always uses that node's single unnamed
// handle, so it needs no explicit id.
const HANDLE_BY_TYPE = {
  substrate: { targetHandle: 'substrate' },
  product: { sourceHandle: 'product' },
  enzyme: { targetHandle: 'enzSite' },
  chanParent: { targetHandle: 'chanParent' },
  chanIn: { targetHandle: 'chanIn' },
  chanOut: { sourceHandle: 'chanOut' },
  stimTarget: { sourceHandle: 'stimTip' },
};

// Which backend endpoint updates each editable node type -- field rendering
// itself lives in PropertiesMenuBox, not per-type here.
const EDITABLE_ENDPOINTS = {
  pool: '/api/update_pool',
  reac: '/api/update_reac',
  enz: '/api/update_enz',
  group: '/api/update_group',
  compartment: '/api/update_compartment',
  concchan: '/api/update_concchan',
  stim: '/api/update_stim',
  // A summation/general function is still just a Function underneath
  // (see moose_graph.py's own describe_stim three-way classification) --
  // same backend endpoint, type-agnostic on that side already.
  func: '/api/update_stim',
  genfunc: '/api/update_stim',
};

// The order-dependent fields describe_reac recomputes whenever a
// substrate/product edge changes a Reac's order (see rescale_reac_for_
// order_change on the backend) -- merged from add_edge/remove_edge's own
// "reacUpdate" response straight into the node's data, rather than a full
// graph refetch, so the Properties panel (if open on that reac) and its
// unit labels never go stale after a connect/disconnect elsewhere.
const REAC_ORDER_FIELDS = [
  'Kf', 'Kb', 'KfUnit', 'KbUnit',
  'numKf', 'numKb', 'numKfUnit', 'numKbUnit',
  'kd', 'kdLabel', 'kdUnit', 'tau', 'tauUnit',
];

function mergeReacUpdate(nodes, reacUpdate) {
  if (!reacUpdate) return nodes;
  const patch = {};
  REAC_ORDER_FIELDS.forEach((key) => {
    if (key in reacUpdate) patch[key] = reacUpdate[key];
  });
  return nodes.map((n) => (n.id === reacUpdate.id ? { ...n, data: { ...n.data, ...patch } } : n));
}

// A funcInput connect/disconnect (see add_edge/remove_edge's own comment)
// can change the target function's own numVars/expr -- patched in the
// same way mergeReacUpdate patches a reac's own order-dependent fields,
// rather than a full graph refetch for what's usually a single quick drag.
function mergeFuncUpdate(nodes, funcUpdate) {
  if (!funcUpdate) return nodes;
  const patch = { expr: funcUpdate.expr, numInputs: funcUpdate.numInputs, inputIds: funcUpdate.inputIds };
  return nodes.map((n) => (n.id === funcUpdate.id ? { ...n, data: { ...n.data, ...patch } } : n));
}

// Mirrors kkit's ADDMSGARROW pairing rules (xreac.g/xpool.g/xenz.g): which
// node-type pairs may be connected, and what the resulting edge means. Only
// the substrate/product handles are drag-connectable for now -- the enzyme
// site link is set structurally when an enzyme is created, not by dragging.
function edgeTypeForConnection(conn, nodeTypeById) {
  const sourceType = nodeTypeById[conn.source];
  const targetType = nodeTypeById[conn.target];
  if (
    sourceType === 'pool' &&
    conn.targetHandle === 'substrate' &&
    (targetType === 'reac' || targetType === 'enz')
  ) {
    return 'substrate';
  }
  if (
    conn.sourceHandle === 'product' &&
    (sourceType === 'reac' || sourceType === 'enz') &&
    targetType === 'pool'
  ) {
    return 'product';
  }
  if (sourceType === 'pool' && conn.targetHandle === 'chanIn' && targetType === 'concchan') {
    return 'chanIn';
  }
  if (conn.sourceHandle === 'chanOut' && sourceType === 'concchan' && targetType === 'pool') {
    return 'chanOut';
  }
  // A summation/general function's own input handle is unnamed (see
  // nodes.jsx's FuncNode/GenFuncNode -- one shared target handle, same
  // pattern PoolNode's own target/source handles already use), so unlike
  // substrate/chanIn there's no targetHandle id to check here.
  if (sourceType === 'pool' && (targetType === 'func' || targetType === 'genfunc')) {
    return 'funcInput';
  }
  return null;
}

function toEdge(from, to, type, i, stoich = 1) {
  return {
    id: `e${i}-${from}-${to}-${type}`,
    source: from,
    target: to,
    style: EDGE_STYLE[type],
    data: { type, stoich },
    ...HANDLE_BY_TYPE[type],
  };
}

// Auto-orient each reac/enz once, from its connected pools' positions: if
// its substrates sit to the right of its products on average, the default
// (substrate-left, product-right) layout would cross itself, so flip it.
// Only run at load/creation time -- re-running this on every edit would
// silently re-flip nodes the user has already arranged or manually toggled.
function computeInitialFlips(graph) {
  const poolX = {};
  const otherX = {};
  graph.nodes.forEach((n) => {
    if (n.type === 'pool') poolX[n.id] = n.x;
    else otherX[n.id] = n.x;
  });

  // For reac/enz nodes: X of the pools feeding in as substrate vs. the
  // pools receiving as product.
  const subXs = {};
  const prodXs = {};
  // For pool nodes (mirror image): X of the reac/enz nodes it's a
  // substrate for (attaches at its source/right handle by default) vs.
  // the ones it's a product of (attaches at its target/left handle).
  const poolSubXs = {};
  const poolProdXs = {};
  // chanIn/chanOut play exactly the same structural role for a ConcChan
  // that substrate/product play for a reac/enz (pool-into-object,
  // object-into-pool) -- folded into the same collection so a ConcChan's
  // own influx/efflux handles flip by the same rule as a reac/enz's
  // substrate/product ones.
  graph.edges.forEach((e) => {
    if (e.type === 'substrate' || e.type === 'chanIn') {
      if (poolX[e.from] !== undefined) {
        if (!subXs[e.to]) subXs[e.to] = [];
        subXs[e.to].push(poolX[e.from]);
      }
      if (otherX[e.to] !== undefined) {
        if (!poolSubXs[e.from]) poolSubXs[e.from] = [];
        poolSubXs[e.from].push(otherX[e.to]);
      }
    } else if (e.type === 'product' || e.type === 'chanOut') {
      if (poolX[e.to] !== undefined) {
        if (!prodXs[e.from]) prodXs[e.from] = [];
        prodXs[e.from].push(poolX[e.to]);
      }
      if (otherX[e.from] !== undefined) {
        if (!poolProdXs[e.to]) poolProdXs[e.to] = [];
        poolProdXs[e.to].push(otherX[e.from]);
      }
    }
  });

  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const flips = {};
  graph.nodes.forEach((n) => {
    if (n.type === 'reac' || n.type === 'enz' || n.type === 'concchan') {
      const subs = subXs[n.id];
      const prods = prodXs[n.id];
      flips[n.id] = !!subs && !!prods && avg(subs) > avg(prods);
    } else if (n.type === 'pool') {
      const asSub = poolSubXs[n.id];
      const asProd = poolProdXs[n.id];
      // A pool need not have both roles (e.g. a pure end-product has no
      // substrate role at all) -- when only one is present, compare it
      // against the pool's own position instead of requiring both.
      if (!asSub && !asProd) {
        flips[n.id] = false;
      } else {
        const relSub = asSub ? avg(asSub) - poolX[n.id] : 0;
        const relProd = asProd ? avg(asProd) - poolX[n.id] : 0;
        flips[n.id] = relSub - relProd < 0;
      }
    }
  });
  return flips;
}

// A regular enzyme's (or ConcChan's) connector to its real host molecule
// (see moose_graph.describe_enz/describe_concchan's own parentPoolId) is
// drawn as a single dot on either the top or bottom edge -- unlike flip's
// left/right axis, its own substrate/product (or chanIn/chanOut) arrows
// already occupy the left/right sides, so top/bottom is the only axis
// this link can use without colliding with them. Chosen once, the same
// way flip is (see computeInitialFlips just above): whichever side is
// actually closer to where the real parent pool sits, comparing Y only
// (Y-up, so a pool with a larger y than its enzyme/concchan sits above it
// on screen -- the connector belongs on that node's *top* edge to reach
// it directly instead of routing all the way around). Falls back to
// 'bottom' -- the original fixed convention -- when there's no
// parentPoolId, or it doesn't resolve to a node with a known position.
function computeInitialParentSides(graph) {
  const yById = {};
  graph.nodes.forEach((n) => {
    yById[n.id] = n.y;
  });
  const sides = {};
  graph.nodes.forEach((n) => {
    if (n.type !== 'enz' && n.type !== 'concchan') return;
    const parentY = n.parentPoolId ? yById[n.parentPoolId] : undefined;
    sides[n.id] = parentY !== undefined && parentY > n.y ? 'top' : 'bottom';
  });
  return sides;
}

const CONTAINER_TYPES = ['group', 'compartment'];
// React Flow reserves the literal node type "group" for its own built-in
// group-node feature and auto-applies a default CSS border/padding/width to
// any node so typed (verified directly in its stylesheet -- .react-flow__
// node-group gets border:1px solid), which showed up as an unwanted second
// border stacked on top of our own. Only the React-Flow-facing `type`
// field needs remapping to sidestep that; the semantic type used
// everywhere else (data.type, CONTAINER_TYPES, etc.) stays "group".
const REACT_FLOW_NODE_TYPE = { group: 'kkitGroup' };
const DEFAULT_CONTAINER_SIZE = {
  group: { width: 4, height: 3 },
  compartment: { width: 8, height: 6 },
};
const CONTAINER_PADDING = 1.5;
// Extra breathing room specifically when a container's auto-fit box has to
// wrap another container (rather than just plain pools/reacs) -- otherwise
// the inner box's own border sits right up against the outer one's. Also
// the minimum gap auto-layout's own grid keeps between two sibling
// containers placed as neighboring cells -- widened from the original 3.5
// (verified directly: that was tight enough, especially at a small
// scale factor, that two thick-bordered sibling boxes could read as
// touching/overlapping even though the grid math itself never actually
// let their footprints intersect).
const CONTAINER_NESTING_PADDING = 6;

// Extra gap between GRID CELLS specifically when a level's own repack is
// packing sibling *containers* (not molecules) -- unlike
// CONTAINER_NESTING_PADDING, which is baked into each individual
// container's own reported footprint (so its border doesn't visually
// touch its parent's), this is genuine open breathing room between two
// neighboring group boxes' cells, generous enough for the inter-group
// connector routing (see collapseView.js's own pavement system) to
// actually have room to work with, not just enough to keep two borders
// from touching.
const CONTAINER_GRID_GAP = 15;

// Cheap AABB test shared by computeLocalLayouts' own overlap safety net
// below -- `a`/`b` are the same {localX, localY, right, bottom} shape
// packedChildren/lockedEntityPlacements/lockedContainerBounds all use
// (Y-up: localY is the top edge, bottom the -- numerically lower -- one).
function boxesOverlap(a, b) {
  const ox = Math.min(a.right, b.right) - Math.max(a.localX, b.localX);
  const oy = Math.min(a.localY, b.localY) - Math.max(a.bottom, b.bottom);
  return ox > 0 && oy > 0;
}
function anyOverlap(boxes) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i], boxes[j])) return true;
    }
  }
  return false;
}

function isDescendantOf(nodeId, containerId, rawById) {
  let cur = rawById[nodeId];
  while (cur && cur.parentId) {
    if (cur.parentId === containerId) return true;
    cur = rawById[cur.parentId];
  }
  return false;
}

// A group/compartment cascades onto everything inside it when deleted
// (MOOSE's own moose.delete already recursively removes descendants, and
// there's no re-parenting in this version for orphans to escape into) --
// confirmed before the fact if it's not empty, since that can otherwise
// silently wipe out a whole reaction sub-system from one drag-to-trash.
function confirmContainerDelete(node, flowNodes) {
  // node.data.type (the semantic type), not node.type (the React-Flow
  // rendering type -- remapped for groups, see REACT_FLOW_NODE_TYPE).
  if (node.data.type !== 'group' && node.data.type !== 'compartment') return true;
  const rawById = {};
  flowNodes.forEach((n) => {
    rawById[n.id] = n.data;
  });
  const hasChildren = flowNodes.some((n) => isDescendantOf(n.id, node.id, rawById));
  if (!hasChildren) return true;
  return window.confirm(
    `Delete "${node.data.name}"? This also deletes everything inside it.`
  );
}

// Precomputed once per build (O(n), one pass over every node) rather than
// re-scanning the *entire* node list once per container inside
// effectiveContainerBox -- that was O(containers * n), a real quadratic-ish
// cost once a model has both many containers and many nodes. Each non-
// container node walks its own (short) parentId chain exactly once and
// registers itself under every ancestor container along the way -- the
// same set effectiveContainerBox's old per-container isDescendantOf scan
// would have found, just built from the other direction.
function buildContainerIndex(rawNodes, rawById) {
  const descendants = {};
  const directContainerChildren = {};
  rawNodes.forEach((n) => {
    if (CONTAINER_TYPES.includes(n.type)) {
      if (n.parentId && CONTAINER_TYPES.includes(rawById[n.parentId]?.type)) {
        (directContainerChildren[n.parentId] ??= []).push(n);
      }
      return;
    }
    // An enz complex pool is never rendered on the canvas (see
    // buildFlowNodes/App.jsx's canvasGraph) -- it shouldn't grow a
    // container's own auto-fit box to accommodate a position nobody ever
    // sees either.
    if (n.type === 'pool' && n.isEnzComplex) return;
    let cur = n.parentId ? rawById[n.parentId] : null;
    while (cur) {
      (descendants[cur.id] ??= []).push(n);
      cur = cur.parentId ? rawById[cur.parentId] : null;
    }
  });
  return { descendants, directContainerChildren };
}

// A container that's never been explicitly sized/positioned (width and
// height both 0 -- true for every legacy .g file's default compartment,
// which never stored these) gets its box auto-derived from whatever's
// currently inside it instead of rendering as, and clamping all its
// children into, a tiny empty box wherever its unset x/y happens to be.
//
// Direct child containers count by their own full box extent (position +
// size), not just their anchor point, so an auto-fit box is always large
// enough to actually contain a nested one rather than just its corner --
// and that case gets extra padding (CONTAINER_NESTING_PADDING), since a
// plain pool/reac doesn't have its own visible border to clear.
//
// `boxById` memoizes results across calls within one build (recursion, not
// insertion order, resolves the "inner box needed before outer box"
// dependency regardless of which order containers appear in graph.nodes).
// `cellPitch` is SX (the global grid pitch, see the "Integer grid
// rebuild" plan) -- used ONLY for the auto-fit (never-explicitly-sized)
// branch below, as a flat one-cell margin around whatever children
// already occupy. This replaces the old CONTAINER_PADDING/
// CONTAINER_NESTING_PADDING fractional-kkit-unit margins, which bounded
// only each child's own top-left ANCHOR point (see the loop below -- it
// still does, unchanged), relying on a margin generous enough to also
// cover each child's own real footprint past that anchor. A flat SX
// margin safely covers any NORMAL (one-cell) child's own full extent;
// it's the plan's own accepted, deliberately simple approximation for
// this auto-fit fallback path specifically -- a container a user has
// EXPLICITLY resized (the common case once a layout is actually being
// worked on) goes through onContainerResize's own exact, per-child
// integer min-size containment instead, which this auto-fit shortcut
// never overrides (its own `n.width > 0 || n.height > 0` branch above
// always wins once that's happened).
function effectiveContainerBox(n, index, boxById, cellPitch = AUTO_LAYOUT_CELL) {
  if (boxById[n.id]) return boxById[n.id];
  if (n.width > 0 || n.height > 0) {
    const box = { x: n.x, y: n.y, width: n.width, height: n.height };
    boxById[n.id] = box;
    return box;
  }

  const xs = [];
  const ys = [];
  const nestedContainers = index.directContainerChildren[n.id] ?? [];
  nestedContainers.forEach((other) => {
    const childBox = effectiveContainerBox(other, index, boxById, cellPitch);
    xs.push(childBox.x, childBox.x + childBox.width);
    ys.push(childBox.y, childBox.y - childBox.height);
  });
  (index.descendants[n.id] ?? []).forEach((other) => {
    xs.push(other.x);
    ys.push(other.y);
  });
  const touchesNestedContainer = nestedContainers.length > 0;

  if (xs.length === 0) {
    const fallback = DEFAULT_CONTAINER_SIZE[n.type];
    const box = { x: n.x, y: n.y, width: fallback.width, height: fallback.height };
    boxById[n.id] = box;
    return box;
  }
  const padding = touchesNestedContainer ? CONTAINER_NESTING_PADDING : cellPitch;
  const box = {
    x: Math.min(...xs) - padding,
    y: Math.max(...ys) + padding,
    width: Math.max(...xs) - Math.min(...xs) + padding * 2,
    height: Math.max(...ys) - Math.min(...ys) + padding * 2,
  };
  boxById[n.id] = box;
  return box;
}

// -- Recursive auto-layout -----------------------------------------------
//
// onAutoLayoutGroup (below, inside the component) lays out one container's
// own direct children in a grid and resizes it to fit -- these two
// functions generalize that to a whole subtree at once: every nested
// group is laid out first (so its own final size is known), then its
// parent's grid places it as a single cell alongside its siblings, and so
// on up to whichever container this was invoked on.
//
// A naive single bottom-up pass (place *and* size each level immediately,
// the single-level math wrapped in recursion) breaks the moment a
// container gets repositioned by its own parent's grid: an
// already-placed container's children keep whatever *absolute* position
// they were just given, so the whole subtree would detach from its own
// box the instant the box itself moved again one level up. Two passes
// instead: computeLocalLayouts (bottom-up) works out only each
// container's own *size* and a child layout relative to an arbitrary
// (0,0) reference, since its real, final origin isn't known yet at that
// point; assignAbsolutePositions (top-down) then walks back down from the
// root -- whose own position isn't touched here, only its contents move
// -- turning each container's relative child layout into real positions,
// using its own just-assigned real origin as it descends into its own
// children in turn.

// computeGridCells and computeFlipUpdates now live in layoutSeed.js
// (imported above) -- a pure refactor when they moved there, not a
// behavior change. optimizeGroupLayout (also imported, used by both
// onAutoLayoutGroup and computeLocalLayouts below) is what actually picks
// each unlocked child's grid cell now -- a seed (connectivity-aware
// relaxation, or a radial hub-first placement, whichever scores better)
// refined by simulated annealing against layoutScore.js's own connector-
// length/crossing/overlap/area score, replacing the plain
// connectivityAwareOrder single-strategy pack this used to call directly;
// see layoutSeed.js's own comments and the planning discussion this
// shipped from.

// Each direct child's own footprint for grid-packing purposes -- a
// nested container's real effective box (padded so its own border
// doesn't sit flush against a neighbor's), or a flat `cellUnit` square
// for a plain entity, which has no border/size concept of its own to
// measure -- except a Pool with a long name, which is given double that
// width. A Pool's real rendered box is text-driven (see nodes.jsx's
// PoolNode -- padding plus a 28px font, no fixed width), so a long name
// can render meaningfully wider than this flat square; packing it into
// the same narrow cell every other plain entity gets left it visually
// overlapping its neighbor once actually rendered, even though the
// packing itself never considered that an overlap (verified directly: a
// long-named pool in a flow-layout group visibly overlapped its row
// neighbor). A coarse, cheap stand-in for properly measuring the
// rendered text -- good enough to give a long name noticeably more
// breathing room without trying to be pixel-exact. An Enz's own box is a
// fixed size regardless of name (see nodes.jsx's EnzNode -- no name is
// drawn on the icon at all), so it doesn't need this treatment.
//
// `cellUnit` -- the per-model SX (see computeDefaultSx below), NOT the
// plain AUTO_LAYOUT_CELL constant directly: a fixed kkit-unit cell size
// stops corresponding to
// a consistent ON-SCREEN size once `scale` (computeAutoScale, picked
// fresh per model to fit that file's OWN native coordinate convention)
// drifts far from its usual range -- verified directly against a real
// file (Vinu_23Sep_with_gr.g) whose native units are roughly 200x
// Kholodenko.g's own, forcing scale down to its floor and leaving every
// auto-layout action's own cells far smaller on screen than an icon's
// own fixed CSS size, reading as everything "crammed." Used for BOTH
// onAutoLayoutGroup's own single-level packing and computeLocalLayouts'
// per-level sizing (a nested *container*'s size there comes from its own
// freshly-recomputed localLayouts entry instead, never this -- see
// computeLocalLayouts' own comment -- since this would only ever read
// the box as it stood *before* the whole operation started).
const LONG_POOL_NAME_THRESHOLD = 10;

// SX derivation (the "Integer grid rebuild" plan's own design, message
// 2): a percentage of the canvas pane's own measured width (not
// window.innerWidth -- the side menu panels eat real width), so icons
// fit comfortably on screen with a default ScaleIcons regardless of a
// file's own native coordinate scale. ~0.09 picked to match this app's
// previous fixed 150px-per-cell default (AUTO_LAYOUT_CELL * DEFAULT_SCALE)
// at a typical ~1650px-wide pane. `canvasWidthPx` is null only before the
// canvas has actually mounted and reported a size (see MainDisplay's own
// getCanvasWidth) -- CANVAS_WIDTH_FALLBACK_PX is a reasonable desktop
// pane width for that moment, same role AUTO_LAYOUT_CELL_PX_TARGET's old
// fixed 150px played.
const SX_SCREEN_FRACTION = 0.09;
const CANVAS_WIDTH_FALLBACK_PX = 1650;
function computeDefaultSx(scale, canvasWidthPx) {
  const widthPx = canvasWidthPx ?? CANVAS_WIDTH_FALLBACK_PX;
  return (SX_SCREEN_FRACTION * widthPx) / scale;
}
const DEFAULT_SX = computeDefaultSx(DEFAULT_SCALE, CANVAS_WIDTH_FALLBACK_PX);

// The user's own explicit correction: 1.0 read as "icons fill the entire
// space between grid points", much too crowded -- 0.4 is the actual
// intended starting point for a comfortable default fit.
const DEFAULT_SCALE_ICONS = 0.4;

// The SOLE, authoritative footprint source anywhere in this app (the
// "Integer grid rebuild" plan's own point 2: NO independent scale factor
// for any object or group) -- a plain entity's own footprint is always
// EXACTLY one grid cell (`SX` wide, `SX/2` tall), two cells wide for a
// long-named pool (`isLongName`, a binary name-length classification,
// never a DOM measurement). A container's own footprint is its current
// effective box (see effectiveContainerBox -- either explicitly
// resized, already an exact SX-multiple by construction, or auto-fit
// from its own content using the same `cellPitch` margin) plus the
// fixed, non-SX `CONTAINER_NESTING_PADDING` visual gap so its own
// border doesn't sit flush against whatever nests it.
function childFootprint(c, containerIndex, boxById, cellPitch = AUTO_LAYOUT_CELL) {
  if (!CONTAINER_TYPES.includes(c.type)) {
    const isLongName = c.type === 'pool' && (c.name?.length ?? 0) > LONG_POOL_NAME_THRESHOLD;
    return { width: isLongName ? cellPitch * 2 : cellPitch, height: cellPitch / 2 };
  }
  const box = effectiveContainerBox(c, containerIndex, boxById, cellPitch);
  return { width: box.width + CONTAINER_NESTING_PADDING, height: box.height + CONTAINER_NESTING_PADDING };
}

// `localLayouts[id] = { children: [{id, localX, localY}], width, height }`
// for every container in the subtree rooted at `rootId`, mutated in
// place (a plain accumulator, not a return value, since every recursive
// call needs to both read siblings' already-computed sizes and add its
// own). A container with no direct children at all keeps its own current
// effective box size rather than collapsing to nothing -- there's no
// "contents" for a layout to be tight *around* in that case.
//
// A container's own final width/height here is always exactly what its
// freshly-packed grid needs, not clamped to never shrink below whatever
// it happened to measure before -- an earlier version kept the larger of
// the two specifically to stop auto-layout from resizing a
// deliberately-sized container out from under itself, but that same rule
// also permanently locked in *any* oversized box (its own past auto-fit
// included) as a floor no later run could ever tighten back up, which is
// exactly backwards from what asking for a fresh layout is for -- it
// read as walls of dead space inside (and between, one level up) every
// container the moment one of them had ever been bigger than strictly
// necessary. The container's own *position* is what actually needed to
// stay put (see assignAbsolutePositions/onAutoLayoutGroup, both
// unaffected by this), not its size.
// A bare setTimeout(0) hands control back to the browser's own event loop
// for one tick -- long enough for a pending React state update (a fresh
// %complete) to actually paint -- before the recursive layout computation
// picks back up with the next container.
function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// `onProgress`, if given, is awaited once per container this recurses
// into or through -- exactly once per invocation of this function, root
// included, which is exactly how the caller's own pre-computed
// containerCount is defined (see onAutoLayoutRecursive). Awaiting it
// (rather than firing it synchronously) is what actually lets the browser
// repaint an updated percentage between containers -- without that yield,
// this whole recursive computation still runs as one uninterrupted
// synchronous block regardless of how "async" the function signature
// looks, and the tab would stay just as frozen as before.
async function computeLocalLayouts(rootId, rawNodes, rawById, containerIndex, boxById, localLayouts, edges, perLevelBudgetMs, cellUnit = AUTO_LAYOUT_CELL, onProgress) {
  const directChildren = rawNodes.filter(
    (n) => n.parentId === rootId && !(n.type === 'pool' && n.isEnzComplex)
  );
  // A locked container (see data.locked) is a true "do not touch" island
  // -- its own subtree uses *absolute*, not parent-relative, coordinates
  // on the backend (see effectiveContainerBox's own reliance on that), so
  // moving the container without also moving every descendant by the same
  // delta would silently detach them from it. Simplest and safest is to
  // never recurse into (or reposition) one at all -- its own current
  // footprint still counts toward this level's bounding-box accounting
  // below, just never gets a fresh internal layout or a new position.
  for (const child of directChildren) {
    if (CONTAINER_TYPES.includes(child.type) && !child.locked) {
      await computeLocalLayouts(child.id, rawNodes, rawById, containerIndex, boxById, localLayouts, edges, perLevelBudgetMs, cellUnit, onProgress);
    }
  }
  if (directChildren.length === 0) {
    const currentBox = effectiveContainerBox(rawById[rootId], containerIndex, boxById, cellUnit);
    localLayouts[rootId] = { children: [], width: currentBox.width, height: currentBox.height };
    if (onProgress) await onProgress();
    return;
  }

  const currentBox = effectiveContainerBox(rawById[rootId], containerIndex, boxById, cellUnit);
  const lockedContainers = directChildren.filter((c) => CONTAINER_TYPES.includes(c.type) && c.locked);
  // Everything else actually gets a position -- an unlocked entity/
  // container, freshly packed below, or a locked *plain entity* (no
  // cascading-descendant concern, unlike a locked container), which keeps
  // its current offset from this container's own new origin so it travels
  // along with whatever group it's actually in without being repacked
  // into a fresh grid slot.
  const repositionable = directChildren.filter((c) => !(CONTAINER_TYPES.includes(c.type) && c.locked));
  const unlockedPackable = repositionable.filter((c) => !c.locked);
  const lockedEntities = repositionable.filter((c) => c.locked);

  // A nested (unlocked) container's size here is its own *freshly
  // computed* localLayouts entry (just populated by the recursive call
  // above), not childFootprint's effectiveContainerBox -- that would read
  // the box as it stood *before* this whole operation started, silently
  // ignoring however much this same layout just grew or shrank it by
  // (verified directly: this mismatch was letting nested containers
  // overlap in the grow case, and was part of why sizes never tightened
  // up in the shrink case). Anything else -- a plain entity, or a locked
  // one -- just reads its own current, real footprint (childFootprint
  // already falls back to a flat AUTO_LAYOUT_CELL square for a
  // non-container, so this is correct for both cases without needing to
  // special-case them separately).
  const sizesMap = new Map(
    repositionable.map((c) => {
      if (CONTAINER_TYPES.includes(c.type) && !c.locked) {
        const own = localLayouts[c.id];
        return [c.id, { width: own.width + CONTAINER_NESTING_PADDING, height: own.height + CONTAINER_NESTING_PADDING }];
      }
      return [c.id, childFootprint(c, containerIndex, boxById, cellUnit)];
    })
  );
  const unlockedSizes = unlockedPackable.map((c) => sizesMap.get(c.id));
  const { colWidth: baseColWidth, rowHeight: baseRowHeight, cols } = computeGridCells(
    unlockedSizes.length > 0 ? unlockedSizes : [{ width: cellUnit, height: cellUnit }]
  );
  // Molecule-level packing keeps its own already-tuned cell size exactly
  // as-is; only a level whose repositionable children are themselves
  // containers gets the extra CONTAINER_GRID_GAP breathing room (see its
  // own comment) -- both the SA search below and the actual grid-pack
  // placement use this same widened spacing, so a candidate's score
  // always reflects the spacing it'll actually be placed with.
  const packingContainers = unlockedPackable.some((c) => CONTAINER_TYPES.includes(c.type));
  const colWidth = baseColWidth + (packingContainers ? CONTAINER_GRID_GAP : 0);
  const rowHeight = baseRowHeight + (packingContainers ? CONTAINER_GRID_GAP : 0);

  // Seed + simulated-annealing refinement (see optimizeGroupLayout's own
  // comment) instead of plain insertion order -- children actually
  // connected to each other land in nearby grid cells instead of
  // wherever the backend happened to list them.
  const optimized = optimizeGroupLayout({ children: repositionable, edges, rawById, sizes: sizesMap, cols, colWidth, rowHeight, timeBudgetMs: perLevelBudgetMs });

  const lockedEntityPlacements = lockedEntities.map((c) => {
    const footprint = childFootprint(c, containerIndex, boxById, cellUnit);
    const localX = c.x - currentBox.x;
    const localY = c.y - currentBox.y;
    return { id: c.id, localX, localY, right: localX + footprint.width, bottom: localY - footprint.height };
  });

  const lockedContainerBounds = lockedContainers.map((c) => {
    const box = effectiveContainerBox(c, containerIndex, boxById, cellUnit);
    const localX = c.x - currentBox.x;
    const localY = c.y - currentBox.y;
    return { localX, localY, right: localX + box.width, bottom: localY - box.height };
  });

  // A locked entity's own real position is folded into this level's
  // bounding-box/collision accounting above (lockedEntityPlacements), but
  // that never stopped the sequential grid pack below from landing an
  // unlocked child's cell right on top of it -- optimizeGroupLayout's own
  // `order` has no concept of grid cells at all, just a good ordering.
  // Reserve each locked entity's own nearest cell first (same
  // nearest-cell math as computeUniformFlowLayout's own locked-group
  // reservation, just local to this container instead of pixel-absolute),
  // then skip any reserved index while sequentially assigning the
  // unlocked order below.
  const lockedCellKeys = new Set(
    lockedEntities.map((c) => {
      const footprint = sizesMap.get(c.id);
      const centerX = c.x - currentBox.x + footprint.width / 2;
      const centerY = c.y - currentBox.y - footprint.height / 2;
      const row = Math.max(0, Math.round(-centerY / rowHeight));
      const col = Math.max(0, Math.round(centerX / colWidth));
      return `${row},${col}`;
    })
  );
  let nextIdx = 0;
  function nextFreeIdx() {
    while (lockedCellKeys.has(`${Math.floor(nextIdx / cols)},${nextIdx % cols}`)) nextIdx += 1;
    return nextIdx;
  }
  // CONTAINER_PADDING is baked into each child's own localX/localY here
  // (matching onAutoLayoutGroup's single-level originX/originY) -- so
  // assignAbsolutePositions below only ever has to add a container's own
  // real origin to these, never a second padding offset on top.
  // Unlike the pitch-based grids elsewhere (cellPitch is center-to-center
  // spacing, not a box size), colWidth/rowHeight here genuinely ARE each
  // slot's own box size (computeGridCells sizes them to the largest
  // child) -- so centering a smaller child within its own slot means
  // splitting the leftover (colWidth - footprint.width)/(rowHeight -
  // footprint.height) evenly on both sides, not just subtracting half the
  // child's own footprint the way the pitch-based grids do.
  const gridPacking = optimized.order.map((child) => {
    const i = nextFreeIdx();
    nextIdx += 1;
    const footprint = sizesMap.get(child.id);
    return {
      id: child.id,
      localX: CONTAINER_PADDING + (i % cols) * colWidth + (colWidth - footprint.width) / 2,
      localY: -CONTAINER_PADDING - Math.floor(i / cols) * rowHeight - (rowHeight - footprint.height) / 2,
      right: CONTAINER_PADDING + (i % cols) * colWidth + colWidth,
      bottom: -CONTAINER_PADDING - Math.floor(i / cols) * rowHeight - rowHeight,
    };
  });

  // A per-level "discarded" result (see optimizeGroupLayout) means "the
  // current arrangement already scores at least as well as anything a
  // fresh repack found" -- so it keeps every unlocked child at its own
  // current relative position instead of force-repacking it into the
  // grid, the same way a locked entity already does (see
  // lockedEntityPlacements above). But "current position" can still
  // collide: a *nested* container's own reported size can grow between
  // when this level's neighboring positions were last set and now (its
  // own internal layout just ran, above) -- verified directly against
  // synSynth7.g, where several sibling groups' molecule-level layouts
  // grew enough to overlap their neighbors even though every position
  // involved was, individually, exactly where it already was. Discarding
  // an *ordering* must never mean silently accepting a *collision*, so
  // this is only ever used when it's actually still collision-free --
  // otherwise the always-safe (if less minimal) grid pack above is used
  // instead, regardless of what the score comparison said.
  const currentPositionPacking = unlockedPackable.map((c) => {
    const footprint = sizesMap.get(c.id);
    const localX = c.x - currentBox.x;
    const localY = c.y - currentBox.y;
    return { id: c.id, localX, localY, right: localX + footprint.width, bottom: localY - footprint.height };
  });
  const keepCurrentPositions =
    optimized.discarded && !anyOverlap([...currentPositionPacking, ...lockedEntityPlacements, ...lockedContainerBounds]);
  const packedChildren = keepCurrentPositions ? currentPositionPacking : gridPacking;

  // `children` only ever holds entries assignAbsolutePositions should
  // actually move (a locked container is deliberately excluded, see
  // above) -- the bounding-box math just below additionally folds in
  // every locked container's own current footprint, so this level's final
  // size still actually contains it even though it's never repositioned.
  const children = [...packedChildren, ...lockedEntityPlacements];
  const allBounds = [...packedChildren, ...lockedEntityPlacements, ...lockedContainerBounds];
  // When every child here truly kept its current position, this
  // container's true current size (not a freshly recomputed bounding
  // box) is what actually belongs here. Recomputing it anyway can drift
  // from the real footprint (this app's own CONTAINER_PADDING convention
  // doesn't necessarily match whatever margin the container actually
  // has), and that drift silently compounds upward: the *parent* level's
  // own baseline-vs-candidate score compares against this container's
  // reported size, so an inflated-but-unmoved child here still reads as
  // "this got bigger" one level up -- verified directly against
  // Repressillator.g, where every one of its 3 nested gene groups
  // discarded correctly (score unchanged) yet the enclosing compartment's
  // own baseline had already drifted up 22% purely from this, well past
  // what its own 10% gate should ever have let through unnoticed.
  localLayouts[rootId] = keepCurrentPositions
    ? { children, width: currentBox.width, height: currentBox.height }
    : {
        children,
        width: Math.max(...allBounds.map((b) => b.right)) - Math.min(...allBounds.map((b) => b.localX)) + CONTAINER_PADDING * 2,
        height: Math.max(...allBounds.map((b) => b.localY)) - Math.min(...allBounds.map((b) => b.bottom)) + CONTAINER_PADDING * 2,
      };
  if (onProgress) await onProgress();
}

// Recurse Flow's own sibling to computeLocalLayouts above -- same bottom-
// up recursion (nested containers get their own fresh layout first, this
// level's own direct children are packed once that's done), same locked-
// container/locked-entity bookkeeping, but a different packing algorithm
// per level, and no per-level time budget (computeFlowGroupLayout/
// computeUniformFlowLayout are already bounded by their own MAX_CYCLES/
// MAX_INNER_STEPS_SAFETY_CAP, not an SA search that needs one):
//
// - Every NESTED level (isRoot false) is packed with the plain Flow
//   engine (computeFlowGroupLayout, DEFAULT_FLOW_WEIGHTS) -- alternating
//   pool/non-pool rows, exactly like the single-level "Flow" button --
//   the user's own step 1 ("first apply Flow to each of the inner
//   groups").
// - The outermost level (isRoot true, the group this action was actually
//   invoked on) is packed with computeUniformFlowLayout instead -- its
//   own direct children are, by this point, ALL groups (the caller
//   refuses the whole operation up front otherwise, see
//   onAutoLayoutRecursiveFlow's own comment), so there is no pool/non-
//   pool split to alternate between; a group is neither. The user's own
//   step 3.
//
// Unlike optimizeGroupLayout, both packers already run their own
// discard-if-worse gate internally (falling back to the current on-
// screen relative positions when nothing improves) -- so there's no
// separate "keepCurrentPositions"/collision-safety-net branch here the
// way computeLocalLayouts needs one for optimizeGroupLayout's own
// "discarded" flag; the returned `positions` already reflect whichever
// of "freshly packed" or "unchanged" actually won.
//
// `flipsOut` accumulates every level's own VERIFIED flips (each
// computeFlowGroupLayout call already found these, checking the real
// layout score -- see layoutScore.js's refineFlips) into one flat map
// the caller applies once at the end, instead of re-deriving them
// afterward with the cruder plain heuristic the Square-recursive action
// still uses (see its own onAutoLayoutRecursive).
// See computeLocalLayouts' own comment on `onProgress` -- same contract,
// awaited once per container.
async function computeLocalFlowLayouts(rootId, rawNodes, rawById, containerIndex, boxById, localLayouts, flipsOut, edges, cellUnit = AUTO_LAYOUT_CELL, isRoot = true, onProgress) {
  const directChildren = rawNodes.filter(
    (n) => n.parentId === rootId && !(n.type === 'pool' && n.isEnzComplex)
  );
  for (const child of directChildren) {
    if (CONTAINER_TYPES.includes(child.type) && !child.locked) {
      await computeLocalFlowLayouts(child.id, rawNodes, rawById, containerIndex, boxById, localLayouts, flipsOut, edges, cellUnit, false, onProgress);
    }
  }
  if (directChildren.length === 0) {
    const currentBox = effectiveContainerBox(rawById[rootId], containerIndex, boxById, cellUnit);
    localLayouts[rootId] = { children: [], width: currentBox.width, height: currentBox.height };
    if (onProgress) await onProgress();
    return;
  }

  const currentBox = effectiveContainerBox(rawById[rootId], containerIndex, boxById, cellUnit);
  const lockedContainers = directChildren.filter((c) => CONTAINER_TYPES.includes(c.type) && c.locked);
  const repositionable = directChildren.filter((c) => !(CONTAINER_TYPES.includes(c.type) && c.locked));
  const unlockedPackable = repositionable.filter((c) => !c.locked);
  const lockedEntities = repositionable.filter((c) => c.locked);

  // Same sizing convention as computeLocalLayouts -- see its own comment.
  const sizesMap = new Map(
    repositionable.map((c) => {
      if (CONTAINER_TYPES.includes(c.type) && !c.locked) {
        const own = localLayouts[c.id];
        return [c.id, { width: own.width + CONTAINER_NESTING_PADDING, height: own.height + CONTAINER_NESTING_PADDING }];
      }
      return [c.id, childFootprint(c, containerIndex, boxById, cellUnit)];
    })
  );

  // Origin is simply the group's own current stored absolute position,
  // used directly -- no rounding step (nothing left to round, see the
  // "Integer grid rebuild" plan: every write path guarantees this is
  // already an exact SX-multiple from ITS OWN parent).
  const origin = { x: currentBox.x, y: currentBox.y };
  const { positions, flips } = isRoot
    ? computeUniformFlowLayout({ children: repositionable, edges, rawById, sizes: sizesMap, origin })
    : computeFlowGroupLayout({ children: repositionable, edges, rawById, sizes: sizesMap, weights: DEFAULT_FLOW_WEIGHTS, cellUnit, origin });
  if (flips) Object.assign(flipsOut, flips);

  // `positions` is already each child's own plain top-left (`gridToPixels`
  // relative to `origin`) -- no centring/footprint subtraction (see the
  // "Integer grid rebuild" plan), so this is a direct copy, not a
  // computation.
  const packedChildren = unlockedPackable.map((c) => {
    const p = positions.get(c.id);
    const footprint = sizesMap.get(c.id);
    const localX = p.x;
    const localY = p.y;
    return { id: c.id, localX, localY, right: localX + footprint.width, bottom: localY - footprint.height };
  });

  const lockedEntityPlacements = lockedEntities.map((c) => {
    const footprint = childFootprint(c, containerIndex, boxById, cellUnit);
    const localX = c.x - currentBox.x;
    const localY = c.y - currentBox.y;
    return { id: c.id, localX, localY, right: localX + footprint.width, bottom: localY - footprint.height };
  });

  const lockedContainerBounds = lockedContainers.map((c) => {
    const box = effectiveContainerBox(c, containerIndex, boxById, cellUnit);
    const localX = c.x - currentBox.x;
    const localY = c.y - currentBox.y;
    return { localX, localY, right: localX + box.width, bottom: localY - box.height };
  });

  const children = [...packedChildren, ...lockedEntityPlacements];
  const allBounds = [...packedChildren, ...lockedEntityPlacements, ...lockedContainerBounds];
  // Zero padding in the grid math itself (the "Integer grid rebuild"
  // plan's own point 9 -- a container's own span is exactly whatever its
  // content needs, no extra cells; any visual gap is a fixed CSS margin
  // on the container's own rendering). Rounded UP to a whole SX/(SX/2)
  // multiple so this container's own footprint -- what its PARENT's own
  // packing uses -- is itself always exactly grid-aligned.
  const rawWidth = Math.max(...allBounds.map((b) => b.right)) - Math.min(...allBounds.map((b) => b.localX));
  const rawHeight = Math.max(...allBounds.map((b) => b.localY)) - Math.min(...allBounds.map((b) => b.bottom));
  localLayouts[rootId] = {
    children,
    width: Math.ceil(rawWidth / cellUnit) * cellUnit,
    height: Math.ceil(rawHeight / (cellUnit / 2)) * (cellUnit / 2),
  };
  if (onProgress) await onProgress();
}

// Turns each container's own locally-relative child placements into real
// ones, given `originX`/`originY` -- that container's own real, final
// top-left corner -- and recurses into every nested container using its
// own freshly-assigned origin in turn. Appends to `positionUpdates` (every
// repositioned node, container or not) and `resizeUpdates` (containers
// only, which need width/height alongside their new x/y).
function assignAbsolutePositions(containerId, originX, originY, rawById, localLayouts, positionUpdates, resizeUpdates) {
  localLayouts[containerId].children.forEach(({ id, localX, localY }) => {
    const x = originX + localX;
    const y = originY + localY;
    positionUpdates.push({ id, x, y });
    if (CONTAINER_TYPES.includes(rawById[id].type)) {
      const childLayout = localLayouts[id];
      resizeUpdates.push({ id, x, y, width: childLayout.width, height: childLayout.height });
      assignAbsolutePositions(id, x, y, rawById, localLayouts, positionUpdates, resizeUpdates);
    }
  });
}

// Shared by the initial/full load path and refreshGraph -- `preserve` lets
// the latter carry forward frontend-only state (flipped/color/plotWindow)
// that has no backend representation, keyed by node id; the former just
// passes empty maps so everything gets freshly computed defaults.
function buildFlowNodes(graph, scale, cellUnit, preserve = {}) {
  const flips = computeInitialFlips(graph);
  const parentSides = computeInitialParentSides(graph);
  const rawById = {};
  graph.nodes.forEach((n) => {
    rawById[n.id] = n;
  });

  // Every group/compartment's effective box is computed once up front --
  // both for its own rendering and as the reference point every child
  // (including a nested group) measures its relative position against.
  const boxById = {};
  const containerIndex = buildContainerIndex(graph.nodes, rawById);
  graph.nodes.forEach((n) => {
    if (CONTAINER_TYPES.includes(n.type)) {
      effectiveContainerBox(n, containerIndex, boxById, cellUnit);
    }
  });

  // Starts past however many pools already have a preserved color, so a
  // newly-added pool never reuses a color already assigned to an existing
  // one (matches the original refreshGraph behavior this replaced).
  let poolIndex = Object.keys(preserve.color ?? {}).length;
  // Pool colors are needed by an enzyme (below) before every pool's own
  // node has necessarily been visited yet in the main pass -- a pool can
  // come after its own enzyme in graph.nodes -- so they're resolved in
  // their own pass first, in the same encounter order the main pass would
  // otherwise use, keeping poolIndex's own assignment identical to before.
  const poolColorById = {};
  graph.nodes.forEach((n) => {
    if (n.type === 'pool') poolColorById[n.id] = preserve.color?.[n.id] ?? RAINBOW_16[poolIndex++ % 16];
  });
  const nodes = graph.nodes.map((n) => {
    const isContainer = CONTAINER_TYPES.includes(n.type);
    // A Pool's own color is always auto-assigned from RAINBOW_16 (real,
    // valid CSS), and a container resolves its own raw value itself (see
    // ContainerNode/resolveGroupColor). An enzyme instead adopts its own
    // parent pool's color verbatim (the user's own request -- an enzyme
    // reads as visually "belonging to" the molecule it's attached to
    // rather than carrying an independent color of its own), falling back
    // to its own raw color (still resolved, see below) only if its parent
    // isn't a real pool for some reason. Every OTHER entity type
    // (reac/concchan/stim/func) used to pass `n.color` straight through
    // unvalidated -- a legacy .g file's own raw color is often a bare
    // GENESIS-palette index ("27", not real CSS -- see resolveGroupColor's
    // own comment), which silently fails as a CSS `background` value: the
    // shape renders with no fill at all while the entity's own name text
    // still shows on top of it, which is exactly what read as "an enzyme
    // with no icon, just its name" on some models. resolveGroupColor
    // already solves this generically (verbatim for real CSS, a derived
    // hue for a numeric index, null only for a genuinely absent/'white'
    // value) -- reused here rather than duplicating that logic for
    // entities.
    const color =
      n.type === 'pool'
        ? poolColorById[n.id]
        : isContainer
          ? n.color
          : n.type === 'enz' && poolColorById[n.parentPoolId]
            ? poolColorById[n.parentPoolId]
            : resolveGroupColor(n.color, n.id) ?? n.color;

    const parentBox = n.parentId ? boxById[n.parentId] : null;
    const ownX = isContainer ? boxById[n.id].x : n.x;
    const ownY = isContainer ? boxById[n.id].y : n.y;
    const relX = parentBox ? ownX - parentBox.x : ownX;
    const relY = parentBox ? ownY - parentBox.y : ownY;

    const node = {
      id: n.id,
      type: REACT_FLOW_NODE_TYPE[n.type] ?? n.type,
      position: { x: relX * scale, y: -relY * scale },
      data: { ...n, color },
    };
    if (n.type === 'pool' || n.type === 'reac' || n.type === 'enz' || n.type === 'concchan' || n.type === 'func' || n.type === 'genfunc') {
      node.data.flipped = preserve.flipped?.[n.id] ?? flips[n.id] ?? false;
    }
    if (n.type === 'enz' || n.type === 'concchan') {
      node.data.parentSide = preserve.parentSide?.[n.id] ?? parentSides[n.id] ?? 'bottom';
    }
    if (n.type === 'pool') {
      // Preserved session state wins (a user's own toggle shouldn't be
      // undone by a refresh); otherwise fall back to what the backend
      // detected from the file's own pre-existing plot definitions (see
      // moose_graph.detect_existing_plots), not unconditionally null.
      node.data.plotWindow = preserve.plotWindow?.[n.id] ?? n.plotWindow ?? null;
    }
    if (isContainer) {
      // Same reasoning as plotWindow just above -- the live model has
      // nowhere to actually store this (see moose_graph.describe_group's
      // own docstring), so a plain refetch (not a save/reload) would
      // otherwise silently return collapsed:false for everything every
      // time. Falls back to whatever the backend *did* manage to read
      // back from a saved SBML file's own custom annotation (see
      // server.py's _extract_collapsed) on first load.
      node.data.collapsed = preserve.collapsed?.[n.id] ?? n.collapsed ?? false;
      // Frontend-only, same reasoning as collapsed just above -- which
      // auto-layout mode ('square' | 'flow') this container was last
      // packed with, set by onAutoLayoutGroup/onAutoLayoutGroupByFlow (and
      // their Recurse variants) so a later manual drag's own snap-to-grid
      // (see onNodeDragStop) knows whether this container's grid uses
      // Flow's x-offset stagger or Square's plain array. Absent (null)
      // for a container never auto-laid-out this session -- treated as
      // Flow's own staggered convention by the reader, not defaulted here.
      node.data.layoutMode = preserve.layoutMode?.[n.id] ?? n.layoutMode ?? null;
    }
    // Frontend-only, same reasoning as flipped/collapsed just above --
    // set whenever the user manually drags, resizes, or flips something
    // (see onNodeDragStop/onContainerResize/onToggleFlip), so the
    // auto-layout actions know to leave it exactly where/however it is.
    // Applies to any node type (a plain entity or a container), so it's
    // not gated behind isContainer/type the way flipped/collapsed are.
    node.data.locked = preserve.locked?.[n.id] ?? false;
    if (n.parentId) {
      node.parentId = n.parentId;
      node.extent = 'parent';
    }
    if (isContainer) {
      // A collapsed container keeps its own real, stored/auto-fit box --
      // only its *contents* hide (see computeCollapsedView), not its own
      // on-screen footprint -- so reorganizing a big model by collapsing
      // groups first doesn't also require re-guessing each one's size once
      // it's expanded again. expandedStyle is still stashed on data (not
      // just used inline) since onContainerResize needs somewhere to keep
      // it in sync with a later manual resize, without needing to redo the
      // box/scale computation above just to read the current size back.
      node.data.expandedStyle = { width: boxById[n.id].width * scale, height: boxById[n.id].height * scale };
      node.style = node.data.expandedStyle;
      node.zIndex = n.type === 'compartment' ? -2 : -1;
    }
    return node;
  });

  // An explicit-complex enzyme's hidden "cplx" pool (see
  // moose_graph.py's is_enz_complex) is never shown as a node of its own
  // on the canvas (see App.jsx's canvasGraph) -- it has no meaningful
  // position of its own to lay out or drag, it's simply the enzyme's own
  // bound state. It's never wired via any edge either (structural only,
  // a plain MOOSE parent-child link, not a message) -- the only way to
  // associate it back to its enzyme is the naming itself: its own id is
  // always exactly the enzyme's id plus one more path segment (verified
  // directly against moose_graph.py's is_enz_complex/create_enz). Stashed
  // onto the enzyme's own data (not removed from `nodes` -- Properties,
  // the Run/Plots pipeline, and SBML persistence all still need it to
  // exist as a real, addressable pool) so the enzyme can show its own
  // plot badge and accept a dropped plot icon on its own behalf.
  //
  // The trailing `[0]` strip matters: MOOSE's own .path property brackets
  // every *ancestor* segment with its index (.../enz1[0]/enz1_cplx) but
  // never the element's own trailing segment when that's queried as an id
  // in its own right (that same enzyme's own `n.id` is just .../enz1, no
  // bracket) -- verified directly, and without stripping it here the two
  // spellings of "the same enzyme" never string-matched, silently leaving
  // complexPoolId null for every enzyme.
  const complexPoolByEnzId = {};
  nodes.forEach((n) => {
    if (n.data.type === 'pool' && n.data.isEnzComplex) {
      const enzId = n.id.slice(0, n.id.lastIndexOf('/')).replace(/\[\d+\]$/, '');
      complexPoolByEnzId[enzId] = n;
    }
  });
  nodes.forEach((n) => {
    if (n.data.type === 'enz') {
      const cplx = complexPoolByEnzId[n.id];
      n.data.complexPoolId = cplx?.id ?? null;
      n.data.complexPlotWindow = cplx?.data.plotWindow ?? null;
    }
  });

  const edges = graph.edges.map((e, i) => toEdge(e.from, e.to, e.type, i, e.stoich));
  return { nodes, edges };
}

function toFlowGraph(graph, scale, cellUnit) {
  return buildFlowNodes(graph, scale, cellUnit);
}

// Which group/compartment (if any) a drop point at (kx, ky) -- in the same
// absolute kkit-unit space as every node's data.x/data.y -- falls inside,
// for deciding a newly-dropped pool/reac/group's structural parent. Uses
// each container's *effective* box (falling back to an auto-fit bounding
// box for one that's never been explicitly sized, same as rendering does)
// rather than raw stored width/height, since the raw values are 0 for the
// ever-present default compartment until a user actually resizes it -- a
// geometric test against that would never match despite it visually
// covering most of the canvas. Picks the smallest (most specific/innermost)
// match when boxes overlap.
function findContainerAt(kx, ky, flowNodes, cellUnit = AUTO_LAYOUT_CELL) {
  const rawNodes = flowNodes.map((n) => n.data);
  const rawById = {};
  rawNodes.forEach((n) => {
    rawById[n.id] = n;
  });
  const boxById = {};
  const containerIndex = buildContainerIndex(rawNodes, rawById);
  const candidates = rawNodes
    .filter((n) => CONTAINER_TYPES.includes(n.type))
    .map((n) => ({ id: n.id, box: effectiveContainerBox(n, containerIndex, boxById, cellUnit) }))
    .filter(({ box }) => kx >= box.x && kx <= box.x + box.width && ky <= box.y && ky >= box.y - box.height);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height);
  return candidates[0].id;
}

// The user's own drag-to-swap request: among `rawById`'s entries sharing
// `parentId` and `categoryOf`'s own pool/non-pool split with the dragged
// node (excluding itself), finds the one whose own (row, col) grid cell
// is EXACTLY the drop point's own (row, col) -- exact integer cell
// identity, not an overlapping box test. This is what fixes "dropped in
// blank space near a neighbour, swapped anyway" by construction: a
// neighbour's hit-box used to be based on a generous, type-blind nominal
// footprint that reached well past its own visible edges into what reads
// as blank space between grid points (verified directly: "drag to a
// blank space with something at the grid point to the right" swapped
// with it instead of landing in the blank cell) -- under the new model
// there is no footprint to compare against at all, only "landed on the
// SAME cell another sibling already occupies". Deliberately same-parent
// only (a different group's own same-category node at the same drop
// point is a coincidence, not something the user meant to swap with).
function findSwapTargetAt(draggedId, kx, ky, category, parentId, rawById, cellUnit) {
  const parentRaw = rawById[parentId];
  if (!parentRaw) return null;
  const { cellPitch, rowPitch } = derivePitches(cellUnit);
  const useOffset = (parentRaw.layoutMode ?? 'flow') !== 'square';
  const originX = parentRaw.x;
  const originY = parentRaw.y;
  const dropCell = nearestGridCell(kx - originX, ky - originY, category, cellPitch, rowPitch, useOffset);
  const candidate = Object.values(rawById).find((n) => {
    if (n.id === draggedId || n.parentId !== parentId) return false;
    if (categoryOf(n.id, rawById) !== category) return false;
    const cell = nearestGridCell((n.x ?? 0) - originX, (n.y ?? 0) - originY, category, cellPitch, rowPitch, useOffset);
    if (cell.row !== dropCell.row) return false;
    // A "wide" (double-cell) long-named pool occupies BOTH its own
    // anchor column and the one after it -- the drop point landing on
    // EITHER one still counts as "landed on this sibling", not a miss.
    // Without this, a regular pool dropped onto the second half of a
    // wide one just sat there overlapping it instead of swapping, since
    // only the wide pool's own first/anchor cell was ever checked
    // (verified directly: this was exactly the reported "regular pool
    // just goes and sits on the double one" bug).
    const isWide = n.type === 'pool' && (n.name?.length ?? 0) > LONG_POOL_NAME_THRESHOLD;
    return dropCell.col === cell.col || (isWide && dropCell.col === cell.col + 1);
  });
  return candidate?.id ?? null;
}

// Clamps a centre point so the entity's own box (centre +/- half its real
// size) stays fully *inside* `box` -- the user's own explicit request:
// never place something straddling a group's own edge. Previously a grid
// point (or a raw drop point) near the edge was accepted as-is, with no
// regard for how far the entity's own real footprint extends past it --
// verified directly: that's exactly what read as "placed right at the
// edge, but sticking out, until the box is manually resized to fit."
// Degenerate case (the entity's own real size is bigger than the box in
// some axis) falls back to that axis' own centre rather than an inverted
// clamp range.
// Every grid computation anywhere in this app (auto-layout, manual
// drag-snap, new-object-drop, locked-cell reservation) needs an `origin`
// to convert between a (row, col) and a real kkit position. Every one of
// those call sites used to compute it as `groupBox.x + CONTAINER_PADDING`
// -- the group's own CURRENT box corner -- which is exactly backwards
// from how a stable grid has to work: that raw value is an arbitrary
// real number that shifts with every resize, auto-fit recompute, or
// manual box edit, so the WHOLE lattice silently re-phased itself every
// time the box moved even slightly, leaving already-placed (locked)
// entities and freshly snapped/packed ones misaligned by a fraction of a
// cell relative to each other even though nothing about their own
// positions changed. The underlying integer grid has to be the stable
// thing, with the box treated as a loose, moveable window onto it (the
// user's own explicit framing) -- not the other way around.
//
// This rounds the group's own current corner onto the NEAREST point of
// the single, shared cellPitch/rowPitch lattice every group in the model
// already uses (cellPitch/rowPitch depend only on the global `scale`, not
// on any particular group), so the origin only ever moves in whole
// cellPitch/rowPeriod steps -- and never at all for a resize smaller than
// half a cell. `rowPeriod` is `rowPitch * 2` (one full pool+nonpool row
// pair), not `rowPitch` itself: rounding Y to a whole number of
// *rowPeriods* guarantees any shift in origin changes an existing
// entity's own computed row index by an EVEN number, which preserves its
// pool/non-pool row parity exactly -- rounding to single rowPitch steps
// could flip an already-placed pool onto what reads as a non-pool row (or
// vice versa) purely from the origin itself moving, which would be a
// second, worse source of instability than the one this fixes. Negative
// row/col indices (the user's own explicit allowance) fall out for free
// from this: nearestGridCell/gridToPixels never assumed row/col can't be
// negative except where buildInitialGrid's own fresh-pack numbering
// deliberately starts at 0 for an entirely new layout.
// Integer replacement for the old clampCenterToBox -- the "Integer grid
// rebuild" plan's own point 9: "content never moves outside bounds of a
// group", done in ix/iy terms, not screen/kkit floats. `numRows`/
// `numCols` is the container's own current integer span (its effective
// box's width/height divided by the pitch -- always an exact multiple
// by construction, see onContainerResize/effectiveContainerBox). Row
// parity (pool=odd, non-pool=even) is re-enforced after clamping --
// clamping to a bound can otherwise land on the wrong parity right at
// the edge.
function clampCellToBounds(row, col, category, wide, numRows, numCols) {
  const maxRow = Math.max(0, numRows - 1);
  let r = Math.min(Math.max(row, 0), maxRow);
  const wantOdd = category === 'pool';
  if ((Math.abs(r % 2) === 1) !== wantOdd) {
    r = r + 1 <= maxRow ? r + 1 : Math.max(0, r - 1);
  }
  const maxCol = Math.max(0, numCols - (wide ? 2 : 1));
  const c = Math.min(Math.max(col, 0), maxCol);
  return { row: r, col: c };
}

// A manual drag/drop's own snap-to-grid has no "repack everything"
// collision search the way auto-layout's own buildInitialGrid does (see
// its own locked-cell reservation) -- it only ever considers the ONE
// entity actually being placed. Dropping near (but not exactly on top
// of) an existing sibling can therefore compute the SAME nearest cell
// that sibling already occupies and silently land right on it, since
// drag-to-swap only fires when the drop point is literally inside that
// sibling's own rendered box (verified directly: this is a real,
// separate gap from the lattice-stability fix above, not caused by it).
// Given the desired (row, col) is already taken (per `occupied`, a
// Set of "row,col" strings), this walks outward ring by ring over every
// OTHER cell of the same category (rows two apart, same as every other
// category-aware search in this app) and returns the nearest free one by
// real pixel distance.
function findFreeGridCell(row, col, cellPitch, rowPitch, occupied) {
  const key = (r, c) => `${r},${c}`;
  if (!occupied.has(key(row, col))) return { row, col };
  for (let radius = 1; radius <= 40; radius++) {
    const candidates = [];
    for (let k = -radius; k <= radius; k++) {
      for (let m = -radius; m <= radius; m++) {
        if (Math.max(Math.abs(k), Math.abs(m)) !== radius) continue;
        candidates.push({ row: row + 2 * k, col: col + m });
      }
    }
    candidates.sort((a, b) => {
      const da = Math.hypot((a.col - col) * cellPitch, (a.row - row) * rowPitch);
      const db = Math.hypot((b.col - col) * cellPitch, (b.row - row) * rowPitch);
      return da - db;
    });
    const free = candidates.find((c) => !occupied.has(key(c.row, c.col)));
    if (free) return free;
  }
  return { row, col };
}

// The occupied-cell Set findFreeGridCell needs: every OTHER direct child
// of `parentId` (excluding `excludeId`, the entity actually being placed)
// of the SAME category, mapped to its own (row, col) under the SAME
// origin/lattice. Under the integer-grid rebuild every sibling's own
// stored x/y IS its plain top-left grid-cell corner already (no
// footprint/centre computation -- nothing to subtract), so this is a
// direct relative-offset lookup.
function occupiedGridCells(rawById, parentId, excludeId, category, originX, originY, cellPitch, rowPitch, useOffset) {
  const occupied = new Set();
  Object.values(rawById).forEach((sibling) => {
    if (sibling.id === excludeId || sibling.parentId !== parentId) return;
    if (categoryOf(sibling.id, rawById) !== category) return;
    const relX = (sibling.x ?? 0) - originX;
    const relY = (sibling.y ?? 0) - originY;
    const { row, col } = nearestGridCell(relX, relY, category, cellPitch, rowPitch, useOffset);
    occupied.add(`${row},${col}`);
    // A "wide" (double-cell) long-named pool also occupies the column
    // after its own anchor -- marking only the anchor cell left a
    // regular pool's own snap-to-grid free to land right on top of a
    // wide sibling's second half, reading as an overlap rather than a
    // miss (see findSwapTargetAt's own matching comment).
    const isWide = sibling.type === 'pool' && (sibling.name?.length ?? 0) > LONG_POOL_NAME_THRESHOLD;
    if (isWide) occupied.add(`${row},${col + 1}`);
  });
  return occupied;
}

// Snaps a creation drop-point into the SAME grid a manual drag already
// snaps to (see onNodeDragStop's own matching logic) -- the user's own
// later request: dragging a NEW pool/reaction in from the palette should
// land on the grid too, not just repositioning an existing one. The
// origin is the parent's own current stored absolute position, used
// directly (no rounding -- under the new model every container's own
// position is already guaranteed to be an exact SX-multiple of its own
// parent, so there is nothing left to snap it onto). `footprint` is
// only needed to know whether this is a "wide" (2-cell) entity, for the
// bounds clamp. `excludeId` is null for a brand new entity (no id yet to
// exclude); an existing entity being repositioned passes its own id, so
// it doesn't collide with its own current cell.
function snapPointToGrid(kx, ky, parentRaw, rawById, containerIndex, boxById, cellUnit, category, footprint, excludeId = null) {
  if (!parentRaw || !CONTAINER_TYPES.includes(parentRaw.type)) return { x: kx, y: ky };
  const parentBox = effectiveContainerBox(parentRaw, containerIndex, boxById, cellUnit);
  const { cellPitch, rowPitch } = derivePitches(cellUnit);
  const originX = parentBox.x;
  const originY = parentBox.y;
  const useOffset = (parentRaw.layoutMode ?? 'flow') !== 'square';
  let { row, col } = nearestGridCell(kx - originX, ky - originY, category, cellPitch, rowPitch, useOffset);
  const occupied = occupiedGridCells(rawById, parentRaw.id, excludeId, category, originX, originY, cellPitch, rowPitch, useOffset);
  ({ row, col } = findFreeGridCell(row, col, cellPitch, rowPitch, occupied));
  const numCols = Math.max(1, Math.round(parentBox.width / cellPitch));
  const numRows = Math.max(1, Math.round(parentBox.height / rowPitch));
  const wide = footprint.width > cellPitch * 1.5;
  ({ row, col } = clampCellToBounds(row, col, category, wide, numRows, numCols));
  // Math.abs: row can be negative now (see nearestGridCell's own
  // comment) -- plain `% 2` keeps the dividend's own sign in JS, so a
  // negative odd row (-1, -3, ...) would otherwise read as !== 1 and
  // silently miss its own stagger shift.
  const shift = useOffset && Math.abs(row % 2) === 1 ? cellPitch / 2 : 0;
  return { x: originX + shift + col * cellPitch, y: originY - row * rowPitch };
}

// React Flow reports a nested node's own `position` relative to its parent
// (that's the whole point of the parentId/extent:'parent' containment
// model -- see buildFlowNodes), so persisting it back as a kkit-unit
// x/y (an absolute, flat coordinate, same convention legacy .g files use)
// means walking up the parentId chain summing each ancestor's own relative
// position, rather than assuming node.position is already absolute.
function absoluteFlowPosition(nodeId, flowNodes) {
  const byId = {};
  flowNodes.forEach((n) => {
    byId[n.id] = n;
  });
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

export default function App() {
  const [flowGraph, setFlowGraph] = useState({ nodes: [], edges: [] });
  const [status, setStatus] = useState('starting new model...');
  // The Units menu's own four choices -- lifted here (rather than kept
  // local to UnitsMenuBox) so every dialog/plot that needs to convert a
  // native backend value can read the current selection. See
  // unitConversions.js for the actual conversion math.
  const [timeUnit, setTimeUnit] = useState(DEFAULT_TIME_UNIT);
  const [concUnit, setConcUnit] = useState(DEFAULT_CONC_UNIT);
  const [volumeUnit, setVolumeUnit] = useState(DEFAULT_VOLUME_UNIT);
  const [lengthUnit, setLengthUnit] = useState(DEFAULT_LENGTH_UNIT);
  // A transient, always-visible popup (regardless of which left-menu tab is
  // showing) for actionable warnings like an invalid drop -- distinct from
  // `status`, which nothing renders anymore (see FileMenuBox's own removal
  // of its status Alert) and was never meant for this anyway: `status` also
  // carries routine, silent-is-fine info ("loaded N nodes, M edges") that a
  // popup would just be noise for. `warningKey` forces the Snackbar to
  // re-open (and restart its auto-hide timer) even if the same message
  // fires twice in a row, since React skips a re-render when neither piece
  // of state actually changes value.
  const [warning, setWarning] = useState('');
  const [warningKey, setWarningKey] = useState(0);
  const showWarning = useCallback((message) => {
    setWarning(message);
    setWarningKey((k) => k + 1);
  }, []);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  // Populated by MainDisplay's own Canvas (see its matching comment) with
  // {fitView, getViewport, setViewport, getInternalNode} once the
  // ReactFlowProvider inside it actually mounts. fitView/getViewport/
  // setViewport: handlePrintLayout/handleSaveLayoutSvg use these to fit
  // the whole diagram into view before capturing it, since
  // onlyRenderVisibleElements means anything panned/zoomed out of the
  // current view isn't just clipped, it's missing from the DOM entirely.
  const canvasApiRef = useRef(null);
  const [activeMenu, setActiveMenu] = useState('File');
  const [plotData, setPlotData] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  // Lifted out of RunMenuBox (rather than kept as its own local state) so a
  // Stimulus's save-time negative-value check (see onSaveNode) can send the
  // Run panel's *current* runtime value along with it, per the user's own
  // choice of where that duration should come from.
  const [runtime, setRuntime] = useState('3000');
  const [plotDt, setPlotDt] = useState('1');
  // Which solver a Start click uses -- 'lsoda' (deterministic, Ksolve) or
  // 'gssa' (Gillespie's Stochastic Simulation Algorithm, Gsolve) -- see
  // sim_runner.py's build_solver.
  const [solverMethod, setSolverMethod] = useState('lsoda');
  // When on, the trace(s) showing when a run *starts* are kept around as a
  // dashed "previous" layer instead of being discarded the moment the new
  // run's own solid trace lands (see handleStartRun below) -- turning it
  // off doesn't retroactively clear an already-dashed trace, only the
  // *next* completed run stops carrying one forward.
  const [overlayPlots, setOverlayPlots] = useState(false);
  const [previousPlotData, setPreviousPlotData] = useState(null);
  // 'conc' (native mM, scaled by the Units menu's own concUnit) or 'n'
  // (raw molecule count, never unit-scaled, same as Pool's own n field
  // elsewhere) -- which of a pool's own domains the Plots tab's time-course
  // traces are shown in. The backend only ever records conc (see
  // sim_runner.py's build_plot_tables) -- 'n' is derived in PlotsPanel
  // itself from each pool's own (already-known) volume.
  const [plotDomain, setPlotDomain] = useState('conc');
  // Which of MainDisplay's two tabs (0 = Reaction Layout, 1 = Plots) is
  // showing -- lifted up here (rather than local state in MainDisplay) so a
  // completed run can switch to it, not just the user clicking the tab.
  const [displayTab, setDisplayTab] = useState(0);
  // Design section 6's 4-way visualization mode -- which of
  // computeCollapsedView/computeDetailedConnectView/computeIsolatedView/
  // computeDecoratedView (collapseView.js) actually decides what's shown,
  // independent of any individual group's own collapsed flag (read
  // directly off the same per-group flag every mode already uses -- no
  // separate group-picker UI here). Cycled through the floating panel's
  // own 4-way toggle button (see MainDisplay.jsx).
  const [visualMode, setVisualMode] = useState('groupConnect');
  const onCycleVisualMode = useCallback(() => {
    setVisualMode((m) => VISUAL_MODES[(VISUAL_MODES.indexOf(m) + 1) % VISUAL_MODES.length]);
  }, []);
  // Per-aggregate-edge bend point (see moveEdgeVia below) -- keyed by the
  // synthetic `aggregate-<a>-<b>` id computeCollapsedView assigns each
  // time it runs, not stored on any real flowGraph.edges entry, since an
  // aggregate edge *has* no real backing edge to attach it to (it
  // represents however many real connections collapsed down to one line).
  // Orphaned entries (for a pair that's no longer both-collapsed) are
  // harmless clutter, not a correctness issue -- left in place rather than
  // pruned, since the same pair collapsing again later should remember it.
  const [aggregateVia, setAggregateVia] = useState({});
  // Recomputed only on full graph reloads (load/reset/refresh), not on
  // incremental edits (drag, single add) -- so a drag or single new node
  // never rescales/shifts everything else already laid out.
  const [scale, setScale] = useState(DEFAULT_SCALE);
  // SX (the "Integer grid rebuild" plan's own global grid pitch, in kkit
  // units) and ScaleIcons (a pure rendering multiplier on icon size, zero
  // effect on SX or any stored coordinate) -- both computed/defaulted
  // once per model load (see handleGraphResult), never recomputed on
  // resize or when ScaleIcons itself changes, and persisted with the
  // SBML file (see FileMenuBox's handleSave/handleLoadSbmlFile) so
  // reopening a saved model reproduces the exact same lattice rather
  // than a freshly-recomputed one that no longer matches the file's own
  // stored absolute coordinates.
  const [sx, setSx] = useState(DEFAULT_SX);
  const [scaleIcons, setScaleIcons] = useState(DEFAULT_SCALE_ICONS);
  // Bumped on every full graph load (not incremental edits) so MainDisplay
  // knows to re-fit the viewport to the new node set -- React Flow's own
  // `fitView` prop only ever runs once, on initial mount.
  const [loadGeneration, setLoadGeneration] = useState(0);
  // The raw, pre-operation state of every node an auto-layout action is
  // about to touch -- see onAutoLayoutGroup/onAutoLayoutRecursive (which
  // set this right before applying a new layout) and onUndoLayout (which
  // restores it). A single slot, not a stack -- only the *most recent*
  // auto-layout run can be undone, and running another auto-layout (or
  // undoing) replaces/clears it rather than accumulating history.
  const [autoLayoutUndoSnapshot, setAutoLayoutUndoSnapshot] = useState(null);
  // True for the duration of any of the four layout actions below (Square/
  // Square recursive/Flow/Randomize) -- each one is a batch of async
  // position-update fetches followed by a refetch, so there's a real
  // window where clicking another layout button (or the same one again)
  // would race against work already in flight. PropertiesMenuBox disables
  // the whole Layout section while this is true.
  const [layoutRunning, setLayoutRunning] = useState(false);
  // Whether a manual drag snaps the dragged node's own centre to its
  // parent group's nearest grid cell (see onNodeDragStop) -- on by
  // default per the user's own explicit stipulation. Lifted here (not
  // local to PropertiesMenuBox) since onNodeDragStop itself needs to read
  // it, not just the checkbox that toggles it.
  const [snapToGrid, setSnapToGrid] = useState(true);
  // Only ever set during a Recurse Square/Flow run (see onAutoLayoutRecursive/
  // onAutoLayoutRecursiveFlow's own onProgress) -- null the rest of the
  // time, including during a plain single-level Square/Flow, which finishes
  // fast enough that a percentage would just flicker.
  const [layoutProgress, setLayoutProgress] = useState(null);

  // Dose Response's whole panel state lives here (not as local state in
  // DoseResponseMenuBox) so it survives switching to another menu tab and
  // back -- only whichever menu is currently selected gets mounted (see
  // AppLayout's menuComponents), so a plain local useState there would be
  // thrown away on every tab switch.
  const [doseParams, setDoseParams] = useState({
    inputId: '',
    outputId: '',
    minDecade: 2,
    maxDecade: 5,
    fine: false,
    buffered: true,
    resetEachLevel: true,
    decreasing: false,
    // 'input' | 'output' | null -- armed by DoseResponseMenuBox's own Pick
    // button (see handleArmDosePick), consumed by the *next* canvas click
    // (see onNodeClick/onPaneClick below) instead of a dropdown, so
    // choosing a dose/monitor pool doesn't mean scrolling through a
    // hundreds-of-entries Select once a model gets large.
    picking: null,
  });
  const [doseRunning, setDoseRunning] = useState(false);
  const [doseError, setDoseError] = useState(null);
  // The completed/in-progress curve, shown in the Plots tab (not inline in
  // DoseResponseMenuBox) -- `window` (1 or 2) is decided once at Start time
  // per the user's own priority: an unused plot window first, otherwise
  // plot2 even if that means displacing whatever it was already showing.
  const [doseCurve, setDoseCurve] = useState(null);
  const doseHaltRef = useRef(false);

  // FindSim experiment-playback state -- same "lives in App.jsx" reasoning
  // as Dose Response just above (survives switching menu tabs). `parsed`
  // is /api/findsim/parse's own response (design, stimuli/readout entity
  // names, the auto-matched pool ids, every pool available for a manual
  // override, and the original spec echoed back for the run call);
  // `entityMap` is the (possibly user-edited) block-id -> pool-id mapping
  // FindSimMenuBox collects before Run is enabled. `result`, like
  // doseCurve, is what the Plots tab actually renders.
  const [findSimParsed, setFindSimParsed] = useState(null);
  const [findSimEntityMap, setFindSimEntityMap] = useState({});
  const [findSimFileName, setFindSimFileName] = useState('');
  const [findSimRunning, setFindSimRunning] = useState(false);
  const [findSimError, setFindSimError] = useState(null);
  const [findSimResult, setFindSimResult] = useState(null);

  const handleGraphResult = useCallback((graph) => {
    if (graph.error) {
      setStatus(`error: ${graph.error}`);
      return;
    }
    const newScale = computeAutoScale(graph);
    setScale(newScale);
    // The file's own saved sx/scaleIcons (see backend's kkit:layoutGrid
    // annotation) reproduce the EXACT lattice it was saved with -- a
    // freshly-computed SX would almost certainly differ slightly (a
    // different canvas width at load time) and silently invalidate every
    // already-on-lattice stored position in that file. Only missing for a
    // legacy file (or a brand new model) -- computed fresh then, with
    // ScaleIcons defaulting to 1.0.
    const newSx = graph.layoutGrid?.sx ?? computeDefaultSx(newScale, canvasApiRef.current?.getCanvasWidth?.());
    const newScaleIcons = graph.layoutGrid?.scaleIcons ?? DEFAULT_SCALE_ICONS;
    setSx(newSx);
    setScaleIcons(newScaleIcons);
    setFlowGraph(toFlowGraph(graph, newScale, newSx));
    setSelectedNodeId(null);
    setStatus(`loaded ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
    // A dose-response curve/session refers to pool ids from whatever model
    // was loaded when it ran -- meaningless (and its ids possibly stale or
    // even reused by something else) once a new model replaces it.
    doseHaltRef.current = true;
    setDoseRunning(false);
    setDoseError(null);
    setDoseCurve(null);
    // A parsed FindSim spec's entity map and any run result refer to pool
    // ids from whatever model was loaded when it was parsed -- same
    // staleness concern as the dose-response curve just above.
    setFindSimParsed(null);
    setFindSimEntityMap({});
    setFindSimFileName('');
    setFindSimRunning(false);
    setFindSimError(null);
    setFindSimResult(null);
    // Switching to Reaction Layout *before* bumping loadGeneration matters:
    // FitViewOnLoad's fitView call measures the canvas container, which
    // reports zero size while its tab is display:none -- if a load
    // happened while the Plots tab was showing (e.g. loading a second
    // file after a run), the fit would silently compute against that
    // zero-size box instead of actually centering the new graph.
    setDisplayTab(0);
    setLoadGeneration((g) => g + 1);
  }, []);

  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    fetch(`${API_BASE}/api/new_model`, { method: 'POST' })
      .then((r) => r.json())
      .then(handleGraphResult)
      .catch((err) => setStatus(`error: ${err}`));
  }, [handleGraphResult]);

  const selectedNode = useMemo(
    () => flowGraph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [flowGraph.nodes, selectedNodeId]
  );

  // A read-only "Parent" field the Properties panel shows for every
  // entity -- moose paths reuse names constantly across different
  // branches of a model (the same pool name inside two different groups
  // is completely ordinary), so an entity's own name alone often can't
  // tell two same-named objects apart; its immediate container's name
  // usually can. null for a node with no parentId at all (a top-level
  // compartment).
  const selectedParentName = useMemo(() => {
    if (!selectedNode) return null;
    // An enzyme/ConcChan's real "parent" -- the molecule it's actually
    // attached to -- is its own parentPoolId (see moose_graph.py's
    // describe_enz/describe_concchan), not parentId, which instead names
    // whichever group/compartment encloses it for canvas containment (see
    // container_parent_id's own docstring) -- those are usually different
    // nodes, and the molecule is the more useful one to disambiguate by.
    const parentId =
      (selectedNode.data?.type === 'enz' || selectedNode.data?.type === 'concchan') && selectedNode.data?.parentPoolId
        ? selectedNode.data.parentPoolId
        : selectedNode.data?.parentId;
    if (!parentId) return null;
    return flowGraph.nodes.find((n) => n.id === parentId)?.data?.name ?? null;
  }, [selectedNode, flowGraph.nodes]);

  // Live layout-quality readout for whichever group/compartment is
  // selected -- the same computeLayoutScore optimizeGroupLayout itself
  // uses to judge a candidate, run here against whatever's *actually on
  // screen right now* (not a candidate), so it updates automatically both
  // before ever running auto-layout (a baseline to compare against) and
  // after (to see what it actually achieved). null whenever there's
  // nothing meaningful to score (no selection, a non-container selected,
  // or a container with no direct children).
  const selectedGroupScore = useMemo(() => {
    if (!selectedNode) return null;
    const type = selectedNode.data?.type;
    if (type !== 'group' && type !== 'compartment') return null;
    const rawNodes = flowGraph.nodes.map((n) => n.data);
    const rawById = {};
    rawNodes.forEach((n) => {
      rawById[n.id] = n;
    });
    const groupId = selectedNode.id;
    const directChildren = rawNodes.filter(
      (n) => n.parentId === groupId && !(n.type === 'pool' && n.isEnzComplex)
    );
    if (directChildren.length === 0) return null;
    const containerIndex = buildContainerIndex(rawNodes, rawById);
    const boxById = {};
    const cellUnit = sx;
    const scoreNodes = directChildren.map((c) => {
      const size = childFootprint(c, containerIndex, boxById, cellUnit);
      return {
        id: c.id,
        x: c.x,
        y: c.y,
        width: size.width,
        height: size.height,
        flipped: !!c.flipped,
        parentSide: c.parentSide,
        type: c.type,
      };
    });
    const scoreEdges = flowGraph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: e.data?.type }));
    return computeLayoutScore(scoreNodes, scoreEdges);
  }, [selectedNode, flowGraph.nodes, flowGraph.edges, sx]);

  // An enz complex pool is never its own citizen on the canvas -- see
  // buildFlowNodes' own comment on why (no meaningful position, no edges,
  // just the enzyme's bound state) -- filtered out here rather than at
  // buildFlowNodes/flowGraph itself, since Properties (reachable by
  // clicking the *enzyme*, not this pool, once App.jsx's onNodeClick
  // routes there), the Run/Plots pipeline, and SBML persistence all still
  // need it present in flowGraph.nodes as a real, addressable pool.
  const canvasGraph = useMemo(() => {
    const hiddenIds = new Set(
      flowGraph.nodes.filter((n) => n.data.type === 'pool' && n.data.isEnzComplex).map((n) => n.id)
    );
    if (hiddenIds.size === 0) return { nodes: flowGraph.nodes, edges: flowGraph.edges };
    return {
      nodes: flowGraph.nodes.filter((n) => !hiddenIds.has(n.id)),
      edges: flowGraph.edges.filter((e) => !hiddenIds.has(e.source) && !hiddenIds.has(e.target)),
    };
  }, [flowGraph.nodes, flowGraph.edges]);

  // The canvas renders this, not flowGraph directly -- everything else
  // (Properties, Plots, Dose Response, FindSim, add/remove) keeps working
  // against the full, uncollapsed flowGraph exactly as before; only the
  // Reaction Layout's own <ReactFlow> nodes/edges props are swapped for
  // this derived view. See collapseView.js for the actual rule (hide a
  // collapsed group's descendants, redirect/aggregate their edges).
  const collapsedIds = useMemo(() => {
    const ids = new Set();
    flowGraph.nodes.forEach((n) => {
      if (CONTAINER_TYPES.includes(n.data.type) && n.data.collapsed) ids.add(n.id);
    });
    return ids;
  }, [flowGraph.nodes]);
  const displayGraph = useMemo(() => {
    const VIEW_FN = {
      groupConnect: computeCollapsedView,
      detailedConnect: computeDetailedConnectView,
      isolated: computeIsolatedView,
      decorated: computeDecoratedView,
    };
    const view = VIEW_FN[visualMode](canvasGraph.nodes, canvasGraph.edges, collapsedIds);
    // Aggregate edges have no backing entry in flowGraph.edges (see
    // moveEdgeVia) -- their bend point is applied here instead, as a
    // cheap post-process over whatever computeCollapsedView just
    // synthesized, keyed by its own deterministic `aggregate-<a>-<b>` id.
    // A no-op lookup under every OTHER mode, none of which ever produce
    // aggregate edges in the first place -- harmless, not worth special-
    // casing out.
    const edgesWithAggregateVia =
      Object.keys(aggregateVia).length === 0
        ? view.edges
        : view.edges.map((e) => (aggregateVia[e.id] ? { ...e, data: { ...e.data, via: aggregateVia[e.id] } } : e));
    // Fills in a default bend point for any edge that still doesn't have
    // one and would otherwise draw straight through some unrelated
    // group's box -- see collapseView.js's own comment. Runs last, after
    // any user-dragged or aggregate via is already in place, since it
    // only ever supplies a default, never overrides one.
    return { ...view, edges: avoidObstacles(view.nodes, edgesWithAggregateVia) };
  }, [canvasGraph.nodes, canvasGraph.edges, collapsedIds, visualMode, aggregateVia]);

  const onNodeClick = useCallback(
    (event, node) => {
      // A proxy (Decorated mode -- see collapseView.js's computeDecoratedView) is
      // a synthetic stand-in for one specific hidden entity, not a real node
      // of its own -- clicking it opens *that* entity's own Properties
      // (still fully present in flowGraph.nodes, just not currently
      // rendered), keyed by realId/realType rather than the proxy's own
      // synthetic id/type.
      const isProxy = node.data.type === 'proxy';
      const realType = isProxy ? node.data.realType : node.data.type;
      const realId = isProxy ? node.data.realId : node.id;

      // Dose Response's own "pick from canvas" flow (see
      // DoseResponseMenuBox's own Pick button/handleArmDosePick) -- while
      // armed, the *next* click anywhere on the canvas is consumed by the
      // pick instead of the usual "open Properties" behavior, valid pool
      // or not (an invalid click just leaves picking armed rather than
      // silently opening Properties for whatever was actually clicked,
      // which would otherwise be a confusing double effect).
      if (doseParams.picking) {
        if (realType === 'pool') {
          const realNode = flowGraph.nodes.find((n) => n.id === realId);
          if (realNode && !realNode.data.isEnzComplex) {
            setDoseParams((p) => ({ ...p, [`${p.picking}Id`]: realId, picking: null }));
          }
        }
        return;
      }

      if (isProxy) {
        if (EDITABLE_ENDPOINTS[realType]) {
          setSelectedNodeId(realId);
          setActiveMenu('Properties');
        }
        return;
      }
      if (EDITABLE_ENDPOINTS[node.data.type]) {
        setSelectedNodeId(node.id);
        setActiveMenu('Properties');
      }
    },
    [doseParams.picking, flowGraph.nodes]
  );

  const onPaneClick = useCallback(() => {
    // A click on blank canvas while a Dose Response pick is armed means
    // "never mind" -- cancels the pick rather than leaving it armed
    // indefinitely (or, worse, silently doing nothing the user can see).
    if (doseParams.picking) {
      setDoseParams((p) => ({ ...p, picking: null }));
      return;
    }
    setSelectedNodeId(null);
  }, [doseParams.picking]);

  // Arms/disarms Dose Response's own "pick from canvas" flow (see
  // onNodeClick above) -- also switches to the Reaction Layout tab, since
  // there's nothing to click on the Plots tab.
  const handleArmDosePick = useCallback((field) => {
    setDoseParams((p) => ({ ...p, picking: p.picking === field ? null : field }));
    setDisplayTab(0);
  }, []);

  // Shared by handlePrintLayout/handleSaveLayoutSvg below -- force-switches
  // to Reaction Layout (that tab's own content is display:none otherwise,
  // which visibility:hidden/visible in index.css's print rule can't
  // override) and fits the WHOLE diagram into view before either one
  // captures anything. Fitting first matters because of Canvas's own
  // onlyRenderVisibleElements=true (see MainDisplay.jsx): a node currently
  // panned/zoomed out of view isn't just visually clipped, it's flat out
  // not in the DOM, so print/SVG export silently dropped it entirely
  // before this existed (verified directly against a real multi-group
  // model -- both the printout and the saved SVG only ever showed
  // whatever fit in the on-screen viewport at the moment of capture, e.g.
  // badLayout.svg). duration: 0 (an instant snap, not fitView's usual
  // animated pan/zoom) so there's nothing to wait out except React's own
  // next render -- still needs a short wait for onlyRenderVisibleElements
  // to actually mount the newly-visible nodes, hence the second delay.
  // Returns a restore() that puts the viewport back the way the user had
  // it, since a print/export isn't a request to change what they were
  // looking at.
  const prepareCanvasForCapture = useCallback(async () => {
    setDisplayTab(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const api = canvasApiRef.current;
    const prevViewport = api?.getViewport?.();
    api?.fitView?.({ padding: 0.1, duration: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const zoom = api?.getViewport?.()?.zoom ?? 1;
    const restore = () => {
      if (prevViewport) api?.setViewport?.(prevViewport, { duration: 0 });
    };
    return { restore, zoom };
  }, []);

  // FileMenuBox's own "Layout -> PDF" (File name field alongside it, same
  // [button][filename] row Save itself uses) -- see index.css's own
  // @media print block, which hides everything except #printable-canvas
  // (MainDisplay's Canvas wrapper, deliberately below the tabs/palette in
  // the tree) for the print pass. There's no JS API to emit a PDF file
  // directly (window.print() always goes through the browser/OS's own
  // print dialog, which is how the user actually picks "Save as PDF") --
  // the filename field's only real effect is the *suggested* filename
  // that dialog offers, via the same document.title trick browsers'
  // own "print to PDF" flow already keys off of.
  const handlePrintLayout = useCallback(
    async (filename) => {
      const { restore } = await prepareCanvasForCapture();
      const originalTitle = document.title;
      const suggested = (filename || 'layout').trim().replace(/\.pdf$/i, '') || 'layout';
      document.title = suggested;
      window.print();
      document.title = originalTitle;
      restore();
    },
    [prepareCanvasForCapture]
  );

  // FileMenuBox's own "Layout -> SVG" -- same #printable-canvas element
  // and same fit-the-whole-diagram-in prep as handlePrintLayout above.
  // buildStandaloneSvg (see its own module comment) builds a plain
  // <rect>/<ellipse>/<path>/<text> SVG straight from this app's own node/
  // edge data -- no <foreignObject>, no inlined computed styles -- so the
  // result is small and renders in any standard SVG viewer, not just a
  // browser (verified directly: the earlier html-to-image-based version
  // produced a 1.6MB file for a small diagram, 95% of it inlined per-
  // element computed style, and didn't render at all in eog/librsvg).
  const handleSaveLayoutSvg = useCallback(
    async (filename) => {
      const { restore, zoom } = await prepareCanvasForCapture();
      try {
        const node = document.getElementById('printable-canvas');
        if (!node) return;
        const svgText = buildStandaloneSvg(node, flowGraph.nodes, flowGraph.edges, zoom);
        const blob = new Blob([svgText], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const trimmed = (filename || 'layout.svg').trim() || 'layout.svg';
        const a = document.createElement('a');
        a.href = url;
        a.download = /\.svg$/i.test(trimmed) ? trimmed : `${trimmed}.svg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        showWarning(`Save Layout to SVG failed: ${err}`);
      } finally {
        restore();
      }
    },
    [prepareCanvasForCapture, flowGraph.nodes, flowGraph.edges, showWarning]
  );

  // The user's own later bug report: pressing Delete/Backspace on a
  // selected pool/reaction/etc removed it from the canvas but left it
  // fully intact in the backend model -- unlike dragging it onto the
  // trash icon (see onNodeDragStop), which calls /api/delete_node and
  // refreshes. This used to be a plain passthrough (every change, remove
  // included, went straight to applyNodeChanges), so React Flow's own
  // built-in `deleteKeyCode` handling (see MainDisplay.jsx) removed a
  // node from local state ONLY, with no backend call and no confirm-
  // before-deleting-a-container dialog. A 'remove' change is now instead
  // routed through the SAME confirm + /api/delete_node + refresh flow as
  // every other delete path, mirroring onEdgesChange's own already-
  // correct handling of an edge 'remove' change just below -- a
  // cancelled confirm drops the change entirely (nothing removed
  // locally, matching cancel), everything else still passes straight
  // through untouched.
  const onNodesChange = useCallback(
    (changes) => {
      const passThrough = [];
      changes.forEach((change) => {
        if (change.type !== 'remove') {
          passThrough.push(change);
          return;
        }
        const node = flowGraph.nodes.find((n) => n.id === change.id);
        if (!node) {
          passThrough.push(change);
          return;
        }
        if (!confirmContainerDelete(node, flowGraph.nodes)) return;
        fetch(`${API_BASE}/api/delete_node`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: node.id }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res.error) {
              setStatus(`error: ${res.error}`);
              return;
            }
            setSelectedNodeId((sel) => (sel === node.id ? null : sel));
            refreshGraphRef.current?.();
          })
          .catch((err) => setStatus(`error: ${err}`));
      });
      setFlowGraph((g) => ({ ...g, nodes: applyNodeChanges(passThrough, g.nodes) }));
    },
    [flowGraph.nodes]
  );

  // A node dragged onto the palette's trash icon is deleted instead of
  // repositioned -- the trash icon lives outside the React Flow canvas
  // (in EntityPalette), so this is a plain DOM hit-test against its
  // rect rather than anything React Flow's own drop handling knows about.
  const isOverTrash = (event) => {
    const trash = document.getElementById('kkit-trash-target');
    if (!trash) return false;
    const rect = trash.getBoundingClientRect();
    return (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
    );
  };

  // refreshGraph is only defined further down (it's the shared "re-fetch
  // and rebuild the whole flow graph" helper also used after other
  // structural edits), but onNodeDragStop's callback only ever *runs* at
  // drag-event time, long after the component has finished this render --
  // so reading it via a ref (populated once refreshGraph is actually
  // declared, below) avoids a temporal-dead-zone reference without having
  // to relocate that whole block earlier in the file.
  const refreshGraphRef = useRef(null);

  // Latched once at drag-start (not re-read from the drop event) since the
  // shift key can easily be released a beat before the mouse button is,
  // and captures the node's own parentId *before* the drag -- both read
  // back in onNodeDragStop to decide whether this was a plain in-group
  // reposition or an attempt to move to a different one.
  const dragStartInfoRef = useRef(null);

  // A node normally can't be dragged out of its own group/compartment box
  // at all (extent:'parent', see buildFlowNodes) -- the user's own later
  // request: holding Shift while starting a drag should lift that, so it
  // can be dropped into a *different* container instead. Relaxing extent
  // only on the one node actually being dragged (rather than globally)
  // keeps every other node's own containment exactly as before.
  const onNodeDragStart = useCallback((event, node) => {
    dragStartInfoRef.current = { shiftHeld: event.shiftKey, parentId: node.parentId };
    if (event.shiftKey && node.parentId) {
      setFlowGraph((g) => ({
        ...g,
        nodes: g.nodes.map((n) => (n.id === node.id ? { ...n, extent: undefined } : n)),
      }));
    }
  }, []);

  const onNodeDragStop = useCallback((event, node) => {
    if (isOverTrash(event)) {
      if (node.data.isEnzComplex) {
        setStatus("an enzyme's complex pool can't be deleted on its own -- delete the enzyme instead");
        return;
      }
      // A group/compartment's confirmation may be cancelled, in which case
      // execution falls through to the normal position-update path below
      // rather than leaving the drag in limbo.
      if (confirmContainerDelete(node, flowGraph.nodes)) {
        // A pool can have enzyme (and complex-pool) children that MOOSE
        // cascades onto when it's deleted -- a full graph re-fetch (rather
        // than just filtering this one id out of local state) is what keeps
        // those removed on screen too.
        fetch(`${API_BASE}/api/delete_node`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: node.id }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res.error) {
              setStatus(`error: ${res.error}`);
              return;
            }
            setSelectedNodeId((sel) => (sel === node.id ? null : sel));
            refreshGraphRef.current?.();
          })
          .catch((err) => setStatus(`error: ${err}`));
        return;
      }
    }
    const abs = absoluteFlowPosition(node.id, flowGraph.nodes);
    const x = abs.x / scale;
    const y = -abs.y / scale;
    const isContainer = CONTAINER_TYPES.includes(node.data.type);

    const dragInfo = dragStartInfoRef.current;
    dragStartInfoRef.current = null;
    if (dragInfo?.shiftHeld) {
      // Excludes the dragged node itself from consideration -- only
      // relevant when it's a group/compartment being dragged (its own box
      // could otherwise "contain" the very point it just moved to).
      const newParentId = findContainerAt(x, y, flowGraph.nodes.filter((n) => n.id !== node.id), sx);
      if (newParentId && newParentId !== dragInfo.parentId) {
        fetch(`${API_BASE}/api/update_position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: node.id, x, y, newParentId }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res.error) {
              setStatus(`error: ${res.error}`);
              // extent was relaxed for this drag -- a node stuck without
              // its usual containment until the next unrelated refresh
              // would be a lingering bug, not just a cosmetic one.
              refreshGraphRef.current?.();
              return;
            }
            setSelectedNodeId((sel) => (sel === node.id ? res.id : sel));
            refreshGraphRef.current?.();
          })
          .catch((err) => {
            setStatus(`error: ${err}`);
            refreshGraphRef.current?.();
          });
        return;
      }
      // Shift was held but it landed back in the same container (or
      // nowhere valid) -- nothing to actually move. Re-fetching (rather
      // than just restoring this one node's own extent) is the simplest
      // way to also snap its position back to wherever it actually was
      // last saved, instead of persisting a drop point that may now sit
      // outside its own unchanged parent's box.
      if (!newParentId) {
        showWarning('Drop it inside a group or compartment.');
      }
      refreshGraphRef.current?.();
      return;
    }

    // Drag-to-swap and snap-to-grid (the user's own later requests) only
    // ever apply to a node with a real parent group/compartment -- both
    // are about that parent's own grid, which a top-level node isn't part
    // of. `x`/`y` (the raw drop point, computed above) is the fallback
    // for either check finding nothing to do.
    let finalX = x;
    let finalY = y;
    let targetFinalX = null;
    let targetFinalY = null;
    let swapTargetId = null;
    // Built unconditionally (not just when node.parentId is set) -- a
    // CONTAINER being dragged needs its own descendant cascade (see
    // below) regardless of whether it itself has a parent; a plain
    // top-level node with no parent never reaches the swap/snap logic
    // below, which still guards on `node.parentId` itself.
    const rawNodes = flowGraph.nodes.map((n) => n.data);
    const rawById = {};
    rawNodes.forEach((n) => {
      rawById[n.id] = n;
    });
    const containerIndex = buildContainerIndex(rawNodes, rawById);
    const boxById = {};
    const cellUnit = sx;
    if (node.parentId) {
      // Under the integer grid rebuild, every stored x/y IS already the
      // plain top-left of its own cell -- `footprint` is only needed here
      // to tell snapPointToGrid whether this is a "wide" (2-cell) entity.
      const footprint = childFootprint(node.data, containerIndex, boxById, cellUnit);
      const category = categoryOf(node.id, rawById);
      const parentRaw = rawById[node.parentId];
      const parentBox =
        parentRaw && CONTAINER_TYPES.includes(parentRaw.type) ? effectiveContainerBox(parentRaw, containerIndex, boxById, cellUnit) : null;

      // Checked first, per the plan: dropping one pool/non-pool directly
      // onto another same-category sibling's own EXACT grid cell (see
      // findSwapTargetAt's own comment -- exact integer cell identity,
      // not an overlapping box) swaps their stored positions instead of
      // moving either one into a fresh grid slot. Never for a CONTAINER,
      // though -- swapping two whole nested sub-trees (each needing its
      // own descendant cascade) isn't something this has been asked for,
      // and a plain snapped move (or the cascade below) is the right
      // fallback for one.
      swapTargetId = isContainer ? null : findSwapTargetAt(node.id, x, y, category, node.parentId, rawById, cellUnit);
      if (swapTargetId) {
        // A swap is just trading the two stored top-left positions
        // directly -- no centre/size bookkeeping needed at all now that
        // position IS the cell's own corner.
        const targetRaw = rawById[swapTargetId];
        finalX = targetRaw.x;
        finalY = targetRaw.y;
        targetFinalX = node.data.x;
        targetFinalY = node.data.y;
      } else if (snapToGrid && parentBox) {
        const snapped = snapPointToGrid(x, y, parentRaw, rawById, containerIndex, boxById, cellUnit, category, footprint, node.id);
        finalX = snapped.x;
        finalY = snapped.y;
      }
    }

    // React Flow's own `position` (relative to the parent, in scaled
    // screen pixels -- see buildFlowNodes' own matching formula) is
    // SEPARATE from this app's own `data.x/y` -- React Flow already moved
    // it to the raw drop point as part of the native drag, but a swap or
    // a grid snap can move the final, PERSISTED spot away from that raw
    // point. Without also recomputing `position` here, the node would
    // keep rendering at the raw drop point until some unrelated action
    // (adding/deleting a node, which fully rebuilds every node's position
    // from scratch) happened to refresh it.
    function toFlowPosition(absX, absY, parentId) {
      const parentBox = parentId ? effectiveContainerBox(rawById[parentId], containerIndex, boxById, cellUnit) : null;
      const relX = parentBox ? absX - parentBox.x : absX;
      const relY = parentBox ? absY - parentBox.y : absY;
      return { x: relX * scale, y: -relY * scale };
    }

    if (swapTargetId) {
      const draggedNewPos = toFlowPosition(finalX, finalY, node.parentId);
      const targetNewPos = toFlowPosition(targetFinalX, targetFinalY, node.parentId);
      Promise.all([
        fetch(`${API_BASE}/api/update_position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: node.id, x: finalX, y: finalY }),
        }).then((r) => r.json()),
        fetch(`${API_BASE}/api/update_position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Swapped by centre, each accounting for its own real size --
          // see the comment above where targetFinalX/Y were computed --
          // not simply the dragged node's own OLD stored corner.
          body: JSON.stringify({ id: swapTargetId, x: targetFinalX, y: targetFinalY }),
        }).then((r) => r.json()),
      ])
        .then(([res1, res2]) => {
          const failed = [res1, res2].find((r) => r.error);
          if (failed) {
            setStatus(`error: ${failed.error}`);
            return;
          }
          setFlowGraph((g) => ({
            ...g,
            // Both ends of a swap are now just as deliberately placed as
            // if the user had dragged each one directly -- see the plan's
            // own reasoning.
            nodes: g.nodes.map((n) => {
              if (n.id === node.id) return { ...n, position: draggedNewPos, data: { ...n.data, x: finalX, y: finalY, locked: true } };
              if (n.id === swapTargetId) return { ...n, position: targetNewPos, data: { ...n.data, x: targetFinalX, y: targetFinalY, locked: true } };
              return n;
            }),
          }));
        })
        .catch((err) => setStatus(`error: ${err}`));
      return;
    }

    const snappedPos = finalX !== x || finalY !== y ? toFlowPosition(finalX, finalY, node.parentId) : null;

    // A group's own children are meant to move AS ONE with it (the
    // user's own explicit design: a child's placement is conceptually an
    // offset from the group's own corner, not an independent absolute
    // position) -- so moving the group has to shift every descendant's
    // own stored absolute x/y by the SAME delta, or they're silently left
    // behind (verified directly: this is exactly what "molecules piled at
    // the bottom after moving the group up" turned out to be --
    // snap-to-grid was reading each child's own stale, pre-move absolute
    // position against the group's NEW box, which reads as "very far
    // outside the box" and clamps every one of them to the same edge).
    // Deliberately NOT buildContainerIndex's own `descendants` map here --
    // that only ever registers *leaf* entities, skipping nested
    // sub-containers entirely (see its own comment), which would leave a
    // nested sub-container's own position relative to THIS move
    // unintentionally shifting. A plain entity (isContainer false) never
    // has descendants, so cascadeTargets is just empty for it -- same
    // code path, no extra branching needed.
    const cascadeTargets = isContainer
      ? rawNodes.filter((n) => n.id !== node.id && isDescendantOf(n.id, node.id, rawById))
      : [];
    const dx = finalX - node.data.x;
    const dy = finalY - node.data.y;
    const cascadeUpdates = cascadeTargets.map((n) => ({ id: n.id, x: n.x + dx, y: n.y + dy }));

    Promise.all(
      [{ id: node.id, x: finalX, y: finalY }, ...cascadeUpdates].map((u) =>
        fetch(`${API_BASE}/api/update_position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(u),
        }).then((r) => r.json())
      )
    )
      .then((results) => {
        const failed = results.find((r) => r.error);
        if (failed) {
          setStatus(`error: ${failed.error}`);
          return;
        }
        const cascadeById = new Map(cascadeUpdates.map((u) => [u.id, u]));
        setFlowGraph((g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            // A manual drag is exactly the "manually positioned" case
            // data.locked exists to flag -- see its own comment -- so a
            // later auto-layout run leaves this node exactly where the
            // user just put it instead of repacking it. Only the node
            // actually dragged gets locked -- a cascaded descendant was
            // carried along, not individually placed, so its own lock
            // status (if any) is left exactly as it already was.
            if (n.id === node.id) {
              return { ...n, ...(snappedPos ? { position: snappedPos } : {}), data: { ...n.data, x: finalX, y: finalY, locked: true } };
            }
            // A cascaded descendant's own RENDERED position never
            // changes -- it's relative to its own immediate parent (the
            // dragged container, or a nested sub-container that's ALSO
            // shifting by this same delta), and a uniform shift leaves
            // that relative offset exactly as it was. Only its stored
            // absolute x/y needs updating, for future reference (the
            // next drag, the next auto-layout, a save).
            const u = cascadeById.get(n.id);
            return u ? { ...n, data: { ...n.data, x: u.x, y: u.y } } : n;
          }),
        }));
      })
      .catch((err) => setStatus(`error: ${err}`));
  }, [scale, flowGraph.nodes, showWarning, snapToGrid, sx]);

  // A group/compartment's resize handle (nodes.jsx's NodeResizer, via
  // NodeActionsContext) reports its new box in the same relative-to-parent
  // flow-pixel space node.position uses -- so it needs the same ancestor
  // walk as absoluteFlowPosition, just seeded from the resize event's own
  // (possibly moved, if resized from the top/left) x/y instead of the
  // node's last-known position.
  const onContainerResize = useCallback(
    (nodeId, box) => {
      const byId = {};
      flowGraph.nodes.forEach((n) => {
        byId[n.id] = n;
      });
      let ax = box.x;
      let ay = box.y;
      let parentId = byId[nodeId]?.parentId;
      while (parentId) {
        const parent = byId[parentId];
        if (!parent) break;
        ax += parent.position.x;
        ay += parent.position.y;
        parentId = parent.parentId;
      }
      const rawX = ax / scale;
      const rawY = -ay / scale;
      const rawWidth = box.width / scale;
      const rawHeight = box.height / scale;

      const rawNodes = flowGraph.nodes.map((n) => n.data);
      const rawById = {};
      rawNodes.forEach((n) => {
        rawById[n.id] = n;
      });
      const containerIndex = buildContainerIndex(rawNodes, rawById);
      const boxById = {};
      const cellUnit = sx;
      const { cellPitch, rowPitch } = derivePitches(cellUnit);

      // The user's own explicit design: a group "cannot shrink smaller
      // than the extent of any of the group objects" -- computed in
      // whole grid cells, with ZERO extra padding folded into the math
      // (spec point 9 says nothing about padding; any visual breathing
      // room is a fixed CSS margin on the group's own rendering, never a
      // term here). Every direct child's own fixed footprint
      // (childFootprint -- no DOM measurement needed any more, see the
      // integer-grid rebuild's own notes) is anchored at its own stored
      // top-left corner, and the proposed box is clamped to still contain
      // all of them, independently per edge (so dragging, say, only the
      // left handle past some child's own left edge is clamped there
      // without also forcing the untouched right edge to move).
      const directChildren = rawNodes.filter(
        (n) => n.parentId === nodeId && !(n.type === 'pool' && n.isEnzComplex)
      );
      let x = rawX;
      let y = rawY;
      let right = rawX + rawWidth;
      let bottom = rawY - rawHeight;
      if (directChildren.length > 0) {
        const extents = directChildren.map((child) => {
          const size = childFootprint(child, containerIndex, boxById, cellUnit);
          return { left: child.x, right: child.x + size.width, top: child.y, bottom: child.y - size.height };
        });
        const contentLeft = Math.min(...extents.map((e) => e.left));
        const contentRight = Math.max(...extents.map((e) => e.right));
        const contentTop = Math.max(...extents.map((e) => e.top));
        const contentBottom = Math.min(...extents.map((e) => e.bottom));
        x = Math.min(x, contentLeft);
        right = Math.max(right, contentRight);
        y = Math.max(y, contentTop);
        bottom = Math.min(bottom, contentBottom);
      }

      // Edges snapped onto the SAME global lattice everything else in
      // this app uses (the user's own explicit design: "groups are
      // placed on square grid points and their boundaries are also
      // aligned to the grid") -- floor/ceil, not round-to-nearest,
      // specifically so snapping never shrinks the box back past the
      // content-safe bounds just computed: each edge only ever moves
      // further AWAY from the content it has to contain, never toward it.
      x = Math.floor(x / cellPitch) * cellPitch;
      right = Math.ceil(right / cellPitch) * cellPitch;
      y = Math.ceil(y / rowPitch) * rowPitch;
      bottom = Math.floor(bottom / rowPitch) * rowPitch;
      const width = right - x;
      const height = y - bottom;

      const oldRaw = byId[nodeId]?.data;
      const dx = oldRaw ? x - oldRaw.x : 0;
      const dy = oldRaw ? y - oldRaw.y : 0;
      // The user's own explicit design: a group's children move AS ONE
      // with it -- same cascade onNodeDragStop's own container-move
      // branch uses (see its own comment), needed here too since
      // resizing from a top/left handle moves the box's own corner
      // exactly the same way a plain drag does.
      const cascadeTargets = rawNodes.filter((n) => n.id !== nodeId && isDescendantOf(n.id, nodeId, rawById));
      const cascadeUpdates = cascadeTargets.map((n) => ({ id: n.id, x: n.x + dx, y: n.y + dy }));

      Promise.all(
        [{ id: nodeId, x, y, width, height }, ...cascadeUpdates].map((u) =>
          fetch(`${API_BASE}/api/update_position`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(u),
          }).then((r) => r.json())
        )
      )
        .then((results) => {
          const failed = results.find((r) => r.error);
          if (failed) {
            setStatus(`error: ${failed.error}`);
            return;
          }
          // The box actually applied can differ from the resize handle's
          // own live, unsnapped `box` (clamped to content, snapped to the
          // lattice) -- position/style have to reflect the REAL final
          // box, in the same relative-to-parent flow-pixel space `box`
          // itself was given in, not the handle's own raw, pre-clamp
          // report.
          const parentBoxNow = oldRaw?.parentId ? effectiveContainerBox(rawById[oldRaw.parentId], containerIndex, boxById, cellUnit) : null;
          const relX = parentBoxNow ? x - parentBoxNow.x : x;
          const relY = parentBoxNow ? y - parentBoxNow.y : y;
          const flowPos = { x: relX * scale, y: -relY * scale };
          const flowStyle = { width: width * scale, height: height * scale };
          const cascadeById = new Map(cascadeUpdates.map((u) => [u.id, u]));
          setFlowGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) => {
              if (n.id === nodeId) {
                return {
                  ...n,
                  position: flowPos,
                  style: flowStyle,
                  // expandedStyle has to move in lockstep with the manual
                  // resize, not just node.style -- it's the value
                  // buildFlowNodes recomputes this container's own real
                  // box from on every future refreshGraph, and until now
                  // it was only ever set once, back at the last
                  // buildFlowNodes call; left unsynced here, the next
                  // refresh (or a save/reload round-trip) would silently
                  // snap this container back to its pre-resize box.
                  // A manual resize (like a manual drag, see
                  // onNodeDragStop) counts as "manually positioned" --
                  // see data.locked's own comment.
                  data: { ...n.data, x, y, width, height, expandedStyle: flowStyle, locked: true },
                };
              }
              // A cascaded descendant's own RENDERED position never
              // changes -- see onNodeDragStop's own matching comment.
              const u = cascadeById.get(n.id);
              return u ? { ...n, data: { ...n.data, x: u.x, y: u.y } } : n;
            }),
          }));
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [flowGraph.nodes, scale, sx]
  );

  // A group's own "auto-layout children" action (Properties panel) --
  // packs its *direct* children only (nested sub-groups move as a single
  // block, their own interior untouched) into a uniform grid anchored at
  // the group's current top-left, then resizes the group itself to fit
  // snugly around the result. Two rounds of /api/update_position (one per
  // child, then one for the group) rather than a dedicated backend
  // endpoint -- every position already flows through that one endpoint,
  // and there's no other bulk-layout concept on the backend to hang a new
  // one off of. Ends with a full refreshGraph (not a local patch) since
  // it touches an unbounded number of nodes at once.
  const onAutoLayoutGroup = useCallback(
    (groupId, { force = false, randomizeItems = false, randomizeBlanks = false } = {}) => {
      const rawNodes = flowGraph.nodes.map((n) => n.data);
      const rawById = {};
      rawNodes.forEach((n) => {
        rawById[n.id] = n;
      });
      const group = rawById[groupId];
      if (!group) return;
      // An enz complex pool is never its own node on the canvas (see
      // buildFlowNodes/canvasGraph) -- it still shows up here as a
      // structural "direct child" of the group (container_parent_id walks
      // straight past its own enzyme to find one), but it has no
      // meaningful position of its own to place; left out entirely rather
      // than given a grid slot next to entities it has no visual relation
      // to (verified directly: that's exactly what read as "some isolated
      // molecule in a corner" -- it wasn't a stray pool, it was one of
      // these).
      const directChildren = rawNodes.filter(
        (n) => n.parentId === groupId && !(n.type === 'pool' && n.isEnzComplex)
      );
      if (directChildren.length === 0) return;
      // A locked child (see data.locked) never moves or resizes -- exactly
      // the "manually positioned/oriented" case that flag exists to
      // protect -- but the group's own final size still has to actually
      // contain it, so its current real footprint is folded into the
      // bounding-box math below alongside the freshly-packed grid.
      const unlockedChildren = directChildren.filter((c) => !c.locked);
      const lockedChildren = directChildren.filter((c) => c.locked);
      if (unlockedChildren.length === 0) return;

      // Anchored at the group's own *effective* box (see effectiveContainerBox),
      // not its raw x/y fields directly -- those only mean "top-left of the
      // box" for a group that's actually been explicitly sized at some point
      // (onContainerResize sets them together). A group still relying on
      // auto-fit-from-contents (width/height never set -- the common case
      // for any group a legacy .g file never had manually resized) can have
      // a raw x/y that's just some arbitrary leftover coordinate, unrelated
      // to where the box actually renders -- anchoring the new grid there
      // was what sent children flying off to an unrelated spot on the
      // canvas instead of rearranging them roughly where they already are
      // (verified directly: children ended up scattered relative to their
      // *old* positions, not the group's own visible box).
      setLayoutRunning(true);
      const containerIndex = buildContainerIndex(rawNodes, rawById);
      const boxById = {};
      const cellUnit = sx;
      const sizes = new Map(directChildren.map((c) => [c.id, childFootprint(c, containerIndex, boxById, cellUnit)]));
      const groupBox = effectiveContainerBox(group, containerIndex, boxById, cellUnit);
      // The group's own stored position is the origin, used directly --
      // every write path now guarantees it's already an exact SX-multiple
      // of ITS OWN parent (see the "Integer grid rebuild" plan), so there
      // is nothing left to round here.
      const originX = groupBox.x;
      const originY = groupBox.y;

      // Item 4 (later feedback): "redo Square... almost same algorithm,
      // just force the pool vs non-pool row structure." Square now
      // shares Flow's own grid/swap engine (see SQUARE_FLOW_WEIGHTS'
      // own comment) -- same alternation guarantee, same verified-
      // improvement swap search, same discard-if-worse gate (never sent
      // to the backend at all if it wouldn't actually improve, exactly
      // as the old optimizeGroupLayout-based version already did), same
      // refineFlips pass, just without Flow's own top-to-bottom bias.
      // `force`/`randomizeItems`/`randomizeBlanks` (a later request,
      // mirroring Flow's own Force option and adding Rand Square/Rand
      // Flow) thread straight through -- see computeFlowGroupLayout's
      // own comments on each.
      const { positions, flips: squareFlips } = computeFlowGroupLayout({
        children: directChildren,
        edges: flowGraph.edges,
        rawById,
        sizes,
        weights: SQUARE_FLOW_WEIGHTS,
        cellUnit,
        force,
        randomizeItems,
        randomizeBlanks,
        origin: { x: originX, y: originY },
      });
      // `p.x`/`p.y` (gridToPixels, layoutGrid.js) is already the plain
      // top-left of the grid cell, relative to the origin -- no footprint
      // subtraction needed, see the "Integer grid rebuild" plan.
      const placements = unlockedChildren.map((child) => {
        const p = positions.get(child.id);
        return { child, x: originX + p.x, y: originY + p.y };
      });
      const lockedFootprints = lockedChildren.map((c) => ({ x: c.x, y: c.y, ...sizes.get(c.id) }));

      // Captured *before* anything is sent to the backend -- these are
      // the raw pre-operation values exactly as they stood (including an
      // "auto-fit" group's own 0/0 width/height, if that's what it had),
      // so onUndoLayout reproduces the prior state exactly rather than an
      // approximation of it.
      const undoSnapshot = {
        nodes: [
          { id: groupId, x: group.x, y: group.y, width: group.width, height: group.height, isContainer: true },
          ...directChildren.map((c) => ({
            id: c.id,
            x: c.x,
            y: c.y,
            width: c.width,
            height: c.height,
            flipped: c.flipped,
            isContainer: CONTAINER_TYPES.includes(c.type),
          })),
        ],
      };

      Promise.all(
        placements.map(({ child, x, y }) =>
          fetch(`${API_BASE}/api/update_position`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: child.id, x, y }),
          }).then((r) => r.json())
        )
      )
        .then((results) => {
          const failed = results.find((r) => r.error);
          if (failed) throw new Error(failed.error);
          // Auto-layout keeps the group's own *position* fixed always
          // (see groupBox.x/y just below -- never touched by anything
          // computed here), but its size always ends up exactly what the
          // freshly-packed grid (plus whatever locked children have to
          // stay contained) needs, grown or shrunk -- an earlier version
          // only ever grew it (never shrinking below whatever it measured
          // before), meant to stop this from resizing a
          // deliberately-sized group out from under itself, but that
          // also permanently locked in any already-oversized box as a
          // floor no later run could tighten back up, which is backwards
          // from what asking for a fresh layout is for: it read as dead
          // space inside the group, not "its contents rearranged".
          const sizeById = new Map(directChildren.map((c) => [c.id, sizes.get(c.id)]));
          const leftEdges = [...placements.map((p) => p.x), ...lockedFootprints.map((f) => f.x)];
          const rightEdges = [
            ...placements.map((p) => p.x + sizeById.get(p.child.id).width),
            ...lockedFootprints.map((f) => f.x + f.width),
          ];
          const bottomEdges = [
            ...placements.map((p) => p.y - sizeById.get(p.child.id).height),
            ...lockedFootprints.map((f) => f.y - f.height),
          ];
          const topEdges = [...placements.map((p) => p.y), ...lockedFootprints.map((f) => f.y)];
          // Zero padding folded into the grid math (spec point 9 -- see
          // onContainerResize's own matching comment) -- rounded UP to a
          // whole SX/rowPitch cell in case a locked child's own old
          // position isn't currently exact (e.g. never touched since a
          // legacy load); every freshly-packed placement already lands
          // exactly on a cell, so this is a no-op for them.
          const { cellPitch: finalCellPitch, rowPitch: finalRowPitch } = derivePitches(cellUnit);
          const width = Math.ceil((Math.max(...rightEdges) - Math.min(...leftEdges)) / finalCellPitch) * finalCellPitch;
          const height = Math.ceil((Math.max(...topEdges) - Math.min(...bottomEdges)) / finalRowPitch) * finalRowPitch;
          return fetch(`${API_BASE}/api/update_position`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: groupId, x: groupBox.x, y: groupBox.y, width, height }),
          }).then((r) => r.json());
        })
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            return;
          }
          // computeFlowGroupLayout's own returned flips (see
          // onAutoLayoutGroupByFlow's own matching comment) already
          // reflect whichever grid it actually chose, verified against
          // the real layout score -- no need to re-derive them here.
          // Also tags the group itself with data.layoutMode: 'square' --
          // see buildFlowNodes' own comment -- so a later manual drag's
          // snap-to-grid (onNodeDragStop) knows this group's grid is a
          // plain, unoffset array, not Flow's staggered one.
          setFlowGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) => {
              if (n.id === groupId) return { ...n, data: { ...n.data, layoutMode: 'square' } };
              return squareFlips[n.id] !== undefined ? { ...n, data: { ...n.data, flipped: squareFlips[n.id] } } : n;
            }),
          }));
          setAutoLayoutUndoSnapshot(undoSnapshot);
          refreshGraphRef.current?.();
          // Deliberately NOT bumping loadGeneration (and so NOT re-fitting
          // the viewport) here -- you're usually looking right at the
          // group you just asked to be laid out, and having the whole
          // view suddenly jump to reframe the entire model was
          // disorienting even though the group's own new size is still
          // perfectly visible without it.
        })
        .catch((err) => setStatus(`error: ${err}`))
        .finally(() => setLayoutRunning(false));
    },
    [flowGraph.nodes, flowGraph.edges, scale, sx]
  );

  // Sibling to onAutoLayoutGroup above, using computeFlowGroupLayout (a
  // deterministic Sugiyama-style layered layout -- see the planning
  // discussion this shipped from) instead of optimizeGroupLayout's scored
  // SA search. Deliberately its own separate action, not folded into the
  // same button/candidate comparison: a flow layout's rows are a hard
  // constraint the user explicitly asked for, not one candidate among
  // several to be judged by layoutScore.js's own connector-length-based
  // score (which has no notion of "upstream/downstream" at all) -- there's
  // no meaningful "discard if worse" gate for it the way the grid-based
  // action has one.
  const onAutoLayoutGroupByFlow = useCallback(
    (groupId, { force = false, randomizeItems = false, randomizeBlanks = false } = {}) => {
      const rawNodes = flowGraph.nodes.map((n) => n.data);
      const rawById = {};
      rawNodes.forEach((n) => {
        rawById[n.id] = n;
      });
      const group = rawById[groupId];
      if (!group) return;
      // Same enz-complex-pool exclusion as onAutoLayoutGroup above -- see
      // its own comment.
      const directChildren = rawNodes.filter(
        (n) => n.parentId === groupId && !(n.type === 'pool' && n.isEnzComplex)
      );
      if (directChildren.length === 0) return;
      const lockedChildren = directChildren.filter((c) => c.locked);
      const unlockedChildren = directChildren.filter((c) => !c.locked);
      if (unlockedChildren.length === 0) return;

      // Set before computeFlowGroupLayout's own (synchronous, occasionally
      // slow-ish -- see layoutGrid.js's own FULL_SCORE_SIZE_LIMIT comment)
      // call below, not just before the network round-trip that follows
      // it -- React can't actually repaint mid-synchronous-call regardless,
      // but this still covers the whole operation from the caller's own
      // point of view, and is what the fetches' own async window needs.
      setLayoutRunning(true);
      const containerIndex = buildContainerIndex(rawNodes, rawById);
      const boxById = {};
      const cellUnit = sx;
      const sizes = new Map(directChildren.map((c) => [c.id, childFootprint(c, containerIndex, boxById, cellUnit)]));
      const groupBox = effectiveContainerBox(group, containerIndex, boxById, cellUnit);
      // The group's own stored position, used directly -- see
      // onAutoLayoutGroup's own matching comment.
      const originX = groupBox.x;
      const originY = groupBox.y;

      const { positions, flips: flowFlips } = computeFlowGroupLayout({
        children: directChildren,
        edges: flowGraph.edges,
        rawById,
        sizes,
        force,
        cellUnit,
        randomizeItems,
        randomizeBlanks,
        origin: { x: originX, y: originY },
      });
      // `p.x`/`p.y` is already the plain top-left of the grid cell -- see
      // onAutoLayoutGroup's own matching comment.
      const placements = unlockedChildren.map((child) => {
        const p = positions.get(child.id);
        return { child, x: originX + p.x, y: originY + p.y };
      });
      const lockedFootprints = lockedChildren.map((c) => ({ x: c.x, y: c.y, ...sizes.get(c.id) }));

      const undoSnapshot = {
        nodes: [
          { id: groupId, x: group.x, y: group.y, width: group.width, height: group.height, isContainer: true },
          ...directChildren.map((c) => ({
            id: c.id,
            x: c.x,
            y: c.y,
            width: c.width,
            height: c.height,
            flipped: c.flipped,
            isContainer: CONTAINER_TYPES.includes(c.type),
          })),
        ],
      };

      Promise.all(
        placements.map(({ child, x, y }) =>
          fetch(`${API_BASE}/api/update_position`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: child.id, x, y }),
          }).then((r) => r.json())
        )
      )
        .then((results) => {
          const failed = results.find((r) => r.error);
          if (failed) throw new Error(failed.error);
          // Same shrink-or-grow-to-fit reasoning as onAutoLayoutGroup's
          // own resize just below -- see its comment.
          const sizeById = new Map(directChildren.map((c) => [c.id, sizes.get(c.id)]));
          const leftEdges = [...placements.map((p) => p.x), ...lockedFootprints.map((f) => f.x)];
          const rightEdges = [
            ...placements.map((p) => p.x + sizeById.get(p.child.id).width),
            ...lockedFootprints.map((f) => f.x + f.width),
          ];
          const bottomEdges = [
            ...placements.map((p) => p.y - sizeById.get(p.child.id).height),
            ...lockedFootprints.map((f) => f.y - f.height),
          ];
          const topEdges = [...placements.map((p) => p.y), ...lockedFootprints.map((f) => f.y)];
          // Zero padding folded into the grid math (spec point 9 -- see
          // onContainerResize's own matching comment) -- rounded UP to a
          // whole SX/rowPitch cell in case a locked child's own old
          // position isn't currently exact (e.g. never touched since a
          // legacy load); every freshly-packed placement already lands
          // exactly on a cell, so this is a no-op for them.
          const { cellPitch: finalCellPitch, rowPitch: finalRowPitch } = derivePitches(cellUnit);
          const width = Math.ceil((Math.max(...rightEdges) - Math.min(...leftEdges)) / finalCellPitch) * finalCellPitch;
          const height = Math.ceil((Math.max(...topEdges) - Math.min(...bottomEdges)) / finalRowPitch) * finalRowPitch;
          return fetch(`${API_BASE}/api/update_position`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: groupId, x: groupBox.x, y: groupBox.y, width, height }),
          }).then((r) => r.json());
        })
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            return;
          }
          // computeFlowGroupLayout's own returned flips (see its own
          // comment) already reflect whichever grid it actually chose,
          // verified against the real layout score (layoutScore.js's
          // refineFlips) rather than recomputed here from scratch with
          // the plain "which side do my pools average out to" heuristic
          // -- recomputing it here instead would silently throw away
          // that verification and could re-introduce a flip the search
          // had already confirmed was worse.
          // Also tags the group itself with data.layoutMode: 'flow' -- see
          // onAutoLayoutGroup's own matching comment.
          setFlowGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) => {
              if (n.id === groupId) return { ...n, data: { ...n.data, layoutMode: 'flow' } };
              return flowFlips[n.id] !== undefined ? { ...n, data: { ...n.data, flipped: flowFlips[n.id] } } : n;
            }),
          }));
          setAutoLayoutUndoSnapshot(undoSnapshot);
          refreshGraphRef.current?.();
        })
        .catch((err) => setStatus(`error: ${err}`))
        .finally(() => setLayoutRunning(false));
    },
    [flowGraph.nodes, flowGraph.edges, scale, sx]
  );

  // Reverts whatever onAutoLayoutGroup/onAutoLayoutRecursive/
  // onAutoLayoutGroupByFlow/onAutoLayoutRecursiveFlow most recently applied, using
  // whichever one's pre-operation snapshot it captured -- restores each
  // touched node's
  // exact raw x/y (and width/height, for a
  // container) via the same /api/update_position endpoint the forward
  // operation used, then restores flips locally (frontend-only, see
  // onToggleFlip). A single undo, not a stack -- running this (or another
  // auto-layout) clears the snapshot, so there's nothing further back to
  // revert to.
  const onUndoLayout = useCallback(() => {
    if (!autoLayoutUndoSnapshot) return;
    Promise.all(
      autoLayoutUndoSnapshot.nodes.map((n) =>
        fetch(`${API_BASE}/api/update_position`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            n.isContainer ? { id: n.id, x: n.x, y: n.y, width: n.width, height: n.height } : { id: n.id, x: n.x, y: n.y }
          ),
        }).then((r) => r.json())
      )
    )
      .then((results) => {
        const failed = results.find((r) => r.error);
        if (failed) throw new Error(failed.error);
        const flipById = new Map(autoLayoutUndoSnapshot.nodes.map((n) => [n.id, n.flipped]));
        setFlowGraph((g) => ({
          ...g,
          nodes: g.nodes.map((n) => (flipById.get(n.id) !== undefined ? { ...n, data: { ...n.data, flipped: flipById.get(n.id) } } : n)),
        }));
        setAutoLayoutUndoSnapshot(null);
        refreshGraphRef.current?.();
      })
      .catch((err) => setStatus(`error: ${err}`));
  }, [autoLayoutUndoSnapshot]);

  // The recursive version of the same action -- see computeLocalLayouts/
  // assignAbsolutePositions' own block comment for why this needs two
  // passes rather than just calling onAutoLayoutGroup depth-first. Batches
  // every position/resize update from the *entire* subtree into two
  // Promise.all rounds (position, then resize, since a container's own
  // resize also carries its final position and would otherwise race a
  // plain position update for the same id) followed by one refreshGraph,
  // rather than one round trip per nesting level.
  const onAutoLayoutRecursive = useCallback(
    async (rootId) => {
      const rawNodes = flowGraph.nodes.map((n) => n.data);
      const rawById = {};
      rawNodes.forEach((n) => {
        rawById[n.id] = n;
      });
      const root = rawById[rootId];
      if (!root) return;

      setLayoutRunning(true);
      // computeLocalLayouts calls optimizeGroupLayout once per nested,
      // unlocked container in the subtree -- a fixed per-call time budget
      // that's perfectly reasonable for a single "Auto-layout direct
      // children" click (see layoutSeed.js's own SA_TIME_BUDGET_MS) adds
      // up fast across a model with dozens of groups, otherwise (verified
      // directly against a real ~36-group model: upward of 15 seconds, a
      // genuinely frozen tab, not just a slow click). A fixed OVERALL
      // budget for the whole recursive operation, divided across however
      // many containers this particular subtree actually has, keeps the
      // total bounded regardless of how deep or wide it is -- at the cost
      // of each individual level getting a shorter search than a
      // single-level click would.
      const RECURSIVE_TOTAL_BUDGET_MS = 4000;
      const containerCount =
        1 + rawNodes.filter((n) => CONTAINER_TYPES.includes(n.type) && !n.locked && isDescendantOf(n.id, rootId, rawById)).length;
      const perLevelBudgetMs = Math.max(80, Math.min(550, Math.floor(RECURSIVE_TOTAL_BUDGET_MS / containerCount)));

      const containerIndex = buildContainerIndex(rawNodes, rawById);
      const boxById = {};
      const localLayouts = {};
      let doneCount = 0;
      setLayoutProgress({ done: 0, total: containerCount });
      const onProgress = async () => {
        doneCount += 1;
        setLayoutProgress({ done: doneCount, total: containerCount });
        await yieldToBrowser();
      };
      await computeLocalLayouts(rootId, rawNodes, rawById, containerIndex, boxById, localLayouts, flowGraph.edges, perLevelBudgetMs, sx, onProgress);
      if (localLayouts[rootId].children.length === 0) {
        setLayoutRunning(false);
        setLayoutProgress(null);
        return;
      }

      // The root of this operation keeps its own current position --
      // only its *contents* are being rearranged, so there's nothing
      // above it in the tree to anchor a new position against; it does
      // still get resized to fit whatever its own subtree now needs.
      const rootBox = effectiveContainerBox(root, containerIndex, boxById, sx);
      const positionUpdates = [];
      const resizeUpdates = [
        { id: rootId, x: rootBox.x, y: rootBox.y, width: localLayouts[rootId].width, height: localLayouts[rootId].height },
      ];
      assignAbsolutePositions(rootId, rootBox.x, rootBox.y, rawById, localLayouts, positionUpdates, resizeUpdates);

      // Captured *before* anything is sent to the backend -- the raw
      // pre-operation values, straight from `rawById`, for every id
      // either update array is about to touch (a container ends up in
      // both -- deduplicated via the Set below). See onUndoLayout.
      const touchedIds = new Set([...positionUpdates.map((u) => u.id), ...resizeUpdates.map((u) => u.id)]);
      const undoSnapshot = {
        nodes: [...touchedIds].map((id) => {
          const n = rawById[id];
          return { id, x: n.x, y: n.y, width: n.width, height: n.height, flipped: n.flipped, isContainer: CONTAINER_TYPES.includes(n.type) };
        }),
      };

      const resizedIds = new Set(resizeUpdates.map((u) => u.id));
      Promise.all(
        positionUpdates
          .filter((u) => !resizedIds.has(u.id))
          .map((u) =>
            fetch(`${API_BASE}/api/update_position`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: u.id, x: u.x, y: u.y }),
            }).then((r) => r.json())
          )
      )
        .then((results) => {
          const failed = results.find((r) => r.error);
          if (failed) throw new Error(failed.error);
          return Promise.all(
            resizeUpdates.map((u) =>
              fetch(`${API_BASE}/api/update_position`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(u),
              }).then((r) => r.json())
            )
          );
        })
        .then((results) => {
          const failed = results.find((r) => r.error);
          if (failed) {
            setStatus(`error: ${failed.error}`);
            return;
          }
          // Re-evaluate flip (see computeFlipUpdates) for every reac/enz/
          // concchan this operation just repositioned, using each one's
          // connected pools' *final* absolute X -- freshly placed ones
          // from positionUpdates/resizeUpdates, everything else (a
          // neighbor outside this subtree, or a locked node) from its own
          // current position.
          const xById = {};
          rawNodes.forEach((n) => {
            xById[n.id] = n.x;
          });
          positionUpdates.forEach((u) => {
            xById[u.id] = u.x;
          });
          resizeUpdates.forEach((u) => {
            xById[u.id] = u.x;
          });
          const lockedIds = new Set(rawNodes.filter((n) => n.locked).map((n) => n.id));
          const candidateIds = positionUpdates.map((u) => u.id);
          const flips = computeFlipUpdates(candidateIds, rawById, flowGraph.edges, xById, lockedIds);
          // Every container this run actually repacked (root plus every
          // nested unlocked one -- resizedIds) is tagged 'square' -- see
          // onAutoLayoutGroup's own matching comment.
          setFlowGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) => {
              if (resizedIds.has(n.id)) return { ...n, data: { ...n.data, layoutMode: 'square' } };
              return flips[n.id] !== undefined ? { ...n, data: { ...n.data, flipped: flips[n.id] } } : n;
            }),
          }));
          setAutoLayoutUndoSnapshot(undoSnapshot);
          // Unlike the single-level layout actions above (which leave the
          // viewport alone -- see their own "deliberately not bumping"
          // comment), a RECURSIVE layout can move everything below the
          // selected group, often well outside whatever's currently in
          // view -- the user's own later request: auto Fit View afterward
          // so the result is actually visible without a manual re-fit.
          // Bumping loadGeneration only *after* the refreshed graph has
          // actually landed in flowGraph (chained here, not fired
          // alongside refreshGraphRef.current?.() the way every other
          // caller does) matters more than it would elsewhere: refetching
          // a big model (the exact case a slow recursive layout implies)
          // takes long enough that FitViewOnLoad's own nested-rAF wait
          // could otherwise fire *before* the new positions ever arrive,
          // fitting to whatever the view happened to still be showing
          // instead of the real result -- verified directly against a
          // 36-group synthetic model, where this raced and lost often
          // enough to reliably reproduce a fit that missed most of it.
          return refreshGraphRef.current?.().then(() => setLoadGeneration((g) => g + 1));
        })
        .catch((err) => setStatus(`error: ${err}`))
        .finally(() => {
          setLayoutRunning(false);
          setLayoutProgress(null);
        });
    },
    [flowGraph.nodes, flowGraph.edges, scale, sx]
  );

  // Recurse Flow -- see computeLocalFlowLayouts' own comment for the
  // three-part design (Flow at every nested level, refuse unless the
  // outermost level is all groups, a uniform square array for that
  // outermost level). No per-level time budget to divide up here (unlike
  // onAutoLayoutRecursive above) -- see computeLocalFlowLayouts' own
  // comment on why.
  const onAutoLayoutRecursiveFlow = useCallback(
    async (rootId) => {
      const rawNodes = flowGraph.nodes.map((n) => n.data);
      const rawById = {};
      rawNodes.forEach((n) => {
        rawById[n.id] = n;
      });
      const root = rawById[rootId];
      if (!root) return;

      // The user's own explicit stipulation: the outermost level has no
      // pool/non-pool split to alternate between, only because every one
      // of its own direct children is assumed to be a group itself --
      // refuse outright rather than silently guessing at a mixed level
      // (a plain pool/reaction sitting next to a nested group has no
      // sensible "square array" position among boxes it isn't the same
      // kind of thing as).
      const directChildren = rawNodes.filter(
        (n) => n.parentId === rootId && !(n.type === 'pool' && n.isEnzComplex)
      );
      if (directChildren.length === 0) return;
      if (directChildren.some((c) => !CONTAINER_TYPES.includes(c.type))) {
        setStatus('error: Recurse Flow requires every direct child of the selected group to be a group or compartment itself');
        return;
      }

      setLayoutRunning(true);
      const containerIndex = buildContainerIndex(rawNodes, rawById);
      const boxById = {};
      const localLayouts = {};
      const flipsOut = {};
      // Same progress convention as onAutoLayoutRecursive's own -- 1 (the
      // root) plus every unlocked descendant container, exactly matching
      // how many times computeLocalFlowLayouts' own recursion actually
      // invokes itself.
      const containerCount =
        1 + rawNodes.filter((n) => CONTAINER_TYPES.includes(n.type) && !n.locked && isDescendantOf(n.id, rootId, rawById)).length;
      let doneCount = 0;
      setLayoutProgress({ done: 0, total: containerCount });
      const onProgress = async () => {
        doneCount += 1;
        setLayoutProgress({ done: doneCount, total: containerCount });
        await yieldToBrowser();
      };
      await computeLocalFlowLayouts(rootId, rawNodes, rawById, containerIndex, boxById, localLayouts, flipsOut, flowGraph.edges, sx, true, onProgress);
      if (localLayouts[rootId].children.length === 0) {
        setLayoutRunning(false);
        setLayoutProgress(null);
        return;
      }

      const rootBox = effectiveContainerBox(root, containerIndex, boxById, sx);
      const positionUpdates = [];
      const resizeUpdates = [
        { id: rootId, x: rootBox.x, y: rootBox.y, width: localLayouts[rootId].width, height: localLayouts[rootId].height },
      ];
      assignAbsolutePositions(rootId, rootBox.x, rootBox.y, rawById, localLayouts, positionUpdates, resizeUpdates);

      const touchedIds = new Set([...positionUpdates.map((u) => u.id), ...resizeUpdates.map((u) => u.id)]);
      const undoSnapshot = {
        nodes: [...touchedIds].map((id) => {
          const n = rawById[id];
          return { id, x: n.x, y: n.y, width: n.width, height: n.height, flipped: n.flipped, isContainer: CONTAINER_TYPES.includes(n.type) };
        }),
      };

      const resizedIds = new Set(resizeUpdates.map((u) => u.id));
      Promise.all(
        positionUpdates
          .filter((u) => !resizedIds.has(u.id))
          .map((u) =>
            fetch(`${API_BASE}/api/update_position`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: u.id, x: u.x, y: u.y }),
            }).then((r) => r.json())
          )
      )
        .then((results) => {
          const failed = results.find((r) => r.error);
          if (failed) throw new Error(failed.error);
          return Promise.all(
            resizeUpdates.map((u) =>
              fetch(`${API_BASE}/api/update_position`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(u),
              }).then((r) => r.json())
            )
          );
        })
        .then((results) => {
          const failed = results.find((r) => r.error);
          if (failed) {
            setStatus(`error: ${failed.error}`);
            return;
          }
          // Each level's own VERIFIED flips (see computeLocalFlowLayouts'
          // own comment) are applied directly -- no need to re-derive
          // them afterward with the plain heuristic the way
          // onAutoLayoutRecursive above still does for Square.
          // Every NESTED container this run touched (resizedIds minus the
          // root itself) was packed with the plain pool/non-pool Flow grid
          // -- tagged 'flow' for the same snap-to-grid reason as
          // onAutoLayoutGroupByFlow's own matching comment. The root
          // itself used computeUniformFlowLayout's own uniform (no pool/
          // non-pool split) grid instead, which isn't either named mode --
          // left untagged, so a later manual drag there falls back to the
          // plan's own "no recorded mode" default (see buildFlowNodes'
          // comment) rather than mislabeling it.
          setFlowGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) => {
              if (n.id !== rootId && resizedIds.has(n.id)) return { ...n, data: { ...n.data, layoutMode: 'flow' } };
              return flipsOut[n.id] !== undefined ? { ...n, data: { ...n.data, flipped: flipsOut[n.id] } } : n;
            }),
          }));
          setAutoLayoutUndoSnapshot(undoSnapshot);
          // See onAutoLayoutRecursive's own matching comment just above.
          return refreshGraphRef.current?.().then(() => setLoadGeneration((g) => g + 1));
        })
        .catch((err) => setStatus(`error: ${err}`))
        .finally(() => {
          setLayoutRunning(false);
          setLayoutProgress(null);
        });
    },
    [flowGraph.nodes, flowGraph.edges, scale, sx]
  );

  // cellWidthPx/cellHeightPx: SX's own on-screen size (nodes.jsx's fixed
  // outer wrapper -- see the "Integer grid rebuild" plan), NOT scaled by
  // ScaleIcons -- only the icon CONTENT inside that wrapper scales.
  const nodeActions = useMemo(
    () => ({ onContainerResize, cellWidthPx: sx * scale, cellHeightPx: (sx / 2) * scale, iconScale: scaleIcons }),
    [onContainerResize, sx, scale, scaleIcons]
  );

  // {poolId: window} for every pool currently marked plotted -- plotWindow
  // is frontend-only state (see buildFlowNodes), so it has to be sent
  // along explicitly whenever saving, for the backend to persist as a
  // small custom annotation (SBML has no native "this is plotted" concept
  // -- confirmed directly that moose.writeSBML doesn't preserve the
  // legacy .g format's own /graphs plot tables at all).
  const plots = useMemo(() => {
    const result = {};
    flowGraph.nodes.forEach((n) => {
      if (n.type === 'pool' && n.data.plotWindow) result[n.id] = n.data.plotWindow;
    });
    return result;
  }, [flowGraph.nodes]);

  // Same reasoning as plots just above -- collapsed is frontend-only, sent
  // along explicitly on save for server.py's _inject_collapsed_annotations
  // to persist as its own small custom annotation. Every group/
  // compartment is included (not just the collapsed ones) so an
  // explicitly-expanded one still round-trips as expanded rather than
  // just being silently absent (harmless either way today, since
  // buildFlowNodes' own fallback is already false, but explicit is
  // cheap and avoids relying on that default staying false forever).
  const collapsedMap = useMemo(() => {
    const result = {};
    flowGraph.nodes.forEach((n) => {
      if (CONTAINER_TYPES.includes(n.data.type)) result[n.id] = !!n.data.collapsed;
    });
    return result;
  }, [flowGraph.nodes]);

  const nodeTypeById = useMemo(() => {
    const map = {};
    flowGraph.nodes.forEach((n) => {
      map[n.id] = n.type;
    });
    return map;
  }, [flowGraph.nodes]);

  const isValidConnection = useCallback(
    (conn) => edgeTypeForConnection(conn, nodeTypeById) !== null,
    [nodeTypeById]
  );

  const onConnect = useCallback(
    (conn) => {
      const edgeType = edgeTypeForConnection(conn, nodeTypeById);
      if (!edgeType) return;
      // add_edge's own funcInput handling needs to know whether to auto-
      // maintain the target's expr as a plain sum (a 'func' node) or leave
      // a user-authored one alone (a 'genfunc' node) -- see its own
      // comment; moose itself can't tell the two apart at connect time.
      const kind = edgeType === 'funcInput' ? (nodeTypeById[conn.target] === 'genfunc' ? 'general' : 'sum') : undefined;
      fetch(`${API_BASE}/api/add_edge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: conn.source, to: conn.target, type: edgeType, kind }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            return;
          }
          setFlowGraph((g) => {
            // Connecting an already-connected pair again is kkit's way of
            // expressing stoichiometry > 1 (see add_edge) -- bump the
            // existing edge's count rather than drawing a second, fully
            // overlapping edge on top of it.
            const existing = g.edges.find(
              (e) => e.source === conn.source && e.target === conn.target && e.data.type === edgeType
            );
            const nodes = mergeFuncUpdate(mergeReacUpdate(g.nodes, res.reacUpdate), res.funcUpdate);
            if (existing) {
              return {
                nodes,
                edges: g.edges.map((e) =>
                  e.id === existing.id ? { ...e, data: { ...e.data, stoich: res.stoich } } : e
                ),
              };
            }
            return {
              nodes,
              edges: [...g.edges, toEdge(conn.source, conn.target, edgeType, g.edges.length, res.stoich)],
            };
          });
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [nodeTypeById]
  );

  const onEdgesChange = useCallback(
    (changes) => {
      // A 'remove' change on a stoichiometry > 1 edge decrements it instead
      // of deleting the edge outright -- remove_edge only ever deletes one
      // underlying message per call, matching "one drag = one message,
      // click+delete removes one at a time" -- so that change is excluded
      // from what reaches applyEdgeChanges, and the edge's count is updated
      // once the backend confirms how many messages are left.
      const passThrough = [];
      changes.forEach((change) => {
        if (change.type !== 'remove') {
          passThrough.push(change);
          return;
        }
        const edge = flowGraph.edges.find((e) => e.id === change.id);
        if (!edge) {
          passThrough.push(change);
          return;
        }
        const decrementOnly = (edge.data.stoich ?? 1) > 1;
        if (!decrementOnly) passThrough.push(change);

        // remove_edge's own funcInput branch needs the same 'sum'/
        // 'general' distinction add_edge's does -- see its own comment.
        const kind =
          edge.data.type === 'funcInput'
            ? nodeTypeById[edge.target] === 'genfunc'
              ? 'general'
              : 'sum'
            : undefined;
        fetch(`${API_BASE}/api/remove_edge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: edge.source, to: edge.target, type: edge.data.type, kind }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res.error) {
              setStatus(`error: ${res.error}`);
              return;
            }
            setFlowGraph((g) => ({
              nodes: mergeFuncUpdate(mergeReacUpdate(g.nodes, res.reacUpdate), res.funcUpdate),
              edges: decrementOnly
                ? g.edges.map((e) =>
                    e.id === edge.id ? { ...e, data: { ...e.data, stoich: res.stoich } } : e
                  )
                : g.edges,
            }));
          })
          .catch((err) => setStatus(`error: ${err}`));
      });
      setFlowGraph((g) => ({ ...g, edges: applyEdgeChanges(passThrough, g.edges) }));
    },
    [flowGraph.edges, nodeTypeById]
  );

  const selectEdge = useCallback((edgeId) => {
    setFlowGraph((g) => ({
      ...g,
      edges: g.edges.map((e) => ({ ...e, selected: e.id === edgeId })),
    }));
  }, []);

  const moveEdgeVia = useCallback((edgeId, pos) => {
    // A synthetic aggregate edge (both endpoints collapsed -- see
    // collapseView.js) isn't in flowGraph.edges at all, so the normal path
    // below would be a silent no-op for it (nothing in the map matches its
    // id); its bend point lives in the separate aggregateVia map instead,
    // reapplied by displayGraph on every render.
    if (edgeId.startsWith('aggregate-')) {
      setAggregateVia((m) => ({ ...m, [edgeId]: pos }));
      return;
    }
    setFlowGraph((g) => ({
      ...g,
      edges: g.edges.map((e) => (e.id === edgeId ? { ...e, data: { ...e.data, via: pos } } : e)),
    }));
  }, []);

  const edgeActions = useMemo(() => ({ selectEdge, moveEdgeVia }), [selectEdge, moveEdgeVia]);

  const onSaveNode = useCallback(
    (nodeId, fields) => {
      const node = flowGraph.nodes.find((n) => n.id === nodeId);
      // `flipped` is frontend-only (not tracked by the backend/MOOSE), so
      // it's stripped before the request and reattached from what was
      // submitted -- otherwise the backend's response (which doesn't know
      // about it) would wipe it out when merged into node data. Defaults to
      // the node's own current value when the caller didn't include it at
      // all -- true for the live per-field saves (color on click, name on
      // blur) that don't go through the full Properties form, which would
      // otherwise blank out an existing flip on every such save.
      // parentSide (like flipped) is frontend-only -- same reasoning,
      // same treatment, so a Save (or the dirty-field-flush this panel's
      // own unmount effect triggers whenever ANY field, including this
      // one, is touched) doesn't wipe out a manual vertical-flip toggle
      // the moment it's set.
      const { flipped = node.data.flipped, parentSide = node.data.parentSide, ...backendFields } = fields;
      const endpoint = EDITABLE_ENDPOINTS[node.data.type];
      const body = { id: nodeId, fields: backendFields };
      // A Stimulus's (or summation Function's -- same underlying MOOSE
      // Function, same expr field) Save is gated on a negative-value
      // check run against the Run panel's *current* runtime (see
      // server.py's _check_stim_expr) -- sent along here rather than
      // baked in at creation time, so editing later always checks
      // against whatever duration is actually configured now.
      if (node.data.type === 'stim' || node.data.type === 'func') body.runtime = parseFloat(runtime) || 1;
      fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .then((updated) => {
          if (updated.error) {
            setStatus(`error: ${updated.error}`);
            // The Properties panel doesn't stay visible if the user
            // switches menus, so a rejected Stimulus/Function save (most
            // notably the negative-value check) needs a popup, not just
            // the easy-to-miss status line -- Save simply does nothing
            // else and the user's typed expression stays in the box to
            // fix.
            if (node.data.type === 'stim' || node.data.type === 'func' || node.data.type === 'genfunc') window.alert(updated.error);
            return;
          }
          // Renaming an object changes its MOOSE path, which is what we use
          // as the node id -- when that happens, every reference to the old
          // id (the node itself, any edges, and the current selection) has
          // to be repointed at the new one.
          const renamed = updated.previousId && updated.previousId !== updated.id;
          // An explicit-complex enzyme's own path is likewise a prefix of
          // its hidden complex pool's path (same "child in the MOOSE
          // hierarchy" reasoning as a group/compartment, just one level
          // deep instead of arbitrarily many) -- its own stashed
          // complexPoolId (see buildFlowNodes) would otherwise go stale
          // the moment the enzyme is renamed, silently breaking its own
          // plot badge/drop target until some *other* edit happened to
          // trigger a full refresh (verified directly).
          if (renamed && (node.data.type === 'group' || node.data.type === 'compartment' || node.data.type === 'enz')) {
            // A group/compartment's own path is a *prefix* of every
            // descendant's path (that's what "children in the MOOSE
            // hierarchy" means) -- renaming it silently changes every
            // descendant's id and parentId too, not just this node's own
            // id. Recomputing that cascade correctly on the frontend would
            // mean replicating MOOSE's own path-string quirks; a full
            // refetch just gets the already-correct new ids from the
            // backend directly instead.
            refreshGraphRef.current?.();
            if (selectedNodeId === nodeId) setSelectedNodeId(updated.id);
            return;
          }
          // A pool's own displayed color is often only a client-side
          // RAINBOW_16 assignment (see buildFlowNodes/addNodeToGraph) that
          // was never actually saved to the backend -- so a save that
          // isn't itself about color (a rename, say) gets back whatever
          // color the backend actually has stored (its unset "white"
          // default), which would otherwise silently clobber the color
          // actually on screen. Only trust the response's color when this
          // save explicitly included it.
          const color = 'color' in backendFields ? updated.color : node.data.color;
          // plotWindow (like flipped/color) is frontend-only -- the
          // backend response never carries it, so it has to be carried
          // forward explicitly or a rename silently drops the pool's plot
          // tag.
          const plotWindow = node.data.plotWindow;
          // collapsed is the same story, for a group/compartment -- the
          // live model has nowhere to store it (see moose_graph.
          // describe_group's own docstring), so describe_group/
          // describe_compartment's response always reports collapsed:
          // false, which would otherwise silently re-expand every
          // container on its very next Properties save.
          const collapsed = node.data.collapsed;
          setFlowGraph((g) => ({
            nodes: g.nodes.map((n) =>
              n.id === nodeId
                ? { ...n, id: updated.id, data: { ...updated, color, flipped, parentSide, plotWindow, collapsed } }
                : n
            ),
            edges: renamed
              ? g.edges.map((e) => ({
                  ...e,
                  source: e.source === nodeId ? updated.id : e.source,
                  target: e.target === nodeId ? updated.id : e.target,
                }))
              : g.edges,
          }));
          if (renamed && selectedNodeId === nodeId) {
            setSelectedNodeId(updated.id);
          }
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [flowGraph.nodes, selectedNodeId, runtime]
  );

  // Re-fetches the whole graph rather than patching state locally -- used
  // after operations whose effect on the node/edge set isn't a single known
  // delta (creating an enzyme also creates a hidden complex pool; deleting a
  // pool cascades to remove its enzyme children in MOOSE). Frontend-only
  // state (flipped/color/plotWindow) is preserved by id rather than
  // recomputed. Deliberately does NOT recompute scale (unlike the initial
  // load/reset path) -- rescaling here would shift every node's pixel
  // position out from under the user mid-edit, reading as the view jumping
  // around for no reason; keeps the current scale, same as drag/single-add.
  const refreshGraph = useCallback(() => {
    // Returns the fetch's own promise -- most callers just fire-and-forget
    // this (fine, `flowGraph` updates whenever it updates), but a couple
    // (see onAutoLayoutRecursive/onAutoLayoutRecursiveFlow) need to know
    // once the refreshed graph has actually landed in state before doing
    // anything that depends on it.
    return fetch(`${API_BASE}/api/graph`)
      .then((r) => r.json())
      .then((graph) => {
        if (graph.error) {
          setStatus(`error: ${graph.error}`);
          return;
        }
        setFlowGraph((g) => {
          const existingFlipped = {};
          const existingColor = {};
          const existingPlotWindow = {};
          const existingCollapsed = {};
          const existingLocked = {};
          const existingParentSide = {};
          const existingLayoutMode = {};
          g.nodes.forEach((n) => {
            existingFlipped[n.id] = n.data.flipped;
            existingLocked[n.id] = n.data.locked;
            if (n.type === 'enz' || n.type === 'concchan') {
              existingParentSide[n.id] = n.data.parentSide;
            }
            if (n.type === 'pool') {
              existingColor[n.id] = n.data.color;
              existingPlotWindow[n.id] = n.data.plotWindow;
            }
            if (CONTAINER_TYPES.includes(n.data.type)) {
              existingCollapsed[n.id] = n.data.collapsed;
              existingLayoutMode[n.id] = n.data.layoutMode;
            }
          });
          return buildFlowNodes(graph, scale, sx, {
            flipped: existingFlipped,
            color: existingColor,
            plotWindow: existingPlotWindow,
            collapsed: existingCollapsed,
            locked: existingLocked,
            parentSide: existingParentSide,
            layoutMode: existingLayoutMode,
          });
        });
      })
      .catch((err) => setStatus(`error: ${err}`));
  }, [scale, sx]);
  refreshGraphRef.current = refreshGraph;

  const addNodeToGraph = useCallback((nodeData) => {
    setFlowGraph((g) => {
      const color =
        nodeData.type === 'pool'
          ? RAINBOW_16[g.nodes.filter((n) => n.type === 'pool').length % 16]
          : nodeData.color;
      return {
        ...g,
        nodes: [
          ...g.nodes,
          {
            id: nodeData.id,
            type: nodeData.type,
            position: { x: nodeData.x * scale, y: -nodeData.y * scale },
            data: { ...nodeData, color, flipped: false, plotWindow: null },
          },
        ],
      };
    });
    setSelectedNodeId(nodeData.id);
    setActiveMenu('Properties');
  }, [scale]);

  // `flipped` is frontend-only (see onSaveNode), so it applies immediately
  // on toggle rather than waiting for the properties panel's Save button --
  // there's no backend round-trip for it to wait on.
  const onToggleFlip = useCallback((nodeId, flipped) => {
    setFlowGraph((g) => ({
      ...g,
      // A manual flip toggle counts as "manually oriented" -- see
      // data.locked's own comment -- so auto-layout's own flip pass
      // (computeFlipUpdates) leaves this node's orientation alone from
      // here on, the same way a manual drag protects its position.
      nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, flipped, locked: true } } : n)),
    }));
  }, []);

  // The user's own later request: a manual override for which edge (top
  // or bottom) an enz/concchan's own structural parent-link handle
  // renders on -- `data.parentSide` (nodes.jsx's EnzNode/ConcChanNode)
  // otherwise only ever gets computeInitialParentSides' own one-time
  // automatic guess (see buildFlowNodes), with no way back once that
  // guess is wrong for how the user actually wants it to read. Frontend-
  // only, same as `flipped` itself -- not sent to the backend, just
  // preserved by id across a refresh (see buildFlowNodes' own `preserve`
  // handling).
  const onToggleParentSide = useCallback((nodeId, parentSide) => {
    setFlowGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, parentSide, locked: true } } : n)),
    }));
  }, []);

  // Clears data.locked across a whole subtree (the container this was
  // invoked on, plus every descendant) -- the escape hatch for "no, I
  // really do want auto-layout to touch everything here again", since
  // there's otherwise no way back from a manual edit's own automatic lock
  // once it's served its purpose. Frontend-only, same as the flag itself
  // (see onToggleFlip/onNodeDragStop/onContainerResize) -- nothing to
  // persist, just an immediate local update.
  const onClearLayoutLocks = useCallback((rootId) => {
    setFlowGraph((g) => {
      const byId = {};
      g.nodes.forEach((n) => {
        byId[n.id] = n;
      });
      const isInScope = (id) => {
        let cur = byId[id];
        while (cur) {
          if (cur.id === rootId) return true;
          cur = cur.parentId ? byId[cur.parentId] : null;
        }
        return false;
      };
      return {
        ...g,
        nodes: g.nodes.map((n) => (n.data.locked && isInScope(n.id) ? { ...n, data: { ...n.data, locked: false } } : n)),
      };
    });
  }, []);

  // The user's own later request: a "Snap to grid" button for a group
  // that pulls every direct child onto the stable lattice exactly where
  // it already sits -- unlike Square/Flow, this never reorders or
  // repacks anything, it just
  // moves each child independently to its own nearest grid cell, the same
  // computation a manual drag-snap already does for one node at a time.
  // Meant as the retroactive fix for a group whose children drifted off
  // the lattice before this session's origin-stability fix existed (or
  // after a manual edit with snap-to-grid turned off) -- not a substitute
  // for Square/Flow, which is still how you'd want a genuinely fresh
  // arrangement. Leaves `locked` exactly as each child already had it --
  // this is a one-off correction, not a request to pin everything in
  // place the way a manual drag does.
  const onSnapGroupToGrid = useCallback(
    (groupId) => {
      const rawNodes = flowGraph.nodes.map((n) => n.data);
      const rawById = {};
      rawNodes.forEach((n) => {
        rawById[n.id] = n;
      });
      const group = rawById[groupId];
      if (!group) return;
      const directChildren = rawNodes.filter(
        (n) => n.parentId === groupId && !(n.type === 'pool' && n.isEnzComplex)
      );
      if (directChildren.length === 0) return;
      const containerIndex = buildContainerIndex(rawNodes, rawById);
      const boxById = {};
      const cellUnit = sx;
      const groupBox = effectiveContainerBox(group, containerIndex, boxById, cellUnit);
      const { cellPitch, rowPitch } = derivePitches(cellUnit);
      const originX = groupBox.x;
      const originY = groupBox.y;
      const useOffset = (group.layoutMode ?? 'flow') !== 'square';
      const numCols = Math.max(1, Math.round(groupBox.width / cellPitch));
      const numRows = Math.max(1, Math.round(groupBox.height / rowPitch));

      // One shared occupied-cell set, keyed per category, built up as
      // each child is assigned -- so two children that happen to compute
      // the SAME nearest cell (the common case this button exists for is
      // everything already distinct, but nothing guarantees it) land on
      // two different cells instead of both landing on one (see
      // findFreeGridCell's own comment).
      const occupiedByCategory = { pool: new Set(), nonpool: new Set() };
      const updates = directChildren.map((child) => {
        const footprint = childFootprint(child, containerIndex, boxById, cellUnit);
        const category = categoryOf(child.id, rawById);
        let { row, col } = nearestGridCell(child.x - originX, child.y - originY, category, cellPitch, rowPitch, useOffset);
        ({ row, col } = findFreeGridCell(row, col, cellPitch, rowPitch, occupiedByCategory[category]));
        const wide = footprint.width > cellPitch * 1.5;
        ({ row, col } = clampCellToBounds(row, col, category, wide, numRows, numCols));
        occupiedByCategory[category].add(`${row},${col}`);
        const shift = useOffset && Math.abs(row % 2) === 1 ? cellPitch / 2 : 0;
        return { id: child.id, x: originX + shift + col * cellPitch, y: originY - row * rowPitch };
      });

      setLayoutRunning(true);
      Promise.all(
        updates.map((u) =>
          fetch(`${API_BASE}/api/update_position`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: u.id, x: u.x, y: u.y }),
          }).then((r) => r.json())
        )
      )
        .then((results) => {
          const failed = results.find((r) => r.error);
          if (failed) {
            setStatus(`error: ${failed.error}`);
            return;
          }
          const updateById = new Map(updates.map((u) => [u.id, u]));
          setFlowGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) => {
              const u = updateById.get(n.id);
              if (!u) return n;
              const parentBox = n.parentId ? effectiveContainerBox(rawById[n.parentId], containerIndex, boxById, cellUnit) : null;
              const relX = parentBox ? u.x - parentBox.x : u.x;
              const relY = parentBox ? u.y - parentBox.y : u.y;
              return { ...n, position: { x: relX * scale, y: -relY * scale }, data: { ...n.data, x: u.x, y: u.y } };
            }),
          }));
        })
        .catch((err) => setStatus(`error: ${err}`))
        .finally(() => setLayoutRunning(false));
    },
    [flowGraph.nodes, scale, sx]
  );

  // Same reasoning as onToggleFlip -- collapsed is frontend-only (see
  // buildFlowNodes/computeCollapsedView), so it applies immediately.
  // node.style is deliberately left untouched here -- a collapsed
  // container keeps its own real on-screen box (see buildFlowNodes'
  // own comment), only its *contents* stop rendering, which
  // computeCollapsedView already handles purely off data.collapsed.
  const onToggleCollapse = useCallback((nodeId, collapsed) => {
    setFlowGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, collapsed } } : n)),
    }));
  }, []);

  // Bulk-sets every group/compartment's own collapsed flag at once -- a
  // one-time action, not a separate overriding mode, so each group's own
  // toggle (Properties, or this same action run again later) remains
  // independently adjustable afterward.
  //
  // Collapse All deliberately leaves each model's own top-level
  // container(s) (no parentId -- e.g. the ever-present "kinetics"
  // compartment) expanded: collapsing it too would hide *everything*
  // inside it, icons and all, since computeCollapsedView resolves every
  // descendant to its *outermost* collapsed ancestor -- there'd be nothing
  // left on screen but that one root icon. Leaving the root expanded means
  // its direct-child groups still collapse down to visible icons, which is
  // the actual point of the action. Expand All has no such carve-out --
  // every container (root included) goes back to fully expanded.
  const onSetAllCollapsed = useCallback((collapsed) => {
    setFlowGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => {
        if (!CONTAINER_TYPES.includes(n.data.type)) return n;
        if (collapsed && !n.parentId) return n;
        return { ...n, data: { ...n.data, collapsed } };
      }),
    }));
  }, []);

  const creationCounter = useRef(0);

  // x/y default to a spread-out placeholder spot (the old click-to-add
  // behavior) when not given -- drag-and-drop passes the actual drop
  // position instead. When placed inside a group/compartment (parentId
  // set), the fast local addNodeToGraph path is skipped in favor of a full
  // refreshGraph -- computing that container's own effective on-screen box
  // (see effectiveContainerBox) is exactly what buildFlowNodes already does
  // for a full graph, and duplicating it here for a single new node isn't
  // worth the risk of the two falling out of sync.
  const handleAddPool = useCallback(
    (x, y, parentId) => {
      const n = ++creationCounter.current;
      fetch(`${API_BASE}/api/create_pool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `pool${n}`, x: x ?? n * 1.5, y: y ?? -2, parentId }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            return;
          }
          if (parentId) {
            refreshGraph();
            setSelectedNodeId(res.id);
            setActiveMenu('Properties');
          } else {
            addNodeToGraph(res);
          }
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [addNodeToGraph, refreshGraph]
  );

  const handleAddReac = useCallback(
    (x, y, parentId) => {
      const n = ++creationCounter.current;
      fetch(`${API_BASE}/api/create_reac`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `reac${n}`, x: x ?? n * 1.5, y: y ?? -3, parentId }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            return;
          }
          if (parentId) {
            refreshGraph();
            setSelectedNodeId(res.id);
            setActiveMenu('Properties');
          } else {
            addNodeToGraph(res);
          }
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [addNodeToGraph, refreshGraph]
  );

  // Always routed through refreshGraph (never the fast addNodeToGraph path)
  // -- a group/compartment is itself a container, and its own rendering
  // needs the same effective-box computation buildFlowNodes already does.
  const handleAddGroup = useCallback(
    (x, y, parentId) => {
      const n = ++creationCounter.current;
      fetch(`${API_BASE}/api/create_group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `group${n}`, x, y, parentId }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            return;
          }
          refreshGraph();
          setSelectedNodeId(res.id);
          setActiveMenu('Properties');
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [refreshGraph]
  );

  // Compartments never nest, so unlike groups this never takes a parentId.
  const handleAddCompartment = useCallback(
    (x, y) => {
      const n = ++creationCounter.current;
      fetch(`${API_BASE}/api/create_compartment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `compartment${n}`, x, y }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            return;
          }
          refreshGraph();
          setSelectedNodeId(res.id);
          setActiveMenu('Properties');
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [refreshGraph]
  );

  // Shared by the click-to-add flow (parent = whatever's selected) and the
  // drag-and-drop flow (parent = whatever pool the enzyme icon landed on).
  // Position is always computed from the parent pool -- two pool-heights
  // directly above it -- rather than from wherever the icon was actually
  // dropped, so the result is consistent regardless of exactly where on the
  // pool you land.
  const createEnzOnPool = useCallback(
    (poolNode) => {
      const n = ++creationCounter.current;
      const x = poolNode.data.x;
      const y = poolNode.data.y + (2 * POOL_HEIGHT_PX) / scale;
      fetch(`${API_BASE}/api/create_enz`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPoolId: poolNode.id, name: `enz${n}`, x, y }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            return;
          }
          refreshGraph();
          setSelectedNodeId(res.id);
          setActiveMenu('Properties');
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [refreshGraph, scale]
  );

  const handleAddEnz = useCallback(() => {
    if (!selectedNode || selectedNode.type !== 'pool' || selectedNode.data.isEnzComplex) {
      setStatus('select a (non-complex) pool first to attach an enzyme to it');
      return;
    }
    createEnzOnPool(selectedNode);
  }, [selectedNode, createEnzOnPool]);

  // A ConcChan is created with defaults (permeability only) attached to its
  // parent pool -- its in/out exchange partners are wired afterward via
  // ordinary drag-to-connect (see edgeTypeForConnection's chanIn/chanOut
  // rules), not collectible from a single drop.
  const createConcChanOnPool = useCallback(
    (poolNode) => {
      const n = ++creationCounter.current;
      const x = poolNode.data.x;
      const y = poolNode.data.y + (2 * POOL_HEIGHT_PX) / scale;
      fetch(`${API_BASE}/api/create_concchan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentPoolId: poolNode.id, name: `pore${n}`, x, y }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            return;
          }
          refreshGraph();
          setSelectedNodeId(res.id);
          setActiveMenu('Properties');
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [refreshGraph, scale]
  );

  // A Stimulus is created immediately wired to the pool it's dropped on
  // (conc/concInit auto-picked from that pool's own isBuffered flag, see
  // create_stim) -- its target isn't re-connectable afterward, same as an
  // enzyme's structural parent link. Starts with a harmless "0" expression
  // so creation itself never trips the negative-value check; the user
  // edits it via Properties afterward.
  const createStimOnPool = useCallback(
    (poolNode) => {
      const n = ++creationCounter.current;
      const x = poolNode.data.x;
      const y = poolNode.data.y + (2 * POOL_HEIGHT_PX) / scale;
      fetch(`${API_BASE}/api/create_stim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetId: poolNode.id,
          expr: '0',
          runtime: parseFloat(runtime) || 1,
          name: `stim${n}`,
          x,
          y,
        }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            window.alert(res.error);
            return;
          }
          refreshGraph();
          setSelectedNodeId(res.id);
          setActiveMenu('Properties');
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [refreshGraph, scale, runtime]
  );

  // A summation function is created immediately wired to the pool it's
  // dropped on (same conc/concInit auto-pick as createStimOnPool), but
  // with zero pool inputs of its own yet -- the user wires those
  // afterward by dragging a connection from another pool onto its own
  // input handle (see edgeTypeForConnection/onConnect's own 'funcInput'
  // handling), which is also what actually gives it a real expr (see
  // create_sumfunc's own comment).
  const createSumFuncOnPool = useCallback(
    (poolNode) => {
      const n = ++creationCounter.current;
      const x = poolNode.data.x;
      const y = poolNode.data.y + (2 * POOL_HEIGHT_PX) / scale;
      fetch(`${API_BASE}/api/create_sumfunc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: poolNode.id, name: `sum${n}`, x, y }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            window.alert(res.error);
            return;
          }
          refreshGraph();
          setSelectedNodeId(res.id);
          setActiveMenu('Properties');
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [refreshGraph, scale]
  );

  // A general function is created with a default 2-slot capacity (see
  // create_genfunc/PropertiesMenuBox's own numInputs field) and a
  // harmless "0" placeholder expr -- the user wires its inputs the same
  // way createSumFuncOnPool's own do, then edits both numInputs and expr
  // via Properties.
  const createGenFuncOnPool = useCallback(
    (poolNode) => {
      const n = ++creationCounter.current;
      const x = poolNode.data.x;
      const y = poolNode.data.y + (2 * POOL_HEIGHT_PX) / scale;
      fetch(`${API_BASE}/api/create_genfunc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: poolNode.id, numInputs: 2, name: `func${n}`, x, y }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            window.alert(res.error);
            return;
          }
          refreshGraph();
          setSelectedNodeId(res.id);
          setActiveMenu('Properties');
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [refreshGraph, scale]
  );

  // Drop target for the Add menu's drag-and-drop icons -- position arrives
  // in on-screen flow-pixel space (from React Flow's screenToFlowPosition),
  // so it's converted back to kkit layout units the same way toFlowGraph's
  // own transform is inverted (x/scale, and y negated back).
  const handleCanvasDrop = useCallback(
    (type, flowPosition, hitNodeId) => {
      const kx = flowPosition.x / scale;
      const ky = -flowPosition.y / scale;
      if (type === 'pool' || type === 'reac') {
        const parentId = findContainerAt(kx, ky, flowGraph.nodes, sx);
        // Snap a freshly-dropped pool/reaction into the same grid a
        // manual drag already snaps to -- the user's own later request.
        let dropX = kx;
        let dropY = ky;
        if (snapToGrid && parentId) {
          const rawNodes = flowGraph.nodes.map((n) => n.data);
          const rawById = {};
          rawNodes.forEach((n) => {
            rawById[n.id] = n;
          });
          const containerIndex = buildContainerIndex(rawNodes, rawById);
          const boxById = {};
          const cellUnit = sx;
          const footprint = childFootprint({ type, name: '' }, containerIndex, boxById, cellUnit);
          const snapped = snapPointToGrid(
            kx,
            ky,
            rawById[parentId],
            rawById,
            containerIndex,
            boxById,
            cellUnit,
            type === 'pool' ? 'pool' : 'nonpool',
            footprint
          );
          dropX = snapped.x;
          dropY = snapped.y;
        }
        if (type === 'pool') handleAddPool(dropX, dropY, parentId);
        else handleAddReac(dropX, dropY, parentId);
      } else if (type === 'group') {
        const parentId = findContainerAt(kx, ky, flowGraph.nodes, sx);
        if (!parentId) {
          showWarning('Drop the group icon inside an existing compartment (or group).');
          return;
        }
        handleAddGroup(kx, ky, parentId);
      } else if (type === 'compartment') {
        // Compartments never nest -- no container hit-test needed.
        handleAddCompartment(kx, ky);
      } else if (type === 'enz') {
        const hitNode = flowGraph.nodes.find((n) => n.id === hitNodeId);
        if (!hitNode || hitNode.type !== 'pool') {
          showWarning('Drop the enzyme icon onto an existing pool.');
          return;
        }
        if (hitNode.data.isEnzComplex) {
          showWarning("An enzyme's complex pool can't be connected to anything.");
          return;
        }
        createEnzOnPool(hitNode);
      } else if (type === 'concchan') {
        const hitNode = flowGraph.nodes.find((n) => n.id === hitNodeId);
        if (!hitNode || hitNode.type !== 'pool') {
          showWarning('Drop the ConcChan icon onto an existing pool.');
          return;
        }
        if (hitNode.data.isEnzComplex) {
          showWarning("An enzyme's complex pool can't be connected to anything.");
          return;
        }
        createConcChanOnPool(hitNode);
      } else if (type === 'stim') {
        const hitNode = flowGraph.nodes.find((n) => n.id === hitNodeId);
        if (!hitNode || hitNode.type !== 'pool') {
          showWarning('Drop the Stimulus icon onto an existing pool.');
          return;
        }
        if (hitNode.data.isEnzComplex) {
          showWarning("An enzyme's complex pool can't be connected to anything.");
          return;
        }
        createStimOnPool(hitNode);
      } else if (type === 'sumfunc') {
        const hitNode = flowGraph.nodes.find((n) => n.id === hitNodeId);
        if (!hitNode || hitNode.type !== 'pool') {
          showWarning('Drop the summation function icon onto an existing pool.');
          return;
        }
        if (hitNode.data.isEnzComplex) {
          showWarning("An enzyme's complex pool can't be connected to anything.");
          return;
        }
        createSumFuncOnPool(hitNode);
      } else if (type === 'genfunc') {
        const hitNode = flowGraph.nodes.find((n) => n.id === hitNodeId);
        if (!hitNode || hitNode.type !== 'pool') {
          showWarning('Drop the general function icon onto an existing pool.');
          return;
        }
        if (hitNode.data.isEnzComplex) {
          showWarning("An enzyme's complex pool can't be connected to anything.");
          return;
        }
        createGenFuncOnPool(hitNode);
      } else if (type === 'plot1' || type === 'plot2') {
        const window = type === 'plot1' ? 1 : 2;
        const hitNode = flowGraph.nodes.find((n) => n.id === hitNodeId);
        // Dropped onto an enzyme -- plots its own hidden complex pool's
        // conc (never itself a droppable canvas node, see buildFlowNodes/
        // canvasGraph), which is what "plot this enzyme" can only sensibly
        // mean now that the complex pool isn't shown as its own icon.
        const targetPoolId = hitNode?.type === 'enz' ? hitNode.data.complexPoolId : hitNode?.id;
        if (!hitNode || (hitNode.type !== 'pool' && hitNode.type !== 'enz') || !targetPoolId) {
          showWarning('Drop the plot icon onto a pool (or an enzyme, to plot its complex) to plot it.');
          return;
        }
        // Purely a frontend marker (like flipped/color) -- toggled so
        // dropping the same window's icon on an already-assigned pool
        // un-plots it; dropping the other window's icon reassigns it. The
        // enzyme's own complexPlotWindow is kept in lockstep with its
        // complex pool's real plotWindow here (its own copy, since
        // EnzNode only ever sees its own data, not the full node list) --
        // buildFlowNodes re-derives the same pairing fresh on every full
        // reload/refresh regardless, this is just what keeps the plot
        // badge's on-canvas state correct *before* the next one of those.
        setFlowGraph((g) => {
          const newWindow = g.nodes.find((n) => n.id === targetPoolId)?.data.plotWindow === window ? null : window;
          return {
            ...g,
            nodes: g.nodes.map((n) => {
              if (n.id === targetPoolId) return { ...n, data: { ...n.data, plotWindow: newWindow } };
              if (n.id === hitNode.id && n.data.type === 'enz') return { ...n, data: { ...n.data, complexPlotWindow: newWindow } };
              return n;
            }),
          };
        });
      }
    },
    [
      scale,
      flowGraph.nodes,
      handleAddPool,
      handleAddReac,
      handleAddGroup,
      handleAddCompartment,
      createEnzOnPool,
      createConcChanOnPool,
      createStimOnPool,
      createSumFuncOnPool,
      createGenFuncOnPool,
      showWarning,
      snapToGrid,
      sx,
    ]
  );

  // Un-plotting by dragging the on-canvas plot badge to the trash icon --
  // that badge is a plain DOM element (not a React Flow node, see
  // nodes.jsx's PoolNode), so it uses native HTML5 drag-and-drop rather
  // than React Flow's own onNodeDragStop hit-test.
  const handleUnplot = useCallback((poolId) => {
    setFlowGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => {
        if (n.id === poolId) return { ...n, data: { ...n.data, plotWindow: null } };
        // An enz complex pool's own badge is dragged from its *enzyme*'s
        // rendered position (see nodes.jsx's EnzNode), but carries the
        // complex pool's real id as its drag payload -- the enzyme's own
        // cached complexPlotWindow needs the same clearing the pool's real
        // plotWindow just got, above, or the badge would keep showing.
        if (n.data.type === 'enz' && n.data.complexPoolId === poolId) {
          return { ...n, data: { ...n.data, complexPlotWindow: null } };
        }
        return n;
      }),
    }));
  }, []);

  const handleStartRun = useCallback((runtime, plotDt) => {
    setIsRunning(true);
    setRunError(null);
    fetch(`${API_BASE}/api/run/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime, plotDt, solver: solverMethod }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setRunError(res.error);
          return;
        }
        // Overlay Plots: whatever was showing right before this run's own
        // result lands becomes the dashed "previous" layer -- but only if
        // the toggle is currently on; otherwise any earlier dashed layer is
        // dropped here too, so turning overlay off makes it vanish at the
        // next completed run, not immediately (see the toggle's own
        // comment above).
        setPreviousPlotData(overlayPlots ? plotData : null);
        setPlotData(res);
        setDisplayTab(1);
      })
      .catch((err) => setRunError(String(err)))
      .finally(() => setIsRunning(false));
  }, [solverMethod, overlayPlots, plotData]);

  const handleResetRun = useCallback(() => {
    fetch(`${API_BASE}/api/run/reset`, { method: 'POST' })
      .then((r) => r.json())
      .then((graph) => {
        if (graph.error) {
          setRunError(graph.error);
          return;
        }
        // A reset is just moose.reinit() -- same pools/reacs/ids, only
        // their values change -- so this rebuilds via the same preserve-
        // by-id path refreshGraph uses for incremental edits, not
        // handleGraphResult's full-load path, which would otherwise
        // discard frontend-only state (flipped/color/plotWindow) that has
        // no backend representation and so can't be recomputed from the
        // reloaded graph alone. Also leaves dose-response state and the
        // current display tab alone, since the model itself hasn't
        // changed the way a fresh load would.
        setFlowGraph((g) => {
          const existingFlipped = {};
          const existingColor = {};
          const existingPlotWindow = {};
          const existingCollapsed = {};
          const existingLocked = {};
          const existingParentSide = {};
          const existingLayoutMode = {};
          g.nodes.forEach((n) => {
            existingFlipped[n.id] = n.data.flipped;
            existingLocked[n.id] = n.data.locked;
            if (n.type === 'enz' || n.type === 'concchan') {
              existingParentSide[n.id] = n.data.parentSide;
            }
            if (n.type === 'pool') {
              existingColor[n.id] = n.data.color;
              existingPlotWindow[n.id] = n.data.plotWindow;
            }
            if (CONTAINER_TYPES.includes(n.data.type)) {
              existingCollapsed[n.id] = n.data.collapsed;
              existingLayoutMode[n.id] = n.data.layoutMode;
            }
          });
          return buildFlowNodes(graph, scale, sx, {
            flipped: existingFlipped,
            color: existingColor,
            plotWindow: existingPlotWindow,
            collapsed: existingCollapsed,
            locked: existingLocked,
            parentSide: existingParentSide,
            layoutMode: existingLayoutMode,
          });
        });
        setStatus(`reset ${graph.nodes.length} nodes to initial values`);
        setPlotData(null);
        setPreviousPlotData(null);
        setRunError(null);
      })
      .catch((err) => setRunError(String(err)));
  }, [scale, sx]);

  // One HTTP request per dose level (not one all-in-one blocking request)
  // so progress can be shown and the user can halt between levels --
  // mirrors xdoser.g's own Halt button, which likewise only ever took
  // effect at the next do_run boundary, never truly mid-run.
  const handleDoseStart = useCallback(() => {
    const { inputId, outputId } = doseParams;
    if (!inputId || !outputId) {
      setDoseError('Pick both a variable pool and a monitored pool');
      return;
    }
    doseHaltRef.current = false;
    setDoseError(null);
    setDoseRunning(true);
    setDisplayTab(1);

    // Which plot window slot the curve claims: an unused one first (plot1
    // before plot2), otherwise plot2 regardless -- displacing whatever it
    // was already showing, per the user's own priority order.
    const plot1Used = flowGraph.nodes.some((n) => n.type === 'pool' && n.data.plotWindow === 1);
    const targetWindow = plot1Used ? 2 : 1;
    setDoseCurve({ window: targetWindow, inputId, outputId, points: [] });

    // The dose-response plot itself (see PlotsPanel) updates after every
    // step, which is the progress indicator -- no separate one needed.
    const stepLoop = () => {
      if (doseHaltRef.current) {
        setDoseRunning(false);
        return;
      }
      fetch(`${API_BASE}/api/dose_response/step`, { method: 'POST' })
        .then((r) => r.json())
        .then((step) => {
          if (step.error) {
            setDoseError(step.error);
            setDoseRunning(false);
            return;
          }
          if (step.result) {
            setDoseCurve((c) => (c ? { ...c, points: [...c.points, step.result] } : c));
          }
          if (step.done || doseHaltRef.current) {
            setDoseRunning(false);
            return;
          }
          stepLoop();
        })
        .catch((err) => {
          setDoseError(String(err));
          setDoseRunning(false);
        });
    };

    fetch(`${API_BASE}/api/dose_response/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputId,
        outputId,
        minDecade: doseParams.minDecade,
        maxDecade: doseParams.maxDecade,
        fine: doseParams.fine,
        buffered: doseParams.buffered,
        resetEachLevel: doseParams.resetEachLevel,
        decreasing: doseParams.decreasing,
        runtime: parseFloat(runtime) || 100,
      }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setDoseError(res.error);
          setDoseRunning(false);
          return;
        }
        stepLoop();
      })
      .catch((err) => {
        setDoseError(String(err));
        setDoseRunning(false);
      });
  }, [doseParams, flowGraph.nodes, runtime]);

  const handleDoseHalt = useCallback(() => {
    doseHaltRef.current = true;
    setDoseRunning(false);
    fetch(`${API_BASE}/api/dose_response/halt`, { method: 'POST' }).catch(() => {});
  }, []);

  // Reads the uploaded .json, parses+auto-matches it against the current
  // model, and seeds entityMap from whatever matched -- unmatched entries
  // stay '' so FindSimMenuBox's dropdowns show them as needing a manual
  // pick before Run is enabled.
  const handleFindSimFile = useCallback((file) => {
    setFindSimError(null);
    setFindSimResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      fetch(`${API_BASE}/api/findsim/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: reader.result }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setFindSimParsed(null);
            setFindSimError(res.error);
            return;
          }
          setFindSimParsed(res);
          setFindSimEntityMap(res.matched);
          setFindSimFileName(file.name);
        })
        .catch((err) => setFindSimError(String(err)));
    };
    reader.readAsText(file);
  }, []);

  const handleFindSimEntityChange = useCallback((blockId, poolId) => {
    setFindSimEntityMap((m) => ({ ...m, [blockId]: poolId }));
  }, []);

  // A single blocking call (not a step session like Dose Response) -- a
  // FindSim TimeSeries/DoseResponse file is typically a handful of
  // stimulus/readout points, nowhere near Dose Response's own potentially
  // long decade sweeps, so there's little to gain from the extra Halt/
  // progress machinery.
  const handleFindSimRun = useCallback(() => {
    if (!findSimParsed) return;
    const unresolved = Object.entries(findSimEntityMap).filter(([, poolId]) => !poolId);
    if (unresolved.length > 0) {
      setFindSimError('Pick a pool for every stimulus/readout entity before running');
      return;
    }
    setFindSimError(null);
    setFindSimRunning(true);
    setDisplayTab(1);
    fetch(`${API_BASE}/api/findsim/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spec: findSimParsed.spec,
        entityMap: findSimEntityMap,
      }),
    })
      .then((r) => r.json())
      .then((res) => {
        setFindSimRunning(false);
        if (res.error) {
          setFindSimError(res.error);
          return;
        }
        // Same plot1-before-plot2 priority as Dose Response's own curve.
        const plot1Used = flowGraph.nodes.some((n) => n.type === 'pool' && n.data.plotWindow === 1);
        setFindSimResult({ ...res, window: plot1Used ? 2 : 1 });
      })
      .catch((err) => {
        setFindSimRunning(false);
        setFindSimError(String(err));
      });
  }, [findSimParsed, findSimEntityMap, flowGraph.nodes]);

  return (
    <>
      <Snackbar
        key={warningKey}
        open={!!warning}
        autoHideDuration={4000}
        onClose={() => setWarning('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="warning" variant="filled" onClose={() => setWarning('')}>
          {warning}
        </Alert>
      </Snackbar>
      <AppLayout
        activeMenu={activeMenu}
        setActiveMenu={setActiveMenu}
        status={status}
        onGraphLoaded={handleGraphResult}
        plots={plots}
        collapsedMap={collapsedMap}
        selectedNode={selectedNode}
        selectedParentName={selectedParentName}
        onSaveNode={onSaveNode}
        onToggleFlip={onToggleFlip}
        onToggleParentSide={onToggleParentSide}
        onToggleCollapse={onToggleCollapse}
        onSetAllCollapsed={onSetAllCollapsed}
        visualMode={visualMode}
        onCycleVisualMode={onCycleVisualMode}
        onAutoLayoutGroup={onAutoLayoutGroup}
        onAutoLayoutGroupByFlow={onAutoLayoutGroupByFlow}
        onAutoLayoutRecursive={onAutoLayoutRecursive}
        onAutoLayoutRecursiveFlow={onAutoLayoutRecursiveFlow}
        onClearLayoutLocks={onClearLayoutLocks}
        onSnapGroupToGrid={onSnapGroupToGrid}
        layoutRunning={layoutRunning}
        layoutProgress={layoutProgress}
        snapToGrid={snapToGrid}
        setSnapToGrid={setSnapToGrid}
        selectedGroupScore={selectedGroupScore}
        scaleIcons={scaleIcons}
        setScaleIcons={setScaleIcons}
        sx={sx}
        onUndoLayout={onUndoLayout}
        canUndoLayout={!!autoLayoutUndoSnapshot}
        loadGeneration={loadGeneration}
        onCanvasDrop={handleCanvasDrop}
        onUnplot={handleUnplot}
        onAddPool={handleAddPool}
        onAddReac={handleAddReac}
        onAddEnz={handleAddEnz}
        onStartRun={handleStartRun}
        onResetRun={handleResetRun}
        isRunning={isRunning}
        runError={runError}
        runtime={runtime}
        setRuntime={setRuntime}
        plotDt={plotDt}
        setPlotDt={setPlotDt}
        solverMethod={solverMethod}
        setSolverMethod={setSolverMethod}
        overlayPlots={overlayPlots}
        setOverlayPlots={setOverlayPlots}
        plotDomain={plotDomain}
        setPlotDomain={setPlotDomain}
        plotData={plotData}
        previousPlotData={previousPlotData}
        doseCurve={doseCurve}
        doseParams={doseParams}
        setDoseParams={setDoseParams}
        doseRunning={doseRunning}
        doseError={doseError}
        onDoseStart={handleDoseStart}
        onDoseHalt={handleDoseHalt}
        onArmDosePick={handleArmDosePick}
        onPrintLayout={handlePrintLayout}
        onSaveLayoutSvg={handleSaveLayoutSvg}
        canvasApiRef={canvasApiRef}
        findSimParsed={findSimParsed}
        findSimEntityMap={findSimEntityMap}
        findSimFileName={findSimFileName}
        findSimRunning={findSimRunning}
        findSimError={findSimError}
        findSimResult={findSimResult}
        onFindSimFile={handleFindSimFile}
        onFindSimEntityChange={handleFindSimEntityChange}
        onFindSimRun={handleFindSimRun}
        displayTab={displayTab}
        setDisplayTab={setDisplayTab}
        flowGraph={flowGraph}
        displayGraph={displayGraph}
        edgeActions={edgeActions}
        nodeActions={nodeActions}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onEdgesChange={onEdgesChange}
        timeUnit={timeUnit}
        setTimeUnit={setTimeUnit}
        concUnit={concUnit}
        setConcUnit={setConcUnit}
        volumeUnit={volumeUnit}
        setVolumeUnit={setVolumeUnit}
        lengthUnit={lengthUnit}
        setLengthUnit={setLengthUnit}
      />
    </>
  );
}
