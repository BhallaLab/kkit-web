import { useCallback, useContext, useRef } from 'react';
import { BaseEdge, EdgeLabelRenderer, Position, useReactFlow } from '@xyflow/react';
import { EdgeActionsContext } from './EdgeContext';

const DRAG_THRESHOLD = 4;
const MAX_DEPARTURE_OFFSET = 60;

// How far outward from the node, and in which direction, a curve should
// leave a handle before bending -- Left/Right handles get a horizontal
// departure; the enzyme's Top site handle gets a vertical one.
//
// For the reac/enz substrate/product handles, and the ConcChan's
// analogous chanIn/chanOut handles (see nodes.jsx's ArrowHandle, shared by
// both), Position is chosen to make the anchor formula read whichever edge
// of the triangle box holds the true touch point -- which, given how that
// box is offset to protrude outside the node, always ends up being the
// edge *opposite* the side the triangle actually protrudes toward. So for
// those handles only, the natural departure direction is the reverse of
// what their Position would normally suggest; a plain pool handle (or the
// enzyme's/ConcChan's own structural parent-link handle) has no such
// inversion, since its Position already matches its real side.
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

// A straight-segment polyline through every point in order -- used only
// for the *multiple*-bend case (data.via as an array, see
// collapseView.js's avoidObstacles), whose whole point is reading as
// grid-aligned/circuit-trace-like right-angle-ish routing rather than a
// single smooth diagonal bow; a spline through 3+ points would fight
// that look, not reinforce it.
function polylinePath(points) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ');
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
  markerStart,
  data,
  selected,
}) {
  const { screenToFlowPosition } = useReactFlow();
  const { selectEdge, moveEdgeVia } = useContext(EdgeActionsContext);
  const dragState = useRef(null);

  // data.via is normally a single {x,y} (a plain user drag, or a legacy
  // single-bend default) but can also be an *array* of points -- written by
  // avoidObstacles' and assignAggregatePorts' own automatic routing,
  // rendered as a straight-segment polyline instead of the single smooth
  // spline a lone via point gets. Dragging a *recognized* 2-point/
  // one-shared-axis array (see onPointerMove below) keeps writing that same
  // shape back, so a right-angled connector stays right-angled while it's
  // being repositioned; any other via shape still collapses to the
  // simpler single-bend, user-owned spline form on the first touch.
  const isMultiBend = Array.isArray(data?.via) && data.via.length > 0;
  const viaPoints = isMultiBend ? data.via : [data?.via ?? { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 }];
  const path = isMultiBend
    ? polylinePath([{ x: sourceX, y: sourceY }, ...viaPoints, { x: targetX, y: targetY }])
    : splinePath(
        { x: sourceX, y: sourceY },
        viaPoints[0],
        { x: targetX, y: targetY },
        sourcePosition,
        targetPosition,
        sourceHandleId === 'product' || sourceHandleId === 'chanOut',
        targetHandleId === 'substrate' || targetHandleId === 'chanIn'
      );
  // The one draggable handle sits at the polyline's own average bend
  // point for a multi-bend edge (there's no single "the" via point to
  // anchor it to), or the lone via point otherwise.
  const via = isMultiBend
    ? {
        x: viaPoints.reduce((sum, p) => sum + p.x, 0) / viaPoints.length,
        y: viaPoints.reduce((sum, p) => sum + p.y, 0) / viaPoints.length,
      }
    : viaPoints[0];

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
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      // A right-angled 2-bend connector (an aggregate group-to-group
      // connector, or any edge avoidObstacles routed around a third box)
      // stays right-angled while it's being dragged, instead of always
      // collapsing to the single smooth-spline point every other drag
      // produces -- sliding the *shared* coordinate (whichever axis both
      // bend points agree on) to follow the pointer, and re-deriving the
      // other from the current source/target, keeps every segment
      // horizontal/vertical throughout the gesture. Only a genuinely
      // unrecognized via shape (not this exact 2-point, one-shared-axis
      // pattern) falls back to the plain single-point/spline form.
      if (isMultiBend && data.via.length === 2 && data.via[0].x === data.via[1].x) {
        moveEdgeVia(id, [
          { x: flowPoint.x, y: sourceY },
          { x: flowPoint.x, y: targetY },
        ]);
        return;
      }
      if (isMultiBend && data.via.length === 2 && data.via[0].y === data.via[1].y) {
        moveEdgeVia(id, [
          { x: sourceX, y: flowPoint.y },
          { x: targetX, y: flowPoint.y },
        ]);
        return;
      }
      moveEdgeVia(id, flowPoint);
    },
    [id, screenToFlowPosition, moveEdgeVia, isMultiBend, data, sourceX, sourceY, targetX, targetY]
  );

  const onPointerUp = useCallback(() => {
    if (dragState.current && !dragState.current.dragging) {
      selectEdge(id);
    }
    dragState.current = null;
  }, [id, selectEdge]);

  // vectorEffect keeps the drawn stroke a constant *screen*-pixel width
  // regardless of the current viewport zoom -- without it, strokeWidth is
  // just another flow-space unit like everything else, and a large
  // collapsed/zoomed-out model can shrink a "1px" edge down to a fraction
  // of an actual screen pixel, effectively invisible even though it's
  // still technically drawn. A big model heavily zoomed out to fit is
  // exactly the case this matters most for.
  const edgeStyle = selected
    ? { ...style, stroke: '#1a73e8', strokeWidth: 3, vectorEffect: 'non-scaling-stroke' }
    : { ...style, vectorEffect: 'non-scaling-stroke' };
  const stoich = data?.stoich ?? 1;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={edgeStyle}
        markerEnd={markerEnd}
        markerStart={markerStart}
        interactionWidth={20}
      />
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
        {/* Stoichiometry > 1 (multiple separate MOOSE messages between the
            same reac/enz and pool -- see moose_graph.py's build_graph) --
            offset from the drag handle above so the two don't overlap. */}
        {stoich > 1 && (
          <div
            className="nodrag nopan"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${via.x + 10}px, ${via.y - 10}px)`,
              fontSize: 12,
              fontWeight: 'bold',
              color: '#333',
              background: '#fff',
              border: '1px solid #333',
              borderRadius: 3,
              padding: '0 3px',
              pointerEvents: 'none',
            }}
          >
            {stoich}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
