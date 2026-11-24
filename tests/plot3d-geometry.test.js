import assert from "node:assert/strict";
import test from "node:test";

import { buildGeometry, lineGeometry } from "../app/src/main/assets/www/js/plot3d-geometry.js";

function f32(values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes.toString("base64");
}

function u32(values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return bytes.toString("base64");
}

function u8(values) {
  return Buffer.from(values).toString("base64");
}

function scene(overrides = {}) {
  return {
    ranges: [
      [-2, 2],
      [-2, 2],
      [-2, 2],
    ],
    box: [1, 1, 1],
    vertices: f32([-2, 0, 0, 0, 2, 0, 2, 0, 0]),
    indices: u32([0, 1, 2]),
    colors: u8([255, 0, 0, 255]),
    lines: f32([-2, 0, 0, 2, 0, 0]),
    lineColors: u8([10, 20, 30, 128, 10, 20, 30, 128]),
    ...overrides,
  };
}

test("a triangle is decoded into opaque geometry with unit normals", () => {
  const geometry = buildGeometry(scene());
  assert.equal(geometry.opaque.count, 3);
  assert.equal(geometry.transparent.count, 0);
  for (let i = 0; i < geometry.opaque.normals.length; i += 3) {
    const length = Math.hypot(
      geometry.opaque.normals[i],
      geometry.opaque.normals[i + 1],
      geometry.opaque.normals[i + 2]
    );
    assert.ok(Math.abs(length - 1) < 1e-6);
  }
});

test("transparent triangles get an index order and keep their alpha", () => {
  const geometry = buildGeometry(scene({ colors: u8([255, 0, 0, 128]) }));
  assert.equal(geometry.transparent.count, 3);
  assert.equal(geometry.transparent.positions.length, 9);
  assert.deepEqual(Array.from(geometry.transparent.order), [0, 1, 2]);
  assert.equal(geometry.transparent.colors[3], 128);
});

test("line geometry keeps the scene colour and opacity", () => {
  const lines = lineGeometry(scene());
  assert.equal(lines.count, 2);
  assert.deepEqual(Array.from(lines.colors.slice(0, 4)), [10, 20, 30, 128]);
});

test("line geometry uses per-vertex colours when the engine sends them", () => {
  const lines = lineGeometry(
    scene({
      lineColors: u8([1, 2, 3, 128, 4, 5, 6, 255]),
    })
  );
  assert.deepEqual(Array.from(lines.colors.slice(0, 8)), [1, 2, 3, 128, 4, 5, 6, 255]);
});

test("a zero-area triangle still gets a usable normal", () => {
  const geometry = buildGeometry(
    scene({
      vertices: f32([0, 0, 0, 0, 0, 0, 0, 0, 0]),
    })
  );
  assert.deepEqual(Array.from(geometry.opaque.normals.slice(0, 3)), [0, 0, 1]);
});

test("buildGeometry rejects a colour buffer that does not match the triangles", () => {
  assert.throws(
    () => buildGeometry(scene({ colors: u8([255, 0, 0, 255, 0, 255, 0, 255]) })),
    /colour count/
  );
  assert.throws(() => buildGeometry(scene({ colors: u8([255, 0, 0]) })), /rgba-aligned/);
});

test("buildGeometry rejects an index outside the vertex buffer", () => {
  assert.throws(
    () => buildGeometry(scene({ indices: u32([0, 1, 3]) })),
    /outside the vertex buffer/
  );
});

test("buildGeometry rejects an empty triangle list", () => {
  assert.throws(() => buildGeometry(scene({ indices: u32([]), colors: u8([]) })), /no triangles/);
});

test("buildGeometry rejects a non-finite vertex", () => {
  assert.throws(
    () => buildGeometry(scene({ vertices: f32([0, 0, 0, 0, Number.NaN, 0, 1, 0, 0]) })),
    /non-finite/
  );
});

test("lineGeometry rejects a non-finite line vertex", () => {
  assert.throws(
    () => lineGeometry(scene({ lines: f32([0, 0, 0, Number.POSITIVE_INFINITY, 0, 0]) })),
    /non-finite/
  );
});

test("lineGeometry rejects a mismatched line colour buffer", () => {
  assert.throws(() => lineGeometry(scene({ lineColors: u8([1, 2, 3, 4]) })), /line colour count/);
});
