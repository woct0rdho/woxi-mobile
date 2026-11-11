// Main-thread client for the native Woxi engine (libwoxi_jni.so).
// The Kotlin side runs the interpreter on a dedicated thread and answers through
// WoxiNativeCallbacks.onEngineResult(id, json), so evaluation never blocks the UI.

function WoxiClient() {
  this.nextId = 1;
  this.pending = {};
}

// The native library is loaded on first use. There is nothing to boot.
WoxiClient.prototype.start = function () {
  window.WoxiNativeCallbacks ??= {};
  window.WoxiNativeCallbacks.onEngineResult = (id, json) => {
    const pending = this.pending[id];
    if (!pending) return;
    delete this.pending[id];
    pending.resolve(json);
  };
  return Promise.resolve();
};

WoxiClient.prototype.send = function (invoke) {
  return new Promise((resolve, reject) => {
    const bridge = window.WoxiNative;
    if (!bridge) {
      reject(new Error("native bridge unavailable"));
      return;
    }
    const id = this.nextId++;
    this.pending[id] = { resolve: resolve, reject: reject };
    try {
      invoke(bridge, id);
    } catch (err) {
      delete this.pending[id];
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
};

WoxiClient.prototype.request = function (kind, input, body, bindings) {
  return this.send(function (bridge, id) {
    // Android's JS-interface object only supports direct calls (no apply/bind).
    bridge.engineRequest(id, kind, input || "", body || "", bindings || "");
  });
};

// One plot-interaction message. The envelope follows Jupyter: a `msg_type` and a
// `content` object out, and a reply with `status` (`ok` or `error`, the latter with
// `ename`/`evalue`) plus the payload in `content`.
WoxiClient.prototype.plot = async function (msgType, content) {
  const text = await this.send(function (bridge, id) {
    bridge.plotRequest(id, JSON.stringify({ msg_type: msgType, content: content || {} }));
  });
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// One typing-help message (`complete_request`, `inspect_request`,
// `is_complete_request`, `catalog_request`). Same envelope as `plot`.
WoxiClient.prototype.query = async function (msgType, content) {
  const text = await this.send(function (bridge, id) {
    bridge.queryRequest(id, JSON.stringify({ msg_type: msgType, content: content || {} }));
  });
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// Evaluates one notebook entry. Resolves with the interpreter's JSON items.
WoxiClient.prototype.evaluate = function (input) {
  return this.request("text", input);
};

// Clears every variable and definition of the interpreter session.
WoxiClient.prototype.reset = function () {
  return this.request("reset", "");
};

// Re-renders a Manipulate body with new control values.
WoxiClient.prototype.manipulate = function (body, bindings) {
  return this.request("manipulate", "", body, JSON.stringify(bindings || {}));
};

export { WoxiClient };
