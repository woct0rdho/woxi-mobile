// The caret's context: which call it is in, which variant applies, whether the slot is
// an option/iterator/signature, and the option names already used by the call. This is
// the decision core. `contextFor` is the one function that chooses a bar state.

import {
  callArgumentRange,
  matchForward,
  optionNamesInCall,
  optionRuleAt,
  optionRuleName,
  prefixSpan,
  scanContext,
} from "./assist-scan.js";
import { PROTOCOL, remainingArgument } from "./assist-shared.js";
import { curatedVariants } from "./prototypes.js";

const MAX_VARIANTS = PROTOCOL.variants;
const MAX_SLOT_EXAMPLES = PROTOCOL.slotExamples;
// With an open-ended arity, Woxi only says where the required arguments end, not
// where the options begin. Require this many arguments before an empty argument is
// read as an option slot. Curated slots and an explicit option prefix stay precise.
const MIN_ARGS_BEFORE_OPTIONS = 3;

// Whether an argument index is past a call's declared arguments. A finite maximum is
// exact. An open-ended arity only says where the required arguments end, not where the
// options begin (DSolve accepts one or more equations, then two positional arguments), so
// be conservative there. Curated slots and an option prefix remain the precise paths.
// A head with no declared arity must also have at least a few arguments before an empty
// argument is read as an option slot.
function afterDeclaredArguments(arity, argIndex) {
  if (!arity) return argIndex >= MIN_ARGS_BEFORE_OPTIONS;
  const min = arity[0];
  const max = arity[1];
  if (max === null || max === undefined) {
    return argIndex >= Math.max(min, MIN_ARGS_BEFORE_OPTIONS);
  }
  return argIndex >= max;
}

function ensurePrototypes() {
  const self = this;
  if (this.learnedAsked || !this.query) return;
  const examples = (this.sink.templates ? this.sink.templates() : []).map(function (template) {
    return template.insert;
  });
  if (!examples.length) return;
  this.learnedAsked = true;
  this.query("prototypes_request", { examples: examples }).then(
    function (reply) {
      if (!reply || reply.status !== "ok" || !reply.content || !reply.content.heads) {
        self.learnedAsked = false;
        return;
      }
      self.learned = Object.assign(Object.create(null), reply.content.heads || {});
      self.variantCache = Object.create(null);
      // A call drawn before the answer arrived now has more slots to show, and the
      // options-position decision may have changed for a cached prefix. `refreshBar`
      // repaints non-candidate rows. A candidate list has to be requested again with
      // the new context before it can be shown.
      self.clearMatchCache();
      if (self.keyboard) self.refreshBar();
      self.requestCurrentMatches();
    },
    function () {
      self.learnedAsked = false;
    }
  );
}

function variantsOf(head) {
  if (!head) return null;
  const cached = this.variantCache[head];
  if (cached !== undefined) return cached;
  const base = curatedVariants(head);
  const variants = base ? base.slice() : [];
  const learned = this.learned[head] || [];
  for (let i = 0; i < learned.length; i += 1) {
    const slots = (learned[i].slots || []).map(function (slot) {
      return {
        text: slot.name,
        role: slot.role,
        examples: (slot.examples || []).slice(),
      };
    });
    if (!slots.length) continue;
    let match = -1;
    for (let j = 0; j < variants.length; j += 1) {
      if (variants[j].length !== slots.length) continue;
      let same = true;
      for (let k = 0; k < slots.length; k += 1) {
        if (variants[j][k].role !== slots[k].role) {
          same = false;
          break;
        }
      }
      if (same) {
        match = j;
        break;
      }
    }
    if (match >= 0) {
      // Keep the curated names, take the examples the examples actually use. The
      // curated slots are shared, so merge into a copy rather than mutating them.
      const merged = variants[match].map(function (slot) {
        return { text: slot.text, role: slot.role, examples: slot.examples.slice() };
      });
      for (let s = 0; s < slots.length; s += 1) {
        if (!slots[s].examples.length) continue;
        const examples = slots[s].examples.concat(
          merged[s].examples.filter(function (example) {
            return slots[s].examples.indexOf(example) < 0;
          })
        );
        merged[s].examples = examples.slice(0, MAX_SLOT_EXAMPLES);
      }
      variants[match] = merged;
    } else if (variants.length < MAX_VARIANTS) {
      variants.push(slots);
    }
  }
  const result = variants.length ? variants : null;
  this.variantCache[head] = result;
  return result;
}

function variantKey(head) {
  const entry = this.sink.entryKey ? this.sink.entryKey() : null;
  return head + "@" + (entry === null || entry === undefined ? "?" : entry);
}

function variantFor(head, args, variants) {
  variants = variants || this.variantsOf(head);
  if (!variants) return null;
  const chosen = this.variantChoice[this.variantKey(head)];
  if (chosen !== undefined && variants[chosen]) return variants[chosen];
  // The variant whose slots the call has reached: the largest one that still fits,
  // else the smallest. `args` is the positional argument count. The option rules were
  // already removed by `positionalArgumentCount`, so they do not pick a variant.
  let best = null;
  let smallest = null;
  for (let i = 0; i < variants.length; i += 1) {
    const size = variants[i].length;
    if (size <= args && (!best || size > best.length)) best = variants[i];
    if (!smallest || size < smallest.length) smallest = variants[i];
  }
  return best || smallest;
}

// The number of positional arguments in the call the caret is in, ignoring the option
// rules and the empty argument being typed. Variant choice must not let an option turn a
// two-argument form into a larger overload (`Solve[x^2 == 1, x, |]` is the options
// slot, not the three-argument `domain` form).
function positionalArgumentCount(code, ctx) {
  if (!ctx.call) return 0;
  const inspected = this.inspectionOf(ctx.head);
  const names = inspected ? inspected.optionNames : null;
  let count = 0;
  for (let index = 0; index < ctx.call.args; index += 1) {
    const range = callArgumentRange(code, ctx.call.open, index);
    const argument = code.slice(range.start, range.end).trim();
    if (!argument) continue;
    const rule = optionRuleName(argument);
    if (rule && (names ? names.has(rule) : /^[A-Z]/.test(rule))) continue;
    count += 1;
  }
  return count;
}

// The call whose options are being typed, when the caret's argument is only an option
// prefix: the completion ranks that call's options first, and the ones the call already
// names below the ones it does not. `optionsInCall` is the same reader the options row
// uses to avoid offering an option twice.
function optionsContext(info, read) {
  if (!info.optionPrefix || !info.ctx.head || !info.ctx.call) return null;
  // Sorted so the same call always makes the same request (and cache key).
  const used = Object.keys(this.optionsInCall(read.code, info.ctx)).sort();
  return { head: info.ctx.head, used: used };
}

// Options already written in the call, so the chips do not offer them twice.
function optionsInCall(code, ctx) {
  return ctx.call ? optionNamesInCall(code, ctx.call.open) : {};
}

// The one place that decides which state the bar should be in. `refresh` fills that state
// with requests, `refreshBar` refills it from what is already cached (a warning that arrives
// later must not turn an iterator row or an option row back into the bare signature), and a
// late answer is only applied while the context still asks for it.
//
// The order is the priority: a name being typed is always a completion (`Fra` in a call's
// options slot is the symbol, not a row of options), then an argument that is only an
// option prefix is the options slot, then an empty iterator `{}`, then the signature.
function contextFor(read) {
  const code = read.code;
  const caret = read.caret;
  const ctx = scanContext(code, caret);
  const span = prefixSpan(code, caret);
  const variant = this.variantFor(ctx.head, this.positionalArgumentCount(code, ctx));
  const past = !!(ctx.head && variant && ctx.argIndex >= variant.length);
  const slot =
    ctx.head && variant && !past ? variant[Math.min(ctx.argIndex, variant.length - 1)] : null;
  const argStart = ctx.call ? ctx.call.argStart : 0;
  // The iterator row is only for the iterator slot's own empty pair. A filled pair, an
  // empty `{}` at the start of a filled iterator, or an empty list nested inside one is
  // an argument being edited, not a slot waiting for a value.
  const open = ctx.open && ctx.open.ch === "{" ? ctx.open.open : -1;
  const close = open >= 0 ? matchForward(code, open) : -1;
  const iterator =
    slot &&
    slot.role === "iterator" &&
    close >= 0 &&
    code.slice(argStart, open).trim() === "" &&
    code.slice(open + 1, close).trim() === "" &&
    /^\s*(?:[,\]]|$)/.test(code.slice(close + 1))
      ? slot
      : null;
  const argument = ctx.call ? code.slice(argStart, caret) : "";
  // A rule at the start of the current argument is a value position, not another
  // option: `Frame -> {1, |}` must not fall through to the options row. A member of
  // the value can still be a name (`Frame -> T` completes), but a delimiter, a sign
  // or a number means the caret is editing a value, so the bar stays idle.
  const rule = ctx.call ? optionRuleAt(code, ctx.call.open, caret, ctx) : null;
  const callOptions = ctx.head ? this.optionsOf(ctx.head) : null;
  // Curated slots are the normal source of an options position. A head without one can
  // still declare options. Its arity and defaults are fetched by `ensureCallMeta`.
  const metaOptions = !!(
    !variant &&
    ctx.head &&
    callOptions &&
    callOptions.length &&
    afterDeclaredArguments(this.callArityOf(ctx.head), ctx.argIndex)
  );
  const inOptions = !!(past || (slot && slot.role === "options") || metaOptions);
  const prefixOffset = span.start - argStart;
  const beforePrefix = prefixOffset >= 0 ? argument.slice(0, prefixOffset) : argument;
  // An options row belongs to an argument that only holds the option name being typed
  // (or nothing). `Plot[..., 1 + |]` is an expression in the options position, not a
  // new option, and a numeric literal is not an option prefix either. The rest of the
  // argument matters too: a caret at the start of an existing option (`|Frame -> True`)
  // or of a value (`|1`) is not the empty options slot. `identifierEnd` skips the rest
  // of the name being typed. `argumentEnd` stops at this argument's comma or bracket.
  const optionStart =
    inOptions &&
    !rule &&
    beforePrefix.trim() === "" &&
    (span.text === "" || /^[A-Za-z$`]/.test(span.text));
  const optionPrefix = optionStart && remainingArgument(code, caret, ctx, span.text) === "";
  let state = "idle";
  if (ctx.inString || ctx.commentDepth > 0) state = "idle";
  else if (rule) {
    state = rule.value.trim() !== "" && /^[A-Za-z$`]/.test(span.text) ? "candidates" : "idle";
  } else if (/(?:->|:>)\s*$/.test(code.slice(0, caret))) state = "idle";
  else if (/^[A-Za-z$`]/.test(span.text)) state = "candidates";
  else if (optionPrefix) state = "options";
  else if (iterator) state = "iterator";
  else if (ctx.head && variant) state = "signature";
  return {
    ctx: ctx,
    span: span,
    variant: variant,
    optionPrefix: optionPrefix,
    iterator: iterator,
    state: state,
  };
}

export function installContext(Assist) {
  Object.assign(Assist.prototype, {
    ensurePrototypes,
    variantsOf,
    variantKey,
    variantFor,
    positionalArgumentCount,
    optionsContext,
    optionsInCall,
    contextFor,
  });
}
