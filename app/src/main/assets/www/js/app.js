// Woxi Mobile notebook UI: the composition root. Boot resolves the elements, binds the
// engine/keyboard/assist services, wires the entries' interaction hooks to the editor,
// evaluator and typing modules, and exposes the automation entry point. The behavior lives
// in the feature modules imported here. This file only decides what talks to what.

import * as WoxiAssist from "./assist.js";
import {
  clearActive,
  duplicateActive,
  formatNotebook,
  gatherTemplates,
  goToDefinition,
  handleKeyAction,
  handleKeyLongPress,
  insertText,
  jumpToDefinition,
  runTemplate,
} from "./editor.js";
import {
  activeEntry,
  autoGrowAll,
  focusEntry,
  focusInput,
  setActive,
  setHooks,
} from "./entries.js";
import { attachPlots, evaluateAll, submitActive } from "./evaluation.js";
import { canRedo, canUndo, recordEdit, redoEntry, undoEntry } from "./history.js";
import * as WoxiKeyboard from "./keyboard.js";
import { displayTitle, suggestFileName } from "./notebook-name.js";
import {
  autosaveComplete,
  beginPage,
  createDefaultNotebook,
  deleteStoredNotebook,
  exportNotebook,
  finishNotebookDelete,
  finishNotebookRename,
  flushAutosave,
  isCurrentPage,
  listNotebooks,
  loadNotebookFromText,
  newNotebook,
  openNotebook,
  openStoredNotebook,
  PAGE_TOKEN,
  persist,
  renameStoredNotebook,
  restore,
} from "./notebook-store.js";
import { refreshAssist, refreshBarState } from "./refresh.js";
import * as WoxiRender from "./render-output.js";
import { el, els, keepFocus, log, nativeCall, runtime, state, toast } from "./runtime.js";
import { closeSheet, openSheet, sheetButton } from "./sheets.js";
import { loadThemeMode, setTheme } from "./theme.js";
import {
  liftEntry,
  readActiveText,
  recordSelection,
  replaceRange,
  selectRange,
  setCaret,
} from "./typing.js";
import { WoxiClient } from "./woxi-client.js";

// The automation page is opened by MainActivity with this flag only when the build
// enables it. A normal page never fetches test-hooks.js or exposes the test entry point.
const AUTOMATION = new URLSearchParams(window.location.search).has("automation");
let runTestAction = null;

export function showMenu() {
  openSheet("Menu", function (body) {
    body.appendChild(sheetButton("New notebook", "", newNotebook));
    body.appendChild(sheetButton("Notebooks...", "", showNotebooks));
    body.appendChild(sheetButton("Import notebook...", "", openNotebook));
    body.appendChild(sheetButton("Export notebook...", "", exportNotebook));
    body.appendChild(el("div", "woxi-sheet-sep"));
    body.appendChild(
      sheetButton("Evaluate notebook", "", async function () {
        if (state.evaluating) {
          toast("Already evaluating");
          return;
        }
        toast("Evaluating...");
        await evaluateAll();
        toast("Done");
      })
    );
    body.appendChild(sheetButton("Format notebook", "", formatNotebook));
    body.appendChild(el("div", "woxi-sheet-sep"));
    body.appendChild(sheetButton("Go to definition", "", goToDefinition));
    body.appendChild(sheetButton("Duplicate entry", "", duplicateActive));
    body.appendChild(sheetButton("Clear entry", "", clearActive));
  });
}

function fileSummary(file) {
  const parts = [];
  if (file.name === state.fileName) parts.push("current");
  if (Number.isFinite(file.modified)) {
    parts.push(new Date(file.modified).toLocaleString());
  }
  if (Number.isFinite(file.size)) parts.push(file.size + " B");
  return parts.join(" \u00b7 ");
}

export function showNotebooks() {
  const files = listNotebooks();
  openSheet("Notebooks", function (body) {
    if (!files.length) {
      body.appendChild(el("div", "woxi-sheet-text", "No saved notebooks yet."));
      return;
    }
    files.forEach(function (file) {
      body.appendChild(notebookRow(file));
    });
  });
}

function backToNotebooks() {
  closeSheet();
  showNotebooks();
}

function notebookRow(file) {
  const row = el("div", "woxi-sheet-row");
  const open = el("button", "woxi-sheet-item woxi-sheet-notebook");
  open.type = "button";
  keepFocus(open);
  open.appendChild(el("span", null, file.name));
  open.appendChild(el("small", null, fileSummary(file)));
  open.addEventListener("click", function () {
    closeSheet();
    openStoredNotebook(file.name);
  });
  const more = el("button", "woxi-sheet-more", "\u22ee");
  more.type = "button";
  more.setAttribute("aria-label", "Actions for " + file.name);
  keepFocus(more);
  more.addEventListener("click", function () {
    showNotebookActions(file);
  });
  row.appendChild(open);
  row.appendChild(more);
  return row;
}

function showNotebookActions(file) {
  openSheet(file.name, function (body) {
    body.appendChild(
      sheetButton("Rename...", "", function () {
        showRenameNotebook(file);
      })
    );
    body.appendChild(
      sheetButton(
        "Delete...",
        "",
        function () {
          showDeleteNotebook(file);
        },
        { danger: true }
      )
    );
    body.appendChild(el("div", "woxi-sheet-sep"));
    body.appendChild(sheetButton("Back to notebooks", "", showNotebooks));
  });
}

function showRenameNotebook(file) {
  openSheet("Rename notebook", function (body) {
    const form = el("form", "woxi-sheet-form");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "woxi-sheet-input";
    input.value = displayTitle(file.name);
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("autocapitalize", "words");
    input.setAttribute("aria-label", "Notebook name");
    form.appendChild(input);

    const actions = el("div", "woxi-sheet-actions");
    const cancel = el("button", "woxi-sheet-action", "Cancel");
    cancel.type = "button";
    keepFocus(cancel);
    cancel.addEventListener("click", backToNotebooks);
    const rename = el("button", "woxi-sheet-action woxi-sheet-action-primary", "Rename");
    rename.type = "submit";
    actions.appendChild(cancel);
    actions.appendChild(rename);
    form.appendChild(actions);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      const raw = input.value.trim();
      if (!raw) {
        toast("Enter a notebook name");
        input.focus();
        return;
      }
      const target = suggestFileName(raw);
      if (target === file.name) {
        closeSheet();
        toast("Name unchanged");
        showNotebooks();
        return;
      }
      closeSheet();
      renameStoredNotebook(file.name, target);
    });
    body.appendChild(form);
    setTimeout(function () {
      input.focus();
      input.select();
    }, 0);
  });
}

function showDeleteNotebook(file) {
  openSheet("Delete notebook", function (body) {
    body.appendChild(
      el(
        "div",
        "woxi-sheet-text",
        'Delete "' + file.name + '"? The file and its saved outputs cannot be recovered.'
      )
    );
    const actions = el("div", "woxi-sheet-actions");
    const cancel = el("button", "woxi-sheet-action", "Cancel");
    cancel.type = "button";
    keepFocus(cancel);
    cancel.addEventListener("click", backToNotebooks);
    const remove = el("button", "woxi-sheet-action woxi-sheet-action-danger", "Delete");
    remove.type = "button";
    keepFocus(remove);
    remove.addEventListener("click", function () {
      closeSheet();
      deleteStoredNotebook(file.name);
    });
    actions.appendChild(cancel);
    actions.appendChild(remove);
    body.appendChild(actions);
  });
}

export function showOptions() {
  openSheet("Options", function (body) {
    body.appendChild(el("div", "woxi-sheet-text", "Theme"));
    const modes = [
      ["system", "System", "follow the device setting"],
      ["light", "Light", ""],
      ["dark", "Dark", ""],
    ];
    modes.forEach(function (entry) {
      const mode = entry[0];
      const selected = state.settings.theme === mode;
      body.appendChild(
        sheetButton((selected ? "\u2713  " : "     ") + entry[1], entry[2], function () {
          setTheme(mode);
        })
      );
    });
  });
}

window.WoxiNativeCallbacks = {
  onInsets: function (top, bottom, ime) {
    // The native side reports physical pixels. CSS wants CSS pixels. It pushes the
    // values whenever they change and once the page has finished loading, so there is
    // nothing to poll for here. The IME inset is separate from the navigation-bar inset:
    // a system text field (the rename dialog) must lift the sheet above the keyboard.
    const dpr = window.devicePixelRatio || 1;
    const root = window.document.documentElement;
    root.style.setProperty("--woxi-inset-top", top / dpr + "px");
    root.style.setProperty("--woxi-inset-bottom", bottom / dpr + "px");
    root.style.setProperty("--woxi-ime-height", (ime || 0) / dpr + "px");
  },
  onSaveComplete: function (ok, name, token) {
    if (!isCurrentPage(token)) return;
    if (ok === "true") {
      toast("Exported " + name);
    } else {
      toast("Export canceled");
    }
  },
  onAutosaveComplete: autosaveComplete,
  onNotebookRenamed: function (ok, oldName, newName, message, token) {
    if (!isCurrentPage(token)) return;
    finishNotebookRename(ok === "true", oldName, newName);
    if (ok === "true") {
      toast("Renamed to " + newName);
      showNotebooks();
    } else {
      toast(message || "Could not rename the notebook");
      showNotebooks();
    }
  },
  onNotebookDeleted: function (ok, name, message, token) {
    if (!isCurrentPage(token)) return;
    const wasCurrent = state.fileName === name;
    finishNotebookDelete(ok === "true", name);
    if (ok === "true") {
      toast("Deleted " + name);
      if (wasCurrent) {
        const remaining = listNotebooks();
        if (remaining.length && openStoredNotebook(remaining[0].name, { skipFlush: true })) return;
        createDefaultNotebook();
      } else {
        showNotebooks();
      }
    } else {
      toast(message || "Could not delete the notebook");
      showNotebooks();
    }
  },
  onFileOpened: function (name, text, token, error) {
    if (!isCurrentPage(token)) return;
    if (!name || typeof text !== "string" || !text) {
      toast(error || "Nothing opened");
      return;
    }
    try {
      flushAutosave();
      loadNotebookFromText(text, name, { existing: false });
    } catch (err) {
      toast("Cannot read notebook: " + (err instanceof Error ? err.message : String(err)));
    }
  },
};

function hideSplash() {
  els.splash.className = "woxi-hidden";
  document.getElementById("woxi-app").className = "";
  // The automation actions that arrived while the page was booting wait for this (see
  // MainActivity.handleTestIntent). A normal page has no queue.
  if (AUTOMATION) nativeCall("testReady");
}

function overlayOpen() {
  return !!(els.overlay && els.overlay.className.indexOf("woxi-hidden") < 0);
}

// Android Back and the hardware Escape mean the same thing: close the panel on top, the
// assistance sheet first, then Menu/Options. One predicate keeps the two paths equal.
function closeTopPanel() {
  if (runtime.assist && runtime.assist.sheetOpen) {
    runtime.assist.closeSheet();
    return true;
  }
  if (overlayOpen()) {
    closeSheet();
    return true;
  }
  return false;
}

// Connects the entry view's user events to the modules that implement them.
function wireEntryHooks() {
  setHooks({
    onActive: function () {
      refreshAssist();
      refreshBarState();
    },
    onFocus: function (entry) {
      // The active-entry hook already refreshed the bar. Focusing only has to bring the
      // entry next to the keyboard.
      liftEntry(entry);
    },
    onInput: function () {
      persist();
      refreshAssist();
    },
    onBeforeInput: function (entry, event) {
      const type = event && event.inputType ? event.inputType : "";
      // The app owns the undo stack. A native undo would change the text without a
      // snapshot. Cancel it and run the app's command instead, so the two histories
      // cannot disagree.
      if (type === "historyUndo" || type === "historyRedo") {
        event.preventDefault();
        if (type === "historyUndo") undoEntry();
        else redoEntry();
        return;
      }
      const kind = type.indexOf("delete") === 0 ? "delete" : "type";
      // `beforeinput` cannot see where an edit ends, but an insertion knows: the caret lands
      // after the inserted text, which is what lets the next hardware key join its word.
      const input = entry.dom ? entry.dom.input : null;
      const start = input ? input.selectionStart : null;
      const after =
        type === "insertText" && typeof event.data === "string" && start !== null
          ? start + event.data.length
          : undefined;
      recordEdit(entry, kind, after);
    },
    onBlur: function () {
      setTimeout(refreshAssist, 0);
    },
    onSubmit: submitActive,
    onUndo: undoEntry,
    onRedo: redoEntry,
    attachPlots: attachPlots,
    onManipulate: function () {
      persist();
    },
  });
}

async function boot() {
  runtime.automation = AUTOMATION;
  els.notebook = document.getElementById("woxi-notebook");
  els.title = document.getElementById("woxi-title");
  els.overlay = document.getElementById("woxi-overlay");
  els.sheetTitle = document.getElementById("woxi-sheet-title");
  els.sheetBody = document.getElementById("woxi-sheet-body");
  els.toast = document.getElementById("woxi-toast");
  els.splash = document.getElementById("woxi-splash");

  els.overlay.addEventListener("click", function (event) {
    if (event.target === els.overlay) closeSheet();
  });
  // Rotation, keyboard and system-bar changes all change the wrapping width.
  window.addEventListener("resize", function () {
    autoGrowAll();
  });
  // A caret-handle drag on Android reports only `selectionchange` - no click, keyup or
  // select - so the bar, and the selection copy used while the field is blurred, have
  // to follow it from here.
  document.addEventListener("selectionchange", function () {
    const focused = document.activeElement;
    if (!focused) return;
    for (let i = 0; i < state.entries.length; i += 1) {
      const entry = state.entries[i];
      if (entry.dom && entry.dom.input === focused) {
        if (state.activeId !== entry.id) setActive(entry);
        recordSelection(entry);
        return;
      }
    }
  });
  // The hardware keyboard's Escape is this app's Back: close the sheet on top.
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    if (closeTopPanel()) event.preventDefault();
  });
  keepFocus(document.getElementById("woxi-btn-menu")).addEventListener("click", showMenu);
  keepFocus(document.getElementById("woxi-btn-options")).addEventListener("click", showOptions);

  wireEntryHooks();

  // The native side keys asynchronous callbacks to the page that submitted the work.
  // A stale page cannot update this one after a renderer restart.
  beginPage();
  // onStop is the Activity boundary. A page reload or renderer replacement can unload
  // this page without an Activity stop, so the debounce also gets a page boundary.
  window.addEventListener("pagehide", flushAutosave);

  runtime.keyboard = new WoxiKeyboard.Keyboard({
    onInsert: function (text, caret, key) {
      insertText(text, caret, key);
    },
    onAction: handleKeyAction,
    onLongPress: handleKeyLongPress,
    // A held key has already written its skeleton (or waits to be pressed as a tap) while
    // the finger is down. The bar is rebuilt under that finger, and the browser's end of
    // gesture can leave the focus on the key or on nothing. The entry keeps the caret, so
    // it takes the focus back once the gesture is over.
    onHoldRelease: function () {
      const entry = activeEntry();
      if (entry) focusInput(entry);
    },
    // The bar pages are defined in keyboard.js. Only their state (Undo/Redo dim when
    // there is nothing to undo or redo) depends on the notebook, so it is answered here.
    keyState: function (key) {
      const entry = activeEntry();
      if (key.action === "undo") return canUndo(entry) ? "" : "dim";
      if (key.action === "redo") return canRedo(entry) ? "" : "dim";
      return "";
    },
  });

  runtime.assist = new WoxiAssist.Assist({
    read: readActiveText,
    replace: replaceRange,
    setCaret: setCaret,
    select: selectRange,
    evaluate: runTemplate,
    templates: gatherTemplates,
    gotoDefinition: jumpToDefinition,
    entryId: function () {
      const entry = activeEntry();
      return entry ? state.entries.indexOf(entry) : 0;
    },
    entryKey: function () {
      return state.activeId;
    },
    codes: function () {
      return state.entries.map(function (entry) {
        return entry.input || "";
      });
    },
  });
  runtime.assist.bind(runtime.keyboard, function (msgType, content) {
    if (!runtime.engine) return Promise.resolve(null);
    return runtime.engine.query(msgType, content);
  });
  refreshBarState();

  const restored = restore();
  if (!restored) createDefaultNotebook();
  state.settings.theme = loadThemeMode();
  setActive(state.entries[0]);
  setTheme(state.settings.theme);

  runtime.engine = new WoxiClient(PAGE_TOKEN);
  runtime.assist.ensurePrototypes();
  if (AUTOMATION) {
    try {
      const testHooks = await import("./test-hooks.js");
      runTestAction = testHooks.createTestAction({ showMenu: showMenu, showOptions: showOptions });
    } catch (err) {
      log("test hooks unavailable: " + (err instanceof Error ? err.message : String(err)));
    }
  }
  hideSplash();
  // The outputs were restored from the file. Wait for the real face before fitting their
  // pictures, then leave the engine idle: evaluation is demand-driven, not a launch step.
  const fonts = window.document.fonts;
  if (fonts) await fonts.ready;
  for (let i = 0; i < state.entries.length; i += 1) {
    const entry = state.entries[i];
    if (entry.dom) WoxiRender.fitGraphics(entry.dom.output);
  }
  // Whichever notebook was loaded, it is now ready to be typed into: the active entry
  // owns the caret, so the caret is visible before the first tap in the text.
  focusEntry(state.entries[0]);
}

const appApi = {
  onNativeBack: function () {
    return closeTopPanel();
  },
  flushAutosave: function () {
    flushAutosave();
  },
};

if (AUTOMATION) {
  appApi.testAction = function (action, argument) {
    // Nothing shown on screen says why a harness action did nothing, so a failing one is
    // reported in the log that the harness reads back. The `done` line is what the device
    // harness waits for instead of sleeping: it marks the moment the action has run.
    try {
      if (!runTestAction) throw new Error("test hooks not loaded");
      runTestAction(action, argument);
    } catch (err) {
      log("test action " + action + " failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      log("test: done " + action);
    }
  };
}

window.WoxiApp = appApi;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () {
    void boot();
  });
} else {
  void boot();
}
