// Definitions: one debounced request for the whole notebook, and the parameters of the
// definition the caret is in (completion ranks those first).

const DEFINITIONS_MS = 400;

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;
const CODE_SEPARATOR = 0x1f;

// A compact key for the notebook's current text, used to avoid re-requesting definitions
// (and to store the last request without keeping every entry's source in state).
function codesKey(codes) {
  let hash = FNV_OFFSET;
  let length = 0;
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    length += code.length;
    for (let j = 0; j < code.length; j += 1) {
      hash ^= code.charCodeAt(j);
      hash = Math.imul(hash, FNV_PRIME);
    }
    hash ^= CODE_SEPARATOR;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return codes.length + ":" + length + ":" + (hash >>> 0);
}

function activeParameters(read) {
  read = read || this.sink.read();
  if (!read || !this.definitions.length) return [];
  const entry = this.sink.entryId ? this.sink.entryId() : 0;
  for (let i = 0; i < this.definitions.length; i += 1) {
    const definition = this.definitions[i];
    if (definition.entry !== entry) continue;
    const full = definition.full || [definition.start, definition.end];
    if (read.caret >= full[0] && read.caret <= full[1]) {
      return definition.params || [];
    }
  }
  return [];
}

function scheduleDefinitions() {
  const self = this;
  if (!this.query || !this.sink.codes) return;
  const codes = this.sink.codes();
  const key = codesKey(codes);
  // Definitions are indexed by entry. An insertion or deletion shifts those indexes,
  // so the old answer must not be used while the debounced new one is on its way. A
  // text edit inside the same number of entries keeps the old index layout.
  if (codes.length !== this.definitionsEntries) {
    this.definitions = [];
    this.definitionsEntries = codes.length;
    this.definitionsGeneration += 1;
    this.clearMatchCache();
  }
  if (key === this.definitionsAsked) return;
  if (this.definitionsTimer) window.clearTimeout(this.definitionsTimer);
  this.definitionsTimer = window.setTimeout(function () {
    self.definitionsTimer = null;
    self.definitionsAsked = key;
    self.query("definitions_request", { codes: codes }).then(
      function (reply) {
        // A newer text, a newer request, or an evaluation has superseded this answer.
        if (self.definitionsAsked !== key) return;
        if (!reply || reply.status !== "ok" || !reply.content) {
          self.definitionsAsked = "";
          return;
        }
        const current = self.sink.codes ? codesKey(self.sink.codes()) : key;
        if (current !== key) return;
        const entries = reply.content.entries || [];
        const flat = [];
        for (let index = 0; index < entries.length; index += 1) {
          for (let d = 0; d < entries[index].length; d += 1) {
            const definition = entries[index][d];
            flat.push({
              entry: index,
              name: definition.name,
              params: definition.params || [],
              start: definition.start,
              end: definition.end,
              full: definition.full || [definition.start, definition.end],
              kind: definition.kind,
            });
          }
        }
        self.definitions = flat;
        self.definitionsEntries = entries.length;
        self.definitionsGeneration += 1;
        // The previous answers were ranked without these definitions.
        self.clearMatchCache();
        self.about = null;
        if (self.sheetOpen && self.sheetTab === "about") self.renderSheet();
        // An answer that was in flight when the generation changed was dropped. Ask
        // again with the new definitions so the next repaint is not stale.
        self.requestCurrentMatches();
      },
      function () {
        // The next edit retries, unless a newer request has taken over.
        if (self.definitionsAsked === key) self.definitionsAsked = "";
      }
    );
  }, DEFINITIONS_MS);
}

export function installDefinitions(Assist) {
  Object.assign(Assist.prototype, {
    activeParameters,
    scheduleDefinitions,
  });
}
