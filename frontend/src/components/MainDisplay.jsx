import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import { ReactFlow, ReactFlowProvider, Background, Controls, ControlButton, useReactFlow, useNodesInitialized } from '@xyflow/react';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import ZoomInMapIcon from '@mui/icons-material/ZoomInMap';
import '@xyflow/react/dist/style.css';
import { nodeTypes } from '../nodes';
import BendableEdge from '../BendableEdge';
import { EdgeActionsContext } from '../EdgeContext';
import { NodeActionsContext } from '../NodeActionsContext';
import PlotsPanel from './PlotsPanel';
import EntityPalette from './EntityPalette';

const edgeTypes = { default: BendableEdge };

// The user's own later request: move the visualization-mode controls out
// of the palette bar above the canvas and into this floating panel
// instead, alongside React Flow's own zoom/Fit View/Lock buttons -- see
// <Controls> below. Every icon here is a plain inline SVG (no MUI icon
// matches these shapes) sized to sit comfortably in a Controls button.
function GroupConnectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="1" y="8" width="8" height="8" rx="1" />
      <rect x="15" y="8" width="8" height="8" rx="1" />
      <line x1="9" y1="12" x2="15" y2="12" />
    </svg>
  );
}

function DetailedConnectIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="1" y="4" width="8" height="16" rx="1" />
      <rect x="15" y="4" width="8" height="16" rx="1" />
      <line x1="5" y1="9" x2="19" y2="9" />
      <line x1="5" y1="15" x2="19" y2="15" />
      <circle cx="5" cy="9" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="5" cy="15" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19" cy="9" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="19" cy="15" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IsolatedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="6" y="6" width="12" height="12" rx="1" />
      <circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="14" cy="10" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="10" cy="14" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="14" cy="14" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

function DecoratedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="8" y="8" width="8" height="8" rx="1" />
      <circle cx="10.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="13.5" cy="13.5" r="1" fill="currentColor" stroke="none" />
      <line x1="8" y1="8" x2="2" y2="2" />
      <line x1="16" y1="8" x2="22" y2="2" />
      <line x1="8" y1="16" x2="2" y2="22" />
      <line x1="16" y1="16" x2="22" y2="22" />
      <line x1="12" y1="8" x2="12" y2="1" />
      <circle cx="2" cy="2" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="22" cy="2" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="2" cy="22" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="22" cy="22" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="1" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

const VISUAL_MODE_ICON = {
  groupConnect: <GroupConnectIcon />,
  detailedConnect: <DetailedConnectIcon />,
  isolated: <IsolatedIcon />,
  decorated: <DecoratedIcon />,
};

const VISUAL_MODE_TITLE = {
  groupConnect: 'GroupConnect: inter-group connections shown as summary lines (only meaningful once inner groups are collapsed) -- click to cycle mode',
  detailedConnect: 'DetailedConnect: every real pool/non-pool connection shown even across group boundaries; collapsed groups shown without connections -- click to cycle mode',
  isolated: 'Isolated: only connections fully within one expanded group are shown; collapsed groups shown without connections -- click to cycle mode',
  decorated: 'Decorated: proxy icons decorate each expanded group to show what its contents connect to; collapsed groups shown without connections -- click to cycle mode',
};

// How long to wait for useNodesInitialized before fitting anyway -- see
// the fallback-timeout note below. Comfortably longer than any real
// measurement race takes to resolve, short enough that a genuinely-stuck
// case (see below) doesn't read as broken.
const FIT_VIEW_FALLBACK_MS = 600;

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
//
// With onlyRenderVisibleElements on (see <ReactFlow> below), a node that
// starts outside the *default* viewport never mounts, so never measures,
// so useNodesInitialized would never flip true at all for any model
// bigger than the initial view -- exactly the large-model case this needs
// to handle. The FIT_VIEW_FALLBACK_MS timer breaks that deadlock: if
// nodesInitialized hasn't happened by then, fit anyway against whatever's
// known so far (fitView's own bounds computation already falls back to a
// zero-size point for anything unmeasured, per @xyflow/system's nodeToBox
// -- position is always known even for a node that's never rendered, so
// the result is still a reasonable, if very slightly conservative, fit).
function FitViewOnLoad({ generation }) {
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const firedForGeneration = useRef(0);
  useEffect(() => {
    if (generation === 0) return;
    if (firedForGeneration.current === generation) return;

    let raf1 = 0;
    let raf2 = 0;
    let fallbackTimer = 0;
    const runFit = () => {
      // nodesInitialized flipping true (or the fallback timer firing)
      // only means measurement has settled as far as it's going to --
      // it doesn't guarantee the browser has actually finished a layout/
      // paint pass reflecting *this* set of nodes yet (verified directly:
      // gating on nodesInitialized alone still intermittently raced on a
      // real ~20-node model). Two nested rAFs is the standard way to wait
      // out "one full frame has actually been painted" rather than just
      // "React has committed" -- the first rAF fires before the browser's
      // next paint, the second fires after it, so by then layout is
      // guaranteed settled.
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          // maxZoom matters as much as padding here: fitView's own zoom
          // ceiling otherwise falls back to the pane's global maxZoom (2
          // by default, see <ReactFlow> below) -- for a small graph (a
          // fresh model with just its one compartment, say) that means
          // zooming in to 200% to fill the viewport, which reads as
          // "vastly enlarged", not centered at a sane scale.
          //
          // Marked "fired" only now, not before scheduling -- if the
          // effect re-runs (nodesInitialized flickering) before this
          // callback gets here, the cleanup below cancels everything, and
          // the guard must still be false so the next run schedules a
          // fresh attempt instead of silently dropping the fit entirely.
          firedForGeneration.current = generation;
          fitView({ padding: 0.2, duration: 300, maxZoom: 1 });
        });
      });
    };

    if (nodesInitialized) {
      runFit();
    } else {
      fallbackTimer = setTimeout(runFit, FIT_VIEW_FALLBACK_MS);
    }
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(fallbackTimer);
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
  onNodeDragStart,
  onNodeDragStop,
  onConnect,
  isValidConnection,
  onEdgesChange,
  loadGeneration,
  onCanvasDrop,
  onSetAllCollapsed,
  visualMode,
  onCycleVisualMode,
  selectedNodeId,
}) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  // Only enabled once the selected node is actually part of what's
  // currently rendered -- a plain entity hidden inside a collapsed group,
  // or something no longer selected at all, has no on-screen box for
  // fitView's own `nodes` filter to fit to.
  const selectedNodeVisible = !!selectedNodeId && flowGraph.nodes.some((n) => n.id === selectedNodeId);
  const handleZoomToSelected = useCallback(() => {
    if (!selectedNodeId) return;
    // A smaller padding than the whole-model Fit View above (0.2) -- the
    // user's own later request was specifically that the selected group
    // "occupies most of the view area", not just any old fit.
    fitView({ nodes: [{ id: selectedNodeId }], padding: 0.08, duration: 300, maxZoom: 12 });
  }, [selectedNodeId, fitView]);
  // Purely local UI memory for which icon the expand/collapse-all toggle
  // shows next -- onSetAllCollapsed itself is a one-shot bulk action, not
  // a persisted mode (see App.jsx's own comment on it), so there's
  // nothing authoritative to derive this from; the user's own later note
  // that individual groups can still be toggled independently afterward
  // means this is only ever a starting nudge, not a source of truth.
  const [allCollapsed, setAllCollapsedLocal] = useState(false);
  const handleToggleAllCollapsed = useCallback(() => {
    // A state updater function must stay pure -- calling another
    // component's own setter (onSetAllCollapsed, which ultimately reaches
    // App.jsx's setFlowGraph) from inside one is what actually triggered
    // "Cannot update a component while rendering a different component"
    // (verified directly). Reading the current `allCollapsed` from the
    // closure instead and firing both setters as plain, separate
    // statements avoids that entirely -- safe here since this only ever
    // runs from a click handler, never anywhere staleness could matter.
    const next = !allCollapsed;
    setAllCollapsedLocal(next);
    onSetAllCollapsed(next);
  }, [allCollapsed, onSetAllCollapsed]);

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
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onEdgesChange={onEdgesChange}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          deleteKeyCode={['Backspace', 'Delete']}
          // The user's own later bug report: Fit View (and even plain
          // mouse-wheel/trackpad zoom) didn't zoom out enough to include a
          // root compartment's own label for a model with a very large
          // native coordinate scale (Vinu_23Sep_with_gr.g) -- verified
          // directly that the viewport was landing on EXACTLY 0.005, this
          // prop's own old floor, not some smaller value fitView's own
          // bounds math actually wanted: the label sits *above* the
          // container's own box (see nodes.jsx's ContainerNode, `bottom:
          // '100%'`), which grows however far outside whatever box
          // React Flow itself measures, so a model whose real content
          // already needs to be zoomed out close to this floor has no
          // room left for fitView to additionally back off far enough to
          // include it -- lowering the floor itself is what actually
          // gives it that room, for both Fit View and manual zoom alike
          // (both are capped by this exact same prop).
          minZoom={0.0002}
          // Raised from 2 -- the new "zoom to selected group" action (see
          // Canvas's own handleZoomToSelected) needs real headroom to
          // zoom a small, tightly-sized collapsed group icon in enough to
          // actually fill most of the view; the pane's own zoom ceiling
          // is a hard limit fitView can't exceed regardless of its own
          // maxZoom option, so raising it here is what actually gives
          // that action (and, incidentally, plain manual zoom-in) the
          // room it needs.
          maxZoom={12}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          // Off by default in React Flow -- without it, every node/edge
          // stays mounted in the DOM regardless of the current pan/zoom,
          // which is what made panning/zooming a large model (hundreds of
          // nodes) sluggish even though the *visible* portion on screen at
          // any moment is small. See FitViewOnLoad's own fallback-timeout
          // handling above for the one thing this trades off (nodes
          // outside the initial view never get measured until they
          // actually scroll into it).
          onlyRenderVisibleElements
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
          <Controls>
            <ControlButton
              onClick={handleToggleAllCollapsed}
              title={allCollapsed ? 'Expand every group/compartment' : 'Collapse every group/compartment'}
            >
              {allCollapsed ? <UnfoldMoreIcon fontSize="small" /> : <UnfoldLessIcon fontSize="small" />}
            </ControlButton>
            <ControlButton onClick={onCycleVisualMode} title={VISUAL_MODE_TITLE[visualMode]}>
              {VISUAL_MODE_ICON[visualMode]}
            </ControlButton>
            <ControlButton
              onClick={handleZoomToSelected}
              disabled={!selectedNodeVisible}
              title="Zoom to the selected group, filling most of the view"
            >
              <ZoomInMapIcon fontSize="small" />
            </ControlButton>
          </Controls>
          <FitViewOnLoad generation={loadGeneration} />
        </ReactFlow>
      </NodeActionsContext.Provider>
    </EdgeActionsContext.Provider>
  );
}

export default function MainDisplay({
  flowGraph,
  displayGraph,
  edgeActions,
  nodeActions,
  onNodeClick,
  onPaneClick,
  onNodesChange,
  onNodeDragStart,
  onNodeDragStop,
  onConnect,
  isValidConnection,
  onEdgesChange,
  plotData,
  doseCurve,
  findSimCurve,
  loadGeneration,
  onCanvasDrop,
  onAddPool,
  onAddReac,
  onAddEnz,
  onUnplot,
  onSetAllCollapsed,
  visualMode,
  onCycleVisualMode,
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
              flowGraph={displayGraph}
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
              loadGeneration={loadGeneration}
              onCanvasDrop={onCanvasDrop}
              onSetAllCollapsed={onSetAllCollapsed}
              visualMode={visualMode}
              onCycleVisualMode={onCycleVisualMode}
              selectedNodeId={selectedNode?.id}
            />
          </ReactFlowProvider>
        </Box>
      </Box>
      <Box sx={{ flexGrow: 1, position: 'relative', display: displayTab === 1 ? 'block' : 'none' }}>
        <PlotsPanel plotData={plotData} nodes={flowGraph.nodes} doseCurve={doseCurve} findSimCurve={findSimCurve} />
      </Box>
    </Box>
  );
}
