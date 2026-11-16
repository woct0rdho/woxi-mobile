// The chip insertion rules, without a browser: `apply` only needs the active text and
// an entry writer, which is the whole point of the sink interface.

import assert from "node:assert/strict";
import { test } from "node:test";

// `assist.js` loads the sheet module, which registers window-level error handlers.
globalThis.window = {
  addEventListener() {},
};

const { Assist } = await import("../app/src/main/assets/www/js/assist.js");

function applyWith(name, detail, code) {
  const calls = [];
  const assist = new Assist({
    read() {
      return { code: code || name, caret: (code || name).length, selStart: 0, selEnd: 0 };
    },
    replace(start, end, text, caret) {
      calls.push({ start, end, text, caret });
    },
  });
  assist.candidates = { key: "", prefix: "", names: [name], details: [detail], total: 1 };
  assist.apply(name);
  assert.equal(calls.length, 1);
  return calls[0];
}

test("a callable name without an arity still opens a call", () => {
  for (const name of ["Print", "Show", "Directive", "Manipulate"]) {
    const call = applyWith(name, {
      type: "function",
      status: "implemented",
      arity: null,
    });
    assert.equal(call.text, name + "[]", name);
    assert.equal(call.caret, call.text.length - 1, name);
  }
});

test("an explicit value symbol stays bare even without an arity", () => {
  for (const name of ["Full", "Center", "TraditionalForm"]) {
    const call = applyWith(name, {
      type: "function",
      status: "implemented",
      arity: null,
    });
    assert.equal(call.text, name, name);
    assert.equal(call.caret, name.length, name);
  }
});

test("a zero-argument call leaves the caret after its brackets", () => {
  const call = applyWith("NotebookDirectory", {
    type: "function",
    status: "implemented",
    arity: [0, 0],
  });
  assert.equal(call.text, "NotebookDirectory[]");
  assert.equal(call.caret, call.text.length);
});
