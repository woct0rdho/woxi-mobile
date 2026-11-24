// The notebook file format, without the app: a notebook round-trips through nbformat 4.5,
// outputs and standard ipywidgets state come back without evaluation, and a foreign
// notebook's standard text/SVG/stream outputs survive as well.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  itemsFromOutputs,
  NBFORMAT,
  NBFORMAT_MINOR,
  parse,
  serialize,
} from "../app/src/main/assets/www/js/notebook.js";
import {
  executionCountBase,
  isEvaluated,
  isValidCellId,
} from "../app/src/main/assets/www/js/notebook-model.js";
import { displayTitle, suggestFileName } from "../app/src/main/assets/www/js/notebook-name.js";
import * as WoxiWidgets from "../app/src/main/assets/www/js/widgets.js";

test("a notebook round-trips through nbformat 4.5", () => {
  const state = {
    title: "Integration",
    entries: [{ input: "Integrate[x^2, x]" }, { input: "Plot[Sin[x], {x, -5, 5}]" }, { input: "" }],
  };
  const parsed = parse(serialize(state));
  // The filename is the title. No custom metadata.title is written.
  assert.equal(parsed.title, undefined);
  // Blank code cells are part of the notebook document, not a writer placeholder.
  assert.deepEqual(
    parsed.entries.map((entry) => entry.input),
    ["Integrate[x^2, x]", "Plot[Sin[x], {x, -5, 5}]", ""]
  );
  assert.equal(parsed.skippedCells, 0);
});

test("blank cells and trailing source whitespace round-trip exactly", () => {
  const inputs = ["x = 1\n\n", "", "  ", "y = 2\n"];
  const parsed = parse(
    serialize({
      entries: inputs.map((input) => ({ input: input, executionCount: null, items: null })),
    })
  );
  assert.deepEqual(
    parsed.entries.map((entry) => entry.input),
    inputs
  );
});

test("a code cell with an empty source keeps its saved output", () => {
  const source = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: "code",
        id: "empty-source",
        execution_count: 4,
        source: "",
        outputs: [
          {
            output_type: "execute_result",
            execution_count: 4,
            data: { "text/plain": ["saved"] },
            metadata: {},
          },
        ],
      },
    ],
  };
  const parsed = parse(JSON.stringify(source));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].input, "");
  assert.equal(parsed.entries[0].items[0].text, "saved");
});

test("the file is nbformat 4.5 and only code cells are taken", () => {
  const notebook = JSON.parse(serialize({ entries: [{ input: "x = 1" }] }));
  assert.equal(notebook.nbformat, NBFORMAT);
  assert.equal(notebook.nbformat_minor, NBFORMAT_MINOR);
  assert.equal(notebook.cells.length, 1);
  assert.equal(notebook.cells[0].cell_type, "code");
  assert.equal(notebook.cells[0].id.length, 8);
  assert.equal(notebook.metadata.title, undefined);
  // A markdown cell is not executed. It is reported as skipped.
  notebook.cells.splice(0, 0, { cell_type: "markdown", source: ["# notes"], metadata: {} });
  const parsed = parse(JSON.stringify(notebook));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].input, "x = 1");
  assert.equal(parsed.skippedCells, 1);
});

test("an evaluated entry's engine items become notebook outputs and parse back", () => {
  const items = [
    { type: "text", text: "x^3/3", svg: '<svg width="40" height="15"></svg>' },
    { type: "print", text: "hi" },
  ];
  const notebook = JSON.parse(
    serialize({
      entries: [
        {
          input: "Integrate[x^2, x]",
          cellId: "abcdef12",
          executionCount: 7,
          items: items,
        },
        { input: "not evaluated", cellId: "abcdef13" },
      ],
    })
  );
  const outputs = notebook.cells[0].outputs;
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0].output_type, "execute_result");
  assert.equal(outputs[0].execution_count, 7);
  assert.deepEqual(outputs[0].data["text/plain"], ["x^3/3"]);
  assert.match(outputs[0].data["image/svg+xml"].join(""), /<svg width="40"/);
  assert.equal(outputs[1].output_type, "stream");
  assert.equal(outputs[1].name, "stdout");
  // A cell that was never evaluated contributes no outputs and no execution count.
  assert.deepEqual(notebook.cells[1].outputs, []);
  assert.equal(notebook.cells[1].execution_count, null);

  const parsed = parse(JSON.stringify(notebook));
  assert.equal(parsed.entries[0].cellId, "abcdef12");
  assert.equal(parsed.entries[0].executionCount, 7);
  assert.equal(parsed.entries[0].items[0].type, "text");
  assert.equal(parsed.entries[0].items[0].text, "x^3/3");
  assert.equal(parsed.entries[0].items[1].type, "print");
});

test("an evaluated cell with no output keeps its execution count", () => {
  const notebook = JSON.parse(
    serialize({
      entries: [
        {
          input: "x = 1;",
          cellId: "abcdef12",
          executionCount: 3,
          items: null,
        },
      ],
    })
  );
  assert.equal(notebook.cells[0].execution_count, 3);
  assert.deepEqual(notebook.cells[0].outputs, []);
  const parsed = parse(JSON.stringify(notebook));
  assert.equal(parsed.entries[0].executionCount, 3);
  assert.deepEqual(parsed.entries[0].items, []);
});

test("a Manipulate panel is standard ipywidgets state plus a view MIME", () => {
  const svg = '<svg width="20" height="20"><g/></svg>';
  const item = {
    type: "manipulate",
    body: "Plot[a x, {x, 0, 1}]",
    controls: [
      { kind: "continuous", name: "a", min: 1, max: 5, initial: "1" },
      { kind: "checkbox", name: "b", initial: "true" },
      { kind: "discrete", name: "c", values: ["x", "y"], initial: "y" },
    ],
    initial: { svg: svg },
  };
  const notebook = JSON.parse(
    serialize({
      entries: [
        {
          input: "Manipulate[Plot[a x, {x, 0, 1}], {a, 1, 5}, {b, True}, {c, {x, y}}]",
          cellId: "abcdef12",
          executionCount: 4,
          items: [item],
          widgets: [{ values: { a: "3", b: "false", c: "x" }, view: { svg: svg } }],
        },
      ],
    })
  );
  const state = notebook.metadata.widgets[WoxiWidgets.STATE_MIME];
  assert.equal(state.version_major, 2);
  assert.equal(state.version_minor, 0);
  assert.equal(state.state["abcdef12m0r"].model_name, "VBoxModel");
  assert.equal(state.state["abcdef12m0c0"].model_name, "FloatSliderModel");
  assert.equal(state.state["abcdef12m0c1"].model_name, "CheckboxModel");
  assert.equal(state.state["abcdef12m0c2"].model_name, "DropdownModel");
  assert.equal(state.state["abcdef12m0c0"].state.value, 3);
  assert.equal(state.state["abcdef12m0c1"].state.value, false);
  assert.equal(state.state["abcdef12m0c2"].state.index, 0);
  const output = notebook.cells[0].outputs[0];
  assert.equal(output.data[WoxiWidgets.VIEW_MIME].model_id, "abcdef12m0r");
  assert.match(output.data["image/svg+xml"].join(""), /<svg/);
  assert.match(output.data["text/plain"].join(""), /^$/);

  const parsed = parse(JSON.stringify(notebook));
  const restored = parsed.entries[0].items[0];
  assert.equal(restored.type, "manipulate");
  assert.equal(restored.body, "Plot[a x, {x, 0, 1}]");
  assert.equal(restored.controls.length, 3);
  assert.equal(restored.controls[0].initial, "3");
  assert.equal(restored.controls[1].initial, "false");
  assert.equal(restored.controls[2].initial, "x");
  assert.equal(restored.initial.svg, svg);
});

test("a Manipulate without a supported graph keeps its ordinary SVG", () => {
  const item = {
    type: "manipulate",
    body: "x",
    controls: [{ kind: "locator", name: "p" }],
    initial: { svg: '<svg width="20" height="20"><g/></svg>' },
  };
  const notebook = JSON.parse(
    serialize({
      entries: [
        {
          input: "Manipulate[x, {p, Locator}]",
          cellId: "abcdef12",
          executionCount: 1,
          items: [item],
        },
      ],
    })
  );
  assert.equal(notebook.metadata.widgets, undefined);
  assert.equal(notebook.cells[0].outputs[0].data[WoxiWidgets.VIEW_MIME], undefined);
  assert.match(notebook.cells[0].outputs[0].data["image/svg+xml"].join(""), /<svg/);
});

test("a text Manipulate uses a LabelModel and survives a round-trip", () => {
  const item = {
    type: "manipulate",
    body: "a x",
    controls: [{ kind: "continuous", name: "a", min: 1, max: 3, initial: "1" }],
    initial: { text: "5" },
  };
  const notebook = JSON.parse(
    serialize({
      entries: [
        {
          input: "Manipulate[a x, {a, 1, 3}]",
          cellId: "abcdef12",
          executionCount: 2,
          items: [item],
        },
      ],
    })
  );
  const state = notebook.metadata.widgets[WoxiWidgets.STATE_MIME].state;
  assert.equal(state["abcdef12m0v"].model_name, "LabelModel");
  assert.equal(state["abcdef12m0v"].state.value, "5");
  const parsed = parse(JSON.stringify(notebook));
  assert.equal(parsed.entries[0].items[0].initial.text, "5");
});

test("cell and widget ids are stable across saves", () => {
  const item = {
    type: "manipulate",
    body: "a",
    controls: [{ kind: "continuous", name: "a", min: 1, max: 3, initial: "1" }],
    initial: { svg: "<svg/>" },
  };
  const entry = {
    input: "Manipulate[a, {a, 1, 3}]",
    executionCount: null,
    items: null,
    cellId: "abcdef12",
  };
  const first = JSON.parse(serialize({ entries: [entry] })).cells[0].id;
  const second = JSON.parse(serialize({ entries: [entry] })).cells[0].id;
  assert.equal(first, "abcdef12");
  assert.equal(second, first);
  entry.items = [item];
  entry.executionCount = 1;
  const one = JSON.parse(serialize({ entries: [entry] }));
  const two = JSON.parse(serialize({ entries: [entry] }));
  assert.deepEqual(
    Object.keys(one.metadata.widgets[WoxiWidgets.STATE_MIME].state),
    Object.keys(two.metadata.widgets[WoxiWidgets.STATE_MIME].state)
  );
});

test("serialization repairs ids without mutating the notebook entries", () => {
  const entry = {
    cellId: "not a legal id",
    input: "x = 1",
    executionCount: null,
    items: null,
  };
  const notebook = JSON.parse(serialize({ entries: [entry] }));

  assert.equal(entry.cellId, "not a legal id");
  assert.equal(isValidCellId(notebook.cells[0].id), true);
});

test("foreign text, SVG, streams and errors become renderable items", () => {
  const items = itemsFromOutputs(
    [
      {
        output_type: "execute_result",
        execution_count: 1,
        data: { "text/plain": ["x^3/3"], "image/svg+xml": ["<svg/>"] },
      },
      {
        output_type: "display_data",
        data: { "image/svg+xml": ["<svg/>"], "text/plain": [""] },
      },
      { output_type: "stream", name: "stdout", text: ["hello\n"] },
      { output_type: "stream", name: "stderr", text: ["Warning: x\n"] },
      { output_type: "stream", name: "stderr", text: ["Error: bad\n"] },
      { output_type: "error", ename: "E", evalue: "bad", traceback: ["E: bad"] },
      { output_type: "display_data", data: { "text/html": ["<b>x</b>"] } },
    ],
    null,
    ""
  );
  assert.deepEqual(
    items.map((item) => item.type),
    ["text", "graphics", "print", "warning", "error", "error"]
  );
  assert.equal(items[0].text, "x^3/3");
  assert.equal(items[1].svg, "<svg/>");
  assert.equal(items[5].text, "E: bad");
});

test("invalid and duplicate cell ids are repaired on import and save", () => {
  const source = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { cell_type: "code", id: "not a legal id", execution_count: 1, source: "a", outputs: [] },
      { cell_type: "code", id: "same-id", execution_count: 2, source: "b", outputs: [] },
      { cell_type: "code", id: "same-id", execution_count: 3, source: "c", outputs: [] },
    ],
  };
  const parsed = parse(JSON.stringify(source));
  const parsedIds = parsed.entries.map((entry) => entry.cellId);
  assert.equal(new Set(parsedIds).size, parsedIds.length);
  assert.equal(parsedIds.every(isValidCellId), true);

  const saved = JSON.parse(serialize({ entries: parsed.entries }));
  const savedIds = saved.cells.map((cell) => cell.id);
  assert.equal(new Set(savedIds).size, savedIds.length);
  assert.equal(savedIds.every(isValidCellId), true);
});

test("valid hyphen and underscore cell ids do not collide in widget models", () => {
  const item = {
    type: "manipulate",
    body: "a",
    controls: [{ kind: "continuous", name: "a", min: 1, max: 3, initial: "1" }],
    initial: { svg: "<svg/>" },
  };
  const notebook = JSON.parse(
    serialize({
      entries: [
        {
          input: "Manipulate[a, {a, 1, 3}]",
          cellId: "a-b",
          executionCount: 1,
          items: [item],
        },
        {
          input: "Manipulate[a, {a, 1, 3}]",
          cellId: "a_b",
          executionCount: 2,
          items: [item],
        },
      ],
    })
  );
  const models = notebook.metadata.widgets[WoxiWidgets.STATE_MIME].state;
  assert.equal(Object.hasOwn(models, "a-bm0r"), true);
  assert.equal(Object.hasOwn(models, "a_bm0r"), true);
});

test("an output with a null count is evaluated and replayed", () => {
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: "code",
        id: "counted",
        execution_count: 2,
        source: "a = 1",
        outputs: [],
      },
      {
        cell_type: "code",
        id: "null-count",
        execution_count: null,
        source: "x = 1",
        outputs: [
          {
            output_type: "display_data",
            data: { "text/plain": ["1"] },
            metadata: {},
          },
        ],
      },
    ],
  };
  const parsed = parse(JSON.stringify(notebook));
  assert.equal(parsed.entries[1].executionCount, null);
  assert.equal(parsed.entries[1].items.length, 1);
  assert.equal(isEvaluated(parsed.entries[1]), true);
  // The writer will give the null-count cell count 3. The next user evaluation must
  // therefore start above that value.
  assert.equal(parsed.executionCount, undefined);
  assert.equal(executionCountBase(parsed.entries), 3);
});

test("the body reader keeps nested brackets, strings and comments", () => {
  assert.equal(
    WoxiWidgets.manipulateBody("Manipulate[Plot[f[x, 2], {x, 0, 1}], {a, 1, 5}]"),
    "Plot[f[x, 2], {x, 0, 1}]"
  );
  assert.equal(WoxiWidgets.manipulateBody('Manipulate["a,b", {x, 1, 2}]'), '"a,b"');
  assert.equal(
    WoxiWidgets.manipulateBody("Manipulate[f[(* a,b *) x], {x, 1, 2}]"),
    "f[(* a,b *) x]"
  );
  assert.equal(WoxiWidgets.manipulateBody("f[x]"), "");
});

test("a 3D scene round-trips as its own MIME value", () => {
  const plot3d = {
    camera: { az: -1.07, el: 0.63, dist: 6.68, perspective: true },
    ranges: [
      [-1, 1],
      [-1, 1],
      [-1, 1],
    ],
    box: [1, 1, 1],
    vertices: "AAAA",
    indices: "AQID",
    colors: "/////w==",
    lines: "",
    lineColors: "",
    coverage: [
      [-1, 1],
      [-1, 1],
      [-1, 1],
    ],
    card: { width: null, height: null, full: false },
    theme: { background: "#ffffff", axis: [102, 102, 102], label: [102, 102, 102] },
    axes: true,
    boxed: true,
  };
  const text = serialize({
    entries: [
      {
        input: "Plot3D[x, {x, -1, 1}, {y, -1, 1}]",
        executionCount: 1,
        items: [{ type: "graphics", plot3d: plot3d }],
      },
    ],
  });
  const parsed = parse(text);
  assert.equal(parsed.entries[0].items.length, 1);
  assert.deepEqual(parsed.entries[0].items[0].plot3d, plot3d);
  const notebook = JSON.parse(text);
  assert.deepEqual(notebook.cells[0].outputs[0].data["application/vnd.woxi.plot3d"], plot3d);
  assert.equal(notebook.cells[0].outputs[0].data["text/plain"], undefined);
});

test("the file name helpers are stable", () => {
  // `displayTitle` strips the extension, not the directory: it is a label for the notebook.
  assert.equal(displayTitle("/tmp/My Notebook.ipynb"), "/tmp/My Notebook");
  assert.equal(displayTitle("My Notebook.ipynb"), "My Notebook");
  assert.equal(displayTitle(""), "Untitled");
  assert.equal(suggestFileName("A/B: C"), "AB C.ipynb");
  assert.equal(suggestFileName("foo.ipynb"), "foo.ipynb");
  assert.equal(suggestFileName("foo.IPYNB"), "foo.ipynb");
  assert.equal(suggestFileName(""), "Untitled.ipynb");
  const long = "x".repeat(100);
  assert.equal(suggestFileName(long), "x".repeat(60) + ".ipynb");
  const emoji = "\u{1F600}".repeat(100);
  assert.equal(Array.from(suggestFileName(emoji)).length, 60 + ".ipynb".length);
});
