// 16 evenly-spaced hues (360/16 = 22.5 degrees apart) -- shared between the
// auto-assignment of molecule colors on load (App.jsx) and the colorbar
// swatches in the properties panel, so what you click there is exactly
// what a freshly-loaded model's molecules are colored with.
export const RAINBOW_16 = Array.from({ length: 16 }, (_, i) => `hsl(${i * 22.5}, 70%, 50%)`);

// Accent colors distinguishing the two Plots-tab windows -- used by the
// palette's two plot icons and by the matching on-canvas badge, independent
// of a molecule's own (rainbow) color, which the actual plotted trace still
// uses.
export const PLOT_WINDOW_COLORS = { 1: '#1a73e8', 2: '#e91e63' };

let _canvas;

// Resolves ANY valid CSS color string (named color, hex, rgb(), etc.) via
// the browser's own color parsing, rather than a hardcoded named-color
// table that would miss hex/rgb input -- an invalid string is silently
// ignored by canvas fillStyle, leaving the white reset in place, which
// reads as "light" and falls back to black text.
export function getContrastTextColor(cssColor) {
  if (typeof document === 'undefined') return 'black';
  if (!_canvas) _canvas = document.createElement('canvas');
  _canvas.width = 1;
  _canvas.height = 1;
  const ctx = _canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? 'black' : 'white';
}
