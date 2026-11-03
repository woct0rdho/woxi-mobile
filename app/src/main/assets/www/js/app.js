// Woxi Mobile notebook UI.
// Responsibilities: entries (input + rendered output), in-app keyboard wiring,
// document persistence (JSON via the Storage Access Framework), menu/options.

(function (global) {
  'use strict';

  var STORAGE_KEY = 'woxi.notebook.v1';

  var state = {
    title: 'Untitled',
    fileName: null,
    dirty: false,
    entries: [],
    nextId: 1,
    activeId: null,
    settings: { theme: 'system' },
    evaluating: false,
  };

  var engine = null;
  var keyboard = null;
  var assist = null;
  var notebookEl = null;
  var titleEl = null;
  var overlayEl = null;
  var sheetTitleEl = null;
  var sheetBodyEl = null;
  var toastEl = null;
  var splashEl = null;
  var persistTimer = null;

  // utilities

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }


  // Calls a method on the injected Java object. The object is a proxy, so the
  // method must be invoked directly (`.apply`/`typeof` checks do not work on it)
  // and a failure inside the error path must not re-enter this function.
  function nativeCall(name) {
    var bridge = global.WoxiNative;
    if (!bridge) return undefined;
    try {
      switch (arguments.length) {
        case 1: return bridge[name]();
        case 2: return bridge[name](arguments[1]);
        case 3: return bridge[name](arguments[1], arguments[2]);
        case 4: return bridge[name](arguments[1], arguments[2], arguments[3]);
        default: return undefined;
      }
    } catch (err) {
      if (global.console) global.console.log('[woxi] native ' + name + ' failed: ' + err.message);
      return undefined;
    }
  }

  function log(message) {
    var bridge = global.WoxiNative;
    if (bridge) {
      try {
        bridge.log(String(message));
        return;
      } catch (err) {
        // fall through to the console
      }
    }
    if (global.console) global.console.log('[woxi] ' + message);
  }

  var toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.className = '';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = 'woxi-hidden'; }, 1900);
  }

  function persist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      try {
        var payload = {
          title: state.title,
          fileName: state.fileName,
          settings: state.settings,
          entries: state.entries.map(function (entry) { return { input: entry.input }; }),
        };
        var json = JSON.stringify(payload);
        global.localStorage.setItem(STORAGE_KEY, json);
      } catch (err) {
        log('persist failed: ' + err.message);
      }
    }, 250);
  }

  function restore() {
    var raw = null;
    try { raw = global.localStorage.getItem(STORAGE_KEY); } catch (err) { raw = null; }
    if (!raw) return false;
    try {
      var data = JSON.parse(raw);
      state.title = data.title || 'Untitled';
      state.fileName = data.fileName || null;
      if (data.settings && data.settings.theme) {
        state.settings.theme = data.settings.theme;
      }
      state.entries = (data.entries || []).map(function (entry) {
        return { id: state.nextId++, input: String(entry.input || ''), collapsed: false };
      });
      return state.entries.length > 0;
    } catch (err) {
      log('restore failed: ' + err.message);
      return false;
    }
  }

  // entry model

  function addEntry(input, options) {
    var entry = {
      id: state.nextId++,
      input: input || '',
      caret: null,
      collapsed: false,
      dom: null,
      output: '',
    };
    var index = options && options.index !== undefined ? options.index : state.entries.length;
    state.entries.splice(index, 0, entry);
    renderNotebook();
    return entry;
  }

  function entryById(id) {
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].id === id) return state.entries[i];
    }
    return null;
  }

  function activeEntry() {
    return entryById(state.activeId) || state.entries[state.entries.length - 1] || null;
  }

  function setActive(entry) {
    state.activeId = entry ? entry.id : null;
    refreshClasses();
    refreshAssist();
  }

  function refreshClasses() {
    for (var i = 0; i < state.entries.length; i++) {
      var entry = state.entries[i];
      if (!entry.dom) continue;
      entry.dom.root.className = entry.id === state.activeId ? 'woxi-entry woxi-active' : 'woxi-entry';
      entry.dom.num.textContent = String(i + 1);
    }
  }

  // Grows an entry's input box to fit its content.
  //
  // The box is collapsed first: `scrollHeight` is only the content height when the
  // element itself is not taller than its content, otherwise it reports the element's
  // own height and wrapped lines get clipped. The 2px covers the 1px borders, which
  // `scrollHeight` excludes but `box-sizing: border-box` counts.
  function autoGrow(textarea) {
    if (!textarea || !textarea.parentNode) return;
    var maxHeight = Math.round(global.innerHeight * 0.45);
    textarea.style.height = '0px';
    var contentHeight = textarea.scrollHeight;
    var height = Math.min(contentHeight + 2, maxHeight);
    textarea.style.height = height + 'px';
    textarea.style.overflowY = contentHeight + 2 > maxHeight ? 'auto' : 'hidden';
  }

  // rendering

  function renderNotebook() {
    // Detach the plot controllers first, but release their handles only after the
    // rebuilt plots have attached: a handle is dropped when its last controller goes
    // away, and the rebuilt markup addresses the same handle.
    var stale = global.WoxiPlot ? global.WoxiPlot.detach(notebookEl) : [];
    notebookEl.innerHTML = '';
    for (var i = 0; i < state.entries.length; i++) {
      notebookEl.appendChild(buildEntry(state.entries[i]));
    }
    refreshClasses();
    // Outputs are stored as HTML, so re-rendering the list restores them.
    // The Manipulate controls need their listeners attached again.
    wireManipulate(notebookEl);
    // Plots too: their listeners cannot live in HTML, and the elements are new.
    // Pan/zoom state is in `data-woxi-plot` and in the stored markup, so a rebuilt
    // plot comes back at the range it was left at.
    for (var p = 0; p < state.entries.length; p++) {
      var entry = state.entries[p];
      if (entry.dom) attachPlots(entry);
    }
    if (global.WoxiPlot) global.WoxiPlot.release(stale);
    // Rebuilt textareas start at one line. Grow them to fit their content again.
    autoGrowAll();
  }

  function buildEntry(entry) {
    var root = el('div', 'woxi-entry');
    var num = el('div', 'woxi-entry-num', '');
    var main = el('div', 'woxi-entry-main');
    var input = document.createElement('textarea');
    input.className = 'woxi-entry-input';
    input.value = entry.input;
    input.rows = 1;
    input.spellcheck = false;
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('inputmode', 'none');   // the app brings its own keyboard
    input.addEventListener('focus', function () {
      setActive(entry);
      nativeCall('hideKeyboard');
      autoGrow(input);
      liftEntry(entry);
      refreshAssist();
    });
    input.addEventListener('input', function () {
      entry.input = input.value;
      entry.caret = input.selectionStart;
      autoGrow(input);
      state.dirty = true;
      updateTitle();
      persist();
      refreshAssist();
    });
    // A blur fires before the tap that caused it completes, so the bar is refreshed
    // after both have run: a key press must land on the keys it was aimed at.
    input.addEventListener('blur', function () { refreshAssistLater(); });
    // The caret must survive taps on the in-app keyboard buttons (which move the
    // focus away from the textarea on some WebView versions).
    ['keyup', 'click', 'select', 'focus'].forEach(function (type) {
      input.addEventListener(type, function () {
        if (input.selectionStart !== null && input.selectionStart !== undefined) {
          entry.caret = input.selectionStart;
        }
        refreshAssist();
      });
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submitActive();
      }
    });
    var output = el('div', 'woxi-entry-output');
    output.innerHTML = entry.output || '';

    main.appendChild(input);
    main.appendChild(output);
    root.appendChild(num);
    root.appendChild(main);

    entry.dom = { root: root, num: num, input: input, output: output };
    if (entry.caret === null || entry.caret === undefined || entry.caret > input.value.length) {
      entry.caret = input.value.length;
    }
    return root;
  }

  function autoGrowAll() {
    for (var i = 0; i < state.entries.length; i++) {
      var entry = state.entries[i];
      if (entry.dom) autoGrow(entry.dom.input);
    }
  }

  function updateTitle() {
    titleEl.textContent = (state.dirty ? '\u2022 ' : '') + (state.title || 'Untitled');
  }

  function showBusy(entry, busy) {
    if (!entry.dom) return;
    var existing = entry.dom.output.querySelector('.woxi-busy-wrap');
    if (busy) {
      if (existing) return;
      var wrap = el('div', 'woxi-busy-wrap');
      wrap.appendChild(el('div', 'woxi-busy'));
      entry.dom.output.appendChild(wrap);
    } else if (existing) {
      existing.parentNode.removeChild(existing);
    }
  }

  // manipulation

  function wireManipulate(container) {
    var blocks = container.querySelectorAll('.woxi-manipulate');
    for (var i = 0; i < blocks.length; i++) {
      wireManipulateBlock(blocks[i]);
    }
  }

  function wireManipulateBlock(block) {
    var body = block.getAttribute('data-woxi-body') || '';
    var view = block.querySelector('.woxi-manipulate-view');
    var controls = block.querySelectorAll('[data-woxi-control]');
    if (!view || !controls.length) return;

    function bindings() {
      var values = {};
      for (var i = 0; i < controls.length; i++) {
        var control = controls[i];
        var name = control.getAttribute('data-woxi-control');
        var kind = control.getAttribute('data-woxi-kind') || '';
        if (control.type === 'checkbox') {
          values[name] = control.checked ? 'True' : 'False';
        } else if (control.tagName === 'SELECT') {
          values[name] = control.value;
        } else if (control.type === 'range') {
          values[name] = String(control.value);
        } else {
          values[name] = control.value;
        }
        var readout = block.querySelector('[data-woxi-value="' + name + '"]');
        if (readout && control.type === 'range') readout.textContent = control.value;
        void kind;
      }
      return values;
    }

    var timer = null;
    function update() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        var current = bindings();
        engine.manipulate(body, current).then(function (json) {
          var parsed = null;
          try { parsed = JSON.parse(json); } catch (err) { parsed = null; }
          if (!parsed) return;
          if (parsed.svg) view.innerHTML = global.WoxiRender.svgTag(parsed.svg, 'woxi-svg');
          else if (parsed.text) view.innerHTML = global.WoxiRender.escapeHtml(parsed.text);
          global.WoxiRender.fitGraphics(view);
        }, function (err) {
          toast(err.message);
        });
      }, 70);
    }

    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      if (control.tagName === 'SELECT') control.addEventListener('change', update);
      else control.addEventListener('input', update);
    }
    // Align the readouts with the values Woxi itself reported as initial state.
    for (var j = 0; j < controls.length; j++) {
      var readout = block.querySelector('[data-woxi-value="' + controls[j].getAttribute('data-woxi-control') + '"]');
      if (readout && controls[j].type === 'range') readout.textContent = controls[j].value;
    }
  }

  // evaluation

  // Eval on an unfinished call closes the brackets instead of doing nothing: the
  // engine says whether the entry is finished, and the closers become part of the
  // text, so nothing is hidden from the user.
  function closeRunningCall(entry) {
    if (!entry || !entry.dom || !engine) return Promise.resolve();
    var text = entry.dom.input.value;
    if (!text.trim() || !global.WoxiAssist) return Promise.resolve();
    return engine.query('is_complete_request', { code: text }).then(function (reply) {
      var status = reply && reply.content && reply.content.status;
      if (status !== 'incomplete' || !entry.dom) return;
      var closers = global.WoxiAssist.closersFor(text, text.length);
      if (!closers) return;
      entry.dom.input.value = text + closers;
      entry.input = entry.dom.input.value;
      autoGrow(entry.dom.input);
      state.dirty = true;
      updateTitle();
      persist();
    }, function () {
      // An engine that cannot answer still gets the text as the user typed it.
    });
  }

  function evaluateEntry(entry) {
    return closeRunningCall(entry).then(function () {
      // User symbols changed with the evaluation, so cached completion is stale.
      if (assist) assist.invalidate();
      return runEntry(entry);
    });
  }

  function runEntry(entry) {
    if (!entry || !entry.dom) return Promise.resolve();
    var input = entry.dom.input.value;
    entry.input = input;
    if (!input.trim()) {
      entry.dom.output.innerHTML = '';
      entry.output = '';
      entry.items = null;
      showBusy(entry, false);
      return Promise.resolve();
    }
    showBusy(entry, true);
    // Timing split for the diagnostics hook: how long the engine round trip takes
    // (bridge + interpreter + JSON) versus how long rendering it into the page
    // takes. Recorded per entry, reported by the `dump` hook.
    var t0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    return engine.evaluate(input).then(function (json) {
      var t1 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
      showBusy(entry, false);
      // Replacing the output drops the controllers of the previous picture, and with
      // them its handle (the new evaluation registers a fresh one).
      if (global.WoxiPlot) {
        global.WoxiPlot.release(global.WoxiPlot.detach(entry.dom.output));
      }
      var html = global.WoxiRender.renderItems(json);
      entry.dom.output.innerHTML = html;
      wireManipulate(entry.dom.output);
      // Trim the empty margins Woxi's plot layout reserves (see render-output.js).
      // Do it before the markup is stored, so a later re-render keeps the trim.
      global.WoxiRender.fitGraphics(entry.dom.output);
      // Plots that carry a view handle become draggable/pinchable, and ask for a
      // re-sample when the view needs data the picture does not have
      // (plot-interact.js).
      attachPlots(entry);
      entry.output = entry.dom.output.innerHTML;
      entry.items = json;
      var t2 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
      entry.engineMs = Math.round(t1 - t0);
      entry.renderMs = Math.round(t2 - t1);
      entry.bytesJson = json.length;
      refreshAssist();
    }, function (err) {
      showBusy(entry, false);
      entry.dom.output.innerHTML = '<div class="woxi-out woxi-out-error">' +
        (err && err.message ? err.message : String(err)) + '</div>';
    });
  }

  var plotLatencyMs = 0;

  // Wires the plots of one entry. Frames change the markup and the range, and both
  // are what the entry keeps - so a notebook rebuild restores the view the user left
  // the plot at, and the listener reference is a live controller rather than an
  // attribute that a rebuild would leave behind claiming to be wired.
  function attachPlots(entry) {
    if (!entry || !entry.dom) return;
    global.WoxiPlot.attach(entry.dom.output, requestPlot, function () {
      entry.output = entry.dom.output.innerHTML;
    });
  }

  // One plot-interaction message (Jupyter-shaped: `msg_type` plus `content`).
  // Resolves with the reply, `{status: 'ok', content}` or
  // `{status: 'error', ename, evalue}`, so the plot controller can tell an expired
  // handle from a plot that simply cannot be re-sampled.
  function requestPlot(msgType, content) {
    var answer = engine.plot(msgType, content);
    // A test can make plot answers arrive late, to exercise what happens when a
    // gesture starts while an earlier frame is still on its way.
    if (!plotLatencyMs) return answer;
    return new Promise(function (resolve, reject) {
      global.setTimeout(function () { answer.then(resolve, reject); }, plotLatencyMs);
    });
  }

  function evaluateAll() {
    if (state.evaluating) return Promise.resolve();
    state.evaluating = true;
    // A fresh session: definitions from the previous run must not leak in.
    return engine.reset().then(function () {
      var chain = Promise.resolve();
      state.entries.forEach(function (entry) {
        chain = chain.then(function () { return evaluateEntry(entry); });
      });
      return chain;
    }).then(function () {
      state.evaluating = false;
    }, function (err) {
      state.evaluating = false;
      toast(err.message);
    });
  }

  function submitActive() {
    var entry = activeEntry();
    if (!entry) return;
    var wasLast = state.entries[state.entries.length - 1] === entry;
    evaluateEntry(entry).then(function () {
      if (wasLast) {
        var next = addEntry('', {});
        focusEntry(next);
      } else {
        var index = state.entries.indexOf(entry);
        var following = state.entries[index + 1];
        if (following) focusEntry(following);
      }
      scrollEntryIntoView(entry);
    });
  }

  function focusEntry(entry) {
    if (!entry || !entry.dom) return;
    setActive(entry);
    entry.dom.input.focus();
  }

  function scrollEntryIntoView(entry) {
    if (!entry || !entry.dom) return;
    setTimeout(function () {
      var rect = entry.dom.root.getBoundingClientRect();
      if (rect.top < 60 || rect.bottom > global.innerHeight - 260) {
        entry.dom.root.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, 30);
  }

  function insertText(text, caretOffset) {
    var entry = activeEntry();
    if (!entry || !entry.dom) return;
    var input = entry.dom.input;
    var focused = global.document.activeElement === input;
    var start = focused && input.selectionStart !== null ? input.selectionStart : entry.caret;
    var end = focused && input.selectionEnd !== null ? input.selectionEnd : start;
    if (start === null || start === undefined) start = input.value.length;
    if (end === null || end === undefined) end = start;
    var value = input.value;
    input.value = value.slice(0, start) + text + value.slice(end);
    var caret = start + Math.max(0, text.length - (caretOffset || 0));
    entry.caret = caret;
    if (focused) input.setSelectionRange(caret, caret);
    entry.input = input.value;
    autoGrow(input);
    state.dirty = true;
    updateTitle();
    persist();
    refreshAssist();
  }

  // typing help

  // The text and caret the bar describes, or null when there is no entry to describe.
  // The entry does not have to hold DOM focus: every key on this keyboard inserts through
  // `entry.caret`, and a tap on a chip must not lose the caret it is about to replace.
  function readActiveText() {
    var entry = activeEntry();
    if (!entry || !entry.dom) return null;
    var input = entry.dom.input;
    // Only a focused textarea reports the caret truthfully: some WebViews reset the
    // selection to 0 when the field blurs, which would move the bar to the start of
    // the entry every time a key is tapped.
    var caret = global.document.activeElement === input ? input.selectionStart : entry.caret;
    if (caret === null || caret === undefined) caret = entry.caret;
    if (caret === null || caret === undefined) caret = input.value.length;
    return { code: input.value, caret: caret };
  }

  // Replaces a range of the active entry, which is how a suggestion is accepted: the
  // typed prefix goes away and the chosen name (and, for a call, its opening bracket)
  // takes its place.
  function replaceRange(start, end, text, caretAfter) {
    var entry = activeEntry();
    if (!entry || !entry.dom) return;
    var input = entry.dom.input;
    var value = input.value;
    start = Math.max(0, Math.min(start, value.length));
    end = Math.max(start, Math.min(end, value.length));
    input.value = value.slice(0, start) + text + value.slice(end);
    var caret = start + (caretAfter === undefined ? text.length : caretAfter);
    entry.caret = caret;
    input.setSelectionRange(caret, caret);
    entry.input = input.value;
    autoGrow(input);
    state.dirty = true;
    updateTitle();
    persist();
    refreshAssist();
  }

  function setCaret(offset) {
    var entry = activeEntry();
    if (!entry || !entry.dom) return;
    var input = entry.dom.input;
    var at = Math.max(0, Math.min(offset, input.value.length));
    input.setSelectionRange(at, at);
    entry.caret = at;
    refreshAssist();
  }

  function refreshAssist() {
    if (assist) assist.refresh();
  }

  // A blur fires before the next focus, so the bar is refreshed after both have run.
  function refreshAssistLater() {
    setTimeout(refreshAssist, 0);
  }

  // While the keyboard is up the entry belongs next to it, not half a screen above:
  // the caret, the suggestions and the keys are then within one glance and one thumb.
  function liftEntry(entry) {
    if (!entry || !entry.dom) return;
    setTimeout(function () {
      var root = entry.dom.root;
      var rect = root.getBoundingClientRect();
      var view = notebookEl.getBoundingClientRect();
      if (rect.height >= view.height) return;
      var below = rect.bottom - (view.bottom - 12);
      if (below < -1) root.scrollIntoView({ block: 'end', behavior: 'smooth' });
    }, 40);
  }

  // Runs one example from the gallery: it replaces the entry, like the old plot keys
  // did, so "show me something" stays one tap.
  function runTemplate(text) {
    var entry = activeEntry();
    if (!entry || !entry.dom) return;
    entry.dom.input.value = text;
    entry.input = text;
    entry.caret = text.length;
    autoGrow(entry.dom.input);
    entry.dom.input.focus();
    state.dirty = true;
    updateTitle();
    persist();
    evaluateEntry(entry);
  }

  // The example gallery of the assist sheet. The plot keys insert the call itself and
  // let the bar name its arguments. The ready-made versions live here.
  function gatherTemplates() {
    var list = [];
    var examples = global.WoxiKeyboard.EXAMPLES || [];
    for (var i = 0; i < examples.length; i += 1) {
      var example = examples[i];
      if (!example.i) continue;
      list.push({ label: example.l, insert: example.i, hint: example.t || '' });
    }
    return list;
  }

  function backspace() {
    var entry = activeEntry();
    if (!entry || !entry.dom) return;
    var input = entry.dom.input;
    var focused = global.document.activeElement === input;
    var start = focused && input.selectionStart !== null ? input.selectionStart : entry.caret;
    var end = focused && input.selectionEnd !== null ? input.selectionEnd : start;
    if (start === null || start === undefined) start = input.value.length;
    if (end === null || end === undefined) end = start;
    if (start === end && start > 0) start -= 1;
    input.value = input.value.slice(0, start) + input.value.slice(end);
    entry.caret = start;
    if (focused) input.setSelectionRange(start, start);
    entry.input = input.value;
    autoGrow(input);
    state.dirty = true;
    updateTitle();
    persist();
    refreshAssist();
  }

  // Replaces an entry's source, re-evaluates it and keeps the UI in sync.
  function applySource(entry, text) {
    entry.dom.input.value = text;
    entry.input = text;
    autoGrow(entry.dom.input);
    focusEntry(entry);
    evaluateEntry(entry);
    state.dirty = true;
    updateTitle();
    persist();
  }

  // Plot / Solve action keys. A filled entry is wrapped unless it already is such a call.
  // An empty one just opens the call: the bar names its arguments, so there is no
  // example to delete first (the sheet's Examples tab has the ready-made versions).
  function wrapActive(kind) {
    var entry = activeEntry();
    if (!entry || !entry.dom) return;
    var text = entry.dom.input.value.trim();
    if (!text) {
      insertText(kind === 'plot' ? 'Plot[' : 'Solve[', 0);
      return;
    }
    if (kind === 'plot') {
      applySource(entry, /^\s*Plot\s*\[/i.test(text) ? text : 'Plot[' + text + ', {x, -10, 10}]');
    } else {
      applySource(entry, /^\s*Solve\s*\[/i.test(text) ? text : 'Solve[' + text + ', x]');
    }
  }

  // Action bar: add an empty entry after the active one and focus it.
  function newEntryBelow() {
    var entry = activeEntry();
    var index = entry ? state.entries.indexOf(entry) + 1 : state.entries.length;
    var added = addEntry('', { index: index });
    focusEntry(added);
    scrollEntryIntoView(added);
  }

  // Action bar: copy the active entry, keeping its result (same session, same value).
  function duplicateActive() {
    var entry = activeEntry();
    if (!entry || !entry.dom) return;
    var copy = addEntry(entry.input, { index: state.entries.indexOf(entry) + 1 });
    copy.output = entry.output;
    copy.items = entry.items;
    copy.dom.output.innerHTML = entry.output || '';
    wireManipulate(copy.dom.root);
    focusEntry(copy);
    scrollEntryIntoView(copy);
    state.dirty = true;
    updateTitle();
    persist();
  }

  // Action bar: remove the active entry (a lone entry is emptied instead).
  function deleteActive() {
    var entry = activeEntry();
    if (!entry) return;
    if (state.entries.length === 1) { clearActive(); return; }
    var index = state.entries.indexOf(entry);
    state.entries.splice(index, 1);
    renderNotebook();
    setActive(state.entries[Math.min(index, state.entries.length - 1)]);
    state.dirty = true;
    updateTitle();
    persist();
  }

  // Action bar: empty the active entry, its result and its caret.
  function clearActive() {
    var entry = activeEntry();
    if (!entry || !entry.dom) return;
    entry.dom.input.value = '';
    entry.dom.output.innerHTML = '';
    entry.input = '';
    entry.output = '';
    entry.items = null;
    entry.caret = 0;
    autoGrow(entry.dom.input);
    focusEntry(entry);
    state.dirty = true;
    updateTitle();
    persist();
  }

  // Action bar: cut / copy / paste over the active entry's text.
  function clipboardOp(op) {
    var entry = activeEntry();
    if (!entry || !entry.dom) return;
    if (op === 'paste') {
      var clip = nativeCall('getClipboard');
      clip = clip === undefined || clip === null ? '' : String(clip);
      if (!clip) { toast('Clipboard is empty'); return; }
      insertText(clip, 0);
      toast('Pasted');
      return;
    }
    var input = entry.dom.input;
    var focused = global.document.activeElement === input;
    var start = focused && input.selectionStart !== null ? input.selectionStart : entry.caret;
    var end = focused && input.selectionEnd !== null ? input.selectionEnd : start;
    if (start === null || start === undefined) start = input.value.length;
    if (end === null || end === undefined) end = start;
    var selection = end > start ? input.value.slice(start, end) : input.value;
    if (!selection) { toast('Nothing to copy'); return; }
    nativeCall('setClipboard', selection);
    if (op === 'copy') { toast('Copied'); return; }
    input.value = end > start ? input.value.slice(0, start) + input.value.slice(end) : '';
    entry.input = input.value;
    entry.caret = end > start ? start : 0;
    if (focused) input.setSelectionRange(entry.caret, entry.caret);
    autoGrow(input);
    state.dirty = true;
    updateTitle();
    persist();
    toast('Cut');
  }

  function handleKeyAction(action, data) {
    if (action === 'assist') {
      if (assist) assist.action(data);
      return;
    }
    if (action === 'enter') submitActive();
    else if (action === 'back') backspace();
    else if (action === 'plot') wrapActive('plot');
    else if (action === 'solve') wrapActive('solve');
    else if (action === 'new') newEntryBelow();
    else if (action === 'duplicate') duplicateActive();
    else if (action === 'delete') deleteActive();
    else if (action === 'clear') clearActive();
    else if (action === 'cut' || action === 'copy' || action === 'paste') clipboardOp(action);
    else if (action === 'evalall') {
      toast('Evaluating...');
      evaluateAll().then(function () { toast('Done'); });
    }
  }

  // menu / sheets

  function openSheet(title, build) {
    sheetTitleEl.textContent = title;
    sheetBodyEl.innerHTML = '';
    build(sheetBodyEl);
    overlayEl.className = '';
    nativeCall('setBackHandlerActive', true);
  }

  function closeSheet() {
    overlayEl.className = 'woxi-hidden';
    nativeCall('setBackHandlerActive', false);
  }

  function sheetButton(label, hint, handler) {
    var btn = el('button', 'woxi-sheet-item');
    btn.type = 'button';
    btn.appendChild(el('span', null, label));
    if (hint) btn.appendChild(el('small', null, hint));
    btn.addEventListener('click', function () {
      closeSheet();
      handler();
    });
    return btn;
  }

  function showMenu() {
    openSheet('Menu', function (body) {
      body.appendChild(sheetButton('New notebook', 'clear entries and start over', newNotebook));
      body.appendChild(sheetButton('Open...', 'read a Jupyter notebook (.ipynb)', openDocument));
      body.appendChild(sheetButton('Save', state.fileName ? state.fileName : 'JSON document', function () { saveDocument(false); }));
      body.appendChild(sheetButton('Save as...', 'choose a location', function () { saveDocument(true); }));
      body.appendChild(el('div', 'woxi-sheet-sep'));
      body.appendChild(sheetButton('Evaluate all entries', 'restart the session and re-run everything', function () {
        toast('Evaluating...');
        evaluateAll().then(function () { toast('Done'); });
      }));
    });
  }

  function showOptions() {
    openSheet('Options', function (body) {
      body.appendChild(el('div', 'woxi-sheet-text', 'Theme'));
      var modes = [
        ['system', 'System', 'follow the device setting'],
        ['light', 'Light', ''],
        ['dark', 'Dark', ''],
      ];
      modes.forEach(function (entry) {
        var mode = entry[0];
        var selected = state.settings.theme === mode;
        body.appendChild(sheetButton((selected ? '\u2713  ' : '     ') + entry[1], entry[2], function () {
          setTheme(mode);
        }));
      });
    });
  }

  // theming

  var DARK_QUERY = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
  var appliedTheme = null;

  // 'system' resolves through the device setting. The result is 'light' or 'dark'.
  function resolveTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return DARK_QUERY && DARK_QUERY.matches ? 'dark' : 'light';
  }

  // Applies a theme mode ('system' | 'light' | 'dark'): the CSS variables flip, the
  // native side follows (window background, system-bar icons) and the interpreter is
  // told whether to typeset for a dark background. Because the typeset SVGs carry
  // their colours, existing results are re-evaluated when the resolved theme changes.
  function setTheme(mode) {
    state.settings.theme = mode;
    var resolved = resolveTheme(mode);
    var changed = appliedTheme !== null && appliedTheme !== resolved;
    appliedTheme = resolved;
    global.document.documentElement.setAttribute('data-theme', resolved);
    nativeCall('setTheme', resolved);
    persist();
    if (changed && state.entries.some(function (entry) { return entry.output; })) {
      evaluateAll();
    }
  }

  if (DARK_QUERY) {
    var onSystemThemeChange = function () {
      if (state.settings.theme === 'system') setTheme('system');
    };
    if (DARK_QUERY.addEventListener) DARK_QUERY.addEventListener('change', onSystemThemeChange);
    else if (DARK_QUERY.addListener) DARK_QUERY.addListener(onSystemThemeChange);
  }

  // documents

  function newNotebook() {
    state.title = 'Untitled';
    state.fileName = null;
    state.entries = [];
    state.dirty = false;
    addEntry('', {});
    focusEntry(state.entries[0]);
    updateTitle();
    persist();
    engine.reset();
  }

  function saveDocument(forcePicker) {
    var name = state.fileName || global.WoxiNotebook.suggestFileName(state.title);
    var json = global.WoxiNotebook.serialize(state);
    var base64 = global.WoxiNotebook.utf8ToBase64(json);
    nativeCall('saveFile', name, base64, global.WoxiNotebook.MIME);
  }

  function openDocument() {
    nativeCall('openFile');
  }

  function loadDocumentFromText(text, fileName) {
    var doc = global.WoxiNotebook.parse(text);
    state.title = doc.title || global.WoxiNotebook.displayTitle(fileName);
    state.fileName = fileName || state.fileName;
    state.entries = [];
    state.nextId = 1;
    doc.entries.forEach(function (entry) { addEntry(entry.input, {}); });
    state.dirty = false;
    updateTitle();
    persist();
    autoGrowAll();
    if (doc.skippedCells) {
      log('opened ' + fileName + ': skipped ' + doc.skippedCells + ' non-code cell(s)');
    }
    toast('Evaluating...');
    evaluateAll().then(function () { toast('Opened ' + (fileName || 'notebook')); });
  }

  // native callbacks

  global.WoxiNativeCallbacks = {
    onInsets: function (top, bottom) {
      // The native side reports physical pixels. CSS wants CSS pixels. It pushes the
      // values whenever they change and once the page has finished loading, so there is
      // nothing to poll for here.
      var dpr = global.devicePixelRatio || 1;
      var root = global.document.documentElement;
      root.style.setProperty('--woxi-inset-top', (top / dpr) + 'px');
      root.style.setProperty('--woxi-inset-bottom', (bottom / dpr) + 'px');
    },
    onSaveComplete: function (ok, name) {
      if (ok === 'true' || ok === true) {
        state.fileName = name;
        state.dirty = false;
        updateTitle();
        persist();
        toast('Saved ' + name);
      } else {
        toast('Save cancelled');
      }
      },
    onFileOpened: function (name, base64) {
      if (!name || !base64) {
        toast('Nothing opened');
        return;
      }
      try {
        loadDocumentFromText(global.WoxiNotebook.base64ToUtf8(base64), name);
      } catch (err) {
        toast('Cannot read document: ' + err.message);
      }
    },
    toClipboard: undefined,
  };

  // boot

  function hideSplash() {
    splashEl.className = 'woxi-hidden';
    document.getElementById('woxi-app').className = '';
  }

  function boot() {
    notebookEl = document.getElementById('woxi-notebook');
    titleEl = document.getElementById('woxi-title');
    overlayEl = document.getElementById('woxi-overlay');
    sheetTitleEl = document.getElementById('woxi-sheet-title');
    sheetBodyEl = document.getElementById('woxi-sheet-body');
    toastEl = document.getElementById('woxi-toast');
    splashEl = document.getElementById('woxi-splash');

    overlayEl.addEventListener('click', function (event) {
      if (event.target === overlayEl) closeSheet();
    });
    // Rotation, keyboard and system-bar changes all change the wrapping width.
    global.addEventListener('resize', function () { autoGrowAll(); });
    document.getElementById('woxi-btn-menu').addEventListener('click', showMenu);
    document.getElementById('woxi-btn-options').addEventListener('click', showOptions);

    keyboard = new global.WoxiKeyboard.Keyboard({
      onInsert: function (text, caret) { insertText(text, caret); },
      onAction: handleKeyAction,
    });

    assist = new global.WoxiAssist.Assist({
      read: readActiveText,
      replace: replaceRange,
      setCaret: setCaret,
      evaluate: runTemplate,
      templates: gatherTemplates,
    });
    assist.bind(keyboard, function (msgType, content) {
      if (!engine) return Promise.resolve(null);
      return engine.query(msgType, content);
    });

    var restored = restore();
    if (!restored) state.entries = [];
    if (!state.entries.length) addEntry('', {});
    renderNotebook();
    autoGrowAll();
    updateTitle();
    setActive(state.entries[0]);
    setTheme(state.settings.theme);

    engine = new global.WoxiClient();
    engine.start().then(function () {
      hideSplash();
      // Show results for a restored notebook (this is a one-shot evaluation, not
      // typing-time evaluation).
      var hasInput = state.entries.some(function (entry) { return entry.input.trim(); });
      if (hasInput) evaluateAll();
      else focusEntry(state.entries[0]);
    }, function (err) {
      log('engine start failed: ' + (err && err.message));
    });
  }

  // automation test hooks

  function domSummary() {
    var outputs = 0;
    var errors = 0;
    var svgs = 0;
    var graphics = 0;
    var manipulates = 0;
    for (var i = 0; i < state.entries.length; i++) {
      var entry = state.entries[i];
      if (!entry.dom) continue;
      var out = entry.dom.output;
      if (out.children.length) outputs += 1;
      errors += out.querySelectorAll('.woxi-out-error').length;
      svgs += out.querySelectorAll('svg').length;
      graphics += out.querySelectorAll('.woxi-out-graphic').length;
      manipulates += out.querySelectorAll('.woxi-manipulate').length;
    }
    return 'entries=' + state.entries.length +
      ' withOutput=' + outputs +
      ' errors=' + errors +
      ' svgs=' + svgs +
      ' graphics=' + graphics +
      ' manipulates=' + manipulates +
      ' title=' + state.title +
      ' inset=' + global.getComputedStyle(global.document.documentElement).getPropertyValue('--woxi-inset-bottom').trim();
  }

  var testAction = function (action, argument) {
    switch (action) {
      case 'insert': {
        var entry = activeEntry();
        if (!entry || !entry.dom) { log('insert: no active entry'); return; }
        entry.dom.input.value = argument || '';
        entry.input = argument || '';
        entry.caret = entry.input.length;   // keep the caret at the end, as a user would
        entry.dom.input.focus();
        autoGrow(entry.dom.input);
        if (argument) {
          evaluateEntry(entry).then(function () {
            log('insert: evaluated ' + argument);
          });
        }
        break;
      }
      case 'type': {
        // Puts text in the active entry without evaluating it: what the user has typed
        // so far, for the assist bar to describe.
        var typedEntry = activeEntry();
        if (!typedEntry || !typedEntry.dom) { log('type: no entry'); break; }
        typedEntry.dom.input.value = argument || '';
        typedEntry.input = argument || '';
        typedEntry.caret = typedEntry.input.length;
        typedEntry.dom.input.focus();
        typedEntry.dom.input.setSelectionRange(typedEntry.caret, typedEntry.caret);
        autoGrow(typedEntry.dom.input);
        refreshAssist();
        log('type: ' + typedEntry.input);
        break;
      }
      case 'add': {
        // Append a new entry with the given source and evaluate it.
        var nowMs = function () { return (global.performance && global.performance.now) ? global.performance.now() : Date.now(); };
        var tSetup = nowMs();
        var added = addEntry(argument || '', {});
        focusEntry(added);
        autoGrow(added.dom.input);
        var tEval = nowMs();
        evaluateEntry(added).then(function () {
          log('add: evaluated ' + (argument || '').slice(0, 40) +
            ' | setup=' + Math.round(tEval - tSetup) + 'ms eval=' + Math.round(nowMs() - tEval) +
            'ms engine=' + added.engineMs + 'ms render=' + added.renderMs + 'ms json=' + added.bytesJson + 'B');
        });
        break;
      }
      case 'key': {
        // Simulate one of the keyboard action keys: enter | plot | solve | back.
        handleKeyAction(argument || 'enter');
        log('key: ' + argument);
        break;
      }
      case 'keys': {
        // Press a keyboard key by its label, exactly as a tap would: a key on the current
        // page wins, otherwise the first page/bar page that has that label.
        var here = global.WoxiKeyboard.PAGES[keyboard.pageId];
        var found = null;
        for (var k = 0; here && k < here.keys.length; k++) {
          if (here.keys[k].l === argument) { found = { key: here.keys[k], page: here.id }; break; }
        }
        if (!found) found = global.WoxiKeyboard.findKey(argument);
        if (!found) { log('keys: no key labelled ' + argument); return; }
        keyboard.press(found.key);
        log('keys: ' + argument + ' page=' + found.page + ' input=' +
          ((activeEntry() && activeEntry().dom) ? activeEntry().dom.input.value : '') +
          ' caret=' + ((activeEntry() && activeEntry().dom) ? activeEntry().caret : '?') +
          ' shift=' + keyboard.shift +
          ' entries=' + state.entries.length);
        break;
      }
      case 'evalall': {
        var hasInput = state.entries.some(function (e) { return e.input.trim(); });
        log('evalall: inputs=' + hasInput);
        evaluateAll().then(function () { log('evalall: done'); });
        break;
      }
      case 'dom':
        log('dom: ' + domSummary());
        break;
      case 'assist': {
        // Dump the context bar, so a device test can assert on what the user sees.
        var assistRead = readActiveText();
        if (!assist || !assistRead) { log('assist: none'); break; }
        var insets = {};
        try {
          insets = JSON.parse(global.WoxiNative.getInsets());
        } catch (err) {
          insets = {};
        }
        var dpr = global.devicePixelRatio || 1;
        var insetTop = insets.top || 0;
        var barKeys = document.querySelectorAll('#woxi-kb-actions .woxi-key');
        var barRects = [];
        for (var bk = 0; bk < barKeys.length; bk += 1) {
          var keyRect = barKeys[bk].getBoundingClientRect();
          barRects.push(barKeys[bk].getAttribute('data-key') + '@' +
            Math.round((keyRect.left + keyRect.width / 2) * dpr) + ',' +
            Math.round(insetTop + (keyRect.top + keyRect.height / 2) * dpr));
        }
        log('assist: state=' + assist.state +
          ' prefix="' + assist.prefix + '"' +
          ' matches=' + assist.matches.names.slice(0, 6).join(',') +
          ' caret=' + assistRead.caret +
          ' text="' + assistRead.code.slice(0, 40) + '"' +
          ' bar=' + barRects.join(' '));
        var viewport = global.visualViewport;
        var kbdRect = document.getElementById('woxi-keyboard').getBoundingClientRect();
        log('metrics: w=' + global.innerWidth + ' h=' + global.innerHeight +
          ' dpr=' + global.devicePixelRatio +
          ' clientH=' + document.documentElement.clientHeight +
          ' vv=' + (viewport ? Math.round(viewport.height) + '@' + Math.round(viewport.offsetTop) : '-') +
          ' kb=' + Math.round(kbdRect.top) + '..' + Math.round(kbdRect.bottom) +
          ' sheet=' + (assist.dom ? assist.dom.className : '-'));
        break;      }
      case 'assistaccept': {
        if (!assist) { log('assistaccept: no assist'); break; }
        var acceptName = argument || (assist.matches.names.length ? assist.matches.names[0] : '');
        if (!acceptName) { log('assistaccept: no match'); break; }
        assist.apply(acceptName);
        log('assistaccept: ' + acceptName);
        break;
      }
      case 'assistsheet': {
        if (!assist) { log('assistsheet: no assist'); break; }
        assist.openSheet(argument || 'all');
        log('assistsheet: ' + (argument || 'all') + ' rows=' +
          document.querySelectorAll('#woxi-assist-body [data-assist-insert],#woxi-assist-body [data-assist-template]').length);
        break;
      }
      case 'assistclose': {
        if (assist) assist.closeSheet();
        log('assistclose');
        break;
      }
      case 'press': {
        // Presses one of the keyboard's keys by label, through the same path a tap takes.
        var pressed = global.WoxiKeyboard.findKey(argument);
        if (!pressed) { log('press: no key ' + argument); break; }
        keyboard.press(pressed.key);
        log('press: ' + argument + ' page=' + pressed.page);
        break;
      }
      case 'caret': {
        var caretEntry = activeEntry();
        if (!caretEntry || !caretEntry.dom) { log('caret: no entry'); break; }
        var at = parseInt(argument, 10);
        if (isNaN(at)) at = caretEntry.dom.input.value.length;
        caretEntry.dom.input.focus();
        setCaret(at);
        log('caret: ' + caretEntry.dom.input.selectionStart);
        break;
      }
      case 'dump': {
        // Log every entry's source and a text preview of its output.
        for (var d = 0; d < state.entries.length; d++) {
          var item = state.entries[d];
          var text = item.dom ? (item.dom.output.textContent || '').replace(/\s+/g, ' ').slice(0, 110) : '';
          var svgCount = item.dom ? item.dom.output.querySelectorAll('svg').length : 0;
          var gsvg = item.dom ? item.dom.output.querySelector('.woxi-out-graphic svg') : null;
          var fit = gsvg ? ((gsvg.getAttribute('data-woxi-fit') === '1' ? 'yes' : 'raw') +
            ' ' + Math.round(parseFloat(gsvg.getAttribute('width')) || 0) + 'x' +
            Math.round(parseFloat(gsvg.getAttribute('height')) || 0)) : '-';
          var plotEl = item.dom ? item.dom.output.querySelector('.woxi-plot') : null;
          var plotView = plotEl ? global.WoxiPlot.viewOf(plotEl) : null;
          var plot = plotView ? ' | plot=' + plotView.id +
            ' x=[' + plotView.x[0].toFixed(3) + ',' + plotView.x[1].toFixed(3) + ']' +
            ' y=[' + plotView.y[0].toFixed(3) + ',' + plotView.y[1].toFixed(3) + ']' +
            (plotView.d ? ' data=[' + plotView.d[0].toFixed(3) + ',' + plotView.d[1].toFixed(3) + ']' : '') +
            (plotView.dy ? ' dy=[' + plotView.dy[0].toFixed(3) + ',' + plotView.dy[1].toFixed(3) + ']' : '') +
            ' resample=' + (plotView.s ? 'yes' : 'no') +
            ' densify=' + (plotView.dn ? ('level' + (plotEl.getAttribute('data-woxi-density') || '1')) : 'no') +
            (function () {
              // The rectangle gestures map onto: the data area when the axes are
              // recognisable, the whole SVG otherwise.
              var area = global.WoxiPlot.plotRect(plotEl);
              return area ? ' rect=' + Math.round(area.width) + 'x' + Math.round(area.height) +
                (area.data ? '/data' : '/svg') : '';
            })() : '';
          log('dump ' + (d + 1) + ': in=' + item.input + ' | svgs=' + svgCount + ' | fit=' + fit + plot + ' | out=' + text +
            (item.engineMs === undefined ? '' :
              ' | engine=' + item.engineMs + 'ms render=' + item.renderMs + 'ms json=' + item.bytesJson + 'B'));
        }
        break;
      }
      case 'save': {
        var name = argument || 'Test.ipynb';
            nativeCall('saveFile', name, global.WoxiNotebook.utf8ToBase64(global.WoxiNotebook.serialize(state)), 'application/json');
        log('save: requested ' + name);
        break;
      }
      case 'loadjson': {
        if (!argument) { log('loadjson: no argument'); return; }
        loadDocumentFromText(argument, 'Test.ipynb');
        log('loadjson: loaded');
        break;
      }
      case 'plotpinch': {
        // Two synthetic pointers closing or opening over time, so the pinch path is
        // exercised the way a real one arrives: moves interleaved with the answers
        // they trigger. adb cannot inject two fingers at once.
        var pinchPlot = global.WoxiPlot.first(notebookEl || document);
        if (!pinchPlot) { log('plotpinch: no interactive plot'); break; }
        var box = pinchPlot.getBoundingClientRect();
        var px = box.left + box.width / 2;
        var py = box.top + box.height / 2;
        var startGap = Math.min(box.width, box.height) * 0.15;
        var pinchFactor = Number(argument) || 2;
        var fire = function (type, id, x, y) {
          pinchPlot.dispatchEvent(new PointerEvent(type, {
            pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
            bubbles: true, cancelable: true, isPrimary: id === 1,
          }));
        };
        fire('pointerdown', 1, px - startGap, py);
        fire('pointerdown', 2, px + startGap, py);
        var steps = 8;
        var step = 0;
        var tick = function () {
          step += 1;
          var gap = startGap * (1 + (pinchFactor - 1) * step / steps);
          fire('pointermove', 1, px - gap, py);
          fire('pointermove', 2, px + gap, py);
          if (step < steps) {
            global.setTimeout(tick, 70);
            return;
          }
          fire('pointerup', 1, px - startGap * pinchFactor, py);
          fire('pointerup', 2, px + startGap * pinchFactor, py);
          log('plotpinch: factor=' + pinchFactor + ' center=' + Math.round(px) + ',' + Math.round(py));
        };
        global.setTimeout(tick, 70);
        break;
      }
      case 'plotdrag': {
        // A drag streamed over time, like a finger: 8 moves of dx/8.
        var dragPlot = global.WoxiPlot.first(notebookEl || document);
        if (!dragPlot) { log('plotdrag: no interactive plot'); break; }
        var parts2 = (argument || '').split(',');
        var totalX = Number(parts2[0] || 0);
        var totalY = Number(parts2[1] || 0);
        var dragBox = dragPlot.getBoundingClientRect();
        var sx = dragBox.left + dragBox.width / 2;
        var sy = dragBox.top + dragBox.height / 2;
        var fireDrag = function (type, x, y) {
          dragPlot.dispatchEvent(new PointerEvent(type, {
            pointerId: 11, pointerType: 'touch', clientX: x, clientY: y,
            bubbles: true, cancelable: true, isPrimary: true,
          }));
        };
        fireDrag('pointerdown', sx, sy);
        var dragSteps = 8;
        var dragStep = 0;
        var dragTick = function () {
          dragStep += 1;
          fireDrag('pointermove', sx + totalX * dragStep / dragSteps, sy + totalY * dragStep / dragSteps);
          if (dragStep < dragSteps) {
            global.setTimeout(dragTick, 70);
            return;
          }
          fireDrag('pointerup', sx + totalX, sy + totalY);
          log('plotdrag: dx=' + totalX + ' dy=' + totalY);
        };
        global.setTimeout(dragTick, 70);
        break;
      }
      case 'plotlatency': {
        // Test hook: delay plot answers, so races can be reproduced on a device.
        plotLatencyMs = Number(argument) || 0;
        log('plotlatency: ' + plotLatencyMs + 'ms');
        break;
      }
      case 'plotrefine': {
        // Asks for more data now instead of waiting for the idle timer.
        var refineTarget = global.WoxiPlot.first(notebookEl || document);
        if (!refineTarget) { log('plotrefine: no interactive plot'); break; }
        var refineView = global.WoxiPlot.viewOf(refineTarget);
        var summary = ' x=[' + refineView.x[0].toFixed(3) + ',' + refineView.x[1].toFixed(3) +
          '] data=[' + refineView.d[0].toFixed(3) + ',' + refineView.d[1].toFixed(3) + ']';
        if (!global.WoxiPlot.needsRefine(refineView)) {
          log('plotrefine: not needed' + summary);
          break;
        }
        log('plotrefine: asking' + summary);
        global.WoxiPlot.refine(refineTarget, refineView);
        break;
      }
      case 'plotview': {
        // Drives the plot gestures from a test: "pan,<dx>,<dy>" or
        // "zoom,<factor>[,<fx>,<fy>]" with the anchor in fractions of the plot area.
        var drivePlot = global.WoxiPlot.first(notebookEl || document);
        if (!drivePlot) { log('plotview: no interactive plot'); break; }
        var parts = (argument || '').split(',');
        var gesture = drivePlot.__woxiPlot;
        var next = null;
        if (parts[0] === 'zoom') {
          var factor = Number(parts[1]);
          var fx = parts.length > 2 ? Number(parts[2]) : undefined;
          var fy = parts.length > 3 ? Number(parts[3]) : undefined;
          next = gesture ? gesture.zoomBy(factor, fx, fy)
            : global.WoxiPlot.zoomView(drivePlot, factor, fx, fy);
        } else {
          next = gesture ? gesture.panBy(Number(parts[1] || 0), Number(parts[2] || 0))
            : global.WoxiPlot.panView(drivePlot, Number(parts[1] || 0), Number(parts[2] || 0));
        }
        if (!next) { log('plotview: nothing to do'); break; }
        log('plotview ' + parts[0] + ': id=' + next.id +
          ' x=[' + next.x[0].toFixed(3) + ',' + next.x[1].toFixed(3) + ']' +
          ' y=[' + next.y[0].toFixed(3) + ',' + next.y[1].toFixed(3) + ']');
        break;
      }
      case 'metrics': {
        // Reports the input-box geometry, to check that wrapped lines are not clipped,
        // plus the keyboard geometry, to check that swiping does not resize it.
        for (var m = 0; m < state.entries.length; m++) {
          var metricEntry = state.entries[m];
          if (!metricEntry.dom) continue;
          var inputEl = metricEntry.dom.input;
          var rect = inputEl.getBoundingClientRect();
          log('metrics ' + (m + 1) + ': len=' + inputEl.value.length +
            ' lines=' + (inputEl.value.split('\n').length) +
            ' width=' + Math.round(rect.width) +
            ' clientH=' + inputEl.clientHeight + ' scrollH=' + inputEl.scrollHeight +
            ' styleH=' + inputEl.style.height + ' overflow=' + inputEl.style.overflowY +
            ' clipped=' + (inputEl.scrollHeight > inputEl.clientHeight + 1));
        }
        var kbd = document.getElementById('woxi-keyboard').getBoundingClientRect();
        var pad = document.getElementById('woxi-kb-keys').getBoundingClientRect();
        var bar = document.getElementById('woxi-kb-actions').getBoundingClientRect();
        log('metrics kbd: total=' + Math.round(kbd.height) +
          ' pad=' + Math.round(pad.height) + ' bar=' + Math.round(bar.height));
        break;
      }
      case 'kb':
        log('kb: ' + keyboard.describe());
        break;
      case 'multitouch': {
        // The reported case: one finger drags the pad, a second finger touches it, then the
        // first finger finishes the drag. With 'lost' the first finger's touchend never
        // arrives (a dropped event), which used to wedge the pad until the app restarted.
        // Synthetic touch events, because adb cannot inject two fingers at once.
        var view = keyboard.padView;
        var lost = argument === 'lost';
        var points = {};
        var list = function (ids) {
          return ids.map(function (id) { return points[id]; });
        };
        var send = function (type, id, x, y, others) {
          points[id] = new global.Touch({
            identifier: id, target: view, clientX: x, clientY: y,
            pageX: x, pageY: y, screenX: x, screenY: y,
            radiusX: 4, radiusY: 4, force: 1,
          });
          var remaining = type === 'touchend' ? list(others) : list(others.concat([id]));
          view.dispatchEvent(new global.TouchEvent(type, {
            bubbles: true, cancelable: true,
            touches: remaining, targetTouches: remaining, changedTouches: [points[id]],
          }));
        };
        try {
          send('touchstart', 1, 900, 2050, []);
          send('touchmove', 1, 700, 2050, []);
          if (lost) {
            // Finger 1 vanishes. Finger 3 starts a fresh gesture.
            send('touchstart', 3, 800, 2200, []);
            send('touchmove', 3, 600, 2200, []);
            send('touchend', 3, 600, 2200, []);
          } else {
            send('touchstart', 2, 500, 2200, [1]);
            send('touchmove', 1, 500, 2050, [2]);
            send('touchend', 2, 500, 2200, [1]);
            send('touchmove', 1, 300, 2050, []);
            send('touchend', 1, 300, 2050, []);
          }
        } catch (err) {
          log('multitouch: synthetic touches unsupported (' + err.message + ')');
          return;
        }
        global.setTimeout(function () {
          var slide = keyboard.slide;
          log('multitouch' + (lost ? ' lost' : '') + ': slide=' + (slide
            ? (slide.animating ? 'ANIMATING(' : 'STUCK(') + Math.round(slide.progress) + ')'
            : 'none') +
            ' page=' + keyboard.pageId +
            ' dragging=' + keyboard.padView.classList.contains('woxi-kb-dragging'));
        }, 250);
        break;
      }
      case 'swipe': {
        var dir = argument || 'left';
        var moved = keyboard.swipe(dir);
        var box2 = document.getElementById('woxi-keyboard').getBoundingClientRect();
        log('swipe ' + dir + ': changed=' + moved + ' kbdH=' + Math.round(box2.height) +
          ' ' + keyboard.describe());
        break;
      }
      case 'barswipe': {
        var bdir = argument || 'left';
        keyboard.swipeBar(bdir);
        var box3 = document.getElementById('woxi-keyboard').getBoundingClientRect();
        log('barswipe ' + bdir + ': kbdH=' + Math.round(box3.height) + ' ' + keyboard.describe());
        break;
      }
      case 'shift': {
        // 'double' simulates two quick taps (the device harness is too slow for that).
        if (argument === 'double') {
          keyboard.toggleShift();
          keyboard.toggleShift();
        } else {
          keyboard.toggleShift();
        }
        log('shift: state=' + keyboard.shift + ' (' +
          ['off', 'one shot', 'locked'][keyboard.shift] + ')');
        break;
      }
      case 'theme':
        setTheme(argument || 'system');
        log('theme: requested=' + (argument || 'system') + ' resolved=' +
          resolveTheme(argument || 'system'));
        break;
      case 'reload':
        global.location.reload();
        break;
      case 'serialize': {
        var json = global.WoxiNotebook.serialize(state);
        log('serialize: ' + json.replace(/\s+/g, ' ').slice(0, 260));
        break;
      }
      case 'slider': {
        // Nudge the first Manipulate slider to check live re-rendering.
        // Optional argument: target fraction of the slider range (default 0.75).
        var slider = notebookEl.querySelector('.woxi-manipulate input[type=range]');
        if (!slider) { log('slider: none found'); return; }
        var block = slider.closest('.woxi-manipulate');
        var viewEl = block.querySelector('.woxi-manipulate-view');
        var fraction = parseFloat(argument);
        if (isNaN(fraction)) fraction = 0.75;
        var beforeSvg = viewEl.querySelector('svg');
        var beforeMarkup = beforeSvg ? beforeSvg.outerHTML : '';
        var target = Number(slider.min) + (Number(slider.max) - Number(slider.min)) * fraction;
        slider.value = String(target);
        slider.dispatchEvent(new global.Event('input', { bubbles: true }));
        setTimeout(function () {
          var svg = viewEl.querySelector('svg');
          var afterMarkup = svg ? svg.outerHTML : '';
          var firstDiff = -1;
          for (var i = 0; i < Math.min(beforeMarkup.length, afterMarkup.length); i++) {
            if (beforeMarkup.charAt(i) !== afterMarkup.charAt(i)) { firstDiff = i; break; }
          }
          log('slider: fraction=' + fraction + ' value=' + slider.value +
            ' svgBefore=' + beforeMarkup.length + ' svgAfter=' + afterMarkup.length +
            ' identical=' + (beforeMarkup === afterMarkup) + ' firstDiffAt=' + firstDiff);
        }, 1500);
        break;
      }
      case 'scrollto': {
        var index = parseInt(argument, 10) - 1;
        var target2 = state.entries[index];
        if (target2 && target2.dom) target2.dom.root.scrollIntoView({ block: 'start' });
        log('scrollto: ' + argument);
        break;
      }
      case 'sheet':
        showMenu();
        break;
      case 'options':
        showOptions();
        break;
      default:
        log('unknown test action ' + action);
    }
  };

  global.WoxiApp = {
    testAction: testAction,
    onNativeBack: function () {
      if (overlayEl && overlayEl.className.indexOf('woxi-hidden') < 0) {
        closeSheet();
        return true;
      }
      return false;
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
