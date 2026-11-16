// Diagnostics: one debounced engine check per text, with the warning chip and the
// issue list. A warning belongs to the text it was found in.

const DIAGNOSTICS_MS = 350;

function scheduleDiagnostics(code) {
  const self = this;
  if (!this.query) return;
  // `code` is the text the current items describe, including a text that was found to
  // be incomplete (no items). Without recording that, every caret move would schedule
  // the same check again.
  if (code === this.issues.code) return;
  if (this.diagnosticsTimer) window.clearTimeout(this.diagnosticsTimer);
  if (!code.trim()) {
    this.setIssues("", []);
    return;
  }
  // A warning describes the text it was found in. As soon as the text changes it is
  // dropped. The check for the new text replaces it a moment later. (This keeps a stale
  // `!` chip from riding along on the next text.) The caller repaints the bar.
  if (this.issues.code !== code) {
    this.issues = { code: "", items: [] };
  }
  this.diagnosticsTimer = window.setTimeout(function () {
    self.diagnosticsTimer = null;
    const read = self.sink.read();
    if (!read || read.code !== code) return;
    const content = { code: code };
    self.query("diagnostics_request", content).then(
      function (reply) {
        if (!reply || reply.status !== "ok" || !reply.content) return;
        // The entry may have changed while the check was on its way. Its answer describes
        // the old text and must not repaint the bar (or report its issues).
        const now = self.sink.read();
        if (!now || now.code !== code) return;
        const content = reply.content;
        // Unfinished input has no diagnostics: the engine says so explicitly. Record the
        // text as checked, but do not add a warning or repaint the bar.
        if (content.status === "incomplete") {
          self.issues = { code: code, items: [] };
          return;
        }
        self.setIssues(code, content.items || []);
      },
      function () {
        // The next edit retries.
      }
    );
  }, DIAGNOSTICS_MS);
}

function setIssues(code, items) {
  const before = this.issues.code;
  const changed = before !== code || JSON.stringify(this.issues.items) !== JSON.stringify(items);
  this.issues = { code: code, items: items };
  if (!changed) return;
  this.keysSignature = ""; // force a repaint, the warning chip is part of the bar
  this.refreshBar();
  if (this.sheetOpen && this.sheetTab === "issues") this.renderSheet();
}

export function installDiagnostics(Assist) {
  Object.assign(Assist.prototype, {
    scheduleDiagnostics,
    setIssues,
  });
}
