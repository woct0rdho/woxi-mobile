// Interpreter output -> notebook HTML.
// The engine answers with Woxi's structured output items:
// {"type":"text","text":"x^3/3","svg":"<svg ...>"}    typeset result
// {"type":"graphics","svg":"<svg ...>"}               plot / graphics
// {"type":"print","text":"..."}                       Print output
// {"type":"warning","text":"..."}                     interpreter message
// {"type":"error","text":"..."}                       parse / evaluation error
// {"type":"manipulate","body":"...","controls":[...],
//  "initial":{"svg":"..."}}                           interactive controls
// This module turns them into the HTML the notebook renders, and re-creates the
// Manipulate controls that live-update their view.

import { escapeHtml } from "./html.js";
import * as shape from "./svg-shape.js";
import { DEFAULT_SLIDER_STEP, SLIDER_STEPS } from "./widgets.js";

// Typeset SVGs carry width/height but often no viewBox, so CSS cannot scale them. Add
// one and a class hook before handing them to the notebook. With `base`, the size is
// re-expressed in em against the font size the box layout used (see `layoutFontSize`).
function sanitizeSvg(svg) {
  // Notebook files can be edited or imported, so their SVG is untrusted. The engine's own
  // output has no scripts or event handlers. Removing them is still the bound.
  return String(svg)
    .replace(/<\s*(script|foreignObject|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|foreignObject|iframe|object|embed)\b[^>]*\/?\s*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*('javascript:[^']*'|"javascript:[^"]*")/gi, "");
}

function openTag(svg, cls, base) {
  svg = sanitizeSvg(svg);
  return String(svg).replace(/^<svg\b([^>]*)>/, function (match, attrs) {
    const width = /(?:^|\s)width="([0-9.]+)"/.exec(attrs);
    const height = /(?:^|\s)height="([0-9.]+)"/.exec(attrs);
    let out = attrs;
    if (width && height) {
      if (!/\sviewBox=/.test(out)) out += ' viewBox="0 0 ' + width[1] + " " + height[1] + '"';
      if (base > 0) {
        out = out
          .replace(
            /(^|\s)width="[0-9.]+"/,
            '$1width="' + (parseFloat(width[1]) / base).toFixed(3) + 'em"'
          )
          .replace(
            /(^|\s)height="[0-9.]+"/,
            '$1height="' + (parseFloat(height[1]) / base).toFixed(3) + 'em"'
          );
      }
    }
    if (!/\sclass="/.test(out)) out += ' class="' + cls + '"';
    return "<svg" + out + ">";
  });
}

// The font size the box layout was asked for, written by the engine's typesetting pass
// on the root element. It is not the largest run: `Style[x, 24]` keeps the 14 px layout
// and draws one glyph larger. A document without it is one the pass refused: it keeps
// the layout's own pixels instead of being re-expressed in em.
function layoutFontSize(svg) {
  const found = /^<svg\b[^>]*\sdata-woxi-font-size="([0-9.]+)"/.exec(String(svg));
  return found ? parseFloat(found[1]) : 0;
}

// A typeset result keeps the layout's own scale: its size is re-expressed in em against
// the size the layout used, and `.woxi-out-math` sets that size (14 px), so a result
// draws at the layout's scale instead of being stretched or shrunk to a fixed CSS
// height. Wide results scroll rather than shrink. Only the opening tag is rewritten, so
// a `width` in the drawing (`<rect>` of a frame) cannot be mistaken for the canvas. A
// document the pass refused has no recorded size and keeps its pixels.
function typesetSvg(svg) {
  return openTag(svg, "woxi-svg", layoutFontSize(svg));
}

// A graphic keeps its pixel size: `fitGraphics` trims it to its ink and CSS shrinks it
// to the card, never stretches it (only a plot fills).
function graphicSvg(svg) {
  return openTag(svg, "woxi-graphic");
}

// A document that names a font size on its root is not a box layout: the layout writes a
// size per run, so a root size means another renderer drew the picture (`QuestionObject`
// is the one Woxi produces). Such a document is shown as a picture, not as math: a
// question panel is a form with its own margins and must not be em-sized or stretched.
function isDrawing(svg) {
  return /^<svg\b[^>]*\sfont-size=/.test(String(svg));
}

// Trimming a graphics SVG to its ink (see `fitGraphics`) keeps this much margin, as a
// fraction of the canvas width, clamped to a few pixels so a thumbnail is not trimmed to
// nothing and a full-width plot does not gain a visible border.
const FIT_PAD_FRACTION = 0.012;
const FIT_PAD_MIN_PX = 2;
const FIT_PAD_MAX_PX = 6;
// A background rectangle is the one that covers the picture: anything smaller is a frame
// or a legend box drawn inside it.
const BACKGROUND_COVERAGE = 0.98;
function controlHtml(control, index) {
  const name = control.name || "c" + index;
  const kind = control.kind || "";
  const value = control.initial;
  const attrs =
    ' data-woxi-control="' + escapeHtml(name) + '" data-woxi-kind="' + escapeHtml(kind) + '"';
  let input;

  if (kind === "checkbox") {
    const checked = String(value).toLowerCase() === "true" ? " checked" : "";
    input = '<input type="checkbox"' + attrs + checked + ">";
  } else if (control.values && control.values.length) {
    let options = "";
    for (let i = 0; i < control.values.length; i++) {
      const option = control.values[i];
      const selected = String(option) === String(value) ? " selected" : "";
      options +=
        '<option value="' +
        escapeHtml(option) +
        '"' +
        selected +
        ">" +
        escapeHtml(option) +
        "</option>";
    }
    input = "<select" + attrs + ">" + options + "</select>";
  } else if (typeof control.min === "number" && typeof control.max === "number") {
    let step = control.step;
    if (step === undefined || step === null) {
      const range = control.max - control.min;
      step = range > 0 ? range / SLIDER_STEPS : DEFAULT_SLIDER_STEP;
    }
    const initial = typeof value === "number" ? value : Number(value);
    input =
      '<input type="range"' +
      attrs +
      ' min="' +
      control.min +
      '" max="' +
      control.max +
      '" step="' +
      step +
      '" value="' +
      (Number.isFinite(initial) ? initial : control.min) +
      '">';
  } else {
    input = '<input type="text"' + attrs + ' value="' + escapeHtml(value) + '">';
  }

  return (
    '<label class="woxi-control">' +
    '<span class="woxi-control-label">' +
    escapeHtml(name) +
    "</span>" +
    input +
    '<span class="woxi-control-value" data-woxi-value="' +
    escapeHtml(name) +
    '">' +
    escapeHtml(String(value)) +
    "</span>" +
    "</label>"
  );
}

function manipulateHtml(item, index) {
  const controls = item.controls || [];
  const parts = [];
  for (let i = 0; i < controls.length; i++) parts.push(controlHtml(controls[i], i));
  const view = manipulateView(item.initial);

  return (
    '<div class="woxi-out woxi-manipulate" data-woxi-body="' +
    escapeHtml(item.body || "") +
    '" data-woxi-item="' +
    index +
    '">' +
    '<div class="woxi-out-graphic woxi-manipulate-view">' +
    view +
    "</div>" +
    (parts.length ? '<div class="woxi-manipulate-controls">' + parts.join("") + "</div>" : "") +
    "</div>"
  );
}

// The view of a `Manipulate`: a picture when the body is a graphic, otherwise its value as
// text in the same face and size as a stored result. `plot-interact.js` refreshes the same
// view, so the first render and a slider change cannot disagree about the typography.
function manipulateView(view) {
  if (view && view.svg) return graphicSvg(view.svg);
  return '<div class="woxi-out-text">' + escapeHtml((view && view.text) || "") + "</div>";
}

// The fields of a plot payload that outlive the session, as one object: what the markup
// records and what a rebuilt controller gets back. The samples' coverage (`d`/`dy`) and
// everything else describe the session that produced the samples, not the notebook. A
// restored notebook must not claim samples it has not got. `plot-interact.js` caches this
// same object, so the live path and the restored one cannot disagree about the shape.
function plotSummary(plot) {
  if (!plot) return null;
  return { id: plot.id, x: plot.x, y: plot.y, s: plot.s, dn: plot.dn };
}

function itemToHtml(item, index) {
  if (!item || !item.type) return "";
  switch (item.type) {
    case "text":
      if (!item.svg) {
        return '<div class="woxi-out woxi-out-text">' + escapeHtml(item.text) + "</div>";
      }
      // A text item is typeset math unless the document says it drew itself (a question
      // panel). That one is a picture and is sized and trimmed like a graphic.
      return isDrawing(item.svg)
        ? '<div class="woxi-out woxi-out-graphic">' + graphicSvg(item.svg) + "</div>"
        : '<div class="woxi-out woxi-out-math">' + typesetSvg(item.svg) + "</div>";
    case "graphics": {
      // A 2D plot carries a handle and the range it shows, so the plot can be
      // panned and zoomed without re-evaluating what the user typed. Only what a
      // rebuilt controller needs is persisted: the samples' coverage and the densify
      // level belong to the session that produced the samples (plot-interact.js).
      const view = item.plot
        ? ' data-woxi-plot="' + escapeHtml(JSON.stringify(plotSummary(item.plot))) + '"'
        : "";
      return (
        '<div class="woxi-out woxi-out-graphic' +
        (item.plot ? " woxi-plot" : "") +
        '"' +
        view +
        ">" +
        graphicSvg(item.svg) +
        "</div>"
      );
    }
    case "print":
      return '<div class="woxi-out woxi-out-print">' + escapeHtml(item.text) + "</div>";
    case "warning":
      return '<div class="woxi-out woxi-out-warning">' + escapeHtml(item.text) + "</div>";
    case "error":
      return '<div class="woxi-out woxi-out-error">' + escapeHtml(item.text) + "</div>";
    case "manipulate":
      return manipulateHtml(item, index);
    default:
      return '<div class="woxi-out woxi-out-text">' + escapeHtml(item.text || "") + "</div>";
  }
}

// Renders the engine's JSON answer, or an already parsed item array, into markup and the
// items it was made from (a plot's samples are in them, and the caller wires the plots from
// those without parsing the answer a second time). `items` is null when a JSON answer is
// unreadable.
function renderItems(json) {
  const parsed = parseItems(json);
  if (parsed.items === null) {
    return {
      items: null,
      html:
        '<div class="woxi-out woxi-out-error">Unreadable engine answer: ' +
        escapeHtml(parsed.error) +
        "</div>",
    };
  }
  const items = parsed.items;
  let html = "";
  for (let i = 0; i < items.length; i++) html += itemToHtml(items[i], i);
  return { items: items, html: html };
}

// The items of an engine answer, or the reason it is not readable.
function parseItems(json) {
  if (!json) return { items: [] };
  if (Array.isArray(json)) return { items: json };
  try {
    const items = JSON.parse(json);
    if (!items || !items.length) return { items: [] };
    return { items: items };
  } catch (err) {
    return { items: null, error: err.message };
  }
}

function inkBackground(svg, baseW, baseH) {
  const children = svg.children || [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.tagName && child.tagName.toLowerCase() === "rect") {
      // A background is filled. A frame (`Framed`, a legend box) is an outline that is part
      // of the picture: hiding it to measure the ink and then stretching it to the result
      // would cut its stroke at the box's edge.
      if (child.getAttribute("fill") === "none") continue;
      const w = parseFloat(child.getAttribute("width"));
      const h = parseFloat(child.getAttribute("height"));
      if (w >= baseW * BACKGROUND_COVERAGE && h >= baseH * BACKGROUND_COVERAGE) return child;
    }
  }
  return null;
}

// Writes a box onto an SVG, and stretches the background rectangle to it so the plot still fills
// its card. `mark` records how the box was chosen: `1` for a measurement of this element.
function applyBox(svg, box, background, mark) {
  svg.setAttribute("viewBox", box.viewBox);
  svg.setAttribute("width", String(box.width));
  svg.setAttribute("height", String(box.height));
  // CSS gives the element `width: 100%; height: auto`, so the rendered height comes from the
  // intrinsic ratio. State that ratio explicitly instead of relying on the browser to recompute
  // it from the attributes.
  if (svg.style) svg.style.aspectRatio = box.width + " / " + box.height;
  svg.setAttribute("data-woxi-fit", mark);
  if (background) {
    background.setAttribute("x", String(box.x));
    background.setAttribute("y", String(box.y));
    background.setAttribute("width", String(box.width));
    background.setAttribute("height", String(box.height));
  }
}

// The extent of everything the picture draws except its background, in its own user units.
function inkBox(svg, background) {
  let hidden = null;
  if (background) {
    hidden = background.style.display;
    background.style.display = "none";
  }
  let ink = null;
  try {
    ink = svg.getBBox();
  } catch (err) {
    ink = null;
  }
  if (background) background.style.display = hidden || "";
  return ink && ink.width > 0 && ink.height > 0 ? ink : null;
}

function fitOneGraphicsSvg(svg) {
  if (!svg) return;
  // A scene plot is drawn by the canvas at the layout's box, which `pinBox` owns. The picture's
  // own viewBox is what a reader sees, and trimming it here would make the saved picture differ
  // from the one the canvas draws for no benefit. The class check also keeps a re-fit off a plot.
  if (svg.closest && svg.closest(".woxi-plot")) return;
  // A graphic can hold another SVG - the typeset math of a Frame, a plot inside a Panel - which
  // its host placed and sized. Trimming that one would change the host's scale, so only the
  // graphic's own root is fitted.
  if (svg.parentElement && svg.parentElement.closest("svg")) return;
  if (svg.getAttribute("data-woxi-fit") === "1") return;
  let baseW = 0;
  let baseH = 0;
  let minX = 0;
  let minY = 0;
  const box = shape.viewBoxOf(svg);
  if (box) {
    minX = box.x;
    minY = box.y;
    baseW = box.width;
    baseH = box.height;
  }
  if (!(baseW > 0) || !(baseH > 0)) {
    baseW = parseFloat(svg.getAttribute("width"));
    baseH = parseFloat(svg.getAttribute("height"));
  }
  if (!(baseW > 0) || !(baseH > 0)) return;

  const background = inkBackground(svg, baseW, baseH);

  // getBBox only reports rendered content, so hiding the background rectangle
  // makes the measurement describe the actual drawing.
  const drawing = inkBox(svg, background);
  if (!drawing) return;

  const pad = Math.min(FIT_PAD_MAX_PX, Math.max(FIT_PAD_MIN_PX, baseW * FIT_PAD_FRACTION));
  const x = Math.max(minX, drawing.x - pad);
  const y = Math.max(minY, drawing.y - pad);
  const w = Math.min(minX + baseW - x, drawing.width + 2 * pad);
  let h = Math.min(minY + baseH - y, drawing.height + 2 * pad);
  if (!(w > 0) || !(h > 0)) return;
  // The picture's own bottom margin, where an axis at the frame's edge draws its labels: a
  // picture is taller than its ink when the axis has left the view, and the card keeps that room
  // so a still picture is framed the way the renderer laid it out.
  h = Math.max(h, minY + baseH - y);

  applyBox(
    svg,
    { x: x, y: y, width: w, height: h, viewBox: x + " " + y + " " + w + " " + h },
    background,
    "1"
  );
}

// Trims every graphics SVG under `root` (plots, charts, contour and 3D renders,
// and the view of a Manipulate). `root` may be the notebook output or the
// graphics container of a Manipulate itself. Typeset math is left untouched, and so is
// a picture a graphic holds: only the graphic's own root SVG is fitted.
function fitGraphics(root) {
  if (!root || !root.querySelectorAll) return;
  let svgs = Array.from(root.querySelectorAll(".woxi-out-graphic > svg"));
  if (!svgs.length && root.matches && root.matches(".woxi-out-graphic")) {
    svgs = Array.from(root.children).filter(function (child) {
      return child.tagName && child.tagName.toLowerCase() === "svg";
    });
  }
  for (let i = 0; i < svgs.length; i++) fitOneGraphicsSvg(svgs[i]);
}

export { escapeHtml, fitGraphics, graphicSvg, manipulateView, plotSummary, renderItems };
