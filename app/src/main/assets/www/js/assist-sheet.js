// The assist sheet: the full-height panel behind the bar's "more" actions - matches,
// examples, a call's slots and options, diagnostics, and a symbol's documentation. It is a set
// of methods installed on `Assist` (the controller owns the state). The panel only builds DOM.

import { argumentEnd, argumentStart, escapeHtml, prefixSpan, scanContext } from "./assist-scan.js";
import { roleLabel, STATUS_LABEL } from "./prototypes.js";

export function installSheet(Assist) {
  Assist.prototype.buildSheet = buildSheet;
  Assist.prototype.applyExample = applyExample;
  Assist.prototype.openSheet = openSheet;
  Assist.prototype.closeSheet = closeSheet;
  Assist.prototype.renderSheet = renderSheet;
  Assist.prototype.emptyHint = emptyHint;
  Assist.prototype.matchRows = matchRows;
  Assist.prototype.exampleRows = exampleRows;
  Assist.prototype.callRows = callRows;
  Assist.prototype.issueRows = issueRows;
  Assist.prototype.aboutRows = aboutRows;
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
      const read = self.sink.read();
      if (read) self.sink.replace(read.caret, read.caret, option + " -> ", option.length + 4);
      self.closeSheet();
    } else if (row.hasAttribute("data-assist-example")) {
      self.applyExample(row.getAttribute("data-assist-example"));
    } else if (row.hasAttribute("data-assist-skeleton")) {
      self.applySkeleton(row.getAttribute("data-assist-skeleton"), { wrap: false });
      self.closeSheet();
    } else if (row.hasAttribute("data-assist-variant")) {
      const parts = row.getAttribute("data-assist-variant").split(":");
      self.variantChoice[parts[0]] = Number(parts[1]);
      self.refresh();
      self.renderSheet();
    } else if (row.hasAttribute("data-assist-goto")) {
      if (self.sink.gotoDefinition) self.sink.gotoDefinition(row.getAttribute("data-assist-goto"));
      self.closeSheet();
    } else if (row.hasAttribute("data-assist-fix")) {
      // The payload is JSON in one attribute: the insert text can contain anything.
      let fix = null;
      try {
        fix = JSON.parse(row.getAttribute("data-assist-fix"));
      } catch (err) {
        fix = null;
      }
      if (fix) self.sink.replace(Number(fix.start), Number(fix.end), fix.insert, fix.insert.length);
      self.closeSheet();
    } else {
      self.apply(row.getAttribute("data-assist-insert"));
    }
  });
}

function applyExample(example) {
  const read = this.sink.read();
  if (!read) return;
  let start = argumentStart(read.code, read.caret);
  const end = argumentEnd(read.code, read.caret);
  let head = start;
  while (head > 0 && read.code.charAt(head - 1) !== "," && read.code.charAt(head - 1) !== "[")
    head -= 1;
  let prefixSpace = "";
  if (read.code.charAt(start) === " ") {
    start += 1;
  } else if (head > 0 && read.code.charAt(head - 1) === ",") {
    prefixSpace = " ";
  }
  const text = prefixSpace + example;
  this.sink.replace(start, end, text, text.length);
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
  const self = this;
  for (let i = 0; i < tabs.length; i += 1) {
    const tab = tabs[i];
    const name = tab.getAttribute("data-tab");
    tab.classList.toggle("woxi-on", name === this.sheetTab);
    if (name === "issues") {
      tab.textContent = this.issues.length ? "Issues (" + this.issues.length + ")" : "Issues";
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
  void self;
}

function emptyHint() {
  if (this.sheetTab === "about") return "Put the caret on a name to see what it is.";
  if (this.sheetTab === "examples") return "No examples here.";
  if (this.sheetTab === "call") return "Put the caret in a call to see its arguments.";
  if (this.sheetTab === "issues")
    return this.read && this.read.code.trim() ? "No problems found." : "Nothing to check yet.";
  if (this.prefix) return 'No match for "' + this.prefix + '".';
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
  const names = this.matches.names || [];
  const details = this.matches.details || [];
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

function callRows() {
  const read = this.sink.read();
  if (!read) return [];
  const ctx = scanContext(read.code, read.caret);
  const head = ctx.head;
  if (!head) return [];
  const variants = this.variantsOf(head);
  if (!variants) return [];
  const active = this.variantFor(head, ctx.argIndex + 1);
  const activeIndex = variants.indexOf(active);
  const used = this.optionsInCall(read.code, ctx);
  const rows = ['<div class="woxi-assist-about">'];
  rows.push(
    '<div class="woxi-assist-about-name">' +
      escapeHtml(head) +
      " \u2014 " +
      Math.min(ctx.argIndex + 1, active.length) +
      " of " +
      active.length +
      (ctx.argIndex + 1 > active.length ? " (options)" : "") +
      "</div>"
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
    const examples = (slot.examples || []).slice(0, 3);
    if (examples.length) {
      rows.push('<div class="woxi-assist-examples">');
      for (let e = 0; e < examples.length; e += 1) {
        rows.push(
          '<button type="button" class="woxi-assist-chip" tabindex="-1" data-assist-example="' +
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
  const options = this.options[head];
  if (options && options.length) {
    rows.push('<div class="woxi-assist-about-line">Options (' + options.length + "):</div>");
    for (let o = 0; o < options.length && o < 40; o += 1) {
      const set = used[options[o].name] ? " \u2713" : "";
      rows.push(
        '<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-option="' +
          escapeHtml(options[o].name) +
          '">' +
          '<span class="woxi-assist-name">' +
          escapeHtml(options[o].name) +
          escapeHtml(set) +
          "</span>" +
          '<span class="woxi-assist-desc">' +
          escapeHtml(options[o].value || "") +
          "</span>" +
          "</button>"
      );
    }
  }
  rows.push("</div>");
  return rows;
}

function issueRows() {
  const rows = [];
  for (let i = 0; i < this.issues.length; i += 1) {
    const issue = this.issues[i];
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
  if (!this.query) return [];
  this.query("inspect_request", { code: name + "[", cursor_pos: name.length }).then(
    function (reply) {
      const defined = self.definitions.find(function (definition) {
        return definition.name === name;
      });
      if (!reply || reply.status !== "ok" || !reply.content || !reply.content.found) {
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
        self.about = { name: name, rows: rows };
      } else {
        const meta = (reply.content.metadata && reply.content.metadata._woxi) || {};
        const lines = ['<div class="woxi-assist-about">'];
        lines.push(
          '<div class="woxi-assist-about-name">' + escapeHtml(meta.name || name) + "</div>"
        );
        lines.push(
          '<div class="woxi-assist-about-line">' +
            statusBadge(meta.status, meta.category) +
            "</div>"
        );
        if (meta.description) {
          lines.push(
            '<div class="woxi-assist-about-line">' + escapeHtml(meta.description) + "</div>"
          );
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
        lines.push(
          '<div class="woxi-assist-actions">' +
            '<button type="button" class="woxi-assist-action" tabindex="-1" data-assist-skeleton="' +
            escapeHtml(meta.name || name) +
            '">insert skeleton</button></div>'
        );
        const defaults = meta.optionDefaults || [];
        if (defaults.length) {
          lines.push(
            '<div class="woxi-assist-about-line">Options (' +
              defaults.length +
              "), tap to insert:</div>"
          );
          for (let i = 0; i < defaults.length && i < 40; i += 1) {
            lines.push(
              '<button type="button" class="woxi-assist-row" tabindex="-1" data-assist-option="' +
                escapeHtml(defaults[i][0]) +
                '">' +
                '<span class="woxi-assist-name">' +
                escapeHtml(defaults[i][0]) +
                "</span>" +
                '<span class="woxi-assist-desc">' +
                escapeHtml(defaults[i][1]) +
                "</span>" +
                "</button>"
            );
          }
        }
        if (meta.doc) {
          lines.push(
            '<div class="woxi-assist-about-line woxi-assist-doc">' + escapeHtml(meta.doc) + "</div>"
          );
        }
        const definedHere = self.definitions.find(function (definition) {
          return definition.name === name;
        });
        if (definedHere) {
          lines.push(
            '<div class="woxi-assist-about-line">defined in entry ' +
              (definedHere.entry + 1) +
              "</div>"
          );
          if (definedHere.params && definedHere.params.length) {
            lines.push(
              '<div class="woxi-assist-about-line">parameters: ' +
                escapeHtml(definedHere.params.join(", ")) +
                "</div>"
            );
          }
        }
        lines.push("</div>");
        self.about = { name: name, rows: lines };
      }
      if (self.sheetOpen && self.sheetTab === "about") self.renderSheet();
    },
    function () {
      self.about = {
        name: name,
        rows: [
          '<div class="woxi-assist-about"><div class="woxi-assist-about-line">Unavailable.</div></div>',
        ],
      };
      if (self.sheetOpen && self.sheetTab === "about") self.renderSheet();
    }
  );
  return ['<div class="woxi-assist-empty">Loading\u2026</div>'];
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
