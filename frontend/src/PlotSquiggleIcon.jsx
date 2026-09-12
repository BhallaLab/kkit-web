// A small rectangle with a squiggly time-trace inside -- used both as the
// Add palette's draggable "Plot 1"/"Plot 2" icons and as the on-canvas badge
// marking a pool that's been dropped onto, so the two visually match. The
// trace color distinguishes which of the two plot windows a badge belongs
// to, matching whichever palette icon was used to place it.
export default function PlotSquiggleIcon({ width = 20, height = 14, traceColor = '#1a73e8' }) {
  return (
    <svg width={width} height={height} viewBox="0 0 20 14">
      <rect x="0.5" y="0.5" width="19" height="13" fill="#fff" stroke="#333" strokeWidth="1" />
      <path d="M2 10 L5 4 L8 9 L11 3 L14 8 L18 4" fill="none" stroke={traceColor} strokeWidth="1.4" />
    </svg>
  );
}
