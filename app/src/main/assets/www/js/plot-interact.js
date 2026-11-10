// Interactive 2D plots: drag to pan, pinch to zoom.
//
// A plot output carries a handle and the data range it currently shows
// (`data-woxi-plot`). A gesture turns into a new range and asks the engine to
// re-render that handle at it - the engine re-renders Woxi's cached plot data, it
// does not re-evaluate what the user typed, so a frame costs a few milliseconds.
// The response replaces the picture, and the range the engine reports back is the
// one the next frame works from, so a gesture accumulates instead of drifting.
//
// Re-evaluating the entry produces a fresh plot with its original range: that is
// what resets the view, nothing is stored anywhere else.
//
// Messages follow Jupyter's shape: a `msg_type` with a `content` object, and a reply
// carrying `status` (`ok`/`error`, the latter with `ename`/`evalue`). `plot_retain`
// and `plot_release` keep the engine's handle registry tied to the controllers that
// are actually on screen.
//
// Between answers the picture waits for the engine. An earlier version transformed
// the whole SVG locally so the finger had something to drag immediately, but a frame
// is one flat drawing: scaling it moved the axes, ticks and labels along with the
// curve, and every engine answer snapped them back. A preview would have to transform
// the data layer alone, which needs the renderer to deliver one (see
// docs/plot_interaction_review.md), so the frame stays fixed and the request rate is
// what makes a gesture smooth. Gestures use pointer events with pointer capture, so
// replacing the SVG while the finger is down cannot take the rest of the gesture with
// it.

(function (global) {
  'use strict';

  var STEP_MS = 16;      // floor: about one display frame. The adaptive step below is
                         // what protects plots whose frames are expensive.
  var STEP_MAX_MS = 200; // longest, for plots whose frames are expensive
  var PINCH_MIN = 0.2;   // ignore degenerate pinch scales

  // When the cached data runs out the engine has to sample again. That is much
  // heavier than a re-render (it re-runs the plot call), so it only happens once a
  // gesture has been still for a moment, and at a distance from the last one.
  var REFINE_IDLE_MS = 350;
  var REFINE_MIN_GAP_MS = 700;
  var REFINE_NARROW = 0.25; // view much narrower than the sampled range

  // A plot with a fixed parameter domain (parametric, polar) gains detail by being
  // drawn with more points, not by sampling a different range. Worth doing when the
  // view is much narrower than the picture, and only a few times.
  var DENSIFY_NARROW = 0.25;
  var DENSIFY_MAX_LEVEL = 3;

  function noop() {}

  // Does this view need data the picture does not have: outside the sampled range
  // (zoomed out past it, or panned away), or far inside it (zoomed in past the
  // sampling). A re-sample covers the view plus a margin, so a small pan after one
  // is free. Two-axis plots (contours, fields) are checked in y as well: covering x
  // says nothing about a vertical pan.
  function needsRefine(plot) {
    if (!plot || !plot.s || !plot.d || !plot.x) return false;
    if (outsideOrCoarse(plot.x, plot.d)) return true;
    if (plot.dy && plot.y) return outsideOrCoarse(plot.y, plot.dy);
    return false;
  }

  function outsideOrCoarse(view, data) {
    var span = view[1] - view[0];
    var dataSpan = data[1] - data[0];
    if (!(span > 0) || !(dataSpan > 0)) return false;
    if (view[0] < data[0] || view[1] > data[1]) return true;
    return span < dataSpan * REFINE_NARROW;
  }

  // A fixed-domain plot can be redrawn with more points. That is the only way to
  // show detail inside the domain it already has.
  function needsDensify(plot, level) {
    if (!plot || !plot.dn || !plot.d || !plot.x) return false;
    if (level >= DENSIFY_MAX_LEVEL) return false;
    var span = plot.x[1] - plot.x[0];
    var domain = plot.d[1] - plot.d[0];
    if (!(span > 0) || !(domain > 0)) return false;
    return span < domain * DENSIFY_NARROW;
  }

  // view state on the container

  function viewOf(container) {
    try {
      return JSON.parse(container.getAttribute('data-woxi-plot') || 'null');
    } catch (err) {
      return null;
    }
  }

  function setView(container, view) {
    container.setAttribute('data-woxi-plot', JSON.stringify(view));
  }

  // The rectangle the data is actually drawn in, in screen pixels.

  // A straight segment as `{x1, y1, x2, y2}`. Woxi 0.4 draws the axes as `<line>`
  // elements. Earlier versions used two-point polylines, and framed plots draw a
  // `<rect>` instead. Anything that is not a single straight segment is ignored, which
  // is what keeps the curve itself (a polyline with hundreds of points) out of this.
  function segmentOf(element) {
    var tag = element.tagName.toLowerCase();
    if (tag === 'line') {
      var x1 = parseFloat(element.getAttribute('x1'));
      var y1 = parseFloat(element.getAttribute('y1'));
      var x2 = parseFloat(element.getAttribute('x2'));
      var y2 = parseFloat(element.getAttribute('y2'));
      if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) return null;
      return { x1: x1, y1: y1, x2: x2, y2: y2 };
    }
    if (tag === 'polyline') {
      var points = (element.getAttribute('points') || '').trim().split(/\s+/);
      if (points.length < 2 || points.length > 6) return null;
      var nums = [];
      for (var i = 0; i < points.length; i++) {
        var pair = points[i].split(',');
        if (pair.length !== 2) return null;
        nums.push(parseFloat(pair[0]), parseFloat(pair[1]));
      }
      if (nums.length !== 4 || !isFinite(nums[0]) || !isFinite(nums[1]) ||
        !isFinite(nums[2]) || !isFinite(nums[3])) {
        return null;
      }
      return { x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] };
    }
    if (tag === 'path') {
      var d = element.getAttribute('d') || '';
      var parts = d.split(/[MmLlHhVv, ]+/).filter(function (part) { return part.length > 0; });
      if (parts.length !== 4) return null;
      var values = parts.map(parseFloat);
      for (var j = 0; j < values.length; j++) if (!isFinite(values[j])) return null;
      return { x1: values[0], y1: values[1], x2: values[2], y2: values[3] };
    }
    return null;
  }

  // Woxi's plot SVG has no clip path, but its axes are straight line segments that
  // span the data area, and a framed plot (contours, densities) draws that frame as a
  // `<rect>`. Both give the data rectangle in SVG user units. The screen mapping comes
  // from the SVG's own transform, so letterboxing is included too.
  function userRect(svg) {
    var rects = svg.querySelectorAll('rect');
    var frame = null;
    for (var i = 0; i < rects.length; i++) {
      var rect = rects[i];
      if ((rect.getAttribute('fill') || '') !== 'none') continue;
      var width = parseFloat(rect.getAttribute('width'));
      var height = parseFloat(rect.getAttribute('height'));
      if (!(width > 0) || !(height > 0)) continue;
      if (!frame || width * height > frame.width * frame.height) {
        frame = {
          x: parseFloat(rect.getAttribute('x')) || 0,
          y: parseFloat(rect.getAttribute('y')) || 0,
          width: width,
          height: height,
        };
      }
    }
    if (frame) return frame;

    var nodes = svg.querySelectorAll('line, polyline, path');
    var horizontal = null;
    var vertical = null;
    for (var j = 0; j < nodes.length; j++) {
      var segment = segmentOf(nodes[j]);
      if (!segment) continue;
      var dx = Math.abs(segment.x2 - segment.x1);
      var dy = Math.abs(segment.y2 - segment.y1);
      if (dy <= 0.5 && (!horizontal || dx > horizontal.length)) {
        horizontal = { length: dx, min: Math.min(segment.x1, segment.x2), max: Math.max(segment.x1, segment.x2) };
      }
      if (dx <= 0.5 && (!vertical || dy > vertical.length)) {
        vertical = { length: dy, min: Math.min(segment.y1, segment.y2), max: Math.max(segment.y1, segment.y2) };
      }
    }
    if (!horizontal || !vertical) return null;
    // The axes span the data area and cross wherever the data origin happens to be, so
    // the rectangle comes from their extents rather than from where they meet: a plot
    // of `Sin` is centred on zero, and taking the crossing as a corner would describe
    // a quarter of the picture.
    return {
      x: horizontal.min,
      y: vertical.min,
      width: horizontal.max - horizontal.min,
      height: vertical.max - vertical.min,
    };
  }

  function screenPoint(matrix, x, y) {
    var point;
    if (typeof DOMPoint !== 'undefined') {
      point = new DOMPoint(x, y).matrixTransform(matrix);
    } else {
      point = { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
    }
    return { x: point.x, y: point.y };
  }

  // Screen rectangle of the data area. Falls back to the whole SVG when the axes
  // cannot be recognised, which is what the gesture maths used to assume.
  function plotRect(svg) {
    var box = svg.getBoundingClientRect();
    if (!(box.width > 0) || !(box.height > 0)) return null;
    var user = userRect(svg);
    var matrix = svg.getScreenCTM ? svg.getScreenCTM() : null;
    if (user && matrix && user.width > 0 && user.height > 0) {
      var topLeft = screenPoint(matrix, user.x, user.y);
      var bottomRight = screenPoint(matrix, user.x + user.width, user.y + user.height);
      var width = bottomRight.x - topLeft.x;
      var height = bottomRight.y - topLeft.y;
      // The data area cannot be larger than the picture it is drawn in.
      if (width > 0 && height > 0 && width <= box.width * 1.01 && height <= box.height * 1.01) {
        return { left: topLeft.x, top: topLeft.y, width: width, height: height, box: box, data: true };
      }
    }
    return { left: box.left, top: box.top, width: box.width, height: box.height, box: box, data: false };
  }

  function containerRect(container) {
    var svg = container.querySelector('svg');
    return svg ? plotRect(svg) : null;
  }

  // gesture maths

  // Dragging moves the picture with the finger: right shows lower x, down shows
  // higher y (the y axis points up).
  function panViewFrom(view, dx, dy, rect) {
    if (!view || !rect) return null;
    var sx = (view.x[1] - view.x[0]) / rect.width;
    var sy = (view.y[1] - view.y[0]) / rect.height;
    return {
      id: view.id,
      x: [view.x[0] - dx * sx, view.x[1] - dx * sx],
      y: [view.y[0] + dy * sy, view.y[1] + dy * sy],
    };
  }

  function panView(container, dx, dy) {
    return panViewFrom(viewOf(container), dx, dy, containerRect(container));
  }

  // Scales a range about a fixed anchor, given in fractions of the plot area: each
  // endpoint moves toward or away from the anchor, rather than the range being
  // re-centered on it. Factor 1 is then the identity at every anchor, and the data
  // point under the finger stays under the finger.
  function zoomViewFrom(view, factor, fx, fy) {
    if (!view || !(factor > 0) || factor < PINCH_MIN) return null;
    var ax = view.x[0] + (fx === undefined ? 0.5 : fx) * (view.x[1] - view.x[0]);
    var ay = view.y[1] - (fy === undefined ? 0.5 : fy) * (view.y[1] - view.y[0]);
    return {
      id: view.id,
      x: [ax + (view.x[0] - ax) / factor, ax + (view.x[1] - ax) / factor],
      y: [ay + (view.y[0] - ay) / factor, ay + (view.y[1] - ay) / factor],
    };
  }

  function zoomView(container, factor, fx, fy) {
    return zoomViewFrom(viewOf(container), factor, fx, fy);
  }

  // talking to the engine

  function attach(root, send, onFrame) {
    var plots = root.querySelectorAll('.woxi-plot');
    for (var i = 0; i < plots.length; i++) wire(plots[i], send, onFrame);
  }

  // Swaps in a re-rendered plot, adopting the range the engine reported. Used when
  // no gesture is running (tests, and the frames after the finger has lifted).
  function apply(container, item) {
    if (!item || !item.svg) return;
    container.innerHTML = global.WoxiRender.graphicInnerHtml(item);
    if (item.plot) setView(container, item.plot);
    global.WoxiRender.fitGraphics(container);
  }

  function fire(send, msgType, content) {
    try {
      var answer = send(msgType, content);
      if (answer && answer.catch) answer.catch(noop);
    } catch (err) {
      // The bridge is gone. There is nothing left to talk to.
    }
  }

  function wire(container, send, onFrame) {
    // A controller reference, not an attribute: a notebook rebuild recreates the
    // elements from HTML, and an attribute would claim they are still wired when
    // their listeners are gone.
    if (container.__woxiPlot) return;

    var pointers = {};        // pointerId -> {x, y}
    var activeCount = 0;
    var pinch = null;         // { startDistance, view, fx, fy }
    // While a finger is down the gesture keeps its own range: every move is applied
    // to that, not to what the picture currently shows, so requests still in flight
    // cannot make a drag lose distance. The ranges agree again on lift-off.
    var gestureView = null;
    // The range the user last asked for. A gesture starts from this rather than from
    // whatever the DOM shows, so starting a new one while a frame is still on its way
    // cannot step back a frame.
    var wanted = null;
    // One request at a time, tagged with a sequence number: a response for an older
    // view is never allowed to move the picture back to it.
    var queued = null;        // { kind, view, tag, density }
    var latestTag = 0;        // the newest thing the user asked for
    var paintedTag = 0;       // the newest answer already drawn
    var inFlight = false;
    var lastSentAt = 0;
    var stepMs = STEP_MS;
    var refineTimer = null;
    var lastRefineAt = 0;
    // Set when the engine says the handle is gone or no longer renders: the plot
    // keeps its picture, but stops asking for frames or re-samples.
    var dead = false;
    var disposed = false;
    // While a gesture runs, the picture keeps the geometry it had when the finger
    // landed, so tick-label changes cannot resize the plot under the user's hand.
    var frozen = null;
    // The data rectangle and the SVG box, measured once per gesture.
    var rect = null;

    function currentView() {
      return gestureView || wanted || viewOf(container);
    }

    // The range the user wants, paired with the coverage the engine last confirmed.
    // The two arrive independently - a frame can land while a finger is down - so
    // they are kept apart instead of being read out of one another.
    function refineCandidate() {
      var desired = currentView();
      if (!desired) return null;
      var shown = viewOf(container);
      if (!shown || !shown.d) return desired;
      return { id: desired.id, x: desired.x, y: desired.y, d: shown.d, dy: shown.dy, s: shown.s, dn: shown.dn };
    }

    function densityLevel() {
      return Number(container.getAttribute('data-woxi-density') || 0) || 0;
    }

    // After a gesture has settled, ask for more data when the view needs it.
    function scheduleRefineCheck() {
      if (dead || disposed || container.getAttribute('data-woxi-resample') === 'off') return;
      if (refineTimer) global.clearTimeout(refineTimer);
      refineTimer = global.setTimeout(function () {
        refineTimer = null;
        if (disposed) return;
        // Never re-sample under a finger, and never while a view is still on its way:
        // both would be superseded before the answer arrived.
        if (gestureView || inFlight || (queued && queued.kind === 'view')) {
          scheduleRefineCheck();
          return;
        }
        if (Date.now() - lastRefineAt < REFINE_MIN_GAP_MS) {
          scheduleRefineCheck();
          return;
        }
        var view = refineCandidate();
        if (!view) return;
        var shown = viewOf(container);
        // A fixed-domain plot: more points, same domain.
        if (shown && needsDensify(shown, densityLevel())) {
          lastRefineAt = Date.now();
          enqueue('densify', view, densityLevel() + 1);
          return;
        }
        if (!needsRefine(view)) return;
        lastRefineAt = Date.now();
        enqueue('refine', view);
      }, REFINE_IDLE_MS);
    }

    function enqueue(kind, view, density) {
      if (!view || disposed) return;
      wanted = view;
      latestTag += 1;
      var job = { kind: kind, view: view, tag: latestTag, density: density || 0 };
      if (!queued || kind === 'view') {
        // The newest view wins. A queued re-sample is not worth sending once the
        // view has moved on.
        queued = job;
      }
      pump();
    }

    function messageFor(job) {
      if (job.kind === 'refine') return 'plot_refine';
      if (job.kind === 'densify') return 'plot_densify';
      return 'plot_view';
    }

    function contentFor(job) {
      var content = { handle: job.view.id, x: job.view.x, y: job.view.y };
      if (job.kind === 'densify') content.level = job.density;
      return content;
    }

    function pump() {
      if (inFlight || !queued || disposed) return;
      // A container taken out of the document (a rebuilt notebook, a deleted entry)
      // must not keep asking the engine for frames.
      if (!container.isConnected) {
        queued = null;
        dispose(true);
        return;
      }
      var wait = stepMs - (Date.now() - lastSentAt);
      if (wait > 0) {
        global.setTimeout(pump, wait);
        return;
      }
      var job = queued;
      queued = null;
      inFlight = true;
      var sentAt = Date.now();
      lastSentAt = sentAt;
      send(messageFor(job), contentFor(job)).then(function (reply) {
        inFlight = false;
        if (disposed) return;
        var item = reply && reply.status === 'ok' ? reply.content : null;
        if (!item || !item.svg) {
          var ename = reply && reply.ename;
          if (ename === 'ExpiredHandle' || !container.querySelector('svg')) {
            container.setAttribute('data-woxi-resample', 'off');
            dead = true;
            container.setAttribute('data-woxi-view', 'expired');
            return;
          }
          // A request the plot cannot serve: stop asking for more data, but keep
          // the picture and keep panning the data it has.
          container.setAttribute('data-woxi-resample', 'off');
          return;
        }
        // Let the request rate follow the engine: a contour frame that takes 80 ms
        // should not be asked for every 40 ms.
        stepMs = Math.min(STEP_MAX_MS, Math.max(STEP_MS, (Date.now() - sentAt) * 1.1));
        if (job.kind === 'densify') {
          container.setAttribute('data-woxi-density', String(job.density));
        }
        applyItem(item, job.tag);
        // The newest answer settles the view, so that is when to decide whether it
        // needs more data than the picture has. A re-sample goes through the same
        // queue, which keeps the two from overtaking each other.
        if (job.kind !== 'view' || job.tag === latestTag) scheduleRefineCheck();
        pump();
      }, function () {
        inFlight = false;
        if (job.kind === 'refine' || job.kind === 'densify') {
          // Do not keep asking for something the engine cannot deliver.
          container.setAttribute('data-woxi-resample', 'off');
          return;
        }
        pump();
      });
    }

    // Shows a response.
    //
    // Two separate questions, and mixing them up froze the picture: during a pinch
    // every new move makes the previous answer outdated, so "is this answer still the
    // newest?" is almost always no - yet those frames are exactly what has to be
    // drawn. So: a picture is painted whenever the answer is newer than the one on
    // screen (which stops a late answer from rolling the viewport back, and still
    // redraws every frame of a gesture), while the range is only taken from the
    // newest answer, so the maths never follows a lagging frame.
    function applyItem(item, tag) {
      if (!item || !item.svg) return;
      var newest = tag === latestTag;
      var paint = tag > paintedTag;
      if (paint) {
        paintedTag = tag;
        container.innerHTML = global.WoxiRender.graphicInnerHtml(item);
        // Frozen geometry while a finger is down, so the plot cannot resize itself
        // (tick labels change the ink bounds) in the middle of a drag.
        global.WoxiRender.fitGraphics(container, gestureView ? frozen : null);
      }
      if (!item.plot) return;
      var truth = currentView();
      var shown = viewOf(container);
      if (!newest || gestureView) {
        // Keep the range the user wants. Take only the sampling that came back -
        // and not even that when what is on screen is already covered by it, so a
        // late answer cannot undo a re-sample that has already landed.
        var covered = shown && shown.d && truth && truth.x[0] >= shown.d[0]
          && truth.x[1] <= shown.d[1];
        if (covered) {
          item.plot.d = shown.d;
          item.plot.s = shown.s;
          item.plot.dn = shown.dn;
        }
        item.plot.x = truth ? truth.x : item.plot.x;
        item.plot.y = truth ? truth.y : item.plot.y;
      }
      setView(container, item.plot);
      if (newest && !gestureView) wanted = item.plot;
      // After the range is written, not before: what gets persisted is the markup and
      // the attribute together, and persisting first saved a frame behind.
      if (onFrame) onFrame(container);
    }

    function schedule(view) {
      enqueue('view', view);
    }

    function ids() {
      return Object.keys(pointers);
    }

    function measure() {
      rect = containerRect(container);
      return rect;
    }

    function beginGesture() {
      gestureView = currentView();
      frozen = global.WoxiRender.svgGeometry(container);
      measure();
    }

    // The gesture froze the crop it started with. The view it ends on produces
    // different tick labels. When the new trim would only remove margin, the frozen
    // crop is kept: a frame that never moves is worth a little extra padding, and the
    // next explicit evaluation re-trims. When it would cut content (the labels grew),
    // the crop is interpolated over a few frames instead of jumping.
    function settleGeometry() {
      var from = global.WoxiRender.svgGeometry(container);
      global.WoxiRender.fitGraphics(container);
      var to = global.WoxiRender.svgGeometry(container);
      if (!from || !to || from.viewBox === to.viewBox) {
        if (onFrame) onFrame(container);
        return;
      }
      var inside = to.x >= from.x - 1 && to.y >= from.y - 1
        && to.x + to.width <= from.x + from.width + 1
        && to.y + to.height <= from.y + from.height + 1;
      if (inside) {
        global.WoxiRender.setGeometry(container, from);
        if (onFrame) onFrame(container);
        return;
      }
      var started = Date.now();
      var duration = 160;
      function step() {
        if (disposed || gestureView) return;
        var t = Math.min(1, (Date.now() - started) / duration);
        var eased = t * t * (3 - 2 * t);
        var box = {
          x: from.x + (to.x - from.x) * eased,
          y: from.y + (to.y - from.y) * eased,
          width: from.width + (to.width - from.width) * eased,
          height: from.height + (to.height - from.height) * eased,
        };
        box.viewBox = [box.x, box.y, box.width, box.height].join(' ');
        global.WoxiRender.setGeometry(container, box);
        if (t < 1) {
          if (global.requestAnimationFrame) global.requestAnimationFrame(step);
          else global.setTimeout(step, 16);
        } else if (onFrame) {
          onFrame(container);
        }
      }
      step();
    }

    function endGesture() {
      gestureView = null;
      frozen = null;
      rect = null;
      settleGeometry();
    }

    function beginPinch() {
      var list = ids();
      if (list.length < 2) {
        pinch = null;
        return;
      }
      var a = pointers[list[0]];
      var b = pointers[list[1]];
      var area = rect || measure();
      if (!area) {
        pinch = null;
        return;
      }
      var cx = (a.x + b.x) / 2;
      var cy = (a.y + b.y) / 2;
      pinch = {
        startDistance: Math.hypot(a.x - b.x, a.y - b.y),
        view: currentView(),
        // The pinch anchor stays put while the fingers scale, so the picture does
        // not slide around under them.
        fx: (cx - area.left) / area.width,
        fy: (cy - area.top) / area.height,
      };
    }

    function onDown(event) {
      var view = viewOf(container);
      if (!view || dead || disposed) return;
      event.preventDefault();
      pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
      activeCount = ids().length;
      try {
        container.setPointerCapture(event.pointerId);
      } catch (err) {
        // the pointer may already be gone. Moves still arrive normally
      }
      if (activeCount === 1) beginGesture();
      if (activeCount >= 2) beginPinch();
    }

    function onMove(event) {
      var pointer = pointers[event.pointerId];
      if (!pointer) return;
      event.preventDefault();
      var previousX = pointer.x;
      var previousY = pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;

      if (pinch && ids().length >= 2) {
        var list = ids();
        var a = pointers[list[0]];
        var b = pointers[list[1]];
        var distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch.startDistance > 0) {
          var zoomed = zoomViewFrom(pinch.view, distance / pinch.startDistance,
            pinch.fx, pinch.fy);
          if (zoomed) {
            gestureView = zoomed;
            schedule(zoomed);
          }
        }
        return;
      }
      var next = panViewFrom(gestureView || currentView(), pointer.x - previousX,
        pointer.y - previousY, rect || measure());
      if (next) {
        gestureView = next;
        schedule(next);
      }
    }

    function onUp(event) {
      if (!pointers[event.pointerId]) return;
      delete pointers[event.pointerId];
      activeCount = ids().length;
      if (activeCount === 0) {
        endGesture();
        scheduleRefineCheck();
      }
      if (activeCount >= 2) beginPinch();
      else pinch = null;
    }

    // Stops the controller without telling the engine anything. `detach` collects
    // the handles so the caller can release them after the replacement has attached
    // (the same handle is addressed by the rebuilt markup).
    function dispose(silent) {
      if (disposed) return;
      disposed = true;
      dead = true;
      if (refineTimer) {
        global.clearTimeout(refineTimer);
        refineTimer = null;
      }
      queued = null;
      var view = viewOf(container);
      container.__woxiPlot = null;
      if (silent && view) fire(send, 'plot_release', { handle: view.id });
    }

    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onUp);
    container.addEventListener('pointercancel', onUp);
    container.classList.add('woxi-plot-ready');
    // One reference per controller, so the engine can drop the plot data when the
    // last one goes away. Fire and forget: the reply carries nothing we need.
    var initial = viewOf(container);
    if (initial) fire(send, 'plot_retain', { handle: initial.id });
    container.__woxiPlot = {
      schedule: schedule,
      pan: panView,
      zoom: zoomView,
      // Gesture-shaped helpers: they start from the newest requested range rather
      // than from what the DOM shows, which is what real drags do.
      panBy: function (dx, dy) {
        var next = panViewFrom(currentView(), dx, dy, containerRect(container));
        if (!next) return null;
        endGesture();
        schedule(next);
        return next;
      },
      zoomBy: function (factor, fx, fy) {
        var next = zoomViewFrom(currentView(), factor, fx, fy);
        if (!next) return null;
        endGesture();
        schedule(next);
        return next;
      },
      refine: function (view) {
        enqueue('refine', view);
      },
      view: currentView,
      send: send,
      dispose: dispose,
    };
  }

  // Stops every controller under `root` and returns what has to be released once
  // the replacement plots have attached.
  function detach(root) {
    var stale = [];
    if (!root || !root.querySelectorAll) return stale;
    var plots = root.querySelectorAll('.woxi-plot');
    for (var i = 0; i < plots.length; i++) {
      var controller = plots[i].__woxiPlot;
      if (!controller) continue;
      var view = viewOf(plots[i]);
      controller.dispose(false);
      if (view) stale.push({ id: view.id, send: controller.send });
    }
    return stale;
  }

  // Releases handles collected by `detach` (or an explicit list of ids) through the
  // send function the controller had.
  function release(stale) {
    if (!stale) return;
    for (var i = 0; i < stale.length; i++) {
      var entry = stale[i];
      if (entry && entry.send && typeof entry.id === 'number') {
        fire(entry.send, 'plot_release', { handle: entry.id });
      }
    }
  }

  function first(root) {
    return root.querySelector ? root.querySelector('.woxi-plot') : null;
  }

  global.WoxiPlot = {
    attach: attach,
    apply: apply,
    detach: detach,
    release: release,
    first: first,
    viewOf: viewOf,
    panView: panView,
    zoomView: zoomView,
    needsRefine: needsRefine,
    needsDensify: needsDensify,
    plotRect: containerRect,
    schedule: function (container, view) {
      if (container && container.__woxiPlot) container.__woxiPlot.schedule(view);
    },
    refine: function (container, view) {
      if (container && container.__woxiPlot) container.__woxiPlot.refine(view);
    },
  };
})(window);
