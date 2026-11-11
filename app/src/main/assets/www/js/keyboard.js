// In-app math keyboard.
//
// Labels show the Wolfram Language text a key inserts. A key whose label is a Wolfram
// function inserts that call with empty brackets and the caret inside (`Sin` -> `Sin[|]`).
// Holding such a key inserts the call with every slot named (`Plot[f, {x, -5, 5}]`),
// wrapping the selection, or the operand at the caret, as the first argument. With a
// selection, a short press replaces it with the call. The extra structure a call needs
// lives in the input assist (`prototypes.js`), not in the key.
//
// Keys that are letters, digits, operators or constants insert exactly their label, and
// action keys (Eval, Backspace, the bar commands) act on the entry. Vertical swipes
// change the level (letters / math / plot 2D / plot 3D). Sideways swipes move inside a
// level - left shows the functions page, right the scripting page - and every page keeps
// four key rows, so the keyboard height never changes.
//
// Key shape: a `KeySpec` (see `types.js`). `insert` uses `|` to mark the caret.

import { BARS, EXAMPLES, NEXT, OPPOSITE, PAGES } from "./keyboard-pages.js";

const SWIPE_MIN = 26; // px before a drag counts as a swipe
const SLIDE_MS = 90; // how long a flick takes to slide a page in
const COMMIT_RATIO = 0.3; // ... or the drag covered this much of the viewport
const FLICK_SPEED = 0.4; // px/ms that commits a short, fast drag
const RUBBER = 0.35; // how far the pages follow a swipe at the end of an axis
const SHIFT_DOUBLE_TAP = 450; // ms, two taps within this window lock shift
const LONG_PRESS_MS = 380; // ms before a held key fires its second action
const LONG_PRESS_SLOP = 10; // px of movement that turns a hold into a swipe
const SHIFT_GLYPH = "\u21E7"; // hollow arrow: arms one capital
const SHIFT_GLYPH_LOCKED = "\u2B06"; // filled arrow: caps lock
const SHIFT_OFF = 0;
const SHIFT_ONESHOT = 1; // affects the next key only
const SHIFT_LOCKED = 2; // stays on, like caps lock
let suppressClicksUntil = 0; // a swipe must not also press the key under the finger

// Splits 'Sin[|]' into the text to insert and the caret offset from the end.
// A backslash escapes the marker, so '\\|' inserts a literal `|` - the Alternatives
// key needs one, and without the escape the marker inside it would swallow the key.
function parseInsert(spec) {
  let marker = -1;
  for (let i = 0; i < spec.length; i++) {
    if (spec.charAt(i) === "\\") {
      i++;
      continue;
    }
    if (spec.charAt(i) === "|") {
      marker = i;
      break;
    }
  }
  const head = marker < 0 ? spec : spec.slice(0, marker);
  const tail = marker < 0 ? "" : spec.slice(marker + 1);
  const after = tail.replace(/\\\|/g, "|");
  return { text: (head + after).replace(/\\\|/g, "|"), caret: after.length };
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Shift changes what a key shows and inserts: on the letters page letters become
// capitals, `\u03B8` becomes `\u03C6`, and the symbol keys switch to their paired operator
// (`;` -> `;;`, `_` -> `__`, `/.` -> `//.`, `{ }` -> `<| |>` hmm see the table). Keys on
// the other pages carry no shifted form, so shift leaves them alone.
function labelFor(key, shifted) {
  if (!shifted) return key.label;
  if (key.shiftLabel) return key.shiftLabel;
  return /^[a-z]$/.test(key.label) ? key.label.toUpperCase() : key.label;
}

// The insert spec of a key for the current shift state (see parseInsert).
function insertFor(key, shifted) {
  if (shifted && key.shiftInsert !== undefined) return key.shiftInsert;
  if (key.insert !== undefined) return key.insert;
  return labelFor(key, shifted);
}

// Watches one surface: a drag first has to leave a small dead zone, from there on the
// pages follow the finger, and the release decides between finishing the transition and
// springing back (see beginSlide/moveSlide/endSlide).
// One finger owns the gesture. Extra fingers are ignored.
Keyboard.prototype.watch = function (view, surface) {
  const self = this;
  let active = null; // identifier of the finger that owns the gesture
  let dir = null,
    startX = 0,
    startY = 0;

  const touchById = function (list, id) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === id) return list[i];
    }
    return null;
  };

  view.addEventListener(
    "touchstart",
    function (event) {
      // The finger that owned the gesture is gone without a touchend (lost event, system
      // gesture): finish its slide instead of leaving the pad dead until a restart.
      if (active !== null && !touchById(event.touches, active)) {
        active = null;
        dir = null;
        if (self.slide) self.finishSlide(false);
      }
      if (active !== null || event.changedTouches.length !== 1) return;
      // Recover the same way when a slide was left behind without a finger on it.
      if (self.slide) {
        if (self.slide.animating) return;
        self.finishSlide(false);
      }
      const t = event.changedTouches[0];
      active = t.identifier;
      startX = t.clientX;
      startY = t.clientY;
      dir = null;
    },
    { passive: true }
  );
  view.addEventListener(
    "touchmove",
    function (event) {
      if (active === null) return;
      const t = touchById(event.touches, active); // only the finger that started it counts
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!dir) {
        if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;
        const horizontal = Math.abs(dx) > Math.abs(dy);
        if (surface === "bar" && !horizontal) return; // the bar only slides sideways
        dir = horizontal ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
        suppressClicksUntil = Date.now() + 400; // the drag must not press a key
        self.beginSlide(surface, dir);
      }
      const along = dir === "left" || dir === "right" ? dx : dy;
      const progress = dir === "left" || dir === "up" ? -along : along;
      self.moveSlide(progress, Date.now());
    },
    { passive: true }
  );
  const release = function (event) {
    if (active === null) return;
    if (!touchById(event.changedTouches, active)) return; // another finger lifted
    active = null;
    dir = null;
    if (self.slide) self.endSlide(Date.now());
  };
  view.addEventListener("touchend", release, { passive: true });
  view.addEventListener("touchcancel", release, { passive: true });
};

// transitions

Keyboard.prototype.viewOf = function (surface) {
  return surface === "bar" ? this.barView : this.padView;
};

Keyboard.prototype.layerOf = function (surface) {
  return surface === "bar" ? this.actionsEl : this.keysEl;
};

// The page a swipe in `dir` would show, or null when the axis ends here (the bar loops,
// so it always has a target). Mirrors applySwipe/applyBarSwipe without changing state.
Keyboard.prototype.peek = function (surface, dir) {
  if (surface === "bar") {
    if (dir !== "left" && dir !== "right") return null;
    const count = BARS.length;
    return (this.barPage + (dir === "left" ? 1 : count - 1)) % count;
  }
  if (this.back && this.back.dir === OPPOSITE[dir]) return this.back.page;
  return NEXT[this.pageId][dir] || null;
};

// Prepares a transition: the incoming page is built into a layer that waits off-view.
Keyboard.prototype.beginSlide = function (surface, dir) {
  const target = this.peek(surface, dir);
  const axis = dir === "left" || dir === "right" ? "x" : "y";
  const box = this.viewOf(surface).getBoundingClientRect();
  const layer = el(
    "div",
    surface === "bar"
      ? "woxi-kb-slide woxi-kb-actions woxi-kb-incoming"
      : "woxi-kb-slide woxi-kb-keys woxi-kb-incoming"
  );
  this.slide = {
    surface: surface,
    dir: dir,
    axis: axis,
    target: target,
    forward: dir === "left" || dir === "up",
    size: axis === "x" ? box.width : box.height,
    progress: 0,
    velocity: 0,
    lastProgress: 0,
    lastTime: Date.now(),
    startTime: Date.now(),
    animating: false,
    current: this.layerOf(surface),
    incoming: null,
    timer: 0,
  };
  if (target !== null) {
    if (surface === "bar") this.buildBar(target, layer);
    else this.buildPage(target, layer);
    this.viewOf(surface).appendChild(layer);
    this.slide.incoming = layer;
  }
  this.viewOf(surface).classList.add("woxi-kb-dragging");
  this.updateSlideTransform();
  // Commit the off-viewport position to the layout. Without this flush a fast flick
  // (touch start and end inside one frame) would place the incoming page in view at
  // once instead of sliding it in, so only one page would be visible.
  if (this.slide.incoming) void this.slide.incoming.offsetWidth;
  return target !== null;
};

// Places the two layers for the current progress. At the end of an axis it only pulls.
Keyboard.prototype.updateSlideTransform = function () {
  const slide = this.slide;
  if (!slide) return;
  const progress = slide.target === null ? slide.progress * RUBBER : slide.progress;
  const fn = slide.axis === "x" ? "translateX(" : "translateY(";
  // The two layers move in opposite directions: the current page leaves toward the
  // swipe direction, the incoming one arrives from the far edge (and both are on screen
  // while the transition runs).
  const current = slide.forward ? -progress : progress;
  const incoming = slide.forward ? slide.size - progress : progress - slide.size;
  slide.current.style.transform = fn + current + "px)";
  if (slide.incoming) slide.incoming.style.transform = fn + incoming + "px)";
};

Keyboard.prototype.moveSlide = function (progress, time) {
  const slide = this.slide;
  if (!slide) return;
  const dt = Math.max(1, time - slide.lastTime);
  slide.velocity = (progress - slide.lastProgress) / dt;
  slide.lastProgress = progress;
  slide.lastTime = time;
  slide.progress = Math.max(0, progress);
  this.updateSlideTransform();
};

// Release: finish the transition when the drag got far or fast enough, else spring back.
Keyboard.prototype.endSlide = function (time) {
  const slide = this.slide;
  if (!slide) return;
  const elapsed = Math.max(1, time - slide.startTime);
  const speed = Math.max(Math.abs(slide.velocity), Math.abs(slide.progress) / elapsed);
  const commit =
    slide.target !== null && (slide.progress > slide.size * COMMIT_RATIO || speed > FLICK_SPEED);
  if (commit) this.applySlideState();
  this.animateSlide(commit ? slide.size : 0, commit);
};

// Flick without a finger: the automation hooks drive the same path a tap-swipe does.
Keyboard.prototype.flick = function (surface, dir) {
  if (this.slide) this.finishSlide(false);
  if (!this.beginSlide(surface, dir)) return false;
  this.applySlideState();
  this.animateSlide(this.slide.size, true);
  return true;
};

// Applies the state change of the slide that is being committed.
Keyboard.prototype.applySlideState = function () {
  const slide = this.slide;
  if (slide.surface === "bar") this.barPage = slide.target;
  else this.applySwipe(slide.dir);
  this.slides = (this.slides || 0) + 1;
};

Keyboard.prototype.animateSlide = function (progress, commit) {
  const slide = this.slide;
  const self = this;
  const view = this.viewOf(slide.surface);
  view.classList.remove("woxi-kb-dragging");
  slide.animating = true; // from here on nothing may disturb the slide
  void slide.current.offsetWidth; // start the transition from the dragged spot
  slide.progress = progress;
  this.updateSlideTransform();
  const onEnd = function (event) {
    if (event.target === slide.current) done();
  };
  const done = function () {
    clearTimeout(slide.timer);
    slide.current.removeEventListener("transitionend", onEnd);
    // A timer or transition from an earlier slide must never end a newer one.
    if (self.slide === slide) self.finishSlide(commit);
  };
  slide.current.addEventListener("transitionend", onEnd);
  slide.timer = setTimeout(done, SLIDE_MS + 80);
};

// Puts the layers back to rest and renders the (possibly new) page in place.
Keyboard.prototype.finishSlide = function () {
  const slide = this.slide;
  if (!slide) return;
  this.slide = null;
  const view = this.viewOf(slide.surface);
  // Reset the layers with the transition switched off: otherwise the reset itself would
  // animate and the viewport would briefly show a half-empty page after every swipe.
  view.classList.add("woxi-kb-dragging");
  slide.current.style.transform = "";
  void slide.current.offsetWidth;
  if (slide.incoming && slide.incoming.parentNode) {
    slide.incoming.parentNode.removeChild(slide.incoming);
  }
  if (slide.surface === "bar") this.renderBar();
  else this.renderPad();
  view.classList.remove("woxi-kb-dragging");
};
function Keyboard(handlers) {
  this.handlers = handlers || {};
  this.keysEl = document.getElementById("woxi-kb-keys");
  this.actionsEl = document.getElementById("woxi-kb-actions");
  this.padView = document.getElementById("woxi-kb-pad-view");
  this.barView = document.getElementById("woxi-kb-bar-view");
  this.pageId = "math";
  this.back = null; // { page, dir } - the step the opposite swipe undoes
  this.barPage = 0;
  this.shift = SHIFT_OFF;
  this.lastShiftTap = 0;
  this.shiftKeys = [];
  this.slide = null; // the transition that is running, or the one being dragged
  this.slides = 0; // committed transitions, for the test hooks
  this.watch(this.padView, "pad");
  this.watch(this.barView, "bar");
  this.renderBar();
  this.renderPad();
}

// rendering

// The classes of one key: its classes, its span, and the app's state for it. Only
// the app knows whether Undo has anything to undo, so it answers through `keyState`.
// Splitting the responsibility this way keeps every page defined in this file.
Keyboard.prototype.keyClasses = function (key) {
  let classes = "woxi-key";
  if (key.classes) {
    classes +=
      " " +
      key.classes
        .split(" ")
        .map(function (name) {
          return "woxi-key-" + name;
        })
        .join(" ");
  }
  if (key.span) classes += " woxi-key-span-" + key.span;
  const state = this.handlers.keyState ? this.handlers.keyState(key) : "";
  if (state) {
    classes +=
      " " +
      state
        .split(" ")
        .map(function (name) {
          return "woxi-key-" + name;
        })
        .join(" ");
  }
  return classes;
};

// Re-applies the state classes to the bar on screen. The buttons are not replaced: a
// button that disappears under a finger never fires its click.
Keyboard.prototype.refreshKeyStates = function () {
  if (!this.barKeys || this.slide) return;
  const buttons = this.actionsEl.children;
  for (let i = 0; i < buttons.length && i < this.barKeys.length; i += 1) {
    const classes = this.keyClasses(this.barKeys[i]);
    if (buttons[i].className !== classes) buttons[i].className = classes;
  }
};

Keyboard.prototype.makeKey = function (key) {
  const self = this;
  const classes = this.keyClasses(key);
  const btn = el("button", classes);
  // The context bar renders rich labels (the signature highlights the argument the
  // caret is in). Every other key is plain text.
  if (key.html !== undefined) btn.innerHTML = key.html;
  else btn.textContent = labelFor(key, this.shiftApplies());
  btn.type = "button";
  if (key.tooltip) btn.title = key.tooltip;
  btn.setAttribute("data-key", key.label);
  if (key.action === "shift") btn.setAttribute("data-base", classes);

  // Holding a key is "more than a tap": a symbol key inserts the call's skeleton, a
  // suggestion chip wraps the selection. The handler says whether it did anything, so
  // a hold with no second action still ends as a normal tap.
  let holdTimer = null;
  let holdX = 0;
  let holdY = 0;
  const cancelHold = function () {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };
  btn.addEventListener(
    "touchstart",
    function (event) {
      if (event.touches.length !== 1 || !self.handlers.onLongPress) return;
      const touch = event.touches[0];
      holdX = touch.clientX;
      holdY = touch.clientY;
      cancelHold();
      holdTimer = setTimeout(function () {
        holdTimer = null;
        if (self.handlers.onLongPress(key)) suppressClicksUntil = Date.now() + 400;
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );
  btn.addEventListener(
    "touchmove",
    function (event) {
      if (!holdTimer) return;
      const touch = event.touches.length ? event.touches[0] : null;
      if (!touch) {
        cancelHold();
        return;
      }
      if (
        Math.abs(touch.clientX - holdX) > LONG_PRESS_SLOP ||
        Math.abs(touch.clientY - holdY) > LONG_PRESS_SLOP
      ) {
        cancelHold();
      }
    },
    { passive: true }
  );
  btn.addEventListener("touchend", cancelHold, { passive: true });
  btn.addEventListener("touchcancel", cancelHold, { passive: true });

  btn.addEventListener("click", function (event) {
    event.preventDefault();
    // A drag or a running slide owns the surface. A stray tap (often a second finger)
    // must not press a key under it.
    if (Date.now() < suppressClicksUntil || self.slide) return;
    self.press(key);
  });
  return btn;
};

Keyboard.prototype.renderBar = function () {
  this.actionsEl.className = "woxi-kb-slide woxi-kb-actions";
  this.buildBar(this.barPage, this.actionsEl);
};

// Fills `into` with the buttons of one bar page. The context page changes while the
// user types (see `setBarKeys`), so its column widths come from the keys themselves.
Keyboard.prototype.buildBar = function (barPage, into) {
  const self = this;
  const keys = BARS[barPage];
  // The keys of the page on screen, so `refreshKeyStates` can update their classes
  // without rebuilding them.
  if (into === this.actionsEl) this.barKeys = keys;
  into.className = "woxi-kb-slide woxi-kb-actions";
  into.innerHTML = "";
  into.setAttribute("data-bar", String(barPage + 1));
  const weighted = keys.some(function (key) {
    return key.grow !== undefined;
  });
  into.style.gridTemplateColumns = weighted
    ? keys
        .map(function (key) {
          return (key.grow === undefined ? 1 : key.grow) + "fr";
        })
        .join(" ")
    : "";
  keys.forEach(function (key) {
    into.appendChild(self.makeKey(key));
  });
};

// Replaces one bar page. The context page is rebuilt on every keystroke. When it is
// the page on screen it is redrawn at once, and a running slide picks up the new keys
// when it finishes (it reads BARS again).
/**
 * @param {number} index
 * @param {import('./types.js').KeySpec[]} keys
 */
Keyboard.prototype.setBarKeys = function (index, keys) {
  if (!BARS[index]) return;
  BARS[index] = keys;
  if (this.barPage === index && !this.slide) this.renderBar();
};

Keyboard.prototype.renderPad = function () {
  this.keysEl.className = "woxi-kb-slide woxi-kb-keys";
  this.shiftKeys = [];
  this.buildPage(this.pageId, this.keysEl);
};

// Fills `into` with the keys of one pad page, including its grid geometry.
Keyboard.prototype.buildPage = function (pageId, into) {
  const page = PAGES[pageId];
  into.className = "woxi-kb-slide woxi-kb-keys";
  into.innerHTML = "";
  into.setAttribute("data-page", page.id);
  into.setAttribute("data-cols", String(page.cols));
  into.style.gridTemplateColumns = "repeat(" + page.cols + ", 1fr)";
  for (let i = 0; i < page.keys.length; i++) {
    const node = this.makeKey(page.keys[i]);
    if (into === this.keysEl && page.keys[i].action === "shift") this.shiftKeys.push(node);
    into.appendChild(node);
  }
  if (into === this.keysEl) this.updateShiftKeys();
};

Keyboard.prototype.currentPageId = function () {
  return this.pageId;
};

// Shift applies to the letters page only. Other pages always insert what they show.
Keyboard.prototype.shiftApplies = function () {
  return this.pageId === "letters" && this.shift !== SHIFT_OFF;
};

// gestures

// Applies a swipe to the state only (no rendering). true when the page changed.
Keyboard.prototype.applySwipe = function (dir) {
  if (this.back && this.back.dir === OPPOSITE[dir]) {
    // The exact opposite of the swipe that led here: go back, and let the undo be
    // undone again by the opposite swipe.
    const left = this.pageId;
    this.pageId = this.back.page;
    this.back = { page: left, dir: dir };
  } else {
    const next = NEXT[this.pageId][dir];
    if (!next) return false; // end of the axis: nothing changes, the step is kept
    this.back = { page: this.pageId, dir: dir };
    this.pageId = next;
  }
  // A one-shot shift belongs to the page it was armed on. A lock survives (caps lock).
  if (this.shift === SHIFT_ONESHOT) this.shift = SHIFT_OFF;
  return true;
};

// One swipe on the key pad, animated.
Keyboard.prototype.swipe = function (dir) {
  return this.flick("pad", dir);
};

// One swipe on the action bar, animated (its pages loop, so it is never clamped).
Keyboard.prototype.swipeBar = function (dir) {
  return this.flick("bar", dir);
};

// input

// Shift, as on a modern phone keyboard: one tap arms the next key, two quick taps lock
// it (caps lock) and a single tap while locked turns the lock off again.
Keyboard.prototype.toggleShift = function () {
  const now = Date.now();
  const doubleTap = now - this.lastShiftTap < SHIFT_DOUBLE_TAP;
  this.lastShiftTap = now;
  if (this.shift === SHIFT_LOCKED) this.shift = SHIFT_OFF;
  else if (doubleTap) this.shift = SHIFT_LOCKED;
  else if (this.shift === SHIFT_OFF) this.shift = SHIFT_ONESHOT;
  else this.shift = SHIFT_OFF; // a single tap cancels a one-shot shift
  this.renderPad(); // the letters change with the mode
};

Keyboard.prototype.updateShiftKeys = function () {
  for (let i = 0; i < this.shiftKeys.length; i++) {
    const node = this.shiftKeys[i];
    let classes = node.getAttribute("data-base") || "woxi-key woxi-key-fn";
    if (this.shift === SHIFT_ONESHOT) classes += " woxi-key-on";
    if (this.shift === SHIFT_LOCKED) classes += " woxi-key-locked";
    node.className = classes;
    // Hollow arrow while armed, filled arrow while locked (as on phone keyboards).
    node.textContent = this.shift === SHIFT_LOCKED ? SHIFT_GLYPH_LOCKED : SHIFT_GLYPH;
  }
};

Keyboard.prototype.press = function (key) {
  if (key.action === "shift") {
    this.toggleShift();
    return;
  }
  if (key.action) {
    if (this.handlers.onAction) this.handlers.onAction(key.action, key.detail);
    return;
  }
  const spec = insertFor(key, this.shiftApplies());
  const insert = parseInsert(spec);
  if (this.handlers.onInsert) this.handlers.onInsert(insert.text, insert.caret, key);
  if (this.shift === SHIFT_ONESHOT) {
    // the key just consumed it
    this.shift = SHIFT_OFF;
    this.renderPad();
  }
};

// test hooks

// One line describing the visible state, used by the device test harness.
Keyboard.prototype.describe = function () {
  const page = PAGES[this.pageId];
  const labels = [];
  for (let i = 0; i < page.keys.length; i++)
    labels.push(labelFor(page.keys[i], this.shiftApplies()));
  const bar = [];
  for (let b = 0; b < BARS[this.barPage].length; b++) bar.push(BARS[this.barPage][b].label);
  const padBox = this.keysEl.getBoundingClientRect();
  const barBox = this.actionsEl.getBoundingClientRect();
  return (
    "page=" +
    this.pageId +
    " back=" +
    (this.back ? this.back.page + ":" + this.back.dir : "-") +
    " shift=" +
    this.shift +
    " cols=" +
    page.cols +
    " slides=" +
    this.slides +
    " bar=" +
    (this.barPage + 1) +
    "/" +
    BARS.length +
    " [" +
    bar.join(" ") +
    "]" +
    " padH=" +
    Math.round(padBox.height) +
    " barH=" +
    Math.round(barBox.height) +
    " keys=[" +
    labels.join(" ") +
    "]"
  );
};

// Every key on every page and bar page, so tests can press a key by its label.
function findKey(label) {
  for (const id in PAGES) {
    if (!Object.prototype.hasOwnProperty.call(PAGES, id)) continue;
    const keys = PAGES[id].keys;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i].label === label || keys[i].shiftLabel === label)
        return { key: keys[i], page: id };
    }
  }
  for (let b = 0; b < BARS.length; b++) {
    for (let k = 0; k < BARS[b].length; k++) {
      if (BARS[b][k].label === label) return { key: BARS[b][k], page: "bar" + (b + 1) };
    }
  }
  return null;
}

export { BARS, EXAMPLES, findKey, Keyboard, NEXT, OPPOSITE, PAGES, parseInsert };
