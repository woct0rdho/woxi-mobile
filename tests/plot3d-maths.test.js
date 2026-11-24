import assert from "node:assert/strict";
import test from "node:test";

import {
  cameraBasis,
  cameraGrid,
  dataToBox,
  depthRange,
  envelopeAspect,
  fitScale,
  fitView,
  formatTick,
  minorStep,
  niceStep,
  projectedEnvelope,
  projectedExtent,
  projectPoint,
  tickValues,
  transformView,
  valuesForStep,
  viewportPlanePoint,
  zoomCeiling,
  zoomFloor,
} from "../app/src/main/assets/www/js/plot3d-maths.js";

const camera = { az: -1.07, el: 0.63, dist: 6.767569726275452, perspective: true };

test("the default camera basis is orthonormal and looks toward the viewer", () => {
  const basis = cameraBasis(-1.07, 0.63);
  assert.ok(Math.abs(Math.hypot(...basis.right) - 1) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...basis.up) - 1) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...basis.toward) - 1) < 1e-12);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  assert.ok(Math.abs(dot(basis.right, basis.up)) < 1e-12);
  assert.ok(Math.abs(dot(basis.right, basis.toward)) < 1e-12);
  assert.ok(Math.abs(dot(basis.up, basis.toward)) < 1e-12);
});

test("a point at the camera centre projects to zero, and depth is positive toward the viewer", () => {
  const camera = { az: -1.07, el: 0.63, dist: 6.767569726275452, perspective: true };
  const origin = projectPoint([0, 0, 0], camera, 1, 1);
  assert.equal(origin.x, 0);
  assert.equal(origin.y, 0);
  const toward = cameraBasis(camera.az, camera.el).toward;
  const front = projectPoint(toward, camera, 1, 1);
  assert.ok(front.depth > 0);
});

test("a point at the camera plane falls back to orthographic projection", () => {
  const camera = { az: -1.07, el: 0.63, dist: 6.767569726275452, perspective: true };
  const basis = cameraBasis(camera.az, camera.el);
  const point = [
    basis.toward[0] * camera.dist + basis.right[0],
    basis.toward[1] * camera.dist + basis.right[1],
    basis.toward[2] * camera.dist + basis.right[2],
  ];
  const projected = projectPoint(point, camera, 1, 1);
  assert.ok(Math.abs(projected.x - 1) < 1e-9);
  assert.ok(Number.isFinite(projected.y));
});

test("an orthographic camera keeps every point's projected size", () => {
  const camera = { az: -1.07, el: 0.63, dist: 6.767569726275452, perspective: false };
  const basis = cameraBasis(camera.az, camera.el);
  const near = [
    basis.right[0] + basis.toward[0],
    basis.right[1] + basis.toward[1],
    basis.right[2] + basis.toward[2],
  ];
  const far = [
    basis.right[0] - basis.toward[0],
    basis.right[1] - basis.toward[1],
    basis.right[2] - basis.toward[2],
  ];
  assert.ok(Math.abs(projectPoint(near, camera, 1, 1).x - 1) < 1e-12);
  assert.ok(Math.abs(projectPoint(far, camera, 1, 1).x - 1) < 1e-12);
});

test("the top view uses Woxi's level camera basis at the pole", () => {
  const top = cameraBasis(0, Math.PI / 2);
  assert.deepEqual(top, { right: [1, 0, 0], up: [0, 1, 0], toward: [0, 0, 1] });
  const bottom = cameraBasis(1.2, -Math.PI / 2);
  assert.deepEqual(bottom, { right: [1, 0, 0], up: [0, -1, 0], toward: [0, 0, -1] });
});

test("the depth window contains the box bounding sphere", () => {
  const box = [1, 1, 0.4];
  const distance = 2 * Math.hypot(1, 1, 0.4) * Math.hypot(1.3, -2.4, 2);
  const [near, far] = depthRange(distance, box);
  const radius = Math.hypot(...box);
  assert.ok(near < distance - radius);
  assert.ok(far > distance + radius);
});

test("a tiny box keeps the near plane below the far plane", () => {
  const box = [1e-6, 1e-6, 1e-6];
  const distance = 2 * Math.hypot(...box) * Math.hypot(1.3, -2.4, 2);
  const [near, far] = depthRange(distance, box);
  assert.ok(Number.isFinite(near));
  assert.ok(Number.isFinite(far));
  assert.ok(near > 0);
  assert.ok(near < far);
});

test("tick values follow the 1/2/5 progression", () => {
  assert.deepEqual(tickValues(0, 10), [0, 2.5, 5, 7.5, 10]);
  assert.deepEqual(tickValues(0, 1), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(niceStep(10), 2.5);
  assert.deepEqual(valuesForStep(0, 1, 0.25), [0, 0.25, 0.5, 0.75, 1]);
});

test("minor ticks use Woxi's four or five divisions", () => {
  assert.equal(minorStep(2), 0.5);
  assert.equal(minorStep(2.5), 0.5);
  assert.equal(minorStep(5), 1);
});

test("tick labels use Woxi's step decimals and scientific notation", () => {
  assert.equal(formatTick(1.5, 0.5), "1.5");
  assert.equal(formatTick(2, 0.5), "2.0");
  assert.equal(formatTick(7.5, 2.5), "7.5");
  assert.equal(formatTick(0.25, 0.25), "0.25");
  assert.equal(formatTick(-0.0001, 0.001), "-0.000");
  assert.equal(formatTick(1e6, 1e5), "1×10⁶");
  assert.equal(formatTick(2e-6, 1e-6), "2×10⁻⁶");
  assert.equal(formatTick(0, 0.5), "0.0");
  assert.equal(formatTick(0, 1e-6), "0");
});

test("the fit scales with the box, so a scaled BoxRatios looks the same", () => {
  const card = { width: 347, height: 260 };
  const base = projectedEnvelope([1, 1, 0.4], camera);
  const small = projectedEnvelope([0.5, 0.5, 0.2], { ...camera, dist: camera.dist / 2 });
  const large = projectedEnvelope([10, 10, 4], { ...camera, dist: camera.dist * 10 });
  const at = (envelope) => fitScale(envelope.x, envelope.y, card.width, card.height);
  assert.ok(Math.abs(at(small) - at(base) / 2) < 1e-9);
  assert.ok(Math.abs(at(large) - at(base) * 10) < 1e-6);
});

test("the envelope holds the box inside the card at every orientation, and is tight", () => {
  const box = [1, 1, 0.4];
  const envelope = projectedEnvelope(box, camera);
  const card = { width: 347, height: 260 };
  const scaleX = fitScale(envelope.x, envelope.y, card.width, card.height);
  const scaleY = (scaleX * card.height) / card.width;
  let finer = { x: 0, y: 0 };
  // A grid that shares no sample with the envelope's own: nothing may exceed it, and
  // a finer sampling must not find the envelope much too large either.
  for (const view of cameraGrid({ ...camera, az: 0.037 }, 60, 31)) {
    const extent = projectedExtent(box, view);
    assert.ok(extent.x <= envelope.x + 1e-9, `x ${extent.x} > ${envelope.x}`);
    assert.ok(extent.y <= envelope.y + 1e-9, `y ${extent.y} > ${envelope.y}`);
    const halfWidth = (extent.x / scaleX) * 0.5 * card.width;
    const halfHeight = (extent.y / scaleY) * 0.5 * card.height;
    assert.ok(halfWidth <= card.width / 2 + 1e-9);
    assert.ok(halfHeight <= card.height / 2 + 1e-9);
    finer = { x: Math.max(finer.x, extent.x), y: Math.max(finer.y, extent.y) };
  }
  assert.ok(finer.x > envelope.x * 0.99, `${finer.x} vs ${envelope.x}`);
  assert.ok(finer.y > envelope.y * 0.99, `${finer.y} vs ${envelope.y}`);
});

test("the card is as wide as the box's rotation envelope", () => {
  const envelope = projectedEnvelope([1, 1, 0.4], camera);
  assert.ok(Math.abs(envelopeAspect(envelope) - envelope.x / envelope.y) < 1e-12);
  // A box too tall for a wide card is capped, as Woxi caps a 3D picture's height.
  assert.ok(Math.abs(envelopeAspect({ x: 0.2, y: 2 }) - 1 / 1.2) < 1e-12);
});

test("the fit uses one side's room on both, because the box stays centred", () => {
  const pads = { left: 20, right: 2, top: 1, bottom: 16 };
  const [halfX, halfY] = [1.479, 1.287];
  const card = { width: 347, height: 260 };
  const scaleX = fitScale(halfX, halfY, card.width, card.height, pads);
  const scaleY = (scaleX * card.height) / card.width;
  const halfWidth = (halfX / scaleX) * 0.5 * card.width;
  const halfHeight = (halfY / scaleY) * 0.5 * card.height;
  const roomX = card.width / 2 - Math.max(pads.left, pads.right);
  const roomY = card.height / 2 - Math.max(pads.top, pads.bottom);
  // One direction binds exactly. The other has room to spare (or binds too).
  assert.ok(Math.abs(Math.min(roomX - halfWidth, roomY - halfHeight)) < 1e-9);
  assert.ok(halfWidth <= roomX + 1e-9);
  assert.ok(halfHeight <= roomY + 1e-9);
});

test("a viewport-parallel plane point is a right/up displacement", () => {
  const basis = cameraBasis(-1.07, 0.63);
  const size = { width: 400, height: 300 };
  const scaleX = 2;
  const scaleY = 1.5;
  const center = viewportPlanePoint(200, 150, size.width, size.height, basis, scaleX, scaleY);
  assert.ok(Math.hypot(...center) < 1e-12);
  const right = viewportPlanePoint(300, 150, size.width, size.height, basis, scaleX, scaleY);
  assert.ok(right[0] * basis.right[0] + right[1] * basis.right[1] + right[2] * basis.right[2] > 0);
  assert.ok(
    Math.abs(right[0] * basis.up[0] + right[1] * basis.up[1] + right[2] * basis.up[2]) < 1e-12
  );
  const camera = { az: -1.07, el: 0.63, dist: 6.767569726275452, perspective: true, basis };
  const projected = projectPoint(center, camera, scaleX, scaleY);
  assert.ok(Math.abs((projected.x * 0.5 + 0.5) * size.width - 200) < 1e-12);
  assert.ok(Math.abs((1 - (projected.y * 0.5 + 0.5)) * size.height - 150) < 1e-12);
});

test("a data point maps to the fixed box with the current view", () => {
  const view = [
    [0, 10],
    [-2, 2],
    [0, 1],
  ];
  assert.deepEqual(dataToBox([0, -2, 0], view, [1, 0.5, 0.4]), [-1, -0.5, -0.4]);
  assert.deepEqual(dataToBox([10, 2, 1], view, [1, 0.5, 0.4]), [1, 0.5, 0.4]);
  assert.deepEqual(dataToBox([5, 0, 0.5], view, [1, 0.5, 0.4]), [0, 0, 0]);
  assert.deepEqual(
    dataToBox(
      [5, 0, 0.5],
      [
        [0, 0],
        [-2, 2],
        [0, 1],
      ],
      [1, 0.5, 0.4]
    ),
    [0, 0, 0]
  );
});

test("a screen translation shifts every box point by exactly that vector", () => {
  const view = [
    [-2, 2],
    [-2, 2],
    [-2, 2],
  ];
  const box = [1, 0.4, 0.8];
  const translate = [0.4, -0.2, 0.1];
  const next = transformView(view, box, 1, translate);
  const before = dataToBox([0, 0, 0], view, box);
  const after = dataToBox([0, 0, 0], next, box);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(after[axis] - before[axis] - translate[axis]) < 1e-12);
  }
});

test("a uniform range zoom scales the box about the requested plane point", () => {
  const view = [
    [-2, 2],
    [-2, 2],
    [-2, 2],
  ];
  const box = [1, 1, 1];
  const next = transformView(view, box, 2, [0, 0, 0]);
  assert.deepEqual(next, [
    [-1, 1],
    [-1, 1],
    [-1, 1],
  ]);
  assert.deepEqual(dataToBox([1, 0, 0], next, box), [1, 0, 0]);
  const anchored = transformView(view, box, 2, [0.5, 0, 0]);
  assert.deepEqual(dataToBox([-1, 0, 0], anchored, box), [-0.5, 0, 0]);
});

test("a range view is clamped to its gesture bounds", () => {
  const coverage = [
    [-1, 1],
    [-1, 1],
    [-1, 1],
  ];
  assert.deepEqual(
    fitView(
      [
        [-2, 2],
        [0, 1],
        [-1, 1],
      ],
      coverage
    ),
    [
      [-1, 1],
      [0, 1],
      [-1, 1],
    ]
  );
  assert.deepEqual(
    fitView(
      [
        [-0.5, 0.5],
        [0.5, 1.5],
        [-1, 1],
      ],
      coverage
    ),
    [
      [-0.5, 0.5],
      [0, 1],
      [-1, 1],
    ]
  );
});

test("zoom limits follow the view and span bounds", () => {
  const bounds = [
    [-3, 3],
    [-3, 3],
    [-3, 3],
  ];
  assert.equal(
    zoomFloor(
      [
        [-3, 3],
        [-3, 3],
        [-3, 3],
      ],
      bounds
    ),
    1
  );
  assert.equal(
    zoomFloor(
      [
        [-1, 1],
        [-1, 1],
        [-1, 1],
      ],
      bounds
    ),
    1 / 3
  );

  const initial = [
    [-3, 3],
    [-3, 3],
    [-3, 3],
  ];
  const minima = initial.map(([low, high]) => (high - low) * 0.05);
  assert.ok(Math.abs(zoomCeiling(initial, minima) - 20) < 1e-12);
  assert.ok(
    Math.abs(
      zoomCeiling(
        [
          [-0.3, 0.3],
          [-3, 3],
          [-3, 3],
        ],
        minima
      ) - 2
    ) < 1e-12
  );
  assert.equal(
    zoomCeiling(
      [
        [-0.15, 0.15],
        [-3, 3],
        [-3, 3],
      ],
      minima
    ),
    1
  );
  assert.equal(
    zoomCeiling(
      [
        [-0.05, 0.05],
        [-3, 3],
        [-3, 3],
      ],
      minima
    ),
    1
  );
  assert.equal(
    zoomCeiling(
      [
        [-3, 3],
        [-3, 3],
        [-3, 3],
      ],
      [0, 0, 0]
    ),
    1
  );
});
