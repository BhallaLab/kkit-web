import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import AppLayout from './AppLayout';

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

// Median (not minimum) nearest-neighbor distance across all node positions.
// Minimum would be thrown off by deliberately-tight pairs that are common in
// kkit layouts (our own create_enz places an enzyme only ~0.5-1 unit from
// its parent pool, and legacy .g files use similar tight diagonal offsets
// for enz/reac icons next to their substrate pool) -- those pairs shouldn't
// dictate the overall scale, but they would if we took the true minimum.
function computeAutoScale(graph) {
  const points = graph.nodes.map((n) => ({ x: n.x, y: n.y }));
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
};

// Which named Handle (see nodes.jsx) each edge type terminates on, on the
// Reac/Enz side -- the Pool side always uses that node's single unnamed
// handle, so it needs no explicit id.
const HANDLE_BY_TYPE = {
  substrate: { targetHandle: 'substrate' },
  product: { sourceHandle: 'product' },
  enzyme: { targetHandle: 'enzSite' },
};

// Which backend endpoint updates each editable node type -- field rendering
// itself lives in PropertiesMenuBox, not per-type here.
const EDITABLE_ENDPOINTS = {
  pool: '/api/update_pool',
  reac: '/api/update_reac',
  enz: '/api/update_enz',
};

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
  return null;
}

function toEdge(from, to, type, i) {
  return {
    id: `e${i}-${from}-${to}-${type}`,
    source: from,
    target: to,
    style: EDGE_STYLE[type],
    data: { type },
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
  graph.nodes.forEach((n) => {
    if (n.type === 'pool') poolX[n.id] = n.x;
  });

  const subXs = {};
  const prodXs = {};
  graph.edges.forEach((e) => {
    if (e.type === 'substrate' && poolX[e.from] !== undefined) {
      if (!subXs[e.to]) subXs[e.to] = [];
      subXs[e.to].push(poolX[e.from]);
    } else if (e.type === 'product' && poolX[e.to] !== undefined) {
      if (!prodXs[e.from]) prodXs[e.from] = [];
      prodXs[e.from].push(poolX[e.to]);
    }
  });

  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const flips = {};
  graph.nodes.forEach((n) => {
    if (n.type !== 'reac' && n.type !== 'enz') return;
    const subs = subXs[n.id];
    const prods = prodXs[n.id];
    flips[n.id] = !!subs && !!prods && avg(subs) > avg(prods);
  });
  return flips;
}

function toFlowGraph(graph, scale) {
  const flips = computeInitialFlips(graph);
  const nodes = graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.x * scale, y: -n.y * scale },
    data: { ...n, flipped: flips[n.id] ?? false },
  }));
  const edges = graph.edges.map((e, i) => toEdge(e.from, e.to, e.type, i));
  return { nodes, edges };
}

export default function App() {
  const [flowGraph, setFlowGraph] = useState({ nodes: [], edges: [] });
  const [status, setStatus] = useState('loading feedback.g...');
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [activeMenu, setActiveMenu] = useState('File');
  const [plotData, setPlotData] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [lastRuntime, setLastRuntime] = useState(null);
  // Recomputed only on full graph reloads (load/reset/refresh), not on
  // incremental edits (drag, single add) -- so a drag or single new node
  // never rescales/shifts everything else already laid out.
  const [scale, setScale] = useState(DEFAULT_SCALE);

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
  }, []);

  const loadFile = useCallback(
    (path) => {
      setStatus(`loading ${path}...`);
      fetch(`${API_BASE}/api/load_gfile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
        .then((r) => r.json())
        .then(handleGraphResult)
        .catch((err) => setStatus(`error: ${err}`));
    },
    [handleGraphResult]
  );

  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    loadFile('/home/bhalla/homework/KKIT/kkit11/examples/feedback.g');
  }, [loadFile]);

  const selectedNode = useMemo(
    () => flowGraph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [flowGraph.nodes, selectedNodeId]
  );

  const onNodeClick = useCallback((event, node) => {
    if (EDITABLE_ENDPOINTS[node.type]) {
      setSelectedNodeId(node.id);
      setActiveMenu('Properties');
    }
  }, []);

  const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

  const onNodesChange = useCallback((changes) => {
    setFlowGraph((g) => ({ ...g, nodes: applyNodeChanges(changes, g.nodes) }));
  }, []);

  const onNodeDragStop = useCallback((event, node) => {
    const x = node.position.x / scale;
    const y = -node.position.y / scale;
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
  }, [scale]);

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
          setFlowGraph((g) => ({
            ...g,
            edges: [...g.edges, toEdge(conn.source, conn.target, edgeType, g.edges.length)],
          }));
        })
        .catch((err) => setStatus(`error: ${err}`));
    },
    [nodeTypeById]
  );

  const onEdgesChange = useCallback(
    (changes) => {
      changes
        .filter((change) => change.type === 'remove')
        .forEach((change) => {
          const edge = flowGraph.edges.find((e) => e.id === change.id);
          if (!edge) return;
          fetch(`${API_BASE}/api/remove_edge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: edge.source, to: edge.target, type: edge.data.type }),
          })
            .then((r) => r.json())
            .then((res) => {
              if (res.error) setStatus(`error: ${res.error}`);
            })
            .catch((err) => setStatus(`error: ${err}`));
        });
      setFlowGraph((g) => ({ ...g, edges: applyEdgeChanges(changes, g.edges) }));
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
      // `flipped` is frontend-only (not tracked by the backend/MOOSE), so
      // it's stripped before the request and reattached from what was
      // submitted -- otherwise the backend's response (which doesn't know
      // about it) would wipe it out when merged into node data.
      const { flipped, ...backendFields } = fields;
      const node = flowGraph.nodes.find((n) => n.id === nodeId);
      const endpoint = EDITABLE_ENDPOINTS[node.type];
      fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: nodeId, fields: backendFields }),
      })
        .then((r) => r.json())
        .then((updated) => {
          if (updated.error) {
            setStatus(`error: ${updated.error}`);
            return;
          }
          // Renaming an object changes its MOOSE path, which is what we use
          // as the node id -- when that happens, every reference to the old
          // id (the node itself, any edges, and the current selection) has
          // to be repointed at the new one.
          const renamed = updated.previousId && updated.previousId !== updated.id;
          setFlowGraph((g) => ({
            nodes: g.nodes.map((n) =>
              n.id === nodeId ? { ...n, id: updated.id, data: { ...updated, flipped } } : n
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
    [flowGraph.nodes, selectedNodeId]
  );

  // Re-fetches the whole graph rather than patching state locally -- used
  // after operations whose effect on the node/edge set isn't a single known
  // delta (creating an enzyme also creates a hidden complex pool; deleting a
  // pool cascades to remove its enzyme children in MOOSE). Existing nodes'
  // `flipped` state is preserved by id rather than recomputed, since the
  // heuristic is only meant to run once per node, not on every refresh.
  // Scale IS recomputed here, same as on load -- the node set just changed,
  // so re-fitting the spacing to whatever remains is the point, unlike drag
  // or single-add which intentionally keep the current scale untouched.
  const refreshGraph = useCallback(() => {
    fetch(`${API_BASE}/api/graph`)
      .then((r) => r.json())
      .then((graph) => {
        if (graph.error) {
          setStatus(`error: ${graph.error}`);
          return;
        }
        const newScale = computeAutoScale(graph);
        setScale(newScale);
        setFlowGraph((g) => {
          const existingFlipped = {};
          g.nodes.forEach((n) => {
            existingFlipped[n.id] = n.data.flipped;
          });
          const freshFlips = computeInitialFlips(graph);
          const nodes = graph.nodes.map((n) => ({
            id: n.id,
            type: n.type,
            position: { x: n.x * newScale, y: -n.y * newScale },
            data: { ...n, flipped: existingFlipped[n.id] ?? freshFlips[n.id] ?? false },
          }));
          const edges = graph.edges.map((e, i) => toEdge(e.from, e.to, e.type, i));
          return { nodes, edges };
        });
      })
      .catch((err) => setStatus(`error: ${err}`));
  }, []);

  const addNodeToGraph = useCallback((nodeData) => {
    setFlowGraph((g) => ({
      ...g,
      nodes: [
        ...g.nodes,
        {
          id: nodeData.id,
          type: nodeData.type,
          position: { x: nodeData.x * scale, y: -nodeData.y * scale },
          data: { ...nodeData, flipped: false },
        },
      ],
    }));
    setSelectedNodeId(nodeData.id);
    setActiveMenu('Properties');
  }, [scale]);

  const creationCounter = useRef(0);

  const handleAddPool = useCallback(() => {
    const n = ++creationCounter.current;
    fetch(`${API_BASE}/api/create_pool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `pool${n}`, x: n * 1.5, y: -2 }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setStatus(`error: ${res.error}`);
          return;
        }
        addNodeToGraph(res);
      })
      .catch((err) => setStatus(`error: ${err}`));
  }, [addNodeToGraph]);

  const handleAddReac = useCallback(() => {
    const n = ++creationCounter.current;
    fetch(`${API_BASE}/api/create_reac`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `reac${n}`, x: n * 1.5, y: -3 }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.error) {
          setStatus(`error: ${res.error}`);
          return;
        }
        addNodeToGraph(res);
      })
      .catch((err) => setStatus(`error: ${err}`));
  }, [addNodeToGraph]);

  const handleAddEnz = useCallback(() => {
    if (!selectedNode || selectedNode.type !== 'pool') {
      setStatus('select a pool first to attach an enzyme to it');
      return;
    }
    const n = ++creationCounter.current;
    const x = selectedNode.data.x + 0.5;
    const y = selectedNode.data.y - 1;
    fetch(`${API_BASE}/api/create_enz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentPoolId: selectedNode.id, name: `enz${n}`, x, y }),
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
  }, [selectedNode, refreshGraph]);

  const handleDeleteSelected = useCallback(() => {
    if (!selectedNodeId) return;
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
  }, [selectedNodeId, refreshGraph]);

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
        handleGraphResult(graph);
        setPlotData(null);
        setLastRuntime(null);
        setRunError(null);
      })
      .catch((err) => setRunError(String(err)));
  }, [handleGraphResult]);

  return (
    <AppLayout
      activeMenu={activeMenu}
      setActiveMenu={setActiveMenu}
      status={status}
      loadFile={loadFile}
      onGraphLoaded={handleGraphResult}
      selectedNode={selectedNode}
      onSaveNode={onSaveNode}
      onAddPool={handleAddPool}
      onAddReac={handleAddReac}
      onAddEnz={handleAddEnz}
      onDeleteSelected={handleDeleteSelected}
      onStartRun={handleStartRun}
      onResetRun={handleResetRun}
      isRunning={isRunning}
      runError={runError}
      lastRuntime={lastRuntime}
      plotData={plotData}
      flowGraph={flowGraph}
      edgeActions={edgeActions}
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
