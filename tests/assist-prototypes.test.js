// Slot roles are presentation data, but the wrong role changes what the skeleton and
// the call card insert. `Limit`'s `x -> x0` is a positional rule, not an option.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  curatedVariant,
  isCallName,
  iteratorExamples,
} from "../app/src/main/assets/www/js/prototypes.js";

test("a positional rule stays in the skeleton", () => {
  const slots = curatedVariant("f, x -> x0");
  assert.deepEqual(
    slots.map((slot) => [slot.role, slot.text]),
    [
      ["expression", "f"],
      ["expression", "x -> x0"],
    ]
  );
  assert.deepEqual(slots[1].examples, ["x -> x0"]);
});

test("an option name is still classified as an option", () => {
  const slots = curatedVariant("expr, opts");
  assert.equal(slots[1].role, "options");
});

test("a table-less implemented function is still a call", () => {
  for (const name of ["Print", "Show", "Directive", "Manipulate"]) {
    assert.equal(isCallName(name, "function"), true, name);
  }
});

test("known value symbols stay bare", () => {
  for (const name of ["Full", "Center", "Top", "TraditionalForm", "Pi", "True"]) {
    assert.equal(isCallName(name, "function"), false, name);
  }
});

test("iterator examples follow the slot variable", () => {
  assert.deepEqual(iteratorExamples("i"), ["{i, -5, 5}", "{i, 0, 2 Pi}"]);
  assert.deepEqual(iteratorExamples(""), ["{x, -5, 5}", "{x, 0, 2 Pi}"]);
});
