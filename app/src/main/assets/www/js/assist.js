// Typing assistance: the context bar above the keys, and the sheet it expands into.
//
// One row, one state. The bar answers "what can go here" while the caret is in a call
// (signature, iterator, options), "what is this name" while a name is being typed
// (candidates, with implementation status), and "what is wrong" when the engine found
// something (issues). Everything else lives in the sheet.
//
// The engine answers over Jupyter-shaped messages: `complete_request`,
// `inspect_request`, `is_complete_request`, `diagnostics_request`,
// `prototypes_request`, `definitions_request`, plus the `catalog_request` extension.
// None of them evaluates the entry. Slot names and roles are the one thing the engine
// cannot know (Wolfram has no usage patterns in Woxi's registry), so they are curated
// here and enriched with what `prototypes_request` learns from the shipped examples.

import {
  argumentStart,
  escapeHtml,
  nextSlotCaret,
  operandAt,
  prefixSpan,
  scanContext,
} from "./assist-scan.js";
import * as WoxiPrototypes from "./prototypes.js";

const BAR_PAGE = 0;
const MAX_CHIPS = 3;
const MATCH_LIMIT = 24;
const SHEET_LIMIT = 200;
const DEBOUNCE_MS = 50;
const DEFINITIONS_MS = 400;
const DIAGNOSTICS_MS = 350;
const OPTION_CACHE_MAX = 40;

// The curated table and the slot-role helpers live in prototypes.js: presentation
// data, not controller state.
const curated = WoxiPrototypes;
const PROTOTYPES = curated.PROTOTYPES;
const STATUS_LABEL = curated.STATUS_LABEL;
const slotsOf = curated.slotsOf;
const iteratorVariable = curated.iteratorVariable;
const curatedVariant = curated.curatedVariant;
const isCallName = curated.isCallName;

// the assist controller

function Assist(sink) {
  this.sink = sink; // {read, replace, setCaret, select, evaluate, templates, entryId, codes}
  this.keyboard = null;
  this.query = null;
  this.seq = 0;
  this.timer = null;
  this.prefix = "";
  this.matches = { names: [], details: [], total: 0, start: 0, end: 0 };
  this.state = "idle";
  this.options = {}; // call head -> [{name, default}]
  this.optionOrder = [];
  this.optionHead = "";
  this.sheetTab = "matches";
  this.sheetOpen = false;
  this.cache = {};
  this.about = null;
  this.catalog = null;
  this.catalogAsked = false;
  this.dom = null;
  this.keysSignature = "";
  this.learned = {}; // head -> [variant] from the engine
  this.learnedAsked = false;
  this.definitions = []; // [{entry, name, params, start, end}]
  this.definitionsAsked = "";
  this.definitionsTimer = null;
  this.issues = [];
  this.issuesText = "";
  this.diagnosticsTimer = null;
  this.variantChoice = {}; // head -> index chosen in the call card
  this.errors = 0;
}

Assist.prototype.bind = function (keyboard, query) {
  this.keyboard = keyboard;
  this.query = query;
  this.buildSheet();
  this.ensureCatalog();
  this.ensurePrototypes();
};

// How much is indexed, for the empty sheet. One request per session, and only when
// the sheet is opened for the first time (the engine may not exist yet at bind time).
Assist.prototype.ensureCatalog = function () {
  const self = this;
  if (this.catalog || this.catalogAsked || !this.query) return;
  this.catalogAsked = true;
  this.query("catalog_request", {}).then(
    function (reply) {
      if (reply && reply.status === "ok" && reply.content) self.catalog = reply.content;
      if (self.sheetOpen) self.renderSheet();
    },
    function () {
      self.catalogAsked = false;
    }
  );
};

// bar

Assist.prototype.idleKeys = function (extra) {
  const keys = [
    { label: "Eval", action: "enter", classes: "ok", grow: 1.2, tooltip: "Evaluate this entry" },
    { label: "Plot", insert: "Plot[|]", classes: "fn", tooltip: "Plot[...] - hold for a skeleton" },
    {
      label: "Solve",
      insert: "Solve[|]",
      classes: "fn",
      tooltip: "Solve[...] - hold for a skeleton",
    },
  ];
  return keys.concat(extra || [], [
    { label: "\u2190", action: "back", classes: "danger", grow: 0.9, tooltip: "Backspace" },
  ]);
};

/**
 * @param {import('./types.js').KeySpec[]} keys
 */
Assist.prototype.setKeys = function (keys) {
  if (!this.keyboard) return;
  // Re-rendering replaces the buttons, and a button that disappears under a finger
  // never fires its click. Refreshes happen on every keystroke and caret move, so
  // identical key lists must leave the bar alone.
  const signature = keys
    .map(function (key) {
      return (
        key.label +
        "|" +
        (key.html || "") +
        "|" +
        (key.detail ? key.detail.name || key.detail.kind : "") +
        "|" +
        (key.classes || "")
      );
    })
    .join(";");
  if (signature === this.keysSignature) return;
  this.keysSignature = signature;
  this.keyboard.setBarKeys(BAR_PAGE, keys);
};

// The warning chip is the only thing that turns amber, and it is offered only when
// the engine found something in finished input.
Assist.prototype.issueKeys = function () {
  if (!this.issues.length) return [];
  return [
    {
      label: "\u26A0 " + this.issues.length,
      action: "assist",
      detail: { kind: "issues" },
      classes: "fn warn",
      grow: 0.9,
      tooltip: this.issues.length === 1 ? "1 problem" : this.issues.length + " problems",
    },
  ];
};

Assist.prototype.renderIdle = function (extra) {
  this.state = "idle";
  this.prefix = "";
  this.matches = { names: [], details: [], total: 0, start: 0, end: 0 };
  this.setKeys(this.idleKeys(extra));
};

// Completion applies here but has nothing to offer: the bar shows the default action
// keys, the same ones the idle state uses.
Assist.prototype.renderNoMatches = function () {
  this.renderIdle(this.issueKeys());
};

Assist.prototype.renderSignature = function (variant, active, extra) {
  this.state = "signature";
  this.prefix = "";
  let html = "";
  for (let i = 0; i < variant.length; i += 1) {
    if (i > 0) html += '<span class="woxi-sig-sep">, </span>';
    html +=
      '<span class="woxi-sig' +
      (i === active ? " woxi-sig-on" : "") +
      '">' +
      escapeHtml(variant[i].text) +
      "</span>";
  }
  const number = Math.min(active + 1, variant.length);
  /** @type {import('./types.js').KeySpec[]} */
  const keys = [
    { label: "Eval", action: "enter", classes: "ok", grow: 1.1, tooltip: "Evaluate this entry" },
    {
      label: "signature",
      html: html,
      action: "assist",
      detail: { kind: "next" },
      classes: "sig",
      grow: 3,
      tooltip: "Tap to move to the next argument",
    },
    ...(extra || []),
    {
      label: number + "/" + variant.length + " \u25BE",
      action: "assist",
      detail: { kind: "call" },
      classes: "fn",
      grow: 0.9,
      tooltip: "Argument " + number + " of " + variant.length + ": the call card",
    },
    { label: "\u2190", action: "back", classes: "danger", grow: 0.8, tooltip: "Backspace" },
  ];
  this.setKeys(keys);
};

Assist.prototype.showIterator = function (slot, extra) {
  const variable = iteratorVariable(slot.text) || "x";
  this.state = "iterator";
  this.prefix = "";
  const keys = [
    { label: "Eval", action: "enter", classes: "ok", grow: 1.1, tooltip: "Evaluate this entry" },
  ];
  for (let i = 0; i < 2; i += 1) {
    const text = "{" + variable + ", " + (i === 0 ? "-5, 5" : "0, 2 Pi") + "}";
    keys.push({
      label: text,
      action: "assist",
      detail: { kind: "accept", name: text },
      classes: "fn chip",
      grow: 1.6,
      tooltip: "Iterate " + variable + " over " + (i === 0 ? "-5 to 5" : "0 to 2 Pi"),
    });
  }
  this.setKeys(
    keys.concat(extra || [], [
      { label: "\u2190", action: "back", classes: "danger", grow: 0.8, tooltip: "Backspace" },
    ])
  );
};

// refresh

Assist.prototype.refresh = function () {
  const read = this.sink.read();
  if (!read) {
    if (this.sheetOpen) this.closeSheet();
    this.renderIdle([]);
    return;
  }
  this.read = read;
  this.scheduleDefinitions();
  this.scheduleDiagnostics(read.code);
  const extra = this.issueKeys();
  const info = this.contextFor(read);
  if (info.state === "candidates") {
    this.requestMatches(info.span.text);
    return;
  }
  if (info.state === "options") {
    this.showOptions(info.ctx.head, extra);
    return;
  }
  if (info.state === "iterator") {
    this.showIterator(info.iterator, extra);
    return;
  }
  if (info.state === "signature") {
    this.renderSignature(info.variant, Math.min(info.ctx.argIndex, info.variant.length - 1), extra);
    return;
  }
  this.renderIdle(extra);
};

// The one place that decides which state the bar should be in. `refresh` fills that state
// with requests, `refreshBar` refills it from what is already cached (a warning that arrives
// later must not turn an iterator row or an option row back into the bare signature), and a
// late answer is only applied while the context still asks for it.
//
// The order is the priority: a name being typed is always a completion (`Fra` in a call's
// options slot is the symbol, not a row of options), then an empty argument past the last
// declared one is the options slot, then an empty iterator `{}`, then the signature.
Assist.prototype.contextFor = function (read) {
  const code = read.code;
  const caret = read.caret;
  const ctx = scanContext(code, caret);
  const span = prefixSpan(code, caret);
  const variant = this.variantFor(ctx.head, ctx.argIndex + 1);
  const past = !!(ctx.head && variant && ctx.argIndex >= variant.length);
  const slot =
    ctx.head && variant && !past ? variant[Math.min(ctx.argIndex, variant.length - 1)] : null;
  // An empty iterator argument (`{`) is the other thing a keyboard key cannot spell in
  // one tap. Once it has content the caret is editing that argument, and a chip would
  // splice a second `{x, ...}` into it.
  const iterator =
    slot &&
    slot.role === "iterator" &&
    ctx.open &&
    ctx.open.ch === "{" &&
    code.slice(ctx.open.open + 1, caret).trim() === ""
      ? slot
      : null;
  let state = "idle";
  if (ctx.inString || ctx.commentDepth > 0) state = "idle";
  // A value after `->` is data, not a symbol name.
  else if (/->\s*$/.test(code.slice(0, caret))) state = "idle";
  else if (/^[A-Za-z$`]/.test(span.text)) state = "candidates";
  else if (past) state = "options";
  else if (iterator) state = "iterator";
  else if (ctx.head && variant) state = "signature";
  return {
    ctx: ctx,
    span: span,
    variant: variant,
    past: past,
    iterator: iterator,
    state: state,
  };
};

// prototypes

Assist.prototype.ensurePrototypes = function () {
  const self = this;
  if (this.learnedAsked || !this.query) return;
  this.learnedAsked = true;
  const examples = (this.sink.templates ? this.sink.templates() : []).map(function (template) {
    return template.insert;
  });
  if (!examples.length) return;
  this.query("prototypes_request", { examples: examples }).then(
    function (reply) {
      if (reply && reply.status === "ok" && reply.content && reply.content.heads) {
        self.learned = reply.content.heads;
      }
    },
    function () {
      self.learnedAsked = false;
    }
  );
};

Assist.prototype.variantsOf = function (head) {
  if (!head) return null;
  const variants = PROTOTYPES[head]
    ? (typeof PROTOTYPES[head] === "string" ? [PROTOTYPES[head]] : PROTOTYPES[head]).map(
        curatedVariant
      )
    : [];
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
    let match = null;
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
        match = variants[j];
        break;
      }
    }
    if (match) {
      // Keep the curated names, take the examples the examples actually use.
      for (let s = 0; s < slots.length; s += 1) {
        if (!slots[s].examples.length) continue;
        const merged = slots[s].examples.concat(
          match[s].examples.filter(function (example) {
            return slots[s].examples.indexOf(example) < 0;
          })
        );
        match[s].examples = merged.slice(0, 4);
      }
    } else if (variants.length < 3) {
      variants.push(slots);
    }
  }
  return variants.length ? variants : null;
};

Assist.prototype.variantFor = function (head, args) {
  const variants = this.variantsOf(head);
  if (!variants) return null;
  const chosen = this.variantChoice[head];
  if (chosen !== undefined && variants[chosen]) return variants[chosen];
  // The variant whose slots the call has reached: the largest one that still fits,
  // else the smallest. Extra arguments are options, so they do not pick a variant.
  let best = null;
  let smallest = null;
  for (let i = 0; i < variants.length; i += 1) {
    const size = variants[i].length;
    if (size <= args && (!best || size > best.length)) best = variants[i];
    if (!smallest || size < smallest.length) smallest = variants[i];
  }
  return best || smallest;
};

// suggestions

Assist.prototype.requestMatches = function (prefix) {
  const self = this;
  // Set here, not in `fetchMatches`: a cached answer is still an answer for this prefix.
  this.prefix = prefix;
  const limit = this.sheetOpen ? SHEET_LIMIT : MATCH_LIMIT;
  const key = prefix + "@" + limit;
  const cached = this.cache[key];
  if (cached) {
    if (!cached.names.length) {
      this.renderNoMatches();
      return;
    }
    this.matches = cached;
    this.state = "candidates";
    if (this.sheetOpen) this.renderSheet();
    this.setKeys(this.chipKeys(cached.names, cached.details, cached.total));
    return;
  }
  if (this.timer) window.clearTimeout(this.timer);
  // The reply must describe the text the prefix came from. A caret drag moves the
  // caret while the request waits out the debounce, so the caret is captured here
  // rather than read again when the request finally goes out.
  const read = this.read || {};
  const code = read.code || "";
  const caret = read.caret || 0;
  this.timer = window.setTimeout(function () {
    self.timer = null;
    self.fetchMatches(prefix, limit, code, caret);
  }, DEBOUNCE_MS);
};

Assist.prototype.fetchMatches = function (prefix, limit, code, caret) {
  const self = this;
  if (!this.query) return;
  const seq = ++this.seq;
  this.prefix = prefix;
  this.query("complete_request", { code: code, cursor_pos: caret, limit: limit }).then(
    function (reply) {
      if (seq !== self.seq || !reply || reply.status !== "ok") return;
      // The caret can move to another context while the answer is on its way (into an
      // empty iterator, or onto the options slot). A list for a prefix that is no longer
      // before the caret would paint the wrong state over the right one.
      const now = self.sink.read();
      if (!now || prefixSpan(now.code, now.caret).text !== prefix) return;
      const content = reply.content || {};
      const names = content.matches || [];
      const meta = content.metadata || {};
      const types = meta._jupyter_types_experimental || [];
      const extra = meta._woxi || [];
      const details = [];
      for (let i = 0; i < names.length; i += 1) {
        details.push({
          description: (types[i] && types[i].docstring) || "",
          status: (extra[i] && extra[i].status) || "unknown",
          category: (extra[i] && extra[i].category) || "",
          doc: (extra[i] && extra[i].doc) || "",
          type: (types[i] && types[i].type) || "function",
          arity: (extra[i] && extra[i].arity) || null,
        });
      }
      self.details = details;
      self.rankParameters(names, details, prefix);
      const result = {
        names: names,
        details: details,
        total: typeof meta.total === "number" ? meta.total : names.length,
        start: content.cursor_start || 0,
        end: content.cursor_end || 0,
      };
      self.cache[prefix + "@" + limit] = result;
      if (!result.names.length) {
        self.renderNoMatches();
        return;
      }
      self.matches = result;
      self.state = "candidates";
      if (self.sheetOpen) self.renderSheet();
      self.setKeys(self.chipKeys(result.names, result.details, result.total));
    },
    function () {
      // The next keystroke retries. Leaving the old candidates is better than flicker.
    }
  );
};

// Parameters of the definition the caret is in are the names an expert types most
// often inside a body, so they lead the list - even when the engine does not know
// them, since `x` is not a builtin.
Assist.prototype.rankParameters = function (names, details, prefix) {
  const params = this.activeParameters();
  if (!params.length) return;
  const wanted = (prefix || "").toLowerCase();
  for (let i = params.length - 1; i >= 0; i -= 1) {
    const name = params[i];
    if (wanted && name.toLowerCase().indexOf(wanted) !== 0) continue;
    const at = names.indexOf(name);
    const detail =
      at >= 0 ? details[at] : { description: "", status: "implemented", category: "", doc: "" };
    if (at >= 0) {
      names.splice(at, 1);
      details.splice(at, 1);
    }
    detail.description = "parameter of this definition";
    detail.status = "implemented";
    names.unshift(name);
    details.unshift(detail);
  }
};

Assist.prototype.activeParameters = function () {
  const read = this.read;
  if (!read || !this.definitions.length) return [];
  const entry = this.sink.entryId ? this.sink.entryId() : 0;
  for (let i = 0; i < this.definitions.length; i += 1) {
    const definition = this.definitions[i];
    if (definition.entry !== entry) continue;
    if (read.caret >= definition.start && read.caret <= definition.end) {
      return definition.params || [];
    }
  }
  return [];
};

Assist.prototype.chipKeys = function (names, details, total) {
  const keys = [
    { label: "Eval", action: "enter", classes: "ok", grow: 1.1, tooltip: "Evaluate this entry" },
  ];
  for (let i = 0; i < names.length && i < MAX_CHIPS; i += 1) {
    const detail = details[i] || {};
    const dimmed = detail.status === "not_implemented" || detail.status === "not_planned";
    keys.push({
      label: names[i],
      action: "assist",
      detail: { kind: "accept", name: names[i], type: detail.type, arity: detail.arity },
      classes: dimmed ? "fn chip dim" : "fn chip",
      grow: 1.25,
      tooltip:
        (detail.description || names[i]) + (dimmed ? " (" + STATUS_LABEL[detail.status] + ")" : ""),
    });
  }
  if (total > names.length) {
    const hidden = total - names.length;
    keys.push({
      label: "+" + hidden,
      action: "assist",
      detail: { kind: "more" },
      classes: "fn",
      grow: 0.95,
      tooltip: hidden + " more matches",
    });
  }
  return keys.concat(this.issueKeys(), [
    { label: "\u2190", action: "back", classes: "danger", grow: 0.8, tooltip: "Backspace" },
  ]);
};

// The symbol the caret is on or right after, which is what go to definition acts on.
Assist.prototype.symbolAtCaret = function () {
  const read = this.sink.read();
  if (!read) return "";
  const code = read.code;
  const start = prefixSpan(code, read.caret).start;
  let end = read.caret;
  while (end < code.length && /[A-Za-z0-9$`]/.test(code.charAt(end))) end += 1;
  const name = code.slice(start, end);
  return /^[A-Za-z$`][A-Za-z0-9$`]*$/.test(name) ? name : "";
};

// Whether a session symbol is a function definition rather than a variable: those wrap
// like builtins do, a plain variable is a value.
Assist.prototype.isDefinedFunction = function (name) {
  for (let i = 0; i < this.definitions.length; i += 1) {
    const definition = this.definitions[i];
    if (definition.name === name && definition.kind === "function") return true;
  }
  return false;
};

// Whether `text` is a plain symbol name, the only thing that can become a call. A
// literal (an iterator chip such as `{x, -5, 5}`) is inserted as it is.
function isIdentifier(text) {
  return /^[A-Za-z$`][A-Za-z0-9$`]*$/.test(text || "");
}

// Short press on a function button: the call with an empty argument list and the caret
// inside (`Integrate[]`, caret between the brackets). Accepting a chip replaces the
// name being typed, and the selection when there is one. A pad key only replaces the
// selection. A name that stands for a value (`Pi`, a session variable, `$Name`)
// arrives as just itself.
Assist.prototype.apply = function (name, type) {
  const read = this.sink.read();
  if (!read) return;
  const code = read.code;
  const selected =
    read.selStart !== undefined && read.selEnd !== undefined && read.selStart !== read.selEnd;
  let start = prefixSpan(code, read.caret).start;
  let end = selected ? read.selEnd : read.caret;
  // A chip that is a whole value (`{x, -5, 5}`) fills the empty argument it is offered
  // for: with the caret between the braces of `{}`, inserting it there would leave
  // `{{x, -5, 5}}`. The pair is empty by the iterator row's definition, so its closing
  // brace is the first one after the opening.
  if (!selected && name.charAt(0) === "{") {
    const context = this.contextFor(read);
    if (context.state === "iterator" && context.ctx.open) {
      start = context.ctx.open.open;
      const close = code.indexOf("}", start + 1);
      if (close >= 0) end = close + 1;
    }
  }
  const info = this.infoOf(name);
  if (type === undefined) type = info ? info.type : undefined;
  if (type === "variable" && this.isDefinedFunction(name)) type = "function";
  const call = isIdentifier(name) && isCallName(name, type);
  const insert = call ? name + "[]" : name;
  this.sink.replace(start, end, insert, insert.length - (call ? 1 : 0));
  if (this.sheetOpen) this.closeSheet();
};

// What the current match list knows about a name (`function`/`variable`, arity), or
// null when it is not in the list (a pad key, an example, the sheet).
Assist.prototype.infoOf = function (name) {
  const names = this.matches && this.matches.names ? this.matches.names : [];
  const at = names.indexOf(name);
  if (at < 0 || !this.details[at]) return null;
  return this.details[at];
};

// Long press on a function button: the call with every slot spelled out
// (`Plot[f, {x, -5, 5}]`). A selection is the first argument and overrides the
// analyzed target. Otherwise the operand that starts at the caret is. With neither,
// the placeholders stay and the first one is selected, so typing replaces it.
//
// A function that takes no arguments cannot wrap anything: the hold falls back to the
// tap (the call itself). Options: `chip` also replaces the partial name before the
// caret. `arity` is what the match list knows. `wrap: false` inserts the placeholders
// only (the sheet's insert skeleton button).
Assist.prototype.applySkeleton = function (head, options) {
  options = options || {};
  const chip = options.chip === true;
  let arity = options.arity;
  const wrap = options.wrap !== false;
  const read = this.sink.read();
  if (!read) return false;
  // Only a function can be wrapped: a constant, a literal chip or a session variable
  // keeps its tap meaning. A user-defined function wraps like a builtin.
  if (!isIdentifier(head) || !isCallName(head)) return false;
  const info = this.infoOf(head);
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
  // A chip always replaces the partial name before the caret, with or without a
  // selection. A pad key leaves the typed text alone.
  const prefix = prefixSpan(code, read.caret);
  let from = chip ? prefix.start : read.caret;
  let to = read.caret;
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
};

// Long press on a suggestion chip: the skeleton, with the partial name replaced.
Assist.prototype.wrap = function (name, arity, type) {
  return this.applySkeleton(name, { chip: true, arity: arity, type: type });
};

// The skeleton of a call: every non-option slot spelled out. Iterator slots get the
// concrete range the gallery uses, which is the part nobody wants to type. `inner`
// (a selection or the operand at the caret) becomes the first slot, and the call is
// left without a selection because nothing is missing any more.
Assist.prototype.skeletonFor = function (head, inner) {
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
    if (i > 0) offset += 2;
    if (i === 0 && !filled) select = [offset, offset + text.length];
    parts.push(text);
    offset += text.length;
  }
  return { text: head + "[" + parts.join(", ") + "]", select: select };
};

Assist.prototype.nextSlot = function () {
  const read = this.sink.read();
  if (!read) return;
  const ctx = scanContext(read.code, read.caret);
  if (!ctx.open) return;
  const at = nextSlotCaret(read.code, read.caret);
  if (at !== null) {
    this.sink.setCaret(at);
    return;
  }
  // The call is not closed yet and there is no comma ahead: start the next argument
  // with one, which is the edit the user would have made by hand.
  const before = read.code.slice(0, read.caret);
  const argument = read.code.slice(argumentStart(read.code, read.caret), read.caret);
  if (argument.trim() !== "" && /[^,\s]$/.test(before)) {
    this.sink.replace(read.caret, read.caret, ", ", 2);
  }
};

// Options already written in the call, so the chips do not offer them twice.
Assist.prototype.optionsInCall = function (code, ctx) {
  const used = {};
  if (!ctx.call) return used;
  let end = code.length;
  for (let i = ctx.call.open; i < code.length; i += 1) {
    if (code.charAt(i) === "]" && scanContext(code, i).stack.length === 1) {
      end = i;
      break;
    }
  }
  const text = code.slice(ctx.call.open, end);
  const pattern = /([A-Za-z][A-Za-z0-9$]*)\s*->/g;
  let match;
  while ((match = pattern.exec(text))) used[match[1]] = true;
  return used;
};

// options

Assist.prototype.showOptions = function (head, extra) {
  const self = this;
  const cached = this.options[head];
  if (cached) {
    this.renderOptions(head, cached, extra);
    return;
  }
  if (!this.query) return;
  const seq = ++this.seq;
  this.query("inspect_request", { code: head + "[", cursor_pos: head.length }).then(
    function (reply) {
      if (seq !== self.seq || !reply || reply.status !== "ok") return;
      const meta = (reply.content && reply.content.metadata) || {};
      const info = meta._woxi || {};
      const options = [];
      const defaults = info.optionDefaults || [];
      for (let i = 0; i < defaults.length; i += 1) {
        options.push({ name: defaults[i][0], value: defaults[i][1] });
      }
      if (!options.length) {
        const names = info.options || [];
        for (let n = 0; n < names.length; n += 1) options.push({ name: names[n], value: "" });
      }
      self.rememberOptions(head, options);
      // Only if the caret still asks for options of this call. It may have moved into an
      // iterator or a name while the defaults were on their way.
      const read = self.sink.read();
      if (!read) return;
      const context = self.contextFor(read);
      if (context.state === "options" && context.ctx.head === head) {
        self.renderOptions(head, options, self.issueKeys());
      }
    },
    function () {
      // Keep the signature bar. The next caret move retries.
    }
  );
};

Assist.prototype.rememberOptions = function (head, options) {
  this.options[head] = options;
  this.optionOrder.push(head);
  if (this.optionOrder.length > OPTION_CACHE_MAX) {
    const dropped = this.optionOrder.shift();
    delete this.options[dropped];
  }
};

Assist.prototype.renderOptions = function (head, options, extra) {
  const read = this.sink.read();
  if (!read) return;
  const span = prefixSpan(read.code, read.caret);
  const used = this.optionsInCall(read.code, scanContext(read.code, read.caret));
  const shown = [];
  for (let i = 0; i < options.length; i += 1) {
    if (used[options[i].name]) continue;
    if (span.text && options[i].name.toLowerCase().indexOf(span.text.toLowerCase()) !== 0) continue;
    shown.push(options[i]);
    if (shown.length === MAX_CHIPS) break;
  }
  if (!shown.length && !span.text) {
    this.renderIdle(extra);
    return;
  }
  this.state = "options";
  this.prefix = "";
  const keys = [
    { label: "Eval", action: "enter", classes: "ok", grow: 1.1, tooltip: "Evaluate this entry" },
  ];
  for (let k = 0; k < shown.length; k += 1) {
    keys.push({
      label: shown[k].name,
      action: "assist",
      detail: { kind: "option", name: shown[k].name },
      classes: "fn chip",
      grow: 1.25,
      tooltip:
        shown[k].name + (shown[k].value ? " \u2192 " + shown[k].value : "") + " (of " + head + ")",
    });
  }
  keys.push({
    label: "\u2304",
    action: "assist",
    detail: { kind: "more" },
    classes: "fn",
    grow: 0.8,
    tooltip: "Options of " + head,
  });
  this.setKeys(
    keys.concat(extra || [], [
      { label: "\u2190", action: "back", classes: "danger", grow: 0.8, tooltip: "Backspace" },
    ])
  );
};

// diagnostics

Assist.prototype.scheduleDiagnostics = function (code) {
  const self = this;
  if (!this.query) return;
  if (code === this.issuesText && this.issuesText !== "") return;
  if (this.diagnosticsTimer) window.clearTimeout(this.diagnosticsTimer);
  if (!code.trim()) {
    this.setIssues("", []);
    return;
  }
  // A warning describes the text it was found in. As soon as the text changes it is
  // dropped. The check for the new text replaces it a moment later. (This keeps a stale
  // `!` chip from riding along on the next text.) The caller repaints the bar.
  if (this.issuesText !== code) {
    this.issues = [];
    this.issuesText = "";
  }
  this.diagnosticsTimer = window.setTimeout(function () {
    self.diagnosticsTimer = null;
    const read = self.sink.read();
    if (!read || read.code !== code) return;
    self.query("diagnostics_request", { code: code }).then(
      function (reply) {
        if (!reply || reply.status !== "ok" || !reply.content) return;
        // The entry may have changed while the check was on its way. Its answer describes
        // the old text and must not repaint the bar (or report its issues).
        const now = self.sink.read();
        if (!now || now.code !== code) return;
        const content = reply.content;
        // Unfinished input has no diagnostics: the engine says so explicitly.
        if (content.status === "incomplete") return;
        self.setIssues(code, content.items || []);
      },
      function () {
        // The next edit retries.
      }
    );
  }, DIAGNOSTICS_MS);
};

Assist.prototype.setIssues = function (text, items) {
  const changed = this.issues.length !== items.length;
  const before = this.issuesText;
  this.issuesText = text;
  this.issues = items;
  if (!changed && before === text) return;
  this.keysSignature = ""; // force a repaint, the warning chip is part of the bar
  this.refreshBar();
  if (this.sheetOpen && this.sheetTab === "issues") this.renderSheet();
};

// Repaint only the bar, without re-running the (debounced) analysis. It reaches the same
// state `refresh` does, so a warning that arrives late keeps an iterator row, an option row
// or a completion list instead of replacing it with the bare signature.
Assist.prototype.refreshBar = function () {
  const read = this.sink.read();
  if (!read) return;
  const extra = this.issueKeys();
  const info = this.contextFor(read);
  if (info.state === "candidates") {
    // Only the list for the name before the caret. A list for an earlier keystroke is on
    // its way out and the request for this one will paint it, with the warning chip.
    if (this.state !== "candidates" || this.prefix !== info.span.text) return;
    if (this.matches.names.length) {
      this.setKeys(this.chipKeys(this.matches.names, this.matches.details, this.matches.total));
    } else {
      this.renderNoMatches();
    }
    return;
  }
  if (info.state === "options") {
    this.showOptions(info.ctx.head, extra);
    return;
  }
  if (info.state === "iterator") {
    this.showIterator(info.iterator, extra);
    return;
  }
  if (info.state === "signature") {
    this.renderSignature(info.variant, Math.min(info.ctx.argIndex, info.variant.length - 1), extra);
    return;
  }
  this.renderIdle(extra);
};

// definitions

Assist.prototype.scheduleDefinitions = function () {
  const self = this;
  if (!this.query || !this.sink.codes) return;
  const codes = this.sink.codes();
  const joined = codes.join("\u0000");
  if (joined === this.definitionsAsked) return;
  if (this.definitionsTimer) window.clearTimeout(this.definitionsTimer);
  this.definitionsTimer = window.setTimeout(function () {
    self.definitionsTimer = null;
    self.definitionsAsked = joined;
    self.query("definitions_request", { codes: codes }).then(
      function (reply) {
        if (!reply || reply.status !== "ok" || !reply.content) return;
        const entries = reply.content.entries || [];
        const flat = [];
        for (let index = 0; index < entries.length; index += 1) {
          for (let d = 0; d < entries[index].length; d += 1) {
            const definition = entries[index][d];
            flat.push({
              entry: index,
              name: definition.name,
              params: definition.params || [],
              start: definition.start,
              end: definition.end,
              kind: definition.kind,
            });
          }
        }
        self.definitions = flat;
        // The candidates were ranked before the definitions arrived. Rank them again
        // now, so a parameter of the definition leads the list as soon as it is known.
        if (self.state === "candidates" && self.matches.names.length) {
          const read = self.sink.read();
          if (read) {
            self.rankParameters(
              self.matches.names,
              self.matches.details,
              prefixSpan(read.code, read.caret).text
            );
            self.setKeys(
              self.chipKeys(self.matches.names, self.matches.details, self.matches.total)
            );
            if (self.sheetOpen) self.renderSheet();
          }
        }
      },
      function () {
        // The next edit retries.
      }
    );
  }, DEFINITIONS_MS);
};

// keyboard actions

Assist.prototype.action = function (data) {
  if (!data) return;
  if (data.kind === "accept") this.apply(data.name, data.type);
  else if (data.kind === "option") {
    const read = this.sink.read();
    if (read) this.sink.replace(read.caret, read.caret, data.name + " -> ", data.name.length + 4);
  } else if (data.kind === "next") this.nextSlot();
  else if (data.kind === "call") this.openSheet("call");
  else if (data.kind === "issues") this.openSheet("issues");
  else if (data.kind === "more") this.openSheet("matches");
};

// Session symbols change when an entry runs, so the ranked answers are stale.
Assist.prototype.invalidate = function () {
  this.cache = {};
  this.about = null;
  this.definitionsAsked = "";
};

import { installSheet } from "./assist-sheet.js";
installSheet(Assist);

export { Assist, PROTOTYPES, slotsOf };
export { closersFor } from "./assist-scan.js";
