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
  addEntry,
  autoGrowAll,
  focusEntry,
  focusInput,
  renderNotebook,
  setActive,
  setHooks,
  updateTitle,
} from "./entries.js";
import { attachPlots, evaluateAll, submitActive } from "./evaluation.js";
import { canRedo, canUndo, recordEdit, redoEntry, undoEntry } from "./history.js";
import * as WoxiKeyboard from "./keyboard.js";
import * as WoxiNotebook from "./notebook.js";
import {
  loadNotebookFromText,
  newNotebook,
  openNotebook,
  persist,
  restore,
  saveNotebook,
} from "./notebook-store.js";
import { refreshAssist, refreshBarState } from "./refresh.js";
import { el, els, keepFocus, log, nativeCall, runtime, state, toast } from "./runtime.js";
import { closeSheet, openSheet, sheetButton } from "./sheets.js";
import { setTheme } from "./theme.js";
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
    body.appendChild(sheetButton("Open...", "", openNotebook));
    body.appendChild(
      sheetButton("Save", state.fileName ? state.fileName : "New notebook", function () {
        saveNotebook();
      })
    );
    body.appendChild(
      sheetButton("Save as...", "", function () {
        saveNotebook(true);
      })
    );
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
  onInsets: function (top, bottom) {
    // The native side reports physical pixels. CSS wants CSS pixels. It pushes the
    // values whenever they change and once the page has finished loading, so there is
    // nothing to poll for here.
    const dpr = window.devicePixelRatio || 1;
    const root = window.document.documentElement;
    root.style.setProperty("--woxi-inset-top", top / dpr + "px");
    root.style.setProperty("--woxi-inset-bottom", bottom / dpr + "px");
  },
  onSaveComplete: function (ok, name) {
    if (ok === "true" || ok === true) {
      state.fileName = name;
      state.dirty = false;
      updateTitle();
      persist();
      toast("Saved " + name);
    } else {
      toast("Save canceled");
    }
  },
  onFileOpened: function (name, base64) {
    if (!name || !base64) {
      toast("Nothing opened");
      return;
    }
    let text;
    try {
      text = WoxiNotebook.base64ToUtf8(base64);
    } catch (err) {
      toast("Cannot read notebook: " + (err instanceof Error ? err.message : String(err)));
      return;
    }
    void loadNotebookFromText(text, name, evaluateAll).catch(function (err) {
      toast("Cannot read notebook: " + (err instanceof Error ? err.message : String(err)));
    });
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
  if (!restored) state.entries = [];
  if (!state.entries.length) addEntry("", {});
  renderNotebook();
  autoGrowAll();
  updateTitle();
  setActive(state.entries[0]);
  setTheme(state.settings.theme);

  runtime.engine = new WoxiClient();
  try {
    await runtime.engine.start();
  } catch (err) {
    log("engine start failed: " + (err instanceof Error ? err.message : String(err)));
    return;
  }
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
  // Show results for a restored notebook (this is a one-shot evaluation, not typing-time
  // evaluation). The first plot's layout is measured once, from its scene, so the label
  // metrics must be the real face: wait for the font set before the evaluation that makes
  // the first plot.
  const fonts = window.document.fonts;
  if (fonts) await fonts.ready;
  const hasInput = state.entries.some(function (entry) {
    return entry.input.trim();
  });
  if (hasInput) await evaluateAll();
  // Whichever notebook was loaded, it is now ready to be typed into: the active entry
  // owns the caret, so the caret is visible before the first tap in the text.
  focusEntry(state.entries[0]);
}

const appApi = {
  onNativeBack: function () {
    return closeTopPanel();
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
