// The editing commands behind the keyboard, the action bar and the sheets: insert, delete,
// undo/redo, templates, clipboard, formatting and go-to-definition. It is the largest feature
// module because every command writes the entry the same way. The pieces it shares (the view,
// the caret, the history) live in `entries.js`, `typing.js` and `history.js`.

import {
  activeEntry,
  addEntry,
  autoGrow,
  focusEntry,
  focusInput,
  renderNotebook,
  revealCaret,
  scrollEntryIntoView,
  updateTitle,
  wireManipulate,
} from "./entries.js";
import { evaluateEntry, submitActive } from "./evaluation.js";
import { recordEdit, redoEntry, undoEntry } from "./history.js";
import * as WoxiKeyboard from "./keyboard.js";
import { persist } from "./notebook-store.js";
import { nativeCall, runtime, state, toast } from "./runtime.js";
import { closeSheet } from "./sheets.js";
import { refreshAssist, selectionOf, selectRange } from "./typing.js";

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
  const caret = start + Math.max(0, text.length - after);
  // One character is typing and joins the current word. A pair or a whole call is one
  // structural step of its own.
  recordEdit(entry, text.length > 1 ? "edit" : "type", caret);
  input.value = value.slice(0, start) + text + value.slice(end);
  entry.caret = caret;
  entry.selStart = caret;
  entry.selEnd = caret;
  input.setSelectionRange(caret, caret);
  focusInput(entry);
  entry.input = input.value;
  autoGrow(input);
  // Growing resets the scroll position, so the caret is revealed afterwards.
  revealCaret(entry);
  state.dirty = true;
  updateTitle();
  persist();
  refreshAssist();
}

function runTemplate(text) {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  recordEdit(entry, "edit");
  entry.dom.input.value = text;
  entry.input = text;
  entry.caret = text.length;
  entry.selStart = text.length;
  entry.selEnd = text.length;
  entry.dom.input.setSelectionRange(text.length, text.length);
  autoGrow(entry.dom.input);
  focusInput(entry);
  revealCaret(entry);
  state.dirty = true;
  updateTitle();
  persist();
  void evaluateEntry(entry);
}

function gatherTemplates() {
  const list = [];
  const examples = WoxiKeyboard.EXAMPLES || [];
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
  recordEdit(entry, end - start > 1 ? "edit" : "delete", start);
  input.value = input.value.slice(0, start) + input.value.slice(end);
  entry.caret = start;
  entry.selStart = start;
  entry.selEnd = start;
  input.setSelectionRange(start, start);
  focusInput(entry);
  entry.input = input.value;
  autoGrow(input);
  revealCaret(entry);
  state.dirty = true;
  updateTitle();
  persist();
  refreshAssist();
}

function handleKeyLongPress(key) {
  if (!key || !runtime.assist) return false;
  let wrapped = false;
  // A suggestion chip carries its name and what the engine knows about it.
  if (key.action === "assist" && key.detail && key.detail.kind === "accept") {
    wrapped = runtime.assist.wrap(key.detail.name, key.detail.arity, key.detail.type) === true;
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
  // caret it places survives the end of the gesture. Returning the answer it expects is
  // what asks for that.
  return "tap";
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
  const copy = addEntry(entry.input, { index: state.entries.indexOf(entry) + 1 });
  copy.output = entry.output;
  copy.dom.output.innerHTML = entry.output || "";
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
  recordEdit(entry, "edit");
  entry.dom.input.value = "";
  entry.dom.output.innerHTML = "";
  entry.input = "";
  entry.output = "";
  entry.caret = 0;
  entry.selStart = 0;
  entry.selEnd = 0;
  entry.dom.input.setSelectionRange(0, 0);
  autoGrow(entry.dom.input);
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
  recordEdit(entry, "edit");
  input.value = end > start ? input.value.slice(0, start) + input.value.slice(end) : "";
  entry.input = input.value;
  entry.caret = end > start ? start : 0;
  entry.selStart = entry.caret;
  entry.selEnd = entry.caret;
  input.setSelectionRange(entry.caret, entry.caret);
  focusInput(entry);
  autoGrow(input);
  revealCaret(entry);
  state.dirty = true;
  updateTitle();
  persist();
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
  try {
    const reply = await runtime.engine.query("format_request", { codes: codes });
    const formatted = reply?.status === "ok" ? reply.content?.codes : null;
    if (!formatted || formatted.length !== codes.length) return codes;
    return formatted;
  } catch {
    return codes;
  }
}

function rewriteEntry(entry, text) {
  const before = entry.dom.input.value;
  const selection = selectionOf(entry);
  const caret = mapCaret(before, text, selection.caret);
  recordEdit(entry, "edit");
  entry.dom.input.value = text;
  entry.input = text;
  entry.caret = caret;
  entry.selStart = caret;
  entry.selEnd = caret;
  entry.dom.input.setSelectionRange(caret, caret);
  autoGrow(entry.dom.input);
  // Formatting every entry in the notebook must not move the caret into the ones that
  // are not being edited.
  if (entry.id === state.activeId) {
    focusInput(entry);
    revealCaret(entry);
  }
  state.dirty = true;
  updateTitle();
  persist();
}

async function formatEntry() {
  const entry = activeEntry();
  if (!entry || !entry.dom || !entry.dom.input.value.trim()) return;
  const text = entry.dom.input.value;
  const codes = await formatCodes([text]);
  if (!codes[0] || codes[0] === text) {
    toast("Already formatted");
    return;
  }
  rewriteEntry(entry, codes[0]);
  refreshAssist();
  toast("Formatted");
}

async function formatNotebook() {
  const entries = state.entries.filter(function (entry) {
    return entry.dom && entry.dom.input.value.trim();
  });
  if (!entries.length) return;
  const codes = entries.map(function (entry) {
    return entry.dom.input.value;
  });
  const formatted = await formatCodes(codes);
  let changed = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (!formatted[i] || formatted[i] === entries[i].dom.input.value) continue;
    rewriteEntry(entries[i], formatted[i]);
    changed += 1;
  }
  refreshAssist();
  toast(
    changed ? "Formatted " + changed + (changed === 1 ? " entry" : " entries") : "Already formatted"
  );
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
  backspace,
  clearActive,
  clipboardOp,
  deleteActive,
  duplicateActive,
  formatCodes,
  formatEntry,
  formatNotebook,
  gatherTemplates,
  goToDefinition,
  handleKeyAction,
  handleKeyLongPress,
  insertText,
  jumpToDefinition,
  mapCaret,
  newEntryBelow,
  rewriteEntry,
  runTemplate,
};
