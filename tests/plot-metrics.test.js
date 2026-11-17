// The label metrics are vendored from Woxi (`woxi-0.4.0/src/functions/plot_padding.rs`): the
// renderer lays a plot's labels out in Arial advances and its own ascent/line height, and the
// headless tests install that table (`tests/plot-metrics-fallback.js`) as their measure. These are
// the numbers Woxi's own padding tests assert, so a change to the table or to the metrics fails
// here before it can drift silently.

import assert from "node:assert/strict";
import { test } from "node:test";

import { setFallbackMeasure, textWidth } from "../app/src/main/assets/www/js/plot-metrics.js";
import { estimateWidth } from "./plot-metrics-fallback.js";

setFallbackMeasure(estimateWidth);

test("the vendored label widths match the renderer's padding tables", () => {
  const close = (actual, expected, label) => {
    assert.ok(Math.abs(actual - expected) < 1e-3, `${label}: ${actual} != ${expected}`);
  };
  // Woxi's `tick_label_widths_follow_arial`: a numeric label uses the renderer's wide minus and
  // the thin-space digit blocks. Other text uses the Arial advances.
  close(textWidth("100", 10), 16.6846, "100");
  close(textWidth("0.0010", 10), 30.586, "0.0010");
  close(textWidth("-1.0", 10), 20.204, "-1.0");
  close(textWidth("10000", 10), 29.199, "10000 (digit blocks)");
  close(textWidth("time", 10), 18.892, "time");
  // A multi-line label measures its widest line.
  assert.equal(textWidth("1\n10000", 10), textWidth("10000", 10));
});
