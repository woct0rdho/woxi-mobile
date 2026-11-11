// The picture's own box, read the same way by the renderer's trim and by the canvas: one reader
// for both. (The scene's geometry - axes, ticks, frame - comes from `engine/src/plot/scene/`.
// The client no longer walks the SVG for it.)

function finite(value) {
  return typeof value === "number" && isFinite(value);
}

// The picture's own box, `{ x, y, width, height }`, or null when it states none this can read.
// All four numbers have to parse: a box with one of them missing is not a box, and the caller
// falls back to the element's width and height.
function viewBoxOf(svg) {
  const box = String(svg.getAttribute("viewBox") || "")
    .trim()
    .split(/[ ,]+/);
  if (box.length !== 4) return null;
  const numbers = box.map(parseFloat);
  for (let i = 0; i < numbers.length; i += 1) {
    if (!finite(numbers[i])) return null;
  }
  return { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] };
}

export { viewBoxOf };
