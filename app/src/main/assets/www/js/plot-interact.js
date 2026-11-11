// Interactive 2D plots: drag to pan. Two fingers pan and zoom. The line through the two fingers
// when the pinch starts selects x-only, y-only or uniform zoom, and the midpoint moves with the
// fingers. One mechanism for every interactive plot.
//
// A plot carries a handle, the range its picture shows (`data-woxi-plot`) and a scene: the
// frame, the data rectangle, the tick values with the labels the renderer printed, value lines
// and texts, all as numbers in the picture's own units (`engine/src/plot/scene/`). The frontend
// draws that scene and the samples on one canvas (`plot-layer.js`), at rest and while a finger is
// down. The markup the engine also sends is inserted hidden, because it is what the notebook
// saves. A plot whose picture has an element the scene cannot express is not registered at all:
// it stays a still picture, and there is no second interaction path.
//
// A gesture turns into a new range. The engine is asked for a scene at the range the finger
// reached, as fast as it answers: one request is in flight at a time and at most one goes out per
// display frame. A gesture frame asks for the scene only (`"picture": false`). The markup is
// brought back at rest, so what the notebook stores is a picture of the range the user left.
//
// The curve does not wait for those answers. The engine also sends the sampled points (base64
// `u16` pairs on a shared grid, see `plot_layer()` in engine/src/plot/frame.rs) and the gesture
// draws them on the canvas at every display frame, clipped where the picture clips its own curves.
// The samples reach half a view past the view, so a pan brings the curve in without a round trip.
// A re-sample (`plot_refine`) brings fresh points and no scene: the canvas redraws the curve and
// the labels, whose values did not change, stay as they are.
//
// Finger pixels become data units through the same mapping the canvas draws with, so a pixel of
// finger movement is a pixel of curve movement. The map is read for the view in hand (the canvas
// holds the box and the scale). Neither the frame nor the card can move under the gesture.
//
// Messages follow Jupyter's shape: a `msg_type` with a `content` object, and a reply carrying
// `status` (`ok`/`error`, the latter with `ename`/`evalue`). `plot_release` frees the engine's
// handle when its controller is gone.

import {
  movedShare,
  needsDensify,
  panViewFrom,
  pinchAnchor,
  pinchMode,
  positiveView,
  refineKind,
  refinePad,
  SPEED_EMA,
  viewBasis,
  zoomAxesViewFrom,
} from "./plot-gesture.js";
import * as WoxiPlotLayer from "./plot-layer.js";
import { build } from "./plot-samples.js";
import * as WoxiRender from "./render-output.js";

const STATS_SAMPLES = 240; // frame timings kept per plot for `plotperf`
// A round trip assumed before one has been measured, for the re-sample margin.
const DEFAULT_ROUND_TRIP_MS = 150;
// The percentile of the measured round trips the margin is sized for.
const ROUND_TRIP_PERCENTILE = 0.9;
// A repaint whose scale differs from the previous one by more than this share moved everything
// the canvas drew: the card was resized (legitimate) or the SVG was not pinned (a bug).
const SCALE_JUMP_SHARE = 0.005;
// One record per plot element: the view its markup shows (parsed from the attribute, cached
// against the string it came from), the controller that owns its listeners, and the counters.
const sessions = new WeakMap();

function sessionOf(container) {
  let session = sessions.get(container);
  if (!session) {
    session = { raw: null, view: null, controller: null, counters: null };
    sessions.set(container, session);
  }
  return session;
}

function controllerOf(container) {
  const session = container && sessions.get(container);
  return session ? session.controller : null;
}

// The attribute is the markup's own record of the view, and it survives a notebook rebuild.
// `setView` is the only writer. The cache is the string it wrote.
function viewOf(container) {
  const session = sessionOf(container);
  const raw = container.getAttribute("data-woxi-plot") || "";
  if (session.raw !== raw) {
    session.raw = raw;
    try {
      session.view = JSON.parse(raw || "null");
    } catch (err) {
      session.view = null;
    }
  }
  return session.view;
}

function setView(container, view) {
  const session = sessionOf(container);
  const summary = WoxiRender.plotSummary(view);
  session.view = summary;
  session.raw = JSON.stringify(summary);
  container.setAttribute("data-woxi-plot", session.raw);
}

function now() {
  return window.performance.now();
}

// `seeds` carries what came with the pictures already on screen (the samples and the scene), so
// the first gesture starts from them instead of asking for them again.
function attach(root, send, onFrame, seeds) {
  const byId = {};
  for (let i = 0; seeds && i < seeds.length; i += 1) byId[seeds[i].id] = seeds[i];
  const plots = root.querySelectorAll(".woxi-plot");
  for (let j = 0; j < plots.length; j += 1) {
    const view = viewOf(plots[j]);
    // A plot without a seed is restored markup from an earlier app session: its handle belongs
    // to an engine that no longer exists, so its first request would be `ExpiredHandle` and the
    // controller would be disposed straight away. The app re-evaluates the document at boot and
    // attaches the fresh picture. Until then the saved picture is shown as it is.
    if (!view || !byId[view.id]) continue;
    wire(plots[j], send, onFrame, byId[view.id]);
  }
}

// The samples and the scene each plot on screen was last given, so a rebuild of the notebook
// (an entry added, deleted or undone) can hand them to the new elements instead of dropping
// every plot back to a still picture. Only a live controller has them: a restored picture that
// was never wired must not become a controller with no scene.
function seedsOf(root) {
  const out = [];
  const plots = root && root.querySelectorAll ? root.querySelectorAll(".woxi-plot") : [];
  for (let i = 0; i < plots.length; i += 1) {
    const session = sessions.get(plots[i]);
    const controller = session && session.controller;
    if (!controller) continue;
    const seed = controller.seed();
    if (seed) out.push(seed);
  }
  return out;
}

// The markup of an output that is worth storing: the picture, not the transient canvas. The
// canvas has no pixels once serialized and the SVG under it is hidden while it is live, so a
// rebuild from the raw innerHTML would restore a blank card. The stored SVG keeps the layout's
// shape (`pinBox`), which is the card's size.
function markupOf(root) {
  if (!root || !root.cloneNode) return root ? root.innerHTML : "";
  const copy = root.cloneNode(true);
  const canvases = copy.querySelectorAll ? copy.querySelectorAll("canvas.woxi-plot-layer") : [];
  for (let i = 0; i < canvases.length; i += 1) {
    if (canvases[i].parentNode) canvases[i].parentNode.removeChild(canvases[i]);
  }
  const svgs = copy.querySelectorAll ? copy.querySelectorAll("svg") : [];
  for (let j = 0; j < svgs.length; j += 1) {
    if (svgs[j].style) svgs[j].style.visibility = "";
  }
  return copy.innerHTML;
}

// One plot message. The bridge answers with a promise (and rejects when it is gone), so there
// is nothing to catch here: a synchronous throw would be a bug worth seeing.
function noop() {}

function fire(send, msgType, content) {
  const answer = send(msgType, content);
  if (answer && answer.catch) answer.catch(noop);
}

function wire(container, send, onFrame, seed) {
  // A controller reference, not an attribute: a notebook rebuild recreates the elements from
  // HTML, and an attribute would claim they are still wired when their listeners are gone.
  // Every wired plot has a seed with a scene: it is the evaluation (or the rebuild) that
  // produced its samples and scene. A plot without one is restored markup from an earlier
  // session (see `attach`), and is left as a still picture.
  if (!seed || !seed.scene || sessionOf(container).controller) return;

  // Pointer ids in the order the fingers landed.
  const pointers = new Map();
  let pinch = null; // { startDistance, view, fx, fy }
  // While a finger is down the gesture keeps its own range: every move is applied to that, not
  // to what the picture currently shows, so requests still in flight cannot make a drag lose
  // distance.
  let gestureView = null;
  // The range of the newest scene the canvas draws, and the range of the newest picture asked
  // for. They differ while a gesture is running: a gesture frame carries no markup. The saved
  // range is the element's `data-woxi-plot` attribute and is read when it is needed.
  let sceneView = null;
  let wanted = null;
  // The controller's life: `live`, `stale` (the engine no longer knows the handle: keep panning
  // the cached scene and samples locally) or `disposed` (the node is gone: nothing may run).
  let status = "live";
  function isLive() {
    return status === "live";
  }
  // One request at a time: `inFlight` is the whole of the ordering.
  let queued = null; // { kind, view, density }
  let inFlight = false;
  // A pump already waiting for the next display frame.
  let pumpQueued = false;
  // The range whose last request failed (kind `view` or `refine`), so a range that cannot be
  // served is not asked for again on every frame. A successful answer clears it.
  let refused = null;
  // The level the current samples were densified to.
  let density = 0;
  // A coverage re-sample has completed since this controller was wired. Until it has, the first
  // coverage re-sample gets the large first-interaction margin.
  let covered = false;
  // The view span of each axis at the last re-sample: a zoom-in past ZOOM_IN of it asks for a
  // denser sample. `null` until the first picture is known.
  let basis = null;
  // The finger's speed through the view, in views per second, for the margin calculation.
  let gestureSpeed = 0;
  let lastMoveAt = 0;
  // A non-view request (a re-sample) has been sent since the last view: the next view gets one
  // turn before another re-sample, so the ticks cannot starve.
  let refinementSinceView = false;

  // Which axes are logarithmic, from the snapshot the seed was built with: the gesture maths
  // needs it even when no canvas is drawing.
  let logAxes = seed.log || { x: false, y: false };
  // The newest scene and its samples. The first scene's layout is kept with the seed: every
  // later picture is drawn in the first one's coordinates, and a rebuild must not resize the
  // card because the newest picture's labels happen to be wider.
  let scene = seed.scene;
  let layout = seed.layout || WoxiPlotLayer.layoutOf(scene);
  if (layout && scene) scene = WoxiPlotLayer.normalize(scene, layout);
  let prepared = seed.prepared || null;
  // The range in `data-woxi-plot` is the saved picture's. A seed's scene is that picture, so the
  // range is both what the canvas drew and what was persisted: a gesture starts from a settled
  // state. A stored view that a log axis cannot draw (an older document) is repaired before the
  // first paint, not only at the first touch.
  let initialView = viewOf(container);
  if (initialView) {
    const repaired = positiveView(initialView, logAxes);
    if (rangeDiffers(initialView, repaired)) {
      setView(container, repaired);
      initialView = viewOf(container);
    }
    if (scene) {
      sceneView = initialView;
      wanted = initialView;
    }
  }
  let layer = null;
  // The range the samples cover, from the newest reply that said so (or the seed's). Only used
  // to decide when a re-sample is due.
  let coverage =
    seed.coverage && seed.coverage.d ? { d: seed.coverage.d, dy: seed.coverage.dy || null } : null;
  if (initialView) basis = viewBasis(initialView, logAxes);

  function currentView() {
    return gestureView || wanted || viewOf(container);
  }

  function stats() {
    const session = sessionOf(container);
    if (!session.counters) {
      session.counters = {
        frames: 0,
        draws: 0,
        paintFails: 0,
        sends: 0,
        failures: 0,
        lastError: "",
        lastFailed: "",
        views: 0,
        refines: 0,
        checks: 0,
        checkAsk: 0,
        checkNoNeed: 0,
        refinePad: null,
        refineReason: null,
        resizes: 0,
        lastBox: null,
        lastScale: null,
        roundTrip: [],
        bytes: [],
        paint: [],
      };
    }
    return session.counters;
  }

  function record(list, value) {
    list.push(value);
    if (list.length > STATS_SAMPLES) list.shift();
  }

  // What the answer weighed: the picture and its points. The scene is not measured: it was
  // parsed from the reply, and serializing it again would cost a copy per gesture frame.
  function weightOf(item) {
    let size = item.svg ? item.svg.length : 0;
    const series = item.data && item.data.s;
    if (series) {
      for (let i = 0; i < series.length; i += 1) size += (series[i].p || "").length;
    }
    return size;
  }

  // The canvas: one renderer, mounted as soon as there is a scene and a box to draw it in.
  function mountLayer(box) {
    if (!scene || !box) return;
    layer = WoxiPlotLayer.mount(container, scene, prepared, logAxes, box, requestDraw);
    requestDraw();
  }

  function dropLayer() {
    if (!layer) return;
    WoxiPlotLayer.unmount(layer);
    layer = null;
  }

  // A repaint is one canvas draw. Several updates in a frame collapse into one.
  let drawQueued = false;

  function requestDraw() {
    if (!layer || drawQueued) return;
    drawQueued = true;
    const run = function () {
      drawQueued = false;
      drawLayer();
    };
    window.requestAnimationFrame(run);
  }

  function drawLayer() {
    if (!layer) return;
    const counters = stats();
    counters.draws += 1;
    const view = currentView();
    const started = now();
    const drawn = WoxiPlotLayer.paint(layer, view);
    record(counters.paint, now() - started);
    if (!drawn) {
      counters.paintFails += 1;
      return;
    }
    // A repaint at a different scale resizes everything the canvas drew: the card was resized,
    // or the SVG was not pinned. The box itself is set once at mount and never changes. It must
    // not happen during a gesture. `plotperf` counts it so a recording is not the only witness.
    const lastScale = counters.lastScale;
    if (typeof lastScale === "number" && Math.abs(lastScale - layer.scale) > SCALE_JUMP_SHARE) {
      counters.resizes += 1;
    }
    counters.lastBox = [layer.box.width, layer.box.height];
    counters.lastScale = layer.scale;
  }

  // The data-to-screen mapping the drag and the pinch convert pixels with. The canvas holds the
  // box and the scene, so this is one call, not a measurement.
  function mappingOf(view) {
    return layer
      ? WoxiPlotLayer.dataMapping(view, layer.scene, layer.box, layer.scale, logAxes)
      : null;
  }

  function beginGesture() {
    gestureView = positiveView(currentView(), logAxes);
    gestureSpeed = 0;
    lastMoveAt = now();
    requestDraw();
  }

  // The gesture is over: from here on the scene is what the canvas shows, and `reconcile` asks
  // for whatever the plot still owes - a scene at the finger's range, and the markup that saves
  // it.
  function endGesture() {
    gestureView = null;
    reconcile();
  }

  function beginPinch() {
    if (pointers.size < 2) {
      pinch = null;
      return;
    }
    const fingers = Array.from(pointers.values());
    const a = fingers[0];
    const b = fingers[1];
    const view = currentView();
    const mapping = mappingOf(view);
    if (!mapping || !view) {
      pinch = null;
      return;
    }
    const startDistance = Math.hypot(a.x - b.x, a.y - b.y);
    if (!(startDistance > 0)) {
      pinch = null;
      return;
    }
    const anchor = pinchAnchor(view, mapping, a, b, container.getBoundingClientRect(), logAxes);
    pinch = {
      startDistance: startDistance,
      mode: pinchMode(a, b),
      view: view,
      fx: anchor.fx,
      fy: anchor.fy,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  }

  // Pointer capture. The DOM throws for a pointer that is already gone, which is the one case
  // worth ignoring.
  function capture(event, on) {
    const method = on ? "setPointerCapture" : "releasePointerCapture";
    if (!container[method]) return;
    try {
      container[method](event.pointerId);
    } catch (err) {
      // Already released.
    }
  }

  function onDown(event) {
    const view = viewOf(container);
    // A stale plot can still be panned locally: its canvas keeps the cached samples. Only the
    // engine requests stop (see `enqueue`).
    if (!view || status === "disposed") return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      beginGesture();
    } else if (pointers.size === 2) {
      beginPinch();
    }
    capture(event, true);
  }

  function onMove(event) {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();
    const previousX = pointer.x;
    const previousY = pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    let next = null;
    const previousView = currentView();
    if (pinch && pointers.size >= 2) {
      const fingers = Array.from(pointers.values());
      const midX = (fingers[0].x + fingers[1].x) / 2;
      const midY = (fingers[0].y + fingers[1].y) / 2;
      const distance = Math.hypot(fingers[0].x - fingers[1].x, fingers[0].y - fingers[1].y);
      // The spread is the distance between the fingers, which ignores a twist at constant gap.
      // The start line chose the axis: an x pinch scales only x, a y pinch only y, and a uniform
      // pinch scales both by the same factor.
      const factor = distance / pinch.startDistance;
      const factorX = pinch.mode === "y" ? 1 : factor;
      const factorY = pinch.mode === "x" ? 1 : factor;
      // Scale about the midpoint the pinch started on, then move that midpoint with the fingers.
      // Both axes pan. Only an axis pinch leaves the other axis's scale alone.
      const zoomed = zoomAxesViewFrom(pinch.view, factorX, factorY, pinch.fx, pinch.fy, logAxes);
      if (zoomed) {
        next = panViewFrom(
          zoomed,
          midX - pinch.midX,
          midY - pinch.midY,
          mappingOf(zoomed),
          logAxes
        );
      }
    } else {
      next = panViewFrom(
        previousView,
        pointer.x - previousX,
        pointer.y - previousY,
        mappingOf(previousView),
        logAxes
      );
    }
    if (!next) return;
    // The finger's speed through the view, in views per second: how much of a view the move
    // crossed divided by how long it took. A pinch crosses by the change of its span. Both axes
    // are measured in the drawing space (decades on a log axis).
    const at = now();
    const seconds = (at - lastMoveAt) / 1000;
    if (seconds > 0 && previousView) {
      const share = Math.max(
        movedShare(previousView.x, next.x, logAxes.x),
        movedShare(previousView.y, next.y, logAxes.y)
      );
      const speed = share / seconds;
      gestureSpeed = gestureSpeed > 0 ? SPEED_EMA * gestureSpeed + (1 - SPEED_EMA) * speed : speed;
    }
    lastMoveAt = at;
    // A move of no pixels is not a new range: asking for it costs a round trip for nothing.
    const moved = rangeDiffers(previousView, next);
    gestureView = next;
    requestDraw();
    if (moved) enqueue("view", next);
  }

  function onUp(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (!pointers.size) endGesture();
    if (pointers.size >= 2) beginPinch();
    else pinch = null;
    capture(event, false);
  }

  // Stops the controller without telling the engine anything. `detach` collects the handles so
  // the caller can release them after the replacement has attached.
  function dispose() {
    if (status === "disposed") return;
    status = "disposed";
    queued = null;
    pumpQueued = false;
    dropLayer();
    sessionOf(container).controller = null;
    container.removeEventListener("pointerdown", onDown);
    container.removeEventListener("pointermove", onMove);
    container.removeEventListener("pointerup", onUp);
    container.removeEventListener("pointercancel", onUp);
  }

  // What the gesture knows about the samples on hand: the capability flags the markup carries,
  // and the coverage the newest reply reported.
  function samplesOnHand() {
    const shown = viewOf(container);
    return {
      s: !!(shown && shown.s),
      dn: !!(shown && shown.dn),
      d: coverage ? coverage.d : null,
      dy: coverage ? coverage.dy : null,
    };
  }

  function rangeDiffers(shown, view) {
    if (!shown || !view || !shown.x || !shown.y) return true;
    return (
      shown.x[0] !== view.x[0] ||
      shown.x[1] !== view.x[1] ||
      shown.y[0] !== view.y[0] ||
      shown.y[1] !== view.y[1]
    );
  }

  function dueRefine() {
    if (status === "disposed") return null;
    const view = currentView();
    if (!view) return null;
    if (refused && refused.kind !== "view" && !rangeDiffers(refused.view, view)) return null;
    const samples = samplesOnHand();
    if (needsDensify(view, samples, density)) {
      return { kind: "densify", view: view, density: density + 1 };
    }
    const kind = refineKind(view, samples, logAxes, basis);
    if (!kind) return null;
    return {
      kind: "refine",
      view: view,
      density: 0,
      reason: kind,
      pad: refinePad(kind, covered, gestureSpeed, tripMs(), !!samples.dy),
      basis: viewBasis(view, logAxes),
    };
  }

  // A p90 of the measured round trips, in milliseconds, for the margin calculation. With no
  // samples yet, a conservative default.
  function tripMs() {
    const list = stats().roundTrip;
    if (!list || !list.length) return DEFAULT_ROUND_TRIP_MS;
    const sorted = list.slice().sort(function (a, b) {
      return a - b;
    });
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ROUND_TRIP_PERCENTILE))];
  }

  // What the plot still owes, asked after every answer and at the end of every gesture. One
  // mechanism: the canvas shows the scene at the current view, and the markup that gets saved
  // shows the current range. So a re-sample is owed when the view needs data the samples do not
  // cover, and a scene when the scene on screen is not at the view, and a picture when the
  // markup is not (only at rest: a gesture frame asks for the scene alone).
  function reconcile() {
    if (status !== "live") return false;
    if (inFlight) return true;
    const view = currentView();
    if (!view) return false;
    const counters = stats();
    counters.checks += 1;
    const settled = gestureView
      ? !!sceneView && !rangeDiffers(sceneView, view)
      : !rangeDiffers(viewOf(container), view);
    // One view between two re-samples: a re-sample carries no scene, so after one the labels
    // would stay at the old range while the finger keeps moving. The coverage is allowed one
    // more view of lag. The ticks are not.
    if (refinementSinceView && !settled) {
      if (refused && refused.kind === "view" && !rangeDiffers(refused.view, view)) {
        counters.checkNoNeed += 1;
        return false;
      }
      counters.checkAsk += 1;
      enqueue("view", view);
      return true;
    }
    const due = dueRefine();
    if (due) {
      counters.checkAsk += 1;
      enqueue(due.kind, due.view, due.density, due);
      return true;
    }
    if (!settled) {
      // A range the engine already refused is not asked for again: the answer would be the same
      // refusal, once per display frame. A new view clears it.
      if (refused && refused.kind === "view" && !rangeDiffers(refused.view, view)) {
        counters.checkNoNeed += 1;
        return false;
      }
      counters.checkAsk += 1;
      enqueue("view", view);
      return true;
    }
    counters.checkNoNeed += 1;
    return false;
  }

  function enqueue(kind, view, densityLevel, details) {
    if (!view || status === "disposed") return;
    // A stale controller cannot ask the engine anything, but a local pan still has to keep its
    // range: `wanted` is what the canvas draws at rest, so the gesture does not snap back.
    if (status === "stale") {
      if (kind === "view") wanted = view;
      return;
    }
    const job = { kind: kind, view: view, density: densityLevel || 0 };
    if (details) {
      job.pad = details.pad;
      job.reason = details.reason;
      job.basis = details.basis;
    }
    // One queue, one rule. A view coalesces with a queued view and never replaces a queued
    // re-sample: the re-sample is what puts the curve under the finger. A re-sample replaces a
    // queued view, so it gets the next slot -- but after a re-sample has been sent, a queued view
    // goes first, so the ticks cannot starve behind a fast finger. The newest view is kept in
    // `wanted` and is re-judged after that view.
    if (kind === "view") {
      wanted = view;
      // A view coalesces with a queued view. After a re-sample, one view replaces a queued
      // re-sample too: that is the ticks' turn. Before one, a queued re-sample is left alone.
      if (!queued || queued.kind === "view" || refinementSinceView) queued = job;
    } else if (!(refinementSinceView && queued && queued.kind === "view")) {
      queued = job;
    }
    pump();
  }

  function messageFor(job) {
    if (job.kind === "refine") return "plot_refine";
    if (job.kind === "densify") return "plot_densify";
    return "plot_view";
  }

  function contentFor(job) {
    const content = { handle: job.view.id };
    if (job.kind === "densify") {
      content.level = job.density;
      return content;
    }
    content.x = job.view.x;
    content.y = job.view.y;
    if (job.kind === "refine" && job.pad > 0) content.pad = job.pad;
    if (job.kind === "view") {
      // The frame's shape, from the scene the canvas draws: the engine re-lays a crop out, and
      // `Show`'s own default would turn a square picture into a 1.6:1 one.
      if (scene && scene.frame && scene.frame[2] > 0) {
        content.aspect = scene.frame[3] / scene.frame[2];
      }
      // A gesture frame needs the scene, not the markup: nothing shows the SVG, and the answer
      // at rest brings it for the document.
      if (gestureView) content.picture = false;
    }
    return content;
  }

  function pump() {
    if (status !== "live" || inFlight || !queued) return;
    if (!container.isConnected) {
      queued = null;
      dispose();
      return;
    }
    // One request per display frame. Nothing else throttles them.
    if (pumpQueued) return;
    pumpQueued = true;
    window.requestAnimationFrame(function () {
      pumpQueued = false;
      if (status !== "live" || inFlight || !queued) return;
      const job = queued;
      queued = null;
      void sendJob(job);
    });
  }

  // A job that produced no usable answer. `ename`/`message` come from the reply or the bridge
  // rejection. The latch belongs to the kind of job that failed: a refused picture must not stop a
  // re-sample, which is often what would make the picture drawable. A new answer clears both.
  function failJob(job, ename, message) {
    if (status === "disposed") return;
    if (ename === "ExpiredHandle") {
      // A handle the engine has evicted or forgotten. Keep the cached scene and samples: the
      // canvas can still pan them locally, and a fresh evaluation of the entry will replace
      // the controller with one that has a live handle. Disposing here would drop the canvas
      // and show the older saved picture instead - a visible snap back.
      status = "stale";
      queued = null;
      pumpQueued = false;
      return;
    }
    if (!container.isConnected) {
      dispose();
      return;
    }
    const counters = stats();
    counters.failures += 1;
    counters.lastError = ename ? ename + ": " + (message || "") : message || "empty reply";
    counters.lastFailed = job.kind;
    refused = { kind: job.kind === "view" ? "view" : "refine", view: job.view };
    reconcile();
    pump();
  }

  async function sendJob(job) {
    if (!isLive() || inFlight || !job) return;
    inFlight = true;
    const sentAt = now();
    stats().sends += 1;
    // A re-sample is counted as such for the queue's alternation, and its margin/reason are
    // visible in `plotperf`.
    if (job.kind === "view") {
      refinementSinceView = false;
    } else {
      refinementSinceView = true;
      stats().refinePad = job.pad || null;
      stats().refineReason = job.reason || null;
    }
    let promise;
    try {
      promise = send(messageFor(job), contentFor(job));
    } catch (error) {
      inFlight = false;
      failJob(job, error && error.ename, String((error && error.message) || error));
      return;
    }
    if (!promise || typeof promise.then !== "function") {
      inFlight = false;
      failJob(job, null, "the bridge returned no promise");
      return;
    }
    try {
      const reply = await promise;
      inFlight = false;
      if (status === "disposed") return;
      const item = reply?.status === "ok" ? reply.content : null;
      const carries = item && (item.svg || item.data || item.plot);
      if (!carries) {
        failJob(job, reply?.ename, reply?.evalue);
        return;
      }
      const counters = stats();
      if (item.svg) counters.frames += 1;
      if (job.kind === "view") counters.views += 1;
      else counters.refines += 1;
      record(counters.roundTrip, now() - sentAt);
      record(counters.bytes, weightOf(item));
      if (job.kind === "densify") density = job.density;
      // A re-sample re-evaluates the original call, which replaces a densified graphic with the
      // renderer's default number of points. Forget the level, or a parametric plot that panned
      // once would never ask for a denser drawing again.
      else if (job.kind === "refine") density = 0;
      refused = null;
      applyItem(item, job);
      // A re-sample that arrived is the new density basis. The first coverage one ends the
      // large first-interaction margin.
      if (job.kind !== "view") {
        if (job.reason === "coverage") covered = true;
        if (job.basis) basis = job.basis;
      }
      reconcile();
      pump();
    } catch (error) {
      // A handler above threw (a DOM or decoding error in applyItem), or the reply was
      // rejected. The job is over: keep the queue moving and surface it in the counters
      // instead of an unhandled rejection.
      inFlight = false;
      failJob(job, error && error.ename, String((error && error.message) || error));
    }
  }

  // Shows a response on the canvas, and the markup it carries hidden (the document's picture).
  function applyItem(item, job) {
    if (item.data) {
      if (typeof item.data.lx === "boolean") logAxes = { x: item.data.lx, y: !!item.data.ly };
      const nextPrepared = build(item.data);
      if (nextPrepared) {
        prepared = nextPrepared;
        if (layer) WoxiPlotLayer.update(layer, null, prepared, logAxes);
        // Coverage describes the samples that arrived with it. A picture reply reports the
        // engine's coverage, which can be newer than the samples the canvas still holds when a
        // re-sample reply was lost, so it is not adopted here.
        if (item.plot && item.plot.d) {
          coverage = { d: item.plot.d, dy: item.plot.dy || null };
        }
      } else {
        // Samples the canvas cannot draw: keep the samples and the coverage that are still on
        // screen, and do not ask for this same range again (the answer would not change).
        if (job && job.view) refused = { kind: "refine", view: job.view };
      }
    }
    if (item.plot && item.plot.scene) {
      if (!layout) layout = WoxiPlotLayer.layoutOf(item.plot.scene);
      scene = WoxiPlotLayer.normalize(item.plot.scene, layout);
      // A scene arrives without markup on a gesture frame. The canvas is already mounted, and it
      // has to draw the new ticks and labels at once - not only when the next markup lands.
      if (layer) WoxiPlotLayer.update(layer, scene, null, null);
      sceneView = item.plot.x && item.plot.y ? { x: item.plot.x, y: item.plot.y } : null;
    }
    if (item.svg) {
      // The markup is what the notebook saves, never what the app shows: it is inserted hidden,
      // sized by the pinned box so the card cannot resize, and the canvas goes over it.
      const box = layer ? layer.box : layout ? WoxiPlotLayer.boxOf(layout) : null;
      dropLayer();
      container.innerHTML = WoxiRender.svgTag(item.svg, "woxi-graphic");
      mountLayer(box);
      if (item.plot && item.plot.x) {
        // The attribute keeps the view and the sample capability flags. A reopened document
        // reads it back.
        setView(container, item.plot);
      }
    }
    // Adopt the range the answer was drawn at only when no newer view has been asked for. A
    // reply that arrives after the finger moved on must not pull the view back. A repaired
    // range (the engine's log fallback) is adopted while the answer is still the newest.
    if (
      item.plot &&
      item.plot.x &&
      item.plot.y &&
      (!job || job.kind !== "view" || !wanted || !rangeDiffers(wanted, job.view))
    ) {
      wanted = { id: item.plot.id, x: item.plot.x, y: item.plot.y };
    }
    requestDraw();
    // What gets persisted is the markup and the attribute together, only between gestures.
    if (onFrame && !gestureView && item.svg) onFrame(container);
  }

  container.addEventListener("pointerdown", onDown);
  container.addEventListener("pointermove", onMove);
  container.addEventListener("pointerup", onUp);
  container.addEventListener("pointercancel", onUp);

  sessionOf(container).controller = {
    active: function () {
      return !!gestureView;
    },
    send: send,
    dispose: dispose,
    // A re-sample now, and whether one is due, for the harness.
    refineNow: function () {
      const due = dueRefine();
      if (due) enqueue(due.kind, due.view, due.density, due);
    },
    refineDue: function () {
      return !!dueRefine();
    },
    // The scene the canvas is drawing, for `plotscene` (a gesture frame's scene is live here
    // before its markup arrives).
    scene: function () {
      return layer ? layer.scene : null;
    },
    // What a rebuilt notebook's new element needs to draw at once: the scene and samples the
    // canvas has, the first scene's layout, the axes and the samples' coverage. Only a wired
    // plot has them.
    seed: function () {
      const view = viewOf(container);
      if (!view || !scene) return null;
      return {
        id: view.id,
        scene: scene,
        prepared: prepared,
        layout: layout,
        log: logAxes,
        coverage: coverage,
      };
    },
    // The harness reads this to see a controller as it sees itself.
    state: function () {
      return {
        status: status,
        density: density,
        layer: !!layer,
        prepared: !!prepared,
        series: prepared ? prepared.series.length : 0,
        gesture: gestureView,
        wanted: wanted,
        scene: sceneView,
        shown: viewOf(container),
        coverage: coverage,
        box: layer ? layer.box : null,
        scale: layer ? layer.scale : null,
        mapping: mappingOf(currentView()),
        frame: scene ? scene.frame : null,
        rails: scene ? scene.rails || null : null,
        // The tick set the canvas is drawing, grouped for the harness.
        ticks: scene ? tickSummary(scene.ticks) : null,
      };
    },
  };

  // A plot is wired with the scene it was rendered with. Mount the canvas now so it draws
  // before the first gesture.
  if (scene) mountLayer(layout ? WoxiPlotLayer.boxOf(layout) : null);
}

// Stops every controller under `root` and returns what has to be released once the replacement
// plots have attached.
function detach(root) {
  const stale = [];
  if (!root || !root.querySelectorAll) return stale;
  const plots = root.querySelectorAll(".woxi-plot");
  for (let i = 0; i < plots.length; i += 1) {
    const controller = controllerOf(plots[i]);
    if (!controller) continue;
    const view = viewOf(plots[i]);
    controller.dispose();
    if (view) stale.push({ id: view.id, send: controller.send });
  }
  return stale;
}

// Releases handles collected by `detach`, except the ones `root` still addresses: a notebook
// rebuild recreates the elements from the stored HTML with the same handle ids, so the engine's
// data is still what those plots show.
function release(stale, root) {
  if (!stale || !stale.length) return;
  const kept = {};
  const plots = root && root.querySelectorAll ? root.querySelectorAll(".woxi-plot") : [];
  for (let i = 0; i < plots.length; i += 1) {
    const view = viewOf(plots[i]);
    if (view) kept[view.id] = true;
  }
  for (let j = 0; j < stale.length; j += 1) {
    const entry = stale[j];
    if (kept[entry.id]) continue;
    fire(entry.send, "plot_release", { handle: entry.id });
  }
}

function first(root) {
  return root.querySelector ? root.querySelector(".woxi-plot") : null;
}

// The last plot on the page, for the harness's `plotstate last` / `plotscene last`: a sweep that
// adds one plot per case inspects the one it just added, not the first.
function last(root) {
  if (!root.querySelectorAll) return null;
  const plots = root.querySelectorAll(".woxi-plot");
  return plots.length ? plots[plots.length - 1] : null;
}

// How a scene's ticks are grouped, for `plotstate`: `axis:kind:labeled`. A tick's kind says
// whether it follows an axis line (`a`) or sits on the frame (`f`).
function tickSummary(ticks) {
  const summary = {};
  for (let i = 0; i < ticks.length; i += 1) {
    const tick = ticks[i];
    const key = tick.o + ":" + (tick.k || "?") + (tick.l ? ":label" : "");
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}

// The session record's other parts, for the harness: the frame counters.
function perf(container) {
  const session = container && sessions.get(container);
  return session ? session.counters : null;
}

function resetPerf(container) {
  const session = container && sessions.get(container);
  if (session) session.counters = null;
}

export {
  attach,
  controllerOf as controller,
  detach,
  first,
  last,
  markupOf,
  perf,
  release,
  resetPerf,
  seedsOf,
  viewOf,
};
