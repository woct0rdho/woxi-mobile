// Woxi Mobile notebook UI: the composition root. Boot resolves the elements, binds the
// engine/keyboard/assist services, wires the entries' interaction hooks to the editor,
// evaluator and typing modules, and exposes the automation entry point. The behavior lives
// in the feature modules imported here. This file only decides what talks to what.

import * as WoxiAssist from "./assist.js";
import {
  loadDocumentFromText,
  newNotebook,
  openDocument,
  persist,
  restore,
  saveDocument,
} from "./documents.js";
import {
  clearActive,
  duplicateActive,
  formatNotebook,
  gatherTemplates,
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
  renderNotebook,
  setActive,
  setHooks,
  updateTitle,
} from "./entries.js";
import { attachPlots, evaluateAll, submitActive } from "./evaluation.js";
import { canRedo, canUndo, recordEdit } from "./history.js";
import * as WoxiKeyboard from "./keyboard.js";
import * as WoxiNotebook from "./notebook.js";
import { el, els, log, runtime, state, toast } from "./runtime.js";
import { closeSheet, openSheet, sheetButton } from "./sheets.js";
import { createTestAction } from "./test-hooks.js";
import { setTheme } from "./theme.js";
import {
  liftEntry,
  readActiveText,
  recordSelection,
  refreshAssist,
  refreshBarState,
  replaceRange,
  selectRange,
  setCaret,
} from "./typing.js";
import { WoxiClient } from "./woxi-client.js";

export function showMenu() {
  openSheet("Menu", function (body) {
    body.appendChild(sheetButton("New notebook", "", newNotebook));
    body.appendChild(sheetButton("Open...", "", openDocument));
    body.appendChild(
      sheetButton("Save", state.fileName ? state.fileName : "New document", function () {
        saveDocument();
      })
    );
    body.appendChild(
      sheetButton("Save as...", "", function () {
        saveDocument();
      })
    );
    body.appendChild(el("div", "woxi-sheet-sep"));
    body.appendChild(
      sheetButton("Evaluate notebook", "", async function () {
        toast("Evaluating...");
        await evaluateAll();
        toast("Done");
      })
    );
    body.appendChild(sheetButton("Format notebook", "", formatNotebook));
    body.appendChild(el("div", "woxi-sheet-sep"));
    body.appendChild(sheetButton("Go to definition", "", jumpToDefinition));
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
      toast("Cannot read document: " + (err instanceof Error ? err.message : String(err)));
      return;
    }
    void loadDocumentFromText(text, name, evaluateAll).catch(function (err) {
      toast("Cannot read document: " + (err instanceof Error ? err.message : String(err)));
    });
  },
  toClipboard: undefined,
};

function hideSplash() {
  els.splash.className = "woxi-hidden";
  document.getElementById("woxi-app").className = "";
}

// Connects the entry view's user events to the modules that implement them.
function wireEntryHooks() {
  setHooks({
    onActive: function () {
      refreshAssist();
      refreshBarState();
    },
    onFocus: function (entry) {
      // Lift the entry next to the keyboard, then describe the caret's context.
      liftEntry(entry);
      refreshAssist();
    },
    onInput: function () {
      persist();
      refreshAssist();
    },
    onBeforeInput: function (entry) {
      recordEdit(entry, "type");
    },
    onBlur: function () {
      setTimeout(refreshAssist, 0);
    },
    onSelection: function (entry) {
      recordSelection(entry, true);
    },
    onSubmit: submitActive,
    attachPlots: attachPlots,
  });
}

async function boot() {
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
        recordSelection(entry, false);
        return;
      }
    }
  });
  document.getElementById("woxi-btn-menu").addEventListener("click", showMenu);
  document.getElementById("woxi-btn-options").addEventListener("click", showOptions);

  wireEntryHooks();

  runtime.keyboard = new WoxiKeyboard.Keyboard({
    onInsert: function (text, caret, key) {
      insertText(text, caret, key);
    },
    onAction: handleKeyAction,
    onLongPress: handleKeyLongPress,
    // The bar pages are defined in keyboard.js. Only their state (Undo/Redo dim when
    // there is nothing to undo or redo) depends on the document, so it is answered here.
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
  hideSplash();
  // Show results for a restored notebook (this is a one-shot evaluation, not typing-time
  // evaluation). The first plot's layout is measured once, from its scene, so the label
  // metrics must be the real face: wait for the font set before the evaluation that makes
  // the first plot.
  try {
    const fonts = window.document.fonts;
    if (fonts) await fonts.ready;
  } catch {
    // A failed font load must not hide the restored notebook.
  }
  const hasInput = state.entries.some(function (entry) {
    return entry.input.trim();
  });
  if (hasInput) await evaluateAll();
  else focusEntry(state.entries[0]);
}

window.WoxiApp = {
  testAction: createTestAction({ showMenu: showMenu, showOptions: showOptions }),
  onNativeBack: function () {
    if (els.overlay && els.overlay.className.indexOf("woxi-hidden") < 0) {
      closeSheet();
      return true;
    }
    return false;
  },
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () {
    void boot();
  });
} else {
  void boot();
}
