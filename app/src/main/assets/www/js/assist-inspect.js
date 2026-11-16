// Inspect answers: one per symbol, with option defaults, arity and builtin metadata.
// The same cache feeds the options row, the call card, the About card and contextFor.

import { scanContext } from "./assist-scan.js";
import { CALL_KEY, GROW, MAX_CHIPS } from "./assist-shared.js";
import { BACK_KEY, EVAL_KEY } from "./keyboard-pages.js";

const INSPECT_CACHE_MAX = 40;

// One inspect request per name. The options row, the call card and the About card all
// read the same answer. `inspections` is the one cache. A hit moves the name to the end
// of the Map, so the cache evicts the least recently used symbol.
function inspectionOf(name) {
  const cached = this.inspections.get(name);
  if (!cached) return null;
  this.inspections.delete(name);
  this.inspections.set(name, cached);
  return cached;
}

function inspectFor(name) {
  const cached = this.inspectionOf(name);
  if (cached) return Promise.resolve(cached);
  if (!this.query) return Promise.resolve(null);
  const pending = this.inspectionLoads.get(name);
  if (pending) return pending;
  const self = this;
  const generation = this.generation;
  const promise = this.query("inspect_request", {
    code: name + "[",
    cursor_pos: name.length,
  }).then(
    function (reply) {
      if (self.inspectionLoads.get(name) === promise) self.inspectionLoads.delete(name);
      if (generation !== self.generation) return null;
      if (!reply || reply.status !== "ok" || !reply.content) return null;
      const raw = (reply.content.metadata && reply.content.metadata._woxi) || {};
      const info = Object.assign({}, raw);
      const defaults = info.optionDefaults || [];
      info.optionDefaults = defaults.map(function (defaultValue) {
        return Array.isArray(defaultValue)
          ? { name: defaultValue[0], value: defaultValue[1] }
          : defaultValue;
      });
      const optionNames = new Set(
        info.optionDefaults.map(function (option) {
          return option.name;
        })
      );
      const result = { found: reply.content.found === true, info: info, optionNames: optionNames };
      self.inspections.set(name, result);
      while (self.inspections.size > INSPECT_CACHE_MAX) {
        self.inspections.delete(self.inspections.keys().next().value);
      }
      return result;
    },
    function () {
      if (self.inspectionLoads.get(name) === promise) self.inspectionLoads.delete(name);
      return null;
    }
  );
  this.inspectionLoads.set(name, promise);
  return promise;
}

// The options a call declares, or null when its inspect answer is not cached yet.
function optionsOf(head) {
  const inspected = this.inspectionOf(head);
  return inspected ? inspected.info.optionDefaults || [] : null;
}

function callArityOf(head) {
  const inspected = this.inspectionOf(head);
  return inspected && Array.isArray(inspected.info.arity) ? inspected.info.arity : null;
}

// One inspect request for a call that has no curated slots. It carries both the options
// and the arity. `contextFor` can then place the options slot for a head it has never
// seen in `prototypes.js`.
function ensureCallMeta(head) {
  const self = this;
  if (!this.query || this.inspections.has(head) || this.inspectionLoads.has(head)) return;
  this.inspectFor(head).then(function () {
    if (!self.sink.read()) return;
    self.refreshBar();
    // The inspection adds the options context (and arity). A prefix typed while it
    // was on its way was requested without either. Ask again rather than leaving the
    // list ranked by the old context.
    self.requestCurrentMatches();
  });
}

function showOptions(head, extra) {
  const self = this;
  const cached = this.inspectionOf(head);
  if (cached) {
    this.renderOptions(head, cached.info.optionDefaults || [], extra);
    return;
  }
  // The previous row may have been a candidates list. It does not describe this
  // options state. The Matches sheet would otherwise keep showing it until the
  // inspect answer arrives.
  this.candidates = null;
  this.inspectFor(head).then(function (result) {
    if (!result) return;
    // Only if the caret still asks for options of this call. It may have moved into an
    // iterator or a name while the defaults were on their way.
    const read = self.sink.read();
    if (!read) return;
    const context = self.contextFor(read);
    if (context.state === "options" && context.ctx.head === head) {
      self.renderOptions(head, result.info.optionDefaults || [], self.issueKeys());
    }
    // The answer may also have arrived after the caret moved on to a name in the
    // options region. That completion was requested without the options context.
    self.requestCurrentMatches();
  });
}

function renderOptions(head, options, extra) {
  const read = this.sink.read();
  if (!read) return;
  const used = this.optionsInCall(read.code, scanContext(read.code, read.caret));
  const shown = [];
  for (let i = 0; i < options.length; i += 1) {
    if (used[options[i].name]) continue;
    shown.push(options[i]);
    if (shown.length === MAX_CHIPS) break;
  }
  if (!shown.length) {
    this.renderIdle(extra);
    return;
  }
  // The options row is not a completion list. The sheet's Matches tab would otherwise
  // show the list from the name that was being typed before the caret got here.
  this.candidates = null;
  const keys = [EVAL_KEY];
  for (let k = 0; k < shown.length; k += 1) {
    keys.push({
      label: shown[k].name,
      action: "assist",
      detail: { kind: "option", name: shown[k].name },
      classes: "fn chip",
      grow: GROW.chip,
      tooltip:
        shown[k].name + (shown[k].value ? " \u2192 " + shown[k].value : "") + " (of " + head + ")",
    });
  }
  keys.push({
    ...CALL_KEY,
    tooltip: "Options of " + head,
  });
  this.setKeys(keys.concat(extra || [], [BACK_KEY]));
}

export function installInspect(Assist) {
  Object.assign(Assist.prototype, {
    inspectionOf,
    inspectFor,
    optionsOf,
    callArityOf,
    ensureCallMeta,
    showOptions,
    renderOptions,
  });
}
