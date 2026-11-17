// The notebook store: the debounced localStorage copy that survives a reload, and the file
// operations behind New / Open / Save. The entries live in the shared `state`. This module
// only reads and replaces the list and asks the entry view to render it. Only the inputs
// are stored: a reload re-evaluates every entry, so a rendered output would be dead weight
// here. The `.ipynb` export carries the outputs from each entry's engine items.

import { addEntry, autoGrowAll, focusEntry, renderNotebook, updateTitle } from "./entries.js";
import * as WoxiNotebook from "./notebook.js";
import { log, nativeCall, runtime, state, toast } from "./runtime.js";

const STORAGE_KEY = "woxi.notebook.v1";
const PERSIST_DEBOUNCE_MS = 250;
let persistTimer = null;

export function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(function () {
    try {
      const payload = {
        title: state.title,
        fileName: state.fileName,
        settings: state.settings,
        entries: state.entries.map(function (entry) {
          return { input: entry.input };
        }),
      };
      const json = JSON.stringify(payload);
      window.localStorage.setItem(STORAGE_KEY, json);
    } catch (err) {
      log("persist failed: " + err.message);
    }
  }, PERSIST_DEBOUNCE_MS);
}

export function restore() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    raw = null;
  }
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    state.title = data.title || "Untitled";
    state.fileName = data.fileName || null;
    if (data.settings && data.settings.theme) {
      state.settings.theme = data.settings.theme;
    }
    state.entries = (data.entries || []).map(function (entry) {
      return { id: state.nextId++, input: String(entry.input || "") };
    });
    return state.entries.length > 0;
  } catch (err) {
    log("restore failed: " + err.message);
    return false;
  }
}

export function newNotebook() {
  state.title = "Untitled";
  state.fileName = null;
  state.entries = [];
  state.dirty = false;
  // The entries and the engine session are new. Nothing the assist learned about the
  // previous notebook (definitions, options, cached matches) applies to this one.
  runtime.assist?.invalidate();
  // The native side remembers the last SAF file. A new notebook must not overwrite it.
  nativeCall("clearNotebookFile");
  addEntry("", {});
  focusEntry(state.entries[0]);
  updateTitle();
  persist();
  if (runtime.engine) {
    void runtime.engine.reset().catch(function (err) {
      log("reset failed: " + (err instanceof Error ? err.message : String(err)));
    });
  }
}

export function saveNotebook(asNew) {
  const name = state.fileName || WoxiNotebook.suggestFileName(state.title);
  const json = WoxiNotebook.serialize(state);
  const base64 = WoxiNotebook.utf8ToBase64(json);
  nativeCall(asNew ? "saveFileAs" : "saveFile", name, base64);
}

export function openNotebook() {
  nativeCall("openFile");
}

// Replaces the notebook with a parsed file and evaluates it. `evaluateAll` is passed in
// rather than imported: evaluation imports `persist` from this module, and the two would
// otherwise depend on each other.
export async function loadNotebookFromText(text, fileName, evaluateAll) {
  const notebook = WoxiNotebook.parse(text);
  state.title = notebook.title || WoxiNotebook.displayTitle(fileName);
  state.fileName = fileName || state.fileName;
  state.entries = [];
  state.nextId = 1;
  notebook.entries.forEach(function (entry) {
    addEntry(entry.input, { render: false });
  });
  if (state.entries.length) renderNotebook();
  else addEntry("", {});
  state.dirty = false;
  updateTitle();
  persist();
  // The assist's definitions, options and completion cache described the old entries.
  // `evaluateAll` would clear them per evaluated entry, but an empty notebook never gets
  // there, so do it before the new notebook is evaluated.
  runtime.assist?.invalidate();
  autoGrowAll();
  if (notebook.skippedCells) {
    log("opened " + fileName + ": skipped " + notebook.skippedCells + " non-code cell(s)");
  }
  toast("Evaluating...");
  await evaluateAll();
  // The opened notebook is ready to be typed into, like a fresh one.
  focusEntry(state.entries[0]);
  toast("Opened " + (fileName || "notebook"));
}
