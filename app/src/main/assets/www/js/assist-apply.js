// Applying a chip or option: where the name replaces the text, whether it becomes a call
// or a rule, and how an option is appended to the call's options region.

import { identifierEnd, matchForward, prefixSpan } from "./assist-scan.js";
import { isIdentifier, remainingArgument } from "./assist-shared.js";
import { isCallName, OPTION_ARROW } from "./prototypes.js";

// The symbol the caret is on or right after, which is what go to definition acts on.
function symbolAtCaret() {
  const read = this.sink.read();
  if (!read) return "";
  const code = read.code;
  const start = prefixSpan(code, read.caret).start;
  const end = identifierEnd(code, read.caret);
  const name = code.slice(start, end);
  return /^[A-Za-z$`][A-Za-z0-9$`]*$/.test(name) ? name : "";
}

// Whether a session symbol is a function definition rather than a variable: those wrap
// like builtins do, a plain variable is a value.
function isDefinedFunction(name) {
  for (let i = 0; i < this.definitions.length; i += 1) {
    const definition = this.definitions[i];
    if (definition.name === name && definition.kind === "function") return true;
  }
  return false;
}

// A call-card option inserts where an option belongs, not where the caret happens to
// be: an option written in the first positional argument would corrupt it. When the
// caret is already in the options region, use the normal chip insertion. Otherwise
// append `Name -> ` to the end of the call.
function applyOption(name) {
  const read = this.sink.read();
  if (!read) return;
  const context = this.contextFor(read);
  if (context.optionPrefix) {
    this.apply(name, undefined, { callOption: true });
    return;
  }
  if (!context.ctx.call) {
    // The call card belonged to a call the user has since left or deleted. There is no
    // options region to append to. Close the sheet rather than writing a rule at an
    // unrelated caret.
    this.closeSheet();
    return;
  }
  const code = read.code;
  const open = context.ctx.call.open;
  const close = matchForward(code, open);
  const at = close >= 0 ? close : code.length;
  const inside = code.slice(open + 1, at).trim();
  const before = code.slice(0, at).trimEnd();
  let text = name + OPTION_ARROW;
  if (inside && !/,$/.test(before)) text = ", " + text;
  else if (inside && /,$/.test(before)) text = " " + text;
  this.sink.replace(at, at, text, text.length);
  if (this.sheetOpen) this.closeSheet();
}

// Short press on a function button: the call with an empty argument list and the caret
// inside (`Integrate[]`, caret between the brackets). Accepting a chip replaces the
// name being typed, and the selection when there is one. A pad key only replaces the
// selection. A name that stands for a value (`Pi`, a session variable, `$Name`, an
// option symbol such as `Axes`) arrives as just itself. An option of the call the caret
// is in arrives with its arrow (`Axes -> `), the same edit the options row makes.
function apply(name, type, detail) {
  const read = this.sink.read();
  if (!read) return;
  const code = read.code;
  const selected =
    read.selStart !== undefined && read.selEnd !== undefined && read.selStart !== read.selEnd;
  let start = prefixSpan(code, read.caret).start;
  let end = selected ? read.selEnd : identifierEnd(code, read.caret);
  const context = this.contextFor(read);
  // A chip that is a whole value (`{x, -5, 5}`) fills the empty argument it is offered
  // for: with the caret between the braces of `{}`, inserting it there would leave
  // `{{x, -5, 5}}`. The pair is empty by the iterator row's definition, so its closing
  // brace is the first one after the opening.
  if (!selected && name.charAt(0) === "{") {
    if (context.state === "iterator" && context.ctx.open) {
      start = context.ctx.open.open;
      const close = matchForward(code, start);
      if (close >= 0) end = close + 1;
    }
  }
  const info = this.infoOf(name);
  if (type === undefined) type = info ? info.type : undefined;
  if (type === "variable" && this.isDefinedFunction(name)) type = "function";
  const flags = detail || info || {};
  let callOption = flags.callOption === true;
  // In an options position a name the call declares is the left side of a rule, even
  // when it arrived without a candidate detail (a pad key or the test hook). The
  // argument must be only the option prefix. `1 + Ax` is an expression, not an option.
  if (!callOption && context.optionPrefix) {
    if (flags.option === true) {
      // The caret is in the options region and the chip is a global option symbol.
      // Woxi may not declare the call's options (Plot3D, ContourPlot), but the name is
      // still the left side of a rule here. Insert the arrow rather than a bare name.
      callOption = true;
    } else {
      const cached = context.ctx.head ? this.inspectionOf(context.ctx.head) : null;
      if (cached && cached.optionNames.has(name)) callOption = true;
    }
  }
  // Do not add a second arrow to an option that already has one after the name. The
  // options row is only shown for an empty slot now, but a chip can still be applied
  // after the caret moved into an existing rule. Replacing the name must preserve it.
  if (callOption) {
    const typed = code.slice(start, read.caret);
    const rest = context.ctx ? remainingArgument(code, read.caret, context.ctx, typed) : "";
    if (rest !== "") callOption = false;
  }
  let insert;
  let after;
  if (callOption) {
    // The caret is in this call's options region: the name is the left side of a rule.
    insert = name + OPTION_ARROW;
    after = insert.length;
  } else {
    const option = flags.option === true;
    // Values are an explicit list, not "any name Woxi has no arity for": Woxi also
    // leaves the arity unknown for callable heads such as `Print`, `Show`, `Directive`
    // and `Manipulate`.
    const call = isIdentifier(name) && !option && isCallName(name, type);
    const existingCall = !selected && code.charAt(end) === "[";
    const zeroArgs = call && Array.isArray(flags.arity) && flags.arity[1] === 0;
    // A name that already heads a call keeps that call's brackets: completing `Sin`
    // inside `Sin[x]` must not turn it into `Sin[][x]`.
    insert = call && !existingCall ? name + "[]" : name;
    after = insert.length - (call && !existingCall && !zeroArgs ? 1 : 0);
  }
  this.sink.replace(start, end, insert, after);
  if (this.sheetOpen) this.closeSheet();
}

// What the current match list knows about a name (`function`/`variable`, arity), or
// null when it is not in the list (a pad key, an example, the sheet).
function infoOf(name) {
  const candidates = this.candidates;
  const names = candidates && candidates.names ? candidates.names : [];
  const details = candidates && candidates.details ? candidates.details : [];
  const at = names.indexOf(name);
  if (at < 0 || !details[at]) return null;
  return details[at];
}

export function installApply(Assist) {
  Object.assign(Assist.prototype, {
    symbolAtCaret,
    isDefinedFunction,
    applyOption,
    apply,
    infoOf,
  });
}
