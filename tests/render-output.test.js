// Typeset output -> HTML, without the app: the client re-expresses a result's size in em
// against the font size the engine recorded for the layout, and only the opening tag is
// rewritten, so a width inside the drawing is not mistaken for the canvas.

import assert from "node:assert/strict";
import { test } from "node:test";

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
