// The editing commands behind the keyboard, the action bar and the sheets: insert, delete,
// undo/redo, templates, clipboard, formatting and go-to-definition. It is the largest feature
// module because every command writes the entry the same way. The pieces it shares (the view,
// the caret, the history) live in `entries.js`, `typing.js` and `history.js`.

import {
  activeEntry,
  addEntry,
  focusEntry,
  renderNotebook,
  scrollEntryIntoView,
  selectionOf,
  setEntrySelection,
  updateTitle,
  wireManipulate,
} from "./entries.js";
import { attachPlots, clearOutput, evaluateEntry, submitActive } from "./evaluation.js";
import { redoEntry, undoEntry } from "./history.js";
import { EXAMPLES } from "./keyboard-pages.js";
import { persist } from "./notebook-store.js";
import * as WoxiPlot from "./plot-interact.js";
import { nativeCall, runtime, state, toast } from "./runtime.js";
import { closeSheet } from "./sheets.js";
import { replaceInEntry, selectRange } from "./typing.js";

const EMPTY_PAIRS = ["()", "[]", "{}", '""'];

function insertText(text, caretOffset, key) {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  const input = entry.dom.input;
  const selection = selectionOf(entry);
  const start = selection.selStart;
  const end = selection.selEnd;
  const value = input.value;
  let after = Math.max(0, caretOffset || 0);
  // A function key replaces a selection: the call is what the user wants there.
  const call = key && key.classes && key.classes.indexOf("fn") >= 0;
  // A key that leaves the caret before text - a delimiter pair - wraps the selection:
  // `( )` around a selected `x^2` gives `(x^2)`. Keys with nothing after the caret
  // replace the selection, the way typing does.
  if (start !== end && after > 0 && !call) {
    const at = text.length - after;
    text = text.slice(0, at) + value.slice(start, end) + text.slice(at);
    after = 0;
  }
  // One character is typing and joins the current word. A pair or a whole call is one
  // structural step of its own. The shared writer records, focuses, grows, persists
  // and refreshes the assist.
  replaceInEntry(entry, start, end, text, text.length - after, text.length > 1 ? "edit" : "type");
}

function runTemplate(text) {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  if (state.evaluating) {
    toast("Evaluation in progress");
    return;
  }
  state.evaluating = true;
  replaceInEntry(entry, 0, entry.dom.input.value.length, text, text.length, "edit");
  void evaluateEntry(entry)
    .catch(function () {})
    .finally(function () {
      state.evaluating = false;
    });
}

function gatherTemplates() {
  const list = [];
  const examples = EXAMPLES || [];
  for (let i = 0; i < examples.length; i += 1) {
    const example = examples[i];
    if (!example.insert) continue;
    list.push({ label: example.label, insert: example.insert, hint: example.tooltip || "" });
  }
  return list;
}

function backspace() {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  const input = entry.dom.input;
  const selection = selectionOf(entry);
  let start = selection.selStart;
  let end = selection.selEnd;
  if (start === end) {
    const pair = input.value.slice(start - 2, start + 2);
    if (pair === "<||>") {
      start -= 2;
      end += 2;
    } else if (start > 0 && EMPTY_PAIRS.indexOf(input.value.slice(start - 1, start + 1)) >= 0) {
      start -= 1;
      end += 1;
    } else if (start > 0) {
      start -= 1;
    }
  }
  // Deleting a pair is one structural step. Deleting one character joins the previous
  // deletion of the same word, like typing does.
  if (start === end) return;
  replaceInEntry(entry, start, end, "", 0, end - start > 1 ? "edit" : "delete");
}

function handleKeyLongPress(key) {
  if (!key || !runtime.assist) return false;
  let wrapped = false;
  // A suggestion chip carries its name and what the engine knows about it.
  if (key.action === "assist" && key.detail && key.detail.kind === "accept") {
    wrapped =
      runtime.assist.wrap(
        key.detail.name,
        key.detail.arity,
        key.detail.type,
        key.detail.option === true,
        key.detail.callOption === true
      ) === true;
  } else if (
    // A symbol key whose insert has no caret marker is a complete call (`Break[]`): it
    // has no argument to spell out or wrap.
    !key.action &&
    key.classes &&
    key.classes.indexOf("fn") >= 0 &&
    key.label &&
    (key.insert === undefined || key.insert.indexOf("|") >= 0)
  ) {
    wrapped = runtime.assist.applySkeleton(key.label) === true;
  }
  if (wrapped) return true;
  // A hold with nothing to wrap is the tap. The keyboard performs it on release, so the
  // caret it places survives the end of the gesture. `false` says no skeleton was written.
  return false;
}

function newEntryBelow() {
  const entry = activeEntry();
  const index = entry ? state.entries.indexOf(entry) + 1 : state.entries.length;
  const added = addEntry("", { index: index });
  focusEntry(added);
  scrollEntryIntoView(added);
}

function duplicateActive() {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  // The copied markup addresses the same plot handles. Seed the new controllers with
  // what the original already has, or the duplicate is a still picture.
  const seeds = WoxiPlot.seedsOf(entry.dom.output);
  const copy = addEntry(entry.input, { index: state.entries.indexOf(entry) + 1 });
  copy.output = entry.output;
  copy.dom.output.innerHTML = entry.output || "";
  attachPlots(copy, null, seeds);
  wireManipulate(copy.dom.root);
  focusEntry(copy);
  scrollEntryIntoView(copy);
  state.dirty = true;
  updateTitle();
  persist();
}

function deleteActive() {
  const entry = activeEntry();
  if (!entry) return;
  if (state.entries.length === 1) {
    clearActive();
    return;
  }
  const index = state.entries.indexOf(entry);
  state.entries.splice(index, 1);
  renderNotebook();
  focusEntry(state.entries[Math.min(index, state.entries.length - 1)]);
  state.dirty = true;
  updateTitle();
  persist();
}

function clearActive() {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  const input = entry.dom.input;
  const hasText = input.value.length > 0;
  const hasOutput = entry.dom.output.innerHTML !== "";
  if (!hasText && !hasOutput) return;
  if (hasText) replaceInEntry(entry, 0, input.value.length, "", 0, "edit");
  clearOutput(entry);
  entry.input = input.value;
  setEntrySelection(entry, 0, 0);
  input.setSelectionRange(0, 0);
  focusEntry(entry);
  state.dirty = true;
  updateTitle();
  persist();
}

function clipboardOp(op) {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  if (op === "paste") {
    let clip = nativeCall("getClipboard");
    clip = clip === undefined || clip === null ? "" : String(clip);
    if (!clip) {
      toast("Clipboard is empty");
      return;
    }
    insertText(clip, 0);
    toast("Pasted");
    return;
  }
  const input = entry.dom.input;
  const picked = selectionOf(entry);
  const start = picked.selStart;
  const end = picked.selEnd;
  const selection = end > start ? input.value.slice(start, end) : input.value;
  if (!selection) {
    toast("Nothing to copy");
    return;
  }
  nativeCall("setClipboard", selection);
  if (op === "copy") {
    toast("Copied");
    return;
  }
  if (end > start) replaceInEntry(entry, start, end, "", 0, "edit");
  else replaceInEntry(entry, 0, input.value.length, "", 0, "edit");
  toast("Cut");
}

function mapCaret(before, after, caret) {
  let wanted = 0;
  let i;
  for (i = 0; i < caret && i < before.length; i += 1) {
    if (!/\s/.test(before.charAt(i))) wanted += 1;
  }
  let seen = 0;
  for (i = 0; i < after.length; i += 1) {
    if (/\s/.test(after.charAt(i))) continue;
    if (seen === wanted) return i;
    seen += 1;
  }
  return after.length;
}

async function formatCodes(codes) {
  if (!runtime.engine) return codes;
  const reply = await runtime.engine.query("format_request", { codes: codes }).catch(() => null);
  const formatted = reply?.status === "ok" ? reply.content?.codes : null;
  if (!formatted || formatted.length !== codes.length) return codes;
  return formatted;
}

function rewriteEntry(entry, text) {
  const before = entry.dom.input.value;
  const selection = selectionOf(entry);
  const caret = mapCaret(before, text, selection.caret);
  // Formatting every entry in the notebook must not move the caret into the ones that
  // are not being edited. `replaceInEntry` focuses only the active entry.
  replaceInEntry(entry, 0, before.length, text, caret, "edit");
}

async function formatEntry() {
  const entry = activeEntry();
  if (!entry || !entry.dom || !entry.dom.input.value.trim()) return;
  const text = entry.dom.input.value;
  const codes = await formatCodes([text]);
  // The user may type while the formatter runs. Never replace a newer text with a
  // formatted copy of the older one.
  if (entry.dom.input.value !== text) {
    toast("Entry changed; not formatted");
    return;
  }
  if (!codes[0] || codes[0] === text) {
    toast("Already formatted");
    return;
  }
  rewriteEntry(entry, codes[0]);
  toast("Formatted");
}

async function formatNotebook() {
  const entries = state.entries.filter(function (entry) {
    return entry.dom && entry.dom.input.value.trim();
  });
  if (!entries.length) return;
  const before = entries.map(function (entry) {
    return entry.dom.input.value;
  });
  const formatted = await formatCodes(before);
  let changed = 0;
  let skipped = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].dom.input.value !== before[i]) {
      skipped += 1;
      continue;
    }
    if (!formatted[i] || formatted[i] === before[i]) continue;
    rewriteEntry(entries[i], formatted[i]);
    changed += 1;
  }
  const changedText = changed
    ? "Formatted " + changed + (changed === 1 ? " entry" : " entries")
    : "Already formatted";
  toast(skipped ? changedText + "; skipped " + skipped + " changed" : changedText);
}

function jumpToDefinition(name) {
  if (!runtime.assist || !runtime.assist.definitions) return;
  let found = null;
  for (let i = 0; i < runtime.assist.definitions.length; i += 1) {
    const definition = runtime.assist.definitions[i];
    if (definition.name !== name) continue;
    if (!found || definition.kind === "function") found = definition;
    if (found.kind === "function") break;
  }
  if (!found) {
    toast("No definition of " + name);
    return;
  }
  const entry = state.entries[found.entry];
  if (!entry || !entry.dom) {
    toast("No definition of " + name);
    return;
  }
  closeSheet();
  focusEntry(entry);
  selectRange(found.start, found.end);
  scrollEntryIntoView(entry);
  toast("Defined in entry " + (found.entry + 1));
}

function goToDefinition() {
  if (!runtime.assist) return;
  const name = runtime.assist.symbolAtCaret();
  if (!name) {
    toast("No symbol under the caret");
    return;
  }
  jumpToDefinition(name);
}

function handleKeyAction(action, data) {
  if (action === "assist") {
    if (runtime.assist) runtime.assist.action(data);
    return;
  }
  if (action === "undo") {
    undoEntry();
    return;
  }
  if (action === "redo") {
    redoEntry();
    return;
  }
  if (action === "enter") void submitActive();
  else if (action === "back") backspace();
  else if (action === "new") newEntryBelow();
  else if (action === "delete") deleteActive();
  else if (action === "cut" || action === "copy" || action === "paste") clipboardOp(action);
  else if (action === "format") void formatEntry();
}

export {
  clearActive,
  duplicateActive,
  formatEntry,
  formatNotebook,
  gatherTemplates,
  goToDefinition,
  handleKeyAction,
  handleKeyLongPress,
  insertText,
  jumpToDefinition,
  runTemplate,
};
