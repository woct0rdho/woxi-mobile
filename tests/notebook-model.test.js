// The pure notebook invariants: valid ids, derived evaluated state and replay order. These
// tests do not need a browser, a WebView or the engine.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  executionCountBase,
  executionCounts,
  isEvaluated,
  isValidCellId,
  nextExecutionCount,
  replayEntries,
  replayInput,
  uniqueCellId,
} from "../app/src/main/assets/www/js/notebook-model.js";

test("a generated cell id is legal, eight characters and unique against the used set", () => {
  const used = new Set();
  for (let i = 0; i < 100; i += 1) {
    const id = uniqueCellId("", used);
    assert.equal(id.length, 8);
    assert.equal(isValidCellId(id), true);
    assert.equal(used.has(id), false);
    used.add(id);
  }
});

test("a valid imported id is kept, while invalid and duplicate ids are replaced", () => {
  const used = new Set();
  assert.equal(uniqueCellId("kept-id", used), "kept-id");
  used.add("kept-id");
  const invalid = uniqueCellId("not a jupyter id", used);
  assert.equal(isValidCellId(invalid), true);
  const duplicate = uniqueCellId("kept-id", used);
  assert.notEqual(duplicate, "kept-id");
  assert.equal(isValidCellId(duplicate), true);
  assert.equal(isValidCellId(""), false);
  assert.equal(isValidCellId("a".repeat(65)), false);
  assert.equal(isValidCellId("a".repeat(64)), true);
});

test("evaluated state is derived from a count or persisted items, not a flag", () => {
  assert.equal(isEvaluated({ executionCount: 0, items: null }), true);
  assert.equal(isEvaluated({ executionCount: null, items: [{ type: "text", text: "x" }] }), true);
  assert.equal(isEvaluated({ executionCount: null, items: [] }), false);
  assert.equal(isEvaluated({ executionCount: null, items: null }), false);
  assert.equal(isEvaluated(null), false);
});

test("the execution count base includes null-count evaluated cells and their copies", () => {
  const entries = [
    { input: "counted", executionCount: 4, items: [] },
    { input: "no count", executionCount: null, items: [{ type: "text", text: "x" }] },
    { input: "unevaluated", executionCount: null, items: [] },
  ];
  assert.equal(executionCountBase(entries), 5);
  assert.deepEqual(executionCounts(entries), [4, 5, null]);
  assert.equal(nextExecutionCount(entries), 6);
  entries.push({ input: "copy", executionCount: null, items: [{ type: "text", text: "x" }] });
  assert.equal(executionCountBase(entries), 6);
  assert.deepEqual(executionCounts(entries), [4, 5, null, 6]);
  assert.equal(nextExecutionCount(entries), 7);
});

test("execution counts accept zero and ignore non-integer counts", () => {
  assert.deepEqual(executionCounts([]), []);
  assert.equal(nextExecutionCount([]), 1);
  assert.deepEqual(
    executionCounts([
      { executionCount: 0, items: null },
      { executionCount: "2", items: [] },
      { executionCount: 2.5, items: [] },
    ]),
    [0, null, null]
  );
});

test("replay includes every evaluated cell and puts null counts after counted cells", () => {
  const entries = [
    { input: "late = 2", executionCount: 4, items: [] },
    { input: "no count", executionCount: null, items: [{ type: "text", text: "x" }] },
    { input: "early = 1", executionCount: 1, items: [] },
    { input: "", executionCount: 2, items: [] },
    { input: "unevaluated", executionCount: null, items: [] },
  ];
  assert.deepEqual(
    replayEntries(entries).map((entry) => entry.input),
    ["early = 1", "late = 2", "no count"]
  );
});

test("replay preserves notebook order among equal counts and null counts", () => {
  const entries = [
    { input: "a", executionCount: null, items: [{ type: "text", text: "a" }] },
    { input: "b", executionCount: 2, items: [] },
    { input: "c", executionCount: null, items: [{ type: "text", text: "c" }] },
    { input: "d", executionCount: 2, items: [] },
  ];
  assert.deepEqual(
    replayEntries(entries).map((entry) => entry.input),
    ["b", "d", "a", "c"]
  );
});

test("replay uses the source that produced the saved output, not an unexecuted edit", () => {
  const entry = {
    input: "edited",
    evaluatedInput: "saved",
    executionCount: 1,
    items: [],
  };
  assert.equal(replayInput(entry), "saved");
  assert.equal(replayInput({ input: "fallback", executionCount: null }), "fallback");
});
