import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import AppLayout from './AppLayout';
import { RAINBOW_16 } from './colorUtils';

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

  const nearestDistances = points
    .map((p, i) => {
      let min = Infinity;
      points.forEach((q, j) => {
        if (i === j) return;
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d > 0 && d < min) min = d;
      });
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
  substrate: { stroke: 'green' },
  product: { stroke: '#333' },
  enzyme: { stroke: 'orange', strokeDasharray: '4 2' },
  chanParent: { stroke: 'orange', strokeDasharray: '4 2' },
  chanIn: { stroke: 'green' },
  chanOut: { stroke: '#333' },
  stimTarget: { stroke: '#e63946', strokeDasharray: '2 2' },
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
// the inner box's own border sits right up against the outer one's.
const CONTAINER_NESTING_PADDING = 3.5;

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
function effectiveContainerBox(n, rawNodes, rawById, boxById) {
  if (boxById[n.id]) return boxById[n.id];
  if (n.width > 0 || n.height > 0) {
    const box = { x: n.x, y: n.y, width: n.width, height: n.height };
    boxById[n.id] = box;
    return box;
  }

  const xs = [];
  const ys = [];
  let touchesNestedContainer = false;
  rawNodes.forEach((other) => {
    if (other.id === n.id) return;
    if (CONTAINER_TYPES.includes(other.type)) {
      if (other.parentId !== n.id) return; // only direct container children
      touchesNestedContainer = true;
      const childBox = effectiveContainerBox(other, rawNodes, rawById, boxById);
      xs.push(childBox.x, childBox.x + childBox.width);
      ys.push(childBox.y, childBox.y - childBox.height);
      return;
    }
    if (isDescendantOf(other.id, n.id, rawById)) {
      xs.push(other.x);
      ys.push(other.y);
    }
  });

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

// Shared by the initial/full load path and refreshGraph -- `preserve` lets
// the latter carry forward frontend-only state (flipped/color/plotWindow)
// that has no backend representation, keyed by node id; the former just
// passes empty maps so everything gets freshly computed defaults.
function buildFlowNodes(graph, scale, preserve = {}) {
  const flips = computeInitialFlips(graph);
  const rawById = {};
  graph.nodes.forEach((n) => {
    rawById[n.id] = n;
  });

  // Every group/compartment's effective box is computed once up front --
  // both for its own rendering and as the reference point every child
  // (including a nested group) measures its relative position against.
  const boxById = {};
  graph.nodes.forEach((n) => {
    if (CONTAINER_TYPES.includes(n.type)) {
      effectiveContainerBox(n, graph.nodes, rawById, boxById);
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
    if (n.type === 'pool') {
      // Preserved session state wins (a user's own toggle shouldn't be
      // undone by a refresh); otherwise fall back to what the backend
      // detected from the file's own pre-existing plot definitions (see
      // moose_graph.detect_existing_plots), not unconditionally null.
      node.data.plotWindow = preserve.plotWindow?.[n.id] ?? n.plotWindow ?? null;
    }
    if (n.parentId) {
      node.parentId = n.parentId;
      node.extent = 'parent';
    }
    if (isContainer) {
      const box = boxById[n.id];
      node.style = { width: box.width * scale, height: box.height * scale };
      node.zIndex = n.type === 'compartment' ? -2 : -1;
    }
    return node;
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
  const candidates = rawNodes
    .filter((n) => CONTAINER_TYPES.includes(n.type))
    .map((n) => ({ id: n.id, box: effectiveContainerBox(n, rawNodes, rawById, boxById) }))
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
  // Recomputed only on full graph reloads (load/reset/refresh), not on
  // incremental edits (drag, single add) -- so a drag or single new node
  // never rescales/shifts everything else already laid out.
  const [scale, setScale] = useState(DEFAULT_SCALE);
  // Bumped on every full graph load (not incremental edits) so MainDisplay
  // knows to re-fit the viewport to the new node set -- React Flow's own
  // `fitView` prop only ever runs once, on initial mount.
  const [loadGeneration, setLoadGeneration] = useState(0);

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

  const onNodeClick = useCallback((event, node) => {
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
          nodes: g.nodes.map((n) =>
            n.id === node.id ? { ...n, data: { ...n.data, x, y } } : n
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
                    data: { ...n.data, x, y, width, height },
                  }
                : n
            ),
          }));
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [flowGraph.nodes, scale]
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
          if (renamed && (node.data.type === 'group' || node.data.type === 'compartment')) {
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
          setFlowGraph((g) => ({
            nodes: g.nodes.map((n) =>
              n.id === nodeId ? { ...n, id: updated.id, data: { ...updated, color, flipped, plotWindow } } : n
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
          g.nodes.forEach((n) => {
            existingFlipped[n.id] = n.data.flipped;
            if (n.type === 'pool') {
              existingColor[n.id] = n.data.color;
              existingPlotWindow[n.id] = n.data.plotWindow;
            }
          });
          return buildFlowNodes(graph, scale, {
            flipped: existingFlipped,
            color: existingColor,
            plotWindow: existingPlotWindow,
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
      nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, flipped } } : n)),
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
        if (!hitNode || hitNode.type !== 'pool') {
          setStatus('drop the plot icon onto a pool to plot it');
          return;
        }
        // Purely a frontend marker (like flipped/color) -- toggled so
        // dropping the same window's icon on an already-assigned pool
        // un-plots it; dropping the other window's icon reassigns it.
        setFlowGraph((g) => ({
          ...g,
          nodes: g.nodes.map((n) =>
            n.id === hitNode.id
              ? { ...n, data: { ...n.data, plotWindow: n.data.plotWindow === window ? null : window } }
              : n
          ),
        }));
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
      nodes: g.nodes.map((n) => (n.id === poolId ? { ...n, data: { ...n.data, plotWindow: null } } : n)),
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
          g.nodes.forEach((n) => {
            existingFlipped[n.id] = n.data.flipped;
            if (n.type === 'pool') {
              existingColor[n.id] = n.data.color;
              existingPlotWindow[n.id] = n.data.plotWindow;
            }
          });
          return buildFlowNodes(graph, scale, {
            flipped: existingFlipped,
            color: existingColor,
            plotWindow: existingPlotWindow,
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
        plotDt: parseFloat(plotDt) || 1,
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
  }, [doseParams, flowGraph.nodes, runtime, plotDt]);

  const handleDoseHalt = useCallback(() => {
    doseHaltRef.current = true;
    setDoseRunning(false);
    fetch(`${API_BASE}/api/dose_response/halt`, { method: 'POST' }).catch(() => {});
  }, []);

  return (
    <AppLayout
      activeMenu={activeMenu}
      setActiveMenu={setActiveMenu}
      status={status}
      onGraphLoaded={handleGraphResult}
      plots={plots}
      selectedNode={selectedNode}
      onSaveNode={onSaveNode}
      onToggleFlip={onToggleFlip}
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
      displayTab={displayTab}
      setDisplayTab={setDisplayTab}
      flowGraph={flowGraph}
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
