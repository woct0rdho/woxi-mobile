// A notebook replacement invalidates in-flight evaluation loops. This module is pure, so
// the generation contract is covered without a DOM or WebView.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  currentEvaluation,
  invalidateEntry,
  invalidateEvaluations,
  isCurrentEntry,
  isCurrentEvaluation,
} from "../app/src/main/assets/www/js/evaluation-generation.js";

test("an evaluation generation becomes stale after a notebook replacement", () => {
  const before = currentEvaluation();
  assert.equal(isCurrentEvaluation(before), true);
  invalidateEvaluations();
  assert.equal(isCurrentEvaluation(before), false);
  const after = currentEvaluation();
  assert.notEqual(after, before);
  assert.equal(isCurrentEvaluation(after), true);
});

test("an entry token becomes stale when that entry is deleted or cleared", () => {
  const entry = { evalToken: 0 };
  assert.equal(isCurrentEntry(entry, 0), true);
  invalidateEntry(entry);
  assert.equal(isCurrentEntry(entry, 0), false);
  assert.equal(isCurrentEntry(entry, 1), true);
  invalidateEntry(entry);
  assert.equal(isCurrentEntry(entry, 1), false);
  assert.equal(isCurrentEntry(entry, 2), true);
});
