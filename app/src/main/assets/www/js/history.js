// The app's own undo stack: programmatic edits (keys, accepted suggestions, closed brackets)
// are invisible to the textarea's stack, so one step per word/operator/edit is kept here.

import { activeEntry, autoGrow, focusInput, revealCaret, updateTitle } from "./entries.js";
import { persist } from "./notebook-store.js";
import { state } from "./runtime.js";
import { refreshAssist, refreshBarState, selectionOf } from "./typing.js";

const STEP_BREAK = " \t\n,;[](){}<>+-*/^=!&|@#:'\"~?%";
const UNDO_LIMIT = 100;
const COALESCE_MS = 700;

function isStepBreak(ch) {
  return !!ch && STEP_BREAK.indexOf(ch) >= 0;
}

function historyOf(entry) {
  if (!entry.history) entry.history = { undo: [], redo: [] };
  return entry.history;
}

function recordEdit(entry, kind, after) {
  if (!entry || !entry.dom) return;
  const history = historyOf(entry);
  const now = Date.now();
  const selection = selectionOf(entry);
  const text = entry.dom.input.value;
  const typed = kind === "type" || kind === "delete";
  const joins =
    typed &&
    selection.selStart === selection.selEnd &&
    entry.lastKind === kind &&
    entry.lastCaret !== null &&
    entry.lastCaret !== undefined &&
    selection.caret === entry.lastCaret &&
    !isStepBreak(text.charAt(selection.caret - 1)) &&
    now - (entry.lastEditAt || 0) < COALESCE_MS;
  if (!joins) {
    history.undo.push({
      text: text,
      caret: selection.caret,
      selStart: selection.selStart,
      selEnd: selection.selEnd,
    });
    if (history.undo.length > UNDO_LIMIT) history.undo.shift();
  }
  history.redo.length = 0;
  entry.lastEditAt = now;
  entry.lastKind = kind;
  entry.lastCaret = after === undefined ? null : after;
  refreshBarState();
}

function canUndo(entry) {
  return !!(entry && entry.history && entry.history.undo.length);
}

function canRedo(entry) {
  return !!(entry && entry.history && entry.history.redo.length);
}

function applyHistory(entry, snapshot) {
  const input = entry.dom.input;
  input.value = snapshot.text;
  entry.input = snapshot.text;
  const length = snapshot.text.length;
  let caret = snapshot.caret;
  if (caret === null || caret === undefined) caret = length;
  caret = Math.max(0, Math.min(caret, length));
  // The step remembers the selection it replaced, so undo puts the selection back.
  let selStart = snapshot.selStart;
  let selEnd = snapshot.selEnd;
  if (selStart === null || selStart === undefined) selStart = caret;
  if (selEnd === null || selEnd === undefined) selEnd = caret;
  selStart = Math.max(0, Math.min(selStart, length));
  selEnd = Math.max(selStart, Math.min(selEnd, length));
  entry.caret = caret;
  entry.selStart = selStart;
  entry.selEnd = selEnd;
  focusInput(entry);
  input.setSelectionRange(selStart, selEnd);
  autoGrow(input);
  revealCaret(entry);
  state.dirty = true;
  updateTitle();
  persist();
  refreshAssist();
}

function undoEntry() {
  const entry = activeEntry();
  if (!canUndo(entry)) return;
  const history = historyOf(entry);
  const selection = selectionOf(entry);
  history.redo.push({
    text: entry.dom.input.value,
    caret: selection.caret,
    selStart: selection.selStart,
    selEnd: selection.selEnd,
  });
  applyHistory(entry, history.undo.pop());
  entry.lastKind = null;
  entry.lastCaret = null;
  refreshBarState();
}

function redoEntry() {
  const entry = activeEntry();
  if (!canRedo(entry)) return;
  const history = historyOf(entry);
  const selection = selectionOf(entry);
  history.undo.push({
    text: entry.dom.input.value,
    caret: selection.caret,
    selStart: selection.selStart,
    selEnd: selection.selEnd,
  });
  applyHistory(entry, history.redo.pop());
  entry.lastKind = null;
  entry.lastCaret = null;
  refreshBarState();
}

export { applyHistory, canRedo, canUndo, historyOf, isStepBreak, recordEdit, redoEntry, undoEntry };
