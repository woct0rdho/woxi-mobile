// Notebook files: one real .ipynb per notebook, in app-private storage.
//
// The renderer owns the document model. This module serializes it to the standard notebook
// format and hands the bytes to NativeBridge, which writes atomically. Opening a file only
// parses and renders it: the engine session is rebuilt lazily by evaluation.js when the
// user next evaluates or moves a Manipulate control.
//
// `persist` is the debounced autosave used by every feature module. It never prompts and
// never blocks the UI. NotebookFiles keeps one pending snapshot per filename, writes on one
// actor thread, reserves names before their files exist, and flushes on Activity.onStop.
// Rename/delete pause autosave while their file operation runs. The serialized latest
// snapshot is handed to the native rename command, so there are no filename aliases.

import { addEntry, autoGrowAll, focusEntry, renderNotebook, updateTitle } from "./entries.js";
import { invalidateEvaluations } from "./evaluation-generation.js";
import * as WoxiNotebook from "./notebook.js";
import { isEvaluated } from "./notebook-model.js";
import { DEFAULT_NAME } from "./notebook-name.js";
import * as WoxiRender from "./render-output.js";
import { log, nativeCall, nativeCallOk, runtime, state, toast } from "./runtime.js";
import { invalidateSession, startFreshSession } from "./session.js";

const AUTOSAVE_DEBOUNCE_MS = 800;
const AUTOSAVE_MAX_WAIT_MS = 5000;
export const PAGE_TOKEN =
  globalThis.crypto && globalThis.crypto.randomUUID
    ? globalThis.crypto.randomUUID()
    : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

let persistTimer = null;
let dirtySince = 0;
let revision = 0;
let savedRevision = 0;
let loading = false;

// A rename/delete is a short cutover. Editing continues in memory while the native
// file operation runs, but autosave is paused so an old filename cannot be recreated.
let mutation = null;

// Invariants:
// - revision only grows. savedRevision is the newest completed write for this page.
// - a failed write never leaves revision <= savedRevision.
// - an existing file is not rewritten merely by opening it.
// - a native callback from another page token is ignored.
// - a pending snapshot found on open/restore is adopted once under this page's token.

function scheduleAutosave() {
  if (mutation) return;
  if (persistTimer) clearTimeout(persistTimer);
  const now = globalThis.performance.now();
  if (!dirtySince) dirtySince = now;
  const remaining = Math.max(0, dirtySince + AUTOSAVE_MAX_WAIT_MS - now);
  const delay = Math.min(AUTOSAVE_DEBOUNCE_MS, remaining);
  persistTimer = setTimeout(function () {
    persistTimer = null;
    if (revision > savedRevision) saveNow();
  }, delay);
}

function clearAutosaveTimers() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
}

export function isCurrentPage(token) {
  return token === PAGE_TOKEN;
}

export function beginPage() {
  nativeCall("beginPage", PAGE_TOKEN);
}

function notifyCurrentNotebook(name) {
  nativeCall("setCurrentNotebook", name, PAGE_TOKEN);
}

function beginMutation(kind, oldName, newName, capturedRevision) {
  if (mutation) return false;
  clearAutosaveTimers();
  dirtySince = 0;
  mutation = {
    kind: kind,
    oldName: oldName,
    newName: newName,
    revision: capturedRevision,
  };
  return true;
}

function abandonMutation() {
  if (!mutation) return;
  mutation = null;
  if (revision <= savedRevision) revision = savedRevision + 1;
  updateTitle();
}

// The app calls these from the native rename/delete callbacks. They clear the mutation
// before the next notebook is installed, so a create/open save is not blocked.
export function finishNotebookRename(ok, oldName, newName) {
  if (!mutation || mutation.kind !== "rename" || mutation.oldName !== oldName) return false;
  const captured = mutation.revision;
  mutation = null;
  if (ok) {
    if (state.fileName === oldName) state.fileName = newName;
    if (captured > savedRevision) savedRevision = captured;
    if (revision > savedRevision) {
      if (!dirtySince) dirtySince = globalThis.performance.now();
      updateTitle();
      scheduleAutosave();
    } else {
      dirtySince = 0;
      updateTitle();
    }
  } else {
    // The native command may have written the captured snapshot before a failed rename.
    // Mark the old file dirty. The normal autosave triggers decide when to try again.
    if (revision <= savedRevision) revision = savedRevision + 1;
    dirtySince = 0;
    updateTitle();
  }
  return true;
}

export function finishNotebookDelete(ok, name) {
  if (!mutation || mutation.kind !== "delete" || mutation.oldName !== name) return false;
  mutation = null;
  if (!ok && revision > savedRevision) {
    if (!dirtySince) dirtySince = globalThis.performance.now();
    updateTitle();
  }
  return true;
}

// Mark a change and arrange the write. The actual wait is the shorter of the trailing
// debounce and the remaining time before the maximum defer.
export function persist() {
  if (loading) return;
  revision += 1;
  updateTitle();
  if (mutation) {
    if (!dirtySince) dirtySince = globalThis.performance.now();
    return;
  }
  scheduleAutosave();
}

export function isDirty() {
  return revision > savedRevision;
}

function writeCurrent() {
  if (!state.fileName) return false;
  let json;
  try {
    json = WoxiNotebook.serialize(state);
  } catch (err) {
    log("serialize failed: " + (err instanceof Error ? err.message : String(err)));
    return false;
  }
  if (!nativeCallOk("autosave", state.fileName, json, String(revision), PAGE_TOKEN)) {
    log("autosave failed: native call rejected");
    return false;
  }
  return true;
}

function saveNow() {
  if (loading || mutation || revision <= savedRevision) return;
  if (!writeCurrent()) {
    updateTitle();
    toast("Could not save the notebook");
  }
}

// The native callback, called with the revision it wrote. A newer edit leaves the document
// dirty and schedules the next write. An older completion is ignored for that decision.
export function autosaveComplete(ok, name, rev, token) {
  if (!isCurrentPage(token)) return;
  const written = Number(rev);
  if (mutation) {
    // The rename command owns the latest snapshot. Older callbacks must not change the
    // current dirty state while the cutover is in progress.
    if (
      ok === "true" &&
      Number.isInteger(written) &&
      written > savedRevision &&
      written <= mutation.revision
    ) {
      savedRevision = written;
    }
    return;
  }
  if (name && state.fileName && name !== state.fileName) {
    return;
  }
  if (ok !== "true") {
    log("autosave failed: " + name);
    // A failure for a snapshot that a later successful write has already superseded
    // must not re-dirty an otherwise clean document.
    if (Number.isInteger(written) && written < savedRevision) return;
    // A failed snapshot must never leave the document clean, even when it was the
    // snapshot loaded by an open operation rather than an edit made on this page.
    if (revision <= savedRevision) revision = savedRevision + 1;
    updateTitle();
    toast("Could not save the notebook");
    return;
  }
  if (Number.isInteger(written) && written > savedRevision) savedRevision = written;
  if (written === revision) {
    dirtySince = 0;
    updateTitle();
  } else if (revision > savedRevision) {
    scheduleAutosave();
  }
}

export function flushAutosave() {
  clearAutosaveTimers();
  if (mutation) return;
  if (revision > savedRevision) saveNow();
  nativeCall("flushAutosave");
}

function fileNameFor(requested) {
  const answer = nativeCall("nextNotebookName", requested || DEFAULT_NAME);
  if (typeof answer === "string" && answer) return answer;
  throw new Error("Could not allocate a notebook name");
}

function installEntries(entries) {
  state.entries = [];
  state.nextId = 1;
  for (let i = 0; i < entries.length; i += 1) {
    const parsed = entries[i];
    const entry = addEntry(parsed.input || "", {
      render: false,
      cellId: parsed.cellId,
    });
    entry.executionCount = parsed.executionCount;
    const items = parsed.items && parsed.items.length ? parsed.items : null;
    entry.items = items;
    entry.evaluatedInput = isEvaluated(entry) ? parsed.input || "" : null;
    entry.output = items ? WoxiRender.renderItems(items).html : "";
    entry.widgets = [];
  }
  if (!state.entries.length) addEntry("", { render: false });
}

function installNotebook(notebook, name) {
  loading = true;
  try {
    clearAutosaveTimers();
    invalidateSession();
    invalidateEvaluations();
    state.fileName = name;
    state.activeId = null;
    state.evaluating = false;
    installEntries(notebook.entries);
    renderNotebook();
    notifyCurrentNotebook(name);
    for (let i = 0; i < state.entries.length; i += 1) {
      const entry = state.entries[i];
      if (entry.dom) WoxiRender.fitGraphics(entry.dom.output);
    }
    dirtySince = 0;
    savedRevision = revision;
    updateTitle();
    autoGrowAll();
    runtime.assist?.invalidate();
  } finally {
    loading = false;
  }
}

// Boot restore. The file is the only notebook source.
export function restore() {
  const answer = nativeCall("loadLastNotebook");
  if (typeof answer === "string" && answer) {
    try {
      const loaded = JSON.parse(answer);
      const text = typeof loaded.text === "string" ? loaded.text : "";
      installNotebook(WoxiNotebook.parse(text), loaded.name || DEFAULT_NAME);
      // A reloaded page may have found a queued snapshot instead of a durable file.
      // Writing it under this page's token gives the new page ownership of the snapshot.
      if (loaded.pending) {
        revision += 1;
        updateTitle();
        saveNow();
      }
      return true;
    } catch (err) {
      // A corrupt file is not overwritten. The app creates a new numbered file.
      log("restore failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }
  return false;
}

export function createDefaultNotebook() {
  clearAutosaveTimers();
  beginEmptyNotebook(fileNameFor(DEFAULT_NAME));
}

export function newNotebook() {
  if (mutation) return;
  flushAutosave();
  let name;
  try {
    name = fileNameFor(DEFAULT_NAME);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return;
  }
  beginEmptyNotebook(name);
}

function beginEmptyNotebook(name) {
  invalidateEvaluations();
  state.fileName = name;
  state.entries = [];
  state.nextId = 1;
  state.activeId = null;
  state.evaluating = false;
  dirtySince = 0;
  runtime.assist?.invalidate();
  addEntry("", {});
  notifyCurrentNotebook(name);
  focusEntry(state.entries[0]);
  revision += 1;
  updateTitle();
  void startFreshSession().catch(function (err) {
    log("reset failed: " + (err instanceof Error ? err.message : String(err)));
  });
  saveNow();
}

export function listNotebooks() {
  const answer = nativeCall("listNotebooks");
  if (typeof answer !== "string" || !answer) return [];
  try {
    const list = JSON.parse(answer);
    return Object.prototype.toString.call(list) === "[object Array]" ? list : [];
  } catch (err) {
    log("listNotebooks failed: " + (err instanceof Error ? err.message : String(err)));
    return [];
  }
}

export function openNotebook() {
  if (mutation) return;
  flushAutosave();
  nativeCall("openFile", PAGE_TOKEN);
}

export function exportNotebook() {
  if (mutation) return;
  flushAutosave();
  const name = state.fileName || DEFAULT_NAME;
  try {
    const json = WoxiNotebook.serialize(state);
    if (!nativeCallOk("exportFile", name, json, PAGE_TOKEN)) {
      toast("Cannot start the export");
    }
  } catch (err) {
    toast("Cannot export notebook: " + (err instanceof Error ? err.message : String(err)));
  }
}

export function openStoredNotebook(name, options = {}) {
  if (mutation) return false;
  const skipFlush = options.skipFlush === true;
  if (name === state.fileName) return true;
  if (!skipFlush) flushAutosave();
  const answer = nativeCall("readNotebook", name);
  if (typeof answer !== "string" || !answer) {
    toast("Cannot read " + name);
    return false;
  }
  try {
    const loaded = JSON.parse(answer);
    if (typeof loaded.text !== "string" || !loaded.text) {
      toast("Cannot read " + name);
      return false;
    }
    const actualName = typeof loaded.name === "string" && loaded.name ? loaded.name : name;
    loadNotebookFromText(loaded.text, actualName, {
      existing: true,
      pending: loaded.pending === true,
    });
    return true;
  } catch (err) {
    toast("Cannot read notebook: " + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

export function renameStoredNotebook(name, target) {
  if (mutation) return;
  if (name === state.fileName) {
    let json;
    try {
      // Preparing the snapshot is the only synchronous part. The native write and rename
      // run on the writer. Edits made while they run stay in memory and are saved under
      // the new name when the callback returns.
      json = WoxiNotebook.serialize(state);
    } catch (err) {
      toast("Cannot rename notebook: " + (err instanceof Error ? err.message : String(err)));
      return;
    }
    const captured = revision;
    if (!beginMutation("rename", name, target, captured)) return;
    if (!nativeCallOk("renameNotebook", name, target, json, PAGE_TOKEN)) {
      abandonMutation();
      toast("Cannot rename the notebook");
    }
    return;
  }
  if (!nativeCallOk("renameNotebook", name, target, "", PAGE_TOKEN)) {
    toast("Cannot rename the notebook");
  }
}

export function deleteStoredNotebook(name) {
  if (mutation) return;
  if (name === state.fileName && !beginMutation("delete", name, null, revision)) return;
  if (!nativeCallOk("deleteNotebook", name, PAGE_TOKEN)) {
    if (name === state.fileName) abandonMutation();
    toast("Cannot delete the notebook");
  }
}

// A SAF import or a test hook. The imported file becomes an app-private working copy.
// Its outputs are displayed, never re-evaluated, and the user can export it again.
// Opening an existing file does not write it back: the file is already its own source.
// `pending` says the text came from a native snapshot that has not reached disk yet.
// Such a snapshot is adopted once under this page's token.
export function loadNotebookFromText(text, fileName, options = {}) {
  if (mutation) return;
  const existing = options.existing === true;
  const pending = options.pending === true;
  const notebook = WoxiNotebook.parse(text);
  const name = existing ? fileName || DEFAULT_NAME : fileNameFor(fileName || DEFAULT_NAME);
  installNotebook(notebook, name);
  if (!existing || pending) {
    revision += 1;
    updateTitle();
    saveNow();
  }
  focusEntry(state.entries[0]);
  if (notebook.skippedCells) {
    log("opened " + name + ": skipped " + notebook.skippedCells + " non-code cell(s)");
    toast("Opened " + name + "; non-code cells were skipped");
  } else {
    toast("Opened " + name);
  }
}

runtime.isDirty = isDirty;
