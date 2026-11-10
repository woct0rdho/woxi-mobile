// Typing assistance: the context bar above the keys, and the sheet it expands into.
//
// One row, one state. The bar answers "what can go here" while the caret is in a call
// (signature, iterator, options), "what is this name" while a name is being typed
// (candidates, with implementation status), and "what is wrong" when the engine found
// something (issues). Everything else lives in the sheet.
//
// The engine answers over Jupyter-shaped messages: `complete_request`,
// `inspect_request`, `is_complete_request`, `diagnostics_request`,
// `prototypes_request`, `definitions_request`, plus the `catalog_request` extension.
// None of them evaluates the entry. Slot names and roles are the one thing the engine
// cannot know (Wolfram has no usage patterns in Woxi's registry), so they are curated
// here and enriched with what `prototypes_request` learns from the shipped examples.

(function (global) {
  'use strict';

  var BAR_PAGE = 0;
  var MAX_CHIPS = 3;
  var MATCH_LIMIT = 24;
  var SHEET_LIMIT = 200;
  var DEBOUNCE_MS = 50;
  var DEFINITIONS_MS = 400;
  var DIAGNOSTICS_MS = 350;
  var OPTION_CACHE_MAX = 40;

  // The curated table and the slot-role helpers live in prototypes.js: presentation
  // data, not controller state.
  var curated = global.WoxiPrototypes;
  var PROTOTYPES = curated.PROTOTYPES;
  var STATUS_LABEL = curated.STATUS_LABEL;
  var slotsOf = curated.slotsOf;
  var iteratorVariable = curated.iteratorVariable;
  var curatedVariant = curated.curatedVariant;
  var roleLabel = curated.roleLabel;
  var isCallName = curated.isCallName;

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

  // The brackets (and quote) that would close the input, outermost last.
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


  // Where the argument the caret is in starts: after the previous top-level comma, or
  // after the bracket that opened it.
  function argumentStart(code, caret) {
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
    return 0;
  }

  // Where the argument the caret is in ends: the next top-level comma or closing
  // bracket of the enclosing call.
  function argumentEnd(code, caret) {
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
        return i;
      }
    }
    return code.length;
  }

  // The index of the closer that matches the opener at `at`, or -1. Strings and
  // `(* comments *)` are skipped, so a bracket inside them does not count.
  function matchForward(code, at) {
    var open = code.charAt(at);
    var closer = open === '<' ? '>' : CLOSER[open];
    if (!closer) return -1;
    var depth = 0;
    for (var i = at; i < code.length; i += 1) {
      var ch = code.charAt(i);
      if (ch === '"') {
        i += 1;
        while (i < code.length && code.charAt(i) !== '"') {
          if (code.charAt(i) === '\\') i += 1;
          i += 1;
        }
        continue;
      }
      if (ch === '(' && code.charAt(i + 1) === '*') {
        var comment = 1;
        i += 2;
        while (i < code.length && comment) {
          if (code.charAt(i) === '(' && code.charAt(i + 1) === '*') { comment += 1; i += 2; continue; }
          if (code.charAt(i) === '*' && code.charAt(i + 1) === ')') { comment -= 1; i += 2; continue; }
          i += 1;
        }
        continue;
      }
      if (open === '<') {
        if (ch === '<' && code.charAt(i + 1) === '|') depth += 1;
        else if (ch === '|' && code.charAt(i + 1) === '>') {
          depth -= 1;
          if (depth === 0) return i;
        }
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === closer) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // The operand that starts at `at`, after spaces: a function call, an identifier, a
  // number, a string or a bracketed group. An operator or a delimiter is not an operand,
  // so there is nothing to wrap there. Only one operand is measured - an expression such
  // as `x + 1` is wrapped by selecting it.
  function operandAt(code, at) {
    var i = at;
    while (i < code.length && /\s/.test(code.charAt(i))) i += 1;
    if (i >= code.length) return null;
    var start = i;
    var ch = code.charAt(i);
    if (/[A-Za-z$`]/.test(ch)) {
      while (i < code.length && /[A-Za-z0-9$`]/.test(code.charAt(i))) i += 1;
      var afterName = i;
      while (afterName < code.length && /\s/.test(code.charAt(afterName))) afterName += 1;
      if (code.charAt(afterName) === '[') {
        var close = matchForward(code, afterName);
        if (close >= 0) return { start: start, end: close + 1 };
      }
      return { start: start, end: i };
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code.charAt(i + 1)))) {
      while (i < code.length && /[0-9.]/.test(code.charAt(i))) i += 1;
      return { start: start, end: i };
    }
    if (ch === '"') {
      i += 1;
      while (i < code.length) {
        if (code.charAt(i) === '\\') i += 1;
        else if (code.charAt(i) === '"') { i += 1; break; }
        i += 1;
      }
      return { start: start, end: i };
    }
    if (ch === '(' || ch === '{' || (ch === '<' && code.charAt(i + 1) === '|')) {
      var matched = matchForward(code, i);
      if (matched < 0) return null;
      return { start: start, end: ch === '<' ? matched + 2 : matched + 1 };
    }
    return null;
  }

  function nextSlotCaret(code, caret) {
    var end = argumentEnd(code, caret);
    if (end >= code.length) return null;
    if (code.charAt(end) === ',') {
      var next = end + 1;
      while (next < code.length && code.charAt(next) === ' ') next += 1;
      return next;
    }
    return end;
  }


  // the assist controller

  function Assist(sink) {
    this.sink = sink; // {read, replace, setCaret, select, evaluate, templates, entryId, codes}
    this.keyboard = null;
    this.query = null;
    this.seq = 0;
    this.timer = null;
    this.prefix = '';
    this.matches = { names: [], details: [], total: 0, start: 0, end: 0 };
    this.state = 'idle';
    this.options = {}; // call head -> [{name, default}]
    this.optionOrder = [];
    this.optionHead = '';
    this.sheetTab = 'matches';
    this.sheetOpen = false;
    this.cache = {};
    this.about = null;
    this.catalog = null;
    this.catalogAsked = false;
    this.dom = null;
    this.keysSignature = '';
    this.learned = {}; // head -> [variant] from the engine
    this.learnedAsked = false;
    this.definitions = []; // [{entry, name, params, start, end}]
    this.definitionsAsked = '';
    this.definitionsTimer = null;
    this.issues = [];
    this.issuesText = '';
    this.diagnosticsTimer = null;
    this.variantChoice = {}; // head -> index chosen in the call card
    this.errors = 0;
  }

  Assist.prototype.bind = function (keyboard, query) {
    this.keyboard = keyboard;
    this.query = query;
    this.buildSheet();
    this.ensureCatalog();
    this.ensurePrototypes();
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

  Assist.prototype.idleKeys = function (extra) {
    var keys = [
      { l: 'Eval', a: 'enter', k: 'ok', g: 1.2, t: 'Evaluate this entry' },
      { l: 'Plot', i: 'Plot[|]', k: 'fn', t: 'Plot[...] - hold for a skeleton' },
      { l: 'Solve', i: 'Solve[|]', k: 'fn', t: 'Solve[...] - hold for a skeleton' },
    ];
    return keys.concat(extra || [], [
      { l: '\u2190', a: 'back', k: 'danger', g: 0.9, t: 'Backspace' },
    ]);
  };

  Assist.prototype.setKeys = function (keys) {
    if (!this.keyboard) return;
    // Re-rendering replaces the buttons, and a button that disappears under a finger
    // never fires its click. Refreshes happen on every keystroke and caret move, so
    // identical key lists must leave the bar alone.
    var signature = keys
      .map(function (key) {
        return key.l + '|' + (key.h || '') + '|' + (key.d ? key.d.name || key.d.kind : '') + '|' + (key.k || '');
      })
      .join(';');
    if (signature === this.keysSignature) return;
    this.keysSignature = signature;
    this.keyboard.setBarKeys(BAR_PAGE, keys);
  };

  // The warning chip is the only thing that turns amber, and it is offered only when
  // the engine found something in finished input.
  Assist.prototype.issueKeys = function () {
    if (!this.issues.length) return [];
    return [{
      l: '\u26A0 ' + this.issues.length,
      a: 'assist',
      d: { kind: 'issues' },
      k: 'fn warn',
      g: 0.9,
      t: this.issues.length === 1 ? '1 problem' : this.issues.length + ' problems',
    }];
  };

  Assist.prototype.renderIdle = function (extra) {
    this.state = 'idle';
    this.prefix = '';
    this.matches = { names: [], details: [], total: 0, start: 0, end: 0 };
    this.setKeys(this.idleKeys(extra));
  };

  // Completion applies here but has nothing to offer: the bar shows the default action
  // keys, the same ones the idle state uses.
  Assist.prototype.renderNoMatches = function () {
    this.renderIdle(this.issueKeys());
  };

  Assist.prototype.renderSignature = function (variant, active, extra) {
    this.state = 'signature';
    this.prefix = '';
    var html = '';
    for (var i = 0; i < variant.length; i += 1) {
      if (i > 0) html += '<span class="woxi-sig-sep">, </span>';
      html += '<span class="woxi-sig' + (i === active ? ' woxi-sig-on' : '') + '">' +
        escapeHtml(variant[i].text) + '</span>';
    }
    var number = Math.min(active + 1, variant.length);
    this.setKeys([
      { l: 'Eval', a: 'enter', k: 'ok', g: 1.1, t: 'Evaluate this entry' },
      { l: 'signature', h: html, a: 'assist', d: { kind: 'next' }, k: 'sig', g: 3, t: 'Tap to move to the next argument' },
    ].concat(extra || [], [
      {
        l: number + '/' + variant.length + ' \u25BE',
        a: 'assist',
        d: { kind: 'call' },
        k: 'fn',
        g: 0.9,
        t: 'Argument ' + number + ' of ' + variant.length + ': the call card',
      },
      { l: '\u2190', a: 'back', k: 'danger', g: 0.8, t: 'Backspace' },
    ]));
  };

  Assist.prototype.showIterator = function (slot, extra) {
    var variable = iteratorVariable(slot.text) || 'x';
    this.state = 'iterator';
    this.prefix = '';
    var keys = [{ l: 'Eval', a: 'enter', k: 'ok', g: 1.1, t: 'Evaluate this entry' }];
    for (var i = 0; i < 2; i += 1) {
      var text = '{' + variable + ', ' + (i === 0 ? '-5, 5' : '0, 2 Pi') + '}';
      keys.push({
        l: text,
        a: 'assist',
        d: { kind: 'accept', name: text },
        k: 'fn chip',
        g: 1.6,
        t: 'Iterate ' + variable + ' over ' + (i === 0 ? '-5 to 5' : '0 to 2 Pi'),
      });
    }
    this.setKeys(keys.concat(extra || [], [{ l: '\u2190', a: 'back', k: 'danger', g: 0.8, t: 'Backspace' }]));
  };

  // refresh

  Assist.prototype.refresh = function () {
    var read = this.sink.read();
    if (!read) {
      if (this.sheetOpen) this.closeSheet();
      this.renderIdle([]);
      return;
    }
    this.read = read;
    var code = read.code;
    var caret = read.caret;
    var ctx = scanContext(code, caret);
    var span = prefixSpan(code, caret);
    var head = ctx.head;
    var args = ctx.argIndex + 1;
    var variant = this.variantFor(head, args);
    var before = code.slice(0, caret);

    this.scheduleDefinitions();
    this.scheduleDiagnostics(code);
    var extra = this.issueKeys();

    // Inside a string or a comment there is nothing to complete.
    if (ctx.inString || ctx.commentDepth > 0) {
      this.renderIdle(extra);
      return;
    }
    // A value after `->` is data, not a symbol name.
    if (/->\s*$/.test(before)) {
      this.renderIdle(extra);
      return;
    }

    if (head && variant && ctx.argIndex >= variant.length) {
      this.showOptions(head, extra);
      return;
    }
    if (/^[A-Za-z$`]/.test(span.text)) {
      this.requestMatches(span.text);
      return;
    }
    if (head && variant) {
      var slot = variant[Math.min(ctx.argIndex, variant.length - 1)];
      // An empty iterator argument (`{`) is the other thing a keyboard key cannot spell
      // in one tap. Once it has content the caret is editing that argument, and a chip
      // would splice a second `{x, ...}` into it.
      var emptyIterator = slot && slot.role === 'iterator' && ctx.open && ctx.open.ch === '{' &&
        code.slice(ctx.open.open + 1, caret).trim() === '';
      if (emptyIterator) {
        this.showIterator(slot, extra);
        return;
      }
      this.renderSignature(variant, Math.min(ctx.argIndex, variant.length - 1), extra);
      return;
    }
    this.renderIdle(extra);
  };

  // prototypes

  Assist.prototype.ensurePrototypes = function () {
    var self = this;
    if (this.learnedAsked || !this.query) return;
    this.learnedAsked = true;
    var examples = (this.sink.templates ? this.sink.templates() : []).map(function (template) {
      return template.insert;
    });
    if (!examples.length) return;
    this.query('prototypes_request', { examples: examples }).then(function (reply) {
      if (reply && reply.status === 'ok' && reply.content && reply.content.heads) {
        self.learned = reply.content.heads;
      }
    }, function () {
      self.learnedAsked = false;
    });
  };

  Assist.prototype.variantsOf = function (head) {
    if (!head) return null;
    var variants = PROTOTYPES[head]
      ? (typeof PROTOTYPES[head] === 'string' ? [PROTOTYPES[head]] : PROTOTYPES[head]).map(curatedVariant)
      : [];
    var learned = this.learned[head] || [];
    for (var i = 0; i < learned.length; i += 1) {
      var slots = (learned[i].slots || []).map(function (slot) {
        return {
          text: slot.name,
          role: slot.role,
          examples: (slot.examples || []).slice(),
        };
      });
      if (!slots.length) continue;
      var match = null;
      for (var j = 0; j < variants.length; j += 1) {
        if (variants[j].length !== slots.length) continue;
        var same = true;
        for (var k = 0; k < slots.length; k += 1) {
          if (variants[j][k].role !== slots[k].role) { same = false; break; }
        }
        if (same) { match = variants[j]; break; }
      }
      if (match) {
        // Keep the curated names, take the examples the examples actually use.
        for (var s = 0; s < slots.length; s += 1) {
          if (!slots[s].examples.length) continue;
          var merged = slots[s].examples.concat(match[s].examples.filter(function (example) {
            return slots[s].examples.indexOf(example) < 0;
          }));
          match[s].examples = merged.slice(0, 4);
        }
      } else if (variants.length < 3) {
        variants.push(slots);
      }
    }
    return variants.length ? variants : null;
  };

  Assist.prototype.variantFor = function (head, args) {
    var variants = this.variantsOf(head);
    if (!variants) return null;
    var chosen = this.variantChoice[head];
    if (chosen !== undefined && variants[chosen]) return variants[chosen];
    // The variant whose slots the call has reached: the largest one that still fits,
    // else the smallest. Extra arguments are options, so they do not pick a variant.
    var best = null;
    var smallest = null;
    for (var i = 0; i < variants.length; i += 1) {
      var size = variants[i].length;
      if (size <= args && (!best || size > best.length)) best = variants[i];
      if (!smallest || size < smallest.length) smallest = variants[i];
    }
    return best || smallest;
  };

  // suggestions

  Assist.prototype.requestMatches = function (prefix) {
    var self = this;
    // Set here, not in `fetchMatches`: a cached answer is still an answer for this prefix.
    this.prefix = prefix;
    var limit = this.sheetOpen ? SHEET_LIMIT : MATCH_LIMIT;
    var key = prefix + '@' + limit;
    var cached = this.cache[key];
    if (cached) {
      if (!cached.names.length) {
        this.renderNoMatches();
        return;
      }
      this.matches = cached;
      this.state = 'candidates';
      if (this.sheetOpen) this.renderSheet();
      this.setKeys(this.chipKeys(cached.names, cached.details, cached.total));
      return;
    }
    if (this.timer) global.clearTimeout(this.timer);
    // The reply must describe the text the prefix came from. A caret drag moves the
    // caret while the request waits out the debounce, so the caret is captured here
    // rather than read again when the request finally goes out.
    var read = this.read || {};
    var code = read.code || '';
    var caret = read.caret || 0;
    this.timer = global.setTimeout(function () {
      self.timer = null;
      self.fetchMatches(prefix, limit, code, caret);
    }, DEBOUNCE_MS);
  };

  Assist.prototype.fetchMatches = function (prefix, limit, code, caret) {
    var self = this;
    if (!this.query) return;
    var seq = ++this.seq;
    this.prefix = prefix;
    this.query('complete_request', { code: code, cursor_pos: caret, limit: limit })
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
            status: (extra[i] && extra[i].status) || 'unknown',
            category: (extra[i] && extra[i].category) || '',
            doc: (extra[i] && extra[i].doc) || '',
            type: (types[i] && types[i].type) || 'function',
            arity: (extra[i] && extra[i].arity) || null,
          });
        }
        self.details = details;
        self.rankParameters(names, details, prefix);
        var result = {
          names: names,
          details: details,
          total: typeof meta.total === 'number' ? meta.total : names.length,
          start: content.cursor_start || 0,
          end: content.cursor_end || 0,
        };
        self.cache[prefix + '@' + limit] = result;
        if (!result.names.length) {
          self.renderNoMatches();
          return;
        }
        self.matches = result;
        self.state = 'candidates';
        if (self.sheetOpen) self.renderSheet();
        self.setKeys(self.chipKeys(result.names, result.details, result.total));
      });
  };

  // Parameters of the definition the caret is in are the names an expert types most
  // often inside a body, so they lead the list - even when the engine does not know
  // them, since `x` is not a builtin.
  Assist.prototype.rankParameters = function (names, details, prefix) {
    var params = this.activeParameters();
    if (!params.length) return;
    var wanted = (prefix || '').toLowerCase();
    for (var i = params.length - 1; i >= 0; i -= 1) {
      var name = params[i];
      if (wanted && name.toLowerCase().indexOf(wanted) !== 0) continue;
      var at = names.indexOf(name);
      var detail = at >= 0 ? details[at] : { description: '', status: 'implemented', category: '', doc: '' };
      if (at >= 0) {
        names.splice(at, 1);
        details.splice(at, 1);
      }
      detail.description = 'parameter of this definition';
      detail.status = 'implemented';
      names.unshift(name);
      details.unshift(detail);
    }
  };

  Assist.prototype.activeParameters = function () {
    var read = this.read;
    if (!read || !this.definitions.length) return [];
    var entry = this.sink.entryId ? this.sink.entryId() : 0;
    for (var i = 0; i < this.definitions.length; i += 1) {
      var definition = this.definitions[i];
      if (definition.entry !== entry) continue;
      if (read.caret >= definition.start && read.caret <= definition.end) {
        return definition.params || [];
      }
    }
    return [];
  };

  Assist.prototype.chipKeys = function (names, details, total) {
    var keys = [{ l: 'Eval', a: 'enter', k: 'ok', g: 1.1, t: 'Evaluate this entry' }];
    for (var i = 0; i < names.length && i < MAX_CHIPS; i += 1) {
      var detail = details[i] || {};
      var dimmed = detail.status === 'not_implemented' || detail.status === 'not_planned';
      keys.push({
        l: names[i],
        a: 'assist',
        d: { kind: 'accept', name: names[i], type: detail.type, arity: detail.arity },
        k: dimmed ? 'fn chip dim' : 'fn chip',
        g: 1.25,
        t: (detail.description || names[i]) + (dimmed ? ' (' + STATUS_LABEL[detail.status] + ')' : ''),
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
    return keys.concat(this.issueKeys(), [
      { l: '\u2190', a: 'back', k: 'danger', g: 0.8, t: 'Backspace' },
    ]);
  };

  // The symbol the caret is on or right after, which is what go to definition acts on.
  Assist.prototype.symbolAtCaret = function () {
    var read = this.sink.read();
    if (!read) return '';
    var code = read.code;
    var start = prefixSpan(code, read.caret).start;
    var end = read.caret;
    while (end < code.length && /[A-Za-z0-9$`]/.test(code.charAt(end))) end += 1;
    var name = code.slice(start, end);
    return /^[A-Za-z$`][A-Za-z0-9$`]*$/.test(name) ? name : '';
  };

  // Whether a session symbol is a function definition rather than a variable: those wrap
  // like builtins do, a plain variable is a value.
  Assist.prototype.isDefinedFunction = function (name) {
    for (var i = 0; i < this.definitions.length; i += 1) {
      var definition = this.definitions[i];
      if (definition.name === name && definition.kind === 'function') return true;
    }
    return false;
  };

  // Whether `text` is a plain symbol name, the only thing that can become a call. A
  // literal (an iterator chip such as `{x, -5, 5}`) is inserted as it is.
  function isIdentifier(text) {
    return /^[A-Za-z$`][A-Za-z0-9$`]*$/.test(text || '');
  }

  // Short press on a function button: the call with an empty argument list and the caret
  // inside (`Integrate[]`, caret between the brackets). Accepting a chip replaces the
  // name being typed, and the selection when there is one. A pad key only replaces the
  // selection. A name that stands for a value (`Pi`, a session variable, `$Name`)
  // arrives as just itself.
  Assist.prototype.apply = function (name, type) {
    var read = this.sink.read();
    if (!read) return;
    var code = read.code;
    var selected = read.selStart !== undefined && read.selEnd !== undefined &&
      read.selStart !== read.selEnd;
    var start = prefixSpan(code, read.caret).start;
    var end = selected ? read.selEnd : read.caret;
    var info = this.infoOf(name);
    if (type === undefined) type = info ? info.type : undefined;
    if (type === 'variable' && this.isDefinedFunction(name)) type = 'function';
    var call = isIdentifier(name) && isCallName(name, type);
    var insert = call ? name + '[]' : name;
    this.sink.replace(start, end, insert, insert.length - (call ? 1 : 0));
    if (this.sheetOpen) this.closeSheet();
  };

  // What the current match list knows about a name (`function`/`variable`, arity), or
  // null when it is not in the list (a pad key, an example, the sheet).
  Assist.prototype.infoOf = function (name) {
    var names = this.matches && this.matches.names ? this.matches.names : [];
    var at = names.indexOf(name);
    if (at < 0 || !this.details[at]) return null;
    return this.details[at];
  };

  // Long press on a function button: the call with every slot spelled out
  // (`Plot[f, {x, -5, 5}]`). A selection is the first argument and overrides the
  // analysed target. Otherwise the operand that starts at the caret is. With neither,
  // the placeholders stay and the first one is selected, so typing replaces it.
  //
  // A function that takes no arguments cannot wrap anything: the hold falls back to the
  // tap (the call itself). Options: `chip` also replaces the partial name before the
  // caret. `arity` is what the match list knows. `wrap: false` inserts the placeholders
  // only (the sheet's insert skeleton button).
  Assist.prototype.applySkeleton = function (head, options) {
    options = options || {};
    var chip = options.chip === true;
    var arity = options.arity;
    var wrap = options.wrap !== false;
    var read = this.sink.read();
    if (!read) return false;
    // Only a function can be wrapped: a constant, a literal chip or a session variable
    // keeps its tap meaning. A user-defined function wraps like a builtin.
    if (!isIdentifier(head) || !isCallName(head)) return false;
    var info = this.infoOf(head);
    var type = options.type !== undefined ? options.type : (info ? info.type : undefined);
    if (type === 'variable' && !this.isDefinedFunction(head)) return false;
    if (arity === undefined && info) arity = info.arity;
    if (arity && arity[1] === 0) {
      this.apply(head, 'function');
      return true;
    }
    var code = read.code;
    var selected = read.selStart !== undefined && read.selEnd !== undefined &&
      read.selStart !== read.selEnd;
    // A chip always replaces the partial name before the caret, with or without a
    // selection. A pad key leaves the typed text alone.
    var prefix = prefixSpan(code, read.caret);
    var from = chip ? prefix.start : read.caret;
    var to = read.caret;
    var inner = null;
    if (wrap && selected) {
      if (!chip) from = read.selStart;
      to = read.selEnd;
      inner = code.slice(read.selStart, read.selEnd);
    } else if (wrap) {
      var operand = operandAt(code, read.caret);
      if (operand) {
        to = operand.end;
        inner = code.slice(operand.start, operand.end);
      }
    }
    var skeleton = this.skeletonFor(head, inner);
    if (!skeleton) {
      // No slots are known for this head: the call alone still wraps what it was given.
      if (inner === null) return false;
      skeleton = { text: head + '[' + inner + ']', select: null };
    }
    this.sink.replace(from, to, skeleton.text, skeleton.text.length);
    if (skeleton.select) {
      this.sink.select(from + skeleton.select[0], from + skeleton.select[1]);
    }
    return true;
  };

  // Long press on a suggestion chip: the skeleton, with the partial name replaced.
  Assist.prototype.wrap = function (name, arity, type) {
    return this.applySkeleton(name, { chip: true, arity: arity, type: type });
  };

  // The skeleton of a call: every non-option slot spelled out. Iterator slots get the
  // concrete range the gallery uses, which is the part nobody wants to type. `inner`
  // (a selection or the operand at the caret) becomes the first slot, and the call is
  // left without a selection because nothing is missing any more.
  Assist.prototype.skeletonFor = function (head, inner) {
    var variant = this.variantFor(head, 1);
    if (!variant) return null;
    var slots = [];
    var i;
    for (i = 0; i < variant.length; i += 1) {
      var slot = variant[i];
      if (slot.role === 'option' || slot.role === 'options') continue;
      slots.push(slot);
    }
    if (!slots.length) return null;
    var filled = inner !== null && inner !== undefined;
    var parts = [];
    var offset = head.length + 1;
    var select = null;
    for (i = 0; i < slots.length; i += 1) {
      slot = slots[i];
      var text;
      if (i === 0 && filled) text = inner;
      else if (slot.role === 'iterator' && slot.examples.length) text = slot.examples[0];
      else text = slot.text;
      if (i > 0) offset += 2;
      if (i === 0 && !filled) select = [offset, offset + text.length];
      parts.push(text);
      offset += text.length;
    }
    return { text: head + '[' + parts.join(', ') + ']', select: select };
  };

  Assist.prototype.nextSlot = function () {
    var read = this.sink.read();
    if (!read) return;
    var ctx = scanContext(read.code, read.caret);
    if (!ctx.open) return;
    var at = nextSlotCaret(read.code, read.caret);
    if (at !== null) {
      this.sink.setCaret(at);
      return;
    }
    // The call is not closed yet and there is no comma ahead: start the next argument
    // with one, which is the edit the user would have made by hand.
    var before = read.code.slice(0, read.caret);
    var argument = read.code.slice(argumentStart(read.code, read.caret), read.caret);
    if (argument.trim() !== '' && /[^,\s]$/.test(before)) {
      this.sink.replace(read.caret, read.caret, ', ', 2);
    }
  };

  // Options already written in the call, so the chips do not offer them twice.
  Assist.prototype.optionsInCall = function (code, ctx) {
    var used = {};
    if (!ctx.call) return used;
    var end = code.length;
    for (var i = ctx.call.open; i < code.length; i += 1) {
      if (code.charAt(i) === ']' && scanContext(code, i).stack.length === 1) { end = i; break; }
    }
    var text = code.slice(ctx.call.open, end);
    var pattern = /([A-Za-z][A-Za-z0-9$]*)\s*->/g;
    var match;
    while ((match = pattern.exec(text))) used[match[1]] = true;
    return used;
  };

  // options

  Assist.prototype.showOptions = function (head, extra) {
    var self = this;
    var cached = this.options[head];
    if (cached) {
      this.renderOptions(head, cached, extra);
      return;
    }
    if (!this.query) return;
    var seq = ++this.seq;
    this.query('inspect_request', { code: head + '[', cursor_pos: head.length })
      .then(function (reply) {
        if (seq !== self.seq || !reply || reply.status !== 'ok') return;
        var meta = (reply.content && reply.content.metadata) || {};
        var info = meta._woxi || {};
        var options = [];
        var defaults = info.optionDefaults || [];
        for (var i = 0; i < defaults.length; i += 1) {
          options.push({ name: defaults[i][0], value: defaults[i][1] });
        }
        if (!options.length) {
          var names = info.options || [];
          for (var n = 0; n < names.length; n += 1) options.push({ name: names[n], value: '' });
        }
        self.rememberOptions(head, options);
        var read = self.sink.read();
        if (!read) return;
        var ctx = scanContext(read.code, read.caret);
        if (ctx.head === head) self.renderOptions(head, options, self.issueKeys());
      });
  };

  Assist.prototype.rememberOptions = function (head, options) {
    this.options[head] = options;
    this.optionOrder.push(head);
    if (this.optionOrder.length > OPTION_CACHE_MAX) {
      var dropped = this.optionOrder.shift();
      delete this.options[dropped];
    }
  };

  Assist.prototype.renderOptions = function (head, options, extra) {
    var read = this.sink.read();
    if (!read) return;
    var span = prefixSpan(read.code, read.caret);
    var used = this.optionsInCall(read.code, scanContext(read.code, read.caret));
    var shown = [];
    for (var i = 0; i < options.length; i += 1) {
      if (used[options[i].name]) continue;
      if (span.text && options[i].name.toLowerCase().indexOf(span.text.toLowerCase()) !== 0) continue;
      shown.push(options[i]);
      if (shown.length === MAX_CHIPS) break;
    }
    if (!shown.length && !span.text) {
      this.renderIdle(extra);
      return;
    }
    this.state = 'options';
    this.prefix = '';
    var keys = [{ l: 'Eval', a: 'enter', k: 'ok', g: 1.1, t: 'Evaluate this entry' }];
    for (var k = 0; k < shown.length; k += 1) {
      keys.push({
        l: shown[k].name,
        a: 'assist',
        d: { kind: 'option', name: shown[k].name },
        k: 'fn chip',
        g: 1.25,
        t: shown[k].name + (shown[k].value ? ' \u2192 ' + shown[k].value : '') + ' (of ' + head + ')',
      });
    }
    keys.push({
      l: '\u2304',
      a: 'assist',
      d: { kind: 'more' },
      k: 'fn',
      g: 0.8,
      t: 'Options of ' + head,
    });
    this.setKeys(keys.concat(extra || [], [{ l: '\u2190', a: 'back', k: 'danger', g: 0.8, t: 'Backspace' }]));
  };

  // diagnostics

  Assist.prototype.scheduleDiagnostics = function (code) {
    var self = this;
    if (!this.query) return;
    if (code === this.issuesText && this.issuesText !== '') return;
    if (this.diagnosticsTimer) global.clearTimeout(this.diagnosticsTimer);
    if (!code.trim()) {
      this.setIssues('', []);
      return;
    }
    this.diagnosticsTimer = global.setTimeout(function () {
      self.diagnosticsTimer = null;
      var read = self.sink.read();
      if (!read || read.code !== code) return;
      self.query('diagnostics_request', { code: code }).then(function (reply) {
        if (!reply || reply.status !== 'ok' || !reply.content) return;
        var content = reply.content;
        // Unfinished input has no diagnostics: the engine says so explicitly.
        if (content.status === 'incomplete') return;
        self.setIssues(code, content.items || []);
      });
    }, DIAGNOSTICS_MS);
  };

  Assist.prototype.setIssues = function (text, items) {
    var changed = this.issues.length !== items.length;
    var before = this.issuesText;
    this.issuesText = text;
    this.issues = items;
    if (!changed && before === text) return;
    this.keysSignature = ''; // force a repaint, the warning chip is part of the bar
    this.refreshBar();
    if (this.sheetOpen && this.sheetTab === 'issues') this.renderSheet();
  };

  // Repaint only the bar, without re-running the (debounced) analysis.
  Assist.prototype.refreshBar = function () {
    var read = this.sink.read();
    if (!read) return;
    var ctx = scanContext(read.code, read.caret);
    var variant = this.variantFor(ctx.head, ctx.argIndex + 1);
    var extra = this.issueKeys();
    if (ctx.head && variant) {
      this.renderSignature(variant, Math.min(ctx.argIndex, variant.length - 1), extra);
    } else if (this.state === 'candidates') {
      this.setKeys(this.chipKeys(this.matches.names, this.matches.details, this.matches.total));
    } else {
      this.renderIdle(extra);
    }
  };

  // definitions

  Assist.prototype.scheduleDefinitions = function () {
    var self = this;
    if (!this.query || !this.sink.codes) return;
    var codes = this.sink.codes();
    var joined = codes.join('\u0000');
    if (joined === this.definitionsAsked) return;
    if (this.definitionsTimer) global.clearTimeout(this.definitionsTimer);
    this.definitionsTimer = global.setTimeout(function () {
      self.definitionsTimer = null;
      self.definitionsAsked = joined;
      self.query('definitions_request', { codes: codes }).then(function (reply) {
        if (!reply || reply.status !== 'ok' || !reply.content) return;
        var entries = reply.content.entries || [];
        var flat = [];
        for (var index = 0; index < entries.length; index += 1) {
          for (var d = 0; d < entries[index].length; d += 1) {
            var definition = entries[index][d];
            flat.push({
              entry: index,
              name: definition.name,
              params: definition.params || [],
              start: definition.start,
              end: definition.end,
              kind: definition.kind,
            });
          }
        }
        self.definitions = flat;
        // The candidates were ranked before the definitions arrived. Rank them again
        // now, so a parameter of the definition leads the list as soon as it is known.
        if (self.state === 'candidates' && self.matches.names.length) {
          var read = self.sink.read();
          if (read) {
            self.rankParameters(self.matches.names, self.matches.details, prefixSpan(read.code, read.caret).text);
            self.setKeys(self.chipKeys(self.matches.names, self.matches.details, self.matches.total));
            if (self.sheetOpen) self.renderSheet();
          }
        }
      });
    }, DEFINITIONS_MS);
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
      '<button type="button" class="woxi-assist-tab" data-tab="matches" tabindex="-1">Matches</button>' +
      '<button type="button" class="woxi-assist-tab" data-tab="examples" tabindex="-1">Examples</button>' +
      '<button type="button" class="woxi-assist-tab" data-tab="call" tabindex="-1">Call</button>' +
      '<button type="button" class="woxi-assist-tab" data-tab="about" tabindex="-1">About</button>' +
      '<button type="button" class="woxi-assist-tab" data-tab="issues" tabindex="-1">Issues</button>' +
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
      var target = event.target;
      if (!target || !target.closest) return;
      var row = target.closest('[data-assist-insert],[data-assist-template],[data-assist-option],' +
        '[data-assist-example],[data-assist-skeleton],[data-assist-variant],[data-assist-fix],[data-assist-goto]');
      if (!row) return;
      if (row.hasAttribute('data-assist-template')) {
        self.sink.evaluate(row.getAttribute('data-assist-template'));
        self.closeSheet();
      } else if (row.hasAttribute('data-assist-option')) {
        var option = row.getAttribute('data-assist-option');
        var read = self.sink.read();
        if (read) self.sink.replace(read.caret, read.caret, option + ' -> ', option.length + 4);
        self.closeSheet();
      } else if (row.hasAttribute('data-assist-example')) {
        self.applyExample(row.getAttribute('data-assist-example'));
      } else if (row.hasAttribute('data-assist-skeleton')) {
        self.applySkeleton(row.getAttribute('data-assist-skeleton'), { wrap: false });
        self.closeSheet();
      } else if (row.hasAttribute('data-assist-variant')) {
        var parts = row.getAttribute('data-assist-variant').split(':');
        self.variantChoice[parts[0]] = Number(parts[1]);
        self.refresh();
        self.renderSheet();
      } else if (row.hasAttribute('data-assist-goto')) {
        if (self.sink.gotoDefinition) self.sink.gotoDefinition(row.getAttribute('data-assist-goto'));
        self.closeSheet();
      } else if (row.hasAttribute('data-assist-fix')) {
        // The payload is JSON in one attribute: the insert text can contain anything.
        var fix = null;
        try {
          fix = JSON.parse(row.getAttribute('data-assist-fix'));
        } catch (err) {
          fix = null;
        }
        if (fix) self.sink.replace(Number(fix.start), Number(fix.end), fix.insert, fix.insert.length);
        self.closeSheet();
      } else {
        self.apply(row.getAttribute('data-assist-insert'));
      }
    });
  };

  // Replaces the argument the caret is in with an example value.
  Assist.prototype.applyExample = function (example) {
    var read = this.sink.read();
    if (!read) return;
    var start = argumentStart(read.code, read.caret);
    var end = argumentEnd(read.code, read.caret);
    var head = start;
    while (head > 0 && read.code.charAt(head - 1) !== ',' && read.code.charAt(head - 1) !== '[') head -= 1;
    var prefixSpace = '';
    if (read.code.charAt(start) === ' ') {
      start += 1;
    } else if (head > 0 && read.code.charAt(head - 1) === ',') {
      prefixSpace = ' ';
    }
    var text = prefixSpace + example;
    this.sink.replace(start, end, text, text.length);
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
  };

  Assist.prototype.closeSheet = function () {
    this.sheetOpen = false;
    this.about = null;
    if (this.dom) this.dom.classList.add('woxi-hidden');
  };

  Assist.prototype.renderSheet = function () {
    if (!this.dom || !this.sheetOpen) return;
    var body = this.dom.querySelector('#woxi-assist-body');
    var tabs = this.dom.querySelectorAll('.woxi-assist-tab');
    var self = this;
    for (var i = 0; i < tabs.length; i += 1) {
      var tab = tabs[i];
      var name = tab.getAttribute('data-tab');
      tab.classList.toggle('woxi-on', name === this.sheetTab);
      if (name === 'issues') {
        tab.textContent = this.issues.length ? 'Issues (' + this.issues.length + ')' : 'Issues';
      }
    }
    var rows;
    if (this.sheetTab === 'examples') rows = this.exampleRows();
    else if (this.sheetTab === 'about') rows = this.aboutRows();
    else if (this.sheetTab === 'call') rows = this.callRows();
    else if (this.sheetTab === 'issues') rows = this.issueRows();
    else rows = this.matchRows();
    body.innerHTML = rows.length ? rows.join('') : '<div class="woxi-assist-empty">' +
      escapeHtml(this.emptyHint()) + '</div>';
    void self;
  };

  Assist.prototype.emptyHint = function () {
    if (this.sheetTab === 'about') return 'Put the caret on a name to see what it is.';
    if (this.sheetTab === 'examples') return 'No examples here.';
    if (this.sheetTab === 'call') return 'Put the caret in a call to see its arguments.';
    if (this.sheetTab === 'issues') return this.read && this.read.code.trim() ? 'No problems found.' : 'Nothing to check yet.';
    if (this.prefix) return 'No match for "' + this.prefix + '".';
    if (this.catalog && this.catalog.total) {
      return this.catalog.total + ' symbols from Woxi ' + this.catalog.version + ' \u2014 type a name.';
    }
    return 'Type a name to see matches.';
  };

  function statusBadge(status, category) {
    var label = STATUS_LABEL[status] || '';
    var parts = [];
    if (label) parts.push(label);
    if (category) parts.push(category);
    return parts.length ? '<span class="woxi-assist-meta">' + escapeHtml(parts.join(' \u00b7 ')) + '</span>' : '';
  }

  Assist.prototype.matchRows = function () {
    var names = this.matches.names || [];
    var details = this.matches.details || [];
    var rows = [];
    for (var i = 0; i < names.length; i += 1) {
      var detail = details[i] || {};
      rows.push(
        '<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-insert="' +
        escapeHtml(names[i]) + '">' +
        '<span class="woxi-assist-name">' + escapeHtml(names[i]) + '</span>' +
        '<span class="woxi-assist-desc">' + escapeHtml(detail.description || '') + '</span>' +
        statusBadge(detail.status, detail.category) +
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

  // The call being edited: the variant in use, one row per slot with its shape and the
  // example values the gallery actually uses, the head's options, and the skeleton.
  Assist.prototype.callRows = function () {
    var read = this.sink.read();
    if (!read) return [];
    var ctx = scanContext(read.code, read.caret);
    var head = ctx.head;
    if (!head) return [];
    var variants = this.variantsOf(head);
    if (!variants) return [];
    var active = this.variantFor(head, ctx.argIndex + 1);
    var activeIndex = variants.indexOf(active);
    var used = this.optionsInCall(read.code, ctx);
    var rows = ['<div class="woxi-assist-about">'];
    rows.push('<div class="woxi-assist-about-name">' + escapeHtml(head) + ' \u2014 ' +
      Math.min(ctx.argIndex + 1, active.length) + ' of ' + active.length +
      (ctx.argIndex + 1 > active.length ? ' (options)' : '') + '</div>');
    for (var i = 0; i < active.length; i += 1) {
      var slot = active[i];
      rows.push(
        '<div class="woxi-assist-slot' + (i === ctx.argIndex ? ' woxi-assist-slot-on' : '') + '">' +
        '<span class="woxi-assist-slot-name">' + escapeHtml(slot.text) + '</span>' +
        '<span class="woxi-assist-slot-role">' + escapeHtml(roleLabel(slot.role)) + '</span>' +
        '</div>'
      );
      var examples = (slot.examples || []).slice(0, 3);
      if (examples.length) {
        rows.push('<div class="woxi-assist-examples">');
        for (var e = 0; e < examples.length; e += 1) {
          rows.push('<button type="button" class="woxi-assist-chip" tabindex="-1" data-assist-example="' +
            escapeHtml(examples[e]) + '">' + escapeHtml(examples[e]) + '</button>');
        }
        rows.push('</div>');
      }
    }
    rows.push('<div class="woxi-assist-actions">');
    rows.push('<button type="button" class="woxi-assist-action" tabindex="-1" data-assist-skeleton="' +
      escapeHtml(head) + '">insert skeleton</button>');
    rows.push('</div>');
    if (variants.length > 1) {
      rows.push('<div class="woxi-assist-about-line">Other forms:</div>');
      for (var v = 0; v < variants.length; v += 1) {
        if (v === activeIndex) continue;
        var text = variants[v].map(function (part) { return part.text; }).join(', ');
        rows.push('<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-variant="' +
          escapeHtml(head) + ':' + v + '">' +
          '<span class="woxi-assist-name">' + escapeHtml(head) + '[' + escapeHtml(text) + ']</span>' +
          '</button>');
      }
    }
    var options = this.options[head];
    if (options && options.length) {
      rows.push('<div class="woxi-assist-about-line">Options (' + options.length + '):</div>');
      for (var o = 0; o < options.length && o < 40; o += 1) {
        var set = used[options[o].name] ? ' \u2713' : '';
        rows.push('<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-option="' +
          escapeHtml(options[o].name) + '">' +
          '<span class="woxi-assist-name">' + escapeHtml(options[o].name) + escapeHtml(set) + '</span>' +
          '<span class="woxi-assist-desc">' + escapeHtml(options[o].value || '') + '</span>' +
          '</button>');
      }
    }
    rows.push('</div>');
    return rows;
  };

  Assist.prototype.issueRows = function () {
    var rows = [];
    for (var i = 0; i < this.issues.length; i += 1) {
      var issue = this.issues[i];
      var message = issue.message;
      if (issue.code === 'syntax') {
        // The grammar's own wording names parser rules. Say what a reader can act on.
        message = 'Syntax error here';
      }
      var fix = '';
      if (issue.fix) {
        fix = '<button type="button" class="woxi-assist-chip" tabindex="-1" data-assist-fix="' +
          escapeHtml(JSON.stringify(issue.fix)) + '">' +
          escapeHtml(issue.fix.label) + '</button>';
      }
      rows.push(
        '<div class="woxi-assist-issue woxi-assist-issue-' + escapeHtml(issue.severity) + '">' +
        '<span class="woxi-assist-issue-dot"></span>' +
        '<span class="woxi-assist-desc">' + escapeHtml(message) + '</span>' +
        fix +
        '</div>'
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
      var defined = self.definitions.find(function (definition) { return definition.name === name; });
      if (!reply || reply.status !== 'ok' || !reply.content || !reply.content.found) {
        var rows = ['<div class="woxi-assist-about">'];
        rows.push('<div class="woxi-assist-about-name">' + escapeHtml(name) + '</div>');
        if (defined) {
          rows.push('<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-goto="' +
            escapeHtml(name) + '"><span class="woxi-assist-name">defined in entry ' + (defined.entry + 1) +
            '</span><span class="woxi-assist-desc">go to definition</span></button>');
          if (defined.params && defined.params.length) {
            rows.push('<div class="woxi-assist-about-line">parameters: ' +
              escapeHtml(defined.params.join(', ')) + '</div>');
          }
        } else {
          rows.push('<div class="woxi-assist-about-line">Nothing known about this name yet.</div>');
        }
        rows.push('</div>');
        self.about = { name: name, rows: rows };
      } else {
        var meta = (reply.content.metadata && reply.content.metadata._woxi) || {};
        var lines = ['<div class="woxi-assist-about">'];
        lines.push('<div class="woxi-assist-about-name">' + escapeHtml(meta.name || name) + '</div>');
        lines.push('<div class="woxi-assist-about-line">' + statusBadge(meta.status, meta.category) + '</div>');
        if (meta.description) {
          lines.push('<div class="woxi-assist-about-line">' + escapeHtml(meta.description) + '</div>');
        }
        if (meta.attributes && meta.attributes.length) {
          lines.push('<div class="woxi-assist-about-line">' +
            escapeHtml(attributeText(meta.attributes)) + '</div>');
        }
        if (meta.arity) {
          var arity = meta.arity[1] === null ? meta.arity[0] + ' or more arguments'
            : meta.arity[0] === meta.arity[1] ? meta.arity[0] + ' argument(s)'
              : meta.arity[0] + ' to ' + meta.arity[1] + ' arguments';
          lines.push('<div class="woxi-assist-about-line">' + escapeHtml(arity) + '</div>');
        }
        if (meta.status === 'not_planned') {
          lines.push('<div class="woxi-assist-about-line woxi-assist-warn">Woxi does not plan to support this.</div>');
        } else if (meta.status === 'not_implemented') {
          lines.push('<div class="woxi-assist-about-line woxi-assist-warn">Not implemented in Woxi yet.</div>');
        }
        lines.push('<div class="woxi-assist-actions">' +
          '<button type="button" class="woxi-assist-action" tabindex="-1" data-assist-skeleton="' +
          escapeHtml(meta.name || name) + '">insert skeleton</button></div>');
        var defaults = meta.optionDefaults || [];
        if (defaults.length) {
          lines.push('<div class="woxi-assist-about-line">Options (' + defaults.length + '), tap to insert:</div>');
          for (var i = 0; i < defaults.length && i < 40; i += 1) {
            lines.push('<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-option="' +
              escapeHtml(defaults[i][0]) + '">' +
              '<span class="woxi-assist-name">' + escapeHtml(defaults[i][0]) + '</span>' +
              '<span class="woxi-assist-desc">' + escapeHtml(defaults[i][1]) + '</span>' +
              '</button>');
          }
        }
        if (meta.doc) {
          lines.push('<div class="woxi-assist-about-line woxi-assist-doc">' + escapeHtml(meta.doc) + '</div>');
        }
        var definedHere = self.definitions.find(function (definition) { return definition.name === name; });
        if (definedHere) {
          lines.push('<div class="woxi-assist-about-line">defined in entry ' + (definedHere.entry + 1) + '</div>');
          if (definedHere.params && definedHere.params.length) {
            lines.push('<div class="woxi-assist-about-line">parameters: ' +
              escapeHtml(definedHere.params.join(', ')) + '</div>');
          }
        }
        lines.push('</div>');
        self.about = { name: name, rows: lines };
      }
      if (self.sheetOpen && self.sheetTab === 'about') self.renderSheet();
    });
    return ['<div class="woxi-assist-empty">Loading\u2026</div>'];
  };

  // Attributes are the one part of a symbol's behaviour an expert reasons about, so
  // spell out what they change instead of listing the names.
  function attributeText(attributes) {
    var notes = [];
    var rest = [];
    for (var i = 0; i < attributes.length; i += 1) {
      var name = attributes[i];
      if (name === 'HoldAll') notes.push('HoldAll: arguments are not evaluated');
      else if (name === 'HoldFirst') notes.push('HoldFirst: first argument is not evaluated');
      else if (name === 'HoldRest') notes.push('HoldRest: arguments after the first are not evaluated');
      else if (name === 'Listable') notes.push('Listable: applies to each element');
      else if (name === 'NumericFunction') notes.push('NumericFunction');
      else if (name === 'Protected' || name === 'ReadProtected') continue;
      else rest.push(name);
    }
    if (rest.length) notes.push(rest.join(', '));
    return notes.join(' \u00b7 ');
  }

  // keyboard actions

  Assist.prototype.action = function (data) {
    if (!data) return;
    if (data.kind === 'accept') this.apply(data.name, data.type);
    else if (data.kind === 'option') {
      var read = this.sink.read();
      if (read) this.sink.replace(read.caret, read.caret, data.name + ' -> ', data.name.length + 4);
    } else if (data.kind === 'next') this.nextSlot();
    else if (data.kind === 'call') this.openSheet('call');
    else if (data.kind === 'issues') this.openSheet('issues');
    else if (data.kind === 'more') this.openSheet('matches');
  };

  // Session symbols change when an entry runs, so the ranked answers are stale.
  Assist.prototype.invalidate = function () {
    this.cache = {};
    this.about = null;
    this.definitionsAsked = '';
  };

  global.WoxiAssist = {
    Assist: Assist,
    PROTOTYPES: PROTOTYPES,
    scanContext: scanContext,
    closersFor: closersFor,
    slotsOf: slotsOf,
    prefixSpan: prefixSpan,
    argumentStart: argumentStart,
    argumentEnd: argumentEnd,
  };
})(window);
