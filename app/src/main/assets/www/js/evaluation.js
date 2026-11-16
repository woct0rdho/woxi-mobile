// Running an entry and showing its output: the engine round trip, rendering the answer into
// the entry's output element, and attaching the plot controllers that make a picture live.
// The output belongs to the notebook (the .ipynb save keeps it). The local restore keeps the
// input and re-evaluates it.

import { closersFor } from "./assist-scan.js";
import {
  activeEntry,
  addEntry,
  focusEntry,
  scrollEntryIntoView,
  showBusy,
  wireManipulate,
} from "./entries.js";
import { persist } from "./notebook-store.js";
import { latency as plotLatency } from "./plot-hooks.js";
import * as WoxiPlot from "./plot-interact.js";
import { build as buildPlotSamples } from "./plot-samples.js";
import { refreshAssist } from "./refresh.js";
import * as WoxiRender from "./render-output.js";
import { runtime, state, toast } from "./runtime.js";
import { replaceInEntry } from "./typing.js";

// Eval on an unfinished call closes the brackets instead of doing nothing: the
// engine says whether the entry is finished, and the closers become part of the
// text, so nothing is hidden from the user.
export async function closeRunningCall(entry) {
  if (!entry || !entry.dom || !runtime.engine) return;
  const text = entry.dom.input.value;
  if (!text.trim()) return;
  const reply = await runtime.engine.query("is_complete_request", { code: text }).catch(() => null);
  const status = reply?.content?.status;
  if (status !== "incomplete") return;
  const closers = closersFor(text, text.length);
  if (!closers) return;
  replaceInEntry(entry, text.length, text.length, closers, closers.length, "edit");
}

export async function evaluateEntry(entry) {
  await closeRunningCall(entry);
  // User symbols changed with the evaluation, so cached completion is stale.
  runtime.assist?.invalidate();
  return runEntry(entry);
}

export function clearOutput(entry) {
  if (!entry || !entry.dom) return;
  WoxiPlot.release(WoxiPlot.detach(entry.dom.output), entry.dom.output);
  entry.dom.output.innerHTML = "";
  entry.output = "";
  delete entry.perf;
}

export async function runEntry(entry) {
  if (!entry || !entry.dom) return;
  const input = entry.dom.input.value;
  entry.input = input;
  if (!input.trim()) {
    clearOutput(entry);
    showBusy(entry, false);
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
    const json = await runtime.engine.evaluate(input);
    const t1 = trackPerf ? window.performance.now() : 0;
    showBusy(entry, false);
    // Replacing the output drops the controllers of the previous picture, and with
    // them its handle (the new evaluation registers a fresh one).
    WoxiPlot.release(WoxiPlot.detach(entry.dom.output), entry.dom.output);
    const rendered = WoxiRender.renderItems(json);
    entry.dom.output.innerHTML = rendered.html;
    wireManipulate(entry.dom.output);
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
    // The evaluation's output is part of the notebook, not a transient view: a reload has to
    // restore the picture (and the plot's saved range/layout), so persist it now.
    persist();
    refreshAssist();
  } catch (err) {
    showBusy(entry, false);
    entry.dom.output.innerHTML =
      '<div class="woxi-out woxi-out-error">' +
      WoxiRender.escapeHtml(err instanceof Error ? err.message : String(err)) +
      "</div>";
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
      // A picture at rest is the notebook's new range. Persist it when the notify is debounced.
      persist();
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
  state.evaluating = true;
  // A fresh session: definitions from the previous run must not leak in.
  try {
    await runtime.engine.reset();
    for (const entry of state.entries) {
      await evaluateEntry(entry);
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  } finally {
    state.evaluating = false;
  }
}

export async function submitActive() {
  if (!runtime.engine || state.evaluating) return;
  state.evaluating = true;
  try {
    const entry = activeEntry();
    if (!entry) return;
    const wasLast = state.entries[state.entries.length - 1] === entry;
    await evaluateEntry(entry);
    if (wasLast) {
      const next = addEntry("", {});
      focusEntry(next);
    } else {
      const index = state.entries.indexOf(entry);
      const following = state.entries[index + 1];
      if (following) focusEntry(following);
    }
    scrollEntryIntoView(entry);
  } finally {
    state.evaluating = false;
  }
}
