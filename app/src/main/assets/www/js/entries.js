// The notebook's entries: the model (ids, active entry) and the view that builds each entry's
// textarea and output. User interaction is reported through a small hooks interface set by
// `app.js`. This module never imports the evaluator, the editor or the assist, so its
// dependencies point one way (view -> runtime + plot/render helpers).

import { currentEvaluation, isCurrentEvaluation } from "./evaluation-generation.js";
import { newCellId } from "./notebook-model.js";
import { displayTitle } from "./notebook-name.js";
import * as WoxiPlot from "./plot-interact.js";
import * as WoxiRender from "./render-output.js";
import { el, els, nativeCall, runtime, state, toast } from "./runtime.js";
import { ensureSession } from "./session.js";

const hooks = {
  onActive: function (entry) {},
  onFocus: function (entry) {},
  onInput: function (entry) {},
  onBeforeInput: function (entry, event) {},
  onBlur: function () {},
  onSubmit: function () {},
  onUndo: function () {},
  onRedo: function () {},
  attachPlots: function (entry, items, seed) {},
  onManipulate: function (entry) {},
};

const MAX_INPUT_HEIGHT_RATIO = 0.45;
const TEXTAREA_BORDER = 2;
const SCROLL_MARGIN_TOP = 60;
const SCROLL_MARGIN_BOTTOM = 12;
const SCROLL_DELAY_MS = 30;
const MANIPULATE_DEBOUNCE_MS = 70;

// `revealCaret` recycles the focus to scroll the field. The focus and blur events that
// causes are not a change of entry, so they must not run the app's focus work.
let revealingEntry = null;

// Installs the behavior the view reports to. Called once by the app's boot.
export function setHooks(next) {
  Object.assign(hooks, next);
}

export function addEntry(input, options) {
  const entry = {
    id: state.nextId++,
    cellId: options?.cellId || newCellId(),
    evalToken: 0,
    input: input || "",
    evaluatedInput: null,
    dom: null,
    output: "",
    items: null,
    executionCount: null,
    widgets: [],
  };
  const index = options?.index ?? state.entries.length;
  state.entries.splice(index, 0, entry);
  if (options?.render !== false) renderNotebook();
  return entry;
}

function entryById(id) {
  for (let i = 0; i < state.entries.length; i++) {
    if (state.entries[i].id === id) return state.entries[i];
  }
  return null;
}

export function activeEntry() {
  return entryById(state.activeId) || state.entries[state.entries.length - 1] || null;
}

// The caret and selection of an entry, preferring the live textarea selection when it
// owns the DOM focus. Every edit path reads this one function, so a command cannot
// disagree with the handles and the assist bar about where the caret is. The caret is
// the selection's start. There is no separate caret field to drift from it.
export function selectionOf(entry) {
  const input = entry.dom.input;
  const length = input.value.length;
  let selStart = entry.selStart;
  let selEnd = entry.selEnd;
  if (
    window.document.activeElement === input &&
    input.selectionStart !== null &&
    input.selectionStart !== undefined
  ) {
    selStart = input.selectionStart;
    selEnd = input.selectionEnd;
  }
  if (selStart === null || selStart === undefined) selStart = length;
  if (selEnd === null || selEnd === undefined) selEnd = selStart;
  selStart = Math.max(0, Math.min(selStart, length));
  selEnd = Math.max(selStart, Math.min(selEnd, length));
  return { caret: selStart, selStart: selStart, selEnd: selEnd };
}

// Stores a selection on the entry model. Writers clamp once here, so the textarea and
// the model cannot disagree about a range past the end of the text.
export function setEntrySelection(entry, start, end) {
  const length = entry.dom ? entry.dom.input.value.length : 0;
  start = Math.max(0, Math.min(start, length));
  end = Math.max(start, Math.min(end, length));
  entry.selStart = start;
  entry.selEnd = end;
  return { start: start, end: end };
}

export function setActive(entry) {
  state.activeId = entry ? entry.id : null;
  refreshClasses();
  hooks.onActive(entry);
}

function refreshClasses() {
  for (let i = 0; i < state.entries.length; i++) {
    const entry = state.entries[i];
    if (!entry.dom) continue;
    entry.dom.root.className =
      entry.id === state.activeId ? "woxi-entry woxi-active" : "woxi-entry";
    entry.dom.num.textContent = String(i + 1);
  }
}

// Grows an entry's input box to fit its content.
// The box is collapsed first: `scrollHeight` is only the content height when the
// element itself is not taller than its content, otherwise it reports the element's
// own height and wrapped lines get clipped. The 2px covers the 1px borders, which
// `scrollHeight` excludes but `box-sizing: border-box` counts.
export function autoGrow(textarea) {
  if (!textarea || !textarea.parentNode) return;
  const maxHeight = Math.round(window.innerHeight * MAX_INPUT_HEIGHT_RATIO);
  textarea.style.height = "0px";
  const contentHeight = textarea.scrollHeight;
  const height = Math.min(contentHeight + TEXTAREA_BORDER, maxHeight);
  textarea.style.height = height + "px";
  textarea.style.overflowY = contentHeight + TEXTAREA_BORDER > maxHeight ? "auto" : "hidden";
}

export function renderNotebook() {
  // What each entry's plots are showing, before their elements go: the samples and the scene
  // belong to the engine handle, not to the markup, and a rebuild must not drop them.
  const seeds = [];
  for (let s = 0; s < state.entries.length; s += 1) {
    const previous = state.entries[s].dom;
    seeds.push(previous ? WoxiPlot.seedsOf(previous.output) : []);
  }
  // Detach the plot controllers first, but release their handles only after the
  // rebuilt plots have attached: a handle is dropped when its last controller goes
  // away, and the rebuilt markup addresses the same handle.
  const stale = WoxiPlot.detach(els.notebook);
  els.notebook.innerHTML = "";
  for (let i = 0; i < state.entries.length; i++) {
    els.notebook.appendChild(buildEntry(state.entries[i]));
  }
  refreshClasses();
  // Outputs are stored as HTML, so re-rendering the list restores them.
  // The Manipulate controls need their listeners attached again.
  for (let w = 0; w < state.entries.length; w += 1) {
    const entry = state.entries[w];
    if (entry.dom) wireManipulate(entry.dom.root, entry);
  }
  // Plots too: their listeners cannot live in HTML, and the elements are new. The seeds keep
  // the samples and the scene, so a rebuilt plot is drawn at once instead of waiting for a
  // gesture to ask for them again.
  for (let p = 0; p < state.entries.length; p++) {
    const entry = state.entries[p];
    if (entry.dom) hooks.attachPlots(entry, null, seeds[p]);
  }
  WoxiPlot.release(stale, els.notebook);
  // A rebuilt output is fresh DOM. Fit its static graphics now. A plot's scene is left
  // alone by fitGraphics, and the font pass in boot runs again after the faces load.
  for (let f = 0; f < state.entries.length; f += 1) {
    const entry = state.entries[f];
    if (entry.dom) WoxiRender.fitGraphics(entry.dom.output);
  }
  // Rebuilt textareas start at one line. Grow them to fit their content again.
  autoGrowAll();
}

function buildEntry(entry) {
  const root = el("div", "woxi-entry");
  const num = el("div", "woxi-entry-num", "");
  const main = el("div", "woxi-entry-main");
  const input = document.createElement("textarea");
  input.className = "woxi-entry-input";
  input.value = entry.input;
  input.rows = 1;
  input.spellcheck = false;
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.setAttribute("autocorrect", "off");
  input.setAttribute("inputmode", "none"); // the app brings its own keyboard
  input.addEventListener("focus", function () {
    // `revealCaret` recycles the focus to scroll the caret into view. That is not a change
    // of entry, so it must not re-run the app's focus work for every key.
    if (revealingEntry === entry) return;
    setActive(entry);
    autoGrow(input);
    hooks.onFocus(entry);
  });
  // Only real input (a hardware keyboard, a system paste) reaches these. Programmatic
  // edits are recorded by the helpers that make them. The event says what kind of edit it
  // is, so a hardware deletion is an undo step of the same kind as the Backspace key.
  input.addEventListener("beforeinput", function (event) {
    hooks.onBeforeInput(entry, event);
  });
  input.addEventListener("input", function () {
    entry.input = input.value;
    entry.selStart = input.selectionStart;
    entry.selEnd = input.selectionEnd;
    // A hardware key is recorded by `beforeinput`, which cannot know where the edit
    // ends. The caret it left is known now, so the next key joins its word. A paste or
    // replacement leaves `lastEdit.merge` false. Do not let this event make it joinable.
    if (entry.lastEdit && entry.lastEdit.merge) entry.lastEdit.caret = input.selectionStart;
    autoGrow(input);
    hooks.onInput(entry);
  });
  // A blur fires before the tap that caused it completes, so the bar is refreshed
  // after both have run: a key press must land on the keys it was aimed at.
  input.addEventListener("blur", function () {
    if (revealingEntry !== entry) hooks.onBlur();
  });
  input.addEventListener("keydown", function (event) {
    // One history, not two. Chrome's native undo would leave the bar's Undo/Redo
    // describing text that is no longer in the field, and the in-app keys step the app's
    // stack, so the hardware shortcuts step it too.
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) hooks.onRedo();
        else hooks.onUndo();
        return;
      }
      if (key === "y" && !event.shiftKey) {
        event.preventDefault();
        hooks.onRedo();
        return;
      }
    }
    // Tab must not take the focus out of the field: the keys and the sheet rows are
    // commands, and a focused key draws no caret and swallows the next letter.
    if (event.key === "Tab") {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      hooks.onSubmit();
    }
  });
  const output = el("div", "woxi-entry-output");
  output.innerHTML = entry.output || "";

  main.appendChild(input);
  main.appendChild(output);
  root.appendChild(num);
  root.appendChild(main);

  entry.dom = { root: root, num: num, input: input, output: output };
  // A rebuilt box starts with its caret at the end of the text. Put the entry's own
  // selection back, so a rebuild leaves the caret where the user left it.
  let selStart = entry.selStart;
  let selEnd = entry.selEnd;
  if (selStart === null || selStart === undefined || selStart > input.value.length) {
    selStart = input.value.length;
  }
  if (selEnd === null || selEnd === undefined) selEnd = selStart;
  selStart = Math.max(0, Math.min(selStart, input.value.length));
  selEnd = Math.max(selStart, Math.min(selEnd, input.value.length));
  entry.selStart = selStart;
  entry.selEnd = selEnd;
  input.setSelectionRange(selStart, selEnd);
  return root;
}

export function autoGrowAll() {
  for (let i = 0; i < state.entries.length; i++) {
    const entry = state.entries[i];
    if (entry.dom) autoGrow(entry.dom.input);
  }
}

export function updateTitle() {
  const dirty = runtime.isDirty ? runtime.isDirty() : false;
  els.title.textContent = (dirty ? "\u2022 " : "") + displayTitle(state.fileName);
}

export function showBusy(entry, busy) {
  if (!entry.dom) return;
  const existing = entry.dom.output.querySelector(".woxi-busy-wrap");
  if (busy) {
    if (existing) return;
    const wrap = el("div", "woxi-busy-wrap");
    wrap.appendChild(el("div", "woxi-busy"));
    entry.dom.output.appendChild(wrap);
  } else if (existing) {
    existing.parentNode.removeChild(existing);
  }
}

export function wireManipulate(container, entry) {
  const blocks = container.querySelectorAll(".woxi-manipulate");
  for (let i = 0; i < blocks.length; i++) {
    wireManipulateBlock(blocks[i], entry);
  }
}

function wireManipulateBlock(block, entry) {
  const body = block.getAttribute("data-woxi-body") || "";
  const itemIndex = Number(block.getAttribute("data-woxi-item"));
  const view = block.querySelector(".woxi-manipulate-view");
  const controls = block.querySelectorAll("[data-woxi-control]");
  if (!view || !controls.length) return;

  function bindings() {
    const values = {};
    for (let i = 0; i < controls.length; i++) {
      const control = controls[i];
      const name = control.getAttribute("data-woxi-control");
      if (control.type === "checkbox") {
        values[name] = control.checked ? "True" : "False";
      } else {
        values[name] = control.value;
      }
      const readout = block.querySelector('[data-woxi-value="' + name + '"]');
      if (readout && control.type === "range") readout.textContent = control.value;
    }
    return values;
  }

  let timer = null;
  function syncControlState() {
    for (let i = 0; i < controls.length; i += 1) {
      const control = controls[i];
      if (control.type === "checkbox") {
        if (control.checked) control.setAttribute("checked", "");
        else control.removeAttribute("checked");
      } else if (control.tagName === "SELECT") {
        for (let j = 0; j < control.options.length; j += 1) {
          if (j === control.selectedIndex) control.options[j].setAttribute("selected", "");
          else control.options[j].removeAttribute("selected");
        }
      } else {
        control.setAttribute("value", control.value);
      }
    }
  }

  async function refreshView(generation) {
    const current = bindings();
    if (!body) return;
    try {
      await ensureSession();
      if (!isCurrentEvaluation(generation)) return;
      const json = await runtime.engine.manipulate(body, current);
      if (!isCurrentEvaluation(generation)) return;
      let parsed = null;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        parsed = null;
      }
      if (!parsed || (!parsed.svg && !parsed.text)) return;
      view.innerHTML = WoxiRender.manipulateView(parsed);
      WoxiRender.fitGraphics(view);
      if (entry && Number.isInteger(itemIndex)) {
        syncControlState();
        entry.widgets[itemIndex] = { values: current, view: parsed };
        entry.output = WoxiPlot.markupOf(entry.dom.output);
        hooks.onManipulate(entry);
      }
    } catch (err) {
      if (isCurrentEvaluation(generation)) toast(err instanceof Error ? err.message : String(err));
    }
  }
  function update() {
    if (timer) clearTimeout(timer);
    const generation = currentEvaluation();
    timer = setTimeout(function () {
      void refreshView(generation);
    }, MANIPULATE_DEBOUNCE_MS);
  }

  for (let i = 0; i < controls.length; i++) {
    const control = controls[i];
    if (control.tagName === "SELECT") control.addEventListener("change", update);
    else control.addEventListener("input", update);
  }
  // Align the readouts with the values Woxi itself reported as initial state.
  for (let j = 0; j < controls.length; j++) {
    const readout = block.querySelector(
      '[data-woxi-value="' + controls[j].getAttribute("data-woxi-control") + '"]'
    );
    if (readout && controls[j].type === "range") readout.textContent = controls[j].value;
  }
}

export function focusEntry(entry) {
  if (!entry || !entry.dom) return;
  setActive(entry);
  focusInput(entry);
}

// Gives the entry the caret. Two things have to line up, and only the first one is the
// web layer's to keep: the field holds the DOM focus, so the next key, the selection and
// the assist bar all speak about this entry, and the window has the focus, without which
// the field draws no caret whatever its DOM state. The WebView takes the window focus only
// when a finger lands in it, so the shell is asked for it whenever it is missing.
export function focusInput(entry) {
  if (!entry || !entry.dom) return;
  const input = entry.dom.input;
  const hadWindowFocus = document.hasFocus();
  if (document.activeElement !== input) input.focus({ preventScroll: true });
  if (!hadWindowFocus) nativeCall("focusWebView");
}

// A textarea scrolls to the caret when the user types into it and when it is focused, but
// a command that writes the value and then places the caret gets neither: a key pressed
// past the last visible line leaves the caret below the box, in a field that is scrolled
// to its start. Recycling the focus is how the native code is asked to bring the caret
// back. `preventScroll` must stay off here, since it also cancels the scroll inside the
// field. Only a field that is focused and whose content overflows has anything to reveal,
// and the native scroll is minimal, so a caret that is already on screen stays put.
export function revealCaret(entry) {
  if (!entry || !entry.dom) return;
  const input = entry.dom.input;
  if (document.activeElement !== input) return;
  if (input.scrollHeight <= input.clientHeight + TEXTAREA_BORDER) return;
  revealingEntry = entry;
  input.blur();
  input.focus();
  revealingEntry = null;
}

export function scrollEntryIntoView(entry) {
  if (!entry || !entry.dom) return;
  setTimeout(function () {
    const rect = entry.dom.root.getBoundingClientRect();
    const keyboard = document.getElementById("woxi-keyboard");
    const keyboardTop = keyboard ? keyboard.getBoundingClientRect().top : window.innerHeight;
    const visibleBottom = keyboardTop > 0 ? keyboardTop : window.innerHeight;
    if (rect.top < SCROLL_MARGIN_TOP || rect.bottom > visibleBottom - SCROLL_MARGIN_BOTTOM) {
      entry.dom.root.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, SCROLL_DELAY_MS);
}
