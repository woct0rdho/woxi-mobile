// The pure part of the notebook model: cell identity, the evaluated state, and the order in
// which a restored session is replayed. No DOM, bridge or engine objects are involved here,
// so the rules can be tested on their own.

const CELL_ID = /^[0-9A-Za-z_-]{1,64}$/;
const CELL_ID_ALPHABET = "0123456789abcdef";
const CELL_ID_LENGTH = 8;

// Jupyter's own new_code_cell uses eight random hex digits. The format allows 1-64
// alphanumerics, `-` and `_`, so an existing id is kept when it is valid.
function newCellId() {
  let out = "";
  for (let i = 0; i < CELL_ID_LENGTH; i++) {
    out += CELL_ID_ALPHABET.charAt(Math.floor(Math.random() * CELL_ID_ALPHABET.length));
  }
  return out;
}

function isValidCellId(value) {
  return typeof value === "string" && CELL_ID.test(value);
}

function uniqueCellId(value, used) {
  if (isValidCellId(value) && !used.has(value)) return value;
  let id = newCellId();
  while (used.has(id)) id = newCellId();
  return id;
}

// An entry is evaluated exactly when it has a persisted result: either an execution
// count (including an output-less evaluation) or at least one output item. The flag used
// to be stored separately and could disagree with the file. It is derived now.
function isEvaluated(entry) {
  if (!entry) return false;
  if (Number.isInteger(entry.executionCount)) return true;
  return Array.isArray(entry.items) && entry.items.length > 0;
}

// A replay must use the source that produced the displayed output, not an edit the user
// has not evaluated yet. This snapshot is session state. The file still stores the current
// source and cannot recover it after a restart.
function replayInput(entry) {
  const value = entry.evaluatedInput === undefined ? entry.input : entry.evaluatedInput;
  return String(value || "");
}

function replayEntries(entries) {
  const ranked = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!isEvaluated(entry) || !replayInput(entry).trim()) continue;
    ranked.push({
      entry: entry,
      count: Number.isInteger(entry.executionCount) ? entry.executionCount : null,
      index: i,
    });
  }
  ranked.sort(function (a, b) {
    if (a.count === null && b.count === null) return a.index - b.index;
    if (a.count === null) return 1;
    if (b.count === null) return -1;
    return a.count - b.count || a.index - b.index;
  });
  return ranked.map(function (row) {
    return row.entry;
  });
}

function executionCounts(entries) {
  let fallback = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry && Number.isInteger(entry.executionCount)) {
      fallback = Math.max(fallback, entry.executionCount);
    }
  }

  const counts = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!isEvaluated(entry)) {
      counts.push(null);
    } else if (Number.isInteger(entry.executionCount)) {
      counts.push(entry.executionCount);
    } else {
      fallback += 1;
      counts.push(fallback);
    }
  }
  return counts;
}

// The next user evaluation must be greater than every count the writer can produce. The
// writer gives an evaluated entry without a count the next number after the largest
// integer count, in entry order. This base includes those entries, so duplicating one or
// adding a new evaluated entry cannot collide with a number synthesized by the next save.
function executionCountBase(entries) {
  let base = 0;
  const counts = executionCounts(entries);
  for (let i = 0; i < counts.length; i += 1) {
    if (Number.isInteger(counts[i])) base = Math.max(base, counts[i]);
  }
  return base;
}

function nextExecutionCount(entries) {
  return executionCountBase(entries) + 1;
}

export {
  executionCountBase,
  executionCounts,
  isEvaluated,
  isValidCellId,
  newCellId,
  nextExecutionCount,
  replayEntries,
  replayInput,
  uniqueCellId,
};
