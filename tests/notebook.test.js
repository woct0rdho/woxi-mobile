// The notebook file format, without the app: a notebook round-trips through nbformat 4 and a
// foreign notebook's code cells survive, while its title and metadata are kept.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  displayTitle,
  NBFORMAT,
  NBFORMAT_MINOR,
  parse,
  serialize,
  suggestFileName,
} from "../app/src/main/assets/www/js/notebook.js";

test("a notebook round-trips through nbformat 4", () => {
  const state = {
    title: "Integration",
    entries: [{ input: "Integrate[x^2, x]" }, { input: "Plot[Sin[x], {x, -5, 5}]" }, { input: "" }],
  };
  const parsed = parse(serialize(state));
  assert.equal(parsed.title, "Integration");
  // Empty cells are not written: a notebook stores code, not blank placeholders.
  assert.deepEqual(
    parsed.entries.map((entry) => entry.input),
    ["Integrate[x^2, x]", "Plot[Sin[x], {x, -5, 5}]"]
  );
  assert.equal(parsed.skippedCells, 0);
});

test("the file is nbformat 4.5 and only code cells are taken", () => {
  const notebook = JSON.parse(serialize({ title: "T", entries: [{ input: "x = 1" }] }));
  assert.equal(notebook.nbformat, NBFORMAT);
  assert.equal(notebook.nbformat_minor, NBFORMAT_MINOR);
  assert.equal(notebook.cells.length, 1);
  assert.equal(notebook.cells[0].cell_type, "code");
  // A markdown cell is not executed. It is reported as skipped.
  notebook.cells.splice(0, 0, { cell_type: "markdown", source: ["# notes"], metadata: {} });
  const parsed = parse(JSON.stringify(notebook));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].input, "x = 1");
  assert.equal(parsed.skippedCells, 1);
});

test("an evaluated entry's engine items become notebook outputs", () => {
  const items = [
    { type: "text", text: "x^3/3", svg: '<svg width="40" height="15"></svg>' },
    { type: "print", text: "hi" },
  ];
  const notebook = JSON.parse(
    serialize({
      title: "T",
      entries: [
        { input: "Integrate[x^2, x]", items: JSON.stringify(items) },
        { input: "not evaluated" },
      ],
    })
  );
  const outputs = notebook.cells[0].outputs;
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0].output_type, "execute_result");
  assert.equal(outputs[0].execution_count, 1);
  assert.deepEqual(outputs[0].data["text/plain"], ["x^3/3"]);
  assert.match(outputs[0].data["image/svg+xml"].join(""), /<svg width="40"/);
  assert.equal(outputs[1].output_type, "stream");
  assert.equal(outputs[1].name, "stdout");
  // A cell that was never evaluated contributes no outputs and no execution count.
  assert.deepEqual(notebook.cells[1].outputs, []);
  assert.equal(notebook.cells[1].execution_count, null);
});

test("the file name helpers are stable", () => {
  // `displayTitle` strips the extension, not the directory: it is a label for the notebook.
  assert.equal(displayTitle("/tmp/My Notebook.ipynb"), "/tmp/My Notebook");
  assert.equal(displayTitle("My Notebook.ipynb"), "My Notebook");
  assert.equal(displayTitle(""), "Untitled");
  assert.equal(suggestFileName("A/B: C"), "AB C.ipynb");
  assert.equal(suggestFileName(""), "Untitled.ipynb");
});
