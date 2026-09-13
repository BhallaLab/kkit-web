import { useCallback, useEffect } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import { ReactFlow, ReactFlowProvider, Background, Controls, useReactFlow } from '@xyflow/react';
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
function FitViewOnLoad({ generation }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (generation === 0) return;
    fitView({ padding: 0.2, duration: 300 });
  }, [generation, fitView]);
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
          fitView
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
