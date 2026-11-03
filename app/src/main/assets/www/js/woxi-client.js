// Main-thread client for the native Woxi engine (libwoxi_jni.so).
// The Kotlin side runs the interpreter on a dedicated thread and answers through
// WoxiNativeCallbacks.onEngineResult(id, json), so evaluation never blocks the UI.

(function (global) {
  'use strict';

  function WoxiClient() {
    this.nextId = 1;
    this.pending = {};
  }

  // The native library is loaded on first use. There is nothing to boot.
  WoxiClient.prototype.start = function () {
    var self = this;
    global.WoxiNativeCallbacks = global.WoxiNativeCallbacks || {};
    global.WoxiNativeCallbacks.onEngineResult = function (id, json) {
      var pending = self.pending[id];
      if (!pending) return;
      delete self.pending[id];
      pending.resolve(json);
    };
    return Promise.resolve();
  };

  WoxiClient.prototype.send = function (invoke) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var bridge = global.WoxiNative;
      if (!bridge) {
        reject(new Error('native bridge unavailable'));
        return;
      }
      var id = self.nextId++;
      self.pending[id] = { resolve: resolve, reject: reject };
      try {
        invoke(bridge, id);
      } catch (err) {
        delete self.pending[id];
        reject(err);
      }
    });
  };

  WoxiClient.prototype.request = function (kind, input, body, bindings) {
    return this.send(function (bridge, id) {
      // Android's JS-interface object only supports direct calls (no apply/bind).
      bridge.engineRequest(id, kind, input || '', body || '', bindings || '');
    });
  };

  // One plot-interaction message. The envelope follows Jupyter: a `msg_type` and a
  // `content` object out, and a reply with `status` (`ok` or `error`, the latter with
  // `ename`/`evalue`) plus the payload in `content`.
  WoxiClient.prototype.plot = function (msgType, content) {
    return this.send(function (bridge, id) {
      bridge.plotRequest(id, JSON.stringify({ msg_type: msgType, content: content || {} }));
    }).then(function (text) {
      try {
        return JSON.parse(text);
      } catch (err) {
        return null;
      }
    });
  };

  // One typing-help message (`complete_request`, `inspect_request`,
  // `is_complete_request`, `catalog_request`). Same envelope as `plot`.
  WoxiClient.prototype.query = function (msgType, content) {
    return this.send(function (bridge, id) {
      bridge.queryRequest(id, JSON.stringify({ msg_type: msgType, content: content || {} }));
    }).then(function (text) {
      try {
        return JSON.parse(text);
      } catch (err) {
        return null;
      }
    });
  };

  // Evaluates one notebook entry. Resolves with the interpreter's JSON items.
  WoxiClient.prototype.evaluate = function (input) {
    return this.request('text', input);
  };

  // Clears every variable and definition of the interpreter session.
  WoxiClient.prototype.reset = function () {
    return this.request('reset', '');
  };

  // Re-renders a Manipulate body with new control values.
  WoxiClient.prototype.manipulate = function (body, bindings) {
    return this.request('manipulate', '', body, JSON.stringify(bindings || {}));
  };

  global.WoxiClient = WoxiClient;
})(window);
