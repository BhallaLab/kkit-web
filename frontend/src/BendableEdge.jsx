import { useCallback, useContext, useRef } from 'react';
import { BaseEdge, EdgeLabelRenderer, Position, useReactFlow } from '@xyflow/react';
import { EdgeActionsContext } from './EdgeContext';

const DRAG_THRESHOLD = 4;
const MAX_DEPARTURE_OFFSET = 60;

// How far outward from the node, and in which direction, a curve should
// leave a handle before bending -- Left/Right handles get a horizontal
// departure; the enzyme's Top site handle gets a vertical one.
//
// For the reac/enz substrate/product handles specifically (see nodes.jsx),
// Position is chosen to make the anchor formula read whichever edge of the
// triangle box holds the true touch point -- which, given how that box is
// offset to protrude outside the node, always ends up being the edge
// *opposite* the side the triangle actually protrudes toward. So for those
// two handles only, the natural departure direction is the reverse of what
// their Position would normally suggest; a plain pool handle (or the
// enzyme's Top site handle) has no such inversion, since its Position
// already matches its real side.
function departureOffset(position, distance, invert) {
  const sign = invert ? -1 : 1;
  switch (position) {
    case Position.Left:
      return { x: -distance * sign, y: 0 };
    case Position.Right:
      return { x: distance * sign, y: 0 };
    case Position.Top:
      return { x: 0, y: -distance };
    case Position.Bottom:
      return { x: 0, y: distance };
    default:
      return { x: 0, y: 0 };
  }
}

// Smooth 2-segment cubic-bezier spline through S -> V -> T (a 3-point
// Catmull-Rom spline, converted to bezier form) -- unlike a single quadratic
// curve using V as a control point, this actually passes through V, so the
// drag handle always sits exactly on the line it's bending. The two control
// points nearest S and T are overridden (rather than left as the plain
// Catmull-Rom result) so the curve always leaves/arrives perpendicular to
// the node it's connected to; the via-point end of each segment is left
// alone, preserving the smooth pass-through at the bend.
function splinePath(S, V, T, sourcePosition, targetPosition, sourceInvert, targetInvert) {
  const d1 = Math.min(Math.hypot(V.x - S.x, V.y - S.y) / 2 || 40, MAX_DEPARTURE_OFFSET);
  const d2 = Math.min(Math.hypot(T.x - V.x, T.y - V.y) / 2 || 40, MAX_DEPARTURE_OFFSET);
  const o1 = departureOffset(sourcePosition, d1, sourceInvert);
  const o2 = departureOffset(targetPosition, d2, targetInvert);

  const seg1c1 = { x: S.x + o1.x, y: S.y + o1.y };
  const seg1c2 = { x: V.x - (T.x - S.x) / 6, y: V.y - (T.y - S.y) / 6 };
  const seg2c1 = { x: V.x + (T.x - S.x) / 6, y: V.y + (T.y - S.y) / 6 };
  const seg2c2 = { x: T.x + o2.x, y: T.y + o2.y };
  return (
    `M ${S.x},${S.y} C ${seg1c1.x},${seg1c1.y} ${seg1c2.x},${seg1c2.y} ${V.x},${V.y}` +
    ` C ${seg2c1.x},${seg2c1.y} ${seg2c2.x},${seg2c2.y} ${T.x},${T.y}`
  );
}

// The midpoint handle serves two purposes: drag it to bend the edge for a
// clearer layout, or click it (no drag) to select the edge so it can be
// removed with Backspace/Delete -- the handle sits in a separate DOM
// subtree (EdgeLabelRenderer's portal) from the path itself, so it needs
// its own click-vs-drag detection to forward a plain click as a selection.
export default function BendableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  targetHandleId,
  style,
  markerEnd,
  data,
  selected,
}) {
  const { screenToFlowPosition } = useReactFlow();
  const { selectEdge, moveEdgeVia } = useContext(EdgeActionsContext);
  const dragState = useRef(null);

  const via = data?.via ?? { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 };
  const path = splinePath(
    { x: sourceX, y: sourceY },
    via,
    { x: targetX, y: targetY },
    sourcePosition,
    targetPosition,
    sourceHandleId === 'product',
    targetHandleId === 'substrate'
  );

  const onPointerDown = useCallback((event) => {
    event.stopPropagation();
    dragState.current = { startX: event.clientX, startY: event.clientY, dragging: false };
    event.target.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (event) => {
      if (!dragState.current) return;
      const dx = event.clientX - dragState.current.startX;
      const dy = event.clientY - dragState.current.startY;
      if (!dragState.current.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragState.current.dragging = true;
      moveEdgeVia(id, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    },
    [id, screenToFlowPosition, moveEdgeVia]
  );

  const onPointerUp = useCallback(() => {
    if (dragState.current && !dragState.current.dragging) {
      selectEdge(id);
    }
    dragState.current = null;
  }, [id, selectEdge]);

  const edgeStyle = selected ? { ...style, stroke: '#1a73e8', strokeWidth: 3 } : style;

  return (
    <>
      <BaseEdge id={id} path={path} style={edgeStyle} markerEnd={markerEnd} interactionWidth={20} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${via.x}px, ${via.y}px)`,
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: selected ? '#1a73e8' : '#666',
            border: 'none',
            cursor: 'grab',
            pointerEvents: 'all',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </EdgeLabelRenderer>
    </>
  );
}
