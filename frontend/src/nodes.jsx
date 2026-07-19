import { Handle, Position } from '@xyflow/react';
import { getContrastTextColor } from './colorUtils';

const baseStyle = {
  padding: '4px 10px',
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

export function PoolNode({ data, selected }) {
  return (
    <div
      style={{
        ...baseStyle,
        ...selectedStyle(selected),
        background: data.color,
        color: getContrastTextColor(data.color),
        borderRadius: 2,
      }}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      {data.name}
    </div>
  );
}

export function ReacNode({ data, selected }) {
  const flipped = !!data.flipped;
  return (
    <div
      style={{
        ...baseStyle,
        ...selectedStyle(selected),
        background: data.color,
        color: getContrastTextColor(data.color),
        borderRadius: '50%',
        textAlign: 'center',
        fontSize: 24,
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
const ENZ_CLIP_PATH_RIGHT = 'polygon(0% 25%, 65% 25%, 65% 0%, 100% 50%, 65% 100%, 65% 75%, 0% 75%)';
const ENZ_CLIP_PATH_LEFT = 'polygon(100% 25%, 35% 25%, 35% 0%, 0% 50%, 35% 100%, 35% 75%, 100% 75%)';

export function EnzNode({ data, selected }) {
  const flipped = !!data.flipped;
  return (
    // The clip-path lives on an inner decorative layer, not this outer
    // container -- otherwise it would also clip away the substrate/product
    // triangles, which deliberately protrude outside the visible shape.
    <div style={{ position: 'relative', boxSizing: 'border-box', width: 55, height: 40 }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: data.color,
          color: getContrastTextColor(data.color),
          fontWeight: 'bold',
          fontSize: 11,
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

export const nodeTypes = { pool: PoolNode, reac: ReacNode, enz: EnzNode, concchan: PoolNode };
