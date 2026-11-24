import assert from "node:assert/strict";
import test from "node:test";

import {
  attach,
  detach,
  firstController,
  isScene,
  lastController,
} from "../app/src/main/assets/www/js/plot3d.js";

function scene(overrides = {}) {
  return {
    camera: { az: -1.07, el: 0.63, dist: 6.767569726275452, perspective: true },
    ranges: [
      [-3, 3],
      [-3, 3],
      [-1, 1],
    ],
    coverage: [
      [-3, 3],
      [-3, 3],
      [-1, 1],
    ],
    box: [1, 1, 0.4],
    vertices: "",
    indices: "",
    colors: "",
    lines: "",
    lineColors: "",
    theme: { background: "#ffffff", axis: [102, 102, 102], label: [102, 102, 102] },
    axes: true,
    boxed: true,
    card: { width: null, height: null, full: false },
    ...overrides,
  };
}

function classList() {
  const values = new Set();
  return {
    add(value) {
      values.add(value);
    },
    contains(value) {
      return values.has(value);
    },
  };
}

function root() {
  const canvas = { getContext: () => null };
  const overlay = {};
  const classes = classList();
  return {
    classList: classes,
    getAttribute: () => "0",
    querySelector(selector) {
      return selector === ".woxi-plot3d-gl" ? canvas : overlay;
    },
    querySelectorAll(selector) {
      return selector === ".woxi-plot3d" ? [this] : [];
    },
  };
}

test("a 3D card without WebGL is hidden and is not registered", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const element = root();
    attach(element, [{ plot3d: scene() }]);
    assert.ok(element.classList.contains("woxi-plot3d-unsupported"));
    assert.equal(firstController(), null);
    assert.equal(lastController(), null);
    detach(element);
  } finally {
    console.warn = originalWarn;
  }
});

test("a scene with reversed or zero-width ranges is invalid", () => {
  assert.equal(
    isScene(
      scene({
        ranges: [
          [1, -1],
          [-3, 3],
          [-1, 1],
        ],
      })
    ),
    false
  );
  assert.equal(
    isScene(
      scene({
        ranges: [
          [-3, -3],
          [-3, 3],
          [-1, 1],
        ],
      })
    ),
    false
  );
});
