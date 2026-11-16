// The assist sheet: the full-height panel behind the bar's "more" actions - matches,
// examples, a call's slots and options, diagnostics, and a symbol's documentation. It is a set
// of methods installed on `Assist`: the controller owns the state and the panel builds the
// DOM and runs the row actions.

import { callArgumentRange, prefixSpan, scanContext } from "./assist-scan.js";
import { escapeHtml } from "./html.js";
import { isCallName, OPTION_ARROW, roleLabel, STATUS_LABEL } from "./prototypes.js";

const EXAMPLE_ROWS = 3;

export function installSheet(Assist) {
  Object.assign(Assist.prototype, {
    buildSheet,
    applyExample,
    openSheet,
    closeSheet,
    renderSheet,
    emptyHint,
    matchRows,
    exampleRows,
    callRows,
    issueRows,
    aboutRows,
  });
}

function buildSheet() {
  const self = this;
  const root = document.createElement("div");
  root.id = "woxi-assist";
  root.className = "woxi-hidden";
  root.innerHTML =
    '<div id="woxi-assist-panel">' +
    '<div id="woxi-assist-head">' +
    '<div id="woxi-assist-tabs">' +
    '<button type="button" class="woxi-assist-tab" data-tab="matches" tabindex="-1">Matches</button>' +
    '<button type="button" class="woxi-assist-tab" data-tab="examples" tabindex="-1">Examples</button>' +
    '<button type="button" class="woxi-assist-tab" data-tab="call" tabindex="-1">Call</button>' +
    '<button type="button" class="woxi-assist-tab" data-tab="about" tabindex="-1">About</button>' +
    '<button type="button" class="woxi-assist-tab" data-tab="issues" tabindex="-1">Issues</button>' +
    "</div>" +
    '<button type="button" id="woxi-assist-close" tabindex="-1">Close</button>' +
    "</div>" +
    '<div id="woxi-assist-body"></div>' +
    "</div>";
  document.body.appendChild(root);
  this.dom = root;

  // A tap must not take focus away from the entry: the user keeps typing while the
  // list is open, and the list keeps filtering.
  root.addEventListener("mousedown", function (event) {
    event.preventDefault();
  });
  root.addEventListener(
    "touchstart",
    function (event) {
      if (event.target === root) self.closeSheet();
    },
    { passive: true }
  );
  root.querySelector("#woxi-assist-close").addEventListener("click", function () {
    self.closeSheet();
  });
  const tabs = root.querySelectorAll(".woxi-assist-tab");
  for (let i = 0; i < tabs.length; i += 1) {
    tabs[i].addEventListener("click", function (event) {
      const tab = event.currentTarget;
      if (!(tab instanceof Element)) return;
      self.sheetTab = tab.getAttribute("data-tab");
      self.renderSheet();
    });
  }
  root.querySelector("#woxi-assist-body").addEventListener("click", function (event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest(
      "[data-assist-insert],[data-assist-template],[data-assist-option]," +
        "[data-assist-example],[data-assist-skeleton],[data-assist-variant],[data-assist-fix],[data-assist-goto]"
    );
    if (!row) return;
    if (row.hasAttribute("data-assist-template")) {
      self.sink.evaluate(row.getAttribute("data-assist-template"));
      self.closeSheet();
    } else if (row.hasAttribute("data-assist-option")) {
      const option = row.getAttribute("data-assist-option");
      if (row.hasAttribute("data-assist-option-call")) {
        // A call-card option belongs in the call's options region. `applyOption`
        // appends it there instead of editing the argument under the caret.
        self.applyOption(option);
      } else {
        const read = self.sink.read();
        if (read) {
          self.sink.replace(
            read.selStart,
            read.selEnd,
            option + OPTION_ARROW,
            option.length + OPTION_ARROW.length
          );
        }
      }
      self.closeSheet();
    } else if (row.hasAttribute("data-assist-example")) {
      const slot = Number(row.getAttribute("data-assist-slot"));
      self.applyExample(row.getAttribute("data-assist-example"), slot);
    } else if (row.hasAttribute("data-assist-skeleton")) {
      if (self.applySkeleton(row.getAttribute("data-assist-skeleton"), { wrap: false })) {
        self.closeSheet();
      }
    } else if (row.hasAttribute("data-assist-variant")) {
      const parts = row.getAttribute("data-assist-variant").split(":");
      self.variantChoice[self.variantKey(parts[0])] = Number(parts[1]);
      self.refresh();
      self.renderSheet();
    } else if (row.hasAttribute("data-assist-goto")) {
      if (self.sink.gotoDefinition) self.sink.gotoDefinition(row.getAttribute("data-assist-goto"));
      self.closeSheet();
    } else if (row.hasAttribute("data-assist-fix")) {
      // The payload is JSON in one attribute: the insert text can contain anything.
      const fix = JSON.parse(row.getAttribute("data-assist-fix"));
      if (fix) self.sink.replace(Number(fix.start), Number(fix.end), fix.insert, fix.insert.length);
      self.closeSheet();
    } else {
      self.apply(row.getAttribute("data-assist-insert"));
    }
  });
}

function applyExample(example, slot) {
  const read = this.sink.read();
  if (!read) return;
  const ctx = scanContext(read.code, read.caret);
  if (!ctx.call || slot === null || slot === undefined || Number.isNaN(slot)) return;
  let text = example;
  const range = callArgumentRange(read.code, ctx.call.open, slot);
  const start = range.start;
  const end = range.end;
  if (range.missing) {
    // The call does not have this argument yet: append it with a separator, the way
    // the user would add the next argument.
    const inside = read.code.slice(ctx.call.open + 1, start).trim();
    const before = read.code.slice(0, start).trimEnd();
    if (inside && !/,$/.test(before)) text = ", " + text;
    else if (inside && /,$/.test(before)) text = " " + text;
  }
  // Keep one separator space when the argument starts after a comma. An argument that
  // already begins with whitespace keeps its indentation and the example follows it.
  let at = start;
  if (read.code.charAt(at) === " ") at += 1;
  else if (at > 0 && read.code.charAt(at - 1) === ",") text = " " + text;
  this.sink.replace(at, end, text, text.length);
}

function openSheet(tab) {
  if (!this.dom) return;
  if (tab) this.sheetTab = tab;
  this.sheetOpen = true;
  const keyboard = document.getElementById("woxi-keyboard");
  const height = keyboard ? Math.round(keyboard.getBoundingClientRect().height) : 0;
  // The scrim stops above the keys: the keyboard stays usable, so typing keeps
  // narrowing the list while it is open.
  this.dom.style.bottom = height + "px";
  this.dom.classList.remove("woxi-hidden");
  this.ensureCatalog();
  const read = this.sink.read();
  if (read) {
    const info = this.contextFor(read);
    if (info.state === "candidates") {
      this.requestMatches(info.span.text, this.optionsContext(info, read), read);
    }
  }
  this.renderSheet();
}

function closeSheet() {
  this.sheetOpen = false;
  this.about = null;
  if (this.dom) this.dom.classList.add("woxi-hidden");
}

function renderSheet() {
  if (!this.dom || !this.sheetOpen) return;
  const body = this.dom.querySelector("#woxi-assist-body");
  const tabs = this.dom.querySelectorAll(".woxi-assist-tab");
  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i];
    const name = tab.getAttribute("data-tab");
    tab.classList.toggle("woxi-on", name === this.sheetTab);
    if (name === "issues") {
      const count = this.issues.items.length;
      tab.textContent = count ? "Issues (" + count + ")" : "Issues";
    }
  }
  let rows;
  if (this.sheetTab === "examples") rows = this.exampleRows();
  else if (this.sheetTab === "about") rows = this.aboutRows();
  else if (this.sheetTab === "call") rows = this.callRows();
  else if (this.sheetTab === "issues") rows = this.issueRows();
  else rows = this.matchRows();
  body.innerHTML = rows.length
    ? rows.join("")
    : '<div class="woxi-assist-empty">' + escapeHtml(this.emptyHint()) + "</div>";
}

function emptyHint() {
  if (this.sheetTab === "about") return "Put the caret on a name to see what it is.";
  if (this.sheetTab === "examples") return "No examples here.";
  if (this.sheetTab === "call") return "Put the caret in a call to see its arguments.";
  if (this.sheetTab === "issues") {
    const read = this.sink.read();
    return read && read.code.trim() ? "No problems found." : "Nothing to check yet.";
  }
  const prefix = this.candidates && this.candidates.prefix;
  if (prefix) return 'No match for "' + prefix + '".';
  if (this.catalog && this.catalog.total) {
    return (
      this.catalog.total + " symbols from Woxi " + this.catalog.version + " \u2014 type a name."
    );
  }
  return "Type a name to see matches.";
}

function statusBadge(status, category) {
  const label = STATUS_LABEL[status] || "";
  const parts = [];
  if (label) parts.push(label);
  if (category) parts.push(category);
  return parts.length
    ? '<span class="woxi-assist-meta">' + escapeHtml(parts.join(" \u00b7 ")) + "</span>"
    : "";
}

function matchRows() {
  const candidates = this.candidates;
  const names = candidates ? candidates.names : [];
  const details = candidates ? candidates.details : [];
  const rows = [];
  for (let i = 0; i < names.length; i += 1) {
    const detail = details[i] || {};
    rows.push(
      '<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-insert="' +
        escapeHtml(names[i]) +
        '">' +
        '<span class="woxi-assist-name">' +
        escapeHtml(names[i]) +
        "</span>" +
        '<span class="woxi-assist-desc">' +
        escapeHtml(detail.description || "") +
        "</span>" +
        statusBadge(detail.status, detail.category) +
        "</button>"
    );
  }
  return rows;
}

function exampleRows() {
  const templates = this.sink.templates ? this.sink.templates() : [];
  const rows = [];
  for (let i = 0; i < templates.length; i += 1) {
    rows.push(
      '<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-template="' +
        escapeHtml(templates[i].insert) +
        '">' +
        '<span class="woxi-assist-name">' +
        escapeHtml(templates[i].label) +
        "</span>" +
        '<span class="woxi-assist-desc">' +
        escapeHtml(templates[i].hint || "") +
        "</span>" +
        "</button>"
    );
  }
  return rows;
}

// One row per option, shared by the call card (defaults from `Options[head]`, with the
// ones already written in the call marked) and the About card (the same defaults, but
// inserted at the caret rather than as an option of the current call).
function optionRows(options, used, call) {
  const rows = [];
  for (let i = 0; i < options.length; i += 1) {
    const option = options[i];
    const name = option.name;
    const value = option.value;
    const set = used && used[name] ? " \u2713" : "";
    rows.push(
      '<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-option="' +
        escapeHtml(name) +
        '"' +
        (call ? ' data-assist-option-call="1"' : "") +
        ">" +
        '<span class="woxi-assist-name">' +
        escapeHtml(name) +
        escapeHtml(set) +
        "</span>" +
        '<span class="woxi-assist-desc">' +
        escapeHtml(value || "") +
        "</span>" +
        "</button>"
    );
  }
  return rows;
}

function callRows() {
  const read = this.sink.read();
  if (!read) return [];
  const ctx = scanContext(read.code, read.caret);
  const head = ctx.head;
  if (!head) return [];
  const variants = this.variantsOf(head);
  const active = variants
    ? this.variantFor(head, this.positionalArgumentCount(read.code, ctx), variants)
    : null;
  const activeIndex = active ? variants.indexOf(active) : -1;
  const used = this.optionsInCall(read.code, ctx);
  const options = this.optionsOf(head);
  if (options === null) {
    const self = this;
    this.inspectFor(head).then(function (loaded) {
      if (loaded && self.sheetOpen && self.sheetTab === "call") self.renderSheet();
    });
  }
  const rows = ['<div class="woxi-assist-about">'];
  if (active) {
    const position =
      ctx.argIndex < active.length
        ? Math.min(ctx.argIndex + 1, active.length) + " of " + active.length
        : "options";
    rows.push(
      '<div class="woxi-assist-about-name">' + escapeHtml(head) + " \u2014 " + position + "</div>"
    );
    for (let i = 0; i < active.length; i += 1) {
      const slot = active[i];
      rows.push(
        '<div class="woxi-assist-slot' +
          (i === ctx.argIndex ? " woxi-assist-slot-on" : "") +
          '">' +
          '<span class="woxi-assist-slot-name">' +
          escapeHtml(slot.text) +
          "</span>" +
          '<span class="woxi-assist-slot-role">' +
          escapeHtml(roleLabel(slot.role)) +
          "</span>" +
          "</div>"
      );
      const examples = (slot.examples || []).slice(0, EXAMPLE_ROWS);
      if (examples.length) {
        rows.push('<div class="woxi-assist-examples">');
        for (let e = 0; e < examples.length; e += 1) {
          rows.push(
            '<button type="button" class="woxi-assist-chip" tabindex="-1" data-assist-slot="' +
              i +
              '" data-assist-example="' +
              escapeHtml(examples[e]) +
              '">' +
              escapeHtml(examples[e]) +
              "</button>"
          );
        }
        rows.push("</div>");
      }
    }
    rows.push('<div class="woxi-assist-actions">');
    rows.push(
      '<button type="button" class="woxi-assist-action" tabindex="-1" data-assist-skeleton="' +
        escapeHtml(head) +
        '">insert skeleton</button>'
    );
    rows.push("</div>");
    if (variants.length > 1) {
      rows.push('<div class="woxi-assist-about-line">Other forms:</div>');
      for (let v = 0; v < variants.length; v += 1) {
        if (v === activeIndex) continue;
        const text = variants[v]
          .map(function (part) {
            return part.text;
          })
          .join(", ");
        rows.push(
          '<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-variant="' +
            escapeHtml(head) +
            ":" +
            v +
            '">' +
            '<span class="woxi-assist-name">' +
            escapeHtml(head) +
            "[" +
            escapeHtml(text) +
            "]</span>" +
            "</button>"
        );
      }
    }
  } else {
    // Woxi has options but no usage patterns. The sheet can still show the options even
    // when there are no slot names to draw.
    rows.push('<div class="woxi-assist-about-name">' + escapeHtml(head) + "</div>");
    rows.push(
      '<div class="woxi-assist-about-line">Woxi does not declare this call\'s argument names.</div>'
    );
  }
  if (options && options.length) {
    rows.push('<div class="woxi-assist-about-line">Options (' + options.length + "):</div>");
    rows.push(...optionRows(options, used, true));
  }
  rows.push("</div>");
  return rows;
}

function issueRows() {
  const rows = [];
  for (let i = 0; i < this.issues.items.length; i += 1) {
    const issue = this.issues.items[i];
    let message = issue.message;
    if (issue.code === "syntax") {
      // The grammar's own wording names parser rules. Say what a reader can act on.
      message = "Syntax error here";
    }
    let fix = "";
    if (issue.fix) {
      fix =
        '<button type="button" class="woxi-assist-chip" tabindex="-1" data-assist-fix="' +
        escapeHtml(JSON.stringify(issue.fix)) +
        '">' +
        escapeHtml(issue.fix.label) +
        "</button>";
    }
    rows.push(
      '<div class="woxi-assist-issue woxi-assist-issue-' +
        escapeHtml(issue.severity) +
        '">' +
        '<span class="woxi-assist-issue-dot"></span>' +
        '<span class="woxi-assist-desc">' +
        escapeHtml(message) +
        "</span>" +
        fix +
        "</div>"
    );
  }
  return rows;
}

function aboutRows() {
  const read = this.sink.read();
  if (!read) return [];
  const ctx = scanContext(read.code, read.caret);
  const span = prefixSpan(read.code, read.caret);
  let name = span.text;
  if (!name && ctx.head) name = ctx.head;
  if (!name) return [];
  if (this.about && this.about.name === name) return this.about.rows;
  const self = this;
  const loading = ['<div class="woxi-assist-empty">Loading\u2026</div>'];
  this.about = { name: name, rows: loading };
  const finish = function (rows) {
    self.about = { name: name, rows: rows };
    if (self.sheetOpen && self.sheetTab === "about") self.renderSheet();
  };
  this.inspectFor(name).then(function (result) {
    // Another name was asked for while this one was on its way.
    if (!self.about || self.about.name !== name) return;
    const defined = self.definitions.find(function (definition) {
      return definition.name === name;
    });
    if (!result) {
      finish([
        '<div class="woxi-assist-about"><div class="woxi-assist-about-line">Unavailable.</div></div>',
      ]);
      return;
    }
    if (!result.found) {
      const rows = ['<div class="woxi-assist-about">'];
      rows.push('<div class="woxi-assist-about-name">' + escapeHtml(name) + "</div>");
      if (defined) {
        rows.push(
          '<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-goto="' +
            escapeHtml(name) +
            '"><span class="woxi-assist-name">defined in entry ' +
            (defined.entry + 1) +
            '</span><span class="woxi-assist-desc">go to definition</span></button>'
        );
        if (defined.params && defined.params.length) {
          rows.push(
            '<div class="woxi-assist-about-line">parameters: ' +
              escapeHtml(defined.params.join(", ")) +
              "</div>"
          );
        }
      } else {
        rows.push('<div class="woxi-assist-about-line">Nothing known about this name yet.</div>');
      }
      rows.push("</div>");
      finish(rows);
      return;
    }
    const meta = result.info;
    const lines = ['<div class="woxi-assist-about">'];
    lines.push('<div class="woxi-assist-about-name">' + escapeHtml(meta.name || name) + "</div>");
    lines.push(
      '<div class="woxi-assist-about-line">' + statusBadge(meta.status, meta.category) + "</div>"
    );
    if (meta.description) {
      lines.push('<div class="woxi-assist-about-line">' + escapeHtml(meta.description) + "</div>");
    }
    if (meta.attributes && meta.attributes.length) {
      lines.push(
        '<div class="woxi-assist-about-line">' +
          escapeHtml(attributeText(meta.attributes)) +
          "</div>"
      );
    }
    if (meta.arity) {
      const arity =
        meta.arity[1] === null
          ? meta.arity[0] + " or more arguments"
          : meta.arity[0] === meta.arity[1]
            ? meta.arity[0] + " argument(s)"
            : meta.arity[0] + " to " + meta.arity[1] + " arguments";
      lines.push('<div class="woxi-assist-about-line">' + escapeHtml(arity) + "</div>");
    }
    if (meta.status === "not_planned") {
      lines.push(
        '<div class="woxi-assist-about-line woxi-assist-warn">Woxi does not plan to support this.</div>'
      );
    } else if (meta.status === "not_implemented") {
      lines.push(
        '<div class="woxi-assist-about-line woxi-assist-warn">Not implemented in Woxi yet.</div>'
      );
    }
    if (self.variantsOf(meta.name || name) && isCallName(meta.name || name)) {
      lines.push(
        '<div class="woxi-assist-actions">' +
          '<button type="button" class="woxi-assist-action" tabindex="-1" data-assist-skeleton="' +
          escapeHtml(meta.name || name) +
          '">insert skeleton</button></div>'
      );
    }
    const defaults = meta.optionDefaults || [];
    if (defaults.length) {
      lines.push(
        '<div class="woxi-assist-about-line">Options (' +
          defaults.length +
          "), tap to insert:</div>"
      );
      lines.push(...optionRows(defaults, null, false));
    }
    if (meta.doc) {
      lines.push(
        '<div class="woxi-assist-about-line woxi-assist-doc">' + escapeHtml(meta.doc) + "</div>"
      );
    }
    if (defined) {
      lines.push(
        '<div class="woxi-assist-about-line">defined in entry ' + (defined.entry + 1) + "</div>"
      );
      if (defined.params && defined.params.length) {
        lines.push(
          '<div class="woxi-assist-about-line">parameters: ' +
            escapeHtml(defined.params.join(", ")) +
            "</div>"
        );
      }
    }
    lines.push("</div>");
    finish(lines);
  });
  return loading;
}

function attributeText(attributes) {
  const notes = [];
  const rest = [];
  for (let i = 0; i < attributes.length; i += 1) {
    const name = attributes[i];
    if (name === "HoldAll") notes.push("HoldAll: arguments are not evaluated");
    else if (name === "HoldFirst") notes.push("HoldFirst: first argument is not evaluated");
    else if (name === "HoldRest")
      notes.push("HoldRest: arguments after the first are not evaluated");
    else if (name === "Listable") notes.push("Listable: applies to each element");
    else if (name === "NumericFunction") notes.push("NumericFunction");
    else if (name === "Protected" || name === "ReadProtected") continue;
    else rest.push(name);
  }
  if (rest.length) notes.push(rest.join(", "));
  return notes.join(" \u00b7 ");
}
