// Typeset output -> HTML, without the app: the client re-expresses a result's size in em
// against the font size the engine recorded for the layout, and only the opening tag is
// rewritten, so a width inside the drawing is not mistaken for the canvas.

import assert from "node:assert/strict";
import { test } from "node:test";

import { envelopeAspect, projectedEnvelope } from "../app/src/main/assets/www/js/plot3d-maths.js";
import { manipulateView, renderItems } from "../app/src/main/assets/www/js/render-output.js";

// A typeset SVG as the engine writes it: width/height in the layout's pixels, no viewBox,
// the layout size on the root, written by `engine/src/typeset.rs`.
const ROOT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="38" height="15" data-woxi-font-size="14">' +
  '<g fill="black"><g transform="translate(0.0,0.0)">' +
  '<text x="0" y="11.2" font-family="monospace" font-size="14.0">x</text></g></g></svg>';

function typeset(svg) {
  return renderItems(JSON.stringify([{ type: "text", text: "x", svg: svg }])).html;
}

test("a typeset result is re-expressed in em against the recorded layout size", () => {
  const html = typeset(ROOT);
  assert.match(html, /width="2\.714em"/);
  assert.match(html, /height="1\.071em"/);
  assert.match(html, /viewBox="0 0 38 15"/);
  assert.match(html, /class="woxi-svg"/);
  assert.match(html, /data-woxi-font-size="14"/);
  // The runs keep the layout's own numbers.
  assert.match(html, /font-size="14\.0"/);
});

test("the class is added once, and an existing viewBox is kept", () => {
  const html = typeset(ROOT.replace('height="15"', 'height="15" viewBox="0 0 1 1"'));
  assert.equal((html.match(/<svg[^>]*class="/g) || []).length, 1);
  assert.equal((html.match(/viewBox="/g) || []).length, 1);
  assert.match(html, /viewBox="0 0 1 1"/);
});

test("a larger styled run does not change the layout scale", () => {
  // `Style[x, 24] + y`: the layout was asked for 14 px and one glyph is 24.
  const styled = ROOT.replace('width="38" height="15"', 'width="41" height="26"').replace(
    'font-size="14.0">x',
    'font-size="24.0">x'
  );
  const html = typeset(styled);
  assert.match(html, /width="2\.929em"/);
  assert.match(html, /height="1\.857em"/);
});

test("a document without the recorded size keeps its pixels", () => {
  // A document the engine's pass refused: its width is already the layout's size, so
  // there is nothing to divide by.
  const html = typeset(ROOT.replace(' data-woxi-font-size="14"', ""));
  assert.match(html, /width="38"/);
  assert.doesNotMatch(html, /em"/);
  assert.match(html, /class="woxi-svg"/);
});

test("a width inside the drawing is not the canvas", () => {
  // `RawBoxes[FrameBox[...]]`: the frame is a <rect> with its own width.
  const framed =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="24" data-woxi-font-size="14">' +
    '<g fill="black"><rect x="0.5" y="0.5" width="16.8" height="22.7"/></g></svg>';
  const html = typeset(framed);
  assert.match(html, /width="1\.286em"/);
  assert.match(html, /<rect x="0\.5" y="0\.5" width="16\.8" height="22\.7"\/>/);
});

test("an svg without a size keeps its pixels and still gets the class", () => {
  const html = typeset('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>');
  assert.doesNotMatch(html, /em"/);
  assert.match(html, /class="woxi-svg"/);
});

const PLOT3D_THEME = {
  background: "#ffffff",
  axis: [102, 102, 102],
  label: [102, 102, 102],
};

function scene3d(overrides = {}) {
  return {
    camera: { az: -1.07, el: 0.63, dist: 6.68, perspective: true },
    ranges: [
      [-1, 1],
      [-1, 1],
      [-1, 1],
    ],
    box: [1, 1, 1],
    vertices: "",
    indices: "",
    colors: "",
    lines: "",
    lineColors: "",
    coverage: [
      [-1, 1],
      [-1, 1],
      [-1, 1],
    ],
    card: { width: null, height: null, full: false },
    theme: PLOT3D_THEME,
    axes: true,
    boxed: true,
    ...overrides,
  };
}

test("a 3D scene renders a canvas card, not an SVG", () => {
  const html = renderItems([{ type: "graphics", plot3d: scene3d() }]).html;
  assert.match(html, /class="woxi-out woxi-out-graphic woxi-plot3d"/);
  assert.match(html, /data-woxi-plot3d="0"/);
  assert.match(html, /woxi-plot3d-gl/);
  assert.doesNotMatch(html, /<svg/);
});

test("a 3D ImageSize sets the fixed card aspect", () => {
  const plot3d = scene3d({ card: { width: 300, height: 200, full: false } });
  const html = renderItems([{ type: "graphics", plot3d: plot3d }]).html;
  assert.match(html, /--woxi-plot3d-width: 300px/);
  assert.match(html, /--woxi-plot3d-aspect: 1\.5/);
});

test("a 3D Automatic pair keeps Woxi's fixed square card", () => {
  const plot3d = scene3d({ card: { width: 360, height: 360, full: false } });
  const html = renderItems([{ type: "graphics", plot3d: plot3d }]).html;
  assert.match(html, /--woxi-plot3d-width: 360px/);
  assert.match(html, /--woxi-plot3d-aspect: 1/);
});

test("a 3D theme sets the card background", () => {
  const plot3d = scene3d({
    theme: { background: "#1a1a1a", axis: [153, 153, 153], label: [153, 153, 153] },
  });
  const html = renderItems([{ type: "graphics", plot3d: plot3d }]).html;
  assert.match(html, /--woxi-plot3d-bg: #1a1a1a/);
});

test("a 3D theme background is only emitted as a hex colour", () => {
  const plot3d = scene3d({
    theme: { background: "red; background:url(x)", axis: [153, 153, 153], label: [153, 153, 153] },
  });
  const html = renderItems([{ type: "graphics", plot3d: plot3d }]).html;
  assert.doesNotMatch(html, /--woxi-plot3d-bg/);
});

test("a bare 3D width lets the height follow the box, and a full-width card does too", () => {
  for (const card of [
    { width: null, height: null, full: true },
    { width: 300, height: null, full: false },
  ]) {
    const plot3d = scene3d({ card });
    const html = renderItems([{ type: "graphics", plot3d: plot3d }]).html;
    // The card's shape is the box's rotation envelope, not the first frame's: the box
    // has to stay inside it at every camera orientation.
    const envelope = projectedEnvelope(plot3d.box, plot3d.camera);
    const aspect = envelopeAspect(envelope);
    assert.match(html, new RegExp("--woxi-plot3d-aspect: " + aspect));
    assert.notEqual(Math.round(aspect * 100), 100, "this box's envelope is not square");
  }
  const plot3d = scene3d({ card: { width: null, height: null, full: true } });
  const html = renderItems([{ type: "graphics", plot3d: plot3d }]).html;
  assert.match(html, /--woxi-plot3d-width: 100%/);
});

test("a malformed 3D scene renders an error, not a broken notebook", () => {
  const html = renderItems([
    { type: "graphics", plot3d: { camera: {}, ranges: [], box: [] } },
  ]).html;
  assert.match(html, /woxi-out-error/);
  assert.doesNotMatch(html, /woxi-plot3d/);
});

test("a text item without svg stays plain text", () => {
  const html = renderItems(JSON.stringify([{ type: "text", text: "1/3" }])).html;
  assert.equal(html, '<div class="woxi-out woxi-out-text">1/3</div>');
});

test("an already parsed item array renders without another JSON pass", () => {
  const result = renderItems([{ type: "text", text: "1/3" }]);
  assert.deepEqual(result.items, [{ type: "text", text: "1/3" }]);
  assert.equal(result.html, '<div class="woxi-out woxi-out-text">1/3</div>');
});

test("a plot keeps its pixels and its viewBox", () => {
  const plot =
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">' +
    '<rect width="400" height="300"/><text x="1" y="2">x</text></svg>';
  const html = renderItems(JSON.stringify([{ type: "graphics", svg: plot }])).html;
  assert.match(html, /class="woxi-graphic"/);
  assert.match(html, /viewBox="0 0 400 300"/);
});

test("an unreadable answer reports the parse error", () => {
  const result = renderItems("{not json");
  assert.equal(result.items, null);
  assert.match(result.html, /Unreadable engine answer: /);
});

test("an empty answer renders nothing", () => {
  const result = renderItems("[]");
  assert.deepEqual(result.items, []);
  assert.equal(result.html, "");
});

// A question panel: another renderer drew it, so the root carries the font size instead
// of each run, and it already has a viewBox.
const PANEL =
  '<svg xmlns="http://www.w3.org/2000/svg" width="268" height="172" viewBox="0 0 268 172"' +
  ' font-family="monospace" font-size="14">' +
  '<text x="14" y="20">hi</text></svg>';

test("a document that drew itself is a picture, not a box layout", () => {
  const html = typeset(PANEL);
  assert.match(html, /woxi-out-graphic/);
  assert.match(html, /class="woxi-graphic"/);
  assert.doesNotMatch(html, /woxi-out-math/);
  // It keeps its pixels. Only a layout is re-expressed in em.
  assert.match(html, /width="268"/);
  assert.doesNotMatch(html, /em"/);
});

test("a manipulate view is a picture or the value as result text", () => {
  assert.match(manipulateView({ svg: ROOT }), /class="woxi-graphic"/);
  assert.equal(manipulateView({ text: "25" }), '<div class="woxi-out-text">25</div>');
  assert.equal(manipulateView(undefined), '<div class="woxi-out-text"></div>');
});

test("a restored slider keeps a numeric initial value that is not the minimum", () => {
  const html = renderItems(
    JSON.stringify([
      {
        type: "manipulate",
        body: "x",
        controls: [{ kind: "continuous", name: "a", min: 1, max: 3, initial: "2.5" }],
        initial: { svg: ROOT },
      },
    ])
  ).html;
  assert.match(html, /type="range"[^>]*value="2\.5"/);
  assert.match(html, /data-woxi-value="a">2\.5</);
});

test("an imported svg is stripped of active content", () => {
  const dirty =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)">' +
    "<script>alert(1)</script><foreignObject><div>x</div></foreignObject>" +
    '<text x="0" y="10">x</text></svg>';
  const html = renderItems(JSON.stringify([{ type: "graphics", svg: dirty }])).html;
  assert.doesNotMatch(html, /script/i);
  assert.doesNotMatch(html, /foreignObject/i);
  assert.doesNotMatch(html, /onload/i);
  assert.match(html, /<text/);
});
