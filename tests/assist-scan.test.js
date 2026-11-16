// The text scanner behind the input assist, without the controller or the engine:
// brackets, strings, comments and associations must all agree about the argument
// around the caret.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  argumentEnd,
  callArgumentRange,
  closersFor,
  matchForward,
  optionNamesInCall,
  optionRuleAt,
  optionRuleName,
  scanContext,
} from "../app/src/main/assets/www/js/assist-scan.js";

test("a string comma does not split a call argument", () => {
  const code = 'f["a,b", x]';
  const ctx = scanContext(code, code.indexOf("x"));
  assert.equal(ctx.head, "f");
  assert.equal(ctx.argIndex, 1);
});

test("scanContext records an argument start after a string", () => {
  const code = 'f[1, "a,b"]';
  const ctx = scanContext(code, code.indexOf("]"));
  assert.equal(ctx.stack[0].argStart, 4);
});

test("argumentEnd finishes a string before looking for the next delimiter", () => {
  const code = 'f[1, "a,b"]';
  assert.equal(argumentEnd(code, code.indexOf("b")), code.indexOf("]"));
});

test("associations own commas like lists", () => {
  const code = "f[<|a -> 1, b -> 2|>, x]";
  const ctx = scanContext(code, code.indexOf("x"));
  assert.equal(ctx.argIndex, 1);
});

test("an unfinished association is closed with |>", () => {
  assert.equal(closersFor("<|a -> 1", 8), "|>");
  assert.equal(closersFor("Plot[<|a -> 1", 14), "|>]");
});

test("options are read only at the call's top level", () => {
  const code = "Show[Plot[Sin[x], {x, 0, 1}, Epilog -> {Frame -> True}], Axes -> False]";
  const show = code.indexOf("[");
  const plot = code.indexOf("[", code.indexOf("Plot") + 1);
  assert.deepEqual(Object.keys(optionNamesInCall(code, show)).sort(), ["Axes"]);
  assert.deepEqual(Object.keys(optionNamesInCall(code, plot)).sort(), ["Epilog"]);
});

test("an options list contributes only its top-level rule names", () => {
  const code =
    "Plot[Sin[x], {x, 0, 1}, {Frame -> True, Epilog -> {GridLines -> Automatic, Axes -> False}}]";
  assert.deepEqual(Object.keys(optionNamesInCall(code, code.indexOf("["))).sort(), [
    "Epilog",
    "Frame",
  ]);
});

test("an option value list stays in one call argument", () => {
  const code = "Plot[Sin[x], {x, 0, 1}, Frame -> {1, ";
  const open = code.indexOf("[");
  assert.equal(optionRuleAt(code, open, code.length).option, "Frame");
  assert.equal(optionRuleAt(code, open, code.length).value.trim(), "{1,");
});

test("matchForward counts every nested bracket type", () => {
  const code = "f[{a, [b, c]}, d]";
  const open = code.indexOf("[");
  assert.equal(matchForward(code, open), code.lastIndexOf("]"));
});

test("an association argument starts after its own last comma", () => {
  const code = "f[<|a -> 1, ";
  const ctx = scanContext(code, code.length);
  assert.equal(ctx.stack[ctx.stack.length - 1].argStart, code.indexOf(",") + 1);
});

test("a rule value is not an option position", () => {
  const code = "Plot[Sin[x], {x, 0, 1}, Frame -> {";
  const open = code.indexOf("[");
  assert.equal(optionRuleAt(code, open, code.length).value.trim(), "{");
});

test("an option name with a context mark is read the same way everywhere", () => {
  assert.equal(optionRuleName("Ctx`Frame -> True"), "Ctx`Frame");
  assert.equal(optionRuleName("Frame :> True"), "Frame");
  assert.equal(optionRuleName("x -> x0"), "x");
});

test("callArgumentRange keeps a nested value list in one argument", () => {
  const code = "Plot[Sin[x], {x, 0, 1}]";
  const open = code.indexOf("[");
  const first = callArgumentRange(code, open, 0);
  const second = callArgumentRange(code, open, 1);
  const missing = callArgumentRange(code, open, 2);
  assert.equal(code.slice(first.start, first.end).trim(), "Sin[x]");
  assert.equal(code.slice(second.start, second.end).trim(), "{x, 0, 1}");
  assert.equal(missing.missing, true);
  assert.equal(missing.start, code.lastIndexOf("]"));
});
