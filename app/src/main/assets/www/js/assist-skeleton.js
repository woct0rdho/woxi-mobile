// The hold gesture's writes: a call with every slot named, wrapping a selection or the
// operand at the caret, and moving the caret to the next argument.

import {
  callArgumentRange,
  identifierEnd,
  matchForward,
  operandAt,
  prefixSpan,
  scanContext,
} from "./assist-scan.js";
import { isIdentifier } from "./assist-shared.js";
import { isCallName } from "./prototypes.js";

const SEPARATOR = ", ";

// Long press on a function button: the call with every slot spelled out
// (`Plot[f, {x, -5, 5}]`). A selection is the first argument and overrides the
// analyzed target. Otherwise the operand that starts at the caret is. With neither,
// the placeholders stay and the first one is selected, so typing replaces it.
//
// A function that takes no arguments cannot wrap anything: the hold falls back to the
// tap (the call itself). Options: `chip` also replaces the partial name before the
// caret. `arity` is what the match list knows. `wrap: false` inserts the placeholders
// only (the sheet's insert skeleton button).
function applySkeleton(head, options) {
  options = options || {};
  const chip = options.chip === true;
  let arity = options.arity;
  const wrap = options.wrap !== false;
  const read = this.sink.read();
  if (!read) return false;
  if (!isIdentifier(head)) return false;
  const info = this.infoOf(head);
  const isOption =
    options.option === true ||
    options.callOption === true ||
    !!(info && (info.option || info.callOption));
  // Only a function can be wrapped: a constant, an option, a literal chip or a session
  // variable keeps its tap meaning. A user-defined function wraps like a builtin.
  if (isOption || !isCallName(head)) return false;
  const type = options.type !== undefined ? options.type : info ? info.type : undefined;
  if (type === "variable" && !this.isDefinedFunction(head)) return false;
  if (arity === undefined && info) arity = info.arity;
  if (arity && arity[1] === 0) {
    this.apply(head, "function");
    return true;
  }
  const code = read.code;
  const selected =
    read.selStart !== undefined && read.selEnd !== undefined && read.selStart !== read.selEnd;
  // A chip accepted on an existing call's head keeps that call. A skeleton would add a
  // second pair of brackets (`Sin[...][x]`). Let the tap handle it instead.
  if (chip && !selected && code.charAt(identifierEnd(code, read.caret)) === "[") return false;
  // A chip always replaces the partial name before the caret, with or without a
  // selection. A pad key leaves the typed text alone. A chip accepted while the caret
  // is inside a name replaces the whole name, not just the part before the caret.
  const prefix = prefixSpan(code, read.caret);
  let from = chip ? prefix.start : read.caret;
  let to = chip ? identifierEnd(code, read.caret) : read.caret;
  let inner = null;
  if (wrap && selected) {
    if (!chip) from = read.selStart;
    to = read.selEnd;
    inner = code.slice(read.selStart, read.selEnd);
  } else if (wrap) {
    const operand = operandAt(code, read.caret);
    if (operand) {
      to = operand.end;
      inner = code.slice(operand.start, operand.end);
    }
  }
  let skeleton = this.skeletonFor(head, inner);
  if (!skeleton) {
    // No slots are known for this head: the call alone still wraps what it was given.
    if (inner === null) return false;
    skeleton = { text: head + "[" + inner + "]", select: null };
  }
  this.sink.replace(from, to, skeleton.text, skeleton.text.length);
  if (skeleton.select) {
    this.sink.select(from + skeleton.select[0], from + skeleton.select[1]);
  }
  return true;
}

// Long press on a suggestion chip: the skeleton, with the partial name replaced.
function wrap(name, arity, type, option, callOption) {
  return this.applySkeleton(name, {
    chip: true,
    arity: arity,
    type: type,
    option: option,
    callOption: callOption,
  });
}

// The skeleton of a call: every non-option slot spelled out. Iterator slots get the
// concrete range the gallery uses, which is the part nobody wants to type. `inner`
// (a selection or the operand at the caret) becomes the first slot, and the call is
// left without a selection because nothing is missing any more.
function skeletonFor(head, inner) {
  const variant = this.variantFor(head, 1);
  if (!variant) return null;
  const slots = [];
  let i;
  let slot;
  for (i = 0; i < variant.length; i += 1) {
    slot = variant[i];
    if (slot.role === "option" || slot.role === "options") continue;
    slots.push(slot);
  }
  if (!slots.length) return null;
  const filled = inner !== null && inner !== undefined;
  const parts = [];
  let offset = head.length + 1;
  let select = null;
  for (i = 0; i < slots.length; i += 1) {
    slot = slots[i];
    let text;
    if (i === 0 && filled) text = inner;
    else if (slot.role === "iterator" && slot.examples.length) text = slot.examples[0];
    else text = slot.text;
    if (i > 0) offset += SEPARATOR.length;
    if (i === 0 && !filled) select = [offset, offset + text.length];
    parts.push(text);
    offset += text.length;
  }
  return { text: head + "[" + parts.join(SEPARATOR) + "]", select: select };
}

function nextSlot() {
  const read = this.sink.read();
  if (!read) return;
  const code = read.code;
  const ctx = scanContext(code, read.caret);
  if (!ctx.call) return;
  const open = ctx.call.open;
  const close = matchForward(code, open);
  // Walk the call's own arguments, not the innermost group's, so a filled iterator or
  // nested list does not trap the caret at its closing brace. `callArgumentRange`
  // already ignores commas inside nested brackets, strings and comments.
  for (let index = 0; index <= ctx.call.args; index += 1) {
    const range = callArgumentRange(code, open, index);
    if (range.missing) break;
    if (read.caret < range.start || read.caret > range.end) continue;
    const next = callArgumentRange(code, open, index + 1);
    if (!next.missing) {
      let at = next.start;
      while (at < code.length && /\s/.test(code.charAt(at))) at += 1;
      this.sink.setCaret(at);
      return;
    }
    if (close >= 0) {
      this.sink.setCaret(close + 1);
      return;
    }
    // The call is not closed yet: start the next argument with a comma, which is the
    // edit the user would have made by hand.
    const before = code.slice(0, read.caret);
    const argument = code.slice(range.start, read.caret);
    if (argument.trim() !== "" && /[^,\s]$/.test(before)) {
      this.sink.replace(read.caret, read.caret, ", ", 2);
    }
    return;
  }
}

export function installSkeleton(Assist) {
  Object.assign(Assist.prototype, {
    applySkeleton,
    wrap,
    skeletonFor,
    nextSlot,
  });
}
