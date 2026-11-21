// Interpreter session lifecycle.
//
// The notebook file is restored without evaluating it. The engine session is therefore
// either:
// - empty and current (`sessionRestored`).
// - a replay in progress.
// - invalidated because another notebook replaced the visible one.
//
// All resets and replays are serialized through one promise chain. That gives two
// invariants:
// - two callers that need the same replay share its promise.
// - a operation for a replaced notebook can never mark the replacement restored, and
//   the replacement's reset waits until the old operation has left the engine.
//
// The generation counter, rather than a boolean "replaying" flag, is what makes the second
// invariant hold across a notebook switch.

import { replayEntries, replayInput } from "./notebook-model.js";
import { runtime, state, toast } from "./runtime.js";

let generation = 0;
let transition = Promise.resolve();
let pending = null;
let pendingGeneration = 0;

function enqueue(operation) {
  const next = transition.then(operation, operation);
  // The chain must continue after a failed operation. The caller gets the rejection.
  transition = next.catch(function () {});
  return next;
}

function track(task, taskGeneration, message) {
  const tracked = task.catch(function (err) {
    if (taskGeneration === generation) {
      toast(message + ": " + (err instanceof Error ? err.message : String(err)));
    }
    throw err;
  });
  pending = tracked;
  pendingGeneration = taskGeneration;
  tracked.then(
    function () {
      if (pending === tracked) {
        pending = null;
        pendingGeneration = 0;
      }
    },
    function () {
      if (pending === tracked) {
        pending = null;
        pendingGeneration = 0;
      }
    }
  );
  return tracked;
}

// Called when a file is installed. The engine still contains the previous notebook's
// definitions, so the next evaluation or manipulation must reset and replay the current
// entries before it can use the engine.
export function invalidateSession() {
  generation += 1;
  state.sessionRestored = false;
  pending = null;
  pendingGeneration = 0;
}

// A brand-new empty notebook has no entries to replay. Reset the engine and declare the
// session current only after the reset completes. Callers may ignore the returned promise.
// The next ensureSession() waits for it.
export function startFreshSession() {
  generation += 1;
  const taskGeneration = generation;
  state.sessionRestored = false;
  pending = null;
  pendingGeneration = 0;
  const task = enqueue(async function () {
    if (!runtime.engine) {
      if (taskGeneration === generation) state.sessionRestored = true;
      return;
    }
    await runtime.engine.reset();
    if (taskGeneration === generation) state.sessionRestored = true;
  });
  return track(task, taskGeneration, "Could not reset the session");
}

export function ensureSession() {
  if (state.sessionRestored) return Promise.resolve();
  if (!runtime.engine) return Promise.resolve();
  if (pending && pendingGeneration === generation) return pending;

  const taskGeneration = generation;
  const task = enqueue(async function () {
    if (!runtime.engine) return;
    await runtime.engine.reset();
    if (taskGeneration !== generation) return;

    const entries = replayEntries(state.entries);
    for (let i = 0; i < entries.length; i += 1) {
      if (taskGeneration !== generation) return;
      await runtime.engine.evaluate(replayInput(entries[i]));
    }
    if (taskGeneration === generation) state.sessionRestored = true;
  });
  return track(task, taskGeneration, "Could not restore the session");
}
