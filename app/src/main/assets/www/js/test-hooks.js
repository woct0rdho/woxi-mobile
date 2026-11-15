// The automation hooks: one action entry point for `docs/automation.md`, driving the same
// controllers a finger does. Test-only code, but it lives in the app because it needs the live
// DOM, services and plot controllers. `createTestAction` takes only the two app-level sheets it
// cannot import (the menu and its theme options).

import { formatEntry, formatNotebook, goToDefinition, handleKeyAction } from "./editor.js";
import { activeEntry, addEntry, autoGrow, focusEntry, renderNotebook } from "./entries.js";
import { evaluateAll, evaluateEntry } from "./evaluation.js";
import { canRedo, canUndo, redoEntry, undoEntry } from "./history.js";
import * as WoxiKeyboard from "./keyboard.js";
import * as WoxiNotebook from "./notebook.js";
import { loadNotebookFromText } from "./notebook-store.js";
import { perfLine, plotAction } from "./plot-hooks.js";
import * as WoxiPlot from "./plot-interact.js";
import { els, log, nativeCall, runtime, state } from "./runtime.js";
import { resolveTheme, setTheme } from "./theme.js";
import { readActiveText, refreshAssist, selectRange } from "./typing.js";

function domSummary() {
  let outputs = 0;
  let errors = 0;
  let svgs = 0;
  let graphics = 0;
  let manipulates = 0;
  for (let i = 0; i < state.entries.length; i++) {
    const entry = state.entries[i];
    if (!entry.dom) continue;
    const out = entry.dom.output;
    if (out.children.length) outputs += 1;
    errors += out.querySelectorAll(".woxi-out-error").length;
    svgs += out.querySelectorAll("svg").length;
    graphics += out.querySelectorAll(".woxi-out-graphic").length;
    manipulates += out.querySelectorAll(".woxi-manipulate").length;
  }
  return (
    "entries=" +
    state.entries.length +
    " withOutput=" +
    outputs +
    " errors=" +
    errors +
    " svgs=" +
    svgs +
    " graphics=" +
    graphics +
    " manipulates=" +
    manipulates +
    " title=" +
    state.title +
    " inset=" +
    window
      .getComputedStyle(window.document.documentElement)
      .getPropertyValue("--woxi-inset-bottom")
      .trim()
  );
}

export function createTestAction(menu) {
  return function testAction(action, argument) {
    // The plot harness lives in its own module: it owns the held drag and the injected latency,
    // and nothing else here needs to know how a synthetic finger is made.
    if (
      plotAction(action, argument, {
        log: log,
        notebook: function () {
          return els.notebook;
        },
      })
    ) {
      return;
    }
    switch (action) {
      case "insert": {
        const entry = activeEntry();
        if (!entry || !entry.dom) {
          log("insert: no active entry");
          return;
        }
        entry.dom.input.value = argument || "";
        entry.input = argument || "";
        entry.caret = entry.input.length; // keep the caret at the end, as a user would
        entry.dom.input.focus();
        autoGrow(entry.dom.input);
        if (argument) {
          void evaluateEntry(entry).then(
            function () {
              log("insert: evaluated " + argument);
            },
            function (err) {
              log("insert: failed " + (err instanceof Error ? err.message : String(err)));
            }
          );
        }
        break;
      }
      case "type": {
        // Puts text in the active entry without evaluating it: what the user has typed
        // so far, for the assist bar to describe.
        const typedEntry = activeEntry();
        if (!typedEntry || !typedEntry.dom) {
          log("type: no entry");
          break;
        }
        typedEntry.dom.input.value = argument || "";
        typedEntry.input = argument || "";
        typedEntry.caret = typedEntry.input.length;
        typedEntry.dom.input.focus();
        typedEntry.dom.input.setSelectionRange(typedEntry.caret, typedEntry.caret);
        autoGrow(typedEntry.dom.input);
        refreshAssist();
        log("type: " + typedEntry.input);
        break;
      }
      case "add": {
        // Append a new entry with the given source and evaluate it.
        const nowMs = function () {
          return window.performance && window.performance.now
            ? window.performance.now()
            : Date.now();
        };
        const tSetup = nowMs();
        const added = addEntry(argument || "", {});
        focusEntry(added);
        autoGrow(added.dom.input);
        const tEval = nowMs();
        void evaluateEntry(added).then(
          function () {
            log(
              "add: evaluated " +
                (argument || "").slice(0, 40) +
                " | setup=" +
                Math.round(tEval - tSetup) +
                "ms eval=" +
                Math.round(nowMs() - tEval) +
                "ms engine=" +
                added.engineMs +
                "ms render=" +
                added.renderMs +
                "ms json=" +
                added.bytesJson +
                "B"
            );
          },
          function (err) {
            log("add: failed " + (err instanceof Error ? err.message : String(err)));
          }
        );
        break;
      }
      case "key": {
        // Simulate one of the keyboard action keys: enter | plot | solve | back.
        handleKeyAction(argument || "enter");
        log("key: " + argument);
        break;
      }
      case "keys": {
        // Press a keyboard key by its label, exactly as a tap would: a key on the current
        // page wins, otherwise the first page/bar page that has that label.
        const here = WoxiKeyboard.PAGES[runtime.keyboard.pageId];
        let found = null;
        for (let k = 0; here && k < here.keys.length; k++) {
          if (here.keys[k].label === argument) {
            found = { key: here.keys[k], page: here.id };
            break;
          }
        }
        if (!found) found = WoxiKeyboard.findKey(argument);
        if (!found) {
          log("keys: no key labeled " + argument);
          return;
        }
        runtime.keyboard.press(found.key);
        log(
          "keys: " +
            argument +
            " page=" +
            found.page +
            " input=" +
            (activeEntry() && activeEntry().dom ? activeEntry().dom.input.value : "") +
            " caret=" +
            (activeEntry() && activeEntry().dom ? activeEntry().caret : "?") +
            " shift=" +
            runtime.keyboard.shift +
            " entries=" +
            state.entries.length
        );
        break;
      }
      case "evalall": {
        const hasInput = state.entries.some(function (e) {
          return e.input.trim();
        });
        log("evalall: inputs=" + hasInput);
        void evaluateAll().then(
          function () {
            log("evalall: done");
          },
          function (err) {
            log("evalall: failed " + (err instanceof Error ? err.message : String(err)));
          }
        );
        break;
      }
      case "dom":
        log("dom: " + domSummary());
        break;
      case "focus": {
        // Where the caret is and whether the field that owns it has the focus that makes it
        // blink. `document.hasFocus` is the window's own focus: without it a focused field
        // draws no caret at all.
        const focusedEntry = activeEntry();
        const element = document.activeElement;
        const input = focusedEntry && focusedEntry.dom ? focusedEntry.dom.input : null;
        log(
          "focus: window=" +
            document.hasFocus() +
            " active=" +
            (element ? element.tagName + "." + (element.className || "") : "none") +
            " input=" +
            (input ? element === input : "none") +
            " sel=" +
            (input
              ? input.selectionStart + ".." + input.selectionEnd + " of " + input.value.length
              : "-")
        );
        break;
      }
      case "assist": {
        // Dump the context bar, so a device test can assert on what the user sees.
        const assistRead = readActiveText();
        if (!runtime.assist || !assistRead) {
          log("assist: none");
          break;
        }
        let insets = {};
        try {
          insets = JSON.parse(window.WoxiNative.getInsets());
        } catch (err) {
          insets = {};
        }
        const dpr = window.devicePixelRatio || 1;
        const insetTop = insets.top || 0;
        const barKeys = document.querySelectorAll("#woxi-kb-actions .woxi-key");
        const barRects = [];
        for (let bk = 0; bk < barKeys.length; bk += 1) {
          const keyRect = barKeys[bk].getBoundingClientRect();
          barRects.push(
            barKeys[bk].getAttribute("data-key") +
              "@" +
              Math.round((keyRect.left + keyRect.width / 2) * dpr) +
              "," +
              Math.round(insetTop + (keyRect.top + keyRect.height / 2) * dpr)
          );
        }
        log(
          "assist: state=" +
            runtime.assist.state +
            ' prefix="' +
            runtime.assist.prefix +
            '"' +
            " matches=" +
            (runtime.assist.matches && runtime.assist.matches.names
              ? runtime.assist.matches.names.slice(0, 6).join(",")
              : "") +
            " caret=" +
            assistRead.caret +
            " chips=" +
            (runtime.assist.details || [])
              .slice(0, 3)
              .map(function (detail) {
                return (
                  (detail.type || "?") + (detail.arity ? "/" + JSON.stringify(detail.arity) : "")
                );
              })
              .join(",") +
            " stored=" +
            (function () {
              const now = activeEntry();
              return now ? now.caret + "/" + now.selStart + "/" + now.selEnd : "-";
            })() +
            ' text="' +
            assistRead.code.slice(0, 40) +
            '"' +
            " issues=" +
            runtime.assist.issues.length +
            " defs=" +
            runtime.assist.definitions.length +
            " bar=" +
            barRects.join(" ")
        );
        const viewport = window.visualViewport;
        const kbdRect = document.getElementById("woxi-keyboard").getBoundingClientRect();
        log(
          "metrics: w=" +
            window.innerWidth +
            " h=" +
            window.innerHeight +
            " dpr=" +
            window.devicePixelRatio +
            " clientH=" +
            document.documentElement.clientHeight +
            " vv=" +
            (viewport ? Math.round(viewport.height) + "@" + Math.round(viewport.offsetTop) : "-") +
            " kb=" +
            Math.round(kbdRect.top) +
            ".." +
            Math.round(kbdRect.bottom) +
            " sheet=" +
            (runtime.assist.dom ? runtime.assist.dom.className : "-")
        );
        break;
      }
      case "assistaccept": {
        if (!runtime.assist) {
          log("assistaccept: no assist");
          break;
        }
        const acceptName =
          argument || (runtime.assist.matches.names.length ? runtime.assist.matches.names[0] : "");
        if (!acceptName) {
          log("assistaccept: no match");
          break;
        }
        runtime.assist.apply(acceptName);
        log("assistaccept: " + acceptName);
        break;
      }
      case "assistsheet": {
        if (!runtime.assist) {
          log("assistsheet: no assist");
          break;
        }
        runtime.assist.openSheet(argument || "all");
        log(
          "assistsheet: " +
            (argument || "all") +
            " rows=" +
            document.querySelectorAll(
              "#woxi-assist-body [data-assist-insert],#woxi-assist-body [data-assist-template]"
            ).length
        );
        break;
      }
      case "assistclose": {
        if (runtime.assist) runtime.assist.closeSheet();
        log("assistclose");
        break;
      }
      case "press": {
        // Presses one of the keyboard's keys by label, through the same path a tap takes.
        const pressed = WoxiKeyboard.findKey(argument);
        if (!pressed) {
          log("press: no key " + argument);
          break;
        }
        runtime.keyboard.press(pressed.key);
        log("press: " + argument + " page=" + pressed.page);
        break;
      }
      case "undo": {
        undoEntry();
        const undoEntryNow = activeEntry();
        log(
          'undo: text="' +
            (undoEntryNow && undoEntryNow.dom ? undoEntryNow.dom.input.value.slice(0, 40) : "") +
            '" canUndo=' +
            canUndo(undoEntryNow) +
            " canRedo=" +
            canRedo(undoEntryNow)
        );
        break;
      }
      case "redo": {
        redoEntry();
        const redoEntryNow = activeEntry();
        log(
          'redo: text="' +
            (redoEntryNow && redoEntryNow.dom ? redoEntryNow.dom.input.value.slice(0, 40) : "") +
            '" canUndo=' +
            canUndo(redoEntryNow) +
            " canRedo=" +
            canRedo(redoEntryNow)
        );
        break;
      }
      case "diag": {
        if (!runtime.assist) {
          log("diag: none");
          break;
        }
        log(
          "diag: items=" +
            runtime.assist.issues.length +
            " codes=" +
            runtime.assist.issues
              .map(function (issue) {
                return issue.code;
              })
              .join(",") +
            " fixes=" +
            runtime.assist.issues.filter(function (issue) {
              return issue.fix;
            }).length +
            ' checked="' +
            runtime.assist.issuesText.slice(0, 30) +
            '"'
        );
        break;
      }
      case "skeleton": {
        if (!runtime.assist) {
          log("skeleton: none");
          break;
        }
        const skeletonDone = runtime.assist.applySkeleton(argument || "Plot");
        log("skeleton: " + (argument || "Plot") + " done=" + skeletonDone);
        break;
      }
      case "format": {
        void formatEntry();
        log("format: cell");
        break;
      }
      case "formatall": {
        void formatNotebook();
        log("formatall: notebook");
        break;
      }
      case "godef": {
        goToDefinition();
        log("godef");
        break;
      }
      case "wrap": {
        if (!runtime.assist) {
          log("wrap: none");
          break;
        }
        runtime.assist.wrap(argument || "Simplify");
        log("wrap: " + (argument || "Simplify"));
        break;
      }
      case "card": {
        if (!runtime.assist) {
          log("card: none");
          break;
        }
        runtime.assist.openSheet(argument || "call");
        log(
          "card: " +
            (argument || "call") +
            " rows=" +
            document.querySelectorAll(
              "#woxi-assist-body [data-assist-example],#woxi-assist-body [data-assist-variant],#woxi-assist-body [data-assist-option]"
            ).length
        );
        break;
      }
      case "caret": {
        const caretEntry = activeEntry();
        if (!caretEntry || !caretEntry.dom) {
          log("caret: no entry");
          break;
        }
        // `caret|<at>` puts the caret somewhere. `caret|<start>,<end>` selects a range,
        // which is how a selection made with the handles is reproduced.
        const range = String(argument === undefined || argument === null ? "" : argument).split(
          ","
        );
        let from = parseInt(range[0], 10);
        let to = range.length > 1 ? parseInt(range[1], 10) : from;
        if (isNaN(from)) from = caretEntry.dom.input.value.length;
        if (isNaN(to)) to = from;
        selectRange(from, to);
        log(
          "caret: " + caretEntry.dom.input.selectionStart + ".." + caretEntry.dom.input.selectionEnd
        );
        break;
      }
      case "dump": {
        // Log every entry's source and a text preview of its output.
        for (let d = 0; d < state.entries.length; d++) {
          const item = state.entries[d];
          const text = item.dom
            ? (item.dom.output.textContent || "").replace(/\s+/g, " ").slice(0, 110)
            : "";
          const svgCount = item.dom ? item.dom.output.querySelectorAll("svg").length : 0;
          const gsvg = item.dom ? item.dom.output.querySelector(".woxi-out-graphic svg") : null;
          const fit = gsvg
            ? (gsvg.getAttribute("data-woxi-fit") === "1"
                ? "yes"
                : gsvg.getAttribute("data-woxi-fit") === "scene"
                  ? "scene"
                  : "raw") +
              " " +
              Math.round(parseFloat(gsvg.getAttribute("width")) || 0) +
              "x" +
              Math.round(parseFloat(gsvg.getAttribute("height")) || 0)
            : "-";
          const plotEl = item.dom ? item.dom.output.querySelector(".woxi-plot") : null;
          const plotView = plotEl ? WoxiPlot.viewOf(plotEl) : null;
          const plot = plotView
            ? " | plot=" +
              plotView.id +
              " x=[" +
              plotView.x[0].toFixed(3) +
              "," +
              plotView.x[1].toFixed(3) +
              "]" +
              " y=[" +
              plotView.y[0].toFixed(3) +
              "," +
              plotView.y[1].toFixed(3) +
              "]" +
              " resample=" +
              (plotView.s ? "yes" : "no") +
              " densify=" +
              (plotView.dn ? "yes" : "no")
            : "";
          log(
            "dump " +
              (d + 1) +
              ": in=" +
              item.input +
              " | svgs=" +
              svgCount +
              " | fit=" +
              fit +
              plot +
              " | out=" +
              text +
              (item.engineMs === undefined
                ? ""
                : " | engine=" +
                  item.engineMs +
                  "ms render=" +
                  item.renderMs +
                  "ms json=" +
                  item.bytesJson +
                  "B") +
              (WoxiPlot.perf(plotEl) ? " | perf=" + perfLine(WoxiPlot.perf(plotEl)) : "")
          );
        }
        break;
      }
      case "save": {
        const name = argument || "Test.ipynb";
        nativeCall(
          "saveFile",
          name,
          WoxiNotebook.utf8ToBase64(WoxiNotebook.serialize(state)),
          "application/json"
        );
        log("save: requested " + name);
        break;
      }
      case "loadjson": {
        if (!argument) {
          log("loadjson: no argument");
          return;
        }
        void loadNotebookFromText(argument, "Test.ipynb", evaluateAll).catch(function (err) {
          log("loadjson: " + err.message);
        });
        log("loadjson: loaded");
        break;
      }
      case "metrics": {
        // Reports the input-box geometry, to check that wrapped lines are not clipped,
        // plus the keyboard geometry, to check that swiping does not resize it.
        for (let m = 0; m < state.entries.length; m++) {
          const metricEntry = state.entries[m];
          if (!metricEntry.dom) continue;
          const inputEl = metricEntry.dom.input;
          const rect = inputEl.getBoundingClientRect();
          log(
            "metrics " +
              (m + 1) +
              ": len=" +
              inputEl.value.length +
              " lines=" +
              inputEl.value.split("\n").length +
              " width=" +
              Math.round(rect.width) +
              " clientH=" +
              inputEl.clientHeight +
              " scrollH=" +
              inputEl.scrollHeight +
              " styleH=" +
              inputEl.style.height +
              " overflow=" +
              inputEl.style.overflowY +
              " clipped=" +
              (inputEl.scrollHeight > inputEl.clientHeight + 1)
          );
        }
        const kbd = document.getElementById("woxi-keyboard").getBoundingClientRect();
        const pad = document.getElementById("woxi-kb-keys").getBoundingClientRect();
        const bar = document.getElementById("woxi-kb-actions").getBoundingClientRect();
        log(
          "metrics kbd: total=" +
            Math.round(kbd.height) +
            " pad=" +
            Math.round(pad.height) +
            " bar=" +
            Math.round(bar.height)
        );
        break;
      }
      case "kb":
        log("kb: " + runtime.keyboard.describe());
        break;
      case "multitouch": {
        // The reported case: one finger drags the pad, a second finger touches it, then the
        // first finger finishes the drag. With 'lost' the first finger's touchend never
        // arrives (a dropped event), which used to wedge the pad until the app restarted.
        // Synthetic touch events, because adb cannot inject two fingers at once.
        const view = runtime.keyboard.padView;
        const lost = argument === "lost";
        const points = {};
        const list = function (ids) {
          return ids.map(function (id) {
            return points[id];
          });
        };
        const send = function (type, id, x, y, others) {
          points[id] = new window.Touch({
            identifier: id,
            target: view,
            clientX: x,
            clientY: y,
            pageX: x,
            pageY: y,
            screenX: x,
            screenY: y,
            radiusX: 4,
            radiusY: 4,
            force: 1,
          });
          const remaining = type === "touchend" ? list(others) : list(others.concat([id]));
          view.dispatchEvent(
            new window.TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: remaining,
              targetTouches: remaining,
              changedTouches: [points[id]],
            })
          );
        };
        try {
          send("touchstart", 1, 900, 2050, []);
          send("touchmove", 1, 700, 2050, []);
          if (lost) {
            // Finger 1 vanishes. Finger 3 starts a fresh gesture.
            send("touchstart", 3, 800, 2200, []);
            send("touchmove", 3, 600, 2200, []);
            send("touchend", 3, 600, 2200, []);
          } else {
            send("touchstart", 2, 500, 2200, [1]);
            send("touchmove", 1, 500, 2050, [2]);
            send("touchend", 2, 500, 2200, [1]);
            send("touchmove", 1, 300, 2050, []);
            send("touchend", 1, 300, 2050, []);
          }
        } catch (err) {
          log("multitouch: synthetic touches unsupported (" + err.message + ")");
          return;
        }
        window.setTimeout(function () {
          const slide = runtime.keyboard.slide;
          log(
            "multitouch" +
              (lost ? " lost" : "") +
              ": slide=" +
              (slide
                ? (slide.animating ? "ANIMATING(" : "STUCK(") + Math.round(slide.progress) + ")"
                : "none") +
              " page=" +
              runtime.keyboard.pageId +
              " dragging=" +
              runtime.keyboard.padView.classList.contains("woxi-kb-dragging")
          );
        }, 250);
        break;
      }
      case "swipe": {
        const dir = argument || "left";
        const moved = runtime.keyboard.swipe(dir);
        const box2 = document.getElementById("woxi-keyboard").getBoundingClientRect();
        log(
          "swipe " +
            dir +
            ": changed=" +
            moved +
            " kbdH=" +
            Math.round(box2.height) +
            " " +
            runtime.keyboard.describe()
        );
        break;
      }
      case "barswipe": {
        const bdir = argument || "left";
        runtime.keyboard.swipeBar(bdir);
        const box3 = document.getElementById("woxi-keyboard").getBoundingClientRect();
        log(
          "barswipe " +
            bdir +
            ": kbdH=" +
            Math.round(box3.height) +
            " " +
            runtime.keyboard.describe()
        );
        break;
      }
      case "shift": {
        // 'double' simulates two quick taps (the device harness is too slow for that).
        if (argument === "double") {
          runtime.keyboard.toggleShift();
          runtime.keyboard.toggleShift();
        } else {
          runtime.keyboard.toggleShift();
        }
        log(
          "shift: state=" +
            runtime.keyboard.shift +
            " (" +
            ["off", "one shot", "locked"][runtime.keyboard.shift] +
            ")"
        );
        break;
      }
      case "expire": {
        // Drops every engine handle without re-evaluating: the controllers see `ExpiredHandle`
        // on their next request, which is the eviction path (`stale`) in isolation.
        void runtime.engine.reset().catch(function (err) {
          log("expire: " + (err instanceof Error ? err.message : String(err)));
        });
        log("expire: engine handles dropped");
        break;
      }
      case "theme":
        setTheme(argument || "system");
        log(
          "theme: requested=" +
            (argument || "system") +
            " resolved=" +
            resolveTheme(argument || "system")
        );
        break;
      case "reload":
        window.location.reload();
        break;
      case "rebuild": {
        // Rebuilds the notebook from the output HTML it keeps, the way deleting an entry or a
        // restored session does. The plots are re-attached without the samples their evaluation
        // carried, so each comes back as markup alone (`plotstate` shows `prepared: false`) and
        // has to ask for them again on its first gesture.
        renderNotebook();
        log("rebuild: " + state.entries.length + " entries");
        break;
      }
      case "serialize": {
        const json = WoxiNotebook.serialize(state);
        log("serialize: " + json.replace(/\s+/g, " ").slice(0, 260));
        break;
      }
      case "slider": {
        // Nudge the first Manipulate slider to check live re-rendering.
        // Optional argument: target fraction of the slider range (default 0.75).
        const slider = els.notebook.querySelector(".woxi-manipulate input[type=range]");
        if (!slider) {
          log("slider: none found");
          return;
        }
        const block = slider.closest(".woxi-manipulate");
        const viewEl = block.querySelector(".woxi-manipulate-view");
        let fraction = parseFloat(argument);
        if (isNaN(fraction)) fraction = 0.75;
        const beforeSvg = viewEl.querySelector("svg");
        const beforeMarkup = beforeSvg ? beforeSvg.outerHTML : "";
        const target = Number(slider.min) + (Number(slider.max) - Number(slider.min)) * fraction;
        slider.value = String(target);
        slider.dispatchEvent(new window.Event("input", { bubbles: true }));
        setTimeout(function () {
          const svg = viewEl.querySelector("svg");
          const afterMarkup = svg ? svg.outerHTML : "";
          let firstDiff = -1;
          for (let i = 0; i < Math.min(beforeMarkup.length, afterMarkup.length); i++) {
            if (beforeMarkup.charAt(i) !== afterMarkup.charAt(i)) {
              firstDiff = i;
              break;
            }
          }
          log(
            "slider: fraction=" +
              fraction +
              " value=" +
              slider.value +
              " svgBefore=" +
              beforeMarkup.length +
              " svgAfter=" +
              afterMarkup.length +
              " identical=" +
              (beforeMarkup === afterMarkup) +
              " firstDiffAt=" +
              firstDiff
          );
        }, 1500);
        break;
      }
      case "scrollto": {
        const index = parseInt(argument, 10) - 1;
        const target2 = state.entries[index];
        if (target2 && target2.dom) target2.dom.root.scrollIntoView({ block: "start" });
        log("scrollto: " + argument);
        break;
      }
      case "sheet":
        menu.showMenu();
        break;
      case "options":
        menu.showOptions();
        break;
      default:
        log("unknown test action " + action);
    }
  };
}
