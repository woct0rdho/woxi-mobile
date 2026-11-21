// The app's shared runtime: the notebook state every component edits, the elements boot
// fills in, and the services (engine, keyboard, assist) that come and go with the activity.
// This is deliberately not a place for behavior: components import the refs they need and
// own their functions. Anything that is not shared state or a DOM/bridge primitive belongs in
// one of the feature modules (`entries.js`, `evaluation.js`, `editor.js`, ...).

export const state = {
  fileName: null,
  entries: [],
  nextId: 1,
  activeId: null,
  settings: { theme: "system" },
  evaluating: false,
  sessionRestored: true,
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

// Refs to the activity's services, set once during boot. They live in an object rather
// than as module bindings because a module cannot assign an imported binding. A page
// reload builds a fresh page and a fresh set.
export const runtime = {
  engine: null,
  keyboard: null,
  assist: null,
  automation: false,
  isDirty: null,
};

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A button is a command, not a field. Left to itself a button takes the focus on press,
// which blurs the entry: its caret, its selection handles and the assist bar all switch
// to a control that has none. Cancelling the press keeps the focus where the text is
// going, and the click still arrives.
export function keepFocus(node) {
  if (!node) return node;
  node.addEventListener("mousedown", function (event) {
    event.preventDefault();
  });
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
    return bridge[name](...args);
  } catch (err) {
    if (window.console) window.console.log("[woxi] native " + name + " failed: " + err.message);
    return undefined;
  }
}

// A checked invocation for operations whose failure must change the caller's control flow.
// `nativeCall` above is for optional UI services. Autosave must not treat a bridge error as
// a durable write.
export function nativeCallOk(name, ...args) {
  const bridge = window.WoxiNative;
  if (!bridge) return false;
  try {
    bridge[name](...args);
    return true;
  } catch (err) {
    if (window.console) {
      window.console.log("[woxi] native " + name + " failed: " + err.message);
    }
    return false;
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
const TOAST_MS = 1900;
export function toast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.className = "";
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    els.toast.className = "woxi-hidden";
  }, TOAST_MS);
}
