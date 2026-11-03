// Typing assistance: the context bar above the keys, and the sheet it expands into.
//
// The bar has one state at a time (idle, signature, candidates, options) and never
// covers the entry or the plot: it is the first page of the action bar that used to
// hold only Eval/Plot/Solve/backspace, so it costs no vertical space at all.
//
// Everything about symbols comes from the engine, over Jupyter-shaped messages:
// `complete_request` ranks the names that match the prefix (including the session's
// own variables), `inspect_request` says what a symbol is and which options it takes,
// and `is_complete_request` tells whether the entry is finished. Nothing here evaluates
// the entry: asking a question about the text is not running it.
(function (global) {
  'use strict';

  var BAR_PAGE = 0;            // the context page of the action bar
  var MAX_CHIPS = 3;
  var MATCH_LIMIT = 24;        // bar suggestions per request
  var SHEET_LIMIT = 200;       // the sheet shows more of the same list
  var DEBOUNCE_MS = 50;
  var OPTION_CACHE_MAX = 40;

  // Slot names for the functions the keyboard puts in front of the user. Woxi's data
  // has a description and an argument count per symbol but no parameter names, so
  // these are presentation only: the caret is placed by counting commas in what the
  // user typed, and nothing is ever validated against this table.
  var PROTOTYPES = {
    Plot: 'f, {x, xmin, xmax}',
    Plot3D: 'f, {x, xmin, xmax}, {y, ymin, ymax}',
    ContourPlot: 'f, {x, xmin, xmax}, {y, ymin, ymax}',
    DensityPlot: 'f, {x, xmin, xmax}, {y, ymin, ymax}',
    RegionPlot: 'cond, {x, xmin, xmax}, {y, ymin, ymax}',
    VectorPlot: '{vx, vy}, {x, xmin, xmax}, {y, ymin, ymax}',
    StreamPlot: '{vx, vy}, {x, xmin, xmax}, {y, ymin, ymax}',
    PolarPlot: 'r, {t, tmin, tmax}',
    ParametricPlot: '{xexpr, yexpr}, {t, tmin, tmax}',
    ParametricPlot3D: '{xexpr, yexpr, zexpr}, {t, tmin, tmax}',
    SphericalPlot3D: 'r, {u, umin, umax}, {v, vmin, vmax}',
    RevolutionPlot3D: 'f, {x, xmin, xmax}',
    ComplexPlot: 'f, {z, zmin, zmax}',
    ComplexPlot3D: 'f, {z, zmin, zmax}',
    DiscretePlot3D: 'f, {x, xmin, xmax}, {y, ymin, ymax}',
    ListPlot: 'data',
    ListLinePlot: 'data',
    ListPlot3D: 'data',
    ArrayPlot: 'array',
    Histogram: 'data',
    BoxWhiskerChart: 'data',
    Table: 'expr, {i, imax}',
    Sum: 'expr, {i, imax}',
    Product: 'expr, {i, imax}',
    NSum: 'expr, {i, imax}',
    Integrate: 'f, x',
    D: 'f, x',
    Solve: 'eqns, vars',
    NSolve: 'eqns, vars',
    NDSolve: 'eqns, y, {x, xmin, xmax}',
    FindRoot: 'eqns, {x, x0}',
    Minimize: 'f, vars',
    Maximize: 'f, vars',
    Limit: 'f, x -> x0',
    Series: 'f, {x, x0, n}',
    Fit: 'data, basis, vars',
    Manipulate: 'expr, {u, umin, umax}',
    Animate: 'expr, {u, umin, umax}',
    Show: 'graphics',
    Graphics: 'primitives',
    Piecewise: 'pairs, x',
  };

  // text scanning

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isIdentChar(ch) {
    return /[A-Za-z0-9$`]/.test(ch);
  }

  // The identifier that ends at `caret`, plus where it starts.
  function prefixSpan(code, caret) {
    var start = caret;
    while (start > 0 && isIdentChar(code.charAt(start - 1))) start -= 1;
    return { start: start, end: caret, text: code.slice(start, caret) };
  }

  var CLOSER = { '[': ']', '{': '}', '(': ')' };
  var MAP_CLOSER = CLOSER;

  // The calls the caret is inside, innermost last. Strings and comments are skipped
  // so a `[` inside `"..."` never opens a call.
  function scanContext(code, caret) {
    var stack = [];
    var inString = false;
    var commentDepth = 0;
    var i = 0;
    while (i < caret) {
      var ch = code.charAt(i);
      if (commentDepth > 0) {
        if (ch === '(' && code.charAt(i + 1) === '*') { commentDepth += 1; i += 2; continue; }
        if (ch === '*' && code.charAt(i + 1) === ')') { commentDepth -= 1; i += 2; continue; }
        i += 1;
        continue;
      }
      if (inString) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === '"') inString = false;
        i += 1;
        continue;
      }
      if (ch === '"') { inString = true; i += 1; continue; }
      if (ch === '(' && code.charAt(i + 1) === '*') { commentDepth = 1; i += 2; continue; }
      if (ch === '[' || ch === '{' || ch === '(') {
        var head = '';
        if (ch === '[') head = prefixSpan(code, i).text;
        stack.push({ open: i, ch: ch, head: head, args: 1 });
        i += 1;
        continue;
      }
      if (ch === ']' || ch === '}' || ch === ')') {
        if (stack.length) stack.pop();
        i += 1;
        continue;
      }
      if (ch === ',' && stack.length) {
        stack[stack.length - 1].args += 1;
      }
      i += 1;
    }
    var inner = stack.length ? stack[stack.length - 1] : null;
    // The call the caret is in is the innermost `[...]`, even when the caret sits in a
    // `{...}` argument of it: the signature and the option position belong to the call.
    var call = null;
    for (var k = stack.length - 1; k >= 0; k -= 1) {
      if (stack[k].ch === '[') { call = stack[k]; break; }
    }
    return {
      stack: stack,
      open: inner,
      call: call,
      head: call ? call.head : '',
      argIndex: call ? call.args - 1 : 0,
      inString: inString,
      commentDepth: commentDepth,
    };
  }

  // The brackets (and quote) that would close the input, outermost last. Used when
  // Eval is pressed on an unfinished call.
  function closersFor(code, caret) {
    var ctx = scanContext(code, caret);
    if (ctx.commentDepth > 0) return '';
    var tail = '';
    for (var i = ctx.stack.length - 1; i >= 0; i -= 1) {
      var closer = CLOSER[ctx.stack[i].ch];
      if (!closer) return '';
      tail += closer;
    }
    if (ctx.inString) tail += '"';
    return tail;
  }

  // Splits a prototype into its top-level slots (`f, {x, a, b}` -> two slots).
  function slotsOf(prototype) {
    var slots = [];
    var depth = 0;
    var current = '';
    for (var i = 0; i < prototype.length; i += 1) {
      var ch = prototype.charAt(i);
      if (ch === '{' || ch === '[' || ch === '(') depth += 1;
      if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        slots.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) slots.push(current.trim());
    return slots;
  }

  // Where the argument the caret is in starts: after the previous top-level comma, or
  // after the bracket that opened it.
  function argumentStart(code, caret, open) {
    var depth = 0;
    for (var i = caret - 1; i >= 0; i -= 1) {
      var ch = code.charAt(i);
      if (ch === ']' || ch === '}' || ch === ')') depth += 1;
      else if (ch === '[' || ch === '{' || ch === '(') {
        if (depth === 0) return i + 1;
        depth -= 1;
      } else if (ch === ',' && depth === 0) {
        return i + 1;
      }
    }
    return open ? open.open + 1 : 0;
  }

  // Where the next argument starts: after the next top-level comma, or just before
  // the bracket that closes the call.
  function nextSlotCaret(code, caret, open) {
    var depth = 0;
    for (var i = caret; i < code.length; i += 1) {
      var ch = code.charAt(i);
      if (ch === '"') {
        i += 1;
        while (i < code.length && code.charAt(i) !== '"') {
          if (code.charAt(i) === '\\') i += 1;
          i += 1;
        }
        continue;
      }
      if (ch === '[' || ch === '{' || ch === '(') depth += 1;
      else if (ch === ']' || ch === '}' || ch === ')') {
        if (depth === 0) return i;
        depth -= 1;
      } else if (ch === ',' && depth === 0) {
        var next = i + 1;
        while (next < code.length && code.charAt(next) === ' ') next += 1;
        return next;
      }
    }
    return null;
  }

  // the assist controller

  function Assist(sink) {
    this.sink = sink;            // { read, replace, setCaret, evaluate, templates, insert }
    this.keyboard = null;
    this.query = null;           // (msgType, content) -> Promise of the reply
    this.seq = 0;
    this.timer = null;
    this.prefix = '';
    this.matches = { names: [], details: [], total: 0, start: 0, end: 0 };
    this.state = 'idle';
    this.options = {};           // call head -> option names
    this.optionOrder = [];
    this.optionHead = '';
    this.sheetTab = 'all';
    this.sheetOpen = false;
    this.cache = {};
    this.about = null;
    this.catalog = null;
    this.catalogAsked = false;
    this.dom = null;
    this.keysSignature = '';
  }

  Assist.prototype.bind = function (keyboard, query) {
    this.keyboard = keyboard;
    this.query = query;
    this.buildSheet();
  };

  // How much is indexed, for the empty sheet. One request per session, and only when
  // the sheet is opened for the first time (the engine may not exist yet at bind time).
  Assist.prototype.ensureCatalog = function () {
    var self = this;
    if (this.catalog || this.catalogAsked || !this.query) return;
    this.catalogAsked = true;
    this.query('catalog_request', {}).then(function (reply) {
      if (reply && reply.status === 'ok' && reply.content) self.catalog = reply.content;
      if (self.sheetOpen) self.renderSheet();
    }, function () {
      self.catalogAsked = false;
    });
  };

  // bar

  Assist.prototype.idleKeys = function () {
    return [
      { l: 'Eval', a: 'enter', k: 'ok', g: 1.2, t: 'Evaluate this entry' },
      { l: 'Plot', a: 'plot', k: 'fn', t: 'Wrap the entry in Plot[...]' },
      { l: 'Solve', a: 'solve', k: 'fn', t: 'Wrap the entry in Solve[...]' },
      { l: '\u2190', a: 'back', k: 'danger', g: 0.9, t: 'Backspace' },
    ];
  };

  Assist.prototype.setKeys = function (keys) {
    if (!this.keyboard) return;
    // Re-rendering replaces the buttons, and a button that disappears under a finger
    // never fires its click. Refreshes happen on every keystroke and caret move, so
    // identical key lists must leave the bar alone.
    var signature = keys
      .map(function (key) { return key.l + '|' + (key.h || '') + '|' + (key.d ? key.d.name || key.d.kind : ''); })
      .join(';');
    if (signature === this.keysSignature) return;
    this.keysSignature = signature;
    this.keyboard.setBarKeys(BAR_PAGE, keys);
  };

  Assist.prototype.renderIdle = function () {
    if (this.state === 'idle') return;
    this.state = 'idle';
    this.prefix = '';
    this.matches = { names: [], details: [], total: 0, start: 0, end: 0 };
    this.setKeys(this.idleKeys());
  };

  Assist.prototype.chipKeys = function (names, details, total) {
    var keys = [{ l: 'Eval', a: 'enter', k: 'ok', g: 1.1, t: 'Evaluate this entry' }];
    for (var i = 0; i < names.length && i < MAX_CHIPS; i += 1) {
      var detail = details[i] || {};
      keys.push({
        l: names[i],
        a: 'assist',
        d: { kind: 'accept', name: names[i] },
        k: detail.implemented === 0 ? 'fn dim' : 'fn chip',
        g: 1.25,
        t: detail.description || names[i],
      });
    }
    if (total > names.length) {
      var hidden = total - names.length;
      keys.push({
        l: '+' + hidden,
        a: 'assist',
        d: { kind: 'more' },
        k: 'fn',
        g: 0.95,
        t: hidden + ' more matches',
      });
    }
    keys.push({ l: '\u2190', a: 'back', k: 'danger', g: 0.8, t: 'Backspace' });
    return keys;
  };

  Assist.prototype.renderSignature = function (slots, active) {
    this.state = 'signature';
    this.prefix = '';
    var html = '';
    for (var i = 0; i < slots.length; i += 1) {
      if (i > 0) html += '<span class="woxi-sig-sep">, </span>';
      html += '<span class="woxi-sig' + (i === active ? ' woxi-sig-on' : '') + '">' +
        escapeHtml(slots[i]) + '</span>';
    }
    this.setKeys([
      { l: 'Eval', a: 'enter', k: 'ok', g: 1.1, t: 'Evaluate this entry' },
      { l: 'signature', h: html, a: 'assist', d: { kind: 'next' }, k: 'sig', g: 3.1, t: 'Tap to move to the next argument' },
      { l: '\u2304', a: 'assist', d: { kind: 'more' }, k: 'fn', g: 0.8, t: 'All matches' },
      { l: '\u2190', a: 'back', k: 'danger', g: 0.8, t: 'Backspace' },
    ]);
  };

  // What the caret is in the middle of, and the bar state that answers it.
  Assist.prototype.refresh = function () {
    var read = this.sink.read();
    if (!read) {
      this.renderIdle();
      if (this.sheetOpen) this.closeSheet();
      return;
    }
    var code = read.code;
    var caret = read.caret;
    var ctx = scanContext(code, caret);
    var span = prefixSpan(code, caret);
    var head = ctx.head;
    var slots = PROTOTYPES[head] ? slotsOf(PROTOTYPES[head]) : null;
    var before = code.slice(0, caret);

    // Inside a string or a comment there is nothing to complete.
    if (ctx.inString || ctx.commentDepth > 0) {
      this.renderIdle();
      return;
    }

    // A value after `->` is data, not a symbol name.
    if (/->\s*$/.test(before)) {
      this.renderIdle();
      return;
    }

    var optionPosition = !!head && !!slots && ctx.argIndex >= slots.length;
    if (optionPosition) {
      this.showOptions(head);
      return;
    }

    // Only a name prefix is worth completing: a digit is an argument, and inside a
    // string or a comment there is nothing to complete.
    if (/^[A-Za-z$`]/.test(span.text)) {
      this.requestMatches(span.text);
      return;
    }

    if (head && slots) {
      var slot = slots[Math.min(ctx.argIndex, slots.length - 1)];
      // An empty iterator argument (`{`) is the other thing a keyboard key cannot spell
      // in one tap, so it gets chips of its own. Once it has content the caret is just
      // editing that argument, and a chip would splice a second `{x, ...}` into it.
      var emptyIterator = slot && slot.charAt(0) === '{' && ctx.open && ctx.open.ch === '{' &&
        code.slice(ctx.open.open + 1, caret).trim() === '';
      if (emptyIterator) {
        this.showIterator(slot);
        return;
      }
      this.prefix = '';
      this.renderSignature(slots, Math.min(ctx.argIndex, slots.length - 1));
      return;
    }
    this.renderIdle();
  };

  // Domains a plot or table iterates over, with the variable the prototype names.
  var ITERATOR_RANGES = ['-5, 5', '0, 2 Pi', '0, 1'];

  Assist.prototype.showIterator = function (slot) {
    var match = /^\{\s*([A-Za-z][A-Za-z0-9]*)/.exec(slot);
    var variable = match ? match[1] : 'x';
    this.state = 'iterator';
    this.prefix = '';
    var keys = [{ l: 'Eval', a: 'enter', k: 'ok', g: 1.1, t: 'Evaluate this entry' }];
    for (var i = 0; i < ITERATOR_RANGES.length - 1; i += 1) {
      var text = '{' + variable + ', ' + ITERATOR_RANGES[i] + '}';
      keys.push({
        l: text,
        a: 'assist',
        d: { kind: 'accept', name: text },
        k: 'fn chip',
        g: 1.7,
        t: 'Iterate ' + variable + ' over ' + ITERATOR_RANGES[i],
      });
    }
    keys.push({ l: '\u2304', a: 'assist', d: { kind: 'more' }, k: 'fn', g: 0.8, t: 'All matches' });
    keys.push({ l: '\u2190', a: 'back', k: 'danger', g: 0.8, t: 'Backspace' });
    this.setKeys(keys);
  };

  // suggestions

  Assist.prototype.requestMatches = function (prefix) {
    var self = this;
    var limit = this.sheetOpen ? SHEET_LIMIT : MATCH_LIMIT;
    var key = prefix + '@' + limit;
    var cached = this.cache[key];
    if (cached) {
      this.matches = cached;
      this.state = 'candidates';
      if (this.sheetOpen) this.renderSheet();
      this.setKeys(this.chipKeys(cached.names, cached.details, cached.total));
      return;
    }
    if (this.timer) global.clearTimeout(this.timer);
    this.timer = global.setTimeout(function () {
      self.timer = null;
      self.fetchMatches(prefix, limit);
    }, DEBOUNCE_MS);
  };

  Assist.prototype.fetchMatches = function (prefix, limit) {
    var self = this;
    if (!this.query) return;
    var read = this.sink.read();
    if (!read) return;
    var seq = ++this.seq;
    this.prefix = prefix;
    this.query('complete_request', { code: read.code, cursor_pos: read.caret, limit: limit })
      .then(function (reply) {
        if (seq !== self.seq || !reply || reply.status !== 'ok') return;
        var content = reply.content || {};
        var names = content.matches || [];
        var meta = content.metadata || {};
        var types = meta._jupyter_types_experimental || [];
        var extra = meta._woxi || [];
        var details = [];
        for (var i = 0; i < names.length; i += 1) {
          details.push({
            description: (types[i] && types[i].docstring) || '',
            implemented: (extra[i] && extra[i].implemented) || 0,
            category: (extra[i] && extra[i].category) || '',
            doc: (extra[i] && extra[i].doc) || '',
          });
        }
        var result = {
          names: names,
          details: details,
          total: typeof meta.total === 'number' ? meta.total : names.length,
          start: content.cursor_start || 0,
          end: content.cursor_end || 0,
        };
        self.cache[prefix + '@' + limit] = result;
        self.matches = result;
        self.state = 'candidates';
        if (self.sheetOpen) self.renderSheet();
        self.setKeys(self.chipKeys(result.names, result.details, result.total));
      });
  };

  Assist.prototype.apply = function (name) {
    var read = this.sink.read();
    if (!read) return;
    var code = read.code;
    var caret = read.caret;
    var span = prefixSpan(code, caret);
    var start = span.start;
    var end = caret;
    var insert = name;
    var after = name.length;
    // A call name opens its bracket: on a phone that is two keys the user does not
    // have to find, and the signature bar takes over from there.
    if (PROTOTYPES[name] && code.charAt(caret) !== '[') {
      insert = name + '[';
      after = insert.length;
    }
    // The bracket keys insert pairs, so accepting a name inside an empty pair fills it
    // instead of nesting a second one (`{` + `{x, 0, 1}` was becoming `{{x, 0, 1}}`).
    var ctx = scanContext(code, caret);
    if (ctx.open && start === caret && MAP_CLOSER[ctx.open.ch] === code.charAt(caret)) {
      if (code.slice(ctx.open.open + 1, caret).trim() === '') {
        start = ctx.open.open;
        end = caret + 1;
        insert = name;
        after = name.length;
      }
    }
    this.sink.replace(start, end, insert, after);
    if (this.sheetOpen) this.closeSheet();
  };

  Assist.prototype.nextSlot = function () {
    var read = this.sink.read();
    if (!read) return;
    var ctx = scanContext(read.code, read.caret);
    if (!ctx.open) return;
    var at = nextSlotCaret(read.code, read.caret, ctx.open);
    if (at !== null) {
      this.sink.setCaret(at);
      return;
    }
    // The call is not closed yet and there is no comma ahead: start the next argument
    // with one, which is the edit the user would have made by hand. An empty argument
    // gets no comma: there is nothing to move past.
    var before = read.code.slice(0, read.caret);
    var argument = read.code.slice(argumentStart(read.code, read.caret, ctx.open), read.caret);
    if (argument.trim() !== '' && /[^,\s]$/.test(before)) {
      this.sink.replace(read.caret, read.caret, ', ', 2);
    }
  };

  // options

  Assist.prototype.showOptions = function (head) {
    var self = this;
    var cached = this.options[head];
    if (cached) {
      this.renderOptions(head, cached);
      return;
    }
    if (!this.query) return;
    var seq = ++this.seq;
    this.query('inspect_request', { code: head + '[', cursor_pos: head.length })
      .then(function (reply) {
        if (seq !== self.seq || !reply || reply.status !== 'ok') return;
        var meta = (reply.content && reply.content.metadata) || {};
        var info = meta._woxi || {};
        var names = info.options || [];
        self.rememberOptions(head, names);
        var read = self.sink.read();
        if (!read) return;
        var ctx = scanContext(read.code, read.caret);
        if (ctx.head === head) self.renderOptions(head, names);
      });
  };

  Assist.prototype.rememberOptions = function (head, names) {
    this.options[head] = names;
    this.optionOrder.push(head);
    if (this.optionOrder.length > OPTION_CACHE_MAX) {
      var dropped = this.optionOrder.shift();
      delete this.options[dropped];
    }
  };

  Assist.prototype.renderOptions = function (head, names) {
    var read = this.sink.read();
    if (!read) return;
    var span = prefixSpan(read.code, read.caret);
    var shown = [];
    for (var i = 0; i < names.length; i += 1) {
      if (span.text && names[i].toLowerCase().indexOf(span.text.toLowerCase()) !== 0) continue;
      shown.push(names[i]);
      if (shown.length === MAX_CHIPS) break;
    }
    if (!shown.length && !span.text) {
      this.renderIdle();
      return;
    }
    this.state = 'options';
    this.prefix = '';
    var keys = [{ l: 'Eval', a: 'enter', k: 'ok', g: 1.1, t: 'Evaluate this entry' }];
    for (var k = 0; k < shown.length; k += 1) {
      keys.push({
        l: shown[k],
        a: 'assist',
        d: { kind: 'accept', name: shown[k] },
        k: 'fn chip',
        g: 1.25,
        t: 'Option of ' + head,
      });
    }
    keys.push({ l: '\u2304', a: 'assist', d: { kind: 'more' }, k: 'fn', g: 0.8, t: 'Options of ' + head });
    keys.push({ l: '\u2190', a: 'back', k: 'danger', g: 0.8, t: 'Backspace' });
    this.setKeys(keys);
  };

  // sheet

  Assist.prototype.buildSheet = function () {
    var self = this;
    var root = document.createElement('div');
    root.id = 'woxi-assist';
    root.className = 'woxi-hidden';
    root.innerHTML =
      '<div id="woxi-assist-panel">' +
      '<div id="woxi-assist-head">' +
      '<div id="woxi-assist-tabs">' +
      '<button type="button" class="woxi-assist-tab" data-tab="all" tabindex="-1">Matches</button>' +
      '<button type="button" class="woxi-assist-tab" data-tab="examples" tabindex="-1">Examples</button>' +
      '<button type="button" class="woxi-assist-tab" data-tab="about" tabindex="-1">About</button>' +
      '</div>' +
      '<button type="button" id="woxi-assist-close" tabindex="-1">Close</button>' +
      '</div>' +
      '<div id="woxi-assist-body"></div>' +
      '</div>';
    document.body.appendChild(root);
    this.dom = root;

    // A tap must not take focus away from the entry: the user keeps typing while the
    // list is open, and the list keeps filtering.
    root.addEventListener('mousedown', function (event) { event.preventDefault(); });
    root.addEventListener('touchstart', function (event) {
      if (event.target === root) self.closeSheet();
    }, { passive: true });
    root.querySelector('#woxi-assist-close').addEventListener('click', function () {
      self.closeSheet();
    });
    var tabs = root.querySelectorAll('.woxi-assist-tab');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', function (event) {
        self.sheetTab = event.currentTarget.getAttribute('data-tab');
        self.renderSheet();
      });
    }
    root.querySelector('#woxi-assist-body').addEventListener('click', function (event) {
      var row = event.target.closest
        ? event.target.closest('[data-assist-insert],[data-assist-template]')
        : null;
      if (!row) return;
      var value = row.getAttribute('data-assist-insert');
      var template = row.getAttribute('data-assist-template');
      if (template) {
        self.sink.evaluate(template);
        self.closeSheet();
        return;
      }
      self.apply(value);
    });
  };

  Assist.prototype.openSheet = function (tab) {
    if (!this.dom) return;
    if (tab) this.sheetTab = tab;
    this.sheetOpen = true;
    var keyboard = document.getElementById('woxi-keyboard');
    var height = keyboard ? Math.round(keyboard.getBoundingClientRect().height) : 0;
    // The scrim stops above the keys: the keyboard stays usable, so typing keeps
    // narrowing the list while it is open.
    this.dom.style.bottom = height + 'px';
    this.dom.classList.remove('woxi-hidden');
    this.ensureCatalog();
    this.renderSheet();
    // The sheet lists more than the bar: ask again with the larger limit.
    if (this.sheetTab === 'all') this.refresh();
  };

  Assist.prototype.closeSheet = function () {
    this.sheetOpen = false;
    this.about = null;
    if (this.dom) this.dom.classList.add('woxi-hidden');
  };

  Assist.prototype.renderSheet = function () {
    if (!this.dom) return;
    if (!this.sheetOpen) return;
    var body = this.dom.querySelector('#woxi-assist-body');
    var tabs = this.dom.querySelectorAll('.woxi-assist-tab');
    for (var i = 0; i < tabs.length; i += 1) {
      var on = tabs[i].getAttribute('data-tab') === this.sheetTab;
      tabs[i].classList.toggle('woxi-on', on);
    }
    var rows = [];
    if (this.sheetTab === 'examples') {
      rows = this.exampleRows();
    } else if (this.sheetTab === 'about') {
      rows = this.aboutRows();
    } else {
      rows = this.matchRows();
    }
    body.innerHTML = rows.length ? rows.join('') : '<div class="woxi-assist-empty">' +
      escapeHtml(this.emptyHint()) + '</div>';
  };

  Assist.prototype.emptyHint = function () {
    if (this.sheetTab === 'about') return 'Put the caret on a name to see what it is.';
    if (this.sheetTab === 'examples') return 'No examples here.';
    if (this.prefix) return 'No match for "' + this.prefix + '".';
    if (this.catalog && this.catalog.total) {
      return this.catalog.total + ' symbols from Woxi ' + this.catalog.version + ' \u2014 type a name.';
    }
    return 'Type a name to see matches.';
  };

  Assist.prototype.matchRows = function () {
    var names = this.matches.names || [];
    var details = this.matches.details || [];
    var rows = [];
    for (var i = 0; i < names.length; i += 1) {
      var detail = details[i] || {};
      var meta = [];
      if (detail.category) meta.push(detail.category);
      if (detail.implemented === 0) meta.push('not implemented');
      rows.push(
        '<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-insert="' +
        escapeHtml(names[i]) + '">' +
        '<span class="woxi-assist-name">' + escapeHtml(names[i]) + '</span>' +
        '<span class="woxi-assist-desc">' + escapeHtml(detail.description || '') + '</span>' +
        (meta.length ? '<span class="woxi-assist-meta">' + escapeHtml(meta.join(' \u00b7 ')) + '</span>' : '') +
        '</button>'
      );
    }
    return rows;
  };

  Assist.prototype.exampleRows = function () {
    var templates = this.sink.templates ? this.sink.templates() : [];
    var rows = [];
    for (var i = 0; i < templates.length; i += 1) {
      rows.push(
        '<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-template="' +
        escapeHtml(templates[i].insert) + '">' +
        '<span class="woxi-assist-name">' + escapeHtml(templates[i].label) + '</span>' +
        '<span class="woxi-assist-desc">' + escapeHtml(templates[i].hint || '') + '</span>' +
        '</button>'
      );
    }
    return rows;
  };

  Assist.prototype.aboutRows = function () {
    var read = this.sink.read();
    if (!read) return [];
    var ctx = scanContext(read.code, read.caret);
    var span = prefixSpan(read.code, read.caret);
    var name = span.text;
    if (!name && ctx.head) name = ctx.head;
    if (!name) return [];
    if (this.about && this.about.name === name) return this.about.rows;
    var self = this;
    if (!this.query) return [];
    this.query('inspect_request', { code: name + '[', cursor_pos: name.length }).then(function (reply) {
      if (!reply || reply.status !== 'ok' || !reply.content || !reply.content.found) {
        self.about = { name: name, rows: ['<div class="woxi-assist-empty">Nothing known about ' + escapeHtml(name) + '.</div>'] };
      } else {
        var meta = (reply.content.metadata && reply.content.metadata._woxi) || {};
        var lines = ['<div class="woxi-assist-about"><div class="woxi-assist-about-name">' +
          escapeHtml(meta.name || name) + '</div>'];
        if (meta.description) lines.push('<div class="woxi-assist-about-line">' + escapeHtml(meta.description) + '</div>');
        if (meta.arity) {
          var arity = meta.arity[1] === null ? meta.arity[0] + ' or more arguments'
            : meta.arity[0] === meta.arity[1] ? meta.arity[0] + ' argument(s)'
              : meta.arity[0] + ' to ' + meta.arity[1] + ' arguments';
          lines.push('<div class="woxi-assist-about-line">' + escapeHtml(arity) + '</div>');
        }
        if (meta.implemented === 0) lines.push('<div class="woxi-assist-about-line woxi-assist-warn">Not implemented in Woxi yet.</div>');
        if (meta.options && meta.options.length) {
          var shown = meta.options.slice(0, 12).join(', ');
          var rest = meta.options.length - Math.min(12, meta.options.length);
          lines.push('<div class="woxi-assist-about-line">Options: ' + escapeHtml(shown) +
            (rest > 0 ? ' \u2026 and ' + rest + ' more' : '') + '</div>');
        }
        if (meta.doc) lines.push('<div class="woxi-assist-about-line woxi-assist-doc">' + escapeHtml(meta.doc) + '</div>');
        lines.push('</div>');
        self.about = { name: name, rows: lines };
      }
      if (self.sheetOpen && self.sheetTab === 'about') self.renderSheet();
    });
    return ['<div class="woxi-assist-empty">Loading\u2026</div>'];
  };

  // keyboard actions

  Assist.prototype.action = function (data) {
    if (!data) return;
    if (data.kind === 'accept') this.apply(data.name);
    else if (data.kind === 'next') this.nextSlot();
    else if (data.kind === 'more') this.openSheet('all');
  };

  // Session symbols change when an entry runs, so the ranked answers are stale.
  Assist.prototype.invalidate = function () {
    this.cache = {};
    this.about = null;
  };

  global.WoxiAssist = {
    Assist: Assist,
    PROTOTYPES: PROTOTYPES,
    scanContext: scanContext,
    closersFor: closersFor,
    slotsOf: slotsOf,
    prefixSpan: prefixSpan,
  };
})(window);
