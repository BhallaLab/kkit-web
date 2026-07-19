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
