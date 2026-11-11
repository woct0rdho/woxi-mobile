// The app's shared runtime: the document state every component edits, the elements boot
// fills in, and the services (engine, keyboard, assist) that come and go with the activity.
// This is deliberately not a place for behavior: components import the refs they need and
// own their functions. Anything that is not shared state or a DOM/bridge primitive belongs in
// one of the feature modules (`entries.js`, `evaluation.js`, `editor.js`, ...).

export const state = {
  title: "Untitled",
  fileName: null,
  dirty: false,
  entries: [],
  nextId: 1,
  activeId: null,
  settings: { theme: "system" },
  evaluating: false,
};

// Elements boot resolves once. Every feature reads them from here.
export const els = {
  notebook: null,
  title: null,
  overlay: null,
  sheetTitle: null,
  sheetBody: null,
  toast: null,
  splash: null,
};

// Refs to the activity's services. They are replaced when the engine restarts or the
// keyboard is bound, so they live in an object rather than as module bindings.
export const runtime = {
  engine: null,
  keyboard: null,
  assist: null,
};

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Calls a method on the injected Java object. The object is a proxy, so the
// method must be invoked directly (`.apply`/`typeof` checks do not work on it)
// and a failure inside the error path must not re-enter this function.
/**
 * @param {string} name
 * @param {...any} args
 */
export function nativeCall(name, ...args) {
  const bridge = window.WoxiNative;
  if (!bridge) return undefined;
  try {
    switch (args.length) {
      case 0:
        return bridge[name]();
      case 1:
        return bridge[name](args[0]);
      case 2:
        return bridge[name](args[0], args[1]);
      case 3:
        return bridge[name](args[0], args[1], args[2]);
      default:
        return undefined;
    }
  } catch (err) {
    if (window.console) window.console.log("[woxi] native " + name + " failed: " + err.message);
    return undefined;
  }
}

export function log(message) {
  const bridge = window.WoxiNative;
  if (bridge) {
    try {
      bridge.log(String(message));
      return;
    } catch (err) {
      // fall through to the console
    }
  }
  if (window.console) window.console.log("[woxi] " + message);
}

// A failure while the UI is being built leaves the splash screen up with no other
// trace, so it is reported like any other log line.
window.addEventListener("error", function (event) {
  log(
    "error: " +
      event.message +
      " at " +
      (event.filename || "?") +
      ":" +
      event.lineno +
      ":" +
      event.colno
  );
});
window.addEventListener("unhandledrejection", function (event) {
  const reason = event.reason;
  log("unhandled rejection: " + (reason && reason.message ? reason.message : String(reason)));
});

let toastTimer = null;
export function toast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.className = "";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    els.toast.className = "woxi-hidden";
  }, 1900);
}
