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
// cannot know (Wolfram has no usage patterns in Woxi's registry), so they live in
// `prototypes.js` and are enriched with what `prototypes_request` learns from the
// shipped examples.
//
// This file is the controller and the state schema. The feature modules install their
// methods on `Assist.prototype` (the same pattern as `assist-sheet.js`), so they never
// import this file and can be read in isolation.

import { installApply } from "./assist-apply.js";
import { installBar } from "./assist-bar.js";
import { installCompletion } from "./assist-completion.js";
import { installContext } from "./assist-context.js";
import { installDefinitions } from "./assist-definitions.js";
import { installDiagnostics } from "./assist-diagnostics.js";
import { installInspect } from "./assist-inspect.js";
import { PROTOCOL } from "./assist-shared.js";
import { installSheet } from "./assist-sheet.js";
import { installSkeleton } from "./assist-skeleton.js";

function Assist(sink) {
  this.sink = sink; // {read, replace, setCaret, select, evaluate, templates, entryId, entryKey, codes}
  this.keyboard = null;
  this.query = null;
  this.seq = 0;
  this.timer = null;
  // The candidates on the bar, or null when another row is showing. The key is the
  // `matchesKey` the list was requested with. A late repaint must not apply a list from
  // another entry, definitions generation or options context.
  this.candidates = null;
  this.inspections = new Map(); // symbol -> {found, info, optionNames}, one inspect per name
  this.inspectionLoads = new Map(); // symbol -> in-flight inspect request
  this.sheetTab = "matches";
  this.sheetOpen = false;
  this.cache = new Map();
  this.generation = 0;
  this.about = null;
  this.catalog = null;
  this.catalogAsked = false;
  this.dom = null;
  this.keysSignature = "";
  this.learned = Object.create(null); // head -> [variant] from the engine
  this.variantCache = Object.create(null); // head -> merged variants
  this.learnedAsked = false;
  this.definitions = []; // [{entry, name, params, start, end, full}]
  this.definitionsAsked = "";
  this.definitionsEntries = 0;
  this.definitionsGeneration = 0;
  this.definitionsTimer = null;
  this.issues = { code: "", items: [] };
  this.diagnosticsTimer = null;
  this.variantChoice = Object.create(null); // head@entry -> index chosen in the call card
}

Assist.prototype.bind = function (keyboard, query) {
  this.keyboard = keyboard;
  this.query = query;
  this.buildSheet();
};

// How much is indexed, for the empty sheet. One request per session, started when the
// sheet is first opened.
Assist.prototype.ensureCatalog = function () {
  const self = this;
  if (this.catalog || this.catalogAsked || !this.query) return;
  this.catalogAsked = true;
  this.query("catalog_request", {}).then(
    function (reply) {
      if (!reply || reply.status !== "ok" || !reply.content) {
        self.catalogAsked = false;
        return;
      }
      self.catalog = reply.content;
      if (self.sheetOpen) self.renderSheet();
    },
    function () {
      self.catalogAsked = false;
    }
  );
};

Assist.prototype.action = function (data) {
  if (!data) return;
  if (data.kind === "accept") this.apply(data.name, data.type, data);
  else if (data.kind === "option") this.apply(data.name, undefined, { callOption: true });
  else if (data.kind === "next") this.nextSlot();
  else if (data.kind === "call") this.openSheet("call");
  else if (data.kind === "issues") this.openSheet("issues");
  else if (data.kind === "more") this.openSheet("matches");
};

// Session symbols change when an entry runs, so the ranked answers are stale.
Assist.prototype.invalidate = function () {
  this.generation += 1;
  // A completion already in flight was ranked with the old session symbols.
  this.seq += 1;
  if (this.timer) {
    window.clearTimeout(this.timer);
    this.timer = null;
  }
  this.definitionsGeneration += 1;
  this.clearMatchCache();
  this.candidates = null;
  this.about = null;
  this.definitions = [];
  this.definitionsAsked = "";
  this.definitionsEntries = 0;
  if (this.definitionsTimer) {
    window.clearTimeout(this.definitionsTimer);
    this.definitionsTimer = null;
  }
  this.issues = { code: "", items: [] };
  if (this.diagnosticsTimer) {
    window.clearTimeout(this.diagnosticsTimer);
    this.diagnosticsTimer = null;
  }
  this.variantChoice = Object.create(null);
  // `Options[f]` can be redefined by an evaluation. Even the built-in answers are
  // cheap enough to re-fetch compared with showing a stale options row.
  this.inspections = new Map();
  this.inspectionLoads = new Map();
};

installContext(Assist);
installBar(Assist);
installCompletion(Assist);
installInspect(Assist);
installDefinitions(Assist);
installDiagnostics(Assist);
installApply(Assist);
installSkeleton(Assist);
installSheet(Assist);

export { Assist, PROTOCOL };
