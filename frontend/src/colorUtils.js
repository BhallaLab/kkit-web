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

// Whether `value` actually parses as a usable CSS color at all -- a kkit
// .g-format model's group/compartment Annotator.color comes straight from
// the old GENESIS/kkit palette convention, a bare numeric *index* (e.g.
// "0", "1"), never converted to CSS on the way in (unlike a Pool's own
// color, always one of colorUtils' own RAINBOW_16 hsl() strings -- see
// App.jsx's buildFlowNodes, which only ever auto-assigns those to pools).
// Treating a value like that as "the user picked a color" (the naive
// `data.color && data.color !== 'white'` check every hasOwnColor call used
// to make) sets `background: "0"` -- invalid CSS, silently ignored by the
// browser, rendering as though no color were set at all while still taking
// the "has own color" branch everywhere else. A detached element's own
// CSSOM color setter is the standard way to ask the browser itself whether
// a string parses, cheaper and more complete than hand-rolling a regex for
// every valid CSS color syntax.
export function isValidCssColor(value) {
  if (typeof value !== 'string' || !value || typeof document === 'undefined') return false;
  const probe = document.createElement('option').style;
  probe.color = '';
  probe.color = value;
  return probe.color !== '';
}

// Turns a group/compartment's raw color into something actually usable:
// its own value verbatim when it's real CSS, a deterministic derived hue
// when it isn't (a bare kkit/GENESIS palette index, typically 1-64), or
// null when there's genuinely no color assigned at all. Kept apart from
// isValidCssColor itself since a bare index isn't "no color" the way a
// missing field is -- the model author *did* pick a color, just not one
// the browser understands, and a flat neutral gray for every such group
// erased that distinction entirely (every colored group looked identical).
// The numeric path deliberately doesn't try to reproduce kkit's own
// palette exactly (that table isn't available here) -- spreading indices
// evenly around the hue wheel is enough for different indices to read as
// different colors, which is what actually matters for telling groups
// apart at a glance. A non-numeric, still-invalid value (some other kind
// of raw annotation this frontend doesn't recognize) falls back to hashing
// `fallbackSeed` (the node's own id) instead, so it's at least *stable*
// across reloads rather than effectively random.
export function resolveGroupColor(rawColor, fallbackSeed) {
  if (!rawColor || rawColor === 'white') return null;
  if (isValidCssColor(rawColor)) return rawColor;
  const n = Number(rawColor);
  let hue;
  if (Number.isFinite(n)) {
    hue = ((n * (360 / 64)) % 360 + 360) % 360;
  } else {
    let hash = 0;
    const seed = fallbackSeed ?? '';
    for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    hue = ((hash % 360) + 360) % 360;
  }
  return `hsl(${hue}, 65%, 55%)`;
}

// Blends `cssColor` toward white by `mix` (0 = the color unchanged, 1 =
// pure white) -- a collapsed group/compartment's own fill uses this
// rather than the same full-strength shade a Pool would use: a
// potentially huge box reads as heavy-handed at full saturation in a way
// a small molecule icon doesn't. Same canvas-based parsing as
// getContrastTextColor, for the same reason -- resolves *any* valid CSS
// color string via the browser's own parser rather than a hand-rolled one
// that would only handle the hsl()/hex formats actually in use today.
export function paleColor(cssColor, mix = 0.55) {
  if (typeof document === 'undefined') return cssColor;
  if (!_canvas) _canvas = document.createElement('canvas');
  _canvas.width = 1;
  _canvas.height = 1;
  const ctx = _canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const blend = (c) => Math.round(c + (255 - c) * mix);
  return `rgb(${blend(r)}, ${blend(g)}, ${blend(b)})`;
}
