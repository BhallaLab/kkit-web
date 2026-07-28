import { useState } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import { ReactFlow, Background, Controls, MiniMap } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeTypes } from '../nodes';
import BendableEdge from '../BendableEdge';
import { EdgeActionsContext } from '../EdgeContext';
import PlotsPanel from './PlotsPanel';

const edgeTypes = { default: BendableEdge };

export default function MainDisplay({
  flowGraph,
  edgeActions,
  onNodeClick,
  onPaneClick,
  onNodesChange,
  onNodeDragStop,
  onConnect,
  isValidConnection,
  onEdgesChange,
  plotData,
}) {
  const [tabIndex, setTabIndex] = useState(0);

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
        <Tabs value={tabIndex} onChange={(e, v) => setTabIndex(v)}>
          <Tab label="Reaction Layout" />
          <Tab label="Plots" />
        </Tabs>
      </Box>
      <Box sx={{ flexGrow: 1, position: 'relative', display: tabIndex === 0 ? 'block' : 'none' }}>
        <EdgeActionsContext.Provider value={edgeActions}>
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
            deleteKeyCode={['Backspace', 'Delete']}
            minZoom={0.05}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </EdgeActionsContext.Provider>
      </Box>
      <Box sx={{ flexGrow: 1, position: 'relative', display: tabIndex === 1 ? 'block' : 'none' }}>
        <PlotsPanel plotData={plotData} nodes={flowGraph.nodes} />
      </Box>
    </Box>
  );
}
