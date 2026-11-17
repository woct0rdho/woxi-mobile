// Property tests for the transforms: instead of a hand-picked case per rule, a seeded generator
// walks many views and scenes and asserts the invariants the subsystem is held to (see
// `docs/plot_interaction.md`). A sign that flips or an anchor that drifts shows up here without a
// device, an engine or an APK.

import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  DENSIFY_MAX_LEVEL,
  fractionOf,
  LOG_FALLBACK_DECADES,
  MAX_REFINE_PAD,
  panViewFrom,
  positiveView,
  REFINE_NEAR,
  refineKind,
  ZOOM_IN,
  zoomViewFrom,
} from "../app/src/main/assets/www/js/plot-gesture.js";
import {
  axisPosition,
  boxOf as sceneBoxOf,
  dataMapping,
  fillBaseline,
  layoutOf,
  normalize,
  paint,
  sceneMapping,
  tickPlace,
} from "../app/src/main/assets/www/js/plot-layer.js";
import { setFallbackMeasure } from "../app/src/main/assets/www/js/plot-metrics.js";
import { U16_MAX } from "../app/src/main/assets/www/js/plot-samples.js";
import { plotSummary } from "../app/src/main/assets/www/js/render-output.js";
import { estimateWidth } from "./plot-metrics-fallback.js";

// Paint's label boxes need a measure without a DOM: the app's canvas is absent here.
setFallbackMeasure(estimateWidth);

// `refineKind` is the production decision. This keeps the tests reading like the question.
const needsRefine = (view, samples, log, basis) => refineKind(view, samples, log, basis) !== null;

const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/protocol.json", import.meta.url), "utf8")
);

// One whole scene, written by the engine's own extraction (`plot/scene/` regenerates it): the
// field names below are the contract between the two languages, so a rename on either side must
// fail a test instead of silently drawing blank axes.
const ENGINE_SCENE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/scene.json", import.meta.url), "utf8")
);

// A deterministic generator, so a failing case can be replayed from its index.
function sequence(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const CASES = 200;

// A picture whose frame sits inside its box, with the data inset from the frame the way Woxi's
// field layout does it. `rect[1]` is the user y of the lowest data value (the larger user y).
function sceneOf(next) {
  const frame = [20 + 40 * next(), 20 + 40 * next(), 0, 0];
  frame[2] = 260 + 80 * next();
  frame[3] = 160 + 60 * next();
  const inset = 4 + 10 * next();
  return {
    box: [0, 0, frame[2] + 2 * frame[0], frame[3] + 2 * frame[1]],
    frame,
    rect: [
      frame[0] + inset,
      frame[1] + frame[3] - inset,
      frame[0] + frame[2] - inset,
      frame[1] + inset,
    ],
    bg: "#FFFFFF",
    fs: { c: "#666666", w: 2 },
    lines: [{ o: "x", v: 0, c: "#666666", w: 2, k: "g" }],
    ticks: [],
    texts: [],
  };
}

function boxOf(scene) {
  return {
    x: 0,
    y: 0,
    width: scene.frame[2] + 2 * scene.frame[0],
    height: scene.frame[3] + 2 * scene.frame[1],
  };
}

test("a saved view keeps the range and the sample capability flags", () => {
  // The attribute is what a rebuild reads back. The samples and the scene are session state and
  // are deliberately absent.
  const saved = plotSummary({ id: 4, x: [-1, 1], y: [-1, 1], s: true, dn: false, a: 0.5 });
  assert.deepEqual(saved, { id: 4, x: [-1, 1], y: [-1, 1], s: true, dn: false });
  assert.deepEqual(plotSummary({ id: 4, x: [-1, 1], y: [-1, 1], s: false, dn: true }), {
    id: 4,
    x: [-1, 1],
    y: [-1, 1],
    s: false,
    dn: true,
  });
  // Repairing a stored log range keeps the capability flags that came with it.
  const repaired = positiveView(
    { id: 4, x: [0, 100], y: [-1, 1], s: true, dn: false },
    { x: true }
  );
  assert.equal(repaired.s, true);
  assert.equal(repaired.dn, false);
});

test("an axes plot keeps its frame whole and puts its labels in rails", () => {
  const scene = {
    box: [0, 0, 3600, 2240],
    frame: [5, 5, 3580, 2213],
    rect: [5, 2218, 3585, 5],
    bg: "#FFFFFF",
    fs: null,
    lines: [
      { o: "y", v: 0, c: "#666666", w: 2, k: "a" },
      { o: "x", v: 0, c: "#666666", w: 2, k: "a" },
    ],
    ticks: [
      {
        o: "x",
        v: 2,
        b: 1111,
        e: 1071,
        c: "#666666",
        w: 2,
        k: "a",
        l: { t: "-2", dx: 0, dy: 120, a: "middle", s: 100, c: "#666666" },
      },
      {
        o: "y",
        v: 1,
        b: 1795,
        e: 1835,
        c: "#666666",
        w: 2,
        k: "a",
        l: { t: "-1.0", dx: -30, dy: 35, a: "end", s: 100, c: "#666666" },
      },
    ],
    texts: [],
  };
  const layout = layoutOf(scene);
  // The frame is the plot area: the first scene's frame shape, at the layout's origin.
  assert.deepEqual(layout.frame, [0, 0, 3580, 2213]);
  // Rails live inside the frame, on the sides the labels or the marks need. The box only
  // holds the padding. The x tick's mark points up (a stuck axis at the top keeps it inside)
  // and the y tick's points right (a stuck axis at the right keeps that one inside).
  assert.ok(layout.rails.bottom > 0, "a rail below");
  assert.ok(layout.rails.left > 0, "a rail left");
  assert.ok(layout.rails.right >= 40, "a rail right for the y marks");
  assert.ok(layout.rails.top >= 40, "a rail top for the x marks");
  assert.ok(Math.abs(layout.box[0] + layout.pad) < 1e-9, "no band left");
  assert.ok(Math.abs(layout.box[1] + layout.pad) < 1e-9, "no band top");
  assert.ok(Math.abs(layout.box[2] - (3580 + 2 * layout.pad)) < 1e-9, "no band right");
  assert.ok(Math.abs(layout.box[3] - (2213 + 2 * layout.pad)) < 1e-9, "no band bottom");
});

test("a frame label gets an outside band on every edge it sits on", () => {
  // `FrameTicks -> All`: labels outside on all four edges (Woxi puts each frame label outside its
  // edge), and no rails anywhere - frame labels never move, so their bands are always used.
  const scene = {
    box: [0, 0, 3600, 2300],
    frame: [232, 5, 3352, 2071],
    rect: [232, 2076, 3584, 5],
    bg: "#FFFFFF",
    fs: { c: "#666666", w: 10 },
    lines: [
      { o: "y", v: 0, c: "#666666", w: 2, k: "g" },
      { o: "x", v: 0, c: "#666666", w: 2, k: "g" },
    ],
    ticks: [
      {
        o: "x",
        v: 2,
        at: 1908,
        b: 2077,
        e: 2053,
        c: "#666666",
        w: 10,
        k: "f",
        s: "b",
        l: { t: "-2", dx: 0, dy: 120, a: "middle", s: 100, c: "#666666" },
      },
      {
        o: "y",
        v: 1,
        at: 1040,
        b: 232,
        e: 256,
        c: "#666666",
        w: 10,
        k: "f",
        s: "l",
        l: { t: "-1.0", dx: -30, dy: 25, a: "end", s: 100, c: "#666666" },
      },
      {
        o: "x",
        v: 2,
        at: 1908,
        b: 5,
        e: 29,
        c: "#666666",
        w: 10,
        k: "f",
        s: "t",
        l: { t: "2", dx: 0, dy: -50, a: "middle", s: 100, c: "#666666" },
      },
      {
        o: "y",
        v: 1,
        at: 1040,
        b: 3584,
        e: 3560,
        c: "#666666",
        w: 10,
        k: "f",
        s: "r",
        l: { t: "1.0", dx: 31, dy: 25, a: "start", s: 100, c: "#666666" },
      },
    ],
    texts: [],
  };
  const layout = layoutOf(scene);
  assert.deepEqual(layout.rails, { left: 0, right: 0, top: 0, bottom: 0 });
  assert.ok(layout.box[0] < -layout.pad, "a band left");
  assert.ok(layout.box[1] < -layout.pad, "a band top");
  assert.ok(layout.box[0] + layout.box[2] > layout.frame[2] + layout.pad, "a band right");
  assert.ok(layout.box[3] > layout.frame[3] + layout.pad, "a band bottom");
});

test("each frame edge grows only its own band", () => {
  const frame = [232, 5, 3352, 2071];
  const sides = {
    left: { o: "y", b: 232, e: 272, at: 1040, s: "l", dx: -30, dy: 35, a: "end" },
    right: { o: "y", b: 3584, e: 3544, at: 1040, s: "r", dx: 30, dy: 35, a: "start" },
    top: { o: "x", b: 5, e: 45, at: 1908, s: "t", dx: 0, dy: -50, a: "middle" },
    bottom: { o: "x", b: 2076, e: 2036, at: 1908, s: "b", dx: 0, dy: 120, a: "middle" },
  };
  for (const [side, shape] of Object.entries(sides)) {
    const scene = {
      box: [0, 0, 3600, 2300],
      frame,
      rect: [232, 2076, 3584, 5],
      bg: "#FFFFFF",
      fs: { c: "#666666", w: 10 },
      lines: [],
      ticks: [
        {
          o: shape.o,
          v: 1,
          at: shape.at,
          b: shape.b,
          e: shape.e,
          c: "#666666",
          w: 10,
          k: "f",
          s: shape.s,
          l: { t: "-1.0", dx: shape.dx, dy: shape.dy, a: shape.a, s: 100, c: "#666666" },
        },
      ],
      texts: [],
    };
    const layout = layoutOf(scene);
    assert.deepEqual(layout.rails, { left: 0, right: 0, top: 0, bottom: 0 }, side);
    const grows = {
      left: -layout.box[0] - layout.pad,
      top: -layout.box[1] - layout.pad,
      right: layout.box[2] - 3352 + layout.box[0] - layout.pad,
      bottom: layout.box[3] - 2071 + layout.box[1] - layout.pad,
    };
    for (const other of Object.keys(sides)) {
      if (other === side) {
        assert.ok(grows[other] > 0, `${side}: its band`);
      } else {
        assert.ok(Math.abs(grows[other]) < 1e-9, `${side}: no band on ${other}`);
      }
    }
  }
});

test("a static label outside the frame grows the box on its side", () => {
  const scene = {
    box: [0, 0, 3600, 2300],
    frame: [232, 5, 3352, 2071],
    rect: [232, 2076, 3584, 5],
    bg: "#FFFFFF",
    fs: { c: "#666666", w: 10 },
    lines: [],
    ticks: [],
    texts: [
      // A bottom frame label, below the frame.
      { t: "time", x: 1908, y: 2240, a: "middle", s: 100, c: "#666666" },
      // An inside title: it costs nothing.
      { t: "Sine", x: 1908, y: 150, a: "middle", s: 100, c: "#666666" },
    ],
  };
  const layout = layoutOf(scene);
  assert.ok(layout.box[3] > 2071 + layout.pad, "a band below the frame");
  assert.ok(Math.abs(layout.box[1] + layout.pad) < 1e-9, "no band above");
});

test("an axis line carries its origin, and a value outside the view clamps to the rail", () => {
  // The engine reports the axis's origin (0, or a user's `AxesOrigin`), never the edge it was
  // clamped to in the picture it rendered. Drawing the origin through the current view is what
  // makes a stale scene keep the axis still: when the origin is outside it clamps to the same
  // rail, and it moves in exactly when the view brings the origin inside.
  const frame = [0, 0, 1000, 1000];
  const rails = { left: 200, right: 150, top: 80, bottom: 120 };
  const scene = {
    box: [0, 0, 1000, 1000],
    frame,
    rect: [0, 1000, 1000, 0],
    rails,
    ticks: [],
    texts: [],
    lines: [
      { o: "x", v: 0, k: "a", c: "#666666", w: 2 },
      { o: "y", v: 0, k: "a", c: "#666666", w: 2 },
    ],
  };
  const left = sceneMapping(scene, { id: 1, x: [1, 3], y: [0.2, 1] }, null);
  const right = sceneMapping(scene, { id: 1, x: [-3, -1], y: [-3, -1] }, null);
  const inside = sceneMapping(scene, { id: 1, x: [-1, 1], y: [-1, 1] }, null);
  assert.equal(axisPosition(scene.lines[0], left, null, frame, rails), 200, "left rail");
  assert.equal(axisPosition(scene.lines[1], left, null, frame, rails), 880, "bottom rail");
  assert.equal(axisPosition(scene.lines[0], right, null, frame, rails), 850, "right rail");
  assert.equal(axisPosition(scene.lines[1], right, null, frame, rails), 80, "top rail");
  assert.equal(axisPosition(scene.lines[0], inside, null, frame, rails), 500, "the origin inside");
  assert.equal(axisPosition(scene.lines[1], inside, null, frame, rails), 500, "the x axis inside");
});

test("a stuck axis keeps its marks inside the frame on the side they point to", () => {
  const scene = {
    box: [0, 0, 1000, 1000],
    frame: [0, 0, 1000, 1000],
    rect: [0, 1000, 1000, 0],
    lines: [{ o: "x", v: 0, k: "a", c: "#666666", w: 2 }],
    ticks: [
      {
        o: "y",
        v: 0.5,
        b: 0,
        e: 40,
        k: "a",
        c: "#666666",
        w: 2,
        l: { t: "0.5", dx: -30, dy: 35, a: "end", s: 100, c: "#666666" },
      },
    ],
    texts: [],
  };
  const layout = layoutOf(scene);
  // The labels are on the left. The marks point right, so the right rail keeps them whole.
  assert.ok(layout.rails.left >= 200, "the label rail");
  assert.ok(layout.rails.right >= 40, "the mark rail");
  const pinned = { ...scene, rails: layout.rails };
  const atRight = { id: 1, x: [-6, -4], y: [-1, 1] };
  const mark = tickPlace(pinned.ticks[0], pinned, sceneMapping(pinned, atRight, null), null);
  assert.equal(mark.base, 1000 - layout.rails.right, "the axis stops a mark short of the border");
  assert.ok(mark.tip <= 1000, "the mark stays inside");
  assert.ok(mark.base - 30 - 200 >= 0, "the label stays inside");
});

test("an axis is clamped to its rail, and its ticks follow it", () => {
  // A horizontal axis (x) at y = 0, with a rail of 100 below it: the axis never comes closer to
  // the frame's bottom than that rail. A log y axis's origin is its low end, always the bottom.
  const scene = {
    frame: [0, 0, 1000, 1000],
    rect: [0, 1000, 1000, 0],
    rails: { left: 0, right: 0, top: 0, bottom: 100 },
    lines: [{ o: "y", v: 0, k: "a", c: "#666666", w: 2 }],
    ticks: [{ o: "x", v: 0.5, b: 500, e: 480, k: "a", c: "#666666", w: 2 }],
    texts: [],
  };
  const inside = { id: 1, x: [-1, 1], y: [-1, 1] };
  assert.equal(
    axisPosition(scene.lines[0], sceneMapping(scene, inside, null), null, scene.frame, scene.rails),
    500,
    "y = 0 in the middle of the view is drawn at its value"
  );
  const above = { id: 1, x: [-1, 1], y: [1, 3] };
  assert.equal(
    axisPosition(scene.lines[0], sceneMapping(scene, above, null), null, scene.frame, scene.rails),
    900,
    "y = 0 below the view stops at the bottom rail"
  );
  const log = { x: false, y: true };
  assert.equal(
    axisPosition(scene.lines[0], sceneMapping(scene, inside, log), log, scene.frame, scene.rails),
    900,
    "a log axis origin sits on the low rail"
  );
  assert.equal(tickPlace(scene.ticks[0], scene, sceneMapping(scene, inside, null), null).base, 500);
  const atBottom = tickPlace(scene.ticks[0], scene, sceneMapping(scene, above, null), null);
  assert.equal(atBottom.base, 900, "the tick follows the axis");
  assert.equal(atBottom.tip, 880, "and its mark points up, into the frame");
});

test("an unlabeled axis mark still reserves its rail", () => {
  // The mark rail is measured from every axis tick, not only the labeled ones: a plot can have
  // unlabeled major ticks (Woxi omits the label at the origin, for one), and a stuck axis must
  // still stop far enough inside the frame for their marks. The mark direction never flips.
  const scene = {
    box: [0, 0, 1000, 1000],
    frame: [0, 0, 1000, 1000],
    rect: [0, 1000, 1000, 0],
    lines: [{ o: "x", v: 0, k: "a", c: "#666666", w: 2 }],
    ticks: [{ o: "y", v: 0.5, b: 0, e: 40, k: "a", c: "#666666", w: 2 }],
    texts: [],
  };
  const layout = layoutOf(scene);
  assert.equal(layout.rails.right, 40);
  const pinned = { ...scene, rails: layout.rails };
  const mark = tickPlace(
    pinned.ticks[0],
    pinned,
    sceneMapping(pinned, { id: 1, x: [-6, -4], y: [-1, 1] }, null),
    null
  );
  assert.equal(mark.base, 1000 - layout.rails.right);
  assert.equal(mark.tip, 1000);
});

test("a fill baseline follows its kind and the view it is drawn at", () => {
  // `Axis` and `Value` are view-independent. `Bottom`/`Top` are the range the renderer is
  // drawing now (Woxi's `reference_y(y_min, y_max)`), not the picture's original range.
  const view = { id: 1, x: [-1, 1], y: [2, 6] };
  const color = "#3D99CC";
  const fill = (kind, value) => ({ kind, value, color, opacity: 0.2 });
  assert.equal(fillBaseline(fill("axis"), view, null), 0);
  assert.equal(fillBaseline(fill("value", 5), view, null), 5);
  assert.equal(fillBaseline(fill("bottom"), view, null), 2);
  assert.equal(fillBaseline(fill("top"), view, null), 6);
  // A fill without a kind (not a shape the engine emits) has no baseline to draw to.
  assert.equal(fillBaseline({ value: 4, color, opacity: 0.2 }, view, null), null);
  const log = { x: false, y: true };
  assert.equal(fillBaseline(fill("bottom"), view, log), Math.log10(2));
  assert.equal(fillBaseline(fill("top"), view, log), Math.log10(6));
  // A `Value` is already in the drawing space (the engine took the logarithm).
  assert.equal(fillBaseline(fill("value", 0.5), view, log), 0.5);
});

test("a later scene is drawn in the first scene's layout", () => {
  const next = sequence(0x1a70);
  for (let i = 0; i < CASES; i += 1) {
    const first = sceneOf(next);
    const layout = layoutOf(first);
    // The first scene becomes the layout: its frame moves to the layout's origin, its picture
    // box is mapped with it (its width is what the sample fractions are scaled by), and it
    // learns the rails.
    const pinned = normalize(first, layout);
    assert.deepEqual(pinned.frame, layout.frame, `frame ${i}`);
    assert.equal(pinned.box[2], first.box[2], `box width ${i}`);
    assert.equal(pinned.box[3], first.box[3], `box height ${i}`);
    assert.deepEqual(pinned.rails, layout.rails, `rails ${i}`);
    // Applying the layout again is a no-op in values (it always builds a new object, so a
    // scene can be mapped at any time without keeping a special case for "already mapped").
    assert.deepEqual(normalize(pinned, layout), pinned, `identity ${i}`);
    // A renderer that laid the same plot out differently at another range: wider margins, a
    // shorter frame, the labels at slightly different offsets.
    const frame = [10 + 60 * next(), 5 + 30 * next(), 0, 0];
    frame[2] = 240 + 120 * next();
    frame[3] = 140 + 100 * next();
    const later = {
      ...first,
      box: [0, 0, frame[2] + 2 * frame[0], frame[3] + 2 * frame[1]],
      frame,
      rect: [frame[0] + 6, frame[1] + frame[3] - 6, frame[0] + frame[2] - 6, frame[1] + 6],
      fs: { c: "#666666", w: 2 },
      lines: [{ o: "x", v: 0, c: "#666666", w: 2, k: "a", d: [10, 5] }],
      ticks: [
        {
          o: "x",
          v: 1.5,
          b: frame[1] + frame[3],
          e: frame[1] + frame[3] - 20,
          c: "#666666",
          w: 2,
          k: "a",
          l: { t: "1.5", dx: 2, dy: 30, a: "middle", s: 100, c: "#666666" },
        },
      ],
      texts: [
        {
          t: "value",
          x: frame[0] - 40,
          y: frame[1] + frame[3] / 2,
          a: "middle",
          s: 100,
          c: "#666666",
          r: { a: -90, x: frame[0] - 40, y: frame[1] + frame[3] / 2 },
        },
      ],
    };
    const drawn = normalize(later, layout);
    for (let k = 0; k < 4; k += 1) {
      assert.equal(drawn.frame[k], layout.frame[k], `frame ${i}/${k}`);
    }
    const sx = layout.frame[2] / later.frame[2];
    const sy = layout.frame[3] / later.frame[3];
    // The picture box is mapped like the frame. Its width is the reference for the samples'
    // stroke/dash/marker fractions, so a picture laid out with different margins keeps them.
    assert.ok(Math.abs(drawn.box[2] - later.box[2] * sx) < 1e-9, `picture box width ${i}`);
    assert.ok(Math.abs(drawn.box[3] - later.box[3] * sy) < 1e-9, `picture box height ${i}`);
    const at = (x, y) => [
      layout.frame[0] + (x - later.frame[0]) * sx,
      layout.frame[1] + (y - later.frame[1]) * sy,
    ];
    assert.deepEqual(drawn.rect.slice(0, 2), at(later.rect[0], later.rect[1]), `rect ${i}`);
    assert.deepEqual(drawn.rect.slice(2), at(later.rect[2], later.rect[3]), `rect ${i}`);
    // The tick's value is unchanged. Its mark and label move with the frame, and its kind (it
    // follows its axis) is carried through.
    assert.equal(drawn.ticks[0].v, later.ticks[0].v, `tick value ${i}`);
    assert.equal(drawn.ticks[0].k, "a", `tick kind ${i}`);
    assert.equal(drawn.lines[0].k, "a", `line kind ${i}`);
    assert.ok(Math.abs(drawn.lines[0].d[0] - 10 * Math.min(sx, sy)) < 1e-9, `dash on ${i}`);
    assert.ok(Math.abs(drawn.lines[0].d[1] - 5 * Math.min(sx, sy)) < 1e-9, `dash off ${i}`);
    assert.deepEqual(
      [drawn.ticks[0].b, drawn.ticks[0].e],
      [at(0, later.ticks[0].b)[1], at(0, later.ticks[0].e)[1]],
      `tick mark ${i}`
    );
    assert.equal(drawn.ticks[0].c, later.ticks[0].c, `tick color ${i}`);
    assert.ok(Math.abs(drawn.ticks[0].w - 2 * Math.min(sx, sy)) < 1e-9, `tick width ${i}`);
    assert.equal(drawn.ticks[0].l.t, "1.5", `label ${i}`);
    assert.ok(Math.abs(drawn.ticks[0].l.dx - 2 * sx) < 1e-9, `label dx ${i}`);
    assert.ok(Math.abs(drawn.ticks[0].l.dy - 30 * sy) < 1e-9, `label dy ${i}`);
    // A rotated label keeps its angle and turns about the mapped anchor.
    assert.equal(drawn.texts[0].r.a, -90, `rotation ${i}`);
    assert.deepEqual(
      [drawn.texts[0].r.x, drawn.texts[0].r.y],
      at(later.texts[0].r.x, later.texts[0].r.y),
      `rotation anchor ${i}`
    );
    assert.deepEqual(
      [drawn.texts[0].x, drawn.texts[0].y],
      at(later.texts[0].x, later.texts[0].y),
      `text ${i}`
    );
  }
});

test("the layout gives the frame the first scene's shape and no label bands of its own", () => {
  const scene = sceneOf(sequence(0x1));
  const layout = layoutOf(scene);
  assert.deepEqual(layout.frame, [0, 0, scene.frame[2], scene.frame[3]]);
  assert.equal(layout.box[2], scene.frame[2] + 2 * layout.pad);
  assert.equal(layout.box[3], scene.frame[3] + 2 * layout.pad);
  assert.deepEqual(layout.rails, { left: 0, right: 0, top: 0, bottom: 0 });
});

test("the engine scene fixture carries every field the canvas draws", () => {
  const scene = ENGINE_SCENE;
  for (const key of ["box", "frame", "rect"]) {
    assert.ok(Array.isArray(scene[key]) && scene[key].length === 4, key);
    assert.ok(scene[key].every(Number.isFinite), key);
  }
  assert.equal(typeof scene.bg, "string");
  assert.ok(scene.fs === undefined || (typeof scene.fs.c === "string" && scene.fs.w > 0));
  assert.ok(scene.lines.length > 0 && scene.ticks.length > 0, "a scene has lines and ticks");
  for (const line of scene.lines) {
    assert.ok(line.o === "x" || line.o === "y", JSON.stringify(line));
    assert.ok(Number.isFinite(line.v) && Number.isFinite(line.w), JSON.stringify(line));
    assert.equal(typeof line.c, "string");
    assert.ok(line.k === "a" || line.k === "g", JSON.stringify(line));
    assert.ok(line.d === undefined || line.d.every(Number.isFinite), JSON.stringify(line));
  }
  // A frame with ticks on all four sides, and labels on the sides Woxi prints them.
  let labeled = 0;
  for (const tick of scene.ticks) {
    assert.ok(tick.o === "x" || tick.o === "y", JSON.stringify(tick));
    assert.ok(
      Number.isFinite(tick.v) &&
        Number.isFinite(tick.at) &&
        Number.isFinite(tick.b) &&
        Number.isFinite(tick.e),
      JSON.stringify(tick)
    );
    assert.equal(typeof tick.c, "string");
    assert.ok(tick.w > 0);
    assert.ok(tick.k === "a" || tick.k === "f", JSON.stringify(tick));
    if (tick.k === "f") {
      assert.ok(
        ["l", "r", "t", "b"].includes(tick.s),
        `a frame tick names its edge: ${JSON.stringify(tick)}`
      );
    } else {
      assert.equal(tick.s, undefined, JSON.stringify(tick));
    }
    if (tick.l) {
      labeled += 1;
      assert.equal(typeof tick.l.t, "string");
      assert.ok(
        Number.isFinite(tick.l.dx) && Number.isFinite(tick.l.dy) && tick.l.s > 0,
        JSON.stringify(tick.l)
      );
      assert.ok(["start", "middle", "end"].includes(tick.l.a));
      assert.equal(typeof tick.l.c, "string");
    }
  }
  assert.ok(labeled > 0, "the fixture has labeled ticks");
  assert.ok(
    scene.texts.some((text) => text.r),
    "the fixture has a rotated axis label"
  );
  for (const text of scene.texts) {
    assert.equal(typeof text.t, "string");
    assert.ok(
      Number.isFinite(text.x) && Number.isFinite(text.y) && text.s > 0,
      JSON.stringify(text)
    );
    assert.equal(typeof text.c, "string");
    if (text.r) {
      assert.ok(
        Number.isFinite(text.r.a) && Number.isFinite(text.r.x) && Number.isFinite(text.r.y)
      );
    }
  }
  assert.ok(
    scene.lines.some((line) => Array.isArray(line.d)),
    "the fixture has dashed grid lines"
  );
  // The client's own operations on the engine's output: the layout gives the frame the picture's
  // shape, keeps its frame labels outside (bands), and the scene maps data y upward.
  const layout = layoutOf(scene);
  assert.deepEqual(layout.frame, [0, 0, scene.frame[2], scene.frame[3]]);
  assert.deepEqual(layout.rails, { left: 0, right: 0, top: 0, bottom: 0 });
  assert.ok(layout.box[0] < -layout.pad, "a band left for the frame labels");
  assert.ok(layout.box[3] > scene.frame[3] + layout.pad, "a band below for the frame labels");
  const mapping = dataMapping({ id: 1, x: [-5, 5], y: [-1, 1] }, scene, sceneBoxOf(scene), 1, null);
  assert.ok(mapping && mapping.a > 0 && mapping.d < 0, "the fixture maps data y upward");
});

// Paint one scene into a fake canvas that records where the labels land. `paint` needs only a 2D
// context's surface here, so a clamp can be held to the position the scene asked for.
function paintedLabels(scene, view) {
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const layout = layoutOf(scene);
    const drawn = normalize(scene, layout);
    const box = { x: layout.box[0], y: layout.box[1], width: layout.box[2], height: layout.box[3] };
    const texts = [];
    const context = {
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      globalAlpha: 1,
      textAlign: "left",
      textBaseline: "alphabetic",
      lineJoin: "",
      lineCap: "",
      setTransform() {},
      clearRect() {},
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fill() {},
      setLineDash() {},
      strokeRect() {},
      closePath() {},
      arc() {},
      translate() {},
      rotate() {},
      fillRect() {},
      fillText(t, x, y) {
        texts.push({ t, x, y });
      },
    };
    const svg = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: box.width, height: box.height }),
    };
    const handle = {
      scene: drawn,
      container: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      canvas: { style: {}, width: 0, height: 0 },
      context,
      box,
      svg,
      prepared: null,
      log: { x: false, y: false },
    };
    assert.equal(paint(handle, view), true);
    return { texts, layout, drawn };
  } finally {
    delete globalThis.window;
  }
}

test("a frame label is painted at its own baseline on every edge", () => {
  // The placement clamp uses the label's ink relative to its anchor. Using the layout's box
  // (relative to the tick base) counts the label's offset twice: a bottom frame label then gets
  // pushed up into the frame, which is exactly the overlap a screenshot showed.
  const scene = {
    box: [0, 0, 1100, 1200],
    frame: [0, 0, 1000, 1000],
    rect: [0, 1000, 1000, 0],
    bg: "#FFFFFF",
    fs: { c: "#666666", w: 10 },
    lines: [],
    ticks: [
      {
        o: "x",
        v: 0,
        at: 500,
        b: 1000,
        e: 965,
        k: "f",
        s: "b",
        c: "#666666",
        w: 10,
        l: { t: "0.0", dx: 0, dy: 120, a: "middle", s: 100, c: "#666666" },
      },
      {
        o: "x",
        v: 0,
        at: 500,
        b: 0,
        e: 35,
        k: "f",
        s: "t",
        c: "#666666",
        w: 10,
        l: { t: "0.0", dx: 0, dy: -51, a: "middle", s: 100, c: "#666666" },
      },
      {
        o: "y",
        v: 0,
        at: 500,
        b: 0,
        e: 35,
        k: "f",
        s: "l",
        c: "#666666",
        w: 10,
        l: { t: "0.0", dx: -30, dy: 25, a: "end", s: 100, c: "#666666" },
      },
      {
        o: "y",
        v: 0,
        at: 500,
        b: 1000,
        e: 965,
        k: "f",
        s: "r",
        c: "#666666",
        w: 10,
        l: { t: "0.0", dx: 30, dy: 25, a: "start", s: 100, c: "#666666" },
      },
    ],
    texts: [],
  };
  const { texts } = paintedLabels(scene, { id: 1, x: [-1, 1], y: [-1, 1] });
  const at = (x, y) => texts.find((text) => text.x === x && text.y === y);
  assert.ok(at(500, 1000 + 120), "bottom frame label on its baseline");
  assert.ok(at(500, 0 - 51), "top frame label on its baseline");
  assert.ok(at(0 - 30, 500 + 25), "left frame label beside its edge");
  assert.ok(at(1000 + 30, 500 + 25), "right frame label beside its edge");
});

test("a frame tick follows its value with the view, like an axis tick", () => {
  // A gesture draws the newest scene at the finger's view, so the scene's values map through a
  // range it was not rendered at. A frame tick is still a data value on a fixed edge: it moves
  // along that edge with the view, so the tick keeps up with the curve at display rate instead
  // of waiting for the next answer. A value that is no longer in the view is not drawn.
  const scene = {
    box: [0, 0, 1100, 1200],
    frame: [0, 0, 1000, 1000],
    rect: [0, 1000, 1000, 0],
    bg: "#FFFFFF",
    fs: { c: "#666666", w: 10 },
    lines: [],
    ticks: [
      {
        o: "x",
        v: 0.5,
        at: 750,
        b: 1000,
        e: 965,
        k: "f",
        s: "b",
        c: "#666666",
        w: 10,
        l: { t: "0.5", dx: 0, dy: 120, a: "middle", s: 100, c: "#666666" },
      },
    ],
    texts: [],
  };
  const at = (view) =>
    paintedLabels(scene, { id: 1, x: view, y: [-1, 1] }).texts.filter((text) => text.t === "0.5");
  // Value 0.5 is three quarters of the way across [-1, 1], and the middle of [0, 1].
  assert.equal(at([-1, 1])[0].x, 750);
  assert.equal(at([0, 1])[0].x, 500);
  // Outside the view its mark is not drawn, and its label must not be either.
  assert.equal(at([2, 3]).length, 0);
});

test("an axis label at a clamped rail stays below its axis", () => {
  // The same clamp applies to an axis label. A tick on the x axis (whose value is inside the
  // view) follows the axis to the bottom rail. Its label is 120 below that base, inside the
  // rail. Counted from the tick base twice, it would be pushed back onto the axis.
  const scene = {
    box: [0, 0, 1100, 1200],
    frame: [0, 0, 1000, 1000],
    rect: [0, 1000, 1000, 0],
    bg: "#FFFFFF",
    fs: { c: "#666666", w: 10 },
    lines: [{ o: "y", v: 0, k: "a", c: "#666666", w: 2 }],
    ticks: [
      {
        o: "x",
        v: 0,
        at: 500,
        b: 500,
        e: 460,
        k: "a",
        c: "#666666",
        w: 10,
        l: { t: "0", dx: 0, dy: 120, a: "middle", s: 100, c: "#666666" },
      },
    ],
    texts: [],
  };
  const { texts, layout } = paintedLabels(scene, { id: 1, x: [-1, 1], y: [1, 3] });
  const base = 1000 - layout.rails.bottom;
  assert.ok(base < 1000 - 100, "the axis is clamped off the frame bottom");
  assert.ok(
    texts.some((text) => text.t === "0" && text.y === base + 120),
    "the label sits below its clamped axis"
  );
});

test("a scene that cannot be mapped is left alone", () => {
  const scene = sceneOf(sequence(0x77));
  const layout = layoutOf(scene);
  assert.equal(normalize(scene, null), scene);
  assert.equal(normalize(null, layout), null);
  const flat = normalize({ ...scene, frame: [0, 0, 0, 0] }, layout);
  assert.equal(flat.frame[2], 0);
});

test("a pan moves the drawn curve by exactly the finger pixels (I1)", () => {
  const next = sequence(0x51ed);
  for (let i = 0; i < CASES; i += 1) {
    const scene = sceneOf(next);
    const box = boxOf(scene);
    const view = {
      id: 1,
      x: [-8 + 4 * next(), 4 + 8 * next()],
      y: [-3 + 2 * next(), 2 + 4 * next()],
    };
    const mapping = dataMapping(view, scene, box, 1, null);
    assert.ok(mapping, `mapping ${i}`);
    const dx = (next() - 0.5) * 200;
    const dy = (next() - 0.5) * 120;
    const panned = panViewFrom(view, dx, dy, mapping, null);
    assert.ok(panned, `pan ${i}`);
    const moved = dataMapping(panned, scene, box, 1, null);
    const point = [(view.x[0] + view.x[1]) / 2, (view.y[0] + view.y[1]) / 2];
    const before = { x: mapping.a * point[0] + mapping.b, y: mapping.d * point[1] + mapping.f };
    const after = { x: moved.a * point[0] + moved.b, y: moved.d * point[1] + moved.f };
    assert.ok(
      Math.abs(after.x - before.x - dx) < 1e-6,
      `case ${i}: x ${after.x - before.x} vs ${dx}`
    );
    assert.ok(
      Math.abs(after.y - before.y - dy) < 1e-6,
      `case ${i}: y ${after.y - before.y} vs ${dy}`
    );
  }
});

test("a tick keeps its label offset and follows the curve (I1, I6)", () => {
  const next = sequence(0x77aa);
  for (let i = 0; i < CASES; i += 1) {
    const scene = sceneOf(next);
    const box = boxOf(scene);
    const view = {
      id: 2,
      x: [-8 + 4 * next(), 4 + 8 * next()],
      y: [-3 + 2 * next(), 2 + 4 * next()],
    };
    const mapping = dataMapping(view, scene, box, 1, null);
    const tick = {
      o: "x",
      v: view.x[0] + 0.3 * (view.x[1] - view.x[0]),
      b: scene.frame[1] + scene.frame[3],
      e: scene.frame[1] + scene.frame[3] + 10,
    };
    tick.b = scene.rect[1] + 10;
    tick.e = tick.b + 10;
    const dx = (next() - 0.5) * 120;
    const panned = panViewFrom(view, dx, 0, mapping, null);
    const moved = dataMapping(panned, scene, box, 1, null);
    const beforeMark = tickPlace(tick, scene, sceneMapping(scene, view, null), null);
    const afterMark = tickPlace(tick, scene, sceneMapping(scene, panned, null), null);
    assert.ok(
      Math.abs(moved.a * tick.v + moved.b - (mapping.a * tick.v + mapping.b) - dx) < 1e-6,
      `case ${i}: ${moved.a * tick.v + moved.b - (mapping.a * tick.v + mapping.b)} vs ${dx}`
    );
    assert.ok(Math.abs(afterMark.base - beforeMark.base) < 1e-9, `case ${i}: tick height`);
  }
});

test("a zoom keeps its anchor under the finger on either axis type (I1)", () => {
  const next = sequence(0x2b3c);
  for (let i = 0; i < CASES; i += 1) {
    const log = { x: next() < 0.5, y: next() < 0.5 };
    const view = {
      id: 3,
      x: log.x ? [0.01 + next(), 10 + 100 * next()] : [-10 + 2 * next(), 2 + 10 * next()],
      y: log.y ? [0.01 + next(), 10 + 100 * next()] : [-10 + 2 * next(), 2 + 10 * next()],
    };
    const scene = sceneOf(next);
    const box = boxOf(scene);
    const fx = -0.5 + 2 * next();
    const fy = -0.5 + 2 * next();
    const factor = 0.3 + 2.5 * next();
    const zoomed = zoomViewFrom(view, factor, fx, fy, log);
    assert.ok(zoomed, `zoom ${i}`);
    const axisValue = (logarithmic, value) => (logarithmic ? Math.log10(value) : value);
    // The anchor is a fraction of each axis (of its decades on a log axis), from the left and from
    // the top. It may sit outside the range.
    const fromFraction = (logarithmic, low, high, fraction, fromTop) => {
      const a = axisValue(logarithmic, low);
      const b = axisValue(logarithmic, high);
      const value = fromTop ? b - fraction * (b - a) : a + fraction * (b - a);
      return logarithmic ? Math.pow(10, value) : value;
    };
    const anchor = [
      fromFraction(log.x, view.x[0], view.x[1], fx, false),
      fromFraction(log.y, view.y[0], view.y[1], fy, true),
    ];
    const mapping = dataMapping(view, scene, box, 1, log);
    if (!mapping) continue;
    const anchorPixels = {
      x: mapping.a * axisValue(log.x, anchor[0]) + mapping.b,
      y: mapping.d * axisValue(log.y, anchor[1]) + mapping.f,
    };
    const after = fractionOf(zoomed, mapping, anchorPixels.x, anchorPixels.y, log);
    assert.ok(Math.abs(after.fx - fx) < 1e-9, `case ${i}: fx ${after.fx} vs ${fx}`);
    assert.ok(Math.abs(after.fy - fy) < 1e-9, `case ${i}: fy ${after.fy} vs ${fy}`);
  }
});

test("a logarithmic view never reaches a non-positive bound (I7)", () => {
  const next = sequence(0x1ce);
  for (let i = 0; i < CASES; i += 1) {
    const log = { x: true, y: true };
    const view = {
      id: 4,
      x: [Math.pow(10, -300 + 300 * next()), Math.pow(10, -100 + 100 * next())],
      y: [Math.pow(10, -300 + 300 * next()), Math.pow(10, -100 + 100 * next())],
    };
    if (!(view.x[0] < view.x[1] && view.y[0] < view.y[1])) continue;
    const scene = sceneOf(next);
    const box = boxOf(scene);
    const mapping = dataMapping(view, scene, box, 1, log);
    if (!mapping) continue;
    const panned = panViewFrom(view, (next() - 0.5) * 4000, (next() - 0.5) * 4000, mapping, log);
    if (panned) {
      assert.ok(panned.x[0] > 0 && panned.x[1] > panned.x[0], `case ${i}: ${panned.x}`);
      assert.ok(panned.y[0] > 0 && panned.y[1] > panned.y[0], `case ${i}: ${panned.y}`);
    }
    const zoomed = zoomViewFrom(view, 0.2 + 3 * next(), 0.5, 0.5, log);
    assert.ok(zoomed, `zoom ${i}`);
    assert.ok(zoomed.x[0] > 0 && zoomed.x[1] > zoomed.x[0], `case ${i}: ${zoomed.x}`);
    assert.ok(zoomed.y[0] > 0 && zoomed.y[1] > zoomed.y[0], `case ${i}: ${zoomed.y}`);
  }
});

test("a re-sample is asked for only when the samples cannot serve the view (I2)", () => {
  const next = sequence(0xc0de);
  for (let i = 0; i < CASES; i += 1) {
    const d0 = -20 + 10 * next();
    const d1 = 20 + 10 * next();
    const width = d1 - d0;
    const samples = { s: true, dn: false, d: [d0, d1] };
    const view = { x: [d0 + width * next(), d0 + width * next()], y: [0, 1] };
    if (!(view.x[0] < view.x[1])) continue;
    const due = needsRefine(view, samples, null, { x: width, y: 1 });
    const outside = view.x[0] < d0 || view.x[1] > d1;
    const margin = Math.min(view.x[0] - d0, d1 - view.x[1]);
    const narrow = view.x[1] - view.x[0] < width * ZOOM_IN;
    assert.equal(
      due,
      outside || margin < (view.x[1] - view.x[0]) * REFINE_NEAR || narrow,
      `case ${i}: ${JSON.stringify(view)} against ${JSON.stringify(samples.d)}`
    );
    assert.equal(
      needsRefine(view, { s: false, dn: false, d: [d0, d1] }, null, { x: width, y: 1 }),
      false
    );
  }
});

test("the protocol constants agree with the shared fixture", () => {
  assert.equal(LOG_FALLBACK_DECADES, FIXTURE.log_fallback_decades);
  assert.equal(U16_MAX, FIXTURE.u16_max);
  assert.equal(REFINE_NEAR, FIXTURE.refine_near);
  assert.equal(ZOOM_IN, FIXTURE.zoom_in);
  assert.equal(DENSIFY_MAX_LEVEL, FIXTURE.densify_max_level);
  assert.equal(MAX_REFINE_PAD, FIXTURE.max_refine_pad);
});
