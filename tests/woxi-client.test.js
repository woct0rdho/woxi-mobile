// Native request routing: a result belongs to the page that submitted it, even when a
// recreated WebView reuses request ids.

import assert from "node:assert/strict";
import { test } from "node:test";

let invoked = null;
globalThis.window = {
  WoxiNativeCallbacks: {},
  WoxiNative: {
    engineRequest(...args) {
      invoked = args;
    },
    plotRequest(...args) {
      invoked = args;
    },
    queryRequest(...args) {
      invoked = args;
    },
  },
};

const { WoxiClient } = await import("../app/src/main/assets/www/js/woxi-client.js");

test("a request carries its page token and ignores a stale callback", async () => {
  const client = new WoxiClient("page-a");
  const answer = client.request("text", "1 + 1");

  assert.deepEqual(invoked.slice(0, 3), [1, "text", "1 + 1"]);
  assert.equal(invoked[5], "page-a");

  globalThis.window.WoxiNativeCallbacks.onEngineResult(1, "stale", "page-b");
  assert.equal(Object.keys(client.pending).length, 1);

  globalThis.window.WoxiNativeCallbacks.onEngineResult(1, "[]", "page-a");
  assert.equal(await answer, "[]");
  assert.equal(Object.keys(client.pending).length, 0);
});

test("plot and query requests use the same page token envelope", async () => {
  const client = new WoxiClient("page-c");

  const plot = client.plot("plot_view", {});
  assert.equal(invoked[2], "page-c");
  globalThis.window.WoxiNativeCallbacks.onEngineResult(invoked[0], "{}", "page-c");
  assert.deepEqual(await plot, {});

  const query = client.query("is_complete_request", {});
  assert.equal(invoked[2], "page-c");
  globalThis.window.WoxiNativeCallbacks.onEngineResult(invoked[0], "{}", "page-c");
  assert.deepEqual(await query, {});
});
