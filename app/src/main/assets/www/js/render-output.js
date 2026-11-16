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

// Typeset SVGs carry width/height but often no viewBox, so CSS cannot scale them.
// Add one and a class hook before handing them to the notebook.
// With `toEm`, the size is rewritten in em using the font size of the layout
// (the largest <text> size: the scripts are smaller, the roots are not).
// A typeset result then draws at its own scale - one line of text is 1 em of
// the body font, a fraction is taller - instead of being stretched or shrunk
// to a fixed CSS height. Graphics keep their pixel size and are scaled by CSS.
function layoutFontSize(svg) {
  const sizes = String(svg).match(/font-size="[0-9.]+"/g) || [];
  let base = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    base = Math.max(base, parseFloat(sizes[i].replace(/[^0-9.]/g, "")));
  }
  return base;
}

function svgTag(svg, cls, toEm) {
  return String(svg).replace(/^<svg\b([^>]*)>/, function (match, attrs) {
    let out = attrs;
    const width = /width="([0-9.]+)"/.exec(attrs);
    const height = /height="([0-9.]+)"/.exec(attrs);
    if (width && height && !/viewBox=/.test(attrs)) {
      out += ' viewBox="0 0 ' + width[1] + " " + height[1] + '"';
    }
    if (toEm && width && height) {
      const base = layoutFontSize(svg);
      if (base > 0) {
        out = out
          .replace(
            'width="' + width[1] + '"',
            'width="' + (parseFloat(width[1]) / base).toFixed(3) + 'em"'
          )
          .replace(
            'height="' + height[1] + '"',
            'height="' + (parseFloat(height[1]) / base).toFixed(3) + 'em"'
          );
      }
    }
    if (!/class=/.test(out)) out += ' class="' + cls + '"';
    return "<svg" + out + ">";
  });
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
// The last JSON parse error, for the caller that reports an unreadable answer.
let lastParseError = "";
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
      step = range > 0 ? range / 100 : 0.1;
    }
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
      (typeof value === "number" ? value : control.min) +
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

function manipulateHtml(item) {
  const controls = item.controls || [];
  const parts = [];
  for (let i = 0; i < controls.length; i++) parts.push(controlHtml(controls[i], i));
  const view =
    item.initial && item.initial.svg
      ? svgTag(item.initial.svg, "woxi-svg")
      : "<span>" + escapeHtml((item.initial && item.initial.text) || "") + "</span>";

  return (
    '<div class="woxi-out woxi-manipulate" data-woxi-body="' +
    escapeHtml(item.body || "") +
    '">' +
    '<div class="woxi-out-graphic woxi-manipulate-view">' +
    view +
    "</div>" +
    (parts.length ? '<div class="woxi-manipulate-controls">' + parts.join("") + "</div>" : "") +
    "</div>"
  );
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

function itemToHtml(item) {
  if (!item || !item.type) return "";
  switch (item.type) {
    case "text":
      return item.svg
        ? '<div class="woxi-out woxi-out-math">' + svgTag(item.svg, "woxi-svg", true) + "</div>"
        : '<div class="woxi-out woxi-out-text">' + escapeHtml(item.text) + "</div>";
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
        svgTag(item.svg, "woxi-graphic") +
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
      return manipulateHtml(item);
    default:
      return '<div class="woxi-out woxi-out-text">' + escapeHtml(item.text || "") + "</div>";
  }
}

// Renders the engine's JSON answer: the markup, and the items it was made from (a plot's
// samples are in them, and the caller wires the plots from those without parsing the
// answer a second time). `items` is null when the answer is unreadable.
function renderItems(json) {
  const items = parseItems(json);
  if (items === null) {
    return {
      items: null,
      html:
        '<div class="woxi-out woxi-out-error">Unreadable engine answer: ' +
        escapeHtml(lastParseError) +
        "</div>",
    };
  }
  let html = "";
  for (let i = 0; i < items.length; i++) html += itemToHtml(items[i]);
  return { items: items, html: html };
}

// The items of an engine answer, or null when it is not readable.
function parseItems(json) {
  if (!json) return [];
  try {
    const items = JSON.parse(json);
    if (!items || !items.length) return [];
    return items;
  } catch (err) {
    lastParseError = err.message;
    return null;
  }
}

function inkBackground(svg, baseW, baseH) {
  const children = svg.children || [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child.tagName && child.tagName.toLowerCase() === "rect") {
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
  // from the one the canvas draws for no benefit. `data-woxi-fit` also keeps a re-fit off a
  // plot that was already pinned.
  if (svg.closest && svg.closest(".woxi-plot")) return;
  const fit = svg.getAttribute("data-woxi-fit");
  if (fit === "1" || fit === "scene") return;
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
// graphics container of a Manipulate itself. Typeset math is left untouched.
function fitGraphics(root) {
  if (!root || !root.querySelectorAll) return;
  let svgs = root.querySelectorAll(".woxi-out-graphic svg");
  if (!svgs.length && root.matches && root.matches(".woxi-out-graphic")) {
    svgs = root.querySelectorAll("svg");
  }
  for (let i = 0; i < svgs.length; i++) fitOneGraphicsSvg(svgs[i]);
}

export { escapeHtml, fitGraphics, plotSummary, renderItems, svgTag };
