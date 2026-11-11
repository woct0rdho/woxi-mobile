// The modal sheet over the notebook: a title, a body built by the caller, and buttons that
// close it and run their command. Menu and Options are just callers of this component.

import { el, els, nativeCall } from "./runtime.js";

export function openSheet(title, build) {
  els.sheetTitle.textContent = title;
  els.sheetBody.innerHTML = "";
  build(els.sheetBody);
  els.overlay.className = "";
  nativeCall("setBackHandlerActive", true);
}

export function closeSheet() {
  els.overlay.className = "woxi-hidden";
  nativeCall("setBackHandlerActive", false);
}

export function sheetButton(label, hint, handler) {
  const btn = el("button", "woxi-sheet-item");
  btn.type = "button";
  btn.appendChild(el("span", null, label));
  if (hint) btn.appendChild(el("small", null, hint));
  btn.addEventListener("click", function () {
    closeSheet();
    void handler();
  });
  return btn;
}
