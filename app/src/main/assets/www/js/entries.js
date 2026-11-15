// The notebook's entries: the model (ids, active entry) and the view that builds each entry's
// textarea and output. User interaction is reported through a small hooks interface set by
// `app.js`. This module never imports the evaluator, the editor or the assist, so its
// dependencies point one way (view -> runtime + plot/render helpers).

import * as WoxiPlot from "./plot-interact.js";
import * as WoxiRender from "./render-output.js";
import { el, els, nativeCall, runtime, state, toast } from "./runtime.js";

const hooks = {
  onActive: function (entry) {},
  onFocus: function (entry) {},
  onInput: function (entry) {},
  onBeforeInput: function (entry, event) {},
  onBlur: function () {},
  onSelection: function (entry) {},
  onSubmit: function () {},
  onUndo: function () {},
  onRedo: function () {},
  attachPlots: function (entry, items, seed) {},
};

// Installs the behavior the view reports to. Called once by the app's boot.
export function setHooks(next) {
  Object.assign(hooks, next);
}

export function addEntry(input, options) {
  const entry = {
    id: state.nextId++,
    input: input || "",
    caret: null,
    collapsed: false,
    dom: null,
    output: "",
  };
  const index = options?.index ?? state.entries.length;
  state.entries.splice(index, 0, entry);
  renderNotebook();
  return entry;
}

export function entryById(id) {
  for (let i = 0; i < state.entries.length; i++) {
    if (state.entries[i].id === id) return state.entries[i];
  }
  return null;
}

export function activeEntry() {
  return entryById(state.activeId) || state.entries[state.entries.length - 1] || null;
}

export function setActive(entry) {
  state.activeId = entry ? entry.id : null;
  refreshClasses();
  hooks.onActive(entry);
}

export function refreshClasses() {
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
  const maxHeight = Math.round(window.innerHeight * 0.45);
  textarea.style.height = "0px";
  const contentHeight = textarea.scrollHeight;
  const height = Math.min(contentHeight + 2, maxHeight);
  textarea.style.height = height + "px";
  textarea.style.overflowY = contentHeight + 2 > maxHeight ? "auto" : "hidden";
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
  wireManipulate(els.notebook);
  // Plots too: their listeners cannot live in HTML, and the elements are new. The seeds keep
  // the samples and the scene, so a rebuilt plot is drawn at once instead of waiting for a
  // gesture to ask for them again.
  for (let p = 0; p < state.entries.length; p++) {
    const entry = state.entries[p];
    if (entry.dom) hooks.attachPlots(entry, null, seeds[p]);
  }
  WoxiPlot.release(stale, els.notebook);
  // Rebuilt textareas start at one line. Grow them to fit their content again.
  autoGrowAll();
}

export function buildEntry(entry) {
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
    if (entry.revealing) return;
    setActive(entry);
    nativeCall("hideKeyboard");
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
    entry.caret = input.selectionStart;
    entry.selStart = input.selectionStart;
    entry.selEnd = input.selectionEnd;
    // A hardware key is recorded by `beforeinput`, which cannot know where the edit
    // ends. The caret it left is known now, so the next key joins its word.
    entry.lastCaret = input.selectionStart;
    autoGrow(input);
    state.dirty = true;
    updateTitle();
    hooks.onInput(entry);
  });
  // A blur fires before the tap that caused it completes, so the bar is refreshed
  // after both have run: a key press must land on the keys it was aimed at.
  input.addEventListener("blur", function () {
    if (!entry.revealing) hooks.onBlur();
  });
  // The bar follows the native selection: a caret moved with the handle, a word picked by a
  // double tap, or a range dragged out is reported by one of these before the next key
  // reads it.
  ["keyup", "click", "select", "focus"].forEach(function (type) {
    input.addEventListener(type, function () {
      hooks.onSelection(entry);
    });
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
  // A rebuilt box starts with its caret at the end of the text. Put the entry's own caret
  // and selection back, so a rebuild (inserting, deleting or duplicating an entry) leaves
  // the caret where the user left it instead of at the end of the expression.
  if (entry.caret === null || entry.caret === undefined || entry.caret > input.value.length) {
    entry.caret = input.value.length;
  }
  let selStart =
    entry.selStart === null || entry.selStart === undefined ? entry.caret : entry.selStart;
  let selEnd = entry.selEnd === null || entry.selEnd === undefined ? entry.caret : entry.selEnd;
  selStart = Math.max(0, Math.min(selStart, input.value.length));
  selEnd = Math.max(selStart, Math.min(selEnd, input.value.length));
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
  els.title.textContent = (state.dirty ? "\u2022 " : "") + (state.title || "Untitled");
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

export function wireManipulate(container) {
  const blocks = container.querySelectorAll(".woxi-manipulate");
  for (let i = 0; i < blocks.length; i++) {
    wireManipulateBlock(blocks[i]);
  }
}

export function wireManipulateBlock(block) {
  const body = block.getAttribute("data-woxi-body") || "";
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
  async function refreshView() {
    const current = bindings();
    try {
      const json = await runtime.engine.manipulate(body, current);
      let parsed = null;
      try {
        parsed = JSON.parse(json);
      } catch (err) {
        parsed = null;
      }
      if (!parsed) return;
      if (parsed.svg) view.innerHTML = WoxiRender.svgTag(parsed.svg, "woxi-svg");
      else if (parsed.text) view.innerHTML = WoxiRender.escapeHtml(parsed.text);
      WoxiRender.fitGraphics(view);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  }
  function update() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () {
      void refreshView();
    }, 70);
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
  if (input.scrollHeight <= input.clientHeight + 2) return;
  entry.revealing = true;
  input.blur();
  input.focus();
  entry.revealing = false;
}

export function scrollEntryIntoView(entry) {
  if (!entry || !entry.dom) return;
  setTimeout(function () {
    const rect = entry.dom.root.getBoundingClientRect();
    if (rect.top < 60 || rect.bottom > window.innerHeight - 260) {
      entry.dom.root.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, 30);
}
