// Camera, projection and tick helpers for 3D plots. These are pure functions so the
// client's initial view and its tick values can be tested without a browser.
//
// Woxi projects a 3D point to the screen with the camera's right/up basis and, for a
// perspective camera, spreads it away from the point the camera looks at by
// `dist / (dist - dot(p, toward))`. The client uses the same formula and the same
// Woxi tick formatting. The card's fixed scale and view-dependent axis edges are
// described in `plot3d-axes.js`.

export function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

// The tick target shared by the client's automatic axes.
const TICKS_PER_AXIS = 4;

const MAX_TICKS = 100;
const TICK_EPSILON = 0.01;
const MAX_TICK_DECIMALS = 6;
const DECIMAL_EPSILON = 1e-6;
const SCIENTIFIC_EPSILON = 1e-9;
const SCIENTIFIC_DECIMALS = 3;
const SCIENTIFIC_BELOW = 1e-5;
const SCIENTIFIC_ABOVE = 1e6;
const ZERO_EPSILON = 1e-6;

// The camera's screen basis and the direction toward the viewer.
export function cameraBasis(azimuth, elevation) {
  // Woxi levels the camera against the vertical at the poles: the top/bottom
  // view puts x to the right and y up/down, independent of azimuth.
  if (Math.abs(Math.abs(elevation) - Math.PI / 2) < 1e-9) {
    const s = elevation > 0 ? 1 : -1;
    return { right: [1, 0, 0], up: [0, s, 0], toward: [0, 0, s] };
  }
  const sa = Math.sin(azimuth);
  const ca = Math.cos(azimuth);
  const se = Math.sin(elevation);
  const ce = Math.cos(elevation);
  return {
    right: [-sa, ca, 0],
    up: [-ca * se, -sa * se, ce],
    toward: [ce * ca, ce * sa, se],
  };
}

function dot(point, axis) {
  return point[0] * axis[0] + point[1] * axis[1] + point[2] * axis[2];
}

export const PERSPECTIVE_EPSILON = 1e-6;

// Project a point in the normalized box to clip-ish coordinates.
// `scaleX`/`scaleY` divide the two screen axes. The caller maps the result
// to pixels. The normalized box and the camera both look at the origin.
export function projectPoint(point, camera, scaleX, scaleY) {
  const basis = camera.basis || cameraBasis(camera.az, camera.el);
  const sx = dot(point, basis.right);
  const sy = dot(point, basis.up);
  const depth = dot(point, basis.toward);
  let factor = 1;
  if (camera.perspective !== false) {
    const gap = camera.dist - depth;
    if (gap > camera.dist * PERSPECTIVE_EPSILON) factor = camera.dist / gap;
  }
  return {
    x: (sx * factor) / scaleX,
    y: (sy * factor) / scaleY,
    depth,
  };
}

// The camera depth window must contain the box's bounding sphere. The fraction
// is a lower bound for very small boxes, where a fixed near plane would cross
// the far plane and invert the depth test.
const DEPTH_MARGIN = 2.4;
const MIN_NEAR_FRACTION = 1e-6;

// The turntable's elevation limit, in radians (about 86 degrees). Rotation past
// this would look at the box from underneath its own lid.
export const MAX_ELEVATION = 1.5;

// How coarsely the reachable camera orientations are sampled when a size has to
// hold for every one of them. The extents change smoothly, so this is enough to
// find their maximum. A finer grid changes nothing visible.
const ENVELOPE_AZIMUTHS = 24;
const ENVELOPE_ELEVATIONS = 7;

// The eight corners of the normalized box, in the order the box edges index.
export function boxCorners(box) {
  const [x, y, z] = box;
  return [
    [-x, -y, -z],
    [x, -y, -z],
    [-x, y, -z],
    [x, y, -z],
    [-x, -y, z],
    [x, -y, z],
    [-x, y, z],
    [x, y, z],
  ];
}

// The half-extents of the box's projected rectangle at one camera, in projection
// units (what `projectPoint` returns before its division by the scale). The
// projection is not symmetric under perspective, so this takes the larger of the
// two sides: the box is drawn centred on the box centre, which is what the fit
// must fit.
export function projectedExtent(box, camera) {
  const corners = boxCorners(box);
  let x = 0;
  let y = 0;
  for (const corner of corners) {
    const point = projectPoint(corner, camera, 1, 1);
    x = Math.max(x, Math.abs(point.x));
    y = Math.max(y, Math.abs(point.y));
  }
  return { x, y };
}

// The camera orientations a fitted size has to hold at: the whole turntable, in
// evenly spaced steps. The default steps are fine enough to find the maximum of
// the extents and coarse enough to stay cheap.
export function cameraGrid(
  camera,
  azimuthCount = ENVELOPE_AZIMUTHS,
  elevationCount = ENVELOPE_ELEVATIONS
) {
  // Only the angles and the projection change. A caller's stale basis is left out.
  const { dist, perspective } = camera;
  const out = [];
  for (let e = 0; e < elevationCount; e += 1) {
    const el =
      elevationCount > 1 ? -MAX_ELEVATION + (2 * MAX_ELEVATION * e) / (elevationCount - 1) : 0;
    for (let a = 0; a < azimuthCount; a += 1) {
      out.push({ az: (2 * Math.PI * a) / azimuthCount, el, dist, perspective });
    }
  }
  return out;
}

// The largest half-extents the box's projected rectangle reaches over every
// reachable camera orientation. Fitting the box to this envelope keeps it the same
// size at every orientation and never lets the card crop it, which is what a
// picture that can be rotated needs and what a picture that cannot does not.
export function projectedEnvelope(box, camera) {
  let x = 0;
  let y = 0;
  for (const view of cameraGrid(camera)) {
    const extent = projectedExtent(box, view);
    x = Math.max(x, extent.x);
    y = Math.max(y, extent.y);
  }
  return { x, y };
}

// The card's width/height ratio for a box of this envelope. A card shaped like the
// envelope is the only shape in which the box can fill it and still fit at every
// orientation. Tall boxes are capped, as Woxi caps a 3D picture's height at 1.2
// times its width.
export function envelopeAspect(envelope) {
  const ratio = envelope.y > 0 ? envelope.x / envelope.y : 1;
  return Number.isFinite(ratio) && ratio > 0 ? Math.max(ratio, 1 / 1.2) : 1;
}

// The projection scale (`scaleX`, in box units per unit of clip space) that fits
// the `halfX` x `halfY` envelope into a `width` x `height` card, leaving `pads` for
// the tick labels. The scale is the same in both directions in pixels, so the box
// keeps its shape: the caller's `scaleY` is `scaleX * height / width`.
//
// The box stays centred on the card - the centre is the pivot a pinch zooms
// about - so a pad on one side has to be matched on the other.
export function fitScale(halfX, halfY, width, height, pads) {
  const pad = pads || {};
  const roomX = Math.max(1, width - 2 * Math.max(pad.left || 0, pad.right || 0));
  const roomY = Math.max(1, height - 2 * Math.max(pad.top || 0, pad.bottom || 0));
  return Math.max((halfX * width) / roomX, (halfY * width) / roomY);
}

// The near/far planes for a box whose camera distance is `distance`.
export function depthRange(distance, box) {
  const radius = Math.hypot(box[0], box[1], box[2]);
  const padding = Math.max(radius * DEPTH_MARGIN, Number.EPSILON);
  const [near, far] = [
    Math.max(distance - padding, distance * MIN_NEAR_FRACTION),
    distance + padding,
  ];
  return [near, far];
}

// The point on the viewport-parallel plane through the box centre under a client
// coordinate. At depth zero the perspective factor is one, so this is a plain
// right/up displacement in box coordinates.
export function viewportPlanePoint(x, y, width, height, basis, scaleX, scaleY) {
  const ndcX = width > 0 ? (x / width) * 2 - 1 : 0;
  const ndcY = height > 0 ? 1 - (y / height) * 2 : 0;
  return [
    basis.right[0] * ndcX * scaleX + basis.up[0] * ndcY * scaleY,
    basis.right[1] * ndcX * scaleX + basis.up[1] * ndcY * scaleY,
    basis.right[2] * ndcX * scaleX + basis.up[2] * ndcY * scaleY,
  ];
}

// The data view whose box coordinates satisfy `b' = scale * b + translate` per
// axis. A screen-space similarity about the box-centre plane is exactly this
// transform, so points on that plane follow the fingers.
export function transformView(view, box, scale, translate) {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return view.map(([low, high], axis) => {
    const span = high - low;
    const ratio = box[axis] > 0 ? box[axis] : 1;
    const half = span / (2 * safeScale);
    const middle = (low + high) / 2;
    const shift = translate ? translate[axis] || 0 : 0;
    const nextMiddle = middle - (shift * span) / (2 * ratio * safeScale);
    return [nextMiddle - half, nextMiddle + half];
  });
}

// Keep a transformed view inside the sampled/gesture bounds, shrinking it
// when the requested span is larger than the available span.
export function fitView(view, coverage) {
  return view.map(([low, high], axis) => {
    const span = high - low;
    const [coverLow, coverHigh] = coverage[axis] || [low, high];
    const coverSpan = coverHigh - coverLow;
    if (!(span > 0) || !(coverSpan > 0)) return [low, high];
    const width = Math.min(span, coverSpan);
    const middle =
      width >= coverSpan
        ? (coverLow + coverHigh) / 2
        : clamp((low + high) / 2, coverLow + width / 2, coverHigh - width / 2);
    return [middle - width / 2, middle + width / 2];
  });
}

// The smallest zoom-out factor allowed by the viewport bounds.
export function zoomFloor(view, bounds) {
  let floor = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const span = view[axis][1] - view[axis][0];
    const bound = bounds[axis][1] - bounds[axis][0];
    if (span > 0 && bound > 0 && span < bound) {
      floor = Math.min(floor, span / bound);
    }
  }
  return floor;
}

// The largest zoom-in factor allowed by the absolute minimum spans.
export function zoomCeiling(view, minimums) {
  let ceiling = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const span = view[axis][1] - view[axis][0];
    const minimum = minimums[axis];
    if (span > 0 && minimum > 0) ceiling = Math.min(ceiling, span / minimum);
  }
  // A view that is already inside the absolute limit may zoom out but not
  // farther in. Never return a ceiling that reverses the gesture.
  return Number.isFinite(ceiling) ? Math.max(1, ceiling) : 1;
}

// A uniform zoom about the box-centre plane. `factor > 1` zooms in.
export function zoomView(view, box, factor) {
  const scale = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return transformView(view, box, scale, [0, 0, 0]);
}

// The per-axis scale and offset from data space to the fixed box. Keep this
// expression in sync with the shader's `uViewLow`/`uViewSpan` mapping.
export function boxMapping(view, box) {
  const scale = [0, 1, 2].map((axis) => {
    const span = view[axis][1] - view[axis][0];
    return span > 0 ? (2 * box[axis]) / span : 0;
  });
  const offset = [0, 1, 2].map((axis) =>
    scale[axis] > 0 ? -view[axis][0] * scale[axis] - box[axis] : 0
  );
  return { scale, offset };
}

// A data-space point in the fixed normalized box for the current view.
export function dataToBox(point, view, box) {
  const { scale, offset } = boxMapping(view, box);
  return [0, 1, 2].map((axis) => point[axis] * scale[axis] + offset[axis]);
}

// The 1/2/5 step for a span.
export function niceStep(span) {
  if (!(span > 0) || !Number.isFinite(span)) return 0;
  const raw = span / TICKS_PER_AXIS;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  return (
    (normalized <= 1
      ? 1
      : normalized <= 2
        ? 2
        : normalized <= 2.5
          ? 2.5
          : normalized <= 5
            ? 5
            : 10) * magnitude
  );
}

// Nice tick values over [low, high], the same 1/2/5 progression Woxi uses.
export function tickValues(low, high) {
  const span = high - low;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const step = niceStep(span);
  if (!(step > 0) || !Number.isFinite(step)) return [];
  return valuesForStep(low, high, step);
}

// Tick values at an explicit spacing.
export function valuesForStep(low, high, step) {
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const values = [];
  let value = Math.ceil(low / step) * step;
  for (let guard = 0; guard < MAX_TICKS && value <= high + step * TICK_EPSILON; guard += 1) {
    values.push(value);
    if (value + step === value) break;
    value += step;
  }
  return values;
}

function tickStepDecimals(step) {
  const magnitude = Math.abs(step);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return 0;
  for (let digits = 0; digits <= MAX_TICK_DECIMALS; digits += 1) {
    const scaled = magnitude * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < DECIMAL_EPSILON * Math.max(1, scaled)) {
      return digits;
    }
  }
  return MAX_TICK_DECIMALS;
}

function scientificTick(value) {
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  const mantissa = value / 10 ** exponent;
  const rounded = Math.abs(mantissa - Math.round(mantissa)) < SCIENTIFIC_EPSILON;
  const text = rounded
    ? String(Math.round(mantissa))
    : mantissa.toFixed(SCIENTIFIC_DECIMALS).replace(/0+$/, "").replace(/\.$/, "");
  const superscript = String(exponent)
    .replace(/-/g, "⁻")
    .replace(/[0-9]/g, (digit) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(digit)]);
  return text + "×10" + superscript;
}

// A tick label with the decimals the step needs, as Woxi writes it.
export function formatTick(value, step) {
  const magnitude = Math.abs(step);
  if (magnitude > 0 && magnitude < SCIENTIFIC_BELOW) {
    if (Math.abs(value) < magnitude * ZERO_EPSILON) return "0";
    return scientificTick(value);
  }
  const decimals = tickStepDecimals(step);
  const effectivelyZero = magnitude > 0 && Math.abs(value) < magnitude * ZERO_EPSILON;
  if (
    Math.abs(value) >= SCIENTIFIC_ABOVE ||
    (!effectivelyZero && Math.abs(value) > 0 && Math.abs(value) < SCIENTIFIC_BELOW)
  ) {
    return scientificTick(value);
  }
  let text = (effectivelyZero ? 0 : value).toFixed(decimals);
  if (text === "-0") text = "0";
  return text;
}

// The minor spacing Woxi uses between two automatic major ticks.
export function minorStep(major) {
  const magnitude = Math.abs(major);
  if (!(magnitude > 0) || !Number.isFinite(magnitude)) return 0;
  const mantissa = magnitude / 10 ** Math.floor(Math.log10(magnitude));
  return major / (Math.abs(mantissa - 2) < 1e-6 ? 4 : 5);
}

// The box is fitted by the projected rectangle its own corners span, so the
// picture inside the card is the box and its labels with no room to spare. The
// scale is fixed for the card and holds at every camera orientation (see
// `projectedEnvelope`), so rotating never crops the box or resizes it.
