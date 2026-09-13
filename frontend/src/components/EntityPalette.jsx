import { Box } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { ENZ_CLIP_PATH_RIGHT } from '../nodes';
import PlotSquiggleIcon from '../PlotSquiggleIcon';
import { PLOT_WINDOW_COLORS } from '../colorUtils';

// Lives directly above the reaction canvas (not in the left-side Add menu)
// so it's always visible while in layout mode, regardless of which menu box
// is open -- placing a new entity no longer means navigating away from
// wherever you already are, and the Properties panel popping up afterward
// (to edit the thing you just placed) no longer buries the palette itself.
const ICON_SIZE = { width: 56, height: 40 };

// Dragging is always enabled (drop location decides placement, and for the
// enzyme/plot icons, which pool they attach to) -- only the click-to-add
// fallback needs a pre-selected pool for the enzyme case, since a plain
// click has no drop position to hit-test against. The plot icon has no
// click fallback at all -- plotting nothing makes sense without a target.
function DragIcon({ type, onClick, clickDisabled, title, children }) {
  const handleDragStart = (event) => {
    event.dataTransfer.setData('application/kkit-node-type', type);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <Box
      draggable
      onDragStart={handleDragStart}
      onClick={clickDisabled ? undefined : onClick}
      title={title}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...ICON_SIZE,
        cursor: clickDisabled ? 'grab' : 'pointer',
        userSelect: 'none',
        flexShrink: 0,
        opacity: clickDisabled ? 0.6 : 1,
        '&:active': { cursor: 'grabbing' },
      }}
    >
      {children}
    </Box>
  );
}

function PoolIcon() {
  return (
    <Box
      sx={{
        width: 48,
        height: 26,
        border: '1px solid #333',
        borderRadius: '2px',
        background: '#8ecae6',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 'bold',
      }}
    >
      Pool
    </Box>
  );
}

function ReacIcon() {
  return (
    <Box
      sx={{
        width: 34,
        height: 34,
        borderRadius: '50%',
        border: '1px solid #333',
        background: '#ffb703',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 18,
        fontWeight: 'bold',
      }}
    >
      ↔
    </Box>
  );
}

// Same clip-path arrow shape as the real EnzNode in the layout (nodes.jsx),
// so the palette icon isn't just a lookalike.
function EnzIcon() {
  return (
    <Box sx={{ position: 'relative', width: 48, height: 32 }}>
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          background: '#fb8500',
          clipPath: ENZ_CLIP_PATH_RIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 'bold',
          pl: '2px',
          pr: '14px',
        }}
      >
        Enz
      </Box>
    </Box>
  );
}

function GroupIcon() {
  return (
    <Box
      sx={{
        width: 44,
        height: 32,
        border: '3px dashed #333',
        borderRadius: 1,
        background: 'rgba(0,0,0,0.03)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        fontWeight: 'bold',
      }}
    >
      Group
    </Box>
  );
}

// Double-walled, matching the real CompartmentNode in the layout.
function CompartmentIcon() {
  return (
    <Box sx={{ position: 'relative', width: 44, height: 32, border: '2px solid #333', borderRadius: 1 }}>
      <Box
        sx={{
          position: 'absolute',
          inset: 3,
          border: '2px solid #333',
          borderRadius: 0.5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 8,
          fontWeight: 'bold',
          textAlign: 'center',
          lineHeight: 1,
        }}
      >
        Compt
      </Box>
    </Box>
  );
}

// A static drop target for two different drag sources: (1) React Flow
// nodes dragged here are deleted -- App.jsx's onNodeDragStop hit-tests
// against this element's id at drag-stop time, since that's React Flow's
// own pointer-based dragging, not native HTML5 DnD; (2) a pool's on-canvas
// plot badge (nodes.jsx), which IS a plain native-draggable element, is
// un-plotted via this element's own onDrop below.
function TrashTarget({ onUnplot }) {
  const handleDragOver = (event) => {
    if (event.dataTransfer.types.includes('application/kkit-unplot')) {
      event.preventDefault();
    }
  };

  const handleDrop = (event) => {
    const payload = event.dataTransfer.getData('application/kkit-unplot');
    if (!payload || !onUnplot) return;
    event.preventDefault();
    const { poolId } = JSON.parse(payload);
    onUnplot(poolId);
  };

  return (
    <Box
      id="kkit-trash-target"
      title="Drag an entity (or a pool's plot badge) here to remove it"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...ICON_SIZE,
        flexShrink: 0,
        border: '1px dashed #c62828',
        borderRadius: 1,
        color: '#c62828',
        background: '#fff5f5',
      }}
    >
      <DeleteIcon />
    </Box>
  );
}

export default function EntityPalette({ onAddPool, onAddReac, onAddEnz, onUnplot, canAddEnz }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 1.5,
        py: 1,
        borderBottom: 1,
        borderColor: 'divider',
        flexShrink: 0,
        background: '#fafafa',
      }}
    >
      <DragIcon type="pool" onClick={() => onAddPool()} title="Drag onto the diagram, or click to add">
        <PoolIcon />
      </DragIcon>
      <DragIcon type="reac" onClick={() => onAddReac()} title="Drag onto the diagram, or click to add">
        <ReacIcon />
      </DragIcon>
      <DragIcon
        type="enz"
        onClick={() => onAddEnz()}
        clickDisabled={!canAddEnz}
        title={canAddEnz ? 'Drag onto a pool, or click to add' : 'Drag onto a pool to attach it'}
      >
        <EnzIcon />
      </DragIcon>
      <DragIcon type="plot1" clickDisabled title="Drag onto a pool to plot it in Plot window 1">
        <PlotSquiggleIcon width={40} height={28} traceColor={PLOT_WINDOW_COLORS[1]} />
      </DragIcon>
      <DragIcon type="plot2" clickDisabled title="Drag onto a pool to plot it in Plot window 2">
        <PlotSquiggleIcon width={40} height={28} traceColor={PLOT_WINDOW_COLORS[2]} />
      </DragIcon>
      <DragIcon type="group" clickDisabled title="Drag inside a compartment (or group) to add an organizational group">
        <GroupIcon />
      </DragIcon>
      <DragIcon type="compartment" clickDisabled title="Drag onto the diagram to add a new compartment">
        <CompartmentIcon />
      </DragIcon>

      <Box sx={{ flexGrow: 1 }} />

      <TrashTarget onUnplot={onUnplot} />
    </Box>
  );
}
