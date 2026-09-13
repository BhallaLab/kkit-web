import { useContext, useEffect } from 'react';
import { Handle, NodeResizer, Position, useUpdateNodeInternals } from '@xyflow/react';
import { getContrastTextColor, PLOT_WINDOW_COLORS } from './colorUtils';
import PlotSquiggleIcon from './PlotSquiggleIcon';
import { NodeActionsContext } from './NodeActionsContext';

// Flipping swaps which side of the node a handle renders on (see
// SubstrateHandle/ProductHandle/ChanInHandle/ChanOutHandle below) without
// changing the node's own overall box -- React Flow only re-measures a
// handle's actual screen position via its own internal ResizeObserver,
// which fires on a *size* change, not a handle moving to the opposite
// edge within the same-size box. Left alone, an edge keeps rendering from
// the handle's old (pre-flip) position until something else forces a
// remeasure -- this is exactly what useUpdateNodeInternals is for
// (verified against its own doc comment: "When you... update a node's
// handle position, you need to let React Flow know about it using this
// hook"), called here whenever a node's own flipped flag changes.
function useFlipRemeasure(id, flipped) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, flipped, updateNodeInternals]);
}

const baseStyle = {
  padding: '4px 10px',
  fontSize: 28,
  border: '1px solid #333',
};

// An enzyme's hidden "cplx" pool is an implementation detail, not a
// molecule the user manages directly -- rendered at a fraction of a normal
// pool's size (real font/padding values, not a CSS transform, since a
// transform wouldn't change what React Flow's ResizeObserver measures, and
// Handles would end up anchored to the pre-transform box instead of the
// visibly smaller one).
const complexPoolStyle = {
  padding: '1px 5px',
  fontSize: 12,
  border: '1px solid #333',
};

function selectedStyle(selected) {
  return selected ? { boxShadow: '0 0 0 3px #1a73e8' } : {};
}

// box-shadow would be cut off by clip-path (it only shows within the
// clipped silhouette), so the enzyme shape needs a filter-based glow, which
// is applied to the rendered shape after clipping instead.
function selectedGlow(selected) {
  return selected ? { filter: 'drop-shadow(0 0 3px #1a73e8) drop-shadow(0 0 3px #1a73e8)' } : {};
}

// The Handle itself *is* the triangle (a CSS border-trick shape), not a
// wrapper box with a separately-positioned decorative child. React Flow's
// connection-drag gesture is wired to the Handle element specifically -- a
// plain sibling div never participates in it regardless of styling -- so
// splitting "the clickable thing" from "the visible thing" only invites
// them to disagree about where they are. Making them the same element
// means the anchor point, the visible shape, and the click/drag hit-area
// are all one box by construction. Several of react-flow's own default
// handle styles (min-width/height, border, border-radius, background) are
// overridden explicitly here since they'd otherwise fight the border-trick
// geometry (e.g. a stray 1px border-right left over on a "rightward"
// triangle would blunt its point).
const triangleCommon = {
  position: 'absolute',
  top: '50%',
  width: 0,
  height: 0,
  minWidth: 0,
  minHeight: 0,
  background: 'transparent',
  borderRadius: 0,
  borderTop: '7px solid transparent',
  borderBottom: '7px solid transparent',
  transform: 'translateY(-50%)',
};

// Rightward (base-left/tip-right, ▶) and leftward (base-right/tip-left, ◀)
// triangles -- an actual mirror-image shape, not a transformed copy of the
// same one, so it stays a real DOM measurement React Flow can anchor to.
const triangleRight = { ...triangleCommon, borderLeft: '11px solid #333', borderRight: 'none' };
const triangleLeft = { ...triangleCommon, borderRight: '11px solid #333', borderLeft: 'none' };

const dotHandleStyle = {
  width: 8,
  height: 8,
  background: '#555',
  border: '1px solid #333',
};

// Explicit per-case geometry for a flippable arrow handle, rather than
// visually mirroring one shared handle with a CSS transform: React Flow
// only re-measures a handle's anchor point when its actual box changes
// (via ResizeObserver), which a same-size `transform: scaleX(-1)` never
// triggers -- so a transformed handle looks flipped but keeps connecting
// from its stale, pre-flip position. Rendering a genuinely different
// handle (own Position, own mirrored triangle, own offset) for the flipped
// case keeps everything consistent with what's actually on screen.
//
// Substrate is always a connection *target*, product always a *source* --
// that's fixed regardless of flip. `position` is chosen purely to pick
// which edge of this shape (left or right) React Flow reads as the anchor
// -- since every other visual placement detail is set explicitly here, it
// no longer needs to match which side the triangle visually renders on:
// left-side triangles anchor on their own right edge (Position.Right),
// right-side ones on their own left edge (Position.Left) -- in both cases,
// that's the edge that ends up touching the node's true boundary.
function ArrowHandle({ type, id, side, pointsRight }) {
  // The Position prop (chosen above for anchor purposes) also adds React
  // Flow's default -left/-right CSS class, which sets its own default
  // left:0 or right:0 -- left unresolved, that conflicts with our own
  // offset and the browser's over-constraint tie-break silently wins.
  // Expressing both cases purely via `left` (using `left: '100%'`, which
  // for an absolutely-positioned element means "the containing block's
  // right edge", rather than switching to the `right` property) sidesteps
  // that ambiguity entirely -- `right` is never touched, so there's nothing
  // left for the class's default to conflict with.
  const anchorPosition = side === 'left' ? Position.Right : Position.Left;
  const glyph = pointsRight ? triangleRight : triangleLeft;
  const offset = { left: side === 'left' ? '-11px' : '100%', right: 'auto' };
  return <Handle type={type} position={anchorPosition} id={id} style={{ ...glyph, ...offset }} />;
}

function SubstrateHandle({ flipped }) {
  return (
    <ArrowHandle
      type="target"
      id="substrate"
      side={flipped ? 'right' : 'left'}
      pointsRight={!flipped}
    />
  );
}

function ProductHandle({ flipped }) {
  return (
    <ArrowHandle
      type="source"
      id="product"
      side={flipped ? 'left' : 'right'}
      pointsRight={!flipped}
    />
  );
}

export function PoolNode({ id, data, selected }) {
  const flipped = !!data.flipped;
  useFlipRemeasure(id, flipped);
  const style = data.isEnzComplex ? complexPoolStyle : baseStyle;

  const handleBadgeDragStart = (event) => {
    event.dataTransfer.setData('application/kkit-unplot', JSON.stringify({ poolId: id }));
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    // The extra wrapper (rather than putting the badge directly alongside
    // the styled div) keeps its own box exactly the size of the pool
    // rectangle -- the badge is positioned absolutely and protrudes outside
    // it, which doesn't enlarge an inline-block parent's own layout size,
    // so the Handles below are unaffected by whether the badge is showing.
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <div
        style={{
          ...style,
          ...selectedStyle(selected),
          background: data.color,
          color: getContrastTextColor(data.color),
          borderRadius: 2,
        }}
      >
        {/* An enzyme's hidden complex pool is never a connection endpoint
            -- no substrate/product handles at all, so nothing can drag a
            reaction/enzyme/channel edge onto it (it can still be plotted,
            which isn't handle-based). */}
        {!data.isEnzComplex && (
          <>
            <Handle type="target" position={flipped ? Position.Right : Position.Left} />
            <Handle type="source" position={flipped ? Position.Left : Position.Right} />
          </>
        )}
        {data.name}
      </div>
      {data.plotWindow && (
        // Draggable (native HTML5 DnD, not React Flow's node dragging,
        // since this is a plain child element) so it can be dragged onto
        // the palette's trash icon to un-plot -- see EntityPalette.jsx's
        // TrashTarget and App.jsx's handleUnplot.
        <div
          draggable
          onDragStart={handleBadgeDragStart}
          title="Drag to the trash icon above to un-plot"
          style={{ position: 'absolute', top: -40, right: -40, cursor: 'grab' }}
        >
          <PlotSquiggleIcon width={36} height={26} traceColor={PLOT_WINDOW_COLORS[data.plotWindow]} />
        </div>
      )}
    </div>
  );
}

export function ReacNode({ id, data, selected }) {
  const flipped = !!data.flipped;
  useFlipRemeasure(id, flipped);
  return (
    <div
      style={{
        ...baseStyle,
        ...selectedStyle(selected),
        background: data.color,
        color: getContrastTextColor(data.color),
        borderRadius: '50%',
        textAlign: 'center',
        fontSize: 48,
      }}
    >
      <SubstrateHandle flipped={flipped} />
      <ProductHandle flipped={flipped} />
      &#8596;
    </div>
  );
}

// A horizontal block arrow: substrate connects at the base, product at the
// tip, and the enzyme's parent-pool link sits on the long top edge of the
// shaft. Flipping swaps in a genuinely mirrored clip-path (arrowhead on the
// other side) rather than transforming the same one, for the same reason
// the handles use separate geometry above.
// Exported so the Add palette's enzyme icon (EntityPalette.jsx) can render
// the exact same arrow shape rather than a separately-drawn lookalike.
export const ENZ_CLIP_PATH_RIGHT = 'polygon(0% 25%, 65% 25%, 65% 0%, 100% 50%, 65% 100%, 65% 75%, 0% 75%)';
const ENZ_CLIP_PATH_LEFT = 'polygon(100% 25%, 35% 25%, 35% 0%, 0% 50%, 35% 100%, 35% 75%, 100% 75%)';

export function EnzNode({ id, data, selected }) {
  const flipped = !!data.flipped;
  useFlipRemeasure(id, flipped);
  return (
    // The clip-path lives on an inner decorative layer, not this outer
    // container -- otherwise it would also clip away the substrate/product
    // triangles, which deliberately protrude outside the visible shape.
    // Box scaled up along with the doubled font size below -- otherwise
    // the bigger name text would get clipped by the arrowhead shape.
    <div style={{ position: 'relative', boxSizing: 'border-box', width: 110, height: 80 }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: data.color,
          color: getContrastTextColor(data.color),
          fontWeight: 'bold',
          fontSize: 26,
          clipPath: flipped ? ENZ_CLIP_PATH_LEFT : ENZ_CLIP_PATH_RIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingLeft: flipped ? 14 : 4,
          paddingRight: flipped ? 4 : 14,
          ...selectedGlow(selected),
        }}
      >
        {data.name}
      </div>
      <SubstrateHandle flipped={flipped} />
      <ProductHandle flipped={flipped} />
      {/* the arrow's visible top edge sits at 25% down, not at y=0 -- the
          top corners are cut away by the clip-path's arrowhead notch. Keeps
          the same straddle-the-boundary look as the pool handles. The 30/70
          split mirrors along with the shaft, which moves from [0,65]% to
          [35,100]% when flipped. */}
      <Handle
        type="target"
        position={Position.Top}
        id="enzSite"
        style={{
          ...dotHandleStyle,
          left: flipped ? '70%' : '30%',
          top: '25%',
          transform: 'translate(-50%, -50%)',
        }}
      />
    </div>
  );
}

// A ConcChan sits between its parent pool (structural link, like an
// enzyme's substrate) and its in/out exchange pair -- drawn as a hollow
// cylinder lying on its side (two rails plus open, colored end caps, with
// nothing filling the middle) rather than a solid shape, to read as an
// actual pore/tube things flow through. Three handles, arranged like an
// enzyme's but rotated: a dot below for the structural parent link
// (mirrors EnzNode's enzSite, but on the opposite edge), and left/right
// arrow handles for influx/efflux that swap sides on flip exactly the way
// SubstrateHandle/ProductHandle do, so the two arrows never cross.
const CONC_CHAN_SIZE = { width: 128, height: 60 };

function ChanInHandle({ flipped }) {
  return <ArrowHandle type="target" id="chanIn" side={flipped ? 'right' : 'left'} pointsRight={!flipped} />;
}

function ChanOutHandle({ flipped }) {
  return <ArrowHandle type="source" id="chanOut" side={flipped ? 'left' : 'right'} pointsRight={!flipped} />;
}

export function ConcChanNode({ id, data, selected }) {
  const flipped = !!data.flipped;
  useFlipRemeasure(id, flipped);
  const { width, height } = CONC_CHAN_SIZE;
  const capRx = 10;
  const railY = 6;
  return (
    <div style={{ position: 'relative', width, height }}>
      <svg
        width={width}
        height={height}
        style={{ position: 'absolute', inset: 0, overflow: 'visible', ...selectedGlow(selected) }}
      >
        <line x1={capRx} y1={railY} x2={width - capRx} y2={railY} stroke="#333" strokeWidth="2" />
        <line x1={capRx} y1={height - railY} x2={width - capRx} y2={height - railY} stroke="#333" strokeWidth="2" />
        <ellipse cx={capRx} cy={height / 2} rx={capRx - 1} ry={height / 2 - railY} fill={data.color} stroke="#333" strokeWidth="2" />
        <ellipse
          cx={width - capRx}
          cy={height / 2}
          rx={capRx - 1}
          ry={height / 2 - railY}
          fill={data.color}
          stroke="#333"
          strokeWidth="2"
        />
      </svg>
      <Handle
        type="target"
        position={Position.Bottom}
        id="chanParent"
        style={{ ...dotHandleStyle, left: '50%', top: '100%', transform: 'translate(-50%, -50%)' }}
      />
      <ChanInHandle flipped={flipped} />
      <ChanOutHandle flipped={flipped} />
      {/* The name sits inside the hollow of the tube, between the two
          rails, rather than floating above it. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 'bold',
          pointerEvents: 'none',
        }}
      >
        {data.name}
      </div>
    </div>
  );
}

// A Stimulus is a lightning bolt with a single handle at its tip, wired at
// creation time to whichever pool it was dropped onto (see
// App.jsx's handleAddStim) -- not itself re-connectable by dragging, same
// as an enzyme's structural parent link.
export const STIM_CLIP_PATH = 'polygon(55% 0%, 15% 55%, 45% 55%, 30% 100%, 85% 40%, 55% 40%)';

export function StimNode({ data, selected }) {
  return (
    <div style={{ position: 'relative', width: 46, height: 56 }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: data.color,
          clipPath: STIM_CLIP_PATH,
          ...selectedGlow(selected),
        }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="stimTip"
        style={{ ...dotHandleStyle, left: '38%', top: '95%', transform: 'translate(-50%, -50%)' }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: -16,
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 11,
          fontWeight: 'bold',
          whiteSpace: 'nowrap',
        }}
      >
        {data.name}
      </div>
    </div>
  );
}

// Groups and compartments are containers, not molecules -- rendered as a
// box behind their contents (see App.jsx's zIndex/parentId wiring) with a
// name label and a manual resize handle. Compartment gets a second inset
// border (a "double-walled box") to read as visually distinct from a plain
// organizational group.
function ContainerNode({ id, data, selected, doubleWalled }) {
  const { onContainerResize } = useContext(NodeActionsContext);
  const handleResizeEnd = (event, params) => {
    onContainerResize(id, { x: params.x, y: params.y, width: params.width, height: params.height });
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        boxSizing: 'border-box',
        // A group is a single dashed line (purely organizational, no
        // volume); a compartment is a solid double-walled box -- distinct
        // enough at a glance that they don't read as the same kind of box.
        border: doubleWalled ? '2px solid #333' : '3px dashed #333',
        borderRadius: 4,
        background: data.color && data.color !== 'white' ? data.color : 'rgba(0,0,0,0.03)',
      }}
    >
      {doubleWalled && (
        <div
          style={{
            position: 'absolute',
            inset: 5,
            border: '2px solid #333',
            borderRadius: 2,
            pointerEvents: 'none',
          }}
        />
      )}
      <div
        style={{
          position: 'absolute',
          top: -22,
          left: 2,
          fontSize: 14,
          fontWeight: 'bold',
          whiteSpace: 'nowrap',
        }}
      >
        {data.name}
      </div>
      <NodeResizer nodeId={id} isVisible={selected} minWidth={60} minHeight={40} onResizeEnd={handleResizeEnd} />
    </div>
  );
}

export function GroupNode(props) {
  return <ContainerNode {...props} doubleWalled={false} />;
}

export function CompartmentNode(props) {
  return <ContainerNode {...props} doubleWalled />;
}

export const nodeTypes = {
  pool: PoolNode,
  reac: ReacNode,
  enz: EnzNode,
  concchan: ConcChanNode,
  stim: StimNode,
  // Registered as "kkitGroup", not "group" -- React Flow reserves the
  // literal type "group" for its own built-in group-node feature and
  // auto-applies a default CSS border to it (see App.jsx's
  // REACT_FLOW_NODE_TYPE remap, which is what actually produces this key).
  kkitGroup: GroupNode,
  compartment: CompartmentNode,
};
