// The samples on their way to something drawable: the engine's base64 `u16` grid becomes points
// in the drawing space (data units, or their logarithm on a log axis) and a `Path2D` per series.
// `null` when the payload cannot be drawn whole - a series that will not decode, or a color the
// canvas cannot parse - because a curve with a piece missing is worse than no canvas at all.

// The grid divisor, part of the protocol. `tests/fixtures/protocol.json` pins it.
const U16_MAX = 65535;
const RGB_MAX = 255;

// `#RRGGBB` or `rgb(r, g, b)` in one comparable form.
function normalizeColor(text) {
  const value = String(text || "")
    .trim()
    .toLowerCase();
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(value);
  if (rgb) {
    let hex = "#";
    for (let i = 1; i <= 3; i += 1) {
      const part = Math.max(0, Math.min(RGB_MAX, parseInt(rgb[i], 10))).toString(16);
      hex += part.length === 1 ? "0" + part : part;
    }
    return hex;
  }
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  return "";
}

function decodeBase64(text) {
  let binary;
  try {
    binary = window.atob(text || "");
  } catch (err) {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Builds the drawable series from the payload, or null when it cannot be drawn whole.
function build(data) {
  if (!data || data.ok !== true || !data.s || !data.s.length) return null;
  if (!data.x || !data.y) return null;
  const xSpan = data.x[1] - data.x[0];
  const ySpan = data.y[1] - data.y[0];
  if (!(xSpan > 0) || !(ySpan > 0)) return null;
  const series = [];
  for (let i = 0; i < data.s.length; i += 1) {
    const raw = data.s[i];
    const color = normalizeColor(raw.c);
    if (!color) return null;
    const bytes = decodeBase64(raw.p);
    if (!bytes || bytes.length % 4 !== 0) return null;
    const count = bytes.length / 4;
    if (!count) continue;
    const points = new Float64Array(count * 2);
    const path = new Path2D();
    for (let j = 0; j < count; j += 1) {
      const at = j * 4;
      const u = (bytes[at] | (bytes[at + 1] << 8)) / U16_MAX;
      const v = (bytes[at + 2] | (bytes[at + 3] << 8)) / U16_MAX;
      const px = data.x[0] + u * xSpan;
      const py = data.y[0] + v * ySpan;
      points[j * 2] = px;
      points[j * 2 + 1] = py;
      if (j === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    }
    // A parametric or polar curve, and a contour, come back to their first point.
    if (
      count > 2 &&
      points[0] === points[(count - 1) * 2] &&
      points[1] === points[(count - 1) * 2 + 1]
    ) {
      path.closePath();
    }
    series.push({
      points: points,
      count: count,
      path: path,
      color: color,
      width: raw.w,
      opacity: typeof raw.o === "number" ? raw.o : 1,
      dashes: raw.da && raw.da.length ? raw.da : null,
      fill: raw.f ? { kind: raw.f.k, value: raw.f.v, color: raw.f.c, opacity: raw.f.o } : null,
      scatter: !!raw.sc,
      marker: raw.m || null,
      markerOpen: !!raw.mo,
      radius: raw.mr > 0 ? raw.mr : 0,
    });
  }
  if (!series.length) return null;
  return { series: series };
}

export { build, U16_MAX };
