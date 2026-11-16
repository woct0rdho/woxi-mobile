// Completion requests and their cache: the debounced engine call, reply parsing, the
// LRU keyed by prefix/entry/definitions/options context, and parameter ranking.

import { PROTOCOL } from "./assist-shared.js";

const MATCH_LIMIT = PROTOCOL.defaultMatches;
const SHEET_LIMIT = PROTOCOL.maxMatches;
const MATCH_CACHE_MAX = 64;
const DEBOUNCE_MS = 50;

// One key for the cache and for the request: the list depends on the entry (definition
// parameters are ranked for it), on the definitions generation, and on the options
// context as well as on the prefix.
function matchesKey(prefix, limit, options) {
  const entry = this.sink.entryKey ? this.sink.entryKey() : "";
  const context = options ? "@" + options.head + ":" + options.used.join(",") : "";
  return prefix + "@" + limit + "@" + entry + "@" + this.definitionsGeneration + context;
}

function storeMatches(key, result) {
  // Re-inserting moves the key to the end, so the oldest answer is evicted first.
  this.cache.delete(key);
  this.cache.set(key, result);
  while (this.cache.size > MATCH_CACHE_MAX) {
    const oldest = this.cache.keys().next().value;
    this.cache.delete(oldest);
  }
}

function clearMatchCache() {
  this.cache.clear();
}

function requestMatches(prefix, options, read) {
  const self = this;
  if (this.timer) {
    window.clearTimeout(this.timer);
    this.timer = null;
  }
  // Invalidate every in-flight answer, including one that the cached path below is
  // about to replace. The reply must describe this request, not an older context.
  const seq = ++this.seq;
  const limit = this.matchLimit();
  const key = this.matchesKey(prefix, limit, options);
  const cached = this.cache.get(key);
  if (cached) {
    cached.key = key;
    cached.prefix = prefix;
    if (!cached.names.length) {
      this.renderNoMatches(prefix, key);
      return;
    }
    this.candidates = cached;
    if (this.sheetOpen) this.renderSheet();
    this.setKeys(this.chipKeys(cached.names, cached.details, cached.total));
    return;
  }
  // The reply must describe the text the prefix came from. A caret drag moves the
  // caret while the request waits out the debounce, so the caret is captured here
  // rather than read again when the request finally goes out. `read` is the snapshot
  // the caller decided on. Falling back to a fresh read only for programmatic callers.
  read = read || this.sink.read() || {};
  const code = read.code || "";
  const caret = read.caret || 0;
  this.timer = window.setTimeout(function () {
    self.timer = null;
    self.fetchMatches(prefix, limit, code, caret, options, key, seq);
  }, DEBOUNCE_MS);
}

function matchLimit() {
  return this.sheetOpen ? SHEET_LIMIT : MATCH_LIMIT;
}

function fetchMatches(prefix, limit, code, caret, options, key, seq) {
  const self = this;
  if (!this.query) return;
  const content = { code: code, cursor_pos: caret, limit: limit };
  if (this.sink.codes) content.notebook_codes = this.sink.codes();
  if (options) {
    content.context_head = options.head;
    content.context_used = options.used;
  }
  this.query("complete_request", content).then(
    function (reply) {
      if (seq !== self.seq || !reply || reply.status !== "ok") return;
      // The caret can move to another context while the answer is on its way (into an
      // empty iterator, onto the options slot, or into another call with the same
      // prefix). A list for another context would paint the wrong state.
      const now = self.sink.read();
      if (!now) return;
      const info = self.contextFor(now);
      if (info.state !== "candidates" || info.span.text !== prefix) return;
      if (self.matchesKey(prefix, limit, self.optionsContext(info, now)) !== key) return;
      const content = reply.content || {};
      const names = content.matches || [];
      const meta = content.metadata || {};
      const types = meta._jupyter_types_experimental || [];
      const extra = meta._woxi || [];
      const details = [];
      for (let i = 0; i < names.length; i += 1) {
        details.push({
          description: (types[i] && types[i].docstring) || "",
          status: (extra[i] && extra[i].status) || "unknown",
          category: (extra[i] && extra[i].category) || "",
          type: (types[i] && types[i].type) || "function",
          arity: (extra[i] && extra[i].arity) || null,
          // An option symbol (`Axes`) is a name, not a call. `callOption` says it is an
          // option of the call the request was made in, so a chip can add the `->` too.
          option: !!(extra[i] && extra[i].option),
          callOption: !!(extra[i] && extra[i].callOption),
        });
      }
      self.rankParameters(names, details, prefix, now);
      const result = {
        key: key,
        prefix: prefix,
        names: names,
        details: details,
        total: typeof meta.total === "number" ? meta.total : names.length,
      };
      self.storeMatches(key, result);
      if (!result.names.length) {
        self.renderNoMatches(prefix, key);
        return;
      }
      self.candidates = result;
      if (self.sheetOpen) self.renderSheet();
      self.setKeys(self.chipKeys(result.names, result.details, result.total));
    },
    function () {
      // The next keystroke retries. Do not leave a list for the previous prefix on the
      // bar (or let a later warning repaint it) after the request failed.
      if (seq !== self.seq) return;
      const now = self.sink.read();
      if (!now) return;
      const info = self.contextFor(now);
      if (info.state !== "candidates" || info.span.text !== prefix) return;
      self.renderNoMatches(prefix, key);
    }
  );
}

// Parameters of the definition the caret is in are the names an expert types most
// often inside a body, so they lead the list - even when the engine does not know
// them, since `x` is not a builtin.
function rankParameters(names, details, prefix, read) {
  const params = this.activeParameters(read);
  if (!params.length) return;
  const wanted = (prefix || "").toLowerCase();
  for (let i = params.length - 1; i >= 0; i -= 1) {
    const name = params[i];
    if (wanted && name.toLowerCase().indexOf(wanted) !== 0) continue;
    const at = names.indexOf(name);
    const detail =
      at >= 0
        ? details[at]
        : {
            description: "",
            status: "implemented",
            category: "",
            type: "variable",
            arity: null,
            option: false,
            callOption: false,
          };
    if (at >= 0) {
      names.splice(at, 1);
      details.splice(at, 1);
    }
    detail.description = "parameter of this definition";
    detail.status = "implemented";
    names.unshift(name);
    details.unshift(detail);
  }
}

// Ask for the candidates of the caret's current prefix again. Used when new metadata
// (the call's options, or its definitions) has changed how the list should be ranked.
function requestCurrentMatches() {
  const read = this.sink.read();
  if (!read) return;
  const info = this.contextFor(read);
  if (info.state !== "candidates") return;
  this.requestMatches(info.span.text, this.optionsContext(info, read), read);
}

export function installCompletion(Assist) {
  Object.assign(Assist.prototype, {
    matchesKey,
    storeMatches,
    clearMatchCache,
    requestMatches,
    matchLimit,
    fetchMatches,
    rankParameters,
    requestCurrentMatches,
  });
}
