// Session replay without a browser, WebView or engine process. The fake engine records the
// exact reset/evaluate sequence. The test covers single-flight replay, null-count entries
// and the generation boundary when a notebook is replaced mid-replay.

import assert from "node:assert/strict";
import { test } from "node:test";

// runtime.js only needs an event target at import time. toast() is a no-op because els.toast
// is still null, and these tests never build DOM.
globalThis.window = { addEventListener() {} };

const { runtime, state } = await import("../app/src/main/assets/www/js/runtime.js");
const { ensureSession, invalidateSession, startFreshSession } =
  await import("../app/src/main/assets/www/js/session.js");

function fakeEngine(calls) {
  return {
    reset: function () {
      calls.push("reset");
    },
    evaluate: function (input) {
      calls.push(input);
    },
  };
}

test("concurrent ensureSession calls share one replay and include null-count entries", async () => {
  const calls = [];
  runtime.engine = fakeEngine(calls);
  state.entries = [
    { input: "first", executionCount: 1, items: [] },
    { input: "null count", executionCount: null, items: [{ type: "text", text: "x" }] },
    { input: "unevaluated", executionCount: null, items: [] },
  ];
  invalidateSession();

  const first = ensureSession();
  const second = ensureSession();
  assert.equal(first, second);
  await first;
  assert.deepEqual(calls, ["reset", "first", "null count"]);
  assert.equal(state.sessionRestored, true);
});

test("startFreshSession resets an empty notebook and ensureSession waits for it", async () => {
  const calls = [];
  runtime.engine = fakeEngine(calls);
  state.entries = [{ input: "", executionCount: null, items: [] }];
  invalidateSession();

  const fresh = startFreshSession();
  const waiting = ensureSession();
  assert.equal(waiting, fresh);
  await fresh;
  assert.deepEqual(calls, ["reset"]);
  assert.equal(state.sessionRestored, true);
});

test("a replay from a replaced notebook cannot mark the replacement restored", async () => {
  const calls = [];
  let releaseFirstReset;
  let resetCount = 0;
  runtime.engine = {
    reset: function () {
      resetCount += 1;
      calls.push("reset");
      if (resetCount === 1) {
        return new Promise(function (resolve) {
          releaseFirstReset = resolve;
        });
      }
      return Promise.resolve();
    },
    evaluate: function (input) {
      calls.push(input);
    },
  };
  state.entries = [{ input: "old", executionCount: 1, items: [] }];
  invalidateSession();
  const oldReplay = ensureSession();

  // Let the queued replay enter its reset before replacing the notebook.
  await Promise.resolve();

  // Replace the notebook while the old reset is still unresolved. The replacement has no
  // entries, so its fresh session must win and no old evaluation may run.
  invalidateSession();
  state.entries = [{ input: "", executionCount: null, items: [] }];
  const fresh = startFreshSession();
  releaseFirstReset();

  await oldReplay;
  await fresh;
  assert.deepEqual(calls, ["reset", "reset"]);
  assert.equal(state.sessionRestored, true);
});
