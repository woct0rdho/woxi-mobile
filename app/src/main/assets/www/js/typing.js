// The caret and the typing bar: where the selection is, the text and selection the assist
// describes, programmatic replacements, and the bar refreshes. It also keeps the entry next
// to the keyboard when the field is focused.

import { persist } from "./documents.js";
import { activeEntry, autoGrow, updateTitle } from "./entries.js";
import { recordEdit } from "./history.js";
import { els, runtime, state } from "./runtime.js";

export function selectionOf(entry) {
  const input = entry.dom.input;
  const length = input.value.length;
  let caret = entry.caret;
  let selStart = entry.selStart;
  let selEnd = entry.selEnd;
  if (
    window.document.activeElement === input &&
    input.selectionStart !== null &&
    input.selectionStart !== undefined
  ) {
    caret = input.selectionStart;
    selStart = input.selectionStart;
    selEnd = input.selectionEnd;
  }
  if (caret === null || caret === undefined) caret = length;
  if (selStart === null || selStart === undefined) selStart = caret;
  if (selEnd === null || selEnd === undefined) selEnd = caret;
  caret = Math.max(0, Math.min(caret, length));
  selStart = Math.max(0, Math.min(selStart, length));
  selEnd = Math.max(selStart, Math.min(selEnd, length));
  return { caret: caret, selStart: selStart, selEnd: selEnd };
}

export function recordSelection(entry, immediate) {
  const input = entry.dom.input;
  if (input.selectionStart === null || input.selectionStart === undefined) return;
  let end = input.selectionEnd;
  if (end === null || end === undefined) end = input.selectionStart;
  entry.caret = input.selectionStart;
  entry.selStart = input.selectionStart;
  entry.selEnd = end;
  if (immediate) refreshAssist();
  else refreshAssistSoon();
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

export function replaceRange(start, end, text, caretAfter) {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  recordEdit(entry, "edit");
  const input = entry.dom.input;
  const value = input.value;
  start = Math.max(0, Math.min(start, value.length));
  end = Math.max(start, Math.min(end, value.length));
  input.value = value.slice(0, start) + text + value.slice(end);
  const caret = start + (caretAfter === undefined ? text.length : caretAfter);
  entry.caret = caret;
  entry.selStart = caret;
  entry.selEnd = caret;
  input.setSelectionRange(caret, caret);
  entry.input = input.value;
  autoGrow(input);
  state.dirty = true;
  updateTitle();
  persist();
  refreshAssist();
}

export function setCaret(offset) {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  const input = entry.dom.input;
  const at = Math.max(0, Math.min(offset, input.value.length));
  input.setSelectionRange(at, at);
  entry.caret = at;
  entry.selStart = at;
  entry.selEnd = at;
  refreshAssist();
}

export function selectRange(start, end) {
  const entry = activeEntry();
  if (!entry || !entry.dom) return;
  const input = entry.dom.input;
  start = Math.max(0, Math.min(start, input.value.length));
  end = Math.max(start, Math.min(end, input.value.length));
  input.focus();
  input.setSelectionRange(start, end);
  entry.caret = end;
  entry.selStart = start;
  entry.selEnd = end;
  refreshAssist();
}

export function refreshBarState() {
  if (runtime.keyboard) runtime.keyboard.refreshKeyStates();
}

export function refreshAssist() {
  if (runtime.assist) runtime.assist.refresh();
}

export function refreshAssistLater() {
  setTimeout(refreshAssist, 0);
}

let selectionRefresh = null;
export function refreshAssistSoon() {
  if (selectionRefresh) clearTimeout(selectionRefresh);
  selectionRefresh = setTimeout(function () {
    selectionRefresh = null;
    refreshAssist();
  }, 40);
}

export function liftEntry(entry) {
  if (!entry || !entry.dom) return;
  setTimeout(function () {
    const root = entry.dom.root;
    const rect = root.getBoundingClientRect();
    const view = els.notebook.getBoundingClientRect();
    if (rect.height >= view.height) return;
    const below = rect.bottom - (view.bottom - 12);
    if (below < -1) root.scrollIntoView({ block: "end", behavior: "smooth" });
  }, 40);
}
