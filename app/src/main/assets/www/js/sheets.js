// The modal sheet over the notebook: a title, a body built by the caller, and buttons that
// close it and run their command. Menu and Options are just callers of this component.

import { activeEntry, focusInput } from "./entries.js";
import { el, els, keepFocus } from "./runtime.js";

export function openSheet(title, build) {
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
  els.overlay.className = "woxi-hidden";
  // A sheet is opened over an entry and never takes the caret for itself (see keepFocus),
  // so whatever made the field lose the focus - the native file picker, the window going
  // away - is repaired on the way out. Deferred by a task: Escape closes the sheet from a
  // keydown, and its default action (which runs after the handler) would blur the field
  // that was just focused. The active entry is read when the task runs, so a command that
  // closed the sheet and then moved elsewhere (go to definition) is not dragged back.
  setTimeout(function () {
    const entry = activeEntry();
    if (entry) focusInput(entry);
  }, 0);
}

export function sheetButton(label, hint, handler) {
  const btn = el("button", "woxi-sheet-item");
  btn.type = "button";
  keepFocus(btn);
  btn.appendChild(el("span", null, label));
  if (hint) btn.appendChild(el("small", null, hint));
  btn.addEventListener("click", function () {
    closeSheet();
    void handler();
  });
  return btn;
}
