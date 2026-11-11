// A headless measure for the plot label layout, vendored from Woxi's own padding table
// (`woxi-0.4.0/src/functions/plot_padding.rs`, ARIAL_ASCII). The app measures the face with a
// canvas. The tests install this measure with `setFallbackMeasure` so a layout can be checked
// without a DOM. The widths are pinned to the values Woxi's own padding tests assert by
// `tests/plot-metrics.test.js`, so a Woxi change fails a test instead of quietly changing a
// rail.

// Advance widths in 1/2048 em for printable ASCII.
const ARIAL_ASCII = [
  569, 569, 727, 1139, 1139, 1821, 1366, 391, 682, 682, 797, 1196, 569, 682, 569, 569, 1139, 1139,
  1139, 1139, 1139, 1139, 1139, 1139, 1139, 1139, 569, 569, 1196, 1196, 1196, 1139, 2079, 1366,
  1366, 1479, 1479, 1366, 1251, 1593, 1479, 569, 1024, 1366, 1139, 1706, 1479, 1593, 1366, 1593,
  1479, 1366, 1251, 1479, 1366, 1933, 1366, 1366, 1251, 569, 569, 569, 961, 1139, 682, 1139, 1139,
  1024, 1139, 1139, 569, 1139, 1139, 455, 455, 1024, 455, 1706, 1139, 1139, 1139, 1139, 682, 1024,
  569, 1139, 1024, 1479, 1024, 1024, 1024, 684, 532, 684, 1196,
];
// Woxi's tick-label minus is a little wider than Arial's hyphen, and a long integer part is split
// into digit blocks by thin spaces.
const TICK_MINUS_EM = 0.63027;
const DIGIT_BLOCK_GAP_EM = 285 / 2048;

function charWidthEm(c) {
  const code = c.codePointAt(0);
  if (code >= 0x20 && code <= 0x7e) return ARIAL_ASCII[code - 0x20] / 2048;
  if (c === "\u2212" || c === "\u00d7") return 1196 / 2048;
  if ((code >= 0x200b && code <= 0x200d) || (code >= 0x2061 && code <= 0x2063)) return 0;
  return 1139 / 2048;
}

// Woxi's `tick_label_width`: a number is measured the way the front end typesets it (a wide
// minus, digit blocks of three split by thin spaces), other text by its character advances. A
// multi-line label measures its widest line.
function estimateWidth(text, size) {
  let widest = 0;
  const lines = String(text).split("\n");
  for (let l = 0; l < lines.length; l += 1) {
    const chars = Array.from(lines[l]);
    const numeric =
      chars.length > 0 &&
      chars.every(function (c) {
        return /[0-9.\-\u2212]/.test(c);
      }) &&
      chars.some(function (c) {
        return /[0-9]/.test(c);
      });
    let em = 0;
    let intDigits = 0;
    let inInt = true;
    for (let i = 0; i < chars.length; i += 1) {
      const c = chars[i];
      if (numeric && (c === "-" || c === "\u2212")) {
        em += TICK_MINUS_EM;
      } else if (numeric && c === ".") {
        inInt = false;
        em += charWidthEm(c);
      } else {
        if (numeric && inInt) intDigits += 1;
        em += charWidthEm(c);
      }
    }
    if (numeric && intDigits >= 5) em += Math.floor((intDigits - 1) / 3) * DIGIT_BLOCK_GAP_EM;
    if (em * size > widest) widest = em * size;
  }
  return widest;
}

export { estimateWidth };
