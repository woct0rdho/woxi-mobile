import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAxes,
  drawAxesOverlay,
  labelPads,
} from "../app/src/main/assets/www/js/plot3d-axes.js";
import {
  boxCorners,
  cameraGrid,
  fitScale,
  projectedEnvelope,
  projectedExtent,
  projectPoint,
} from "../app/src/main/assets/www/js/plot3d-maths.js";

const camera = { az: -1.07, el: 0.63, dist: 6.767569726275452, perspective: true };
const theme = { axis: [118, 118, 118], label: [220, 220, 220] };
const view = [
  [-3, 3],
  [-2, 2],
  [-1, 1],
];

test("the box corners are the normalized ratios", () => {
  const corners = boxCorners([1, 2, 0.4]);
  assert.deepEqual(corners[0], [-1, -2, -0.4]);
  assert.deepEqual(corners[7], [1, 2, 0.4]);
});

test("the axes choose three edges, carry ticks and stay inside the box", () => {
  const axes = buildAxes({ box: [1, 1, 0.4], axes: true, boxed: true }, view, camera, theme);
  assert.equal(axes.positions.length, 12 * 6);
  assert.equal(axes.axisPositions.length, 3 * 6);
  assert.equal(axes.axes.length, 3);
  assert.deepEqual(axes.axisColor, [118, 118, 118]);
  assert.deepEqual(axes.labelColor, [220, 220, 220]);
  for (const axis of axes.axes) {
    assert.ok(axis.ticks.length > 0);
    assert.ok(axis.ticks.some((tick) => tick.major && tick.text));
    for (const tick of axis.ticks) {
      for (let component = 0; component < 3; component += 1) {
        assert.ok(Math.abs(tick.at[component]) <= [1, 1, 0.4][component] + 1e-12);
      }
    }
  }
});

test("an orthographic camera keeps the box and tick axes", () => {
  const axes = buildAxes(
    { box: [1, 1, 0.4], axes: true, boxed: true },
    view,
    { ...camera, perspective: false },
    theme
  );
  assert.equal(axes.positions.length, 12 * 6);
  assert.equal(axes.axisPositions.length, 3 * 6);
  assert.equal(axes.axes.length, 3);
});

test("the pole view keeps its axis edges horizontal and vertical", () => {
  const axes = buildAxes(
    { box: [1, 1, 0.4], axes: true, boxed: true },
    view,
    { az: 0, el: Math.PI / 2, dist: camera.dist, perspective: false },
    theme
  );
  assert.equal(axes.positions.length, 12 * 6);
  assert.equal(axes.axes.length, 3);
  const x = axes.axes[0];
  const y = axes.axes[1];
  assert.ok(Math.abs(x.end[0] - x.origin[0]) > 0);
  assert.ok(Math.abs(x.end[1] - x.origin[1]) < 1e-12);
  assert.ok(Math.abs(y.end[1] - y.origin[1]) > 0);
  assert.ok(Math.abs(y.end[0] - y.origin[0]) < 1e-12);
});

test("the axes follow a rotated camera and omit labels when Axes is false", () => {
  const before = buildAxes({ box: [1, 1, 1], axes: true, boxed: true }, view, camera, theme);
  const rotated = buildAxes(
    { box: [1, 1, 1], axes: true, boxed: true },
    view,
    {
      ...camera,
      az: camera.az + Math.PI,
    },
    theme
  );
  assert.notDeepEqual(before.axes[2].origin, rotated.axes[2].origin);
  const hidden = buildAxes({ box: [1, 1, 1], axes: false, boxed: true }, view, camera, theme);
  assert.equal(hidden.axes.length, 0);
  assert.equal(hidden.positions.length, 12 * 6);
  assert.equal(hidden.axisPositions.length, 0);
});

test("an unboxed scene draws its three axis lines without a box", () => {
  const axes = buildAxes({ box: [1, 1, 0.4], axes: true, boxed: false }, view, camera, theme);
  assert.equal(axes.positions.length, 0);
  assert.equal(axes.axisPositions.length, 3 * 6);
  assert.equal(axes.axes.length, 3);
  const rotated = buildAxes(
    { box: [1, 1, 0.4], axes: true, boxed: false },
    view,
    {
      ...camera,
      az: camera.az + Math.PI,
    },
    theme
  );
  assert.notDeepEqual(axes.axisPositions, rotated.axisPositions);
  const hidden = buildAxes({ box: [1, 1, 0.4], axes: false, boxed: false }, view, camera, theme);
  assert.equal(hidden.positions.length, 0);
  assert.equal(hidden.axisPositions.length, 0);
});

test("the overlay paints major labels and both major and minor marks", () => {
  const axes = buildAxes({ box: [1, 1, 0.4], axes: true, boxed: true }, view, camera, theme);
  const calls = { text: 0, lines: 0 };
  let textFont = "";
  const segments = [];
  let last = null;
  const ctx = {
    font: "",
    textBaseline: "",
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    textAlign: "",
    beginPath() {},
    moveTo(x, y) {
      last = [x, y];
    },
    lineTo(x, y) {
      if (last) segments.push([last, [x, y]]);
    },
    stroke() {
      calls.lines += 1;
    },
    measureText(text) {
      return { width: text.length * 5.5 };
    },
    fillText() {
      calls.text += 1;
      textFont = this.font;
    },
  };
  drawAxesOverlay(ctx, axes, camera, 1, 0.75, 400, 300);
  assert.ok(calls.lines > 0);
  assert.ok(calls.text > 0);
  assert.match(textFont, /^10px /);
  assert.equal(ctx.lineWidth, 0.5);
  const major = axes.axes.flatMap((axis) => axis.ticks.filter((tick) => tick.major));
  assert.ok(calls.text <= major.length);

  const axis = axes.axes[0];
  const tick = axis.ticks[0];
  const toPx = (point) => {
    const p = projectPoint(point, camera, 1, 0.75);
    return { x: (p.x * 0.5 + 0.5) * 400, y: (1 - (p.y * 0.5 + 0.5)) * 300 };
  };
  const a = toPx(axis.origin);
  const b = toPx(axis.end);
  const p = toPx(tick.at);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const mark = tick.major ? 4 : 2.5;
  const expected = [p.x - (dy / length) * mark, p.y + (dx / length) * mark];
  assert.ok(Math.abs(segments[0][0][0] - p.x) < 1e-9);
  assert.ok(Math.abs(segments[0][0][1] - p.y) < 1e-9);
  assert.ok(Math.abs(segments[0][1][0] - expected[0]) < 1e-9);
  assert.ok(Math.abs(segments[0][1][1] - expected[1]) < 1e-9);
});

test("no two labels overlap, on one axis or across the shared corner", () => {
  // A narrow range on x and y packs the end labels of both axes onto one corner.
  const axes = buildAxes(
    { box: [1, 1, 0.4], axes: true, boxed: true },
    [
      [-1, 1],
      [-2, 2],
      [-0.5, 0.5],
    ],
    camera,
    theme
  );
  const labels = [];
  const ctx = {
    font: "",
    textBaseline: "",
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    textAlign: "",
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    measureText(text) {
      return { width: text.length * 5.5 };
    },
    fillText(text, x, y) {
      const width = text.length * 5.5;
      const left =
        this.textAlign === "end" ? x - width : this.textAlign === "start" ? x : x - width / 2;
      labels.push({ left, right: left + width, top: y - 5, bottom: y + 5, text });
    },
  };
  drawAxesOverlay(ctx, axes, camera, 1, 0.75, 400, 300);
  assert.ok(labels.length >= 3, `${labels.length} labels`);
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i];
      const b = labels[j];
      const overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      assert.ok(!overlap, `"${a.text}" overlaps "${b.text}"`);
    }
  }
  // Every axis keeps at least one label, or the axis would read as unticked.
  for (const axis of axes.axes) {
    assert.ok(
      axis.ticks.some((tick) => tick.text),
      "axis has labeled ticks"
    );
  }
});

test("an axis seen end-on keeps one label, not a pile", () => {
  // Looking almost straight down the x axis (azimuth 0) foreshortens the x edge
  // to a few pixels, so all of its ticks land on nearly the same spot.
  const endOn = { az: 0, el: 0.02, dist: 6.767569726275452, perspective: true };
  const axes = buildAxes({ box: [1, 1, 0.4], axes: true, boxed: true }, view, endOn, theme);
  const xAxis = axes.axes[0];
  const edge = (point) => {
    const p = projectPoint(point, endOn, 1, 0.75);
    return { x: (p.x * 0.5 + 0.5) * 400, y: (1 - (p.y * 0.5 + 0.5)) * 300 };
  };
  const a = edge(xAxis.origin);
  const b = edge(xAxis.end);
  const projectedLength = Math.hypot(b.x - a.x, b.y - a.y);
  // Shorter than two label heights, so its labels cannot all sit apart on it.
  assert.ok(projectedLength < 80, `x edge is foreshortened (${projectedLength.toFixed(1)} px)`);
  const labeled = xAxis.ticks.filter((tick) => tick.text);
  assert.ok(labeled.length >= 3, "the ticks themselves are all there");
  const drawn = [];
  const ctx = {
    font: "",
    textBaseline: "",
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    textAlign: "",
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    measureText(text) {
      return { width: text.length * 5.5 };
    },
    fillText(text, x, y) {
      drawn.push({ text, x, y });
    },
  };
  drawAxesOverlay(ctx, axes, endOn, 1, 0.75, 400, 300);
  // The x labels are those anchored a label offset from an x tick: the same y as the
  // tick, give or take the offset, and within a few pixels of the edge's x extent.
  const xTicks = labeled.map((tick) => edge(tick.at));
  const xLabels = drawn.filter((label) =>
    xTicks.some((at) => Math.abs(label.x - at.x) < 8 && Math.abs(label.y - at.y) < 20)
  );
  assert.ok(xLabels.length >= 1, "the foreshortened axis keeps a label");
  assert.ok(
    xLabels.length <= 3,
    `${xLabels.length} labels on a ${projectedLength.toFixed(1)} px edge`
  );
  // Whatever else is thinned, the range's two end labels stay.
  const texts = xLabels.map((label) => label.text);
  assert.ok(texts.includes(labeled[0].text), `first label ${labeled[0].text} kept`);
  assert.ok(texts.includes(labeled[labeled.length - 1].text), "last label kept");
  // Labels that stay are at least a label height and a half apart along the edge.
  for (let i = 1; i < xLabels.length; i += 1) {
    const gap = Math.hypot(xLabels[i].x - xLabels[i - 1].x, xLabels[i].y - xLabels[i - 1].y);
    assert.ok(gap >= 15, `labels ${gap.toFixed(1)} px apart`);
  }
});

// A 2D context that records what the overlay paints and estimates text widths the
// same way the other tests do.
function recordingCtx(onText) {
  return {
    font: "",
    textBaseline: "",
    lineWidth: 0,
    strokeStyle: "",
    fillStyle: "",
    textAlign: "",
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    measureText(text) {
      return { width: text.length * 5.5 };
    },
    fillText(text, x, y) {
      const width = text.length * 5.5;
      const left =
        this.textAlign === "end" ? x - width : this.textAlign === "start" ? x : x - width / 2;
      if (onText) onText({ text, left, right: left + width, top: y - 5, bottom: y + 5 });
    },
  };
}

test("the label pads keep every label inside the card at every orientation", () => {
  const scene = { box: [1, 1, 0.4], boxed: true, axes: true, theme };
  const context = recordingCtx();
  for (const [width, height] of [
    [347, 347],
    [347, 260],
    [300, 360],
  ]) {
    const envelope = projectedEnvelope(scene.box, camera);
    const scaleX = fitScale(envelope.x, envelope.y, width, height);
    const pads = labelPads(
      scene,
      view,
      camera,
      scaleX,
      scaleX * (height / width),
      width,
      height,
      context
    );
    // The pads have to be positive: the test would pass vacuously if they were not.
    assert.ok(pads.left + pads.right + pads.top + pads.bottom > 0);
    const fitted = fitScale(envelope.x, envelope.y, width, height, pads);
    const fittedY = fitted * (height / width);
    // A finer grid than the pads were measured on: no label may touch the card edge.
    let labels = 0;
    for (const turned of cameraGrid(camera, 16, 9)) {
      const extent = projectedExtent(scene.box, turned);
      const halfX = (extent.x / fitted) * 0.5 * width;
      const halfY = (extent.y / fittedY) * 0.5 * height;
      const axes = buildAxes(scene, view, turned, theme);
      const ctx = recordingCtx((label) => {
        labels += 1;
        assert.ok(
          label.left >= -1e-6,
          `${width}x${height}: label ${label.text} left ${label.left}`
        );
        assert.ok(
          label.right <= width + 1e-6,
          `${width}x${height}: ${label.text} right ${label.right}`
        );
        assert.ok(label.top >= -1e-6, `${width}x${height}: ${label.text} top ${label.top}`);
        assert.ok(
          label.bottom <= height + 1e-6,
          `${width}x${height}: ${label.text} bottom ${label.bottom}`
        );
      });
      // The box has to stay inside its own card too.
      assert.ok(halfX <= width / 2 + 1e-6);
      assert.ok(halfY <= height / 2 + 1e-6);
      drawAxesOverlay(ctx, axes, turned, fitted, fittedY, width, height);
    }
    assert.ok(labels > 0, "some labels were drawn");
  }
});
