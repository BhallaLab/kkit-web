import { Fragment, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { Handle, NodeResizer, Position, useStoreApi, useUpdateNodeInternals } from '@xyflow/react';
import { getContrastTextColor, paleColor, PLOT_WINDOW_COLORS, resolveGroupColor } from './colorUtils';
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
//
// Skips the very first (mount) run -- a freshly-mounted node's handles
// already render in the *correct* position for whatever `flipped` value
// it mounted with, same as any other prop; there's nothing stale to fix
// up yet, only an actual *change* on an already-mounted node (the user
// toggling the Properties checkbox) needs a remeasure. Verified directly
// that skipping it here was the fix for a large model (~600 nodes)
// otherwise locking up the whole tab for 15+ seconds on load: every node
// firing this unconditionally on mount means hundreds of
// updateNodeInternals calls in the same commit, each forcing a
// synchronous layout read against the (by then large) DOM -- real layout
// thrashing, and the actual reason this got dramatically worse than
// linearly with model size.
function useFlipRemeasure(id, flipped) {
  const updateNodeInternals = useUpdateNodeInternals();
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
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

// A fixed 110px shaft was tight enough that anything longer than a short
// name got clipped by the arrowhead notch (the clip-path's own shape, not
// text overflow CSS, so there was nothing to just enable). Grown from name
// length instead, the same rough per-character estimate PoolNode's own
// (also text-driven) size uses -- the clip-path polygon is defined in
// percentages of the box, so a wider box just stretches the same arrow
// shape proportionally rather than needing new geometry.
const ENZ_HEIGHT = 80;
const ENZ_MIN_WIDTH = 110;

export function EnzNode({ id, data, selected }) {
  const flipped = !!data.flipped;
  useFlipRemeasure(id, flipped);
  const width = Math.max(ENZ_MIN_WIDTH, 24 + (data.name?.length ?? 0) * 15);

  // An enzyme's hidden complex pool is plotted via *this* icon (see
  // App.jsx's handleCanvasDrop/handleUnplot) rather than needing its own
  // canvas presence -- data.complexPoolId/complexPlotWindow are stashed
  // here by buildFlowNodes precisely so this one badge can stand in for
  // it, the same "drag to the trash to un-plot" affordance PoolNode's own
  // badge offers, just carrying the complex pool's real id as its payload
  // instead of this enzyme's own.
  const handleBadgeDragStart = (event) => {
    event.dataTransfer.setData('application/kkit-unplot', JSON.stringify({ poolId: data.complexPoolId }));
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    // The clip-path lives on an inner decorative layer, not this outer
    // container -- otherwise it would also clip away the substrate/product
    // triangles, which deliberately protrude outside the visible shape.
    // Box scaled up along with the doubled font size below -- otherwise
    // the bigger name text would get clipped by the arrowhead shape.
    <div style={{ position: 'relative', boxSizing: 'border-box', width, height: ENZ_HEIGHT }}>
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
      {/* The structural link to the enzyme's own parent pool, at the
          bottom edge (mirroring the arrow's own bottom notch at 75% down,
          the same distance from the shaft's edge as the top notch the
          handle used to sit on) so it reads as "attached to the molecule
          underneath", not competing visually with the substrate/product
          arrows on the left/right. The 30/70 split still mirrors along
          with the shaft on flip, moving from [0,65]% to [35,100]%. */}
      <Handle
        type="target"
        position={Position.Bottom}
        id="enzSite"
        style={{
          ...dotHandleStyle,
          left: flipped ? '70%' : '30%',
          top: '75%',
          transform: 'translate(-50%, -50%)',
        }}
      />
      {data.complexPlotWindow && (
        <div
          draggable
          onDragStart={handleBadgeDragStart}
          title="Drag to the trash icon above to un-plot"
          style={{ position: 'absolute', top: -40, right: -40, cursor: 'grab' }}
        >
          <PlotSquiggleIcon width={36} height={26} traceColor={PLOT_WINDOW_COLORS[data.complexPlotWindow]} />
        </div>
      )}
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
//
// Collapsing a container (data.collapsed) hides its *contents* only --
// computeCollapsedView (collapseView.js) is what removes its descendants
// from the rendered node list -- never its own on-screen box, which keeps
// whatever real/auto-fit size buildFlowNodes gave it either way (see
// App.jsx's own comment on that): reorganizing a big model by collapsing
// groups first shouldn't mean re-guessing each one's footprint once it's
// expanded again. So collapsed and expanded share this exact same
// component and geometry, differing only in background fill (a diagonal
// hatch stands in for "closed, nothing to see inside" -- otherwise an
// empty collapsed box would be visually identical to a genuinely empty
// expanded one).
//
// The whole box's interior is pointerEvents:'none' regardless of collapsed
// state -- only the border itself (four hit-strips, each a bit more
// generous than the drawn border's own thickness -- see HIT_MARGIN_PX --
// so clicking near the line, not just exactly on it, still hits) and the
// name handle opt back into pointerEvents:'auto'. Without this, a large
// container (easily spanning most of the canvas for a big model) swallows
// every click meant for something inside it the instant it's selected:
// React Flow elevates a selected node's z-index above its siblings by
// default (elevateNodesOnSelect), and every node here -- container or
// molecule alike -- renders as a flat sibling positioned by its own
// absolute coordinates, not truly nested in the DOM (verified directly
// against @xyflow/react's own NodeRenderer), so an elevated container's
// full bounding box ends up sitting visually *and* for pointer-events *on
// top of* its own contents. Collapsed is no exception now that it keeps
// its own real (potentially huge) box rather than a small fixed icon: an
// earlier version made the whole interior clickable while collapsed on
// the reasoning that there's nothing left underneath to protect, but that
// missed the case of *other, unrelated* nodes just happening to sit
// within the same screen region (verified directly: a collapsed group, or
// even the ever-present top-level compartment collapsed via its own
// Properties toggle, swallowed clicks meant for its surroundings across
// its *entire* area) -- border-and-label-only is the one rule that stays
// correct regardless of what else might be nearby.
//
// NodeResizer is a sibling of the interior div, not nested inside it --
// its own resize handles are plain descendants with no pointer-events
// override of their own (verified directly against @xyflow/react's
// stylesheet), so nesting them inside the pointerEvents:'none' div would
// have made them uninteractable too. Left available even while collapsed
// (no early return skips it) -- since the box keeps its own real
// footprint now, resizing it is just as meaningful collapsed as expanded.
//
// The border hit-strips alone still aren't enough on their own for a
// *really* large container, though: both the drawn border and the
// strips are sized in the same flow-space pixels as everything else, so
// at the extreme zoom-out a huge container forces (verified directly
// against a several-thousand-unit-wide group -- the fit-to-content scale
// alone was under 0.06x), a border many times thicker than normal still
// shrinks to a fraction of an actual screen pixel -- neither visible nor
// hittable. The name handle below is the fix for *that*: countering the
// ambient zoom with 1/zoom keeps it at a constant on-screen size (and
// the border's own position as its anchor, not a size, needs no such
// correction), so there's always at least one guaranteed-clickable spot
// on every container regardless of how it's zoomed.
const HIT_MARGIN_PX = 4;

// Keeps a ref'd element's own `transform: scale(...)` in sync with the
// *inverse* of the current viewport zoom, without ever causing a React
// re-render for it. `useStore(zoomSelector)` (the obvious approach, and
// what this replaced) subscribes the normal React way -- a re-render on
// every single store update -- and React Flow's own transform updates
// continuously during an active pan/zoom gesture, easily dozens of times
// a second. That's one React re-render (full JSX rebuild, reconciliation,
// possible DOM writes for the whole subtree) per container per frame, for
// every single container simultaneously visible on screen. Fine for a
// handful; became the dominant cost -- verified directly, this was the
// actual bottleneck behind zooming into a several-hundred-node model
// visibly locking up the tab and, over sustained interaction, growing
// memory pressure enough to eventually take the whole process down. A raw
// store subscription (zustand's own .subscribe, bypassing React's render
// cycle entirely) doing one direct DOM style write per frame instead is
// the standard fix for exactly this kind of per-frame, viewport-driven
// styling -- same visual result, a small fraction of the cost.
function useZoomCounterScale() {
  const ref = useRef(null);
  const store = useStoreApi();
  // useLayoutEffect, not useEffect -- the initial `apply()` needs to land
  // before the browser's first paint of this node, or a heavily zoomed-out
  // view would flash the badge at its true (huge, uncorrected) flow-space
  // size for one frame before snapping to the right on-screen size.
  useLayoutEffect(() => {
    const apply = () => {
      if (!ref.current) return;
      ref.current.style.transform = `scale(${1 / store.getState().transform[2]})`;
    };
    apply();
    return store.subscribe(apply);
  }, [store]);
  return ref;
}

// Maps a port's abstract side (assigned by collapseView.js's port-layout
// pass, see its own block comment) to the Position enum React Flow needs
// for departure-direction bookkeeping (BendableEdge's departureOffset).
function sideToPosition(side) {
  switch (side) {
    case 'right':
      return Position.Right;
    case 'top':
      return Position.Top;
    case 'bottom':
      return Position.Bottom;
    default:
      return Position.Left;
  }
}

// Places a port's dot at `frac` (0..1) along its assigned side, overriding
// React Flow's own default top:50%/left:0-style positioning entirely (the
// same explicit left+top+transform pattern EnzNode's enzSite handle already
// uses) -- a plain Position-based placement always centers on the edge, with
// no way to offset along it, which is the whole point of a knob.
function portHandleStyle(side, frac) {
  const pct = `${frac * 100}%`;
  switch (side) {
    case 'right':
      return { ...dotHandleStyle, left: '100%', top: pct, transform: 'translate(-50%, -50%)' };
    case 'top':
      return { ...dotHandleStyle, left: pct, top: 0, transform: 'translate(-50%, -50%)' };
    case 'bottom':
      return { ...dotHandleStyle, left: pct, top: '100%', transform: 'translate(-50%, -50%)' };
    default:
      return { ...dotHandleStyle, left: 0, top: pct, transform: 'translate(-50%, -50%)' };
  }
}

// A collapsed container's own knob set (data.ports, assigned by
// collapseView.js's aggregated-edge port-layout pass) changes on an
// *already-mounted* node -- collapsing a previously-expanded group adds
// brand-new named Handles to a node React Flow has had measured (with no
// handles at all) since it first mounted. Exactly the case
// useFlipRemeasure's own comment describes: React Flow only re-measures
// handle bounds via its ResizeObserver on an actual DOM/size change, never
// merely because a node's *set* of Handle children grew -- left alone, an
// edge targeting a freshly-added port id fails outright ("Couldn't create
// edge for source handle id", react-flow error #008), not just render
// stale, since the id never had any bounds registered at all. Unlike
// useFlipRemeasure, the *first* run here must NOT be skipped: a node's
// very first appearance of a non-empty ports array (collapsing it) is
// exactly the transition that needs the remeasure, not a no-op default
// state already correct on mount. Scoped to only the (typically much
// smaller) set of currently-collapsed containers, and only re-fires when
// the actual port id set changes, so this doesn't reintroduce the
// per-node-on-every-load cost that comment warns about.
function usePortsRemeasure(id, ports) {
  const updateNodeInternals = useUpdateNodeInternals();
  const key = ports.map((p) => p.id).join(',');
  useEffect(() => {
    if (key) updateNodeInternals(id);
  }, [id, key, updateNodeInternals]);
}

function ContainerNode({ id, data, selected, doubleWalled }) {
  const { onContainerResize } = useContext(NodeActionsContext);
  const badgeRef = useZoomCounterScale();
  usePortsRemeasure(id, data.ports ?? []);
  const handleResizeEnd = (event, params) => {
    onContainerResize(id, { x: params.x, y: params.y, width: params.width, height: params.height });
  };
  const borderWidth = doubleWalled ? 4 : 6;
  const hitWidth = borderWidth + HIT_MARGIN_PX;
  const collapsed = !!data.collapsed;
  // A kkit .g-format group/compartment's raw color is often a bare
  // GENESIS-palette index ("0", "1", ... up to "64"), never a real CSS
  // color -- resolveGroupColor turns that into an actual, stable, derived
  // color instead of silently discarding it (see its own comment); only a
  // genuinely absent/'white' value comes back null, meaning "no color was
  // ever assigned" rather than "assigned but unparseable".
  const resolvedColor = resolveGroupColor(data.color, id);
  const hasOwnColor = !!resolvedColor;
  // A user-assigned color, rendered at full strength, made the whole
  // (potentially huge) container read as a heavy saturated block with its
  // own contents hard to pick out on top of it -- paled the same way the
  // collapsed fill already was, just a lighter mix since an *expanded* box
  // still needs to look "chosen", not washed out entirely. Absent a color,
  // an almost-invisible 0.03 alpha wash read as plain white -- bumped to a
  // level that's still clearly a neutral, unobtrusive container, but
  // actually visible without a color picked.
  const baseFill = hasOwnColor ? paleColor(resolvedColor, 0.72) : 'rgba(0,0,0,0.07)';
  // A collapsed box uses a *pale* wash of its own color (or a neutral pale
  // gray, absent one) rather than the same full-strength shade a Pool
  // would use -- a whole group/compartment reads as heavy-handed at full
  // saturation in a way a small molecule icon doesn't, especially once it
  // can be as large as its own real, uncollapsed box (see this
  // component's own block comment above). The diagonal hatch layered on
  // top is now just a subtle texture cue that contents are hidden, not
  // the dominant "generic stippled box" look every collapsed container
  // used to have regardless of its actual assigned color.
  const collapsedFill = paleColor(resolvedColor ?? '#c0c0c0');

  return (
    <Fragment>
      <div
        style={{
          width: '100%',
          height: '100%',
          position: 'relative',
          boxSizing: 'border-box',
          // A group is a single dashed line (purely organizational, no
          // volume); a compartment is a solid double-walled box -- distinct
          // enough at a glance that they don't read as the same kind of box.
          border: doubleWalled ? `${borderWidth}px solid #333` : `${borderWidth}px dashed #333`,
          borderRadius: 4,
          background: collapsed ? collapsedFill : baseFill,
          backgroundImage: collapsed
            ? 'repeating-linear-gradient(45deg, rgba(0,0,0,0.05) 0, rgba(0,0,0,0.05) 6px, transparent 6px, transparent 16px)'
            : 'none',
          pointerEvents: 'none',
        }}
      >
        {/* Plain, unnamed handles -- like a Pool's own -- so a collapsed-
            view edge (see collapseView.js's aggregate/redirected edges,
            which don't specify a handle id) has somewhere to attach; a
            collapsed group is never itself a *real* substrate/product
            endpoint, so there's no handle-side convention to honor here.
            Harmless while expanded -- nothing ever targets them then. */}
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
        {/* Distinct per-edge "connector knobs" around the box's four sides,
            assigned by collapseView.js's aggregated-edge port-layout pass so
            each collapsed-group-to-collapsed-group connector plugs into its
            own clearly-placed point on whichever side gives the shortest
            routing, instead of every connector converging on the one fixed
            Left/Right handle above regardless of actual direction. Named
            (data.ports[].id) and typed per edge, so each only ever serves
            the one connector it was assigned to. */}
        {(data.ports ?? []).map((port) => (
          <Handle
            key={port.id}
            id={port.id}
            type={port.type}
            position={sideToPosition(port.side)}
            style={portHandleStyle(port.side, port.frac)}
          />
        ))}
        {/* Offset outward by the parent's own border-box border (which an
            absolutely-positioned child with top/bottom/left/right:0 would
            otherwise anchor *inside*, at the padding edge, not the actual
            outer edge -- verified directly: left uncorrected, the drawn
            border itself sat in an unclickable gap between these strips
            and the box's true edge) so each strip actually covers the
            visible border line, not just an inset band next to it. */}
        <div
          style={{
            position: 'absolute',
            top: -borderWidth,
            left: -borderWidth,
            right: -borderWidth,
            height: hitWidth,
            pointerEvents: 'auto',
          }}
        />
        <div
          style={{
            position: 'absolute',
            bottom: -borderWidth,
            left: -borderWidth,
            right: -borderWidth,
            height: hitWidth,
            pointerEvents: 'auto',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: -borderWidth,
            bottom: -borderWidth,
            left: -borderWidth,
            width: hitWidth,
            pointerEvents: 'auto',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: -borderWidth,
            bottom: -borderWidth,
            right: -borderWidth,
            width: hitWidth,
            pointerEvents: 'auto',
          }}
        />
        {doubleWalled && (
          <div
            style={{
              position: 'absolute',
              inset: borderWidth + 4,
              border: '4px solid #333',
              borderRadius: 2,
              pointerEvents: 'none',
            }}
          />
        )}
        {/* A fixed *screen* size regardless of zoom (see the block comment
            above) -- anchored at the box's own top-left corner, growing
            up-and-right from it via transformOrigin so it reads as sitting
            just above the border the way the old plain label did, without
            needing a separate pixel offset that would itself need
            counter-scaling. */}
        <div
          ref={badgeRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transformOrigin: 'bottom left',
            fontSize: 14,
            fontWeight: 'bold',
            whiteSpace: 'nowrap',
            pointerEvents: 'auto',
            cursor: 'pointer',
            background: '#fff',
            border: '1px solid #333',
            borderRadius: 4,
            padding: '1px 6px',
          }}
        >
          {data.name}
        </div>
      </div>
      <NodeResizer nodeId={id} isVisible={selected} minWidth={60} minHeight={40} onResizeEnd={handleResizeEnd} />
    </Fragment>
  );
}

export function GroupNode(props) {
  return <ContainerNode {...props} doubleWalled={false} />;
}

export function CompartmentNode(props) {
  return <ContainerNode {...props} doubleWalled />;
}

// Which real node component a proxy of each type dispatches to -- see
// ProxyNode below. Deliberately not a lookup into the exported nodeTypes
// map (which is keyed by React Flow's own remapped type strings, e.g.
// "kkitGroup") -- groups/compartments are never proxy-able in the first
// place (isolate mode already handles them at the group level), so this
// only ever needs the five real entity types.
const PROXY_REAL_COMPONENT = {
  pool: PoolNode,
  reac: ReacNode,
  enz: EnzNode,
  concchan: ConcChanNode,
  stim: StimNode,
};

// A stand-in for one specific entity that isolate mode has hidden (see
// collapseView.js's computeIsolateView) -- rendered as the *real* node
// component it represents (same shape, same size, same color/flip/etc,
// via data.realType and the rest of the real entity's own data that
// computeIsolateView already carried over), not a generic placeholder, so
// it reads as "the actual thing, just relocated" -- wrapped in a dashed
// outline (decorative only -- an outline never participates in layout, so
// it can't change the wrapped component's own measured size) plus a
// slightly reduced opacity as the one visual cue that it's a stand-in, not
// the real node living at this position.
//
// Fixed position and non-draggable (App.jsx has nothing to persist a drag
// to -- this node is entirely recomputed from scratch on every render);
// clicking it is handled by App.jsx's onNodeClick reading data.realId/
// data.realType, not anything here.
export function ProxyNode({ id, data, selected }) {
  const RealComponent = PROXY_REAL_COMPONENT[data.realType];
  return (
    <div
      title={`${data.name} -- hidden by isolate mode, click to view/edit`}
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        outline: '2px dashed #888',
        outlineOffset: 2,
        opacity: 0.82,
        cursor: 'pointer',
      }}
    >
      {RealComponent ? (
        <RealComponent id={id} data={data} selected={selected} />
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '1px dashed #888',
            borderRadius: 4,
            background: '#eee',
            fontSize: 11,
          }}
        >
          <Handle type="target" position={Position.Left} />
          <Handle type="source" position={Position.Right} />
          {data.name}
        </div>
      )}
    </div>
  );
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
  proxy: ProxyNode,
};
