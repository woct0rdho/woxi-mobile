// Caret context and the writes that depend on it: the iterator row must only claim the
// iterator slot's own empty pair, and the call-card actions must target the slot or the
// options region rather than whatever happens to be under the caret.

import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.window = {
  addEventListener() {},
};

const { Assist } = await import("../app/src/main/assets/www/js/assist.js");

function assistWith(code, caret) {
  const calls = [];
  const assist = new Assist({
    read() {
      return { code: code, caret: caret, selStart: caret, selEnd: caret };
    },
    replace(start, end, text, after) {
      calls.push({ start: start, end: end, text: text, caret: after });
    },
  });
  return { assist: assist, calls: calls };
}

function stateAt(code, caret) {
  return assistWith(code, caret).assist.contextFor({ code: code, caret: caret }).state;
}

test("an iterator row claims only an empty iterator argument", () => {
  assert.equal(stateAt("Table[x, {}]", 10), "iterator");
  assert.equal(stateAt("Table[x, {i, 10}]", 10), "signature");
  assert.equal(stateAt("Table[x, {i, {}}]", 14), "signature");
  assert.equal(stateAt("Table[x, { } + 1]", 10), "signature");
});

test("a chip fills the empty iterator pair, not a nested list", () => {
  const empty = assistWith("Table[x, {}]", 10);
  empty.assist.apply("{i, 10}");
  assert.deepEqual(empty.calls, [{ start: 9, end: 11, text: "{i, 10}", caret: 7 }]);
});

test("the call card's example replaces its own slot", () => {
  const call = assistWith("Plot[Sin[x], {x, 0, 1}]", 7);
  call.assist.applyExample("{y, 0, 2}", 1);
  assert.equal(call.calls.length, 1);
  assert.equal(call.calls[0].start, 13);
  assert.equal(call.calls[0].end, 22);
  assert.equal(call.calls[0].text, "{y, 0, 2}");
});

test("a missing slot is appended before the call's closing bracket", () => {
  const call = assistWith("Plot[Sin[x]]", 7);
  call.assist.applyExample("{y, 0, 2}", 1);
  assert.deepEqual(call.calls, [{ start: 11, end: 11, text: ", {y, 0, 2}", caret: 11 }]);
});

test("a call-card option is appended to the options region", () => {
  const call = assistWith("Plot[Sin[x]]", 7);
  call.assist.applyOption("Frame");
  assert.deepEqual(call.calls, [{ start: 11, end: 11, text: ", Frame -> ", caret: 11 }]);
});

test("a global option symbol in an options region gets its arrow", () => {
  const code = "Plot3D[Sin[x] Sin[y], {x, 0, 1}, {y, 0, 1}, Ax";
  const assist = assistWith(code, code.length);
  assist.assist.candidates = {
    key: "",
    prefix: "Ax",
    names: ["Axes"],
    details: [{ type: "function", option: true, callOption: false }],
    total: 1,
  };
  assist.assist.apply("Axes", undefined, { option: true });
  assert.equal(assist.calls.length, 1);
  assert.equal(assist.calls[0].text, "Axes -> ");
  assert.equal(assist.calls[0].caret, 8);
});

test("inspect caches the options and arity one request answers", async () => {
  let requests = 0;
  const assist = new Assist({ read() {} });
  assist.query = function () {
    requests += 1;
    return Promise.resolve({
      status: "ok",
      content: {
        found: true,
        metadata: {
          _woxi: { name: "Plot", arity: [1, null], optionDefaults: [["Frame", "False"]] },
        },
      },
    });
  };
  const inspected = await assist.inspectFor("Plot");
  const again = await assist.inspectFor("Plot");
  assert.equal(requests, 1);
  assert.equal(inspected, again);
  assert.deepEqual(inspected.info.optionDefaults, [{ name: "Frame", value: "False" }]);
  assert.deepEqual(assist.optionsOf("Plot"), [{ name: "Frame", value: "False" }]);
  assert.deepEqual(assist.callArityOf("Plot"), [1, null]);
});

test("the options context carries the call and the options already used", () => {
  const code = "Plot[Sin[x], {x, 0, 1}, Frame -> True, Fra";
  const assist = assistWith(code, code.length).assist;
  const info = assist.contextFor({ code: code, caret: code.length });
  const context = assist.optionsContext(info, { code: code, caret: code.length });
  assert.deepEqual(context, { head: "Plot", used: ["Frame"] });
});

test("an option after a two-argument form does not select the larger overload", () => {
  const code = "Solve[x^2 == 1, x, ]";
  const caret = code.length - 1;
  const info = assistWith(code, caret).assist.contextFor({ code: code, caret: caret });
  assert.equal(info.variant.length, 2);
  assert.equal(info.state, "options");
});

test("a numeric literal is not an option prefix", () => {
  const code = "Plot[f, {x, 0, 1}, 1]";
  const info = assistWith(code, code.length - 1).assist.contextFor({
    code: code,
    caret: code.length - 1,
  });
  assert.equal(info.state, "signature");
});

test("a prototype name that exists on Object.prototype does not crash", () => {
  assert.equal(stateAt("constructor[", 12), "idle");
});

test("nextSlot leaves a filled call and a nested list", () => {
  function nextSlotAt(code, caret) {
    let at = null;
    const assist = new Assist({
      read() {
        return { code: code, caret: caret, selStart: caret, selEnd: caret };
      },
      replace() {},
      setCaret(value) {
        at = value;
      },
    });
    assist.nextSlot();
    return at;
  }

  const code = "Plot[Sin[x], {x, 0, 1}]";
  assert.equal(nextSlotAt(code, 20), code.length);
  assert.equal(nextSlotAt(code, 9), code.indexOf("]") + 1);
});

test("a chip replaces a whole identifier when the caret is inside it", () => {
  const assist = assistWith("Sin[x]", 2);
  assist.assist.candidates = {
    key: "",
    prefix: "Si",
    names: ["Sin"],
    details: [{ type: "function" }],
    total: 1,
  };
  assist.assist.apply("Sin");
  assert.deepEqual(assist.calls, [{ start: 0, end: 3, text: "Sin", caret: 3 }]);

  const rename = assistWith("Sin[x]", 2);
  rename.assist.candidates = {
    key: "",
    prefix: "Si",
    names: ["Cos"],
    details: [{ type: "function" }],
    total: 1,
  };
  rename.assist.apply("Cos");
  assert.deepEqual(rename.calls, [{ start: 0, end: 3, text: "Cos", caret: 3 }]);
});

test("a chip on an existing call head does not add a skeleton", () => {
  const assist = assistWith("Sin[x]", 2).assist;
  assert.equal(assist.applySkeleton("Sin", { chip: true }), false);
});

test("an option of the call is not wrapped into a skeleton", () => {
  const assist = assistWith("f[", 2).assist;
  assert.equal(assist.applySkeleton("Plot", { callOption: true }), false);
});

test("an occupied argument is not an options slot", () => {
  const cases = [
    ["Plot[Sin[x], {x, -5, 5}, Frame -> True]", "Frame"],
    ["Plot[Sin[x], {x, -5, 5}, 1]", "1"],
    ["Plot[Sin[x], {x, -5, 5}, {x, 0, 1}]", "{x, 0, 1}"],
    ['Plot[Sin[x], {x, -5, 5}, "text"]', '"text"'],
  ];
  for (const [code, content] of cases) {
    assert.equal(stateAt(code, code.indexOf(content)), "signature", code);
  }
  const empty = "Plot[Sin[x], {x, -5, 5}, ]";
  assert.equal(stateAt(empty, empty.length - 1), "options");
});

test("an option accepted inside an existing rule keeps its arrow", () => {
  const code = "Plot[Sin[x], {x, -5, 5}, Axes -> True]";
  const caret = code.indexOf("Axes") + 4;
  const call = assistWith(code, caret);
  call.assist.candidates = {
    key: "",
    prefix: "Axes",
    names: ["Axes"],
    details: [{ type: "function", option: true, callOption: true }],
    total: 1,
  };
  call.assist.apply("Axes");
  assert.deepEqual(call.calls, [
    { start: code.indexOf("Axes"), end: code.indexOf("Axes") + 4, text: "Axes", caret: 4 },
  ]);
});

test("the call card does not list the active form as another form", () => {
  const code = "Plot[Sin[x], {x, -5, 5}]";
  const caret = code.length - 1;
  const assist = new Assist({
    read() {
      return { code: code, caret: caret, selStart: caret, selEnd: caret };
    },
  });
  assist.learned.Plot = [
    {
      slots: [
        { role: "expression", name: "f", examples: ["Sin[x]"] },
        { role: "iterator", name: "{x, xmin, xmax}", examples: ["{x, -2 Pi, 2 Pi}"] },
      ],
    },
  ];
  const rows = assist.callRows();
  const other = rows.filter(function (row) {
    return row.indexOf("data-assist-variant=") >= 0;
  });
  assert.equal(other.length, 1);
  assert.ok(other[0].indexOf('data-assist-variant="Plot:1"') >= 0);
});

test("an inspection that arrives after a prefix asks for matches again", async () => {
  const code = "Foo[1, x";
  const assist = new Assist({
    read() {
      return { code: code, caret: code.length, selStart: code.length, selEnd: code.length };
    },
  });
  assist.query = function () {
    return Promise.resolve({
      status: "ok",
      content: {
        found: true,
        metadata: { _woxi: { name: "Foo", arity: [1, null], optionDefaults: [] } },
      },
    });
  };
  let requested = 0;
  assist.refreshBar = function () {};
  assist.requestCurrentMatches = function () {
    requested += 1;
  };
  assist.ensureCallMeta("Foo");
  await new Promise(function (resolve) {
    setTimeout(resolve, 0);
  });
  assert.equal(requested, 1);
});

test("an unfinished text is checked only once", async () => {
  const timers = [];
  const realSetTimeout = globalThis.window.setTimeout?.bind(globalThis.window);
  const realClearTimeout = globalThis.window.clearTimeout?.bind(globalThis.window);
  globalThis.window.setTimeout = function (callback) {
    timers.push(callback);
    return timers.length;
  };
  globalThis.window.clearTimeout = function () {};
  let requests = 0;
  const assist = new Assist({
    read() {
      return { code: "Sin[", caret: 4, selStart: 4, selEnd: 4 };
    },
  });
  assist.query = function () {
    requests += 1;
    return Promise.resolve({ status: "ok", content: { status: "incomplete", items: [] } });
  };
  try {
    assist.scheduleDiagnostics("Sin[");
    assert.equal(timers.length, 1);
    timers.shift()();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(requests, 1);
    assert.equal(assist.issues.code, "Sin[");
    assist.scheduleDiagnostics("Sin[");
    assert.equal(timers.length, 0);
    assert.equal(requests, 1);
  } finally {
    globalThis.window.setTimeout = realSetTimeout;
    globalThis.window.clearTimeout = realClearTimeout;
  }
});
