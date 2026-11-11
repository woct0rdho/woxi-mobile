// The plot renderer. One canvas draws everything an interactive plot shows: the background, the
// frame, grid and axis lines, ticks, tick labels, static texts - the scene the engine extracts
// from its picture (`engine/src/plot/scene/`) - and the series, from the samples it sends.
//
// The scene carries values, not pixel positions: a tick is a value in the drawing space, a label
// is an offset from its tick, the frame and the data rectangle are in the picture's own user
// units. A pan or a pinch is therefore one affine and a repaint - the frame and the card never
// move, and the labels follow their values at display rate. The picture's contents are never
// read back during a gesture (the SVG is only measured for its box), and there is no second
// rendering path: the same draw runs at rest and while a finger is down.
//
// The markup the engine also sends is never shown for an interactive plot. It is inserted hidden
// because it is what gets saved: the notebook keeps a picture of the plot for other readers,
// while the app draws the scene. The pinned box (the first scene's frame plus its bands and
// padding, set as the SVG's CSS size) keeps the card's size and the user-to-pixel scale constant
// from picture to picture.

import { LABEL_LINE, labelBox, labelInk, PLOT_FONT, textBox, textWidth } from "./plot-metrics.js";

// The renderer's own measurements on its 360 px canvas: a plain dot is 2.3 px wide and an
// `Automatic` marker 3.5 px, so their radii are these fractions of the image width. The minimums
// are CSS pixels too. `paint` converts them to the picture's user units with the current scale.
const MIN_STROKE_CSS_PX = 0.6;
const MIN_MARKER_CSS_PX = 1.5;
const MIN_DASH_CSS_PX = 0.5;
// Woxi draws a filled scatter's stems at the renderer's 1-pixel stroke
// (`stroke_width(RESOLUTION_SCALE)` in plot.rs), which is this fraction of its 360 px reference
// width. A filled curve's area has no stroke.
const WOXI_REFERENCE_WIDTH = 360;
const STEM_WIDTH_FRACTION = 1 / WOXI_REFERENCE_WIDTH;

// A coordinate in the space the gesture maths works in: data units, or decades on a
// logarithmic axis.
function axisValue(logarithmic, value) {
  return logarithmic ? Math.log10(value) : value;
}

// The affine from the drawing space (data units, or decades) to the picture's own user units,
// for the range `view` drawn onto the scene's data rectangle. `ax`/`ay` carry the sign: the
// picture's y axis grows downward, so the lowest data value maps to the larger user y.
/**
 * @param {import('./types.js').Scene} scene
 * @param {import('./types.js').View} view
 * @param {import('./types.js').LogAxes|null} log
 * @returns {{ ax: number, bx: number, ay: number, by: number }|null}
 */
function sceneMapping(scene, view, log) {
  if (!scene || !scene.rect || !view || !view.x || !view.y) return null;
  const rect = scene.rect;
  const logX = !!(log && log.x);
  const logY = !!(log && log.y);
  const x0 = axisValue(logX, view.x[0]);
  const x1 = axisValue(logX, view.x[1]);
  const y0 = axisValue(logY, view.y[0]);
  const y1 = axisValue(logY, view.y[1]);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  const ax = (rect[2] - rect[0]) / (x1 - x0);
  const bx = rect[0] - ax * x0;
  const ay = (rect[3] - rect[1]) / (y1 - y0);
  const by = rect[1] - ay * y0;
  if (!isFinite(ax) || !isFinite(ay) || ax === 0 || ay === 0) return null;
  return { ax: ax, bx: bx, ay: ay, by: by };
}

// Data -> screen pixels for the range being drawn: `screenX = a * x + b` and
// `screenY = d * y + f`, in CSS pixels of the canvas. `log` says which axes are decades rather
// than data units. The picture's data rectangle is `scene.rect`. The mapping does not copy it.
//
// `scene`, `box` and `scale` are what the handle carries: the scene, the pinned box in user
// units, and the CSS pixels per user unit.
/**
 * @param {import('./types.js').View} view
 * @param {import('./types.js').Scene} scene
 * @param {import('./types.js').UserRect} box
 * @param {number} scale
 * @param {import('./types.js').LogAxes|null} log
 * @returns {import('./types.js').Mapping|null}
 */
function dataMapping(view, scene, box, scale, log) {
  if (!scene || !scene.rect || !box || !(scale > 0)) return null;
  if (!view || !view.x || !view.y) return null;
  const logX = !!(log && log.x);
  const logY = !!(log && log.y);
  if (logX && (!(view.x[0] > 0) || !(view.x[1] > 0))) return null;
  if (logY && (!(view.y[0] > 0) || !(view.y[1] > 0))) return null;
  const x0 = axisValue(logX, view.x[0]);
  const x1 = axisValue(logX, view.x[1]);
  const y0 = axisValue(logY, view.y[0]);
  const y1 = axisValue(logY, view.y[1]);
  const map = sceneMapping(scene, view, log);
  if (!(x1 > x0) || !(y1 > y0) || !map) return null;
  const a = map.ax * scale;
  const b = (map.bx - box.x) * scale;
  const d = map.ay * scale;
  const f = (map.by - box.y) * scale;
  // The drawing space is data units, or decades: a log axis maps through its logarithm.
  return { a: a, b: b, d: d, f: f };
}

// Extra room kept beyond a label's extent, as a fraction of its font size, so that a wider value
// later still fits (the layout does not change for it).
const LABEL_SLACK = 0.35;
// Padding around the frame, as a fraction of its width: the card's own margin, so the canvas's
// background does not end exactly on the plot area. The frame's stroke gets its own half on top.
const FRAME_PAD = 0.004;
// The padding never goes below this, in user units (a fraction of a pixel on a phone), so a tiny
// picture still has an edge to draw.
const PAD_MIN_USER = 1;
// The wire names a tick's edge with one letter. A rail names its side in full.
const SIDE_FIELD = { l: "left", r: "right", t: "top", b: "bottom" };
// A tick whose position is within this much of the frame's edge is drawn. The renderer writes
// coordinates rounded to 0.1 user units. Half a user unit of slack also absorbs the frame's
// stroke without visibly moving the mark.
const FIT_SLACK = 0.5;

// Where a value line is drawn, in user units: its value through the mapping, kept a label's
// width inside the frame on the side its labels sit (its rail). A log axis's origin is its low
// end, so it always sits on the low rail. `line.o` is the axis the line is positioned on.
/**
 * @param {import('./types.js').SceneLine} line
 * @param {{ ax: number, bx: number, ay: number, by: number }} mapping
 * @param {import('./types.js').LogAxes|null} log
 * @param {[number, number, number, number]} frame
 * @param {import('./types.js').Rails|null} rails
 * @returns {number}
 */
function axisPosition(line, mapping, log, frame, rails) {
  const room = rails || { left: 0, right: 0, top: 0, bottom: 0 };
  const horizontal = line.o === "y";
  const low = horizontal ? frame[1] + room.top : frame[0] + room.left;
  const high = horizontal ? frame[1] + frame[3] - room.bottom : frame[0] + frame[2] - room.right;
  if (high < low) return (low + high) / 2;
  // A log axis's origin is its low end: the left of the frame for an x axis, the bottom of it
  // for a y axis (the larger user y), on that side's rail.
  if (log && log[line.o]) return horizontal ? high : low;
  const at = horizontal ? mapping.ay * line.v + mapping.by : mapping.ax * line.v + mapping.bx;
  return Math.min(high, Math.max(low, at));
}

// Where a filled series' baseline is, in the drawing space of the view being drawn. `Axis` is
// zero and `Value` is the user's value. `Bottom`/`Top` are the range the renderer is drawing
// now, which the view supplies (Woxi recomputes them from the render's `y_min`/`y_max`, so
// freezing the picture's range would leave the fill short of the frame edge after a pan). A
// payload without a kind has no baseline. The engine always sends one.
/**
 * @param {{ kind: 'axis'|'bottom'|'top'|'value', value?: number }|null} fill
 * @param {import('./types.js').View} view
 * @param {import('./types.js').LogAxes|null} log
 * @returns {number|null}
 */
function fillBaseline(fill, view, log) {
  if (!fill) return null;
  const y = view && view.y;
  if (fill.kind === "axis") return 0;
  if (fill.kind === "bottom" && y) return axisValue(log && log.y, y[0]);
  if (fill.kind === "top" && y) return axisValue(log && log.y, y[1]);
  if (fill.kind === "value" && typeof fill.value === "number") return fill.value;
  return null;
}

// A tick's base and tip, in user units. A tick on a frame edge stays where the picture drew it.
// One on an axis follows the axis's clamped position. The rail the axis stops on already keeps
// the mark inside the frame, so its direction is never reversed: the label side must not flip,
// and a reversed mark would cross its own label.
/**
 * @param {import('./types.js').SceneTick} tick
 * @param {import('./types.js').Scene} scene
 * @param {{ ax: number, bx: number, ay: number, by: number }} mapping
 * @param {import('./types.js').LogAxes|null} log
 * @returns {{ base: number, tip: number }|null}
 */
function tickPlace(tick, scene, mapping, log) {
  if (tick.k !== "a") return { base: tick.b, tip: tick.e };
  const baseAxis = tick.o === "x" ? "y" : "x";
  let line = null;
  for (let i = 0; i < scene.lines.length; i += 1) {
    if (scene.lines[i].o === baseAxis && scene.lines[i].k === "a") {
      line = scene.lines[i];
      break;
    }
  }
  // An axis tick without its axis line is a malformed scene: the engine pairs the two. Skip the
  // tick instead of drawing it at a base the picture made up. (Tests build a scene with the line.)
  if (!line) return null;
  const base = axisPosition(line, mapping, log, scene.frame, scene.rails);
  const length = Math.abs(tick.e - tick.b);
  const direction = tick.e >= tick.b ? 1 : -1;
  return { base: base, tip: base + direction * length };
}

// Pins the card's shape onto the (hidden) markup: the layout box, as its width, height and
// aspect ratio. The SVG's own viewBox is left alone - it is the picture the notebook saves -
// and the box the canvas draws in comes from the same layout, so the card cannot resize when
// the renderer's margins change.
/**
 * @param {SVGSVGElement} svg
 * @param {import('./types.js').UserRect} box
 */
function pinBox(svg, box) {
  if (!svg || !box || !(box.width > 0) || !(box.height > 0)) return;
  svg.setAttribute("width", String(box.width));
  svg.setAttribute("height", String(box.height));
  if (svg.style) svg.style.aspectRatio = box.width + " / " + box.height;
  svg.setAttribute("data-woxi-fit", "scene");
}

// The layout a plot keeps, in its own coordinate space, fixed at the first scene:
// - The frame is the plot area. Its shape is the first scene's frame shape (the user's
//   `AspectRatio`), and it never moves or resizes.
// - Rails live inside the frame, on the sides an axis label sits on, and where its marks
//   point. An axis never comes closer to the frame's border than its labels or marks need, so a
//   pinned axis keeps its labels visible without an outer margin and without flipping them.
//   While the axis is not pinned the rail is just plot area.
// - Bands live outside the frame, on the sides an outside label sits on: a frame tick's
//   label (Woxi puts frame labels outside their edge, on whichever edges `FrameTicks` chose) or a
//   static label (`FrameLabel`, `PlotLabel`). Such a label is always at that edge, so the band is
//   always occupied - unlike a margin reserved for an axis that happens to be pinned.
// - The image box is the frame plus its bands plus a small padding for the frame's stroke.
/**
 * @param {import('./types.js').Scene} scene
 * @returns {import('./types.js').Layout|null}
 */
function layoutOf(scene) {
  if (!scene || !scene.frame || !scene.box || !(scene.box[2] > 0)) return null;
  const frame = scene.frame;
  const rails = { left: 0, right: 0, top: 0, bottom: 0 };
  const bands = { left: 0, right: 0, top: 0, bottom: 0 };
  const fonts = { left: 0, right: 0, top: 0, bottom: 0 };
  const extend = function (set, side, value, font) {
    if (!(value > 0)) return;
    const field = SIDE_FIELD[side];
    if (value > set[field]) set[field] = value;
    if (font > fonts[field]) fonts[field] = font;
  };
  for (let i = 0; i < scene.ticks.length; i += 1) {
    const tick = scene.ticks[i];
    const label = tick.l;
    const box = label ? labelBox(label) : null;
    if (tick.k === "a") {
      // A mark that points at a frame border needs its own length of rail there: an axis stuck
      // against that border keeps its marks inside the frame, on whichever side it stops. This
      // is every axis tick, labeled or not. The mark direction is therefore never flipped.
      const mark = Math.abs(tick.e - tick.b);
      if (mark > 0 && Number.isFinite(mark)) {
        const markFont = label ? label.s : 0;
        if (tick.o === "x") extend(rails, tick.e >= tick.b ? "b" : "t", mark, markFont);
        else extend(rails, tick.e >= tick.b ? "r" : "l", mark, markFont);
      }
      if (!label) continue;
      // An axis label's reach from the axis, on the side it sits on.
      if (tick.o === "x") {
        if (box.y1 > 0) extend(rails, "b", box.y1, label.s);
        else extend(rails, "t", -box.y0, label.s);
      } else if (box.x0 < 0) {
        extend(rails, "l", -box.x0, label.s);
      } else {
        extend(rails, "r", box.x1, label.s);
      }
    } else {
      if (!label) continue;
      // A frame tick's label is outside the edge the engine put the tick on. The scene carries
      // that edge (`s`): the base may sit a frame stroke's width inside the rectangle.
      const side = tick.s;
      if (!side) continue;
      const beyond =
        side === "l" ? -box.x0 : side === "r" ? box.x1 : side === "b" ? box.y1 : -box.y0;
      extend(bands, side, beyond, label.s);
      // A label centered near the edge's end overhangs the frame along that edge. Woxi's own
      // padding reserves room for it (`along_x`/`along_y` in plot_padding.rs), so the card does
      // too. Without this a top label at the frame's right end would have no room.
      if (Number.isFinite(tick.at)) {
        if (side === "t" || side === "b") {
          const leftOver = frame[0] - (tick.at + box.x0);
          const rightOver = tick.at + box.x1 - (frame[0] + frame[2]);
          if (leftOver > 0) extend(bands, "l", leftOver, label.s);
          if (rightOver > 0) extend(bands, "r", rightOver, label.s);
        } else {
          const topOver = frame[1] - (tick.at + box.y0);
          const bottomOver = tick.at + box.y1 - (frame[1] + frame[3]);
          if (topOver > 0) extend(bands, "t", topOver, label.s);
          if (bottomOver > 0) extend(bands, "b", bottomOver, label.s);
        }
      }
    }
  }
  for (let t = 0; t < scene.texts.length; t += 1) {
    const text = scene.texts[t];
    const bounds = textBox(text);
    if (bounds.x0 < frame[0]) extend(bands, "l", frame[0] - bounds.x0, text.s);
    if (bounds.x1 > frame[0] + frame[2]) {
      extend(bands, "r", bounds.x1 - (frame[0] + frame[2]), text.s);
    }
    if (bounds.y0 < frame[1]) extend(bands, "t", frame[1] - bounds.y0, text.s);
    if (bounds.y1 > frame[1] + frame[3]) {
      extend(bands, "b", bounds.y1 - (frame[1] + frame[3]), text.s);
    }
  }
  const sides = ["left", "right", "top", "bottom"];
  for (let k = 0; k < sides.length; k += 1) {
    const key = sides[k];
    // The slack goes only where something is already kept: an empty side costs nothing.
    if (rails[key] > 0) rails[key] += LABEL_SLACK * fonts[key];
    if (bands[key] > 0) bands[key] += LABEL_SLACK * fonts[key];
  }
  const pad = Math.max(PAD_MIN_USER, FRAME_PAD * frame[2], scene.fs ? scene.fs.w / 2 : 0);
  const left = bands.left + pad;
  const top = bands.top + pad;
  const right = bands.right + pad;
  const bottom = bands.bottom + pad;
  return {
    frame: [0, 0, frame[2], frame[3]],
    box: [-left, -top, frame[2] + left + right, frame[3] + top + bottom],
    rails: rails,
    pad: pad,
  };
}

// A scene drawn in the layout's coordinates: its frame onto the pinned frame, and every number
// that is in user units with it. The scale is per axis because the renderer lays out margins
// that differ by axis. The text keeps one size (the smaller scale), which is all a font can do.
/**
 * @param {import('./types.js').Scene} scene
 * @param {import('./types.js').Layout} layout
 * @returns {import('./types.js').Scene}
 */
function normalize(scene, layout) {
  if (!scene || !layout) return scene;
  const frame = scene.frame;
  const target = layout.frame;
  if (
    !frame ||
    !target ||
    !(frame[2] > 0) ||
    !(frame[3] > 0) ||
    !(target[2] > 0) ||
    !(target[3] > 0)
  ) {
    return scene;
  }
  const sx = target[2] / frame[2];
  const sy = target[3] / frame[3];
  if (!isFinite(sx) || !isFinite(sy) || sx <= 0 || sy <= 0) return scene;
  const font = Math.min(sx, sy);
  const xAt = function (x) {
    return target[0] + (x - frame[0]) * sx;
  };
  const yAt = function (y) {
    return target[1] + (y - frame[1]) * sy;
  };
  const rect = scene.rect;
  const label = function (source) {
    if (!source) return source;
    return {
      t: source.t,
      dx: source.dx * sx,
      dy: source.dy * sy,
      a: source.a,
      s: source.s * font,
      c: source.c,
    };
  };
  return {
    box: scene.box
      ? [xAt(scene.box[0]), yAt(scene.box[1]), scene.box[2] * sx, scene.box[3] * sy]
      : scene.box,
    frame: [target[0], target[1], target[2], target[3]],
    rect: [xAt(rect[0]), yAt(rect[1]), xAt(rect[2]), yAt(rect[3])],
    bg: scene.bg,
    fs: scene.fs ? { c: scene.fs.c, w: scene.fs.w * font } : scene.fs,
    rails: layout.rails,
    lines: scene.lines.map(function (line) {
      return {
        o: line.o,
        v: line.v,
        c: line.c,
        w: line.w * font,
        d: line.d
          ? line.d.map(function (dash) {
              return dash * font;
            })
          : line.d,
        k: line.k,
      };
    }),
    ticks: scene.ticks.map(function (tick) {
      const across = tick.o === "x" ? yAt : xAt;
      const along = tick.o === "x" ? xAt : yAt;
      return {
        o: tick.o,
        v: tick.v,
        at: along(tick.at),
        b: across(tick.b),
        e: across(tick.e),
        k: tick.k,
        s: tick.s,
        c: tick.c,
        w: tick.w * font,
        l: label(tick.l),
      };
    }),
    texts: scene.texts.map(function (text) {
      return {
        t: text.t,
        x: xAt(text.x),
        y: yAt(text.y),
        a: text.a,
        s: text.s * font,
        c: text.c,
        r: text.r ? { a: text.r.a, x: xAt(text.r.x), y: yAt(text.r.y) } : text.r,
      };
    }),
  };
}

// The shaped box of a layout, as `mount` and `pinBox` take it. (The layout's box is the frame
// plus its bands and padding. A raw scene's box is the picture's viewBox and is not used to
// size the card - the layout is.)
/**
 * @param {import('./types.js').Layout} layout
 * @returns {import('./types.js').UserRect|null}
 */
function boxOf(layout) {
  if (!layout || !layout.box) return null;
  return { x: layout.box[0], y: layout.box[1], width: layout.box[2], height: layout.box[3] };
}

/**
 * @param {HTMLElement} container
 * @param {import('./types.js').Scene} scene
 * @param {import('./types.js').Prepared|null} prepared
 * @param {import('./types.js').LogAxes|null} log
 * @param {import('./types.js').UserRect} box
 * @param {() => void} onResize
 * @returns {import('./types.js').Layer|null}
 */
function mount(container, scene, prepared, log, box, onResize) {
  // A plot without a layout box has no shape to draw: mounting it at a guessed box would put
  // every number at the wrong scale. It stays a still picture instead.
  if (!container || !scene || !box || !(box.width > 0) || !(box.height > 0)) return null;
  const svg = container.querySelector("svg");
  // A plot without its picture has nothing to measure or draw over. It stays a still picture.
  if (!svg) return null;
  const canvas = window.document.createElement("canvas");
  canvas.className = "woxi-plot-layer";
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("2d");
  if (!context) return null;
  container.appendChild(canvas);
  const handle = {
    container: container,
    svg: svg,
    canvas: canvas,
    context: context,
    scene: scene,
    prepared: prepared || null,
    log: log || { x: false, y: false },
    box: box,
    scale: 1,
    observer: null,
  };
  // The card can be resized without the plot changing: the keyboard opens, the device rotates,
  // the sheet is dragged. `paint` reads the SVG's box every frame. The same measurement here keeps
  // the gesture maths correct before the first paint. Observe the element whose box `paint`
  // actually reads (the SVG), not the container around it.
  function measureScale() {
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && handle.box.width > 0) handle.scale = rect.width / handle.box.width;
  }
  if (onResize) {
    if (window.ResizeObserver) {
      handle.observer = new window.ResizeObserver(function () {
        measureScale();
        onResize();
      });
      handle.observer.observe(svg);
    } else if (window.addEventListener) {
      handle.viewportListener = function () {
        measureScale();
        onResize();
      };
      window.addEventListener("resize", handle.viewportListener);
    }
  }
  pinBox(svg, handle.box);
  // The renderer's margins are Woxi's. Ours are the scene's. Mark it so the ink trim leaves it
  // alone, and hide it: the canvas is the picture.
  svg.style.visibility = "hidden";
  measureScale();
  return handle;
}

// Sets the parts given. A null leaves that part as it is. Failed decodes are handled in the
// controller (they keep the samples and coverage that are still drawn), so this never needs to
// clear a part.
/**
 * @param {import('./types.js').Layer} handle
 * @param {import('./types.js').Scene|null} scene
 * @param {import('./types.js').Prepared|null} prepared
 * @param {import('./types.js').LogAxes|null} log
 */
function update(handle, scene, prepared, log) {
  if (!handle) return;
  if (scene) handle.scene = scene;
  if (prepared) handle.prepared = prepared;
  if (log) handle.log = log;
}

/**
 * @param {import('./types.js').Layer} handle
 */
function unmount(handle) {
  if (!handle) return;
  if (handle.observer) handle.observer.disconnect();
  if (handle.viewportListener) {
    window.removeEventListener("resize", handle.viewportListener);
    handle.viewportListener = null;
  }
  if (handle.svg) handle.svg.style.visibility = "";
  if (handle.canvas.parentNode) handle.canvas.parentNode.removeChild(handle.canvas);
}

// The curve closed down to a horizontal baseline, for `Filling`.
function fillPath(series, matrix, baseline) {
  const out = new Path2D();
  const points = series.points;
  const firstX = points[0] * matrix.a + matrix.e;
  out.moveTo(firstX, baseline);
  for (let i = 0; i < series.count; i += 1) {
    out.lineTo(points[i * 2] * matrix.a + matrix.e, points[i * 2 + 1] * matrix.d + matrix.f);
  }
  out.lineTo(points[(series.count - 1) * 2] * matrix.a + matrix.e, baseline);
  out.closePath();
  return out;
}

// The corner of a triangle marker as a fraction of its radius, from Woxi's `▲` outline: the
// apex is at (0, 4.33) and the base corners at (±4.99, -4.32) on its reference canvas (`▼` is
// the mirror). The client draws a triangle rather than the glyph, so the proportions travel.
const TRIANGLE_APEX = 4.33 / 4.99;
const TRIANGLE_BASE = 4.32 / 4.99;

function drawMarker(context, kind, x, y, radius, open) {
  context.beginPath();
  if (kind === "square") {
    context.rect(x - radius, y - radius, radius * 2, radius * 2);
  } else if (kind === "diamond") {
    context.moveTo(x, y - radius);
    context.lineTo(x + radius, y);
    context.lineTo(x, y + radius);
    context.lineTo(x - radius, y);
    context.closePath();
  } else if (kind === "up" || kind === "down") {
    const sign = kind === "up" ? -1 : 1;
    context.moveTo(x, y + sign * radius * TRIANGLE_APEX);
    context.lineTo(x + radius, y - sign * radius * TRIANGLE_BASE);
    context.lineTo(x - radius, y - sign * radius * TRIANGLE_BASE);
    context.closePath();
  } else {
    context.arc(x, y, radius, 0, Math.PI * 2);
  }
  if (open) {
    context.stroke();
  } else {
    context.fill();
  }
}

// Draws the value lines: an axis is clamped to its rails (the room its labels need), a grid line
// is drawn at its value. Both are clipped to the frame.
function paintLines(context, scene, mapping, log, frameRect, rails) {
  context.save();
  context.beginPath();
  context.rect(frameRect.x, frameRect.y, frameRect.width, frameRect.height);
  context.clip();
  for (let l = 0; l < scene.lines.length; l += 1) {
    const line = scene.lines[l];
    context.strokeStyle = line.c;
    context.lineWidth = line.w;
    context.setLineDash(line.d || []);
    context.beginPath();
    const along =
      line.k === "a"
        ? axisPosition(line, mapping, log, scene.frame, rails)
        : line.o === "x"
          ? mapping.ax * line.v + mapping.bx
          : mapping.ay * line.v + mapping.by;
    if (line.o === "x") {
      context.moveTo(along, frameRect.y);
      context.lineTo(along, frameRect.y + frameRect.height);
    } else {
      context.moveTo(frameRect.x, along);
      context.lineTo(frameRect.x + frameRect.width, along);
    }
    context.stroke();
  }
  context.setLineDash([]);
  context.restore();
}

// The series, mapped through the view and clipped to the data rectangle. Everything is drawn in
// the picture's own units (the canvas transform is user -> device pixels), so the series matrix
// is the drawing-space -> user affine, not the pixel one.
function paintSeries(context, scene, prepared, mapping, view, log, scale) {
  if (!prepared) return;
  const matrix = {
    a: mapping.ax,
    b: 0,
    c: 0,
    d: mapping.ay,
    e: mapping.bx,
    f: mapping.by,
  };
  const dataRect = scene.rect;
  context.save();
  context.beginPath();
  context.rect(dataRect[0], dataRect[3], dataRect[2] - dataRect[0], dataRect[1] - dataRect[3]);
  context.clip();
  // The samples' stroke, dash and marker sizes are fractions of the picture's image width, which
  // is the scene's own box, not the card's (the card adds the label bands). `normalize` maps the
  // box like the frame, so a picture laid out again at another range keeps the same fraction.
  const image = scene.box[2];
  const strokeFloor = MIN_STROKE_CSS_PX / scale;
  const dashFloor = MIN_DASH_CSS_PX / scale;
  const markerFloor = MIN_MARKER_CSS_PX / scale;
  for (let i = 0; i < prepared.series.length; i += 1) {
    const entry = prepared.series[i];
    const lineWidth = Math.max(strokeFloor, entry.width * image);
    // The fill's baseline is a drawing-space value. A fixed value is pinned to the data. A
    // `Top`/`Bottom` reference follows the view, as Woxi's own render does.
    const baseline = fillBaseline(entry.fill, view, log);
    if (entry.fill && baseline !== null && isFinite(baseline)) {
      context.globalAlpha = Math.max(0, Math.min(1, entry.fill.opacity));
      context.strokeStyle = entry.fill.color || entry.color;
      context.fillStyle = entry.fill.color || entry.color;
      if (entry.scatter) {
        // Woxi's stems are a one-pixel stroke on its 360 px reference canvas, whatever the
        // curve's `Thick`/`Thin`. The payload's fill opacity carries its 0.3 default.
        context.lineWidth = Math.max(strokeFloor, image * STEM_WIDTH_FRACTION);
        context.beginPath();
        for (let j = 0; j < entry.count; j += 1) {
          const dx = entry.points[j * 2] * matrix.a + matrix.e;
          context.moveTo(dx, entry.points[j * 2 + 1] * matrix.d + matrix.f);
          context.lineTo(dx, matrix.d * baseline + matrix.f);
        }
        context.stroke();
      } else {
        context.fill(fillPath(entry, matrix, matrix.d * baseline + matrix.f));
      }
      context.globalAlpha = 1;
    }
    if (entry.count > 1 && !entry.scatter) {
      context.globalAlpha = Math.max(0, Math.min(1, entry.opacity));
      context.strokeStyle = entry.color;
      context.lineWidth = lineWidth;
      context.lineJoin = "round";
      context.lineCap = entry.dashes && entry.dashes.indexOf(0) >= 0 ? "round" : "butt";
      if (entry.dashes) {
        const dashes = [];
        for (let d = 0; d < entry.dashes.length; d += 1) {
          dashes.push(Math.max(dashFloor, entry.dashes[d] * image));
        }
        context.setLineDash(dashes);
      } else {
        context.setLineDash([]);
      }
      const path = new Path2D();
      path.addPath(entry.path, matrix);
      context.stroke(path);
      context.setLineDash([]);
      context.globalAlpha = 1;
    }
    if (entry.radius > 0) {
      const radius = Math.max(markerFloor, entry.radius * image);
      context.globalAlpha = Math.max(0, Math.min(1, entry.opacity));
      context.fillStyle = entry.color;
      context.strokeStyle = entry.color;
      context.lineWidth = lineWidth;
      const kind = entry.marker || "circle";
      for (let k = 0; k < entry.count; k += 1) {
        const markerX = entry.points[k * 2] * matrix.a + matrix.e;
        const markerY = entry.points[k * 2 + 1] * matrix.d + matrix.f;
        // Culled by the clip, not by the frame: outside it nothing would be drawn anyway.
        if (markerX < dataRect[0] - radius || markerX > dataRect[2] + radius) continue;
        if (
          markerY < Math.min(dataRect[1], dataRect[3]) - radius ||
          markerY > Math.max(dataRect[1], dataRect[3]) + radius
        )
          continue;
        drawMarker(context, kind, markerX, markerY, radius, entry.markerOpen);
      }
      context.globalAlpha = 1;
    }
  }
  context.restore();
}

// The ticks and their labels. Both follow the data: an axis tick's base is its axis's clamped
// position, and its position along the axis is its value through the view. A frame tick's base
// is its frame edge, and its position along the edge is its value too, so a gesture moves the
// tick with the curve at display rate instead of leaving it at the position of the answer it
// came from. The label's own area is the frame for an axis label (its rail) and the card for a
// frame label (its band). Woxi puts those labels on different sides of the frame, so only the
// area differs. Placement, the along-edge fit and the clamp are one rule for both.
function paintTicks(context, scene, mapping, log, frameRect, box) {
  const font = PLOT_FONT;
  const inside = {
    x: frameRect.x,
    y: frameRect.y,
    x1: frameRect.x + frameRect.width,
    y1: frameRect.y + frameRect.height,
  };
  const card = { x: box.x, y: box.y, x1: box.x + box.width, y1: box.y + box.height };
  for (let t = 0; t < scene.ticks.length; t += 1) {
    const tick = scene.ticks[t];
    const at = tick.o === "x" ? mapping.ax * tick.v + mapping.bx : mapping.ay * tick.v + mapping.by;
    const fits =
      tick.o === "x"
        ? at >= inside.x - FIT_SLACK && at <= inside.x1 + FIT_SLACK
        : at >= inside.y - FIT_SLACK && at <= inside.y1 + FIT_SLACK;
    if (!fits) continue;
    const mark = tickPlace(tick, scene, mapping, log);
    if (!mark) continue;
    context.strokeStyle = tick.c;
    context.lineWidth = tick.w;
    context.beginPath();
    if (tick.o === "x") {
      context.moveTo(at, mark.base);
      context.lineTo(at, mark.tip);
    } else {
      context.moveTo(mark.base, at);
      context.lineTo(mark.tip, at);
    }
    context.stroke();
    const label = tick.l;
    if (!label) continue;
    const width = textWidth(label.t, label.s);
    // The area the label must stay in: the frame for an axis label, the card for a frame label.
    const bounds = tick.k === "a" ? inside : card;
    // Along the edge a label that would cross the end of its area is left out (its tick is still
    // drawn): shifted along the edge it would no longer mark its tick, and a clipped text reads
    // worse than a missing one. A frame label's band reserves the overhang, so it passes here.
    if (tick.o === "x") {
      if (at - width / 2 < bounds.x || at + width / 2 > bounds.x1) continue;
    } else if (
      at - (LABEL_LINE * label.s) / 2 < bounds.y ||
      at + (LABEL_LINE * label.s) / 2 > bounds.y1
    ) {
      continue;
    }
    const labelBounds = labelInk(label, width);
    let labelX = tick.o === "x" ? at + label.dx : mark.base + label.dx;
    let labelY = tick.o === "x" ? mark.base + label.dy : at + label.dy;
    if (labelX + labelBounds.x0 < bounds.x) labelX += bounds.x - (labelX + labelBounds.x0);
    if (labelX + labelBounds.x1 > bounds.x1) labelX -= labelX + labelBounds.x1 - bounds.x1;
    if (labelY + labelBounds.y0 < bounds.y) labelY += bounds.y - (labelY + labelBounds.y0);
    if (labelY + labelBounds.y1 > bounds.y1) labelY -= labelY + labelBounds.y1 - bounds.y1;
    context.font = label.s + "px " + font;
    context.fillStyle = label.c;
    context.textAlign = label.a === "middle" ? "center" : label.a === "end" ? "right" : "left";
    context.textBaseline = "alphabetic";
    context.fillText(label.t, labelX, labelY);
  }
}

// Static texts (titles, axis labels) do not move with the data and do not need a data mapping:
// they are drawn where the renderer put them. A rotated label turns about its own anchor, which
// is what the renderer wrote in `transform`.
function paintTexts(context, scene) {
  const font = PLOT_FONT;
  for (let s = 0; s < scene.texts.length; s += 1) {
    const text = scene.texts[s];
    context.font = text.s + "px " + font;
    context.fillStyle = text.c;
    context.textAlign = text.a === "middle" ? "center" : text.a === "end" ? "right" : "left";
    context.textBaseline = "alphabetic";
    if (text.r) {
      context.save();
      context.translate(text.r.x, text.r.y);
      context.rotate((text.r.a * Math.PI) / 180);
      context.fillText(text.t, text.x - text.r.x, text.y - text.r.y);
      context.restore();
    } else {
      context.fillText(text.t, text.x, text.y);
    }
  }
}

// Draws the scene and the series at `view`. This is the whole renderer: it runs at rest and on
// every gesture frame. It measures the picture's box (the SVG's rect) each frame, but never
// reads the picture's contents. The series is drawn before the labels so a curve cannot cover
// them. Both are in the picture's user units.
/**
 * @param {import('./types.js').Layer} handle
 * @param {import('./types.js').View} view
 * @returns {boolean}
 */
function paint(handle, view) {
  if (!handle || !view) return false;
  const scene = handle.scene;
  const container = handle.container;
  const canvas = handle.canvas;
  const context = handle.context;
  const box = handle.box;
  if (!scene || !box || !(box.width > 0) || !(box.height > 0)) return false;
  const origin = container.getBoundingClientRect();
  const element = handle.svg.getBoundingClientRect();
  if (!element || !(element.width > 0)) return false;
  // A view that cannot be mapped is a corrupt scene or a range the caller should have repaired.
  // Do not clear the canvas for it: the last frame stays visible, and the controller counts the
  // failed paint instead of showing a bare frame.
  const mapping = sceneMapping(scene, view, handle.log);
  if (!mapping) return false;
  // CSS pixels per user unit. The canvas covers the SVG's box, which is the pinned box.
  const scale = element.width / box.width;
  handle.scale = scale;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(element.width * dpr));
  const pixelHeight = Math.max(1, Math.round(element.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const style = canvas.style;
  style.left = element.left - origin.left + "px";
  style.top = element.top - origin.top + "px";
  style.width = element.width + "px";
  style.height = element.height + "px";

  // Everything below draws in user units: the transform is user -> device pixels.
  context.setTransform(dpr * scale, 0, 0, dpr * scale, -box.x * scale * dpr, -box.y * scale * dpr);
  context.clearRect(box.x, box.y, box.width, box.height);
  // The background covers the whole box, as the renderer's own background rect does.
  context.fillStyle = scene.bg;
  context.fillRect(box.x, box.y, box.width, box.height);

  const frame = scene.frame;
  const frameRect = { x: frame[0], y: frame[1], width: frame[2], height: frame[3] };
  paintLines(context, scene, mapping, handle.log, frameRect, scene.rails);
  if (scene.fs) {
    context.strokeStyle = scene.fs.c;
    context.lineWidth = scene.fs.w;
    context.strokeRect(frameRect.x, frameRect.y, frameRect.width, frameRect.height);
  }
  paintSeries(context, scene, handle.prepared, mapping, view, handle.log, scale);
  paintTicks(context, scene, mapping, handle.log, frameRect, box);
  paintTexts(context, scene);
  return true;
}

export {
  axisPosition,
  boxOf,
  dataMapping,
  fillBaseline,
  layoutOf,
  mount,
  normalize,
  paint,
  pinBox,
  sceneMapping,
  tickPlace,
  unmount,
  update,
};
