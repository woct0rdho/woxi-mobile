// Running an entry and showing its output: the engine round trip, rendering the answer into
// the entry's output element, and attaching the plot controllers that make a picture live.
// The evaluation's output is part of the notebook, so it is persisted as it lands.

import * as WoxiAssist from "./assist.js";
import {
  activeEntry,
  addEntry,
  focusEntry,
  scrollEntryIntoView,
  showBusy,
  wireManipulate,
} from "./entries.js";
import { recordEdit } from "./history.js";
import { persist } from "./notebook-store.js";
import { latency as plotLatency } from "./plot-hooks.js";
import * as WoxiPlot from "./plot-interact.js";
import { build as buildPlotSamples } from "./plot-samples.js";
import * as WoxiRender from "./render-output.js";
import { runtime, state, toast } from "./runtime.js";
import { refreshAssist } from "./typing.js";

// Eval on an unfinished call closes the brackets instead of doing nothing: the
// engine says whether the entry is finished, and the closers become part of the
// text, so nothing is hidden from the user.
export async function closeRunningCall(entry) {
  if (!entry || !entry.dom || !runtime.engine) return;
  const text = entry.dom.input.value;
  if (!text.trim()) return;
  try {
    const reply = await runtime.engine.query("is_complete_request", { code: text });
    const status = reply?.content?.status;
    if (status !== "incomplete" || !entry.dom) return;
    const closers = WoxiAssist.closersFor(text, text.length);
    if (!closers) return;
    recordEdit(entry, "edit");
    entry.dom.input.value = text + closers;
    entry.input = entry.dom.input.value;
    entry.dom.input.dispatchEvent(new window.Event("input"));
  } catch {
    // An engine that cannot answer still gets the text as the user typed it.
  }
}

export async function evaluateEntry(entry) {
  await closeRunningCall(entry);
  // User symbols changed with the evaluation, so cached completion is stale.
  runtime.assist?.invalidate();
  return runEntry(entry);
}

export async function runEntry(entry) {
  if (!entry || !entry.dom) return;
  const input = entry.dom.input.value;
  entry.input = input;
  if (!input.trim()) {
    entry.dom.output.innerHTML = "";
    entry.output = "";
    showBusy(entry, false);
    return;
  }
  showBusy(entry, true);
  // Timing split for the diagnostics hook: how long the engine round trip takes
  // (bridge + interpreter + JSON) versus how long rendering it into the page
  // takes. Recorded per entry, reported by the `dump` hook.
  const t0 = window.performance.now();
  try {
    const json = await runtime.engine.evaluate(input);
    const t1 = window.performance.now();
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
    const t2 = window.performance.now();
    entry.engineMs = Math.round(t1 - t0);
    entry.renderMs = Math.round(t2 - t1);
    entry.bytesJson = json.length;
    // The evaluation's output is part of the notebook, not a transient view: a reload has to
    // restore the picture (and the plot's saved range/layout), so persist it now.
    persist();
    refreshAssist();
  } catch (err) {
    showBusy(entry, false);
    entry.dom.output.innerHTML =
      '<div class="woxi-out woxi-out-error">' +
      (err instanceof Error ? err.message : String(err)) +
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
}
