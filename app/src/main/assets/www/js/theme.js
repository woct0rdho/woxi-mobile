// Theme selection: the CSS variables, the native window and the interpreter's typesetting
// all follow one resolved light/dark mode. Changing the mode re-evaluates what is already
// on screen because typeset SVGs carry their colors.

import { evaluateAll } from "./evaluation.js";
import { persist } from "./notebook-store.js";
import { nativeCall, state } from "./runtime.js";

const DARK_QUERY = window.matchMedia("(prefers-color-scheme: dark)");

// Follow the device setting while the user has chosen 'system'.
const onSystemThemeChange = function () {
  if (state.settings.theme === "system") setTheme("system");
};
DARK_QUERY.addEventListener("change", onSystemThemeChange);

export function resolveTheme(mode) {
  if (mode === "light" || mode === "dark") return mode;
  return DARK_QUERY.matches ? "dark" : "light";
}

export function setTheme(mode) {
  state.settings.theme = mode;
  const resolved = resolveTheme(mode);
  const previous = window.document.documentElement.getAttribute("data-theme");
  const changed = previous !== null && previous !== resolved;
  window.document.documentElement.setAttribute("data-theme", resolved);
  nativeCall("setTheme", resolved);
  persist();
  if (
    changed &&
    state.entries.some(function (entry) {
      return entry.output;
    })
  ) {
    void evaluateAll();
  }
}
