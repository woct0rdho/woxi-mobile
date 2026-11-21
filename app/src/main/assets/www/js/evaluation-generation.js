// Generation of the current user evaluation. Replacing the notebook invalidates in-flight
// evaluations so an old evaluateAll loop cannot quietly submit old code to the new session.
// This is separate from the interpreter-session generation in session.js because evaluation
// requests and reset/replay requests have different cancellation points.

let generation = 0;

export function currentEvaluation() {
  return generation;
}

export function isCurrentEvaluation(value) {
  return value === generation;
}

export function invalidateEvaluations() {
  generation += 1;
}

// Entry-level invalidation. This covers structural changes that the notebook generation
// does not see: deleting or clearing an entry while its evaluation is still in flight.
// The token lives on the entry, so a result cannot be written into a detached DOM node.
export function invalidateEntry(entry) {
  if (!entry) return;
  entry.evalToken = (Number.isInteger(entry.evalToken) ? entry.evalToken : 0) + 1;
}

export function isCurrentEntry(entry, token) {
  return !!entry && entry.evalToken === token;
}
