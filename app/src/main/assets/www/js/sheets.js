// The modal sheet over the notebook: a title, a body built by the caller, and buttons that
// close it and run their command. Menu and Options are just callers of this component.

import { activeEntry, focusInput } from "./entries.js";
import { el, els, keepFocus } from "./runtime.js";

// A sheet-to-sheet command closes the current sheet and opens the next one. The close path
// restores focus in a deferred task. That task must not focus the entry behind the new
// sheet. Each open/close advances this token, and a close only restores focus if no newer
// sheet operation happened in the meantime.
let sheetGeneration = 0;

export function openSheet(title, build) {
  sheetGeneration += 1;
  els.sheetTitle.textContent = title;
  els.sheetBody.innerHTML = "";
  build(els.sheetBody);
  els.overlay.className = "";
  // The sheet is modal: the entry behind it must not keep taking text from a hardware
  // keyboard while the keystrokes are invisible. (Blurring also drops the IME connection,
  // which a focused field keeps even with `inputmode="none"`, so a physical key cannot be
  // committed into the hidden field.) The caret comes back with `closeSheet`.
  const entry = activeEntry();
  if (entry && entry.dom) entry.dom.input.blur();
}

export function closeSheet() {
  sheetGeneration += 1;
  const closeGeneration = sheetGeneration;
  const entry = activeEntry();
  const active = window.document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== (entry && entry.dom.input) &&
    typeof active.blur === "function"
  ) {
    active.blur();
  }
  els.overlay.className = "woxi-hidden";
  // A sheet is opened over an entry and never takes the caret for itself (see keepFocus),
  // so whatever made the field lose the focus - the native file picker, the window going
  // away - is repaired on the way out. Deferred by a task: Escape closes the sheet from a
  // keydown, and its default action (which runs after the handler) would blur the field
  // that was just focused. The active entry is read when the task runs, so a command that
  // closed the sheet and then moved elsewhere (go to definition) is not dragged back.
  setTimeout(function () {
    if (sheetGeneration !== closeGeneration) return;
    const entryNow = activeEntry();
    if (entryNow) focusInput(entryNow);
  }, 0);
}

export function sheetButton(label, hint, handler, options) {
  const btn = el("button", "woxi-sheet-item");
  btn.type = "button";
  if (options && options.danger) btn.classList.add("woxi-sheet-item-danger");
  keepFocus(btn);
  btn.appendChild(el("span", null, label));
  if (hint) btn.appendChild(el("small", null, hint));
  btn.addEventListener("click", function () {
    closeSheet();
    void handler();
  });
  return btn;
}
