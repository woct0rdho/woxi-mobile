// The caret and the typing bar: where the selection is, the text and selection the assist
// describes, programmatic replacements, and the bar refreshes. It also keeps the entry next
// to the keyboard when the field is focused.

import {
  activeEntry,
  autoGrow,
  focusInput,
  revealCaret,
  selectionOf,
  setEntrySelection,
} from "./entries.js";
import { recordEdit } from "./history.js";
import { persist } from "./notebook-store.js";
import { refreshAssist } from "./refresh.js";
import { els, state } from "./runtime.js";

export function recordSelection(entry) {
  const input = entry.dom.input;
  if (input.selectionStart === null || input.selectionStart === undefined) return;
  const caret = input.selectionStart;
  let end = input.selectionEnd;
  if (end === null || end === undefined) end = caret;
  const unchanged = entry.selStart === caret && entry.selEnd === end;
  setEntrySelection(entry, caret, end);
  if (unchanged) return;
  refreshAssistSoon();
}

export function readActiveText() {
  const entry = activeEntry();
  if (!entry || !entry.dom) return null;
  const selection = selectionOf(entry);
  return {
    code: entry.dom.input.value,
    caret: selection.caret,
    selStart: selection.selStart,
    selEnd: selection.selEnd,
  };
}

export function replaceInEntry(entry, start, end, text, caretAfter, kind) {
  if (!entry || !entry.dom) return;
  const input = entry.dom.input;
  const value = input.value;
  start = Math.max(0, Math.min(start, value.length));
  end = Math.max(start, Math.min(end, value.length));
  const next = value.slice(0, start) + text + value.slice(end);
  // A key at the start of a field, or a command that rewrites the same text, is not
  // an edit: it must not add an undo step.
  if (next === value) return;
  const caret = start + (caretAfter === undefined ? text.length : caretAfter);
  recordEdit(entry, kind || "edit", caret);
  input.value = next;
  setEntrySelection(entry, caret, caret);
  input.setSelectionRange(caret, caret);
  entry.input = input.value;
  autoGrow(input);
  if (entry.id === state.activeId) {
    focusInput(entry);
    revealCaret(entry);
  }
  persist();
  refreshAssist();
}

export function replaceRange(start, end, text, caretAfter) {
  const entry = activeEntry();
  if (!entry) return;
  replaceInEntry(entry, start, end, text, caretAfter, "edit");
}

export function setCaret(offset) {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  const input = entry.dom.input;
  const at = Math.max(0, Math.min(offset, input.value.length));
  input.setSelectionRange(at, at);
  focusInput(entry);
  revealCaret(entry);
  setEntrySelection(entry, at, at);
  refreshAssist();
}

export function selectRange(start, end) {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  const input = entry.dom.input;
  start = Math.max(0, Math.min(start, input.value.length));
  end = Math.max(start, Math.min(end, input.value.length));
  focusInput(entry);
  input.setSelectionRange(start, end);
  revealCaret(entry);
  setEntrySelection(entry, start, end);
  refreshAssist();
}

const SELECTION_DEBOUNCE_MS = 40;
const LIFT_MS = 40;
const LIFT_MARGIN = 12;
const LIFT_TOLERANCE = 1;

let selectionRefresh = null;
export function refreshAssistSoon() {
  if (selectionRefresh) clearTimeout(selectionRefresh);
  selectionRefresh = setTimeout(function () {
    selectionRefresh = null;
    refreshAssist();
  }, SELECTION_DEBOUNCE_MS);
}

export function liftEntry(entry) {
  if (!entry || !entry.dom) return;
  setTimeout(function () {
    const root = entry.dom.root;
    const rect = root.getBoundingClientRect();
    const view = els.notebook.getBoundingClientRect();
    if (rect.height >= view.height) return;
    const below = rect.bottom - (view.bottom - LIFT_MARGIN);
    if (below < -LIFT_TOLERANCE) root.scrollIntoView({ block: "end", behavior: "smooth" });
  }, LIFT_MS);
}
