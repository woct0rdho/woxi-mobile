// Unit tests for the gesture maths (`plot-interact.js`) and the scene mapping
// (`plot-layer.js`): finger pixels become a data range for a pan and a pinch, a range becomes
// screen pixels through the scene, and a view is compared with the samples on hand.
//
// They need neither the engine nor the APK: the modules are imported directly, and the pure
// functions they exercise never touch the DOM or the bridge. A device test can only catch the
// failures here by eye.
//
// Run with `pnpm test` (or `node --test "tests/*.test.js"`).

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  fractionOf,
  LOG_FALLBACK_DECADES,
  needsDensify,
  panViewFrom,
  PINCH_AXIS_DEGREES,
  pinchAnchor,
  pinchMode,
  positiveView,
  REFINE_NEAR,
  refineKind,
  refinePad,
  TWO_AXIS_REFINE_PAD,
  ZOOM_IN,
  zoomAxesViewFrom,
  zoomViewFrom,
} from "../app/src/main/assets/www/js/plot-gesture.js";
import * as layer from "../app/src/main/assets/www/js/plot-layer.js";
import { U16_MAX } from "../app/src/main/assets/www/js/plot-samples.js";

// `refineKind` is the production decision. This keeps the tests reading like the question.
const needsRefine = (view, samples, log, basis) => refineKind(view, samples, log, basis) !== null;

// The scene of a `Plot[Sin[x], {x, -5, 5}]` card: a frame inset in the picture, and a data
// rectangle inside the frame (the renderer's `PlotRangePadding`). The rect's second number is
// the user y of the lowest data value, which is the larger user y: the picture's y axis grows
// downward. The box is the pinned picture box, one CSS pixel per user unit here.
const BOX = { x: 0, y: 0, width: 360, height: 240 };
const SCENE = {
  frame: [20, 20, 320, 200],
  rect: [40, 190, 300, 30],
  bg: "#FFFFFF",
  fs: { c: "#666666", w: 2 },
  lines: [
    { o: "x", v: 0, c: "#666666", w: 2 },
    { o: "y", v: 0, c: "#666666", w: 2 },
  ],
  ticks: [],
  texts: [],
};
const VIEW = { id: 7, x: [-5, 5], y: [-1, 1] };

function span(range) {
  return range[1] - range[0];
}

function close(actual, expected, what) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} vs ${expected}`);
}

test("the mapping puts the view on the scene's data rectangle", () => {
  const mapping = layer.dataMapping(VIEW, SCENE, BOX, 1, null);
  assert.ok(mapping, "mapping");
  close(mapping.a * VIEW.x[0] + mapping.b, 40, "left edge");
  close(mapping.a * VIEW.x[1] + mapping.b, 300, "right edge");
  // The range's lowest y is the bottom of the picture (the larger screen y).
  close(mapping.d * VIEW.y[0] + mapping.f, 190, "bottom edge");
  close(mapping.d * VIEW.y[1] + mapping.f, 30, "top edge");
});

test("a pan translates both bounds and keeps the span (linear axes)", () => {
  const panned = panViewFrom(VIEW, 26, 0, { a: 10, b: 0, d: -10, f: 0 }, null);
  assert.ok(panned, "panned");
  assert.equal(panned.id, VIEW.id);
  assert.equal(panned.x[0], VIEW.x[0] - 2.6);
  assert.equal(panned.x[1], VIEW.x[1] - 2.6);
  assert.deepEqual(panned.y, VIEW.y);
});

test("a pan moves the drawn curve by exactly the finger pixels", () => {
  const mapping = layer.dataMapping(VIEW, SCENE, BOX, 1, null);
  const panned = panViewFrom(VIEW, 13, 9, mapping, null);
  const after = layer.dataMapping(panned, SCENE, BOX, 1, null);
  const middle = [(VIEW.x[0] + VIEW.x[1]) / 2, (VIEW.y[0] + VIEW.y[1]) / 2];
  close(after.a * middle[0] + after.b - (mapping.a * middle[0] + mapping.b), 13, "x moved");
  close(after.d * middle[1] + after.f - (mapping.d * middle[1] + mapping.f), 9, "y moved");
});

test("a tick moves with the curve by the same pixels", () => {
  const tick = { o: "x", v: 2, b: 190, e: 210 };
  const mapping = layer.dataMapping(VIEW, SCENE, BOX, 1, null);
  const panned = panViewFrom(VIEW, -17, 0, mapping, null);
  const moved = layer.dataMapping(panned, SCENE, BOX, 1, null);
  const before = layer.tickPlace(tick, SCENE, layer.sceneMapping(SCENE, VIEW, null), null);
  const after = layer.tickPlace(tick, SCENE, layer.sceneMapping(SCENE, panned, null), null);
  close(moved.a * tick.v + moved.b - (mapping.a * tick.v + mapping.b), -17, "tick moved");
  close(after.base, before.base, "tick height");
});

test("a value line stays at its value across a pan", () => {
  const mapping = layer.dataMapping(VIEW, SCENE, BOX, 1, null);
  const panned = panViewFrom(VIEW, 10, 0, mapping, null);
  const moved = layer.dataMapping(panned, SCENE, BOX, 1, null);
  // The vertical line at x = 0 follows the mapping (the picture moves with the finger).
  const beforeX = mapping.a * 0 + mapping.b;
  const afterX = moved.a * 0 + moved.b;
  close(afterX - beforeX, 10, "axis moved");
  // The horizontal line at y = 0 stays at the same height for a horizontal pan.
  close(mapping.d * 0 + mapping.f, 110, "zero line");
});

test("a zoom scales about the anchor, and the anchor stays under the finger", () => {
  const mapping = { a: 26, b: 170, d: -80, f: 110 };
  const zoomed = zoomViewFrom(VIEW, 2, 0.25, 0.5, null);
  assert.ok(zoomed, "zoomed");
  close(span(zoomed.x), span(VIEW.x) / 2, "x span");
  close(span(zoomed.y), span(VIEW.y) / 2, "y span");
  const anchorX = VIEW.x[0] + 0.25 * span(VIEW.x);
  const before = fractionOf(VIEW, mapping, mapping.a * anchorX + mapping.b, 0, null);
  const after = fractionOf(zoomed, mapping, mapping.a * anchorX + mapping.b, 0, null);
  assert.equal(before.fx, 0.25);
  close(after.fx, 0.25, "anchor");
});

test("a pan after a zoom uses the zoomed view's own scale", () => {
  // The controller reads the mapping for the view in hand. A 2x pinch halves the span, so the
  // pixels-per-unit doubles. A 100 px pan must then move half as far in data units as it would
  // with the pre-zoom mapping. Caching the mapping at the first finger (the old bug) used the
  // stale scale.
  const before = { a: 33, b: 0, d: -96, f: 0 };
  const view = { id: 3, x: [-5, 5], y: [-1, 1] };
  const zoomed = zoomViewFrom(view, 2, 0.5, 0.5, null);
  const after = { a: before.a * 2, b: 0, d: before.d * 2, f: 0 };
  const panned = panViewFrom(zoomed, 100, 0, after, null);
  close(panned.x[0], zoomed.x[0] - 100 / after.a, "shift with the zoomed scale");
  close(span(panned.x), span(zoomed.x), "span kept");
  const stale = panViewFrom(zoomed, 100, 0, before, null);
  close(stale.x[0], zoomed.x[0] - 100 / before.a, "the pre-zoom scale is the old bug");
});

test("a pinch anchor is the finger midpoint in the mapping's own coordinates", () => {
  // The pointers arrive in page pixels. The mapping is relative to the container, which sits
  // 200 px down the page and 40 px in. A page point must land at the container-local one: the
  // anchor used to be read from page pixels, which zoomed about a point above the frame.
  const mapping = { a: 30, b: 10, d: -20, f: 200 };
  const view = { id: 4, x: [0, 10], y: [0, 10] };
  const rect = { left: 40, top: 200 };
  const local = { x: 40 + 190, y: 200 + 120 };
  const page = { x: local.x - 50, y: local.y };
  const away = { x: local.x + 50, y: local.y };
  const at = fractionOf(view, mapping, 190, 120, null);
  const anchor = pinchAnchor(view, mapping, page, away, rect, null);
  assert.ok(Math.abs(anchor.fx - at.fx) < 1e-12, "fx");
  assert.ok(Math.abs(anchor.fy - at.fy) < 1e-12, "fy");
  assert.ok(anchor.fx > 0 && anchor.fx < 1 && anchor.fy > 0 && anchor.fy < 1, "inside the view");
  // Zooming about it keeps the data under the fingers where it was.
  const zoomed = zoomViewFrom(view, 2, anchor.fx, anchor.fy, null);
  const after = pinchAnchor(zoomed, mapping, page, away, rect, null);
  assert.ok(Math.abs(after.fx - anchor.fx) < 1e-9, "fx after");
  assert.ok(Math.abs(after.fy - anchor.fy) < 1e-9, "fy after");
});

test("a pinch anchored outside the frame keeps that anchor, on either axis type", () => {
  const mapping = { a: 10, b: 0, d: -10, f: 0 };
  for (const view of [
    { id: 6, x: [0, 10], y: [0, 10] },
    { id: 7, x: [1, 100], y: [1, 100] },
  ]) {
    const log = view.x[1] === 100 ? { x: true, y: true } : null;
    const fraction = 1.5;
    const zoomed = zoomViewFrom(view, 2, fraction, fraction, log);
    assert.ok(zoomed, "zoomed");
    const axisSpan = (range) =>
      log ? Math.log10(range[1]) - Math.log10(range[0]) : range[1] - range[0];
    close(axisSpan(zoomed.x), axisSpan(view.x) / 2, "span");
    const anchor = log
      ? Math.pow(
          10,
          Math.log10(view.x[0]) + fraction * (Math.log10(view.x[1]) - Math.log10(view.x[0]))
        )
      : view.x[0] + fraction * span(view.x);
    const inMapping = log ? Math.log10(anchor) : anchor;
    close(fractionOf(zoomed, mapping, mapping.a * inMapping, 0, log).fx, fraction, "anchor");
  }
});

test("a logarithmic pan and zoom keep both bounds positive", () => {
  const view = { id: 5, x: [1, 100], y: [1, 100] };
  const panned = panViewFrom(view, -60, 0, { a: 10, b: 0, d: -10, f: 0 }, { x: true, y: true });
  assert.ok(panned, "panned");
  assert.ok(panned.x[0] > 0 && panned.x[1] > panned.x[0], `${panned.x}`);
  close(Math.log10(panned.x[1] / panned.x[0]), 2, "decades kept");
  const zoomed = zoomViewFrom(view, 2, 0.5, 0.5, { x: true, y: true });
  assert.ok(zoomed.x[0] > 0 && zoomed.y[0] > 0);
  close(Math.log10(zoomed.x[1] / zoomed.x[0]), 1, "decades halved");
});

test("a zoom beyond the minimum step keeps zooming, and a bad factor is refused", () => {
  const finest = zoomViewFrom(VIEW, 0.2, 0.5, 0.5, null);
  assert.deepEqual(zoomViewFrom(VIEW, 0.01, 0.5, 0.5, null).x, finest.x);
  assert.equal(zoomViewFrom(VIEW, 0, 0.5, 0.5, null), null);
  assert.equal(zoomViewFrom(VIEW, -1, 0.5, 0.5, null), null);
});

test("the initial finger line selects x, y or uniform zoom", () => {
  const a = { x: 100, y: 100 };
  const at = (degrees, length) => {
    const radians = (degrees * Math.PI) / 180;
    return { x: a.x + length * Math.cos(radians), y: a.y + length * Math.sin(radians) };
  };
  assert.equal(pinchMode(a, at(0, 200)), "x");
  assert.equal(pinchMode(a, at(PINCH_AXIS_DEGREES / 2, 200)), "x");
  assert.equal(pinchMode(a, at(PINCH_AXIS_DEGREES * 2, 200)), "uniform");
  assert.equal(pinchMode(a, at(90, 200)), "y");
  assert.equal(pinchMode(a, at(90 - PINCH_AXIS_DEGREES / 2, 200)), "y");
  assert.equal(pinchMode(a, at(90 - PINCH_AXIS_DEGREES * 2, 200)), "uniform");
  assert.equal(pinchMode(a, at(45, 200)), "uniform");
  assert.equal(pinchMode(a, a), "uniform");
});

test("an axis pinch scales only that axis and keeps its own anchor", () => {
  const mapping = { a: 26, b: 170, d: -80, f: 110 };
  const xOnly = zoomAxesViewFrom(VIEW, 2, 1, 0.25, 0.5, null);
  const yOnly = zoomAxesViewFrom(VIEW, 1, 2, 0.25, 0.5, null);
  assert.ok(xOnly, "x-only");
  assert.ok(yOnly, "y-only");
  close(span(xOnly.x), span(VIEW.x) / 2, "x span");
  close(span(xOnly.y), span(VIEW.y), "y span is left alone");
  close(span(yOnly.x), span(VIEW.x), "x span is left alone");
  close(span(yOnly.y), span(VIEW.y) / 2, "y span");
  const anchorX = VIEW.x[0] + 0.25 * span(VIEW.x);
  const anchorY = VIEW.y[1] - 0.5 * span(VIEW.y);
  const screenX = mapping.a * anchorX + mapping.b;
  const screenY = mapping.d * anchorY + mapping.f;
  close(fractionOf(xOnly, mapping, screenX, screenY, null).fx, 0.25, "x anchor");
  close(fractionOf(yOnly, mapping, screenX, screenY, null).fy, 0.5, "y anchor");
  assert.equal(zoomAxesViewFrom(VIEW, 0, 1, 0.5, 0.5, null), null);
  assert.equal(zoomAxesViewFrom(VIEW, 1, -1, 0.5, 0.5, null), null);
});

test("uniform zoom preserves the aspect at the start of the gesture", () => {
  // An x-axis pinch leaves a different data aspect than the initial plot's. A later uniform
  // pinch must carry that current aspect along, not restore the initial one.
  const squashed = zoomAxesViewFrom(VIEW, 2, 1, 0.5, 0.5, null);
  const uniform = zoomAxesViewFrom(squashed, 2, 2, 0.5, 0.5, null);
  close(span(squashed.x) / span(squashed.y), 2.5, "x-only aspect");
  close(span(uniform.x) / span(uniform.y), span(squashed.x) / span(squashed.y), "uniform aspect");
  close(span(uniform.x), span(VIEW.x) / 4, "x span");
  close(span(uniform.y), span(VIEW.y) / 2, "y span");
});

test("a two-finger move scales about its start midpoint and then pans with it", () => {
  const startMapping = layer.dataMapping(VIEW, SCENE, BOX, 1, null);
  const startX = startMapping.a * 0 + startMapping.b;
  const startY = startMapping.d * 0 + startMapping.f;
  const zoomed = zoomAxesViewFrom(VIEW, 2, 2, 0.5, 0.5, null);
  const moved = panViewFrom(zoomed, 20, 10, layer.dataMapping(zoomed, SCENE, BOX, 1, null), null);
  const after = layer.dataMapping(moved, SCENE, BOX, 1, null);
  close(after.a * 0 + after.b, startX + 20, "midpoint x moved with the fingers");
  close(after.d * 0 + after.f, startY + 10, "midpoint y moved with the fingers");
  close(span(moved.x), span(VIEW.x) / 2, "x span");
  close(span(moved.y), span(VIEW.y) / 2, "y span");
  // The same move with an x-only scale: the other axis only follows the midpoint.
  const xZoomed = zoomAxesViewFrom(VIEW, 2, 1, 0.5, 0.5, null);
  const xMoved = panViewFrom(
    xZoomed,
    20,
    10,
    layer.dataMapping(xZoomed, SCENE, BOX, 1, null),
    null
  );
  close(span(xMoved.x), span(VIEW.x) / 2, "x-only x span");
  close(span(xMoved.y), span(VIEW.y), "x-only y span");
});

test("an axis pinch keeps its scale in the drawing space on a log axis", () => {
  const view = { id: 11, x: [1, 100], y: [1, 100] };
  const log = { x: true, y: true };
  const xOnly = zoomAxesViewFrom(view, 2, 1, 0.5, 0.5, log);
  const yOnly = zoomAxesViewFrom(view, 1, 2, 0.5, 0.5, log);
  close(Math.log10(xOnly.x[1] / xOnly.x[0]), 1, "x decades");
  close(Math.log10(xOnly.y[1] / xOnly.y[0]), 2, "y decades are left alone");
  close(Math.log10(yOnly.x[1] / yOnly.x[0]), 2, "x decades are left alone");
  close(Math.log10(yOnly.y[1] / yOnly.y[0]), 1, "y decades");
  assert.ok(xOnly.x[0] > 0 && yOnly.y[0] > 0);
});

test("a stored log view is repaired only when its high bound can be drawn", () => {
  const log = { x: true, y: false };
  const repaired = positiveView({ id: 8, x: [0, 100], y: [-1, 1] }, log);
  close(repaired.x[0], 100 / Math.pow(10, LOG_FALLBACK_DECADES), "low bound");
  assert.equal(repaired.x[1], 100);
  const undrawable = { id: 9, x: [-10, -1], y: [-1, 1] };
  assert.deepEqual(positiveView(undrawable, log), undrawable);
});

test("a view that has run out of samples asks for a re-sample", () => {
  const samples = { s: true, dn: false, d: [-10, 10] };
  assert.equal(needsRefine({ x: [-5, 5] }, samples, null), false);
  assert.equal(needsRefine({ x: [8, 18] }, samples, null), true);
  assert.equal(needsRefine({ x: [11, 21] }, samples, null), true);
  // A zoom-in asks for a denser sample only relative to the span at the last re-sample. A large
  // coverage pad is not itself a zoom-in.
  assert.equal(needsRefine({ x: [-1, 1] }, samples, null, { x: 10, y: 2 }), true);
  assert.equal(needsRefine({ x: [-1, 1] }, samples, null, { x: 2, y: 2 }), false);
  assert.equal(
    needsRefine({ x: [-0.5, 0.5] }, { s: true, d: [-3.5, 3.5] }, null, { x: 1, y: 1 }),
    false,
    "a large pad is not a zoom-in"
  );
  // A plot the canvas refuses is never asked for samples.
  assert.equal(needsRefine({ x: [11, 21] }, { s: false, d: [-10, 10] }, null), false);
  // A log axis is judged in decades: a margin that looks wide in data units can be tiny.
  assert.equal(needsRefine({ x: [11.96, 131.7] }, { s: true, d: [3.6, 437] }, { x: true }), false);
  assert.equal(needsRefine({ x: [11.96, 131.7] }, { s: true, d: [3.6, 437] }, null), true);
});

test("the refine kind separates coverage from resolution, and the pad follows it", () => {
  const samples = { s: true, d: [-10, 10] };
  assert.equal(refineKind({ x: [8, 18] }, samples, null, { x: 10, y: 2 }), "coverage");
  assert.equal(refineKind({ x: [-1, 1] }, samples, null, { x: 10, y: 2 }), "resolution");
  assert.equal(refineKind({ x: [-5, 5] }, samples, null, { x: 10, y: 2 }), null);
  // The first coverage re-sample gets the large first-interaction margin. Later ones have a
  // floor, grow with the finger's speed and the round trip, and stop at the shared cap.
  close(refinePad("coverage", false, 0, 100), 2.5, "first");
  close(refinePad("coverage", true, 0, 100), 1, "floor");
  assert.ok(refinePad("coverage", true, 10, 200) > 1, "a faster finger gets more margin");
  close(refinePad("coverage", true, 10, 200), 4, "the cap");
  close(
    refinePad("coverage", true, 10, 200, true),
    TWO_AXIS_REFINE_PAD,
    "a two-axis margin is capped like the engine"
  );
  close(refinePad("resolution", true, 10, 200), 0.5, "a resolution re-sample stays tight");
});

test("a fixed-domain plot is densified, and that needs the coverage", () => {
  const domain = { s: false, dn: true, d: [-1, 1] };
  assert.equal(needsDensify({ x: [-0.1, 0.1] }, domain, 0), true);
  assert.equal(needsDensify({ x: [-0.1, 0.1] }, domain, 3), false);
  assert.equal(needsDensify({ x: [-0.1, 0.1] }, { s: false, dn: false, d: [-1, 1] }, 0), false);
});

test("the protocol constants agree with the shared fixture", () => {
  const values = JSON.parse(
    fs.readFileSync(new URL("./fixtures/protocol.json", import.meta.url), "utf8")
  );
  assert.equal(LOG_FALLBACK_DECADES, values.log_fallback_decades);
  assert.equal(U16_MAX, values.u16_max);
  assert.equal(REFINE_NEAR, values.refine_near);
  assert.equal(ZOOM_IN, values.zoom_in);
  assert.equal(TWO_AXIS_REFINE_PAD, values.two_axis_max_refine_pad);
});
