// Theme selection: the CSS variables, the native window and the interpreter's typesetting
// all follow one resolved light/dark mode. Changing the mode re-evaluates what is already
// on screen because typeset SVGs carry their colors.

import { evaluateAll } from "./evaluation.js";
import { log, nativeCall, state } from "./runtime.js";

const DARK_QUERY = window.matchMedia("(prefers-color-scheme: dark)");
const SETTINGS_KEY = "woxi.settings";
const THEMES = ["system", "light", "dark"];

// The inline script in index.html resolves the saved mode before first paint. This is the
// own, validated read used once the module graph is ready.
export function loadThemeMode() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "null");
    if (saved && THEMES.indexOf(saved.theme) >= 0) return saved.theme;
  } catch (err) {
    // Settings are optional.
  }
  return "system";
}

function persistSettings() {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (err) {
    log("settings persist failed: " + (err instanceof Error ? err.message : String(err)));
  }
}

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
  persistSettings();
  if (
    changed &&
    state.entries.some(function (entry) {
      return entry.output;
    })
  ) {
    void evaluateAll();
  }
}
