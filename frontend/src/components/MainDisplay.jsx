import { useCallback, useEffect, useRef } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import { ReactFlow, ReactFlowProvider, Background, Controls, useReactFlow, useNodesInitialized } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeTypes } from '../nodes';
import BendableEdge from '../BendableEdge';
import { EdgeActionsContext } from '../EdgeContext';
import { NodeActionsContext } from '../NodeActionsContext';
import PlotsPanel from './PlotsPanel';
import EntityPalette from './EntityPalette';

const edgeTypes = { default: BendableEdge };

// React Flow's own `fitView` prop only ever runs once, on initial mount --
// re-centering on a later load (a new file, a reset) needs an imperative
// call, triggered here off a generation counter rather than the node array
// itself so normal edits (drag, single add) never yank the user's own pan/zoom.
//
// Firing that call as soon as `generation` changes races React Flow's own
// node measurement (each node's actual on-screen width/height is only
// known after its own ResizeObserver callback fires, asynchronously w.r.t.
// React's render/commit) -- verified directly: for a small graph the race
// usually resolves in time by sheer luck, but a real ~20-node model
// reliably lost it, computing fitView's bounds against not-yet-measured
// nodes and landing on a wildly wrong pan/zoom. useNodesInitialized flips
// true only once every node has actually been measured, so gating on it
// (in addition to the generation change) waits out the race instead of
// hoping to win it.
function FitViewOnLoad({ generation }) {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const firedForGeneration = useRef(0);
  useEffect(() => {
    if (generation === 0) return;
    if (!nodesInitialized) return;
    if (firedForGeneration.current === generation) return;
    // nodesInitialized flipping true only means React Flow's own store has
    // recorded a measurement for every node -- it doesn't guarantee the
    // browser has actually finished a layout/paint pass reflecting *this*
    // set of nodes yet (verified directly: gating on nodesInitialized alone
    // still intermittently raced on a real ~20-node model). Two nested
    // rAFs is the standard way to wait out "one full frame has actually
    // been painted" rather than just "React has committed" -- the first
    // rAF fires before the browser's next paint, the second fires after
    // it, so by then layout is guaranteed settled.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        // maxZoom matters as much as padding here: fitView's own zoom
        // ceiling otherwise falls back to the pane's global maxZoom (2 by
        // default, see <ReactFlow> below) -- for a small graph (a fresh
        // model with just its one compartment, say) that means zooming in
        // to 200% to fill the viewport, which reads as "vastly enlarged",
        // not centered at a sane scale.
        //
        // Marked "fired" only now, not before scheduling -- if the effect
        // re-runs (nodesInitialized flickering) before this callback gets
        // here, the cleanup below cancels these rAFs, and the guard must
        // still be false so the next run schedules a fresh pair instead of
        // silently dropping the fit entirely.
        firedForGeneration.current = generation;
        fitView({ padding: 0.2, duration: 300, maxZoom: 1 });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [generation, nodesInitialized, fitView]);
  return null;
}

// Drag-and-drop from the Add menu's icon palette needs screenToFlowPosition
// (only available via useReactFlow, i.e. from inside a ReactFlowProvider),
// so this inner component is wrapped by one below rather than calling the
// hook directly in MainDisplay itself.
function Canvas({
  flowGraph,
  edgeActions,
  nodeActions,
  onNodeClick,
  onPaneClick,
  onNodesChange,
  onNodeDragStop,
  onConnect,
  isValidConnection,
  onEdgesChange,
  loadGeneration,
  onCanvasDrop,
}) {
  const { screenToFlowPosition } = useReactFlow();

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  // Which node (if any) the pointer is over at drop time -- used so an
  // enzyme icon dropped onto a pool attaches to it directly, matching the
  // old kkit GUI's click-and-drag placement instead of requiring a
  // separate "select a pool first" step.
  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/kkit-node-type');
      if (!type || !onCanvasDrop) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const hitEl = document.elementFromPoint(event.clientX, event.clientY)?.closest('.react-flow__node');
      const hitNodeId = hitEl?.getAttribute('data-id') ?? null;
      onCanvasDrop(type, position, hitNodeId);
    },
    [screenToFlowPosition, onCanvasDrop]
  );

  return (
    <EdgeActionsContext.Provider value={edgeActions}>
      <NodeActionsContext.Provider value={nodeActions}>
        <ReactFlow
          nodes={flowGraph.nodes}
          edges={flowGraph.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onEdgesChange={onEdgesChange}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          deleteKeyCode={['Backspace', 'Delete']}
          minZoom={0.05}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          // Dragging a node up to the trash icon (which sits in the palette
          // bar above the canvas, outside the pane) would otherwise trigger
          // React Flow's default auto-pan-near-the-edge behavior, panning the
          // whole view during the drag -- the trash drop itself is detected
          // by a plain DOM hit-test (App.jsx's isOverTrash), not by the node
          // needing to visually reach anything inside the pane, so autopan
          // here only gets in the way.
          autoPanOnNodeDrag={false}
        >
          <Background />
          <Controls />
          <FitViewOnLoad generation={loadGeneration} />
        </ReactFlow>
      </NodeActionsContext.Provider>
    </EdgeActionsContext.Provider>
  );
}

export default function MainDisplay({
  flowGraph,
  edgeActions,
  nodeActions,
  onNodeClick,
  onPaneClick,
  onNodesChange,
  onNodeDragStop,
  onConnect,
  isValidConnection,
  onEdgesChange,
  plotData,
  loadGeneration,
  onCanvasDrop,
  onAddPool,
  onAddReac,
  onAddEnz,
  onUnplot,
  selectedNode,
  displayTab,
  setDisplayTab,
}) {
  const canAddEnz = selectedNode?.type === 'pool' && !selectedNode.data.isEnzComplex;

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#f5f5f5',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      <Box sx={{ borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Tabs value={displayTab} onChange={(e, v) => setDisplayTab(v)}>
          <Tab label="Reaction Layout" />
          <Tab label="Plots" />
        </Tabs>
      </Box>
      <Box
        sx={{
          flexGrow: 1,
          position: 'relative',
          display: displayTab === 0 ? 'flex' : 'none',
          flexDirection: 'column',
        }}
      >
        <EntityPalette
          onAddPool={onAddPool}
          onAddReac={onAddReac}
          onAddEnz={onAddEnz}
          onUnplot={onUnplot}
          canAddEnz={canAddEnz}
        />
        <Box sx={{ flexGrow: 1, position: 'relative' }}>
          <ReactFlowProvider>
            <Canvas
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
              loadGeneration={loadGeneration}
              onCanvasDrop={onCanvasDrop}
            />
          </ReactFlowProvider>
        </Box>
      </Box>
      <Box sx={{ flexGrow: 1, position: 'relative', display: displayTab === 1 ? 'block' : 'none' }}>
        <PlotsPanel plotData={plotData} nodes={flowGraph.nodes} />
      </Box>
    </Box>
  );
}
