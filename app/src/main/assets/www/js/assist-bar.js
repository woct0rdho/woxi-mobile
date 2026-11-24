// The bar above the keys: idle keys, signature progress, iterator chips, candidate
// chips and warnings, plus the refresh loop that chooses which of those rows to show.

import { CALL_KEY, GROW, MAX_CHIPS } from "./assist-shared.js";
import { escapeHtml } from "./html.js";
import { BACK_KEY, BARS, CONTEXT_PAGE, EVAL_KEY } from "./keyboard-pages.js";
import { STATUS_LABEL } from "./prototypes.js";

const MAX_ITERATOR_CHIPS = 2;

function emptyCandidates(prefix, key) {
  return { key: key || "", prefix: prefix || "", names: [], details: [], total: 0 };
}

function idleKeys(extra) {
  const base = BARS[CONTEXT_PAGE];
  return base.slice(0, -1).concat(extra || [], [base[base.length - 1]]);
}

/**
 * @param {import('./types.js').KeySpec[]} keys
 */
function setKeys(keys) {
  if (!this.keyboard) return;
  // Re-rendering replaces the buttons, and a button that disappears under a finger
  // never fires its click. Refreshes happen on every keystroke and caret move, so
  // identical key lists must leave the bar alone.
  const signature = keys
    .map(function (key) {
      return [
        key.label,
        key.html || "",
        key.action || "",
        key.classes || "",
        key.insert || "",
        key.tooltip || "",
        key.grow === undefined ? "" : key.grow,
        key.detail ? JSON.stringify(key.detail) : "",
      ].join("|");
    })
    .join(";");
  if (signature === this.keysSignature) return;
  this.keysSignature = signature;
  this.keyboard.setBarKeys(keys);
}

// The warning chip is the only thing that turns amber, and it is offered only when
// the engine found something in finished input.
function issueKeys() {
  const issues = this.issues.items;
  if (!issues.length) return [];
  return [
    {
      label: "\u26A0 " + issues.length,
      action: "assist",
      detail: { kind: "issues" },
      classes: "fn warn",
      grow: 0.9,
      tooltip: issues.length === 1 ? "1 problem" : issues.length + " problems",
    },
  ];
}

function renderIdle(extra) {
  this.candidates = null;
  this.setKeys(this.idleKeys(extra));
}

// Completion applies here but has nothing to offer: the bar shows the default action
// keys, the same ones the idle state uses. Keep the prefix and request key for the
// sheet's empty hint (`No match for "..."`) and for a later warning repaint.
function renderNoMatches(prefix, key) {
  this.candidates = emptyCandidates(prefix, key);
  this.setKeys(this.idleKeys(this.issueKeys()));
  if (this.sheetOpen) this.renderSheet();
}

function renderSignature(variant, active, extra) {
  // No name is being completed here: the sheet's Matches tab must not show the list
  // from the last prefix.
  this.candidates = null;
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
  /**
   * @type {import('./types.js').KeySpec[]}
   */
  const keys = [
    EVAL_KEY,
    {
      label: "signature",
      html: html,
      action: "assist",
      detail: { kind: "next" },
      classes: "sig",
      grow: GROW.signature,
      tooltip: "Tap to move to the next argument",
    },
    ...(extra || []),
    {
      ...CALL_KEY,
      label: number + "/" + variant.length + " \u25BE",
      grow: 0.9,
      tooltip: "Argument " + number + " of " + variant.length + ": the call card",
    },
    BACK_KEY,
  ];
  this.setKeys(keys);
}

function showIterator(slot, extra) {
  this.candidates = null;
  const keys = [EVAL_KEY];
  // The examples carry the gallery's concrete values and the curated fallback. Asking
  // the slot is what lets a learned example such as Table's `{i, 10}` reach the bar.
  const examples = [];
  const source = slot.examples || [];
  for (let i = 0; i < source.length && examples.length < MAX_ITERATOR_CHIPS; i += 1) {
    const text = String(source[i]).trim();
    if (text.charAt(0) !== "{" || examples.indexOf(text) >= 0) continue;
    examples.push(text);
  }
  for (let i = 0; i < examples.length; i += 1) {
    const text = examples[i];
    keys.push({
      label: text,
      action: "assist",
      detail: { kind: "accept", name: text },
      classes: "fn chip",
      grow: GROW.chip,
      tooltip: "Fill the iterator with " + text,
    });
  }
  this.setKeys(keys.concat(extra || [], [BACK_KEY]));
}

function chipKeys(names, details, total) {
  const keys = [EVAL_KEY];
  for (let i = 0; i < names.length && i < MAX_CHIPS; i += 1) {
    const detail = details[i] || {};
    const dimmed = detail.status === "not_implemented" || detail.status === "not_planned";
    keys.push({
      label: names[i],
      action: "assist",
      detail: {
        kind: "accept",
        name: names[i],
        type: detail.type,
        arity: detail.arity,
        option: detail.option === true,
        callOption: detail.callOption === true,
      },
      classes: dimmed ? "fn chip dim" : "fn chip",
      grow: GROW.chip,
      tooltip:
        (detail.description || names[i]) +
        (detail.callOption ? " (option of this call: inserts -> )" : "") +
        (dimmed ? " (" + STATUS_LABEL[detail.status] + ")" : ""),
    });
  }
  const shown = Math.min(names.length, MAX_CHIPS);
  if (total > shown) {
    const hidden = total - shown;
    keys.push({
      label: "+" + hidden,
      action: "assist",
      detail: { kind: "more" },
      classes: "fn",
      grow: GROW.more,
      tooltip: hidden + " more matches",
    });
  }
  return keys.concat(this.issueKeys(), [BACK_KEY]);
}

function refresh() {
  const read = this.sink.read();
  if (!read) {
    if (this.sheetOpen) this.closeSheet();
    this.renderIdle([]);
    return;
  }
  this.ensurePrototypes();
  this.scheduleDefinitions();
  this.scheduleDiagnostics(read.code);
  const extra = this.issueKeys();
  const info = this.contextFor(read);
  // A head without curated slots may still declare options. Its arity and defaults are
  // one inspect request. Once they arrive, contextFor can recognize the options slot.
  if (!info.variant && info.ctx.head && info.ctx.call && info.ctx.argIndex >= 1) {
    this.ensureCallMeta(info.ctx.head);
  }
  if (info.state === "candidates") {
    this.requestMatches(info.span.text, this.optionsContext(info, read), read);
    return;
  }
  this.renderContext(info, extra);
}

// The states other than candidates share one dispatcher. `refresh` and `refreshBar`
// differ only in how they obtain the data, not in which row they show.
function renderContext(info, extra) {
  if (info.state === "options") this.showOptions(info.ctx.head, extra);
  else if (info.state === "iterator") this.showIterator(info.iterator, extra);
  else if (info.state === "signature") {
    this.renderSignature(info.variant, Math.min(info.ctx.argIndex, info.variant.length - 1), extra);
  } else this.renderIdle(extra);
  // The sheet is deliberately not modal to typing. If it is open, its Matches tab must
  // not keep rows from a candidates state the caret has already left.
  if (this.sheetOpen) this.renderSheet();
}

// Repaint only the bar, without re-running the (debounced) analysis. It reaches the same
// state `refresh` does, so a warning that arrives late keeps an iterator row, an option row
// or a completion list instead of replacing it with the bare signature.
function refreshBar() {
  const read = this.sink.read();
  if (!read) return;
  const extra = this.issueKeys();
  const info = this.contextFor(read);
  if (info.state === "candidates") {
    // Only the list for this exact request. A list for an earlier keystroke, another
    // entry or another options context is on its way out and the request for this one
    // will paint it, with the warning chip.
    const key = this.matchesKey(info.span.text, this.matchLimit(), this.optionsContext(info, read));
    if (!this.candidates || this.candidates.key !== key) return;
    if (this.candidates.names.length) {
      this.setKeys(
        this.chipKeys(this.candidates.names, this.candidates.details, this.candidates.total)
      );
    } else {
      this.renderNoMatches(info.span.text, key);
    }
    return;
  }
  this.renderContext(info, extra);
}

export function installBar(Assist) {
  Object.assign(Assist.prototype, {
    idleKeys,
    setKeys,
    issueKeys,
    renderIdle,
    renderNoMatches,
    renderSignature,
    showIterator,
    chipKeys,
    refresh,
    renderContext,
    refreshBar,
  });
}
