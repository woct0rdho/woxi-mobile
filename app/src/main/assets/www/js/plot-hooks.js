// The plot harness: synthetic fingers, latency injection and the frame counters. Nothing
// here runs in normal use - the app calls `plotAction` only for the action names below -
// but it has to live in the app because it needs the same DOM, the same controllers and
// the same bridge.
//
// It moved out of `app.js` when the web layer became modules: these hooks own the plot side
// (they hold the held drag and the injected latency), and everything else in `app.js` only
// routes an action name here.

import * as WoxiPlot from "./plot-interact.js";
import * as WoxiPlot3d from "./plot3d.js";

// Answers the engine has already given are delayed by this much, so races between a finger and
// a frame can be reproduced on a device.
let latencyMs = 0;

// The drag `plothold` starts, so `plotmove` and `plotrelease` can continue it.
let held = null;

export function latency() {
  return latencyMs;
}

// Nearest-rank percentile of a small sample. Diagnostic only.
function percentile(values, fraction) {
  if (!values || !values.length) return 0;
  const sorted = values.slice().sort(function (a, b) {
    return a - b;
  });
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1)))
  );
  return sorted[index];
}

// One line of frame cost: round trip p50/p95, SVG paint p50/p95 and the payload size - the
// numbers the plot plan budgets against.
export function perfLine(counters) {
  const rt = counters.roundTrip || [];
  const paint = counters.paint || [];
  const bytes = counters.bytes || [];
  return (
    "frames=" +
    counters.frames +
    " rt=" +
    Math.round(percentile(rt, 0.5)) +
    "/" +
    Math.round(percentile(rt, 0.95)) +
    "ms" +
    " paint=" +
    Math.round(percentile(paint, 0.5)) +
    "/" +
    Math.round(percentile(paint, 0.95)) +
    "ms" +
    " bytes=" +
    Math.round(percentile(bytes, 0.5)) +
    "B" +
    " views=" +
    (counters.views || 0) +
    " refines=" +
    (counters.refines || 0) +
    (counters.refinePad
      ? " pad=" + counters.refinePad + (counters.refineReason ? "/" + counters.refineReason : "")
      : "") +
    " checks=" +
    (counters.checks || 0) +
    "/" +
    (counters.checkAsk || 0) +
    "ask" +
    (counters.checkNoNeed ? " ok=" + counters.checkNoNeed : "") +
    (counters.lastBox
      ? " box=" + Math.round(counters.lastBox[0]) + "x" + Math.round(counters.lastBox[1])
      : "") +
    (typeof counters.lastScale === "number"
      ? " scale=" + Math.round(counters.lastScale * 10) / 10
      : "") +
    (counters.resizes ? " geom=" + counters.resizes : "") +
    " draws=" +
    (counters.draws || 0) +
    (counters.paintFails ? " dropped=" + counters.paintFails : "") +
    " sends=" +
    (counters.sends || 0) +
    (counters.failures
      ? " failed=" +
        counters.failures +
        ":" +
        counters.lastError +
        (counters.lastFailed ? "/" + counters.lastFailed : "")
      : "")
  );
}

// One synthetic pointer event on a plot.
function fireOn(plot, id, type, x, y) {
  plot.dispatchEvent(
    new PointerEvent(type, {
      pointerId: id,
      pointerType: "touch",
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
      isPrimary: id === 1,
    })
  );
}

function plotCenter(plot) {
  const box = plot.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2, box: box };
}

// Streams a synthetic gesture over `frames` display frames: `at(t)` gives the pointers
// ([id, x, y]) at progress t in [0, 1]. They go down at t = 0, move once per display
// frame and come up at t = 1, through the same pointer events a finger produces, so a
// screen recording of the plot sees every frame the controller draws.
function streamPointers(plot, frames, at, done, log) {
  const down = at(0);
  for (const [id, x, y] of down) fireOn(plot, id, "pointerdown", x, y);
  let step = 0;
  const tick = function () {
    step += 1;
    const t = step / frames;
    const type = step < frames ? "pointermove" : "pointerup";
    for (const [id, x, y] of at(t)) fireOn(plot, id, type, x, y);
    if (step < frames) {
      window.requestAnimationFrame(tick);
      return;
    }
    log(done);
  };
  window.requestAnimationFrame(tick);
}

// Runs one plot action. Returns whether it was one, so the caller's switch can fall through to
// everything else. `context` is `{ log, notebook }`: the app's logger, and the element the
// notebook lives in (null before boot).
export function plotAction(name, argument, context) {
  const log = context.log;
  const root = function () {
    return context.notebook() || document;
  };
  const firstPlot = function () {
    return WoxiPlot.first(root());
  };
  // `plotstate last` / `plotscene last` inspect the newest plot: a sweep that adds one plot per
  // case needs the plot it just added, while the default stays the first.
  const whichPlot = function (argument) {
    return (argument || "").trim() === "last" ? WoxiPlot.last(root()) : firstPlot();
  };

  switch (name) {
    case "plotperf": {
      // What plot frames cost, per plot. `plotperf reset` clears the counters so the next
      // gesture can be measured on its own.
      if (argument === "reset") {
        const resetted = root().querySelectorAll(".woxi-plot");
        for (let r = 0; r < resetted.length; r++) WoxiPlot.resetPerf(resetted[r]);
        log("plotperf: reset " + resetted.length);
        break;
      }
      const perfPlots = root().querySelectorAll(".woxi-plot");
      if (!perfPlots.length) {
        log("plotperf: no interactive plot");
        break;
      }
      for (let p = 0; p < perfPlots.length; p++) {
        const perfEl = perfPlots[p];
        const controller = WoxiPlot.controller(perfEl);
        const perfView = WoxiPlot.viewOf(perfEl);
        const counters = WoxiPlot.perf(perfEl);
        // The range the finger asked for, the picture on screen, and whether the canvas is
        // drawing the curve between frames.
        const layerState = controller && controller.state ? controller.state() : null;
        const head =
          "plotperf " +
          (perfView ? "handle=" + perfView.id : "handle=?") +
          " layer=" +
          (layerState && layerState.layer ? "on" : "off") +
          " series=" +
          (layerState ? layerState.series : 0) +
          " gesture=" +
          (controller && controller.active() ? "yes" : "no");
        log(counters ? head + " " + perfLine(counters) : head + " frames=0");
      }
      break;
    }
    case "plotsweep": {
      // A finger-like drag: down, one move per animation frame, up. The hooks that step with
      // setTimeout move at ~14 Hz, which is slower than a real finger and makes any gesture
      // look jumpy, so a smoothness check needs this.
      const sweepPlot = firstPlot();
      if (!sweepPlot) {
        log("plotsweep: no interactive plot");
        break;
      }
      const sweepParts = (argument || "").split(",");
      const sweepX = Number(sweepParts[0] || 0);
      const sweepY = Number(sweepParts[1] || 0);
      const sweepFrames = Number(sweepParts[2] || 0) || 180;
      const sweep = plotCenter(sweepPlot);
      const sweepStarted = Date.now();
      fireOn(sweepPlot, 21, "pointerdown", sweep.x, sweep.y);
      let sweepAt = 0;
      const sweepStep = function () {
        sweepAt += 1;
        fireOn(
          sweepPlot,
          21,
          "pointermove",
          sweep.x + (sweepX * sweepAt) / sweepFrames,
          sweep.y + (sweepY * sweepAt) / sweepFrames
        );
        if (sweepAt < sweepFrames) {
          window.requestAnimationFrame(sweepStep);
          return;
        }
        fireOn(sweepPlot, 21, "pointerup", sweep.x + sweepX, sweep.y + sweepY);
        log(
          "plotsweep: dx=" +
            sweepX +
            " dy=" +
            sweepY +
            " frames=" +
            sweepFrames +
            " elapsed=" +
            (Date.now() - sweepStarted) +
            "ms"
        );
      };
      window.requestAnimationFrame(sweepStep);
      break;
    }
    case "plotscene": {
      // The scene the canvas is drawing, with coordinates rounded: what the ticks, their marks
      // and their labels are, which is what a wrong side or a clamped axis shows up in.
      const scenePlot = whichPlot(argument);
      const sceneController = WoxiPlot.controller(scenePlot);
      const drawn = sceneController ? sceneController.scene() : null;
      if (!drawn) {
        log("plotscene: none");
        break;
      }
      const round = function (value) {
        return Math.round(value * 100) / 100;
      };
      const sceneDigest = {
        box: drawn.box.map(round),
        frame: drawn.frame.map(round),
        rails: drawn.rails || null,
        fs: drawn.fs || null,
        lines: drawn.lines.map(function (line) {
          return { o: line.o, v: round(line.v), k: line.k };
        }),
        ticks: drawn.ticks.map(function (tick) {
          const out = {
            o: tick.o,
            v: round(tick.v),
            k: tick.k,
            at: round(tick.at),
            s: tick.s || null,
            b: round(tick.b),
            e: round(tick.e),
          };
          if (tick.l) {
            out.l = {
              t: tick.l.t,
              dx: round(tick.l.dx),
              dy: round(tick.l.dy),
              a: tick.l.a,
              s: round(tick.l.s),
            };
          }
          return out;
        }),
        texts: drawn.texts.map(function (text) {
          return {
            t: text.t,
            x: round(text.x),
            y: round(text.y),
            a: text.a,
            r: text.r ? text.r.a : null,
          };
        }),
      };
      log("plotscene: " + JSON.stringify(sceneDigest));
      break;
    }
    case "plot3dstate": {
      const controller =
        argument === "first" ? WoxiPlot3d.firstController() : WoxiPlot3d.lastController();
      log("plot3dstate: " + (controller ? JSON.stringify(controller.state()) : "none"));
      return true;
    }
    case "plot3dperf": {
      const controller = WoxiPlot3d.lastController();
      if (argument === "reset" && controller) controller.resetStats();
      log(WoxiPlot3d.perfLine(controller));
      return true;
    }
    case "plot3dspin": {
      const controller = WoxiPlot3d.lastController();
      if (!controller) {
        log("plot3dspin: no 3D plot");
        return true;
      }
      const parts = String(argument || "").split(",");
      const frames = parseInt(parts[0], 10) || 60;
      const dy = parts.length > 1 ? Number(parts[1]) : 0.01;
      void controller.spin(frames, dy).then(function () {
        log("plot3dspin: done " + frames);
      });
      return true;
    }
    case "plot3dpinch": {
      const controller = WoxiPlot3d.lastController();
      if (!controller) {
        log("plot3dpinch: no 3D plot");
        return true;
      }
      controller.pinchBy(Number(argument) || 1.2);
      log("plot3dpinch: " + String(argument || 1.2));
      return true;
    }
    case "plot3dorbit": {
      // A one-finger drag at display-frame rate over `frames` frames, through the same
      // pointer events a finger produces, so a screen recording sees every frame the
      // controller draws. `plot3dorbit dx,dy,frames` (dx/dy in CSS px), centred on the card.
      const plot = document.querySelector(".woxi-plot3d");
      if (!plot) {
        log("plot3dorbit: no 3D plot");
        return true;
      }
      const parts = (argument || "120,0,30").split(",");
      const dx = Number(parts[0]) || 0;
      const dy = Number(parts[1]) || 0;
      const frames = parseInt(parts[2], 10) || 30;
      const centre = plotCenter(plot);
      const startX = centre.x - dx / 2;
      const startY = centre.y - dy / 2;
      streamPointers(
        plot,
        frames,
        (t) => [[21, startX + dx * t, startY + dy * t]],
        "plot3dorbit: done " + frames,
        log
      );
      return true;
    }
    case "plot3dpinchmove": {
      // Two synthetic pointers over time on the newest 3D plot: the gap grows by `factor`
      // while the midpoint moves by (`shiftX`,`shiftY`) CSS px, like a real pinch-pan.
      // `plot3dpinchmove factor,shiftX,shiftY[,frames]`.
      const plot = document.querySelector(".woxi-plot3d");
      if (!plot) {
        log("plot3dpinchmove: no 3D plot");
        return true;
      }
      const parts = (argument || "2,0,0,30").split(",");
      const factor = Number(parts[0]) || 2;
      const shiftX = Number(parts[1]) || 0;
      const shiftY = Number(parts[2]) || 0;
      const frames = parseInt(parts[3], 10) || 30;
      const centre = plotCenter(plot);
      const startGap = Math.min(centre.box.width, centre.box.height) * 0.15;
      streamPointers(
        plot,
        frames,
        (t) => {
          const gap = startGap * (1 + (factor - 1) * t);
          const x = centre.x + shiftX * t;
          const y = centre.y + shiftY * t;
          return [
            [1, x - gap, y],
            [2, x + gap, y],
          ];
        },
        "plot3dpinchmove: done factor=" +
          factor +
          " shift=" +
          shiftX +
          "," +
          shiftY +
          " frames=" +
          frames,
        log
      );
      return true;
    }
    case "plotstate": {
      // What a plot's controller believes: the first plot by default, the newest with `last`.
      // The range the finger asked for, the scene's range, the samples' coverage, the pinned box
      // and the rails.
      const statePlot = whichPlot(argument);
      const stateController = WoxiPlot.controller(statePlot);
      log("plotstate: " + (stateController ? JSON.stringify(stateController.state()) : "none"));
      break;
    }
    case "plotpinch": {
      // Two synthetic pointers closing or opening over time, so the pinch path is exercised the
      // way a real one arrives: moves interleaved with the answers they trigger. adb cannot
      // inject two fingers at once. The optional angle (degrees), shift x and shift y let a test
      // choose x/y/uniform and a moving midpoint: `plotpinch 2,45,120,0`.
      const pinchPlot = firstPlot();
      if (!pinchPlot) {
        log("plotpinch: no interactive plot");
        break;
      }
      const pinch = plotCenter(pinchPlot);
      const pinchParts = (argument || "").split(",");
      const startGap = Math.min(pinch.box.width, pinch.box.height) * 0.15;
      const pinchFactor = Number(pinchParts[0]) || 2;
      const pinchAngle = ((Number(pinchParts[1]) || 0) * Math.PI) / 180;
      const shiftX = Number(pinchParts[2]) || 0;
      const shiftY = Number(pinchParts[3]) || 0;
      const pinchDx = Math.cos(pinchAngle);
      const pinchDy = Math.sin(pinchAngle);
      fireOn(
        pinchPlot,
        1,
        "pointerdown",
        pinch.x - pinchDx * startGap,
        pinch.y - pinchDy * startGap
      );
      fireOn(
        pinchPlot,
        2,
        "pointerdown",
        pinch.x + pinchDx * startGap,
        pinch.y + pinchDy * startGap
      );
      const steps = 10;
      let step = 0;
      const tick = function () {
        step += 1;
        const gap = startGap * (1 + ((pinchFactor - 1) * step) / steps);
        const centerX = pinch.x + (shiftX * step) / steps;
        const centerY = pinch.y + (shiftY * step) / steps;
        fireOn(pinchPlot, 1, "pointermove", centerX - pinchDx * gap, centerY - pinchDy * gap);
        fireOn(pinchPlot, 2, "pointermove", centerX + pinchDx * gap, centerY + pinchDy * gap);
        if (step < steps) {
          window.setTimeout(tick, 16);
          return;
        }
        fireOn(
          pinchPlot,
          1,
          "pointerup",
          pinch.x + shiftX - pinchDx * startGap * pinchFactor,
          pinch.y + shiftY - pinchDy * startGap * pinchFactor
        );
        fireOn(
          pinchPlot,
          2,
          "pointerup",
          pinch.x + shiftX + pinchDx * startGap * pinchFactor,
          pinch.y + shiftY + pinchDy * startGap * pinchFactor
        );
        log(
          "plotpinch: factor=" +
            pinchFactor +
            " angle=" +
            Math.round((pinchAngle * 180) / Math.PI) +
            " shift=" +
            shiftX +
            "," +
            shiftY +
            " center=" +
            Math.round(pinch.x) +
            "," +
            Math.round(pinch.y)
        );
      };
      window.setTimeout(tick, 16);
      break;
    }
    case "plothold": {
      // A drag that never lifts, so a screenshot can show what a gesture draws before any
      // answer arrives. `plotrelease` finishes it.
      const holdPlot = firstPlot();
      if (!holdPlot) {
        log("plothold: no interactive plot");
        break;
      }
      const holdParts = (argument || "0,0").split(",");
      const holdStart = plotCenter(holdPlot);
      held = {
        plot: holdPlot,
        x: holdStart.x,
        y: holdStart.y,
        dx: Number(holdParts[0] || 0),
        dy: Number(holdParts[1] || 0),
        at: 0,
      };
      fireOn(holdPlot, 12, "pointerdown", holdStart.x, holdStart.y);
      log("plothold: down at " + Math.round(holdStart.x) + "," + Math.round(holdStart.y));
      break;
    }
    case "plotmove": {
      // Steps the held drag forward by the fraction given (`0.5` = halfway. `0` is the finger
      // back where it started, which is a move of no pixels and still a frame).
      if (!held) {
        log("plotmove: nothing held");
        break;
      }
      const heldAt = Math.max(
        0,
        Math.min(1, argument === "" || argument === undefined ? 0.5 : Number(argument))
      );
      held.at = heldAt;
      fireOn(held.plot, 12, "pointermove", held.x + held.dx * heldAt, held.y + held.dy * heldAt);
      log("plotmove: " + heldAt);
      break;
    }
    case "plotrelease": {
      if (!held) {
        log("plotrelease: nothing held");
        break;
      }
      fireOn(held.plot, 12, "pointerup", held.x + held.dx * held.at, held.y + held.dy * held.at);
      held = null;
      log("plotrelease: up");
      break;
    }
    case "plotlatency": {
      // Delays every plot answer, so races can be reproduced on a device.
      latencyMs = Number(argument) || 0;
      log("plotlatency: " + latencyMs + "ms");
      break;
    }
    case "plotrefine": {
      // Asks for more data now instead of waiting for the next answer to judge the coverage.
      const refineTarget = firstPlot();
      const refineController = WoxiPlot.controller(refineTarget);
      if (!refineController) {
        log("plotrefine: no interactive plot");
        break;
      }
      const refView = WoxiPlot.viewOf(refineTarget);
      if (!refView) {
        log("plotrefine: the plot has no saved view");
        break;
      }
      const summary = " x=[" + refView.x[0].toFixed(3) + "," + refView.x[1].toFixed(3) + "]";
      if (!refineController.refineDue()) {
        log("plotrefine: not needed" + summary);
        break;
      }
      log("plotrefine: asking" + summary);
      refineController.refineNow();
      break;
    }
    default:
      return false;
  }
  return true;
}
