// The 3D box, its field-dependent axis edges, ticks and labels. Woxi chooses
// the nearest bottom corner for the x/y axes and the leftmost or rightmost
// vertical edge for z. Doing the same keeps the marks on the visible side when
// the camera is rotated. The marks and labels are painted in the 2D overlay so
// they stay horizontal and have a constant pixel size.

import { PLOT_FONT } from "./plot-metrics.js";
import {
  boxCorners,
  cameraGrid,
  formatTick,
  minorStep,
  niceStep,
  projectedExtent,
  projectPoint,
  tickValues,
  valuesForStep,
} from "./plot3d-maths.js";

const TICK_MARK = 4;
const MINOR_TICK_MARK = 2.5;
const TICK_LABEL_OFFSET = 10;
const TICK_LABEL_SIDE_OFFSET = TICK_LABEL_OFFSET * 0.6;
const TICK_FONT_SIZE = 10;
// Room left between two labels that would otherwise touch.
const LABEL_GAP = 1.5;
// The least distance between two consecutive labels along their edge.
const LABEL_MIN_ALONG = TICK_FONT_SIZE * 1.5;
// Keep a label whose anchor is just outside the projected box. The card itself
// clips the rest of the label at its edge.
const LABEL_CLIP_MARGIN_X = 40;
const LABEL_CLIP_MARGIN_Y = 20;

const BOX_EDGES = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3],
  [4, 5],
  [4, 6],
  [5, 7],
  [6, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

function cssColor(value, alpha) {
  return "rgba(" + value[0] + "," + value[1] + "," + value[2] + "," + alpha + ")";
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// The labeled ticks of an axis that stay, so that consecutive ones are at least
// LABEL_MIN_ALONG apart on screen. The first and last labels are kept: an axis
// without its end labels reads as a different range.
function thinLabels(axis, project) {
  const kept = axis.ticks.filter((tick) => tick.text);
  for (let i = 1; i < kept.length; i += 1) {
    const a = project(kept[i - 1].at);
    const b = project(kept[i].at);
    if (Math.hypot(b.x - a.x, b.y - a.y) < LABEL_MIN_ALONG) {
      // Drop the neighbour that is not an end label (the earlier one of the two
      // when both are interior, so the set stays evenly spread).
      kept.splice(i === kept.length - 1 ? i - 1 : i, 1);
      i = Math.max(0, i - 2);
    }
  }
  return new Set(kept);
}

// How coarsely the camera orientations are sampled when measuring the room the
// labels need. They are at most a few pixels apart from their neighbours.
const PAD_AZIMUTHS = 8;
const PAD_ELEVATIONS = 5;

function pushSegment(out, a, b) {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

function axisPoint(origin, end, low, high, flipped, value) {
  if (!(high > low)) return origin;
  let t = (value - low) / (high - low);
  if (flipped) t = 1 - t;
  return [
    origin[0] + (end[0] - origin[0]) * t,
    origin[1] + (end[1] - origin[1]) * t,
    origin[2] + (end[2] - origin[2]) * t,
  ];
}

function ticksOn(origin, end, low, high, flipped, step) {
  const ticks = [];
  const major = tickValues(low, high);
  const minor = Math.abs(minorStep(step));
  if (!(minor > 0) || !Number.isFinite(minor)) return ticks;
  const all = valuesForStep(low, high, minor);
  for (const value of all) {
    const isMajor = major.some((at) => Math.abs(at - value) < minor * 1e-6);
    ticks.push({
      at: axisPoint(origin, end, low, high, flipped, value),
      major: isMajor,
      text: isMajor ? formatTick(value, step) : "",
    });
  }
  return ticks;
}

// Box edges and the axis edges/ticks for the current view and camera.
export function buildAxes(scene, view, camera, theme) {
  const axisColor = theme.axis;
  const labelColor = theme.label;
  const corners = boxCorners(scene.box);
  const positions = [];
  const axisPositions = [];
  if (scene.boxed) {
    for (const [a, b] of BOX_EDGES) pushSegment(positions, corners[a], corners[b]);
  }
  const axes = [];
  if (scene.axes) {
    const project = (point) => projectPoint(point, camera, 1, 1);
    // Each axis lies on the bottom edge of the face that is nearer the viewer (x on
    // a y-face, y on an x-face). Deciding per axis, by the depth of the face's middle,
    // means an axis changes edge only when its own face is the nearer one. The
    // labels then hop from the back edge to the front one at the view where both
    // edges project onto nearly the same line. Woxi's rule (the nearest corner) ties
    // two corners near the diagonal of the view and flips the labels along their
    // edge in one frame, which a static picture never shows and a rotation does.
    const nearY =
      project([0, scene.box[1], -scene.box[2]]).depth >
      project([0, -scene.box[1], -scene.box[2]]).depth
        ? 1
        : -1;
    const nearX =
      project([scene.box[0], 0, -scene.box[2]]).depth >
      project([-scene.box[0], 0, -scene.box[2]]).depth
        ? 1
        : -1;
    const low = [-scene.box[0], -scene.box[1], -scene.box[2]];
    // The x edge runs along x on the near y-face, from its low-x corner. The y edge
    // along y on the near x-face, from its low-y corner.
    const xOrigin = [low[0], nearY * scene.box[1], low[2]];
    const xEnd = [scene.box[0], nearY * scene.box[1], low[2]];
    const yOrigin = [nearX * scene.box[0], low[1], low[2]];
    const yEnd = [nearX * scene.box[0], scene.box[1], low[2]];
    // The z edge is the leftmost or rightmost vertical edge, so its labels sit beside
    // the silhouette rather than over the surface (Woxi's rule). Of the two, the one
    // farther from the box centre's projection is taken.
    let minX = Infinity;
    let maxX = -Infinity;
    let minIndex = 0;
    let maxIndex = 0;
    let sumX = 0;
    for (let index = 0; index < 4; index += 1) {
      const x = project(corners[index]).x;
      sumX += x;
      if (x < minX) {
        minX = x;
        minIndex = index;
      }
      if (x > maxX) {
        maxX = x;
        maxIndex = index;
      }
    }
    const zIndex = Math.abs(minX - sumX / 4) >= Math.abs(maxX - sumX / 4) ? minIndex : maxIndex;
    const zOrigin = corners[zIndex];
    const zEnd = [zOrigin[0], zOrigin[1], scene.box[2]];

    const definitions = [
      { axis: 0, origin: xOrigin, end: xEnd, flipped: false },
      { axis: 1, origin: yOrigin, end: yEnd, flipped: false },
      { axis: 2, origin: zOrigin, end: zEnd, flipped: false },
    ];
    // Woxi draws the three axis lines over the box edges. They follow the
    // camera, so the client has to keep this buffer separate from the fixed
    // 12 box edges.
    for (const definition of definitions) {
      pushSegment(axisPositions, definition.origin, definition.end);
    }
    for (const definition of definitions) {
      const [low, high] = view[definition.axis];
      const step = niceStep(high - low);
      if (!(step > 0) || !Number.isFinite(step)) continue;
      axes.push({
        ...definition,
        step,
        ticks: ticksOn(definition.origin, definition.end, low, high, definition.flipped, step),
      });
    }
  }
  return {
    positions: new Float32Array(positions),
    axisPositions: new Float32Array(axisPositions),
    axes,
    axisColor,
    labelColor,
  };
}

// The screen frame of one axis: where its ends land, and the directions its marks
// and labels go. An axis seen end-on has no frame (it is shorter than a pixel).
function axisFrames(axes, camera, scaleX, scaleY, width, height) {
  const project = (point) => {
    const p = projectPoint(point, camera, scaleX, scaleY);
    return { x: (p.x * 0.5 + 0.5) * width, y: (1 - (p.y * 0.5 + 0.5)) * height };
  };
  const center = project([0, 0, 0]);
  const frames = [];
  for (const axis of axes.axes) {
    const a = project(axis.origin);
    const b = project(axis.end);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (!(length > 1)) continue;
    // Woxi fixes the mark side to the projected axis direction and sends
    // only the labels away from the box centre.
    const markX = -dy / length;
    const markY = dx / length;
    let perpX = markX;
    let perpY = markY;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    if (perpX * (center.x - midX) + perpY * (center.y - midY) > 0) {
      perpX = -perpX;
      perpY = -perpY;
    }
    const anchor = perpX < -0.5 ? "end" : perpX > 0.5 ? "start" : "center";
    frames.push({ axis, project, markX, markY, perpX, perpY, anchor });
  }
  return frames;
}

// The labels these frames paint, with the box each one occupies, in card pixels.
function layoutLabels(frames, ctx, width, height) {
  // Labels already placed, on any axis. The end labels of two axes meet at their
  // shared corner, and a foreshortened axis lands all of its labels on one spot.
  // A label that would overlap one already drawn is left out (Woxi thins the
  // labels the same way).
  const placed = [];
  const labels = [];
  for (const frame of frames) {
    const labeled = thinLabels(frame.axis, frame.project);
    for (const tick of frame.axis.ticks) {
      if (!tick.text || !labeled.has(tick)) continue;
      const p = frame.project(tick.at);
      const offset = frame.anchor === "center" ? TICK_LABEL_OFFSET : TICK_LABEL_SIDE_OFFSET;
      const x = p.x + frame.perpX * offset;
      const y = p.y + frame.perpY * offset;
      if (
        x < -LABEL_CLIP_MARGIN_X ||
        x > width + LABEL_CLIP_MARGIN_X ||
        y < -LABEL_CLIP_MARGIN_Y ||
        y > height + LABEL_CLIP_MARGIN_Y
      )
        continue;
      const textWidth = ctx.measureText(tick.text).width;
      const left =
        frame.anchor === "end" ? x - textWidth : frame.anchor === "start" ? x : x - textWidth / 2;
      const box = {
        left: left - LABEL_GAP,
        right: left + textWidth + LABEL_GAP,
        top: y - TICK_FONT_SIZE / 2 - LABEL_GAP,
        bottom: y + TICK_FONT_SIZE / 2 + LABEL_GAP,
      };
      if (placed.some((other) => overlaps(other, box))) continue;
      placed.push(box);
      labels.push({ text: tick.text, x, y, anchor: frame.anchor, box });
    }
  }
  return labels;
}

// How far the tick labels reach past the box's projected rectangle on each side,
// in card pixels: the room the fit has to leave for them. Measured over the reachable
// camera orientations, because the card's scale has to hold at all of them.
export function labelPads(scene, view, camera, scaleX, scaleY, width, height, ctx) {
  const pads = { left: 0, right: 0, top: 0, bottom: 0 };
  const savedFont = ctx.font;
  ctx.font = TICK_FONT_SIZE + "px " + PLOT_FONT;
  ctx.textBaseline = "middle";
  for (const turned of cameraGrid(camera, PAD_AZIMUTHS, PAD_ELEVATIONS)) {
    const extent = projectedExtent(scene.box, turned);
    const halfX = (extent.x / scaleX) * 0.5 * width;
    const halfY = (extent.y / scaleY) * 0.5 * height;
    const frames = axisFrames(
      buildAxes(scene, view, turned, scene.theme),
      turned,
      scaleX,
      scaleY,
      width,
      height
    );
    for (const label of layoutLabels(frames, ctx, width, height)) {
      pads.left = Math.max(pads.left, width / 2 - halfX - label.box.left);
      pads.right = Math.max(pads.right, label.box.right - (width / 2 + halfX));
      pads.top = Math.max(pads.top, height / 2 - halfY - label.box.top);
      pads.bottom = Math.max(pads.bottom, label.box.bottom - (height / 2 + halfY));
    }
  }
  ctx.font = savedFont;
  return pads;
}

// Paint the tick marks and labels on the 2D overlay.
export function drawAxesOverlay(ctx, axes, camera, scaleX, scaleY, width, height) {
  const frames = axisFrames(axes, camera, scaleX, scaleY, width, height);
  ctx.font = TICK_FONT_SIZE + "px " + PLOT_FONT;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = cssColor(axes.axisColor, 1);
  ctx.fillStyle = cssColor(axes.labelColor, 1);
  for (const frame of frames) {
    for (const tick of frame.axis.ticks) {
      const mark = tick.major ? TICK_MARK : MINOR_TICK_MARK;
      const p = frame.project(tick.at);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + frame.markX * mark, p.y + frame.markY * mark);
      ctx.stroke();
    }
  }
  for (const label of layoutLabels(frames, ctx, width, height)) {
    ctx.textAlign = label.anchor;
    ctx.fillText(label.text, label.x, label.y);
  }
}
