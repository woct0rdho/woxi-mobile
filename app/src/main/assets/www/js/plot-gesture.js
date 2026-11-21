// The pure gesture maths and the sample-margin rules: finger pixels to a data range, two
// fingers to a pan and a zoom (on one axis or both), a coverage judgment and the margin a
// re-sample asks for. The controller (`plot-interact.js`) owns the DOM, the queue and the
// engine messages. This module needs neither, so `tests/plot-maths.test.js` exercises it
// directly.

const PINCH_MIN = 0.2; // the most one pinch step may scale by (5x)
// A two-finger gesture whose initial finger line is within this many degrees of an axis scales
// that axis only. Anything further from an axis scales both axes uniformly. The line is the one
// through the two fingers when the second finger lands, and the mode stays latched until both
// lift.
const PINCH_AXIS_DEGREES = 15;
const PINCH_AXIS_TAN = Math.tan((PINCH_AXIS_DEGREES * Math.PI) / 180);
// Decades a logarithmic axis is allowed to cover when a range that reaches zero has to be
// repaired. The engine guards the same way (`LOG_FALLBACK_DECADES` in
// engine/src/plot/handle.rs) and reports the repaired range back.
const LOG_FALLBACK_DECADES = 12;
// A re-sample re-runs the plot call, which is heavier than a crop, so it is one of the framed
// requests. A view this much narrower than the samples is worth one.
const ZOOM_IN = 0.25;
// Refill a view that is about to run out of data, not one that already has. The trigger is the
// remaining margin as a share of the view (see `coverageShort`).
const REFINE_NEAR = 0.3;
// A pan or pinch sample margin, in views. The first interaction is allowed a larger lag (the
// plot is drawn with only the initial samples), then every re-sample keeps at least this much
// data past the view. A faster finger gets a larger margin from `refinePad`.
const MIN_REFINE_PAD = 1.0;
const FIRST_REFINE_PAD = 2.5;
const MAX_REFINE_PAD = 4.0;
// The engine caps a two-axis re-sample lower (`TWO_AXIS_MAX_REFINE_PAD` in
// engine/src/plot/handle.rs): its margin costs area, not a strip. The client keeps the same cap
// so the margin it asks for is the margin it gets.
const TWO_AXIS_REFINE_PAD = 1.0;
// A re-sample asked for because a zoom-in made the samples too coarse to draw: keep it tight so
// the points go where the eye is, but not so tight that the coverage check fires again at once.
const RESOLUTION_REFINE_PAD = 0.5;
// The margin covers the distance the finger travels during a round trip, plus a fixed cushion
// for the answer that is already on its way when the finger stops.
const REFINE_LATENCY_CUSHION_MS = 150;
const REFINE_LEAD_EXTRA = 0.5;
// The margin is rounded to this fraction of a view: finer steps are below what a finger can tell.
const REFINE_PAD_QUANTUM = 0.25;
// Weight of the previous estimate in the finger-speed EMA. A new move contributes 1 - this.
const SPEED_EMA = 0.6;
// A plot with a fixed parameter domain (parametric, polar) gains detail by being drawn with more
// points, not by sampling a different range. Only a few times. The engine clamps the level too.
const DENSIFY_MAX_LEVEL = 3;

function spanOf(range, logarithmic) {
  if (!range || !(range[1] > range[0])) return 0;
  if (logarithmic && range[0] > 0) return Math.log10(range[1] / range[0]);
  return range[1] - range[0];
}

function coverageShort(view, data, near, logarithmic) {
  if (view[0] < data[0] || view[1] > data[1]) return true;
  const span = spanOf(view, logarithmic);
  const dataSpan = spanOf(data, logarithmic);
  if (!(span > 0) || !(dataSpan > 0)) return false;
  const margin =
    logarithmic && view[0] > 0 && data[0] > 0
      ? Math.min(Math.log10(view[0] / data[0]), Math.log10(data[1] / view[1]))
      : Math.min(view[0] - data[0], data[1] - view[1]);
  return margin < span * near;
}

// A view this much narrower than the view at the last re-sample is worth a denser one. The
// basis is the view span, not the samples' (padded) range: a large coverage pad would otherwise
// look like a zoom-in and shrink the very margin it just added.
function tooCoarse(viewSpan, basisSpan) {
  return basisSpan > 0 && viewSpan < basisSpan * ZOOM_IN;
}

// Why this view needs samples, if it does: `coverage` (outside the samples, or about to run out),
// `resolution` (a zoom-in since the last re-sample), or null. Both axes are asked: a two-axis
// plot's samples are padded vertically as well. `basis` is the view span each axis had at the
// last re-sample. When absent, the current view is the basis (no resolution request).
function refineKind(view, samples, log, basis) {
  if (!view || !view.x || !samples || !samples.s || !samples.d) return null;
  if (coverageShort(view.x, samples.d, REFINE_NEAR, log && log.x)) return "coverage";
  if (samples.dy && view.y && coverageShort(view.y, samples.dy, REFINE_NEAR, log && log.y)) {
    return "coverage";
  }
  const b = basis || { x: spanOf(view.x, log && log.x), y: spanOf(view.y, log && log.y) };
  if (tooCoarse(spanOf(view.x, log && log.x), b.x)) return "resolution";
  if (samples.dy && view.y && tooCoarse(spanOf(view.y, log && log.y), b.y)) return "resolution";
  return null;
}

// The sample margin to ask for: the first coverage re-sample gets a large one (the plot was
// drawn with only the initial samples, and the user is told the first pan may lag). Afterward
// the margin covers the distance the finger travels during a round trip, with a floor and a cap.
function refinePad(kind, covered, speed, latencyMs, twoAxis) {
  if (kind === "resolution") return RESOLUTION_REFINE_PAD;
  const lead = (Math.max(0, speed) * (Math.max(0, latencyMs) + REFINE_LATENCY_CUSHION_MS)) / 1000;
  let pad = Math.min(MAX_REFINE_PAD, Math.max(MIN_REFINE_PAD, lead + REFINE_LEAD_EXTRA));
  if (!covered) pad = Math.max(pad, FIRST_REFINE_PAD);
  if (twoAxis) pad = Math.min(pad, TWO_AXIS_REFINE_PAD);
  return Math.round(pad / REFINE_PAD_QUANTUM) * REFINE_PAD_QUANTUM;
}

// The drawing-space span of each axis of a view, for the resolution basis.
function viewBasis(view, log) {
  if (!view || !view.x || !view.y) return null;
  return { x: spanOf(view.x, log && log.x), y: spanOf(view.y, log && log.y) };
}

// How much of a view a pointer move crossed, as a share of the view's span. The gesture math
// uses the drawing space (decades on a log axis), so a speed in views/s means the same thing on
// both kinds of axis.
function movedShare(from, to, logarithmic) {
  if (!from || !to) return 0;
  const span = spanOf(from, logarithmic);
  if (!(span > 0)) return 0;
  const a = logarithmic && from[0] > 0 && to[0] > 0 ? Math.log10(to[0] / from[0]) : to[0] - from[0];
  return Math.abs(a) / span;
}

// A fixed-domain plot can be redrawn with more points. That is the only way to show detail
// inside the domain it already has.
function needsDensify(view, samples, level) {
  if (!view || !view.x || !samples || !samples.dn || !samples.d) return false;
  if (level >= DENSIFY_MAX_LEVEL) return false;
  const span = view.x[1] - view.x[0];
  const domain = samples.d[1] - samples.d[0];
  if (!(span > 0) || !(domain > 0)) return false;
  return span < domain * ZOOM_IN;
}

// A log axis has no data at or below zero: the renderer draws an axis-less picture for a range
// that reaches it (measured: 762 B, one polyline, no ticks, labels or frame), which yields no
// scene and so cannot be served. The gesture maths therefore keeps the range positive - a pan
// multiplies both bounds, a zoom scales decades - and only a stored view from an older build,
// or a zoom-out past LOG_FALLBACK_DECADES, can reach the wall. There it stops that axis (like a
// box against the edge: the other axis keeps moving).
//
// The decades limit is the samples' payload: they are u16 pairs over the drawing (log) range,
// so twelve decades quantize a curve to 12/65536 of an axis height (a fifth of a pixel on a
// phone), while a three-hundred-decade range would step by pixels. The layout of a log axis
// is no longer special: the renderer draws its line at the low end (there is no origin to
// cross), the scene calls it an axis (`k: 'a'`) and the client clamps it to that rail, and the
// same tick/label machinery as a linear axis keeps the ticks on it. Only this domain constraint
// remains.
function logBound(low, high) {
  if (!(high > 0) || !isFinite(high)) return null;
  return low > 0 ? low : high / Math.pow(10, LOG_FALLBACK_DECADES);
}

// Dragging moves the picture with the finger: right shows lower x, down shows higher y.
// `mapping` is the data-to-screen map the canvas draws with, so a pixel of finger movement is a
// pixel of curve movement. A linear axis translates both bounds by the same shift. A log axis
// multiplies both, which keeps them positive and moves the window by the same distance in
// decades.
function panViewFrom(view, dx, dy, mapping, log) {
  if (!view || !mapping || !(mapping.a > 0) || !(mapping.d < 0)) return null;
  const logX = !!(log && log.x);
  const logY = !!(log && log.y);
  const shiftX = dx / mapping.a;
  const shiftY = -dy / mapping.d;
  const factor = Math.pow(10, -shiftX);
  const yFactor = Math.pow(10, shiftY);
  const xHigh = logX ? view.x[1] * factor : view.x[1] - shiftX;
  const yHigh = logY ? view.y[1] * yFactor : view.y[1] + shiftY;
  const xLow = logX ? logBound(view.x[0] * factor, xHigh) : view.x[0] - shiftX;
  const yLow = logY ? logBound(view.y[0] * yFactor, yHigh) : view.y[0] + shiftY;
  if (xLow === null || yLow === null) return null;
  return {
    id: view.id,
    x: [xLow, xHigh],
    y: [yLow, yHigh],
  };
}

// Which axes a two-finger spread constrains, from the line through the fingers when the pinch
// starts. Within `PINCH_AXIS_DEGREES` of horizontal it is an x pinch, within the same angle of
// vertical a y pinch, and every other orientation (including a coincident pair) is a uniform
// pinch. The mode is latched by the controller. This function only reads the start line.
function pinchMode(a, b) {
  if (!a || !b) return "uniform";
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  if (!(dx > 0) && !(dy > 0)) return "uniform";
  if (dy <= dx * PINCH_AXIS_TAN) return "x";
  if (dx <= dy * PINCH_AXIS_TAN) return "y";
  return "uniform";
}

// Scales each range about its own fixed anchor, given in fractions of the axis (of its decades
// on a log axis): each endpoint moves toward or away from the anchor, rather than the range
// being re-centered on it. Factor 1 is then the identity at every anchor, and the data point
// under the finger stays under the finger. A pinch that closes to a fraction of its starting
// gap is a fast zoom: clamp the step instead of refusing it. Different factors are how an axis
// pinch is drawn. The caller scales the other axis by 1.
function zoomAxesViewFrom(view, sx, sy, fx, fy, log) {
  if (!view || !(sx > 0) || !(sy > 0)) return null;
  sx = Math.max(sx, PINCH_MIN);
  sy = Math.max(sy, PINCH_MIN);
  const logX = !!(log && log.x);
  const logY = !!(log && log.y);
  const ax = logX
    ? Math.pow(10, Math.log10(view.x[0]) + fx * (Math.log10(view.x[1]) - Math.log10(view.x[0])))
    : view.x[0] + fx * (view.x[1] - view.x[0]);
  const ay = logY
    ? Math.pow(10, Math.log10(view.y[1]) - fy * (Math.log10(view.y[1]) - Math.log10(view.y[0])))
    : view.y[1] - fy * (view.y[1] - view.y[0]);
  if (logX && !(ax > 0)) return null;
  if (logY && !(ay > 0)) return null;
  const scaled = function (value, anchor, logarithmic, factor) {
    if (!logarithmic) return anchor + (value - anchor) / factor;
    return Math.pow(10, Math.log10(anchor) + (Math.log10(value) - Math.log10(anchor)) / factor);
  };
  let xLow = scaled(view.x[0], ax, logX, sx);
  let yLow = scaled(view.y[0], ay, logY, sy);
  const xHigh = scaled(view.x[1], ax, logX, sx);
  const yHigh = scaled(view.y[1], ay, logY, sy);
  if (logX) xLow = logBound(xLow, xHigh);
  if (logY) yLow = logBound(yLow, yHigh);
  if (xLow === null || yLow === null) return null;
  return {
    id: view.id,
    x: [xLow, xHigh],
    y: [yLow, yHigh],
  };
}

function zoomViewFrom(view, factor, fx, fy, log) {
  return zoomAxesViewFrom(view, factor, factor, fx, fy, log);
}

// Where a screen point sits on each axis, in fractions from the left and from the top.
function fractionOf(view, mapping, x, y, log) {
  const logX = !!(log && log.x);
  const logY = !!(log && log.y);
  const ux = (x - mapping.b) / mapping.a;
  const uy = (y - mapping.f) / mapping.d;
  const x0 = logX ? Math.log10(view.x[0]) : view.x[0];
  const x1 = logX ? Math.log10(view.x[1]) : view.x[1];
  const y0 = logY ? Math.log10(view.y[0]) : view.y[0];
  const y1 = logY ? Math.log10(view.y[1]) : view.y[1];
  return {
    fx: (ux - x0) / (x1 - x0),
    fy: 1 - (uy - y0) / (y1 - y0),
  };
}

// The pinch's anchor: the midpoint of two fingers as a fraction of the view. The pointer
// coordinates are the page's. The mapping's are the container's own, so the container's corner
// is taken off first.
function pinchAnchor(view, mapping, a, b, rect, log) {
  return fractionOf(view, mapping, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, log);
}

// A view whose logarithmic axis reaches zero. An older stored view can hold one, and a
// zoom-out past the logarithmic fallback can reach it too. It cannot be drawn, so it is
// repaired before it is used as a gesture's start. The rule is the engine's
// (`drawable_view`): a range whose high bound is not positive either is left alone, because
// moving its low bound would only swap one undrawable range for another.
function positiveView(view, log) {
  if (!view || !view.x || !view.y) return view;
  const axis = function (range, logarithmic) {
    if (!logarithmic || range[0] > 0 || !(range[1] > 0)) return range;
    return [range[1] / Math.pow(10, LOG_FALLBACK_DECADES), range[1]];
  };
  const out = {
    id: view.id,
    x: axis(view.x, log && log.x),
    y: axis(view.y, log && log.y),
  };
  // The saved range also carries the sample capability flags (`s`/`dn`), and a repair must not
  // lose them.
  if (typeof view.s === "boolean") out.s = view.s;
  if (typeof view.dn === "boolean") out.dn = view.dn;
  return out;
}

export {
  DENSIFY_MAX_LEVEL,
  fractionOf,
  LOG_FALLBACK_DECADES,
  MAX_REFINE_PAD,
  movedShare,
  needsDensify,
  panViewFrom,
  PINCH_AXIS_DEGREES,
  pinchAnchor,
  pinchMode,
  positiveView,
  REFINE_NEAR,
  refineKind,
  refinePad,
  SPEED_EMA,
  TWO_AXIS_REFINE_PAD,
  viewBasis,
  ZOOM_IN,
  zoomAxesViewFrom,
  zoomViewFrom,
};
