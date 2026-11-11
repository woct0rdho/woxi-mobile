// Text metrics. The label's baseline and its line box are the renderer's own (Woxi's
// `plot_padding.rs`: Arial's ascent 1854/2048 em and line height 2288/2048 em, the units the
// renderer writes its label offsets in). The device draws the face the saved SVG uses (Atkinson
// Hyperlegible Next) and measures its advance with the canvas. A headless layout (the unit tests)
// installs a fallback measure with `setFallbackMeasure`. The app never does.

const PLOT_FONT = '"Atkinson Hyperlegible Next", sans-serif';
// Warm the face before the first measurement: the layout is measured once, from the first scene,
// and a fallback face would size its rails and bands for different glyphs. The app also waits for
// `document.fonts.ready` before it evaluates a restored notebook, so the warm-up is a head start.
if (typeof document !== "undefined" && document.fonts && document.fonts.load) {
  document.fonts.load("100px " + PLOT_FONT).catch(function () {});
}
const LABEL_ASCENT = 1854 / 2048;
const LABEL_LINE = 2288 / 2048;

let measureContext = null;
let fallbackMeasure = null;

// Installs the measure a canvas-less layout uses. Tests pass Woxi's Arial advance table
// (`tests/plot-metrics-fallback.js`). The app leaves this unset, because every WebView has a
// 2D canvas.
function setFallbackMeasure(measure) {
  fallbackMeasure = measure;
}

// The advance of a label in user units, measured in the face the saved picture uses.
/**
 * @param {string} text
 * @param {number} size
 * @returns {number}
 */
function textWidth(text, size) {
  if (measureContext === null) {
    measureContext = false;
    if (typeof document !== "undefined" && document.createElement) {
      const canvas = document.createElement("canvas");
      if (canvas.getContext) measureContext = canvas.getContext("2d") || false;
    }
  }
  if (measureContext) {
    measureContext.font = size + "px " + PLOT_FONT;
    let widest = 0;
    const lines = String(text).split("\n");
    for (let l = 0; l < lines.length; l += 1) {
      const width = measureContext.measureText(lines[l]).width;
      if (width > widest) widest = width;
    }
    return widest;
  }
  return fallbackMeasure ? fallbackMeasure(text, size) : 0;
}

// A tick label's box relative to its tick's base, in user units. `width` is the already
// measured advance when the caller has one (paint measures it once for the fit check).
/**
 * @param {import('./types.js').TickLabel} label
 * @param {number=} width
 * @returns {{ x0: number, y0: number, x1: number, y1: number }}
 */
function labelBox(label, width) {
  if (width === undefined) width = textWidth(label.t, label.s);
  const x0 = label.dx - (label.a === "middle" ? width / 2 : label.a === "end" ? width : 0);
  const y0 = label.dy - LABEL_ASCENT * label.s;
  return { x0: x0, y0: y0, x1: x0 + width, y1: y0 + LABEL_LINE * label.s };
}

// A label's ink relative to its anchor (the baseline point `fillText` is given). This is what a
// placement clamp needs. `labelBox` is relative to the tick's base, which is what the layout
// measures. Mixing the two counts the label's offset twice.
function labelInk(label, width) {
  if (width === undefined) width = textWidth(label.t, label.s);
  const x0 = label.a === "middle" ? -width / 2 : label.a === "end" ? -width : 0;
  return {
    x0: x0,
    x1: x0 + width,
    y0: -LABEL_ASCENT * label.s,
    y1: (LABEL_LINE - LABEL_ASCENT) * label.s,
  };
}

// A static text's box in the scene's user units, after the rotation the renderer asked for.
function textBox(text) {
  const width = textWidth(text.t, text.s);
  const x0 = text.x - (text.a === "middle" ? width / 2 : text.a === "end" ? width : 0);
  const y0 = text.y - LABEL_ASCENT * text.s;
  const x1 = x0 + width;
  const y1 = y0 + LABEL_LINE * text.s;
  const rotation = text.r;
  if (!rotation) return { x0: x0, y0: y0, x1: x1, y1: y1 };
  const cos = Math.cos((rotation.a * Math.PI) / 180);
  const sin = Math.sin((rotation.a * Math.PI) / 180);
  const xs = [];
  const ys = [];
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  for (let i = 0; i < corners.length; i += 1) {
    const dx = corners[i][0] - rotation.x;
    const dy = corners[i][1] - rotation.y;
    xs.push(rotation.x + dx * cos - dy * sin);
    ys.push(rotation.y + dx * sin + dy * cos);
  }
  return {
    x0: Math.min.apply(null, xs),
    y0: Math.min.apply(null, ys),
    x1: Math.max.apply(null, xs),
    y1: Math.max.apply(null, ys),
  };
}

export { LABEL_LINE, labelBox, labelInk, PLOT_FONT, setFallbackMeasure, textBox, textWidth };
