import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import AppLayout from './AppLayout';
import { RAINBOW_16 } from './colorUtils';
import { computeCollapsedView, computeIsolateView, avoidObstacles } from './collapseView';
import {
  AUTO_LAYOUT_CELL,
  computeGridCells,
  computeFlipUpdates,
  optimizeGroupLayout,
} from './layoutSeed';
import { computeLayoutScore } from './layoutScore';

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

const EDGE_STYLE = {
  substrate: { stroke: 'green', strokeWidth: 1.75 },
  product: { stroke: '#333', strokeWidth: 1.75 },
  enzyme: { stroke: 'orange', strokeDasharray: '4 2', strokeWidth: 1.75 },
  chanParent: { stroke: 'orange', strokeDasharray: '4 2', strokeWidth: 1.75 },
  chanIn: { stroke: 'green', strokeWidth: 1.75 },
  chanOut: { stroke: '#333', strokeWidth: 1.75 },
  stimTarget: { stroke: '#e63946', strokeDasharray: '2 2', strokeWidth: 1.75 },
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
function effectiveContainerBox(n, index, boxById) {
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
    const childBox = effectiveContainerBox(other, index, boxById);
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
  const padding = touchesNestedContainer ? CONTAINER_NESTING_PADDING : CONTAINER_PADDING;
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
// doesn't sit flush against a neighbor's), or a flat AUTO_LAYOUT_CELL
// square for a plain entity, which has no border/size concept of its own
// to measure -- except a Pool (a "molecule", in kkit's own terms) with a
// long name, which is given double that width. A Pool's real rendered box
// is text-driven (see nodes.jsx's PoolNode -- padding plus a 28px font, no
// fixed width), so a long name can render meaningfully wider than this
// flat square; packing it into the same narrow cell every other plain
// entity gets left it visually overlapping its neighbor once actually
// rendered, even though the packing itself never considered that an
// overlap. A coarse, cheap stand-in for properly measuring the rendered
// text (which would need the same px-per-kkit-unit `scale` this function
// doesn't have access to) -- good enough to give a long name noticeably
// more breathing room without trying to be pixel-exact. Used for BOTH
// onAutoLayoutGroup's own single-level packing and computeLocalLayouts'
// per-level sizing (a nested *container*'s size there comes from its own
// freshly-recomputed localLayouts entry instead, never this -- see
// computeLocalLayouts' own comment -- since this would only ever read the
// box as it stood *before* the whole operation started).
const LONG_POOL_NAME_THRESHOLD = 10;

function childFootprint(c, containerIndex, boxById) {
  if (!CONTAINER_TYPES.includes(c.type)) {
    const isLongPoolName = c.type === 'pool' && (c.name?.length ?? 0) > LONG_POOL_NAME_THRESHOLD;
    return { width: isLongPoolName ? AUTO_LAYOUT_CELL * 2 : AUTO_LAYOUT_CELL, height: AUTO_LAYOUT_CELL };
  }
  const box = effectiveContainerBox(c, containerIndex, boxById);
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
function computeLocalLayouts(rootId, rawNodes, rawById, containerIndex, boxById, localLayouts, edges, perLevelBudgetMs) {
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
  directChildren.forEach((child) => {
    if (CONTAINER_TYPES.includes(child.type) && !child.locked) {
      computeLocalLayouts(child.id, rawNodes, rawById, containerIndex, boxById, localLayouts, edges, perLevelBudgetMs);
    }
  });
  if (directChildren.length === 0) {
    const currentBox = effectiveContainerBox(rawById[rootId], containerIndex, boxById);
    localLayouts[rootId] = { children: [], width: currentBox.width, height: currentBox.height };
    return;
  }

  const currentBox = effectiveContainerBox(rawById[rootId], containerIndex, boxById);
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
      return [c.id, childFootprint(c, containerIndex, boxById)];
    })
  );
  const unlockedSizes = unlockedPackable.map((c) => sizesMap.get(c.id));
  const { colWidth, rowHeight, cols } = computeGridCells(
    unlockedSizes.length > 0 ? unlockedSizes : [{ width: AUTO_LAYOUT_CELL, height: AUTO_LAYOUT_CELL }]
  );

  // Seed + simulated-annealing refinement (see optimizeGroupLayout's own
  // comment) instead of plain insertion order -- children actually
  // connected to each other land in nearby grid cells instead of
  // wherever the backend happened to list them.
  const optimized = optimizeGroupLayout({ children: repositionable, edges, rawById, sizes: sizesMap, cols, colWidth, rowHeight, timeBudgetMs: perLevelBudgetMs });
  // CONTAINER_PADDING is baked into each child's own localX/localY here
  // (matching onAutoLayoutGroup's single-level originX/originY) -- so
  // assignAbsolutePositions below only ever has to add a container's own
  // real origin to these, never a second padding offset on top.
  //
  // A per-level "discarded" result (see optimizeGroupLayout) used to
  // still fall back to a plain, unordered *grid repack* of this level's
  // own children here -- the gate only ever stopped a worse *ordering*
  // from being used, not a worse *layout*, since a fresh grid pack in
  // insertion order is not the same thing as this level's own current
  // arrangement, and could easily score worse than what was already on
  // screen. That's what let a whole recursive run regress a nested
  // group's own score despite this exact gate already existing --
  // verified directly against Repressillator.g. Discarded now means what
  // it means everywhere else in this app: leave this level's own
  // children at their current relative position instead, the same way a
  // locked entity already does (see lockedEntityPlacements just below).
  const packedChildren = optimized.discarded
    ? unlockedPackable.map((c) => {
        const footprint = sizesMap.get(c.id);
        const localX = c.x - currentBox.x;
        const localY = c.y - currentBox.y;
        return { id: c.id, localX, localY, right: localX + footprint.width, bottom: localY - footprint.height };
      })
    : optimized.order.map((child, i) => ({
        id: child.id,
        localX: CONTAINER_PADDING + (i % cols) * colWidth,
        localY: -CONTAINER_PADDING - Math.floor(i / cols) * rowHeight,
        right: CONTAINER_PADDING + (i % cols) * colWidth + colWidth,
        bottom: -CONTAINER_PADDING - Math.floor(i / cols) * rowHeight - rowHeight,
      }));

  const lockedEntityPlacements = lockedEntities.map((c) => {
    const footprint = childFootprint(c, containerIndex, boxById);
    const localX = c.x - currentBox.x;
    const localY = c.y - currentBox.y;
    return { id: c.id, localX, localY, right: localX + footprint.width, bottom: localY - footprint.height };
  });

  const lockedContainerBounds = lockedContainers.map((c) => {
    const box = effectiveContainerBox(c, containerIndex, boxById);
    const localX = c.x - currentBox.x;
    const localY = c.y - currentBox.y;
    return { localX, localY, right: localX + box.width, bottom: localY - box.height };
  });

  // `children` only ever holds entries assignAbsolutePositions should
  // actually move (a locked container is deliberately excluded, see
  // above) -- the bounding-box math just below additionally folds in
  // every locked container's own current footprint, so this level's final
  // size still actually contains it even though it's never repositioned.
  const children = [...packedChildren, ...lockedEntityPlacements];
  const allBounds = [...packedChildren, ...lockedEntityPlacements, ...lockedContainerBounds];
  // When this level's own packing was discarded, every one of its
  // children (packed or locked) is already sitting at its own current
  // position -- so this container's true current size (not a freshly
  // recomputed bounding box) is what actually belongs here. Recomputing
  // it anyway can drift from the real footprint (this app's own
  // CONTAINER_PADDING convention doesn't necessarily match whatever
  // margin the container actually has), and that drift silently
  // compounds upward: the *parent* level's own baseline-vs-candidate
  // score compares against this container's reported size, so an
  // inflated-but-unmoved child here still reads as "this got bigger" one
  // level up -- verified directly against Repressillator.g, where every
  // one of its 3 nested gene groups discarded correctly (score
  // unchanged) yet the enclosing compartment's own baseline had already
  // drifted up 22% purely from this, well past what its own 10% gate
  // should ever have let through unnoticed.
  localLayouts[rootId] = optimized.discarded
    ? { children, width: currentBox.width, height: currentBox.height }
    : {
        children,
        width: Math.max(...allBounds.map((b) => b.right)) - Math.min(...allBounds.map((b) => b.localX)) + CONTAINER_PADDING * 2,
        height: Math.max(...allBounds.map((b) => b.localY)) - Math.min(...allBounds.map((b) => b.bottom)) + CONTAINER_PADDING * 2,
      };
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
function buildFlowNodes(graph, scale, preserve = {}) {
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
      effectiveContainerBox(n, containerIndex, boxById);
    }
  });

  // Starts past however many pools already have a preserved color, so a
  // newly-added pool never reuses a color already assigned to an existing
  // one (matches the original refreshGraph behavior this replaced).
  let poolIndex = Object.keys(preserve.color ?? {}).length;
  const nodes = graph.nodes.map((n) => {
    const isContainer = CONTAINER_TYPES.includes(n.type);
    const color =
      n.type === 'pool' ? preserve.color?.[n.id] ?? RAINBOW_16[poolIndex++ % 16] : n.color;

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
    if (n.type === 'pool' || n.type === 'reac' || n.type === 'enz' || n.type === 'concchan') {
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

function toFlowGraph(graph, scale) {
  return buildFlowNodes(graph, scale);
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
function findContainerAt(kx, ky, flowNodes) {
  const rawNodes = flowNodes.map((n) => n.data);
  const rawById = {};
  rawNodes.forEach((n) => {
    rawById[n.id] = n;
  });
  const boxById = {};
  const containerIndex = buildContainerIndex(rawNodes, rawById);
  const candidates = rawNodes
    .filter((n) => CONTAINER_TYPES.includes(n.type))
    .map((n) => ({ id: n.id, box: effectiveContainerBox(n, containerIndex, boxById) }))
    .filter(({ box }) => kx >= box.x && kx <= box.x + box.width && ky <= box.y && ky >= box.y - box.height);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height);
  return candidates[0].id;
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
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [activeMenu, setActiveMenu] = useState('File');
  const [plotData, setPlotData] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [lastRuntime, setLastRuntime] = useState(null);
  // Lifted out of RunMenuBox (rather than kept as its own local state) so a
  // Stimulus's save-time negative-value check (see onSaveNode) can send the
  // Run panel's *current* runtime value along with it, per the user's own
  // choice of where that duration should come from.
  const [runtime, setRuntime] = useState('3000');
  const [plotDt, setPlotDt] = useState('1');
  // Which of MainDisplay's two tabs (0 = Reaction Layout, 1 = Plots) is
  // showing -- lifted up here (rather than local state in MainDisplay) so a
  // completed run can switch to it, not just the user clicking the tab.
  const [displayTab, setDisplayTab] = useState(0);
  // Design section 6's "isolate mode" -- an on/off toggle, separate from
  // any individual group's own collapsed flag, that hides every collapsed
  // group entirely (icon and all) and replaces whatever it connected to
  // with per-entity proxy stand-ins (see collapseView.js's
  // computeIsolateView). "The expanded group(s)" isolate mode shows is
  // read directly off the same per-group collapsed flag every other view
  // already uses -- there's no separate group-picker UI here.
  const [isolateMode, setIsolateMode] = useState(false);
  const onToggleIsolateMode = useCallback(() => setIsolateMode((v) => !v), []);
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
    setFlowGraph(toFlowGraph(graph, newScale));
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
    const scoreNodes = directChildren.map((c) => {
      const size = childFootprint(c, containerIndex, boxById);
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
  }, [selectedNode, flowGraph.nodes, flowGraph.edges]);

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
    const view = isolateMode
      ? computeIsolateView(canvasGraph.nodes, canvasGraph.edges, collapsedIds)
      : computeCollapsedView(canvasGraph.nodes, canvasGraph.edges, collapsedIds);
    // Aggregate edges have no backing entry in flowGraph.edges (see
    // moveEdgeVia) -- their bend point is applied here instead, as a
    // cheap post-process over whatever computeCollapsedView just
    // synthesized, keyed by its own deterministic `aggregate-<a>-<b>` id.
    // A no-op lookup under isolate mode, which never produces aggregate
    // edges in the first place -- harmless, not worth special-casing out.
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
  }, [canvasGraph.nodes, canvasGraph.edges, collapsedIds, isolateMode, aggregateVia]);

  const onNodeClick = useCallback((event, node) => {
    // A proxy (isolate mode -- see collapseView.js's computeIsolateView) is
    // a synthetic stand-in for one specific hidden entity, not a real node
    // of its own -- clicking it opens *that* entity's own Properties
    // (still fully present in flowGraph.nodes, just not currently
    // rendered), keyed by realId/realType rather than the proxy's own
    // synthetic id/type.
    if (node.data.type === 'proxy') {
      if (EDITABLE_ENDPOINTS[node.data.realType]) {
        setSelectedNodeId(node.data.realId);
        setActiveMenu('Properties');
      }
      return;
    }
    if (EDITABLE_ENDPOINTS[node.data.type]) {
      setSelectedNodeId(node.id);
      setActiveMenu('Properties');
    }
  }, []);

  const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

  const onNodesChange = useCallback((changes) => {
    setFlowGraph((g) => ({ ...g, nodes: applyNodeChanges(changes, g.nodes) }));
  }, []);

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
    fetch(`${API_BASE}/api/update_position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: node.id, x, y }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setStatus(`error: ${res.error}`);
          return;
        }
        setFlowGraph((g) => ({
          ...g,
          // A manual drag is exactly the "manually positioned" case
          // data.locked exists to flag -- see its own comment -- so a
          // later auto-layout run leaves this node exactly where the user
          // just put it instead of repacking it.
          nodes: g.nodes.map((n) =>
            n.id === node.id ? { ...n, data: { ...n.data, x, y, locked: true } } : n
          ),
        }));
      })
      .catch((err) => setStatus(`error: ${err}`));
  }, [scale, flowGraph.nodes]);

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
      const x = ax / scale;
      const y = -ay / scale;
      const width = box.width / scale;
      const height = box.height / scale;
      fetch(`${API_BASE}/api/update_position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: nodeId, x, y, width, height }),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.error) {
            setStatus(`error: ${res.error}`);
            return;
          }
          setFlowGraph((g) => ({
            ...g,
            nodes: g.nodes.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    position: { x: box.x, y: box.y },
                    style: { width: box.width, height: box.height },
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
                    data: { ...n.data, x, y, width, height, expandedStyle: { width: box.width, height: box.height }, locked: true },
                  }
                : n
            ),
          }));
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [flowGraph.nodes, scale]
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
    (groupId) => {
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

      const containerIndex = buildContainerIndex(rawNodes, rawById);
      const boxById = {};
      const sizes = new Map(directChildren.map((c) => [c.id, childFootprint(c, containerIndex, boxById)]));
      const { colWidth, rowHeight, cols } = computeGridCells(unlockedChildren.map((c) => sizes.get(c.id)));
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
      const groupBox = effectiveContainerBox(group, containerIndex, boxById);
      const originX = groupBox.x + CONTAINER_PADDING;
      const originY = groupBox.y - CONTAINER_PADDING;
      // Seed (connectivity-aware relaxation, or a radial hub-first
      // placement, whichever scores better) plus simulated-annealing
      // refinement against layoutScore.js's own connector-length/crossing/
      // overlap/area score -- see layoutSeed.js's own optimizeGroupLayout
      // and the planning discussion this shipped from. A result scoring
      // more than 10% worse than the group's own current layout is
      // discarded entirely below -- nothing gets sent to the backend at
      // all in that case, not even a fallback rearrangement, so a user
      // clicking this button can never make their own layout *worse*.
      const optimized = optimizeGroupLayout({ children: directChildren, edges: flowGraph.edges, rawById, sizes, cols, colWidth, rowHeight });
      if (optimized.discarded) {
        setStatus('auto-layout would not improve this group -- left unchanged');
        return;
      }
      const placements = optimized.order.map((child, i) => ({
        child,
        x: originX + (i % cols) * colWidth,
        y: originY - Math.floor(i / cols) * rowHeight,
      }));
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
          const leftEdges = [...placements.map((p) => p.x), ...lockedFootprints.map((f) => f.x)];
          const rightEdges = [...placements.map((p) => p.x + colWidth), ...lockedFootprints.map((f) => f.x + f.width)];
          const bottomEdges = [...placements.map((p) => p.y - rowHeight), ...lockedFootprints.map((f) => f.y - f.height)];
          const topEdges = [...placements.map((p) => p.y), ...lockedFootprints.map((f) => f.y)];
          const width = Math.max(...rightEdges) - Math.min(...leftEdges) + CONTAINER_PADDING * 2;
          const height = Math.max(...topEdges) - Math.min(...bottomEdges) + CONTAINER_PADDING * 2;
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
          // optimizeGroupLayout already computed the right flip for every
          // reac/enz/concchan this operation touched, against the exact
          // same final positions just committed above -- no need to
          // re-derive it here the way a plain connectivity-aware pack
          // used to require.
          if (Object.keys(optimized.flips).length > 0) {
            setFlowGraph((g) => ({
              ...g,
              nodes: g.nodes.map((n) => (optimized.flips[n.id] !== undefined ? { ...n, data: { ...n.data, flipped: optimized.flips[n.id] } } : n)),
            }));
          }
          setAutoLayoutUndoSnapshot(undoSnapshot);
          refreshGraphRef.current?.();
          // Deliberately NOT bumping loadGeneration (and so NOT re-fitting
          // the viewport) here -- you're usually looking right at the
          // group you just asked to be laid out, and having the whole
          // view suddenly jump to reframe the entire model was
          // disorienting even though the group's own new size is still
          // perfectly visible without it.
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [flowGraph.nodes, flowGraph.edges]
  );

  // Reverts whatever onAutoLayoutGroup/onAutoLayoutRecursive most recently
  // applied, using the pre-operation snapshot either one captured --
  // restores each touched node's exact raw x/y (and width/height, for a
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
    (rootId) => {
      const rawNodes = flowGraph.nodes.map((n) => n.data);
      const rawById = {};
      rawNodes.forEach((n) => {
        rawById[n.id] = n;
      });
      const root = rawById[rootId];
      if (!root) return;

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
      computeLocalLayouts(rootId, rawNodes, rawById, containerIndex, boxById, localLayouts, flowGraph.edges, perLevelBudgetMs);
      if (localLayouts[rootId].children.length === 0) return;

      // The root of this operation keeps its own current position --
      // only its *contents* are being rearranged, so there's nothing
      // above it in the tree to anchor a new position against; it does
      // still get resized to fit whatever its own subtree now needs.
      const rootBox = effectiveContainerBox(root, containerIndex, boxById);
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
          if (Object.keys(flips).length > 0) {
            setFlowGraph((g) => ({
              ...g,
              nodes: g.nodes.map((n) => (flips[n.id] !== undefined ? { ...n, data: { ...n.data, flipped: flips[n.id] } } : n)),
            }));
          }
          setAutoLayoutUndoSnapshot(undoSnapshot);
          refreshGraphRef.current?.();
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [flowGraph.nodes, flowGraph.edges]
  );

  const nodeActions = useMemo(() => ({ onContainerResize }), [onContainerResize]);

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
      fetch(`${API_BASE}/api/add_edge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: conn.source, to: conn.target, type: edgeType }),
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
            const nodes = mergeReacUpdate(g.nodes, res.reacUpdate);
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

        fetch(`${API_BASE}/api/remove_edge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: edge.source, to: edge.target, type: edge.data.type }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res.error) {
              setStatus(`error: ${res.error}`);
              return;
            }
            setFlowGraph((g) => ({
              nodes: mergeReacUpdate(g.nodes, res.reacUpdate),
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
    [flowGraph.edges]
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
      const { flipped = node.data.flipped, ...backendFields } = fields;
      const endpoint = EDITABLE_ENDPOINTS[node.data.type];
      const body = { id: nodeId, fields: backendFields };
      // A Stimulus's Save is gated on a negative-value check run against
      // the Run panel's *current* runtime (see server.py's
      // _check_stim_expr) -- sent along here rather than baked in at
      // creation time, so editing later always checks against whatever
      // duration is actually configured now.
      if (node.data.type === 'stim') body.runtime = parseFloat(runtime) || 1;
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
            // switches menus, so a rejected Stimulus save (most notably
            // the negative-value check) needs a popup, not just the
            // easy-to-miss status line -- Save simply does nothing else
            // and the user's typed expression stays in the box to fix.
            if (node.data.type === 'stim') window.alert(updated.error);
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
                ? { ...n, id: updated.id, data: { ...updated, color, flipped, plotWindow, collapsed } }
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
    fetch(`${API_BASE}/api/graph`)
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
            }
          });
          return buildFlowNodes(graph, scale, {
            flipped: existingFlipped,
            color: existingColor,
            plotWindow: existingPlotWindow,
            collapsed: existingCollapsed,
            locked: existingLocked,
            parentSide: existingParentSide,
          });
        });
      })
      .catch((err) => setStatus(`error: ${err}`));
  }, [scale]);
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

  // Drop target for the Add menu's drag-and-drop icons -- position arrives
  // in on-screen flow-pixel space (from React Flow's screenToFlowPosition),
  // so it's converted back to kkit layout units the same way toFlowGraph's
  // own transform is inverted (x/scale, and y negated back).
  const handleCanvasDrop = useCallback(
    (type, flowPosition, hitNodeId) => {
      const kx = flowPosition.x / scale;
      const ky = -flowPosition.y / scale;
      if (type === 'pool') {
        handleAddPool(kx, ky, findContainerAt(kx, ky, flowGraph.nodes));
      } else if (type === 'reac') {
        handleAddReac(kx, ky, findContainerAt(kx, ky, flowGraph.nodes));
      } else if (type === 'group') {
        const parentId = findContainerAt(kx, ky, flowGraph.nodes);
        if (!parentId) {
          setStatus('drop the group icon inside an existing compartment (or group)');
          return;
        }
        handleAddGroup(kx, ky, parentId);
      } else if (type === 'compartment') {
        // Compartments never nest -- no container hit-test needed.
        handleAddCompartment(kx, ky);
      } else if (type === 'enz') {
        const hitNode = flowGraph.nodes.find((n) => n.id === hitNodeId);
        if (!hitNode || hitNode.type !== 'pool') {
          setStatus('drop the enzyme icon onto an existing pool');
          return;
        }
        if (hitNode.data.isEnzComplex) {
          setStatus("an enzyme's complex pool can't be connected to anything");
          return;
        }
        createEnzOnPool(hitNode);
      } else if (type === 'concchan') {
        const hitNode = flowGraph.nodes.find((n) => n.id === hitNodeId);
        if (!hitNode || hitNode.type !== 'pool') {
          setStatus('drop the ConcChan icon onto an existing pool');
          return;
        }
        if (hitNode.data.isEnzComplex) {
          setStatus("an enzyme's complex pool can't be connected to anything");
          return;
        }
        createConcChanOnPool(hitNode);
      } else if (type === 'stim') {
        const hitNode = flowGraph.nodes.find((n) => n.id === hitNodeId);
        if (!hitNode || hitNode.type !== 'pool') {
          setStatus('drop the Stimulus icon onto an existing pool');
          return;
        }
        if (hitNode.data.isEnzComplex) {
          setStatus("an enzyme's complex pool can't be connected to anything");
          return;
        }
        createStimOnPool(hitNode);
      } else if (type === 'plot1' || type === 'plot2') {
        const window = type === 'plot1' ? 1 : 2;
        const hitNode = flowGraph.nodes.find((n) => n.id === hitNodeId);
        // Dropped onto an enzyme -- plots its own hidden complex pool's
        // conc (never itself a droppable canvas node, see buildFlowNodes/
        // canvasGraph), which is what "plot this enzyme" can only sensibly
        // mean now that the complex pool isn't shown as its own icon.
        const targetPoolId = hitNode?.type === 'enz' ? hitNode.data.complexPoolId : hitNode?.id;
        if (!hitNode || (hitNode.type !== 'pool' && hitNode.type !== 'enz') || !targetPoolId) {
          setStatus('drop the plot icon onto a pool (or an enzyme, to plot its complex) to plot it');
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

  const handleDeleteSelected = useCallback(() => {
    if (!selectedNodeId || !selectedNode) return;
    if (!confirmContainerDelete(selectedNode, flowGraph.nodes)) return;
    fetch(`${API_BASE}/api/delete_node`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selectedNodeId }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setStatus(`error: ${res.error}`);
          return;
        }
        setSelectedNodeId(null);
        refreshGraph();
      })
      .catch((err) => setStatus(`error: ${err}`));
  }, [selectedNodeId, selectedNode, flowGraph.nodes, refreshGraph]);

  const handleStartRun = useCallback((runtime, plotDt) => {
    setIsRunning(true);
    setRunError(null);
    fetch(`${API_BASE}/api/run/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runtime, plotDt }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setRunError(res.error);
          return;
        }
        setPlotData(res);
        setLastRuntime(runtime);
        setDisplayTab(1);
      })
      .catch((err) => setRunError(String(err)))
      .finally(() => setIsRunning(false));
  }, []);

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
            }
          });
          return buildFlowNodes(graph, scale, {
            flipped: existingFlipped,
            color: existingColor,
            plotWindow: existingPlotWindow,
            collapsed: existingCollapsed,
            locked: existingLocked,
            parentSide: existingParentSide,
          });
        });
        setStatus(`reset ${graph.nodes.length} nodes to initial values`);
        setPlotData(null);
        setLastRuntime(null);
        setRunError(null);
      })
      .catch((err) => setRunError(String(err)));
  }, [scale]);

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
      onToggleCollapse={onToggleCollapse}
      onSetAllCollapsed={onSetAllCollapsed}
      isolateMode={isolateMode}
      onToggleIsolateMode={onToggleIsolateMode}
      onAutoLayoutGroup={onAutoLayoutGroup}
      onAutoLayoutRecursive={onAutoLayoutRecursive}
      onClearLayoutLocks={onClearLayoutLocks}
      selectedGroupScore={selectedGroupScore}
      onUndoLayout={onUndoLayout}
      canUndoLayout={!!autoLayoutUndoSnapshot}
      loadGeneration={loadGeneration}
      onCanvasDrop={handleCanvasDrop}
      onUnplot={handleUnplot}
      onAddPool={handleAddPool}
      onAddReac={handleAddReac}
      onAddEnz={handleAddEnz}
      onDeleteSelected={handleDeleteSelected}
      onStartRun={handleStartRun}
      onResetRun={handleResetRun}
      isRunning={isRunning}
      runError={runError}
      lastRuntime={lastRuntime}
      runtime={runtime}
      setRuntime={setRuntime}
      plotDt={plotDt}
      setPlotDt={setPlotDt}
      plotData={plotData}
      doseCurve={doseCurve}
      doseParams={doseParams}
      setDoseParams={setDoseParams}
      doseRunning={doseRunning}
      doseError={doseError}
      onDoseStart={handleDoseStart}
      onDoseHalt={handleDoseHalt}
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
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onEdgesChange={onEdgesChange}
    />
  );
}
