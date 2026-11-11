// Theme selection: the CSS variables, the native window and the interpreter's typesetting
// all follow one resolved light/dark mode. Changing the mode re-evaluates what is already
// on screen because typeset SVGs carry their colors.

import { persist } from "./documents.js";
import { evaluateAll } from "./evaluation.js";
import { nativeCall, state } from "./runtime.js";

const DARK_QUERY = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let appliedTheme = null;

// Follow the device setting while the user has chosen 'system'.
if (DARK_QUERY) {
  const onSystemThemeChange = function () {
    if (state.settings.theme === "system") setTheme("system");
  };
  if (DARK_QUERY.addEventListener) DARK_QUERY.addEventListener("change", onSystemThemeChange);
  else if (DARK_QUERY.addListener) DARK_QUERY.addListener(onSystemThemeChange);
}

export function resolveTheme(mode) {
  if (mode === "light" || mode === "dark") return mode;
  return DARK_QUERY && DARK_QUERY.matches ? "dark" : "light";
}

export function setTheme(mode) {
  state.settings.theme = mode;
  const resolved = resolveTheme(mode);
  const changed = appliedTheme !== null && appliedTheme !== resolved;
  appliedTheme = resolved;
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
