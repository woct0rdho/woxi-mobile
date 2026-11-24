// Interactive 3D plots. One WebGL2 canvas draws the triangles, mesh and box. One 2D
// canvas draws the tick labels. A gesture changes the camera or the data-view uniforms,
// then rebuilds only the local tick geometry - there is no engine request on the gesture
// path - so a 3D plot reaches the display rate even when its source samples were expensive.
//
// The geometry (data-space vertices, triangle indices, face colours, line segments), the
// initial view, sampled coverage and card size come from the engine's `plot3d` item. See
// docs/plot3d.md.

import { buildAxes, drawAxesOverlay, labelPads } from "./plot3d-axes.js";
import { buildGeometry, lineGeometry, lineMesh } from "./plot3d-geometry.js";
import {
  boxMapping,
  cameraBasis,
  clamp,
  depthRange,
  envelopeAspect,
  fitScale,
  fitView,
  MAX_ELEVATION,
  PERSPECTIVE_EPSILON,
  projectedEnvelope,
  transformView,
  viewportPlanePoint,
  zoomCeiling,
  zoomFloor,
  zoomView,
} from "./plot3d-maths.js";

const STATS_LIMIT = 240;
const controllers = new Map();
// One finger's rotation sensitivity, in radians per CSS pixel. This is a
// gesture constant, not a projection constant. It is deliberately independent
// of the card size.
const ROTATE_RADIANS_PER_PIX = 0.009;
const DRAG_THRESHOLD_PX = 4;
const DOUBLE_TAP_MS = 300;
// The card keeps a pixel of room around the picture, as Woxi pads a 3D SVG.
const CARD_PADDING_PX = 1;
// A label measured at one fit may move a little when the fit shrinks. This keeps
// the second pass from leaving it a fraction of a pixel over the edge.
const LABEL_PAD_SLACK = 2;
// The smallest view span relative to the initial view, so repeated pinches
// cannot shrink the data view indefinitely. Zoom-out is bounded by the
// sampled/gesture bounds instead.
const MIN_SPAN_FRACTION = 0.05;
// NDC depth biases. They are small fractions of the near/far span in practice.
// Keep them below the smallest visible depth separation.
const LINE_DEPTH_BIAS = 0.004;
const BOX_DEPTH_BIAS = 0.002;
// Keep the backing store bounded on high-density devices. The card still fits
// the CSS size, this only limits the render resolution.
const MAX_DEVICE_PIXEL_RATIO = 2.5;
// The fixed two-sided light, in camera coordinates.
const LIGHT_RIGHT = 0.35;
const LIGHT_UP = 0.8;
const LIGHT_TOWARD = 0.45;
const LIGHT_DIFFUSE_EXPONENT = 0.85;
const LIGHT_AMBIENT = 0.55;
const LIGHT_DIFFUSE = 0.8;
const VIEW_CLIP_EPSILON = 1 + 1e-4;

function normalize(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(vector, factor) {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

function cloneView(view) {
  return view.map(([low, high]) => [low, high]);
}

// The controller keeps scene metadata separately from the original payload.
// The payload is retained for context restoration. Decoded geometry is not
// retained twice. Keeping the base64 here would also be a second reference,
// not a copy, because the notebook item already owns the strings.
function sceneMetadata(scene) {
  return {
    camera: scene.camera,
    ranges: scene.ranges,
    box: scene.box,
    theme: scene.theme,
    axes: scene.axes,
    boxed: scene.boxed,
    coverage: scene.coverage,
    card: scene.card,
  };
}

// Flat triangles from the indexed scene.
function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || "3D shader compile failed");
  }
  return shader;
}

// uData selects the data-to-box mapping for surface and mesh vertices. Box
// edges and axis lines are already in box units and keep uData = 0.
function program(gl) {
  const vertex = `#version 300 es
  in vec3 aPos; in vec3 aNormal; in vec4 aColor;
  uniform vec3 uRight; uniform vec3 uUp; uniform vec3 uToward;
  uniform vec3 uViewLow; uniform vec3 uViewSpan; uniform vec3 uBox; uniform float uData;
  uniform vec2 uScale; uniform float uDist; uniform float uPerspective;
  uniform float uNear; uniform float uFar; uniform float uDepthBias;
  out vec3 vNormal; out vec4 vColor; out vec3 vUnit; out float vClip;
  void main() {
    vec3 p = aPos;
    vec3 unit = vec3(0.0);
    if (uData > 0.5) {
      unit = (aPos - uViewLow) / max(uViewSpan, vec3(1e-9)) * 2.0 - 1.0;
      p = unit * uBox;
    }
    float sx = dot(p, uRight);
    float sy = dot(p, uUp);
    float d = dot(p, uToward);
    float factor = uPerspective > 0.5 && uDist - d > uDist * ${PERSPECTIVE_EPSILON} ? uDist / (uDist - d) : 1.0;
    float distanceToEye = uDist - d;
    float z = (distanceToEye - uNear) / (uFar - uNear) * 2.0 - 1.0;
    gl_Position = vec4(sx * factor / uScale.x, sy * factor / uScale.y, z - uDepthBias, 1.0);
    vNormal = length(aNormal) > 1e-6 ? normalize(aNormal) : vec3(0.0, 0.0, 1.0);
    vColor = aColor;
    vUnit = unit;
    vClip = uData;
  }`;
  const fragment = `#version 300 es
  precision mediump float;
  in vec3 vNormal; in vec4 vColor; in vec3 vUnit; in float vClip;
  uniform vec3 uLightDir; uniform float uUnlit;
  out vec4 fragColor;
  void main() {
    if (vClip > 0.5 && any(greaterThan(abs(vUnit), vec3(${VIEW_CLIP_EPSILON})))) discard;
    vec4 color = vColor;
    if (uUnlit < 0.5) {
      vec3 normal = normalize(vNormal);
      float diffuse = pow(abs(dot(normal, normalize(uLightDir))), ${LIGHT_DIFFUSE_EXPONENT});
      color.rgb *= ${LIGHT_AMBIENT} + ${LIGHT_DIFFUSE} * diffuse;
      color.rgb = min(color.rgb, vec3(1.0));
    }
    fragColor = color;
  }`;
  const link = gl.createProgram();
  const vertexShader = compile(gl, gl.VERTEX_SHADER, vertex);
  const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(link, vertexShader);
  gl.attachShader(link, fragmentShader);
  gl.linkProgram(link);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(link, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(link) || "3D shader link failed");
  }
  return {
    program: link,
    aPos: gl.getAttribLocation(link, "aPos"),
    aNormal: gl.getAttribLocation(link, "aNormal"),
    aColor: gl.getAttribLocation(link, "aColor"),
    u: {
      right: gl.getUniformLocation(link, "uRight"),
      up: gl.getUniformLocation(link, "uUp"),
      toward: gl.getUniformLocation(link, "uToward"),
      viewLow: gl.getUniformLocation(link, "uViewLow"),
      viewSpan: gl.getUniformLocation(link, "uViewSpan"),
      box: gl.getUniformLocation(link, "uBox"),
      data: gl.getUniformLocation(link, "uData"),
      scale: gl.getUniformLocation(link, "uScale"),
      dist: gl.getUniformLocation(link, "uDist"),
      perspective: gl.getUniformLocation(link, "uPerspective"),
      near: gl.getUniformLocation(link, "uNear"),
      far: gl.getUniformLocation(link, "uFar"),
      depthBias: gl.getUniformLocation(link, "uDepthBias"),
      light: gl.getUniformLocation(link, "uLightDir"),
      unlit: gl.getUniformLocation(link, "uUnlit"),
    },
  };
}

function upload(gl, mesh, usage = gl.STATIC_DRAW) {
  const buffers = {};
  const bind = (name, data, size, type, normalized) => {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    buffers[name] = { buffer, size, type, normalized };
  };
  bind("aPos", mesh.positions, 3, gl.FLOAT, false);
  bind("aNormal", mesh.normals, 3, gl.FLOAT, false);
  bind("aColor", mesh.colors, 4, gl.UNSIGNED_BYTE, true);
  let indexBuffer = null;
  if (mesh.order) {
    indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.order, gl.STATIC_DRAW);
  }
  return { buffers, count: mesh.count, indexBuffer };
}

function deleteMesh(gl, mesh) {
  if (!gl || !mesh) return;
  for (const attr of Object.values(mesh.buffers || {})) gl.deleteBuffer(attr.buffer);
  if (mesh.indexBuffer) gl.deleteBuffer(mesh.indexBuffer);
}

function drawMesh(gl, shader, mesh, mode, unlit, depthBias, data) {
  if (!mesh || !mesh.count) return;
  const { buffers } = mesh;
  for (const name of ["aPos", "aNormal", "aColor"]) {
    const attr = buffers[name];
    gl.bindBuffer(gl.ARRAY_BUFFER, attr.buffer);
    gl.enableVertexAttribArray(shader[name]);
    gl.vertexAttribPointer(shader[name], attr.size, attr.type, attr.normalized, 0, 0);
  }
  gl.uniform1f(shader.u.unlit, unlit ? 1 : 0);
  gl.uniform1f(shader.u.depthBias, depthBias || 0);
  gl.uniform1f(shader.u.data, data ? 1 : 0);
  if (mesh.indexBuffer) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indexBuffer);
    gl.drawElements(mode, mesh.count, gl.UNSIGNED_INT, 0);
  } else {
    gl.drawArrays(mode, 0, mesh.count);
  }
}

function sortTransparent(gl, mesh, view, box, toward, indexBuffer) {
  if (!mesh || !indexBuffer || !mesh.positions || !mesh.order || !(mesh.count > 0)) return;
  const triangles = mesh.count / 3;
  const depth = mesh.depth || (mesh.depth = new Float32Array(triangles));
  const positions = mesh.positions;
  const { scale, offset } = boxMapping(view, box);
  for (let t = 0; t < triangles; t++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const at = t * 9 + k * 3;
      x += positions[at] * scale[0] + offset[0];
      y += positions[at + 1] * scale[1] + offset[1];
      z += positions[at + 2] * scale[2] + offset[2];
    }
    depth[t] = (x * toward[0] + y * toward[1] + z * toward[2]) / 3;
  }
  const order = mesh.sorted || (mesh.sorted = new Uint32Array(triangles));
  for (let i = 0; i < triangles; i++) order[i] = i;
  order.sort((a, b) => depth[a] - depth[b]);
  const sorted = mesh.order;
  for (let i = 0; i < triangles; i++) {
    sorted[i * 3] = order[i] * 3;
    sorted[i * 3 + 1] = order[i] * 3 + 1;
    sorted[i * 3 + 2] = order[i] * 3 + 2;
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, sorted);
}

function cardStyle(scene) {
  const card = scene.card;
  const width = Number(card.width);
  const height = Number(card.height);
  // A 3D picture's height follows the box unless ImageSize pins it, as Woxi fits a
  // 3D SVG to its box. The box's size in the card has to hold at every camera
  // orientation, so its shape is the envelope the box sweeps when it is rotated,
  // not the shape it has in the first frame: a card of the first frame's shape
  // would crop the box as soon as a finger turned it.
  const aspect = envelopeAspect(
    projectedEnvelope(scene.box, {
      az: scene.camera.az,
      el: scene.camera.el,
      dist: scene.camera.dist,
      perspective: scene.camera.perspective !== false,
    })
  );
  const parts = [];
  if (
    typeof scene.theme.background === "string" &&
    /^#[0-9a-fA-F]{6}$/.test(scene.theme.background)
  ) {
    parts.push("--woxi-plot3d-bg: " + scene.theme.background);
  }
  if (card.full) {
    parts.push("--woxi-plot3d-width: 100%", "--woxi-plot3d-max: 100%");
  } else if (width > 0) {
    parts.push("--woxi-plot3d-width: " + width + "px", "--woxi-plot3d-max: 100%");
  }
  parts.push("--woxi-plot3d-aspect: " + (width > 0 && height > 0 ? width / height : aspect));
  return ' style="' + parts.join("; ") + '"';
}

function isRange(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] < value[1]
  );
}

// The scene fields the markup and controller need before any GL work. *
export function isScene(scene) {
  return (
    scene &&
    typeof scene === "object" &&
    scene.camera &&
    Number.isFinite(scene.camera.az) &&
    Number.isFinite(scene.camera.el) &&
    Number.isFinite(scene.camera.dist) &&
    scene.camera.dist > 0 &&
    Array.isArray(scene.ranges) &&
    scene.ranges.length === 3 &&
    scene.ranges.every(isRange) &&
    Array.isArray(scene.coverage) &&
    scene.coverage.length === 3 &&
    scene.coverage.every(isRange) &&
    Array.isArray(scene.box) &&
    scene.box.length === 3 &&
    scene.box.every((value) => Number.isFinite(value) && value > 0) &&
    scene.theme &&
    typeof scene.theme === "object" &&
    Array.isArray(scene.theme.axis) &&
    scene.theme.axis.length === 3 &&
    Array.isArray(scene.theme.label) &&
    scene.theme.label.length === 3 &&
    scene.card &&
    typeof scene.card === "object" &&
    typeof scene.vertices === "string" &&
    typeof scene.indices === "string" &&
    typeof scene.colors === "string" &&
    typeof scene.lines === "string" &&
    typeof scene.lineColors === "string"
  );
}

function axesMetadata(axes) {
  return {
    axes: axes.axes,
    axisColor: axes.axisColor,
    labelColor: axes.labelColor,
  };
}

// The container markup for one scene. The geometry lives in the engine item, not the DOM.
export function html(scene, index) {
  if (!isScene(scene)) {
    return '<div class="woxi-out woxi-out-error">Invalid 3D scene</div>';
  }
  return (
    '<div class="woxi-out woxi-out-graphic woxi-plot3d" data-woxi-plot3d="' +
    index +
    '"' +
    cardStyle(scene) +
    '><canvas class="woxi-plot3d-gl"></canvas><canvas class="woxi-plot3d-overlay"></canvas></div>'
  );
}

class Plot3D {
  constructor(root, scene) {
    this.root = root;
    this.scene = sceneMetadata(scene);
    // Keep the original payload so a lost context can rebuild its GPU state.
    // The strings are shared with the notebook item, not copied.
    this.source = scene;
    this.canvas = root.querySelector(".woxi-plot3d-gl");
    this.overlay = root.querySelector(".woxi-plot3d-overlay");
    this.camera = {
      az: scene.camera.az,
      el: scene.camera.el,
    };
    this.view = cloneView(this.scene.ranges);
    this.bounds = scene.coverage.map(([low, high], axis) => [
      Math.min(low, this.scene.ranges[axis][0]),
      Math.max(high, this.scene.ranges[axis][1]),
    ]);
    // The initial view is the reference for the absolute zoom limit.
    this.minSpans = this.scene.ranges.map(([low, high]) => (high - low) * MIN_SPAN_FRACTION);
    this.counters = {
      frames: 0,
      paint: [],
      spinMs: 0,
      spinDraws: 0,
    };
    this.pointers = new Map();
    this.gesture = null;
    this.moved = false;
    this.frame = null;
    this.lastTap = 0;
    this.gl = null;
    this.disposed = false;
    this.contextLost = null;
    this.contextRestored = null;
    this.inputHandlers = null;

    this.root.classList.remove?.("woxi-plot3d-unsupported");
    try {
      this.setupWebGL();
    } catch (err) {
      console.warn("3D WebGL setup failed", err);
      this.releaseWebGL();
      this.disposed = true;
      this.root.classList.add("woxi-plot3d-unsupported");
      return;
    }
    this.contextLost = (event) => {
      if (this.disposed) return;
      // Stop the default permanent loss so the browser can restore the
      // context. Keep the controller registered and hidden until then.
      event.preventDefault();
      this.pointers.clear();
      this.gesture = null;
      this.moved = false;
      this.lastTap = 0;
      if (this.frame !== null) {
        window.cancelAnimationFrame(this.frame);
        this.frame = null;
      }
      this.gl = null;
      this.uploaded = null;
      this.shader = null;
      this.root.classList.add("woxi-plot3d-unsupported");
    };
    this.contextRestored = () => {
      if (this.disposed) return;
      try {
        // The card was hidden during the loss. Restore its layout before
        // measuring it, or resize() would see a zero-sized element.
        this.root.classList.remove?.("woxi-plot3d-unsupported");
        this.setupWebGL();
        // Force the backing-store dimensions to be restored with the new context.
        this.displayWidth = 0;
        this.displayHeight = 0;
        this.resize();
        this.requestDraw();
      } catch (err) {
        console.warn("3D WebGL restore failed", err);
        this.root.classList.add("woxi-plot3d-unsupported");
        this.dispose();
      }
    };
    this.canvas.addEventListener("webglcontextlost", this.contextLost);
    this.canvas.addEventListener("webglcontextrestored", this.contextRestored);
    try {
      this.resize();
      this.bindInput();
      this.watchResize();
    } catch (err) {
      console.warn("3D plot setup failed", err);
      this.root.classList.add("woxi-plot3d-unsupported");
      this.dispose();
    }
  }

  setupWebGL() {
    const gl = this.canvas.getContext("webgl2", {
      antialias: true,
      alpha: true,
      depth: true,
    });
    if (!gl) throw new Error("3D plots require WebGL2");
    this.gl = gl;
    const geometry = buildGeometry(this.source);
    const meshLines = lineGeometry(this.source);
    const builtAxes = buildAxes(this.scene, this.view, this.cameraState(), this.scene.theme);
    this.axes = axesMetadata(builtAxes);
    this.shader = program(gl);
    const boxMesh = lineMesh(builtAxes.positions, this.scene.theme.axis);
    const axisMesh = lineMesh(builtAxes.axisPositions, this.scene.theme.axis);
    this.uploaded = {
      opaque: upload(gl, geometry.opaque),
      transparent: upload(gl, geometry.transparent),
      lines: upload(gl, meshLines),
      box: upload(gl, boxMesh),
      axes: upload(gl, axisMesh, gl.DYNAMIC_DRAW),
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  watchResize() {
    if (typeof ResizeObserver === "function") {
      try {
        this.observer = new ResizeObserver(() => this.resize());
        this.observer.observe(this.root);
        return;
      } catch (err) {
        console.warn("3D plot ResizeObserver unavailable", err);
      }
    }
    this.resizeHandler = () => this.resize();
    window.addEventListener("resize", this.resizeHandler);
  }

  resize() {
    if (!this.gl) return;
    const rect = this.root.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(MAX_DEVICE_PIXEL_RATIO, window.devicePixelRatio || 1);
    if (this.displayWidth === width && this.displayHeight === height && this.dpr === dpr) return;
    this.displayWidth = width;
    this.displayHeight = height;
    this.dpr = dpr;
    for (const canvas of [this.canvas, this.overlay]) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
    }
    this.envelope = projectedEnvelope(this.scene.box, this.cameraState());
    this.fitProjection();
    if (this.gesture?.kind === "pinch") this.startPinch();
    this.requestDraw();
  }

  // Fits the box and its tick labels into the card. The scale holds at every camera
  // orientation (the box is sized by the envelope it sweeps when rotated), so turning
  // the plot neither crops the box nor resizes it, and the labels stay inside the card
  // at every angle.
  fitProjection() {
    const width = this.displayWidth;
    const height = this.displayHeight;
    const envelope = this.envelope || projectedEnvelope(this.scene.box, this.cameraState());
    const ctx = this.overlay.getContext("2d");
    const pad = (extra) => ({
      left: CARD_PADDING_PX + extra.left,
      right: CARD_PADDING_PX + extra.right,
      top: CARD_PADDING_PX + extra.top,
      bottom: CARD_PADDING_PX + extra.bottom,
    });
    let scale = fitScale(envelope.x, envelope.y, width, height, pad({}));
    if (ctx) {
      // A label sits a fixed number of pixels from its tick, so shrinking the box does
      // not shrink the room the labels need by as much: measure again once it has.
      for (let pass = 0; pass < 2; pass += 1) {
        const pads = labelPads(
          this.scene,
          this.view,
          this.cameraState(),
          scale,
          scale * (height / width),
          width,
          height,
          ctx
        );
        pads.left += LABEL_PAD_SLACK;
        pads.right += LABEL_PAD_SLACK;
        pads.top += LABEL_PAD_SLACK;
        pads.bottom += LABEL_PAD_SLACK;
        scale = fitScale(envelope.x, envelope.y, width, height, pad(pads));
      }
    }
    this.scaleX = scale;
    this.scaleY = scale * (height / width);
  }

  refreshAxes() {
    const builtAxes = buildAxes(
      this.scene,
      this.view,
      this.cameraState(this.basis()),
      this.scene.theme
    );
    this.axes = axesMetadata(builtAxes);
    if (!this.gl || !this.uploaded?.axes) return;
    const axisMesh = lineMesh(builtAxes.axisPositions, this.scene.theme.axis);
    const existing = this.uploaded.axes;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, existing.buffers.aPos.buffer);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, axisMesh.positions);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
  }

  requestDraw() {
    if (this.frame !== null || this.disposed) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  basis() {
    return cameraBasis(this.camera.az, this.camera.el);
  }

  cameraState(basis) {
    return {
      az: this.camera.az,
      el: this.camera.el,
      dist: this.scene.camera.dist,
      perspective: this.scene.camera.perspective !== false,
      ...(basis ? { basis } : {}),
    };
  }

  draw() {
    if (!this.gl) return;
    const start = window.performance.now();
    const gl = this.gl;
    const width = this.displayWidth;
    const height = this.displayHeight;
    if (!width || !height) {
      this.resize();
      return;
    }
    const camera = this.cameraState(this.basis());
    this.refreshAxes();
    const [near, far] = depthRange(camera.dist, this.scene.box);
    const light = normalize(
      add(
        add(scale(camera.basis.right, LIGHT_RIGHT), scale(camera.basis.up, LIGHT_UP)),
        scale(camera.basis.toward, LIGHT_TOWARD)
      )
    );
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.shader.program);
    gl.uniform3fv(this.shader.u.right, camera.basis.right);
    gl.uniform3fv(this.shader.u.up, camera.basis.up);
    gl.uniform3fv(this.shader.u.toward, camera.basis.toward);
    gl.uniform3fv(
      this.shader.u.viewLow,
      this.view.map(([low]) => low)
    );
    gl.uniform3fv(
      this.shader.u.viewSpan,
      this.view.map(([low, high]) => high - low)
    );
    gl.uniform3fv(this.shader.u.box, this.scene.box);
    gl.uniform2f(this.shader.u.scale, this.scaleX, this.scaleY);
    gl.uniform1f(this.shader.u.dist, camera.dist);
    gl.uniform1f(this.shader.u.perspective, camera.perspective ? 1 : 0);
    gl.uniform1f(this.shader.u.near, near);
    gl.uniform1f(this.shader.u.far, far);
    gl.uniform3fv(this.shader.u.light, light);
    gl.depthMask(true);
    drawMesh(gl, this.shader, this.uploaded.opaque, gl.TRIANGLES, false, 0, true);
    if (this.uploaded.transparent.count) {
      sortTransparent(
        gl,
        this.uploaded.transparent,
        this.view,
        this.scene.box,
        camera.basis.toward,
        this.uploaded.transparent.indexBuffer
      );
      gl.depthMask(false);
      drawMesh(gl, this.shader, this.uploaded.transparent, gl.TRIANGLES, false, 0, true);
      gl.depthMask(true);
    }
    drawMesh(gl, this.shader, this.uploaded.lines, gl.LINES, true, LINE_DEPTH_BIAS, true);
    drawMesh(gl, this.shader, this.uploaded.box, gl.LINES, true, BOX_DEPTH_BIAS, false);
    // Woxi paints the three axes over the surface. Keep the box depth-tested,
    // but draw the axis lines last without depth so a back-facing z edge does
    // not disappear behind the mesh.
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    drawMesh(gl, this.shader, this.uploaded.axes, gl.LINES, true, 0, false);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    this.drawLabels(camera);
    this.counters.frames += 1;
    this.counters.paint.push(window.performance.now() - start);
    if (this.counters.paint.length > STATS_LIMIT) this.counters.paint.shift();
  }

  drawLabels(camera) {
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.displayWidth, this.displayHeight);
    if (this.axes.axes.length === 0) return;
    drawAxesOverlay(
      ctx,
      this.axes,
      camera,
      this.scaleX,
      this.scaleY,
      this.displayWidth,
      this.displayHeight
    );
  }

  startPinch() {
    const points = Array.from(this.pointers.values());
    if (points.length < 2) return;
    const distance = Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
    const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    this.gesture = {
      kind: "pinch",
      distance,
      center,
      view: cloneView(this.view),
      basis: this.basis(),
      scaleX: this.scaleX,
      scaleY: this.scaleY,
    };
  }

  bindInput() {
    const root = this.root;
    const local = (event) => {
      const rect = root.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const planePoint = (point, basis, scaleX, scaleY) =>
      viewportPlanePoint(
        point.x,
        point.y,
        this.displayWidth,
        this.displayHeight,
        basis,
        scaleX,
        scaleY
      );
    const handlePinch = () => {
      if (this.gesture?.kind !== "pinch") return;
      const points = Array.from(this.pointers.values());
      if (points.length < 2) return;
      const start = this.gesture;
      const distance = Math.max(
        1,
        Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
      );
      const center = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const scale = clamp(
        distance / start.distance,
        zoomFloor(start.view, this.bounds),
        zoomCeiling(start.view, this.minSpans)
      );
      const from = planePoint(start.center, start.basis, start.scaleX, start.scaleY);
      const to = planePoint(center, start.basis, start.scaleX, start.scaleY);
      const translate = [to[0] - scale * from[0], to[1] - scale * from[1], to[2] - scale * from[2]];
      this.view = fitView(transformView(start.view, this.scene.box, scale, translate), this.bounds);
      this.requestDraw();
    };
    const capture = (event) => {
      if (!root.setPointerCapture) return;
      try {
        root.setPointerCapture(event.pointerId);
      } catch (err) {
        // The pointer is already gone.
      }
    };
    const down = (event) => {
      if (!this.gl) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      const point = local(event);
      capture(event);
      this.pointers.set(event.pointerId, point);
      if (this.pointers.size === 1) {
        this.moved = false;
        this.gesture = {
          kind: "orbit",
          start: point,
          camera: { az: this.camera.az, el: this.camera.el },
        };
      } else {
        // A second or third finger starts a fresh pinch over the current
        // pair, rather than inheriting a pair and midpoint from before.
        this.moved = true;
        this.gesture = null;
        this.startPinch();
      }
    };
    const move = (event) => {
      if (!this.gl || !this.pointers.has(event.pointerId)) return;
      event.preventDefault();
      const point = local(event);
      this.pointers.set(event.pointerId, point);
      const gesture = this.gesture;
      if (this.pointers.size === 1 && gesture?.kind === "orbit") {
        const dx = point.x - gesture.start.x;
        const dy = point.y - gesture.start.y;
        if (!this.moved) {
          if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
          this.moved = true;
        }
        this.camera.az = gesture.camera.az - dx * ROTATE_RADIANS_PER_PIX;
        this.camera.el = clamp(
          gesture.camera.el + dy * ROTATE_RADIANS_PER_PIX,
          -MAX_ELEVATION,
          MAX_ELEVATION
        );
        this.requestDraw();
      } else if (this.pointers.size >= 2 && gesture?.kind === "pinch") {
        this.moved = true;
        handlePinch();
      }
    };
    root.addEventListener("pointerdown", down, { passive: false });
    root.addEventListener("pointermove", move, { passive: false });
    const release = (event) => {
      if (!this.gl || !this.pointers.has(event.pointerId)) return;
      this.pointers.delete(event.pointerId);
      if (this.pointers.size === 0) {
        const now = Date.now();
        if (!this.moved && now - this.lastTap < DOUBLE_TAP_MS) this.reset();
        this.lastTap = this.moved ? 0 : now;
        this.gesture = null;
      } else if (this.pointers.size === 1) {
        const point = Array.from(this.pointers.values())[0];
        this.gesture = {
          kind: "orbit",
          start: point,
          camera: { az: this.camera.az, el: this.camera.el },
        };
      } else {
        // Three fingers down to two: restart from the remaining pair, not
        // from the pair that was active before the lift.
        this.moved = true;
        this.gesture = null;
        this.startPinch();
      }
    };
    root.addEventListener("pointerup", release);
    root.addEventListener("pointercancel", release);
    root.addEventListener("lostpointercapture", release);
    this.inputHandlers = { down, move, release };
  }

  reset() {
    this.camera.az = this.scene.camera.az;
    this.camera.el = this.scene.camera.el;
    this.view = cloneView(this.scene.ranges);
    this.requestDraw();
  }

  spin(frames, dy) {
    const total = Math.max(1, frames || 60);
    const step = dy === undefined ? 0.01 : dy;
    const started = window.performance.now();
    const startFrames = this.counters.frames;
    let frame = 0;
    return new Promise((resolve) => {
      const tick = () => {
        this.camera.az += step;
        this.requestDraw();
        frame += 1;
        if (frame >= total) {
          this.counters.spinMs = window.performance.now() - started;
          this.counters.spinDraws = this.counters.frames - startFrames;
          resolve(undefined);
        } else window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    });
  }

  pinchBy(factor) {
    const scale = clamp(
      Number(factor) || 1.2,
      zoomFloor(this.view, this.bounds),
      zoomCeiling(this.view, this.minSpans)
    );
    this.view = fitView(zoomView(this.view, this.scene.box, scale), this.bounds);
    this.requestDraw();
  }

  counts() {
    return {
      faces: ((this.uploaded?.opaque?.count || 0) + (this.uploaded?.transparent?.count || 0)) / 3,
      segments: (this.uploaded?.lines?.count || 0) / 2,
    };
  }

  resetStats() {
    this.counters.frames = 0;
    this.counters.paint = [];
    this.counters.spinMs = 0;
    this.counters.spinDraws = 0;
  }

  state() {
    const counts = this.counts();
    return {
      faces: counts.faces,
      segments: counts.segments,
      camera: {
        az: this.camera.az,
        el: this.camera.el,
        dist: this.scene.camera.dist,
        perspective: this.scene.camera.perspective !== false,
      },
      box: this.scene.box,
      ranges: cloneView(this.view),
      coverage: cloneView(this.scene.coverage),
      bounds: cloneView(this.bounds),
      initialView: cloneView(this.scene.ranges),
      card: this.scene.card,
      // What the card's layout gave the projection: the size the fit worked with and
      // the scale it chose (the box's projected half-extents over these are its share
      // of the card).
      display: { width: this.displayWidth, height: this.displayHeight },
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      frames: this.counters.frames,
      spinMs: this.counters.spinMs,
    };
  }

  dispose() {
    this.disposed = true;
    this.releaseWebGL();
    controllers.delete(this.root);
    if (this.observer) this.observer.disconnect();
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.contextLost) {
      this.canvas.removeEventListener("webglcontextlost", this.contextLost);
      this.contextLost = null;
    }
    if (this.contextRestored) {
      this.canvas.removeEventListener("webglcontextrestored", this.contextRestored);
      this.contextRestored = null;
    }
    if (this.inputHandlers) {
      this.root.removeEventListener("pointerdown", this.inputHandlers.down);
      this.root.removeEventListener("pointermove", this.inputHandlers.move);
      this.root.removeEventListener("pointerup", this.inputHandlers.release);
      this.root.removeEventListener("pointercancel", this.inputHandlers.release);
      this.root.removeEventListener("lostpointercapture", this.inputHandlers.release);
      this.inputHandlers = null;
    }
    this.pointers.clear();
    this.gesture = null;
    this.source = null;
    if (this.frame !== null) {
      window.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  releaseWebGL() {
    if (this.gl) {
      const gl = this.gl;
      for (const mesh of Object.values(this.uploaded || {})) deleteMesh(gl, mesh);
      if (this.shader?.program) gl.deleteProgram(this.shader.program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      this.gl = null;
    }
    this.uploaded = null;
    this.shader = null;
  }
}

// Attach every rendered 3D plot to its scene. Idempotent for the same DOM.
export function attach(root, items) {
  if (!root) return;
  pruneDetached();
  items = items || [];
  const plots = root.querySelectorAll(".woxi-plot3d");
  for (let index = 0; index < plots.length; index += 1) {
    const rootPlot = plots[index];
    if (controllers.has(rootPlot)) continue;
    const key = rootPlot.getAttribute("data-woxi-plot3d");
    if (key === null) continue;
    const scene = items[Number(key)]?.plot3d;
    if (!isScene(scene)) continue;
    let controller;
    try {
      controller = new Plot3D(rootPlot, scene);
    } catch (err) {
      console.warn("3D scene skipped", err);
      rootPlot.classList.add("woxi-plot3d-unsupported");
      continue;
    }
    if (!controller.disposed) controllers.set(rootPlot, controller);
  }
}
export function detach(root) {
  if (!root) return;
  for (const plot of root.querySelectorAll(".woxi-plot3d")) {
    controllers.get(plot)?.dispose();
  }
}

export function firstController() {
  pruneDetached();
  return controllers.values().next().value || null;
}

export function lastController() {
  pruneDetached();
  const values = Array.from(controllers.values());
  return values.length ? values[values.length - 1] : null;
}

function pruneDetached() {
  for (const [root, controller] of Array.from(controllers)) {
    if (controller.disposed || !root.isConnected) controller.dispose();
  }
}

export function perfLine(controller) {
  if (!controller) return "plot3d: no controller";
  const counts = controller.counts();
  const paint = controller.counters.paint.slice().sort((a, b) => a - b);
  const median = paint.length ? paint[Math.floor(paint.length / 2)] : 0;
  return (
    "plot3d faces=" +
    counts.faces +
    " segments=" +
    counts.segments +
    " frames=" +
    controller.counters.frames +
    " paint=" +
    Math.round(median * 10) / 10 +
    "ms" +
    (controller.counters.spinMs
      ? " spin=" +
        Math.round(controller.counters.spinMs) +
        "ms/" +
        Math.round((1000 * controller.counters.spinDraws) / controller.counters.spinMs) +
        "fps"
      : "")
  );
}
