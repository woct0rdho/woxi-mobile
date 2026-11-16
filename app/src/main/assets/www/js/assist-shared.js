// Pure values and helpers shared by the assist modules: protocol limits, key widths
// that more than one row uses, and the small text/identifier helpers. No state, DOM or
// engine access belongs here.

import { argumentEnd, identifierEnd } from "./assist-scan.js";

// The protocol limits below are shared with engine/src/assist/complete.rs and
// prototypes.rs. Change the engine first. The client must not ask for more than it returns.
export const PROTOCOL = {
  variants: 3,
  defaultMatches: 24,
  maxMatches: 200,
  slotExamples: 3,
};

// The candidate/option row never shows more than this many name chips.
export const MAX_CHIPS = 3;

// The action keys shared by every row. A row adds its own keys between Eval and Back.
export const GROW = { call: 0.8, chip: 1.25, more: 0.95, signature: 3 };
export const CALL_KEY = {
  label: "\u2304",
  action: "assist",
  detail: { kind: "call" },
  classes: "fn",
  grow: GROW.call,
  tooltip: "The call card",
};

// The text left in the current argument after the name being typed. An options slot is
// empty before and after the caret. `identifierEnd` skips the rest of a name, and
// `argumentEnd` stops at the argument's own comma or bracket.
export function remainingArgument(code, caret, ctx, typed) {
  return code
    .slice(typed ? identifierEnd(code, caret) : caret, argumentEnd(code, caret, ctx))
    .trim();
}

// Whether `text` is a plain symbol name, the only thing that can become a call. A
// literal (an iterator chip such as `{x, -5, 5}`) is inserted as it is.
export function isIdentifier(text) {
  return /^[A-Za-z$`][A-Za-z0-9$`]*$/.test(text || "");
}
