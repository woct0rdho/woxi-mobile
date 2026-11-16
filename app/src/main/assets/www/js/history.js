// The app's own undo stack: programmatic edits (keys, accepted suggestions, closed brackets)
// are invisible to the textarea's stack, so one step per word/operator/edit is kept here.

import {
  activeEntry,
  autoGrow,
  focusInput,
  revealCaret,
  selectionOf,
  setEntrySelection,
  updateTitle,
} from "./entries.js";
import { persist } from "./notebook-store.js";
import { refreshAssist, refreshBarState } from "./refresh.js";
import { state } from "./runtime.js";

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
  const last = entry.lastEdit;
  const joins =
    typed &&
    selection.selStart === selection.selEnd &&
    last !== null &&
    last !== undefined &&
    last.kind === kind &&
    last.caret !== null &&
    last.caret !== undefined &&
    selection.caret === last.caret &&
    !isStepBreak(text.charAt(selection.caret - 1)) &&
    now - (last.at || 0) < COALESCE_MS;
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
  // The `input` event follows `beforeinput`. Only an edit whose end was known (or a
  // deletion, whose new caret is exactly where the input event leaves it) may set the
  // caret that the next edit joins. A paste must stay a step of its own.
  entry.lastEdit = {
    kind: kind,
    caret: after === undefined ? null : after,
    at: now,
    merge: typed && (after !== undefined || kind === "delete"),
  };
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
  setEntrySelection(entry, selStart, selEnd);
  focusInput(entry);
  input.setSelectionRange(selStart, selEnd);
  autoGrow(input);
  revealCaret(entry);
  state.dirty = true;
  updateTitle();
  persist();
  refreshAssist();
}

function stepHistory(entry, from, to) {
  const selection = selectionOf(entry);
  from.push({
    text: entry.dom.input.value,
    caret: selection.caret,
    selStart: selection.selStart,
    selEnd: selection.selEnd,
  });
  applyHistory(entry, to.pop());
  entry.lastEdit = null;
  refreshBarState();
}

function undoEntry() {
  const entry = activeEntry();
  if (!canUndo(entry)) return;
  const history = historyOf(entry);
  stepHistory(entry, history.redo, history.undo);
}

function redoEntry() {
  const entry = activeEntry();
  if (!canRedo(entry)) return;
  const history = historyOf(entry);
  stepHistory(entry, history.undo, history.redo);
}

export { canRedo, canUndo, recordEdit, redoEntry, undoEntry };
