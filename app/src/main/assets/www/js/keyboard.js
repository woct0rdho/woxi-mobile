// In-app math keyboard.
//
// Labels show the Wolfram Language text a key inserts.
// Function keys insert the call and put the caret inside the brackets.
// Their tooltip names the exact insert when it carries fixed parts
// (`D` -> `D[..., x]`). Plot keys insert a runnable example, described in the tooltip.
//
// Vertical swipes change the level (letters / math / plot 2D / plot 3D). Sideways
// swipes move inside a level - left shows the functions page, right the scripting
// page - and every page keeps four key rows, so the keyboard height never changes.
//
// Key shape: { l: label, i: insert ('|' marks the caret), a: action, k: class,
//              s: column span, t: tooltip }

(function (global) {
  'use strict';

  var SWIPE_MIN = 26;          // px before a drag counts as a swipe
  var SLIDE_MS = 90;           // how long a flick takes to slide a page in
  var COMMIT_RATIO = 0.3;      // ... or the drag covered this much of the viewport
  var FLICK_SPEED = 0.4;       // px/ms that commits a short, fast drag
  var RUBBER = 0.35;           // how far the pages follow a swipe at the end of an axis
  var SHIFT_DOUBLE_TAP = 450;  // ms, two taps within this window lock shift
  var SHIFT_GLYPH = '\u21E7';        // hollow arrow: arms one capital
  var SHIFT_GLYPH_LOCKED = '\u2B06'; // filled arrow: caps lock
  var SHIFT_OFF = 0;
  var SHIFT_ONESHOT = 1;       // affects the next key only
  var SHIFT_LOCKED = 2;        // stays on, like caps lock
  var suppressClicksUntil = 0; // a swipe must not also press the key under the finger

  var PAGES = {
    functions: {
      id: 'functions',
      cols: 6,
      keys: [
        { l: 'ArcSin', i: 'ArcSin[|]', k: 'fn', t: 'ArcSin[...]' },
        { l: 'Pi', i: 'Pi', t: 'Pi' },
        { l: 'Abs', i: 'Abs[|]', k: 'fn', t: 'Abs[...]' },
        { l: 'Exp', i: 'Exp[|]', k: 'fn', t: 'Exp[...]' },
        { l: '*Degree', i: '*Degree', t: 'Degrees: 30*Degree' },
        { l: 'D', i: 'D[|, x]', k: 'fn', t: 'D[..., x]' },
        { l: 'ArcCos', i: 'ArcCos[|]', k: 'fn', t: 'ArcCos[...]' },
        { l: 'I', i: 'I', t: 'Imaginary unit' },
        { l: 'Re', i: 'Re[|]', k: 'fn', t: 'Re[...]' },
        { l: 'Im', i: 'Im[|]', k: 'fn', t: 'Im[...]' },
        { l: '!', i: '!', t: 'Factorial' },
        { l: 'Integrate', i: 'Integrate[|, x]', k: 'fn', t: 'Integrate[..., x]' },
        { l: 'ArcTan', i: 'ArcTan[|]', k: 'fn', t: 'ArcTan[...]' },
        { l: 'E', i: 'E', t: 'Euler number' },
        { l: 'Floor', i: 'Floor[|]', k: 'fn', t: 'Floor[...]' },
        { l: 'Ceiling', i: 'Ceiling[|]', k: 'fn', t: 'Ceiling[...]' },
        { l: '*^', i: '*^', t: 'Scientific notation: 1.5*^3' },
        { l: 'Limit', i: 'Limit[|, x -> 0]', k: 'fn', t: 'Limit[..., x -> 0]' },
        { l: 'Log10', i: 'Log10[|]', k: 'fn', t: 'Log10[...]' },
        { l: 'EulerGamma', i: 'EulerGamma', k: 'fn xs', t: 'EulerGamma' },
        { l: 'Manipulate', i: 'Manipulate[|, {a, 1, 5}]', k: 'fn', s: 2, t: 'Manipulate[..., {a, 1, 5}]' },
        { l: 'Infinity', i: 'Infinity', t: 'Infinity' },
        { l: 'Out', i: 'Out[|]', k: 'fn', t: 'Result of the previous entry' },
      ],
    },
    math: {
      id: 'math',
      cols: 7,
      keys: [
        { l: 'Sin', i: 'Sin[|]', k: 'fn', t: 'Sin[...]' },
        { l: 'x' },
        { l: '7' },
        { l: '8' },
        { l: '9' },
        { l: '/', t: 'Divide' },
        { l: '( )', i: '(|)', t: 'Parentheses' },
        { l: 'Cos', i: 'Cos[|]', k: 'fn', t: 'Cos[...]' },
        { l: 'y' },
        { l: '4' },
        { l: '5' },
        { l: '6' },
        { l: '*', t: 'Times' },
        { l: '^', t: 'Power' },
        { l: 'Tan', i: 'Tan[|]', k: 'fn', t: 'Tan[...]' },
        { l: 'T' },
        { l: '1' },
        { l: '2' },
        { l: '3' },
        { l: '-', t: 'Minus' },
        { l: 'Sqrt', i: 'Sqrt[|]', k: 'fn', t: 'Sqrt[...]' },
        { l: 'Log', i: 'Log[|]', k: 'fn', t: 'Natural logarithm Log[...]' },
        { l: '=', t: 'Set' },
        { l: ',' },
        { l: '0' },
        { l: '.' },
        { l: '+' },
        { l: '[ ]', i: '[|]', t: 'Brackets' },
      ],
    },
    script: {
      id: 'script',
      cols: 6,
      keys: [
        { l: 'Do', i: 'Do[|, {5}]', k: 'fn', t: 'Repeat: Do[..., {n}]' },
        { l: 'Mod', i: 'Mod[|, 2]', k: 'fn', t: 'Mod[x, 2]' },
        { l: '<' },
        { l: '>' },
        { l: '#' },
        { l: 'If', i: 'If[|, , ]', k: 'fn', t: 'If[cond, then, else]' },
        { l: 'While', i: 'While[|, ]', k: 'fn', t: 'While[test, body]' },
        { l: '$' },
        { l: '<=' },
        { l: '>=' },
        { l: "'", t: 'Derivative' },
        { l: 'Which', i: 'Which[|, , ]', k: 'fn', t: 'Which[c1, v1, c2, v2]' },
        { l: 'Break', i: 'Break[]', k: 'fn', t: 'Break[]' },
        { l: '!' },
        { l: '!=' },
        { l: '==' },
        { l: ':' },
        { l: 'Switch', i: 'Switch[|, , ]', k: 'fn', t: 'Switch[expr, form, value]' },
        { l: 'Return', i: 'Return[|]', k: 'fn', t: 'Return[...]' },
        { l: '" "', i: '"|"', t: 'String' },
        { l: '&', t: 'Pure function' },
        { l: '|', i: '\\|', t: 'Alternatives' },
        { l: '@', t: 'Prefix application' },
        { l: ']', t: 'Close bracket' },
      ],
    },
    letters: {
      id: 'letters',
      cols: 10,
      keys: [
        { l: 'q' }, { l: 'w' }, { l: 'e' }, { l: 'r' }, { l: 't' }, { l: 'y' }, { l: 'u' }, { l: 'i' }, { l: 'o' }, { l: 'p' },
        { l: 'a' }, { l: 's' }, { l: 'd' }, { l: 'f' }, { l: 'g' }, { l: 'h' }, { l: 'j' }, { l: 'k' }, { l: 'l' },
        { l: '\u23CE', i: '\n', t: 'New line' },
        { l: 'z' }, { l: 'x' }, { l: 'c' }, { l: 'v' }, { l: 'b' }, { l: 'n' }, { l: 'm' },
        { l: '\u03B8', L: '\u03C6', t: 'Theta (Phi with shift)' },
        { l: '_', L: '/;', t: 'Blank (Condition /; with shift)' },
        { l: '?', L: '/@', t: 'Information or PatternTest (?..., Map /@ with shift)' },
        { l: '\u21E7', a: 'shift', k: 'fn', t: 'Shift: one capital, tap twice to lock' },
        { l: '`', L: '~', t: 'Precision or context mark (Infix ~ with shift)' },
        { l: '%', L: '->', t: 'Previous result (Rule -> with shift)' },
        { l: '\u2423', i: ' ', k: 'dim xs', s: 4, t: 'Space' },
        { l: ';', L: ':=', t: 'CompoundExpression (SetDelayed := with shift)' },
        { l: '{ }', i: '{|}', L: '<| |>', I: '<\\||\\|>', k: 'xs', t: 'List (Association with shift)' },
        { l: '\u21E7', a: 'shift', k: 'fn', t: 'Shift: one capital, tap twice to lock' },
      ],
    },
    plot2d: {
      id: 'plot2d',
      cols: 3,
      keys: [
        { l: 'Plot', i: 'Plot[Sin[x], {x, -2 Pi, 2 Pi}]', k: 'fn', t: 'Function plot' },
        { l: 'ListPlot', i: 'ListPlot[{1, 4, 9, 16, 25}]', k: 'fn', t: 'Scatter plot of data' },
        { l: 'ContourPlot', i: 'ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}]', k: 'fn', t: 'Implicit graph: the zero contour of the equation' },
        { l: 'ParametricPlot', i: 'ParametricPlot[{Cos[3 t], Sin[2 t]}, {t, 0, 2 Pi}]', k: 'fn', t: 'Parametric curve' },
        { l: 'ListLinePlot', i: 'ListLinePlot[{3, 1, 4, 1, 5, 9, 2, 6}]', k: 'fn', t: 'Line graph' },
        { l: 'DensityPlot', i: 'DensityPlot[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]', k: 'fn', t: 'Coloured contour plot' },
        { l: 'PolarPlot', i: 'PolarPlot[1 + Cos[3 t], {t, 0, 2 Pi}]', k: 'fn', t: 'Polar plot' },
        { l: 'BoxWhiskerChart', i: 'BoxWhiskerChart[RandomReal[NormalDistribution[0, 1], 200]]', k: 'fn', t: 'Box plot' },
        { l: 'ArrayPlot', i: 'ArrayPlot[Table[Mod[i + j, 3], {i, 16}, {j, 16}]]', k: 'fn', t: 'Matrix drawn as an image' },
        { l: 'VectorPlot', i: 'VectorPlot[{y, -x}, {x, -3, 3}, {y, -3, 3}]', k: 'fn', t: 'Vector field' },
        { l: 'Histogram', i: 'Histogram[RandomReal[NormalDistribution[0, 1], 300]]', k: 'fn', t: 'Histogram of data' },
        { l: 'Fit', i: 'data = {{1, 2}, {2, 5}, {3, 7}, {4, 9}}; Show[ListPlot[data], Plot[Fit[data, {1, x}, x], {x, 1, 4}]]', k: 'fn', t: 'Regression: fit the data' },
      ],
    },
    // level: plot 3D (swipe down twice)
    plot3d: {
      id: 'plot3d',
      cols: 3,
      keys: [
        { l: 'Plot3D', i: 'Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]', k: 'fn', t: 'Surface of a function' },
        { l: 'ListPlot3D', i: 'ListPlot3D[Table[Sin[i/2] Cos[j/2], {i, 12}, {j, 12}]]', k: 'fn', t: 'Surface from a table of heights' },
        { l: 'RegionPlot', i: 'RegionPlot[x^2 + y^2 < 1, {x, -1.5, 1.5}, {y, -1.5, 1.5}]', k: 'fn', t: 'Implicit region' },
        { l: 'ParametricPlot3D', i: 'ParametricPlot3D[{Cos[t], Sin[t], t}, {t, 0, 4 Pi}]', k: 'fn', t: 'Parametric curve in 3D' },
        { l: 'ListLinePlot3D', i: 'ListLinePlot3D[Table[{n, n^2, Sin[n]}, {n, 10}]]', k: 'fn', t: 'Line through points in 3D' },
        { l: 'RegionPlot3D', i: 'RegionPlot3D[x^2 + y^2 + z^2 < 1, {x, -1.5, 1.5}, {y, -1.5, 1.5}, {z, -1.5, 1.5}]', k: 'fn', t: 'Implicit region in 3D' },
        { l: 'SphericalPlot3D', i: 'SphericalPlot3D[1 + 0.4 Sin[4 u] Cos[4 v], {u, 0, Pi}, {v, 0, 2 Pi}]', k: 'fn', t: 'Spherical coordinates' },
        { l: 'ComplexPlot', i: 'ComplexPlot[Sin[z], {z, -3 - 3 I, 3 + 3 I}]', k: 'fn', t: 'Complex plane' },
        { l: 'DiscretePlot3D', i: 'DiscretePlot3D[Sin[x] Cos[y], {x, 0, 10}, {y, 0, 10}]', k: 'fn', t: 'Values on a lattice' },
        { l: 'VectorPlot3D', i: 'VectorPlot3D[{y, -x, z}, {x, -1, 1}, {y, -1, 1}, {z, -1, 1}]', k: 'fn', t: 'Vector field in 3D' },
        { l: 'ComplexPlot3D', i: 'ComplexPlot3D[Sin[z], {z, -2 - 2 I, 2 + 2 I}]', k: 'fn', t: 'Modulus of a complex function' },
        { l: 'RevolutionPlot3D', i: 'RevolutionPlot3D[Sqrt[x], {x, 0, 4}]', k: 'fn', t: 'Surface of revolution, the cylindrical plotS' },
      ],
    },
  };

  // Navigation is a graph of pages plus one remembered step. A swipe moves from the
  // current page in that direction:
  //
  // math       left functions  right script  up letters   down plots 2D
  // letters    left functions  right script  -            down math
  // plots 2D   left functions  right script  up math      down plots 3D
  // plots 3D   left functions  right script  up plots 2D  -
  // functions  -               right math    up letters   down plots 2D
  // script     left math       -             up letters   down plots 2D
  //
  // The page a swipe came from is remembered together with the direction that led to
  // it, and only the exact opposite swipe uses that memory (so every swipe is undone by
  // the opposite one). Nothing older is kept: after
  // `plots 2D -> right -> script -> down -> plots 2D -> up -> script` a `left` shows the
  // math page - the default in that direction - rather than plots 2D again. A swipe at
  // the end of an axis changes nothing and keeps the remembered step.
  var NEXT = {
    math: { left: 'functions', right: 'script', up: 'letters', down: 'plot2d' },
    letters: { left: 'functions', right: 'script', up: null, down: 'math' },
    plot2d: { left: 'functions', right: 'script', up: 'math', down: 'plot3d' },
    plot3d: { left: 'functions', right: 'script', up: 'plot2d', down: null },
    functions: { left: null, right: 'math', up: 'letters', down: 'plot2d' },
    script: { left: 'math', right: null, up: 'letters', down: 'plot2d' },
  };
  var OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up' };

  // The action bar above the keys: three pages, swiped left/right in a loop.
  var BARS = [
    [
      { l: 'Eval', a: 'enter', k: 'ok', t: 'Evaluate this entry' },
      { l: 'Plot', a: 'plot', k: 'fn', t: 'Wrap the entry in Plot[...]' },
      { l: 'Solve', a: 'solve', k: 'fn', t: 'Wrap the entry in Solve[...]' },
      { l: '\u2190', a: 'back', k: 'danger', t: 'Backspace' },
    ],
    [
      { l: 'Eval all', a: 'evalall', k: 'fn accent', t: 'Restart the session and run every entry' },
      { l: 'Insert', a: 'new', t: 'New entry below' },
      { l: 'Duplicate', a: 'duplicate', k: 'fn', t: 'Copy this entry' },
      { l: 'Delete', a: 'delete', k: 'fn danger', t: 'Delete this entry' },
    ],
    [
      { l: 'Cut', a: 'cut', t: 'Cut the selection (or the whole entry)' },
      { l: 'Copy', a: 'copy', t: 'Copy the selection (or the whole entry)' },
      { l: 'Paste', a: 'paste', t: 'Paste from the clipboard' },
      { l: 'Clear', a: 'clear', k: 'danger', t: 'Clear this entry' },
    ],
  ];

  // Splits 'Sin[|]' into the text to insert and the caret offset from the end.
  //
  // A backslash escapes the marker, so '\\|' inserts a literal `|` - the Alternatives
  // key needs one, and without the escape the marker inside it would swallow the key.
  function parseInsert(spec) {
    var marker = -1;
    for (var i = 0; i < spec.length; i++) {
      if (spec.charAt(i) === '\\') { i++; continue; }
      if (spec.charAt(i) === '|') { marker = i; break; }
    }
    var head = marker < 0 ? spec : spec.slice(0, marker);
    var tail = marker < 0 ? '' : spec.slice(marker + 1);
    var after = tail.replace(/\\\|/g, '|');
    return { text: (head + after).replace(/\\\|/g, '|'), caret: after.length };
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Shift changes what a key shows and inserts: on the letters page letters become
  // capitals, `\u03B8` becomes `\u03C6`, and the symbol keys switch to their paired operator
  // (`;` -> `;;`, `_` -> `__`, `/.` -> `//.`, `{ }` -> `<| |>` hmm see the table). Keys on
  // the other pages carry no shifted form, so shift leaves them alone.
  function labelFor(key, shifted) {
    if (!shifted) return key.l;
    if (key.L) return key.L;
    return /^[a-z]$/.test(key.l) ? key.l.toUpperCase() : key.l;
  }

  // The insert spec of a key for the current shift state (see parseInsert).
  function insertFor(key, shifted) {
    if (shifted && key.I !== undefined) return key.I;
    if (key.i !== undefined) return key.i;
    return labelFor(key, shifted);
  }

  // Watches one surface: a drag first has to leave a small dead zone, from there on the
  // pages follow the finger, and the release decides between finishing the transition and
  // springing back (see beginSlide/moveSlide/endSlide).
  //
  // One finger owns the gesture. Extra fingers are ignored.
  Keyboard.prototype.watch = function (view, surface) {
    var self = this;
    var active = null;              // identifier of the finger that owns the gesture
    var dir = null, startX = 0, startY = 0;

    var touchById = function (list, id) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].identifier === id) return list[i];
      }
      return null;
    };

    view.addEventListener('touchstart', function (event) {
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
      var t = event.changedTouches[0];
      active = t.identifier;
      startX = t.clientX;
      startY = t.clientY;
      dir = null;
    }, { passive: true });
    view.addEventListener('touchmove', function (event) {
      if (active === null) return;
      var t = touchById(event.touches, active);   // only the finger that started it counts
      if (!t) return;
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      if (!dir) {
        if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;
        var horizontal = Math.abs(dx) > Math.abs(dy);
        if (surface === 'bar' && !horizontal) return;   // the bar only slides sideways
        dir = horizontal ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
        suppressClicksUntil = Date.now() + 400;         // the drag must not press a key
        self.beginSlide(surface, dir);
      }
      var along = (dir === 'left' || dir === 'right') ? dx : dy;
      var progress = (dir === 'left' || dir === 'up') ? -along : along;
      self.moveSlide(progress, Date.now());
    }, { passive: true });
    var release = function (event) {
      if (active === null) return;
      if (!touchById(event.changedTouches, active)) return;   // another finger lifted
      active = null;
      dir = null;
      if (self.slide) self.endSlide(Date.now());
    };
    view.addEventListener('touchend', release, { passive: true });
    view.addEventListener('touchcancel', release, { passive: true });
  };

  // transitions

  Keyboard.prototype.viewOf = function (surface) {
    return surface === 'bar' ? this.barView : this.padView;
  };

  Keyboard.prototype.layerOf = function (surface) {
    return surface === 'bar' ? this.actionsEl : this.keysEl;
  };

  // The page a swipe in `dir` would show, or null when the axis ends here (the bar loops,
  // so it always has a target). Mirrors applySwipe/applyBarSwipe without changing state.
  Keyboard.prototype.peek = function (surface, dir) {
    if (surface === 'bar') {
      if (dir !== 'left' && dir !== 'right') return null;
      var count = BARS.length;
      return (this.barPage + (dir === 'left' ? 1 : count - 1)) % count;
    }
    if (this.back && this.back.dir === OPPOSITE[dir]) return this.back.page;
    return NEXT[this.pageId][dir] || null;
  };

  // Prepares a transition: the incoming page is built into a layer that waits off-view.
  Keyboard.prototype.beginSlide = function (surface, dir) {
    var target = this.peek(surface, dir);
    var axis = (dir === 'left' || dir === 'right') ? 'x' : 'y';
    var box = this.viewOf(surface).getBoundingClientRect();
    var layer = el('div', surface === 'bar'
      ? 'woxi-kb-slide woxi-kb-actions woxi-kb-incoming'
      : 'woxi-kb-slide woxi-kb-keys woxi-kb-incoming');
    this.slide = {
      surface: surface,
      dir: dir,
      axis: axis,
      target: target,
      forward: dir === 'left' || dir === 'up',
      size: axis === 'x' ? box.width : box.height,
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
      if (surface === 'bar') this.buildBar(target, layer); else this.buildPage(target, layer);
      this.viewOf(surface).appendChild(layer);
      this.slide.incoming = layer;
    }
    this.viewOf(surface).classList.add('woxi-kb-dragging');
    this.updateSlideTransform();
    // Commit the off-viewport position to the layout. Without this flush a fast flick
    // (touch start and end inside one frame) would place the incoming page in view at
    // once instead of sliding it in, so only one page would be visible.
    if (this.slide.incoming) void this.slide.incoming.offsetWidth;
    return target !== null;
  };

  // Places the two layers for the current progress. At the end of an axis it only pulls.
  Keyboard.prototype.updateSlideTransform = function () {
    var slide = this.slide;
    if (!slide) return;
    var progress = slide.target === null ? slide.progress * RUBBER : slide.progress;
    var fn = slide.axis === 'x' ? 'translateX(' : 'translateY(';
    // The two layers move in opposite directions: the current page leaves towards the
    // swipe direction, the incoming one arrives from the far edge (and both are on screen
    // while the transition runs).
    var current = slide.forward ? -progress : progress;
    var incoming = slide.forward ? slide.size - progress : progress - slide.size;
    slide.current.style.transform = fn + current + 'px)';
    if (slide.incoming) slide.incoming.style.transform = fn + incoming + 'px)';
  };

  Keyboard.prototype.moveSlide = function (progress, time) {
    var slide = this.slide;
    if (!slide) return;
    var dt = Math.max(1, time - slide.lastTime);
    slide.velocity = (progress - slide.lastProgress) / dt;
    slide.lastProgress = progress;
    slide.lastTime = time;
    slide.progress = Math.max(0, progress);
    this.updateSlideTransform();
  };

  // Release: finish the transition when the drag got far or fast enough, else spring back.
  Keyboard.prototype.endSlide = function (time) {
    var slide = this.slide;
    if (!slide) return;
    var elapsed = Math.max(1, time - slide.startTime);
    var speed = Math.max(Math.abs(slide.velocity), Math.abs(slide.progress) / elapsed);
    var commit = slide.target !== null &&
      (slide.progress > slide.size * COMMIT_RATIO || speed > FLICK_SPEED);
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
    var slide = this.slide;
    if (slide.surface === 'bar') this.barPage = slide.target;
    else this.applySwipe(slide.dir);
    this.slides = (this.slides || 0) + 1;
  };

  Keyboard.prototype.animateSlide = function (progress, commit) {
    var slide = this.slide;
    var self = this;
    var view = this.viewOf(slide.surface);
    view.classList.remove('woxi-kb-dragging');
    slide.animating = true;                  // from here on nothing may disturb the slide
    void slide.current.offsetWidth;          // start the transition from the dragged spot
    slide.progress = progress;
    this.updateSlideTransform();
    var onEnd = function (event) {
      if (event.target === slide.current) done();
    };
    var done = function () {
      clearTimeout(slide.timer);
      slide.current.removeEventListener('transitionend', onEnd);
      // A timer or transition from an earlier slide must never end a newer one.
      if (self.slide === slide) self.finishSlide(commit);
    };
    slide.current.addEventListener('transitionend', onEnd);
    slide.timer = setTimeout(done, SLIDE_MS + 80);
  };

  // Puts the layers back to rest and renders the (possibly new) page in place.
  Keyboard.prototype.finishSlide = function () {
    var slide = this.slide;
    if (!slide) return;
    this.slide = null;
    var view = this.viewOf(slide.surface);
    // Reset the layers with the transition switched off: otherwise the reset itself would
    // animate and the viewport would briefly show a half-empty page after every swipe.
    view.classList.add('woxi-kb-dragging');
    slide.current.style.transform = '';
    void slide.current.offsetWidth;
    if (slide.incoming && slide.incoming.parentNode) {
      slide.incoming.parentNode.removeChild(slide.incoming);
    }
    if (slide.surface === 'bar') this.renderBar(); else this.renderPad();
    view.classList.remove('woxi-kb-dragging');
  };

  function Keyboard(handlers) {
    this.handlers = handlers || {};
    this.keysEl = document.getElementById('woxi-kb-keys');
    this.actionsEl = document.getElementById('woxi-kb-actions');
    this.padView = document.getElementById('woxi-kb-pad-view');
    this.barView = document.getElementById('woxi-kb-bar-view');
    this.pageId = 'math';
    this.back = null;            // { page, dir } - the step the opposite swipe undoes
    this.barPage = 0;
    this.shift = SHIFT_OFF;
    this.lastShiftTap = 0;
    this.shiftKeys = [];
    this.slide = null;           // the transition that is running, or the one being dragged
    this.slides = 0;             // committed transitions, for the test hooks
    this.watch(this.padView, 'pad');
    this.watch(this.barView, 'bar');
    this.renderBar();
    this.renderPad();
  }

  // rendering

  Keyboard.prototype.makeKey = function (key) {
    var self = this;
    var classes = 'woxi-key';
    if (key.k) {
      classes += ' ' + key.k.split(' ').map(function (name) { return 'woxi-key-' + name; }).join(' ');
    }
    if (key.s) classes += ' woxi-key-span-' + key.s;
    var btn = el('button', classes, labelFor(key, this.shiftApplies()));
    btn.type = 'button';
    if (key.t) btn.title = key.t;
    btn.setAttribute('data-key', key.l);
    if (key.a === 'shift') btn.setAttribute('data-base', classes);
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      // A drag or a running slide owns the surface. A stray tap (often a second finger)
      // must not press a key under it.
      if (Date.now() < suppressClicksUntil || self.slide) return;
      self.press(key);
    });
    return btn;
  };

  Keyboard.prototype.renderBar = function () {
    this.actionsEl.className = 'woxi-kb-slide woxi-kb-actions';
    this.buildBar(this.barPage, this.actionsEl);
  };

  // Fills `into` with the four buttons of one bar page.
  Keyboard.prototype.buildBar = function (barPage, into) {
    var self = this;
    into.className = 'woxi-kb-slide woxi-kb-actions';
    into.innerHTML = '';
    into.setAttribute('data-bar', String(barPage + 1));
    BARS[barPage].forEach(function (key) { into.appendChild(self.makeKey(key)); });
  };

  Keyboard.prototype.renderPad = function () {
    this.keysEl.className = 'woxi-kb-slide woxi-kb-keys';
    this.shiftKeys = [];
    this.buildPage(this.pageId, this.keysEl);
  };

  // Fills `into` with the keys of one pad page, including its grid geometry.
  Keyboard.prototype.buildPage = function (pageId, into) {
    var page = PAGES[pageId];
    into.className = 'woxi-kb-slide woxi-kb-keys';
    into.innerHTML = '';
    into.setAttribute('data-page', page.id);
    into.setAttribute('data-cols', String(page.cols));
    into.style.gridTemplateColumns = 'repeat(' + page.cols + ', 1fr)';
    for (var i = 0; i < page.keys.length; i++) {
      var node = this.makeKey(page.keys[i]);
      if (into === this.keysEl && page.keys[i].a === 'shift') this.shiftKeys.push(node);
      into.appendChild(node);
    }
    if (into === this.keysEl) this.updateShiftKeys();
  };

  Keyboard.prototype.currentPageId = function () {
    return this.pageId;
  };

  // Shift applies to the letters page only. Other pages always insert what they show.
  Keyboard.prototype.shiftApplies = function () {
    return this.pageId === 'letters' && this.shift !== SHIFT_OFF;
  };

  // gestures

  // Applies a swipe to the state only (no rendering). true when the page changed.
  Keyboard.prototype.applySwipe = function (dir) {
    if (this.back && this.back.dir === OPPOSITE[dir]) {
      // The exact opposite of the swipe that led here: go back, and let the undo be
      // undone again by the opposite swipe.
      var left = this.pageId;
      this.pageId = this.back.page;
      this.back = { page: left, dir: dir };
    } else {
      var next = NEXT[this.pageId][dir];
      if (!next) return false;   // end of the axis: nothing changes, the step is kept
      this.back = { page: this.pageId, dir: dir };
      this.pageId = next;
    }
    // A one-shot shift belongs to the page it was armed on. A lock survives (caps lock).
    if (this.shift === SHIFT_ONESHOT) this.shift = SHIFT_OFF;
    return true;
  };

  // One swipe on the key pad, animated.
  Keyboard.prototype.swipe = function (dir) {
    return this.flick('pad', dir);
  };

  // One swipe on the action bar, animated (its pages loop, so it is never clamped).
  Keyboard.prototype.swipeBar = function (dir) {
    return this.flick('bar', dir);
  };

  // input

  // Shift, as on a modern phone keyboard: one tap arms the next key, two quick taps lock
  // it (caps lock) and a single tap while locked turns the lock off again.
  Keyboard.prototype.toggleShift = function () {
    var now = Date.now();
    var doubleTap = now - this.lastShiftTap < SHIFT_DOUBLE_TAP;
    this.lastShiftTap = now;
    if (this.shift === SHIFT_LOCKED) this.shift = SHIFT_OFF;
    else if (doubleTap) this.shift = SHIFT_LOCKED;
    else if (this.shift === SHIFT_OFF) this.shift = SHIFT_ONESHOT;
    else this.shift = SHIFT_OFF;          // a single tap cancels a one-shot shift
    this.renderPad();                     // the letters change with the mode
  };

  Keyboard.prototype.updateShiftKeys = function () {
    for (var i = 0; i < this.shiftKeys.length; i++) {
      var node = this.shiftKeys[i];
      var classes = node.getAttribute('data-base') || 'woxi-key woxi-key-fn';
      if (this.shift === SHIFT_ONESHOT) classes += ' woxi-key-on';
      if (this.shift === SHIFT_LOCKED) classes += ' woxi-key-locked';
      node.className = classes;
      // Hollow arrow while armed, filled arrow while locked (as on phone keyboards).
      node.textContent = this.shift === SHIFT_LOCKED ? SHIFT_GLYPH_LOCKED : SHIFT_GLYPH;
    }
  };

  Keyboard.prototype.press = function (key) {
    if (key.a === 'shift') { this.toggleShift(); return; }
    if (key.a) {
      if (this.handlers.onAction) this.handlers.onAction(key.a);
      return;
    }
    var spec = insertFor(key, this.shiftApplies());
    var insert = parseInsert(spec);
    if (this.handlers.onInsert) this.handlers.onInsert(insert.text, insert.caret);
    if (this.shift === SHIFT_ONESHOT) {    // the key just consumed it
      this.shift = SHIFT_OFF;
      this.renderPad();
    }
  };

  // test hooks

  // One line describing the visible state, used by the device test harness.
  Keyboard.prototype.describe = function () {
    var page = PAGES[this.pageId];
    var labels = [];
    for (var i = 0; i < page.keys.length; i++) labels.push(labelFor(page.keys[i], this.shiftApplies()));
    var bar = [];
    for (var b = 0; b < BARS[this.barPage].length; b++) bar.push(BARS[this.barPage][b].l);
    var padBox = this.keysEl.getBoundingClientRect();
    var barBox = this.actionsEl.getBoundingClientRect();
    return 'page=' + this.pageId +
      ' back=' + (this.back ? this.back.page + ':' + this.back.dir : '-') +
      ' shift=' + this.shift + ' cols=' + page.cols + ' slides=' + this.slides +      ' bar=' + (this.barPage + 1) + '/' + BARS.length + ' [' + bar.join(' ') + ']' +
      ' padH=' + Math.round(padBox.height) + ' barH=' + Math.round(barBox.height) +
      ' keys=[' + labels.join(' ') + ']';
  };

  // Every key on every page and bar page, so tests can press a key by its label.
  function findKey(label) {
    for (var id in PAGES) {
      if (!Object.prototype.hasOwnProperty.call(PAGES, id)) continue;
      var keys = PAGES[id].keys;
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].l === label || keys[i].L === label) return { key: keys[i], page: id };
      }
    }
    for (var b = 0; b < BARS.length; b++) {
      for (var k = 0; k < BARS[b].length; k++) {
        if (BARS[b][k].l === label) return { key: BARS[b][k], page: 'bar' + (b + 1) };
      }
    }
    return null;
  }

  global.WoxiKeyboard = {
    Keyboard: Keyboard,
    PAGES: PAGES,
    BARS: BARS,
    NEXT: NEXT,
    OPPOSITE: OPPOSITE,
    parseInsert: parseInsert,
    findKey: findKey,
  };
})(window);
