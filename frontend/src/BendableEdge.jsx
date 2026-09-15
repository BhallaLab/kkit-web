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

// Drags one segment of a multi-bend polyline perpendicular to itself,
// re-deriving an axis-aligned route rather than letting the dragged point
// go anywhere -- `points` is the FULL point list including the fixed
// source/target ends (a stable snapshot taken at drag-start, see
// onSegmentPointerDown's own comment), `segIndex` the segment between
// points[segIndex] and points[segIndex+1]. A segment touching a via point
// on either end just slides that point's shared coordinate to follow the
// pointer (the original single-handle behavior, generalized to whichever
// segment was actually grabbed); a segment touching the *fixed* source or
// target end can't move that endpoint at all, so instead a brand-new via
// point is inserted right next to it -- dragging a "stub" segment bends a
// new corner into existence rather than doing nothing. Returns the new
// via array (points with both fixed ends stripped back off).
function dragSegment(points, segIndex, pointer) {
  const a = points[segIndex];
  const b = points[segIndex + 1];
  const axis = a.y === b.y ? 'y' : 'x';
  const other = axis === 'x' ? 'y' : 'x';
  const newCoord = pointer[axis];
  const isFixedStart = segIndex === 0;
  const isFixedEnd = segIndex === points.length - 2;
  const next = points.map((p) => ({ ...p }));
  if (!isFixedStart) next[segIndex][axis] = newCoord;
  if (!isFixedEnd) next[segIndex + 1][axis] = newCoord;
  if (isFixedStart) {
    next.splice(1, 0, { [axis]: newCoord, [other]: next[0][other] });
  } else if (isFixedEnd) {
    const insertIdx = next.length - 1;
    next.splice(insertIdx, 0, { [axis]: newCoord, [other]: next[insertIdx][other] });
  }
  return next.slice(1, -1);
}

// Every segment gets its own handle -- drag any one of them, or click it
// (no drag) to select the edge so it can be removed with Backspace/Delete.
// Handles sit in a separate DOM subtree (EdgeLabelRenderer's portal) from
// the path itself, so each needs its own click-vs-drag detection to
// forward a plain click as a selection.
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
  // spline a lone via point gets. Dragging any segment of a multi-bend
  // route (see dragSegment above) keeps writing an axis-aligned array back,
  // so a right-angled connector stays right-angled while it's being
  // repositioned; the single-point/spline case (no array at all) keeps the
  // simpler one-handle behavior it always had.
  const isMultiBend = Array.isArray(data?.via) && data.via.length > 0;
  const viaPoints = isMultiBend ? data.via : [data?.via ?? { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 }];
  // The route's own via array is computed once, off in collapseView.js,
  // against its own independently-derived idea of where a handle sits;
  // sourceX/sourceY/targetX/targetY here are React Flow's own live,
  // authoritative measurement of that same point, taken fresh every
  // render. The two aren't always pixel-identical -- verified directly on
  // a real collapsed model, a several-unit drift (measurement/rounding,
  // not a logic bug either side) was enough to turn the endpoint-adjacent
  // segment visibly diagonal, especially at the heavy zoom-out a large
  // collapsed model fits to. Snapping the near-end via point's *free* axis
  // (the one it does NOT share with its own neighboring via point -- that
  // shared one is the deliberate lane/shelf coordinate, left untouched) to
  // the real endpoint value guarantees the rendered path always actually
  // touches the endpoint and starts/ends axis-aligned, regardless of any
  // such drift.
  //
  // "Which axis is free" is read off the via array's own two nearest
  // points, NOT off sourcePosition/targetPosition or a closest-distance
  // guess -- both were tried and verified unreliable: sourcePosition
  // alone doesn't say which axis a *specific* route construction shares
  // (collapseView.js's two different route builders, the plain shelf
  // route and the obstacle-avoiding detour, share opposite axes for the
  // same departure side), and a closest-distance guess picks the wrong
  // axis whenever the real lane coordinate happens to sit numerically
  // closer to the endpoint than the genuine shared axis's own tiny drift
  // does. Comparing a via point to its *immediate via neighbor* instead is
  // reliable regardless of construction: that neighbor relationship is
  // always an exact match by construction (never subject to any
  // measurement drift), so whichever axis they don't already agree on is
  // unambiguously the free one. Purely a rendering-time correction --
  // data.via itself is never touched, so this can't compound across
  // renders or fight a user's own drag.
  const freeAxisFrom = (p, neighbor) => {
    if (p.x === neighbor.x) return 'y';
    if (p.y === neighbor.y) return 'x';
    return null;
  };
  const snappedViaPoints = isMultiBend
    ? viaPoints.map((p, i, arr) => {
        if (arr.length < 2) return p;
        if (i === 0) {
          const freeAxis = freeAxisFrom(p, arr[1]);
          if (freeAxis) return { ...p, [freeAxis]: freeAxis === 'x' ? sourceX : sourceY };
        }
        if (i === arr.length - 1) {
          const freeAxis = freeAxisFrom(p, arr[arr.length - 2]);
          if (freeAxis) return { ...p, [freeAxis]: freeAxis === 'x' ? targetX : targetY };
        }
        return p;
      })
    : viaPoints;
  const allPoints = isMultiBend ? [{ x: sourceX, y: sourceY }, ...snappedViaPoints, { x: targetX, y: targetY }] : null;
  const path = isMultiBend
    ? polylinePath(allPoints)
    : splinePath(
        { x: sourceX, y: sourceY },
        viaPoints[0],
        { x: targetX, y: targetY },
        sourcePosition,
        targetPosition,
        sourceHandleId === 'product' || sourceHandleId === 'chanOut',
        targetHandleId === 'substrate' || targetHandleId === 'chanIn'
      );
  // The stoichiometry label (below) still anchors at the polyline's own
  // average bend point regardless of how many segment handles it now has
  // -- there's no single "the" via point to hang it off otherwise.
  const via = isMultiBend
    ? {
        x: viaPoints.reduce((sum, p) => sum + p.x, 0) / viaPoints.length,
        y: viaPoints.reduce((sum, p) => sum + p.y, 0) / viaPoints.length,
      }
    : viaPoints[0];

  // Not a useCallback -- `allPoints` is a fresh array every render (it's
  // derived straight from `data.via`), so there would be nothing stable to
  // memoize against anyway.
  const onSegmentPointerDown = (event, segIndex) => {
    event.stopPropagation();
    dragState.current = {
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      segIndex,
      // A stable snapshot of the whole polyline as it stood *before* this
      // gesture -- every subsequent pointermove recomputes from this same
      // reference rather than compounding onto whatever the previous move
      // just wrote, so a single continuous drag inserts at most one new
      // corner, not one per animation frame.
      originalPoints: allPoints ? allPoints.map((p) => ({ ...p })) : null,
    };
    event.target.setPointerCapture(event.pointerId);
  };

  const onSegmentPointerMove = useCallback(
    (event) => {
      if (!dragState.current) return;
      const dx = event.clientX - dragState.current.startX;
      const dy = event.clientY - dragState.current.startY;
      if (!dragState.current.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragState.current.dragging = true;
      const flowPoint = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const { segIndex, originalPoints } = dragState.current;
      if (originalPoints) {
        moveEdgeVia(id, dragSegment(originalPoints, segIndex, flowPoint));
        return;
      }
      moveEdgeVia(id, flowPoint);
    },
    [id, screenToFlowPosition, moveEdgeVia]
  );

  const onSegmentPointerUp = useCallback(() => {
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
        {/* One handle per segment for a multi-bend route -- each at that
            segment's own midpoint -- so any part of the polyline can be
            grabbed and tweaked, not just whichever one segment happened to
            carry the single shared handle before. The single-point/spline
            case keeps its one lone handle, unchanged. */}
        {isMultiBend
          ? allPoints.slice(0, -1).map((p, i) => {
              const q = allPoints[i + 1];
              const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
              return (
                <div
                  key={i}
                  className="nodrag nopan"
                  style={{
                    position: 'absolute',
                    transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`,
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: selected ? '#1a73e8' : '#666',
                    border: 'none',
                    cursor: 'grab',
                    pointerEvents: 'all',
                  }}
                  onPointerDown={(event) => onSegmentPointerDown(event, i)}
                  onPointerMove={onSegmentPointerMove}
                  onPointerUp={onSegmentPointerUp}
                />
              );
            })
          : (
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
                onPointerDown={(event) => onSegmentPointerDown(event, 0)}
                onPointerMove={onSegmentPointerMove}
                onPointerUp={onSegmentPointerUp}
              />
            )}
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
