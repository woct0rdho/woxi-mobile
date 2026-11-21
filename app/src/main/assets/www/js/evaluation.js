// Running an entry and showing its output: the engine round trip, rendering the answer into
// the entry's output element, and attaching the plot controllers that make a picture live.
// The output belongs to the notebook (the .ipynb save keeps it). A restored notebook shows
// its saved outputs without evaluating. The interpreter session is rebuilt on first use.

import { closersFor } from "./assist-scan.js";
import {
  activeEntry,
  addEntry,
  focusEntry,
  scrollEntryIntoView,
  showBusy,
  wireManipulate,
} from "./entries.js";
import {
  currentEvaluation,
  invalidateEntry,
  isCurrentEntry,
  isCurrentEvaluation,
} from "./evaluation-generation.js";
import { nextExecutionCount } from "./notebook-model.js";
import { persist } from "./notebook-store.js";
import { latency as plotLatency } from "./plot-hooks.js";
import * as WoxiPlot from "./plot-interact.js";
import { build as buildPlotSamples } from "./plot-samples.js";
import { refreshAssist } from "./refresh.js";
import * as WoxiRender from "./render-output.js";
import { runtime, state, toast } from "./runtime.js";
import { ensureSession, startFreshSession } from "./session.js";
import { replaceInEntry } from "./typing.js";

// The saved outputs came from an older process. Rebuild the interpreter's definitions
// before the first evaluation or Manipulate interaction, without touching the displayed
// outputs. This is the cost we move from app launch to the first action that needs it.

export async function closeRunningCall(entry, evalToken) {
  if (!entry || !entry.dom || !runtime.engine) return;
  const generation = currentEvaluation();
  const text = entry.dom.input.value;
  if (!text.trim()) return;
  const reply = await runtime.engine.query("is_complete_request", { code: text }).catch(() => null);
  if (!isCurrentEvaluation(generation) || !isCurrentEntry(entry, evalToken)) return;
  const status = reply?.content?.status;
  if (status !== "incomplete") return;
  const closers = closersFor(text, text.length);
  if (!closers) return;
  if (!isCurrentEntry(entry, evalToken)) return;
  replaceInEntry(entry, text.length, text.length, closers, closers.length, "edit");
}

export async function evaluateEntry(entry) {
  const generation = currentEvaluation();
  const evalToken = entry ? entry.evalToken : undefined;
  await closeRunningCall(entry, evalToken);
  if (
    !isCurrentEvaluation(generation) ||
    !isCurrentEntry(entry, evalToken) ||
    !state.entries.includes(entry)
  ) {
    return;
  }
  // User symbols changed with the evaluation, so cached completion is stale.
  runtime.assist?.invalidate();
  return runEntry(entry);
}

function detachPlotControllers(entry) {
  if (!entry || !entry.dom) return;
  WoxiPlot.release(WoxiPlot.detach(entry.dom.output), entry.dom.output);
}

export function clearOutput(entry) {
  if (!entry || !entry.dom) return;
  invalidateEntry(entry);
  detachPlotControllers(entry);
  entry.dom.output.innerHTML = "";
  entry.output = "";
  entry.items = null;
  entry.evaluatedInput = null;
  entry.executionCount = null;
  entry.widgets = [];
  delete entry.perf;
}

export async function runEntry(entry) {
  if (!entry || !entry.dom) return;
  // Starting a new run invalidates an older result for the same entry, even when the
  // notebook itself has not changed. A deletion or clear does the same through
  // invalidateEntry().
  invalidateEntry(entry);
  const generation = currentEvaluation();
  const evalToken = entry.evalToken;
  const current = function () {
    return (
      isCurrentEvaluation(generation) &&
      isCurrentEntry(entry, evalToken) &&
      state.entries.includes(entry)
    );
  };
  const input = entry.dom.input.value;
  entry.input = input;
  if (!input.trim()) {
    if (!current()) return;
    clearOutput(entry);
    showBusy(entry, false);
    persist();
    return;
  }
  showBusy(entry, true);
  delete entry.perf;
  // Timing split for the diagnostics hook: how long the engine round trip takes
  // (bridge + interpreter + JSON) versus how long rendering it into the page
  // takes. Recorded per entry only in the automation build, where the `dump` hook
  // reads it.
  const trackPerf = runtime.automation;
  const t0 = trackPerf ? window.performance.now() : 0;
  try {
    await ensureSession();
    if (!current()) {
      showBusy(entry, false);
      return;
    }
    const json = await runtime.engine.evaluate(input);
    if (!current()) {
      showBusy(entry, false);
      return;
    }
    const t1 = trackPerf ? window.performance.now() : 0;
    showBusy(entry, false);
    // Compute the next count before replacing this entry's old outputs. Once the new
    // items are installed, executionCountBase() would count them as an evaluated entry
    // with a null count and skip a number.
    const executionCount = nextExecutionCount(state.entries);
    // Replacing the output drops the controllers of the previous picture, and with
    // them its handle (the new evaluation registers a fresh one).
    detachPlotControllers(entry);
    const rendered = WoxiRender.renderItems(json);
    // The engine items are the notebook's outputs (the `.ipynb` export serializes them).
    // The rendered markup below is the live view. An unreadable answer keeps neither.
    entry.items = rendered.items && rendered.items.length ? rendered.items : null;
    entry.evaluatedInput = input;
    entry.executionCount = executionCount;
    entry.widgets = [];
    entry.dom.output.innerHTML = rendered.html;
    wireManipulate(entry.dom.output, entry);
    // Trim the empty margins Woxi's plot layout reserves (see render-output.js).
    // Do it before the markup is stored, so a later re-render keeps the trim.
    WoxiRender.fitGraphics(entry.dom.output);
    // Plots that carry a view handle become draggable and pinchable, and ask for a
    // fresh picture when the view moves (plot-interact.js). Their samples come from
    // this answer, so the first gesture draws from them.
    attachPlots(entry, rendered.items);
    entry.output = WoxiPlot.markupOf(entry.dom.output);
    if (trackPerf) {
      const t2 = window.performance.now();
      entry.perf = {
        engineMs: Math.round(t1 - t0),
        renderMs: Math.round(t2 - t1),
        bytesJson: json.length,
      };
    } else {
      delete entry.perf;
    }
    persist();
    refreshAssist();
  } catch (err) {
    showBusy(entry, false);
    if (!current()) return;
    const message = err instanceof Error ? err.message : String(err);
    const executionCount = nextExecutionCount(state.entries);
    detachPlotControllers(entry);
    entry.items = [{ type: "error", text: message }];
    entry.evaluatedInput = input;
    entry.executionCount = executionCount;
    entry.widgets = [];
    entry.dom.output.innerHTML =
      '<div class="woxi-out woxi-out-error">' + WoxiRender.escapeHtml(message) + "</div>";
    entry.output = WoxiPlot.markupOf(entry.dom.output);
    persist();
  }
}

export function attachPlots(entry, items, previous) {
  if (!entry || !entry.dom) return;
  // The samples of each plot in this answer, keyed by handle: a controller starts
  // from them instead of asking for what the engine just sent.
  const seeds = [];
  items = items ?? [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item?.plot) {
      // The controller starts from what this answer already produced: the decoded samples, the
      // scene and the first layout. A later rebuild hands the same snapshot over (`seedsOf`),
      // so both paths give `wire` one shape.
      const data = item.data;
      seeds.push({
        id: item.plot.id,
        scene: item.plot.scene,
        prepared: data ? buildPlotSamples(data) : null,
        log: data && typeof data.lx === "boolean" ? { x: data.lx, y: !!data.ly } : null,
        coverage: item.plot.d ? { d: item.plot.d, dy: item.plot.dy || null } : null,
      });
    }
  }
  // A notebook rebuild has no answer to seed from: it hands over what the plots on the old
  // elements were last given, so they come back drawn instead of as still pictures.
  previous = previous ?? [];
  for (let k = 0; k < previous.length; k += 1) seeds.push(previous[k]);
  WoxiPlot.attach(
    entry.dom.output,
    requestPlot,
    function () {
      entry.output = WoxiPlot.markupOf(entry.dom.output);
      // The live view is session state. The notebook keeps the evaluation's SVG. A pan
      // does not rewrite the saved picture until the entry is evaluated again.
    },
    seeds
  );
}

export async function requestPlot(msgType, content) {
  const answer = runtime.engine.plot(msgType, content);
  // The harness can make plot answers arrive late (`plotlatency`), to exercise what happens
  // when a gesture starts while an earlier frame is still on its way.
  const delay = plotLatency();
  if (!delay) return answer;
  await new Promise((resolve) => window.setTimeout(resolve, delay));
  return answer;
}

export async function evaluateAll() {
  if (!runtime.engine || state.evaluating) return;
  const generation = currentEvaluation();
  state.evaluating = true;
  // A fresh session: definitions from the previous run must not leak in.
  try {
    await startFreshSession();
    if (!isCurrentEvaluation(generation)) return;
    for (const entry of state.entries) {
      if (!isCurrentEvaluation(generation)) return;
      await evaluateEntry(entry);
    }
  } catch (err) {
    if (isCurrentEvaluation(generation)) toast(err instanceof Error ? err.message : String(err));
  } finally {
    if (isCurrentEvaluation(generation)) state.evaluating = false;
  }
}

export async function submitActive() {
  if (!runtime.engine || state.evaluating) return;
  const generation = currentEvaluation();
  state.evaluating = true;
  try {
    const entry = activeEntry();
    if (!entry) return;
    const wasLast = state.entries[state.entries.length - 1] === entry;
    await evaluateEntry(entry);
    if (!isCurrentEvaluation(generation)) return;
    if (wasLast) {
      const next = addEntry("", {});
      focusEntry(next);
      persist();
    } else {
      const index = state.entries.indexOf(entry);
      const following = state.entries[index + 1];
      if (following) focusEntry(following);
    }
    scrollEntryIntoView(entry);
  } finally {
    if (isCurrentEvaluation(generation)) state.evaluating = false;
  }
}
