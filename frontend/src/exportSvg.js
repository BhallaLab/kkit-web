// A genuinely standalone, portable SVG for "Save Layout to SVG" -- plain
// <rect>/<ellipse>/<polygon>/<path>/<text> elements only, built from this
// app's own node/edge data model (the same one driving the live canvas),
// not from html-to-image's DOM-clone-plus-foreignObject approach this
// replaced. That approach (still a fine choice for e.g. a raster PNG
// export) fails two things a real SVG file needs: portability (a
// <foreignObject> full of arbitrary HTML/CSS only ever renders in a
// browser -- standalone viewers like eog/gThumb, and non-browser renderers
// like librsvg/Inkscape/ImageMagick, don't implement it at all) and file
// size (it inlines every element's *entire* computed style -- hundreds of
// properties, most at their default value -- verified directly: 279
// elements averaging 5.7KB of inline style each, 95% of a 1.6MB file for a
// diagram with a handful of visible nodes).
//
// Deliberately simplified relative to the live canvas -- a plain colored
// shape plus a name label, no drag handles/plot badges -- rather than
// hand-porting nodes.jsx's own full visual language into a second parallel
// renderer. Positions/sizes still come from the live DOM (exactly what
// React Flow itself measured, including anything the layout engine or a
// manual resize/drag produced) -- only style/text come from the data
// model, since scraping text out of a node's own DOM would pick up icons/
// badges along with the name with no reliable way to tell them apart. Reac,
// Enz, Func/GenFunc/Stim specifically are drawn to match nodes.jsx's own
// shapes/glyphs (an Enz's clip-path arrow polygon, a Reac's "↔", a Func's
// "Σ", a GenFunc's "f(x)", a Stim's bare icon with no inner text) rather
// than the generic ellipse+name every other round type gets, since none of
// them actually show their own name inside the icon on the live canvas
// either (verified directly against each one's own rendered DOM).
import { getContrastTextColor, resolveGroupColor, paleColor } from './colorUtils';

const CONTAINER_TYPES = new Set(['kkitGroup', 'compartment']);
// Node types drawn as a plain colored ellipse+name -- everything round
// that isn't one of Reac/Enz/Func/GenFunc/Stim's own special-cased shapes
// below.
const ROUND_TYPES = new Set(['concchan']);
// Fixed, non-name glyph shown inside each of these instead of the entity's
// own name -- see nodes.jsx's own ReacNode/FuncNode/GenFuncNode. Stim has
// no entry at all: nodes.jsx's own StimNode shows no text inside its icon
// either (the name renders *below* it as a separate label there, which
// this export's simplified single-glyph-or-none treatment doesn't attempt
// to reproduce).
const ROUND_GLYPH = {
  reac: '↔',
  func: 'Σ',
  genfunc: 'f(x)',
};

// EnzNode's own clip-path (see nodes.jsx): a 7-point arrow/chevron polygon
// in percentages of the node's own box, filled with the enzyme's color and
// carrying no text at all on the live canvas -- reproduced here as literal
// fractions of (w, h) rather than a CSS clip-path (portable SVG has no
// direct equivalent, but a plain polygon reproduces the identical shape).
const ENZ_ARROW_POINTS = [
  [1, 0.25],
  [0.35, 0.25],
  [0.35, 0],
  [0, 0.5],
  [0.35, 1],
  [0.35, 0.75],
  [1, 0.75],
];

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// A proxy (Decorated collapse mode) stands in for one real entity -- its
// own visual category should match whatever that entity actually is, not
// literally "proxy".
function shapeTypeFor(node) {
  return node.data?.type === 'proxy' ? node.data.realType : node.type;
}

// A font size that actually fits inside (boxW, boxH) for `text` -- rather
// than a fixed constant (verified directly: a fixed 14*zoom routinely
// overflowed a Pool's own rounded rect, since a Pool's real box is sized
// for its *own* name at its *own* native font, not some unrelated fixed
// size). Approximates character width as a fraction of font-size (no DOM
// text-measurement API is available for a string that was never actually
// rendered at this candidate size) -- generous enough not to look
// needlessly tiny on a short name, conservative enough that a long one
// still shrinks to fit rather than spilling past the shape's own edge.
function fitFontSize(text, boxW, boxH, { maxSize = 32, minSize = 6, charWidth = 0.6, hPad = 0.85, vPad = 0.7 } = {}) {
  const byHeight = boxH * vPad;
  const byWidth = text.length > 0 ? (boxW * hPad) / (text.length * charWidth) : maxSize;
  return Math.max(minSize, Math.min(maxSize, byHeight, byWidth));
}

// The *actual* font-size nodes.jsx set for this node's own label, read
// straight off the live DOM, rather than fitFontSize's own character-count
// estimate -- more accurate where it's cheap to get (a Pool/ConcChan's
// name sits in a single, simply-nested child, unlike a container's own
// label, which floats above/beside its box via a different mechanism not
// worth reverse-engineering here). Descends through wrapper elements that
// have exactly one non-absolutely-positioned child (skipping Handles,
// which nodes.jsx always position:absolute) until it finds the element
// whose own direct child is the actual text node. `scale` converts the
// raw CSS value (unaffected by the ancestor zoom transform) into the
// post-transform size that's actually rendered on screen. Falls back to
// fitFontSize's own estimate if the expected simple structure isn't
// there.
function domLabelFontSize(el, text, boxW, boxH, scale) {
  let cur = el;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const hasDirectText = [...cur.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (hasDirectText) {
      const size = parseFloat(getComputedStyle(cur).fontSize);
      if (Number.isFinite(size) && size > 0) return size * scale;
      break;
    }
    const candidates = [...cur.children].filter((c) => getComputedStyle(c).position !== 'absolute');
    if (candidates.length !== 1) break;
    cur = candidates[0];
  }
  return fitFontSize(text, boxW, boxH);
}

// Edge types drawn at half the usual stroke width -- App.jsx's own
// EDGE_STYLE already makes an enzyme/ConcChan structural link (the
// pool-to-enzSite/chanParent dashed line) visually secondary to a real
// substrate/product reaction-flow edge; halving its width in this export
// makes that reads more clearly at a diagram's usual small on-page size.
const HALF_WIDTH_EDGE_TYPES = new Set(['enzyme', 'chanParent']);

export function buildStandaloneSvg(canvasEl, nodes, edges, zoom) {
  const canvasRect = canvasEl.getBoundingClientRect();
  const nodeById = {};
  nodes.forEach((n) => {
    nodeById[n.id] = n;
  });
  const edgeTypeById = {};
  (edges ?? []).forEach((e) => {
    edgeTypeById[e.id] = e.data?.type;
  });
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

  const containerParts = [];
  const entityParts = [];

  canvasEl.querySelectorAll('.react-flow__node').forEach((el) => {
    const id = el.getAttribute('data-id');
    const node = nodeById[id];
    if (!node) return;
    const type = shapeTypeFor(node);
    const r = el.getBoundingClientRect();
    const x = r.left - canvasRect.left;
    const y = r.top - canvasRect.top;
    const w = r.width;
    const h = r.height;
    if (w <= 0 || h <= 0) return;
    const name = escapeXml(node.data?.name ?? '');

    if (CONTAINER_TYPES.has(type)) {
      const resolved = resolveGroupColor(node.data?.color, id);
      const collapsed = !!node.data?.collapsed;
      const fill = collapsed ? paleColor(resolved ?? '#c0c0c0') : resolved ? paleColor(resolved, 0.72) : 'rgba(0,0,0,0.07)';
      const dash = type === 'compartment' ? '' : ' stroke-dasharray="6,4"';
      const fontSize = fitFontSize(node.data?.name ?? '', w - 12, 24, { maxSize: 16, hPad: 0.95 });
      containerParts.push(
        `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${fill}" stroke="#333" stroke-width="2"${dash}/>` +
          `<text x="${x + 6}" y="${y + fontSize + 2}" font-size="${fontSize}" font-family="sans-serif" fill="#333">${name}</text>`
      );
      return;
    }

    const color = node.data?.color || '#ffffff';

    if (type === 'enz') {
      const points = ENZ_ARROW_POINTS.map(([fx, fy]) => `${x + fx * w},${y + fy * h}`).join(' ');
      entityParts.push(`<polygon points="${points}" fill="${color}" stroke="#333" stroke-width="1"/>`);
      return;
    }

    if (type === 'stim') {
      // No inner glyph at all (see nodes.jsx's own StimNode) -- just the
      // colored icon, a plain diamond standing in for its lightning-bolt
      // clip-path (not worth reproducing as its own polygon for a shape
      // this small).
      entityParts.push(
        `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" fill="${color}" stroke="#333" stroke-width="1"/>`
      );
      return;
    }

    if (type in ROUND_GLYPH) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const glyph = ROUND_GLYPH[type];
      const fill = type === 'reac' ? '#ffffff' : color;
      const textColor = type === 'reac' ? '#000' : getContrastTextColor(color);
      const fontSize = fitFontSize(glyph, w, h);
      entityParts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" stroke="#333" stroke-width="1"/>`);
      entityParts.push(
        `<text x="${cx}" y="${cy}" font-size="${fontSize}" font-family="sans-serif" fill="${textColor}" text-anchor="middle" dominant-baseline="central">${glyph}</text>`
      );
      return;
    }

    const textColor = getContrastTextColor(color);
    const fontSize = domLabelFontSize(el, node.data?.name ?? '', w, h, scale);
    if (ROUND_TYPES.has(type)) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      entityParts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" fill="${color}" stroke="#333" stroke-width="1"/>`);
    } else {
      entityParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${color}" stroke="#333" stroke-width="1"/>`);
    }
    entityParts.push(
      `<text x="${x + w / 2}" y="${y + h / 2}" font-size="${fontSize}" font-family="sans-serif" fill="${textColor}" text-anchor="middle" dominant-baseline="central">${name}</text>`
    );
  });

  // Edge paths' own `d` coordinates live in React Flow's pre-transform
  // "flow" space (verified directly: .react-flow__viewport carries the
  // actual CSS transform -- matrix(zoom, 0, 0, zoom, panX, panY) -- and
  // every edge is a descendant of it, inheriting that transform visually
  // without it ever appearing on the path/svg element itself). Node shapes
  // above don't need this because getBoundingClientRect() already reports
  // their post-transform screen position -- but a path's raw `d` string is
  // copied verbatim, so without re-applying that same matrix here it
  // rendered at the *pre-zoom* scale, off by whatever factor 1/zoom was
  // (verified directly: exactly the "connectors scaled wrong by ~2-3x"
  // bug report, on a diagram whose fitView zoom happened to be small).
  const viewportEl = canvasEl.querySelector('.react-flow__viewport');
  const viewportTransform = viewportEl ? getComputedStyle(viewportEl).transform : 'none';
  const edgeTransform = viewportTransform && viewportTransform !== 'none' ? viewportTransform : `matrix(${scale},0,0,${scale},0,0)`;

  // vector-effect="non-scaling-stroke" would keep the stroke a constant
  // *screen*-pixel width regardless of the group transform below (the live
  // canvas itself relies on exactly that -- see BendableEdge.jsx), but
  // support for it varies enough across static SVG renderers that
  // pre-dividing by `scale` here (so the transform's own multiply lands
  // back on the intended screen-pixel width) is the more portable choice --
  // same reasoning as the marker sizes below.
  //
  // One arrowhead marker per distinct stroke color actually used (rather
  // than a single fixed color, or the newer/less portable SVG2
  // `context-stroke`) -- EDGE_STYLE (App.jsx) only ever assigns from a
  // small, fixed enum of colors, so this is a handful of markers at most,
  // each an exact match for its own edges' own color. `stroke-dasharray`
  // is copied too -- an enzyme/stim/function structural link is styled
  // dashed on the live canvas already (see EDGE_STYLE), this just failed
  // to carry that over before, rendering solid regardless.
  const markerIdByColor = new Map();
  const edgeParts = [];
  canvasEl.querySelectorAll('.react-flow__edge').forEach((edgeGroup) => {
    const path = edgeGroup.querySelector('.react-flow__edge-path');
    const d = path?.getAttribute('d');
    if (!d) return;
    const edgeType = edgeTypeById[edgeGroup.getAttribute('data-id')];
    const style = getComputedStyle(path);
    const stroke = style.stroke && style.stroke !== 'none' ? style.stroke : '#999';
    const widthMultiplier = HALF_WIDTH_EDGE_TYPES.has(edgeType) ? 0.5 : 1;
    const strokeWidth = ((parseFloat(style.strokeWidth) || 1.5) * widthMultiplier) / scale;
    const dashArray = style.strokeDasharray && style.strokeDasharray !== 'none' ? style.strokeDasharray : null;
    if (!markerIdByColor.has(stroke)) markerIdByColor.set(stroke, `arrow-${markerIdByColor.size}`);
    const markerId = markerIdByColor.get(stroke);
    const dashAttr = dashArray ? ` stroke-dasharray="${dashArray.replace(/px/g, '').replace(/,/g, ' ')}"` : '';
    edgeParts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${dashAttr} marker-end="url(#${markerId})"/>`);
  });

  const width = Math.round(canvasRect.width);
  const height = Math.round(canvasRect.height);
  // markerUnits="userSpaceOnUse" plus a size pre-divided by `scale` (same
  // reasoning as strokeWidth above) keeps each arrowhead a constant,
  // reasonable screen size regardless of how zoomed-out fitView left the
  // diagram.
  const markerSize = 8 / scale;
  const markerDefs = [...markerIdByColor.entries()]
    .map(
      ([color, markerId]) =>
        `<marker id="${markerId}" viewBox="0 0 10 10" refX="8" refY="5" ` +
        `markerWidth="${markerSize}" markerHeight="${markerSize}" markerUnits="userSpaceOnUse" orient="auto-start-reverse">` +
        `<path d="M0,0 L10,5 L0,10 Z" fill="${color}"/></marker>`
    )
    .join('');

  // Groups/compartments first (painted as background), then edges, then
  // pools/reacs/enz/... on top -- matches the live canvas's own stacking
  // (containers behind their contents) regardless of DOM query order.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<defs>${markerDefs}</defs>` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    containerParts.join('') +
    `<g transform="${escapeXml(edgeTransform)}">${edgeParts.join('')}</g>` +
    entityParts.join('') +
    `</svg>`
  );
}
