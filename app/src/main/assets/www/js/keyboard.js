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

import { BARS, CONTEXT_PAGE, NEXT, OPPOSITE, PAGES } from "./keyboard-pages.js";
import { el, keepFocus } from "./runtime.js";

const SWIPE_MIN = 26; // px before a drag counts as a swipe
const SLIDE_MS = 90; // how long a flick takes to slide a page in
const COMMIT_RATIO = 0.3; // ... or the drag covered this much of the viewport
const FLICK_SPEED = 0.4; // px/ms that commits a short, fast drag
const RUBBER = 0.35; // how far the pages follow a swipe at the end of an axis
const SHIFT_DOUBLE_TAP = 450; // ms, two taps within this window lock shift
const LONG_PRESS_MS = 380; // ms before a held key fires its second action
const LONG_PRESS_SLOP = 10; // px of movement that turns a hold into a swipe
const CLICK_GUARD_MS = 400; // a swipe or hold must not also press the key under the finger
const SLIDE_FALLBACK_MS = 80; // extra time after the CSS transition before forcing the end
const SHIFT_GLYPH = "\u21E7"; // hollow arrow: arms one capital
const SHIFT_GLYPH_LOCKED = "\u2B06"; // filled arrow: caps lock
const SHIFT_OFF = 0;
const SHIFT_ONESHOT = 1; // affects the next key only
const SHIFT_LOCKED = 2; // stays on, like caps lock
const SHIFT_NAMES = ["off", "one shot", "locked"];

// The touch with the given identifier, or null. A keyboard gesture owns one finger.
// Another finger on the same surface must not move or end it.
function touchById(list, id) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].identifier === id) return list[i];
  }
  return null;
}

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
  return { text: head.replace(/\\\|/g, "|") + after, caret: after.length };
}

// Shift changes what a key shows and inserts: on the letters page letters become
// capitals, `\u03B8` becomes `\u03C6`, and the symbol keys switch to their paired operator
// (`;` -> `;;`, `_` -> `__`, `/.` -> `//.`. See the page table for the rest). Keys on
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
  if (key.call) return key.label + "[|]";
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

  view.addEventListener(
    "touchstart",
    function (event) {
      // The finger that owned the gesture is gone without a touchend (lost event, system
      // gesture): finish its slide instead of leaving the pad dead until a restart.
      if (active !== null && !touchById(event.touches, active)) {
        active = null;
        dir = null;
        if (self.slide) self.finishSlide();
      }
      if (active !== null || event.changedTouches.length !== 1) return;
      // Recover the same way when a slide was left behind without a finger on it.
      if (self.slide) {
        if (self.slide.timer) return;
        self.finishSlide();
      }
      // A new gesture starts here. The click guard only has to cover the click of the
      // gesture that just ended. Keeping the timestamp longer would swallow a deliberate
      // tap on the next key.
      self.suppressClicksUntil = 0;
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
        self.suppressClicksUntil = Date.now() + CLICK_GUARD_MS; // the drag must not press a key
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
// so it always has a target). One function for the drag animation and the commit, so a
// slide cannot animate to one page and land on another.
Keyboard.prototype.targetOf = function (surface, dir) {
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
  const target = this.targetOf(surface, dir);
  const box = this.viewOf(surface).getBoundingClientRect();
  const layer = el(
    "div",
    surface === "bar" ? "woxi-kb-slide woxi-kb-actions" : "woxi-kb-slide woxi-kb-keys"
  );
  this.slide = {
    surface: surface,
    dir: dir,
    target: target,
    size: dir === "left" || dir === "right" ? box.width : box.height,
    progress: 0,
    lastTime: Date.now(),
    speed: 0,
    startTime: Date.now(),
    committed: false,
    barDirty: false,
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
  const horizontal = slide.dir === "left" || slide.dir === "right";
  const forward = slide.dir === "left" || slide.dir === "up";
  const size = slide.size;
  const progress = slide.target === null ? slide.progress * RUBBER : slide.progress;
  const fn = horizontal ? "translateX(" : "translateY(";
  // The two layers move in opposite directions: the current page leaves toward the
  // swipe direction, the incoming one arrives from the far edge (and both are on screen
  // while the transition runs).
  const current = forward ? -progress : progress;
  const incoming = forward ? size - progress : progress - size;
  this.layerOf(slide.surface).style.transform = fn + current + "px)";
  if (slide.incoming) slide.incoming.style.transform = fn + incoming + "px)";
};

Keyboard.prototype.moveSlide = function (progress, time) {
  const slide = this.slide;
  if (!slide) return;
  const dt = Math.max(1, time - slide.lastTime);
  slide.speed = (progress - slide.progress) / dt;
  slide.lastTime = time;
  slide.progress = Math.max(0, progress);
  this.updateSlideTransform();
};

// Release: finish the transition when the drag got far or fast enough, else spring back.
Keyboard.prototype.endSlide = function (time) {
  const slide = this.slide;
  if (!slide) return;
  const elapsed = Math.max(1, time - slide.startTime);
  const speed = Math.max(Math.abs(slide.speed), Math.abs(slide.progress) / elapsed);
  const commit =
    slide.target !== null && (slide.progress > slide.size * COMMIT_RATIO || speed > FLICK_SPEED);
  if (commit) this.applySlideState();
  this.animateSlide(commit ? slide.size : 0);
};

// Flick without a finger: the automation hooks drive the same path a tap-swipe does.
Keyboard.prototype.flick = function (surface, dir) {
  if (this.slide) this.finishSlide();
  if (!this.beginSlide(surface, dir)) {
    // `beginSlide` created the rubber-band layer even though the axis has no target.
    // Clear it or the surface stays in the dragging state and swallows clicks.
    this.finishSlide();
    return false;
  }
  this.applySlideState();
  this.animateSlide(this.slide.size);
  return true;
};

// Applies the state change of the slide that is being committed.
Keyboard.prototype.applySlideState = function () {
  const slide = this.slide;
  slide.committed = true;
  if (slide.surface === "bar") this.barPage = slide.target;
  else this.applySwipe(slide.dir);
};

Keyboard.prototype.animateSlide = function (progress) {
  const slide = this.slide;
  const self = this;
  const view = this.viewOf(slide.surface);
  const current = this.layerOf(slide.surface);
  view.classList.remove("woxi-kb-dragging");
  void current.offsetWidth; // start the transition from the dragged spot
  slide.progress = progress;
  this.updateSlideTransform();
  // The CSS transition is disabled for reduced motion, so waiting for its end would
  // leave the surface in the slide state (and swallow the next tap) for nothing.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    this.finishSlide();
    return;
  }
  const onEnd = function (event) {
    if (event.target === current) done();
  };
  const done = function () {
    clearTimeout(slide.timer);
    current.removeEventListener("transitionend", onEnd);
    // A timer or transition from an earlier slide must never end a newer one.
    if (self.slide === slide) self.finishSlide();
  };
  current.addEventListener("transitionend", onEnd);
  slide.timer = setTimeout(done, SLIDE_MS + SLIDE_FALLBACK_MS);
};

// Puts the layers back to rest and renders the (possibly new) page in place.
Keyboard.prototype.finishSlide = function () {
  const slide = this.slide;
  if (!slide) return;
  this.slide = null;
  const view = this.viewOf(slide.surface);
  const current = this.layerOf(slide.surface);
  // Reset the layers with the transition switched off: otherwise the reset itself would
  // animate and the viewport would briefly show a half-empty page after every swipe.
  view.classList.add("woxi-kb-dragging");
  current.style.transform = "";
  void current.offsetWidth;
  if (slide.incoming && slide.incoming.parentNode) {
    slide.incoming.parentNode.removeChild(slide.incoming);
  }
  // A spring-back leaves the current page on screen. Only rebuild when the page
  // changed or the context page changed while the finger was down. A committed slide
  // always needs the rest-state DOM for its new page.
  if (slide.surface === "bar") {
    if (slide.committed || slide.barDirty) this.renderBar();
  } else {
    if (slide.committed) this.renderPad();
    if (slide.barDirty) this.renderBar();
  }
  view.classList.remove("woxi-kb-dragging");
};
function Keyboard(handlers) {
  this.handlers = handlers || {};
  this.keysEl = document.getElementById("woxi-kb-keys");
  this.actionsEl = document.getElementById("woxi-kb-actions");
  this.padView = document.getElementById("woxi-kb-pad-view");
  this.barView = document.getElementById("woxi-kb-bar-view");
  this.padView.style.setProperty("--woxi-slide-ms", SLIDE_MS + "ms");
  this.barView.style.setProperty("--woxi-slide-ms", SLIDE_MS + "ms");
  this.pageId = "math";
  this.back = null; // { page, dir } - the step the opposite swipe undoes
  this.barPage = 0;
  this.contextKeys = null; // page 1 while the assist is bound
  this.shift = SHIFT_OFF;
  this.lastShiftTap = 0;
  this.slide = null; // the transition that is running, or the one being dragged
  this.suppressClicksUntil = 0; // a swipe/hold must not also press the key under the finger
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
  if (this.slide) {
    this.slide.barDirty = true;
    return;
  }
  const keys = this.barKeysOf(this.barPage);
  const buttons = this.actionsEl.children;
  for (let i = 0; i < buttons.length && i < keys.length; i += 1) {
    const classes = this.keyClasses(keys[i]);
    if (buttons[i].className !== classes) buttons[i].className = classes;
  }
};

Keyboard.prototype.makeKey = function (key) {
  const self = this;
  const classes = this.keyClasses(key);
  const btn = el("button", classes);
  // The context bar renders rich labels (the signature highlights the argument the
  // caret is in). Every other key is plain text. A shift key shows its mode.
  if (key.html !== undefined) btn.innerHTML = key.html;
  else if (key.action === "shift") {
    btn.textContent = this.shift === SHIFT_LOCKED ? SHIFT_GLYPH_LOCKED : SHIFT_GLYPH;
  } else btn.textContent = labelFor(key, this.shiftApplies());
  btn.type = "button";
  if (key.tooltip) btn.title = key.tooltip;
  btn.setAttribute("data-key", key.label);
  if (key.action === "shift") {
    if (this.shift === SHIFT_ONESHOT) btn.className += " woxi-key-on";
    if (this.shift === SHIFT_LOCKED) btn.className += " woxi-key-locked";
  }

  // A key is a way to type into the entry, not a field of its own. See `keepFocus`:
  // cancelling the press keeps the caret in the entry, and the click still arrives.
  keepFocus(btn);

  // Holding a key is "more than a tap": a symbol key inserts the call's skeleton, a
  // suggestion chip wraps the selection. When there is no such second action the hold is
  // the tap, but it is performed on release: a press that runs while the finger is still
  // down is followed by the browser's end-of-gesture handling, which takes the focus and
  // the selection away from the little caret the press just placed.
  let holdTimer = null;
  let holdAction = ""; // "" when there is none, "tap" for the release, "fired" when written
  let holdId = null; // the finger that owns the hold; other fingers are ignored
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
      holdId = touch.identifier;
      holdX = touch.clientX;
      holdY = touch.clientY;
      cancelHold();
      holdAction = "";
      holdTimer = setTimeout(function () {
        holdTimer = null;
        const fired = self.handlers.onLongPress(key);
        if (fired) {
          holdAction = "fired";
          self.suppressClicksUntil = Date.now() + CLICK_GUARD_MS;
        } else {
          // No skeleton was written: the hold is the tap, performed on release so the
          // caret survives the end of the gesture.
          holdAction = "tap";
        }
      }, LONG_PRESS_MS);
    },
    { passive: true }
  );
  btn.addEventListener(
    "touchmove",
    function (event) {
      if (!holdTimer || holdId === null) return;
      const touch = touchById(event.touches, holdId);
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
  btn.addEventListener(
    "touchend",
    function (event) {
      if (holdId !== null && !touchById(event.changedTouches, holdId)) return;
      cancelHold();
      const action = holdAction;
      holdAction = "";
      holdId = null;
      if (!action) return;
      // The gesture is over. Any click it still delivers is the one being replaced (and a
      // click can arrive much later than the guard set when the hold fired).
      self.suppressClicksUntil = Date.now() + CLICK_GUARD_MS;
      if (action === "tap") self.press(key);
      if (self.handlers.onHoldRelease) self.handlers.onHoldRelease(key);
    },
    { passive: true }
  );
  btn.addEventListener(
    "touchcancel",
    function (event) {
      if (holdId !== null && !touchById(event.changedTouches, holdId)) return;
      cancelHold();
      holdAction = "";
      holdId = null;
    },
    { passive: true }
  );

  btn.addEventListener("click", function (event) {
    event.preventDefault();
    // A drag or a running slide owns the surface. A stray tap (often a second finger)
    // must not press a key under it.
    if (Date.now() < self.suppressClicksUntil || self.slide) return;
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
Keyboard.prototype.barKeysOf = function (barPage) {
  return barPage === CONTEXT_PAGE && this.contextKeys ? this.contextKeys : BARS[barPage];
};

Keyboard.prototype.buildBar = function (barPage, into) {
  const self = this;
  const keys = this.barKeysOf(barPage);
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

// Replaces the context page. It is rebuilt on every keystroke. When it is the page on
// screen it is redrawn at once, and a running slide picks up the new keys when it
// finishes (it reads the stored context keys).
/**
 * @param {import('./types.js').KeySpec[]} keys
 */
Keyboard.prototype.setBarKeys = function (keys) {
  this.contextKeys = keys;
  if (this.slide) {
    this.slide.barDirty = true;
    return;
  }
  if (this.barPage === CONTEXT_PAGE) this.renderBar();
};

Keyboard.prototype.renderPad = function () {
  this.keysEl.className = "woxi-kb-slide woxi-kb-keys";
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
    into.appendChild(node);
  }
};

// Shift applies to the letters page only. Other pages always insert what they show.
Keyboard.prototype.shiftApplies = function () {
  return this.pageId === "letters" && this.shift !== SHIFT_OFF;
};

// gestures

// Applies a swipe to the state only (no rendering). true when the page changed.
Keyboard.prototype.applySwipe = function (dir) {
  const target = this.targetOf("pad", dir);
  if (target === null) return false; // end of the axis: nothing changes, the step is kept
  const left = this.pageId;
  this.pageId = target;
  // The page just left is what the opposite swipe undoes. The next opposite swipe can
  // put it back, so every swipe is reversible.
  this.back = { page: left, dir: dir };
  // A one-shot shift belongs to the page it was armed on. A lock survives (caps lock).
  if (this.shift === SHIFT_ONESHOT) this.shift = SHIFT_OFF;
  this.lastShiftTap = 0;
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

Keyboard.prototype.press = function (key) {
  if (key.action === "shift") {
    this.toggleShift();
    return;
  }
  // Two shift taps only lock when no other key was typed in between.
  this.lastShiftTap = 0;
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
  const barKeys = this.barKeysOf(this.barPage);
  for (let b = 0; b < barKeys.length; b++) bar.push(barKeys[b].label);
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

export { Keyboard, SHIFT_NAMES };
