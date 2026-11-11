// The keyboard's page data: every key on every page, the example templates, and the swipe
// graph between pages. Nothing here needs the DOM. `keyboard.js` renders and gestures it.

/**
 * @type {Object<string, { id: string, cols: number, keys: import('./types.js').KeySpec[] }>}
 */
const PAGES = {
  functions: {
    id: "functions",
    cols: 6,
    keys: [
      { label: "ArcSin", insert: "ArcSin[|]", classes: "fn", tooltip: "ArcSin[...]" },
      { label: "Pi", insert: "Pi", tooltip: "Pi" },
      { label: "Abs", insert: "Abs[|]", classes: "fn", tooltip: "Abs[...]" },
      { label: "Exp", insert: "Exp[|]", classes: "fn", tooltip: "Exp[...]" },
      { label: "*Degree", insert: "*Degree", tooltip: "Degrees: 30*Degree" },
      { label: "D", insert: "D[|]", classes: "fn", tooltip: "D[...]" },
      { label: "ArcCos", insert: "ArcCos[|]", classes: "fn", tooltip: "ArcCos[...]" },
      { label: "I", insert: "I", tooltip: "Imaginary unit" },
      { label: "Re", insert: "Re[|]", classes: "fn", tooltip: "Re[...]" },
      { label: "Im", insert: "Im[|]", classes: "fn", tooltip: "Im[...]" },
      { label: "!", insert: "!", tooltip: "Factorial" },
      { label: "Integrate", insert: "Integrate[|]", classes: "fn", tooltip: "Integrate[...]" },
      { label: "ArcTan", insert: "ArcTan[|]", classes: "fn", tooltip: "ArcTan[...]" },
      { label: "E", insert: "E", tooltip: "Euler number" },
      { label: "Floor", insert: "Floor[|]", classes: "fn", tooltip: "Floor[...]" },
      { label: "Ceiling", insert: "Ceiling[|]", classes: "fn", tooltip: "Ceiling[...]" },
      { label: "*^", insert: "*^", tooltip: "Scientific notation: 1.5*^3" },
      { label: "Limit", insert: "Limit[|]", classes: "fn", tooltip: "Limit[...]" },
      { label: "Log10", insert: "Log10[|]", classes: "fn", tooltip: "Log10[...]" },
      { label: "EulerGamma", insert: "EulerGamma", tooltip: "Euler-Mascheroni constant" },
      {
        label: "Manipulate",
        insert: "Manipulate[|]",
        classes: "fn",
        span: 2,
        tooltip: "Manipulate[...]",
      },
      { label: "Infinity", insert: "Infinity", tooltip: "Infinity" },
      { label: "Out", insert: "Out[|]", classes: "fn", tooltip: "Result of the previous entry" },
    ],
  },
  math: {
    id: "math",
    cols: 7,
    keys: [
      { label: "Sin", insert: "Sin[|]", classes: "fn", tooltip: "Sin[...]" },
      { label: "x" },
      { label: "7" },
      { label: "8" },
      { label: "9" },
      { label: "/", tooltip: "Divide" },
      { label: "( )", insert: "(|)", tooltip: "Parentheses" },
      { label: "Cos", insert: "Cos[|]", classes: "fn", tooltip: "Cos[...]" },
      { label: "y" },
      { label: "4" },
      { label: "5" },
      { label: "6" },
      { label: "*", tooltip: "Times" },
      { label: "^", tooltip: "Power" },
      { label: "Tan", insert: "Tan[|]", classes: "fn", tooltip: "Tan[...]" },
      { label: "T" },
      { label: "1" },
      { label: "2" },
      { label: "3" },
      { label: "-", tooltip: "Minus" },
      { label: "Sqrt", insert: "Sqrt[|]", classes: "fn", tooltip: "Sqrt[...]" },
      { label: "Log", insert: "Log[|]", classes: "fn", tooltip: "Natural logarithm Log[...]" },
      { label: "=", tooltip: "Set" },
      { label: "," },
      { label: "0" },
      { label: "." },
      { label: "+" },
      { label: "[ ]", insert: "[|]", tooltip: "Brackets" },
    ],
  },
  script: {
    id: "script",
    cols: 6,
    keys: [
      { label: "Do", insert: "Do[|]", classes: "fn", tooltip: "Do[...]" },
      { label: "Mod", insert: "Mod[|]", classes: "fn", tooltip: "Mod[...]" },
      { label: "<" },
      { label: ">" },
      { label: "#" },
      { label: "If", insert: "If[|]", classes: "fn", tooltip: "If[cond, then, else]" },
      { label: "While", insert: "While[|]", classes: "fn", tooltip: "While[test, body]" },
      { label: "$" },
      { label: "<=" },
      { label: ">=" },
      { label: "'", tooltip: "Derivative" },
      { label: "Which", insert: "Which[|]", classes: "fn", tooltip: "Which[c1, v1, c2, v2]" },
      { label: "Break", insert: "Break[]", classes: "fn", tooltip: "Break[]" },
      { label: "!" },
      { label: "!=" },
      { label: "==" },
      { label: ":" },
      { label: "Switch", insert: "Switch[|]", classes: "fn", tooltip: "Switch[expr, form, value]" },
      { label: "Return", insert: "Return[|]", classes: "fn", tooltip: "Return[...]" },
      { label: '" "', insert: '"|"', tooltip: "String" },
      { label: "&", tooltip: "Pure function" },
      { label: "|", insert: "\\|", tooltip: "Alternatives" },
      { label: "@", tooltip: "Prefix application" },
      { label: "]", tooltip: "Close bracket" },
    ],
  },
  letters: {
    id: "letters",
    cols: 10,
    keys: [
      { label: "q" },
      { label: "w" },
      { label: "e" },
      { label: "r" },
      { label: "t" },
      { label: "y" },
      { label: "u" },
      { label: "i" },
      { label: "o" },
      { label: "p" },
      { label: "a" },
      { label: "s" },
      { label: "d" },
      { label: "f" },
      { label: "g" },
      { label: "h" },
      { label: "j" },
      { label: "k" },
      { label: "l" },
      { label: "\u23CE", insert: "\n", tooltip: "New line" },
      { label: "z" },
      { label: "x" },
      { label: "c" },
      { label: "v" },
      { label: "b" },
      { label: "n" },
      { label: "m" },
      { label: "\u03B8", shiftLabel: "\u03C6", tooltip: "Theta (Phi with shift)" },
      { label: "_", shiftLabel: "/;", tooltip: "Blank (Condition /; with shift)" },
      {
        label: "?",
        shiftLabel: "/@",
        tooltip: "Information or PatternTest (?..., Map /@ with shift)",
      },
      {
        label: "\u21E7",
        action: "shift",
        classes: "fn",
        tooltip: "Shift: one capital, tap twice to lock",
      },
      { label: "`", shiftLabel: "~", tooltip: "Precision or context mark (Infix ~ with shift)" },
      { label: "%", shiftLabel: "->", tooltip: "Previous result (Rule -> with shift)" },
      { label: "\u2423", insert: " ", classes: "dim xs", span: 4, tooltip: "Space" },
      { label: ";", shiftLabel: ":=", tooltip: "CompoundExpression (SetDelayed := with shift)" },
      {
        label: "{ }",
        insert: "{|}",
        shiftLabel: "<| |>",
        shiftInsert: "<\\||\\|>",
        classes: "xs",
        tooltip: "List (Association with shift)",
      },
      {
        label: "\u21E7",
        action: "shift",
        classes: "fn",
        tooltip: "Shift: one capital, tap twice to lock",
      },
    ],
  },
  plot2d: {
    id: "plot2d",
    cols: 3,
    keys: [
      { label: "Plot", insert: "Plot[|]", classes: "fn", tooltip: "Function plot" },
      { label: "ListPlot", insert: "ListPlot[|]", classes: "fn", tooltip: "Scatter plot of data" },
      {
        label: "ContourPlot",
        insert: "ContourPlot[|]",
        classes: "fn",
        tooltip: "Zero contour of an equation",
      },
      {
        label: "ParametricPlot",
        insert: "ParametricPlot[|]",
        classes: "fn",
        tooltip: "Parametric curve",
      },
      { label: "ListLinePlot", insert: "ListLinePlot[|]", classes: "fn", tooltip: "Line graph" },
      {
        label: "DensityPlot",
        insert: "DensityPlot[|]",
        classes: "fn",
        tooltip: "Colored contour plot",
      },
      { label: "PolarPlot", insert: "PolarPlot[|]", classes: "fn", tooltip: "Polar plot" },
      {
        label: "BoxWhiskerChart",
        insert: "BoxWhiskerChart[|]",
        classes: "fn",
        tooltip: "Box plot",
      },
      {
        label: "ArrayPlot",
        insert: "ArrayPlot[|]",
        classes: "fn",
        tooltip: "Matrix drawn as an image",
      },
      { label: "VectorPlot", insert: "VectorPlot[|]", classes: "fn", tooltip: "Vector field" },
      { label: "Histogram", insert: "Histogram[|]", classes: "fn", tooltip: "Histogram of data" },
      { label: "Fit", insert: "Fit[|]", classes: "fn", tooltip: "Regression: fit the data" },
    ],
  },
  // level: plot 3D (swipe down twice)
  plot3d: {
    id: "plot3d",
    cols: 3,
    keys: [
      { label: "Plot3D", insert: "Plot3D[|]", classes: "fn", tooltip: "Surface of a function" },
      {
        label: "ListPlot3D",
        insert: "ListPlot3D[|]",
        classes: "fn",
        tooltip: "Surface from a table of heights",
      },
      { label: "RegionPlot", insert: "RegionPlot[|]", classes: "fn", tooltip: "Implicit region" },
      {
        label: "ParametricPlot3D",
        insert: "ParametricPlot3D[|]",
        classes: "fn",
        tooltip: "Parametric curve in 3D",
      },
      {
        label: "ListLinePlot3D",
        insert: "ListLinePlot3D[|]",
        classes: "fn",
        tooltip: "Line through points in 3D",
      },
      {
        label: "RegionPlot3D",
        insert: "RegionPlot3D[|]",
        classes: "fn",
        tooltip: "Implicit region in 3D",
      },
      {
        label: "SphericalPlot3D",
        insert: "SphericalPlot3D[|]",
        classes: "fn",
        tooltip: "Spherical coordinates",
      },
      { label: "ComplexPlot", insert: "ComplexPlot[|]", classes: "fn", tooltip: "Complex plane" },
      {
        label: "DiscretePlot3D",
        insert: "DiscretePlot3D[|]",
        classes: "fn",
        tooltip: "Values on a lattice",
      },
      {
        label: "VectorPlot3D",
        insert: "VectorPlot3D[|]",
        classes: "fn",
        tooltip: "Vector field in 3D",
      },
      {
        label: "ComplexPlot3D",
        insert: "ComplexPlot3D[|]",
        classes: "fn",
        tooltip: "Modulus of a complex function",
      },
      {
        label: "RevolutionPlot3D",
        insert: "RevolutionPlot3D[|]",
        classes: "fn",
        tooltip: "Surface of revolution",
      },
    ],
  },
};

// Ready-made examples, one tap each. The keys insert the call and let the assist
// bar name its arguments, and this list backs the sheet's Examples tab.
/** @type {import('./types.js').KeySpec[]} */
const EXAMPLES = [
  { label: "Plot", insert: "Plot[Sin[x], {x, -2 Pi, 2 Pi}]", tooltip: "Function plot" },
  { label: "ListPlot", insert: "ListPlot[{1, 4, 9, 16, 25}]", tooltip: "Scatter plot of data" },
  {
    label: "ContourPlot",
    insert: "ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}]",
    tooltip: "Implicit graph: the zero contour of the equation",
  },
  {
    label: "ParametricPlot",
    insert: "ParametricPlot[{Cos[3 t], Sin[2 t]}, {t, 0, 2 Pi}]",
    tooltip: "Parametric curve",
  },
  {
    label: "ListLinePlot",
    insert: "ListLinePlot[{3, 1, 4, 1, 5, 9, 2, 6}]",
    tooltip: "Line graph",
  },
  {
    label: "DensityPlot",
    insert: "DensityPlot[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]",
    tooltip: "Colored contour plot",
  },
  { label: "PolarPlot", insert: "PolarPlot[1 + Cos[3 t], {t, 0, 2 Pi}]", tooltip: "Polar plot" },
  {
    label: "BoxWhiskerChart",
    insert: "BoxWhiskerChart[RandomReal[NormalDistribution[0, 1], 200]]",
    tooltip: "Box plot",
  },
  {
    label: "ArrayPlot",
    insert: "ArrayPlot[Table[Mod[i + j, 3], {i, 16}, {j, 16}]]",
    tooltip: "Matrix drawn as an image",
  },
  {
    label: "VectorPlot",
    insert: "VectorPlot[{y, -x}, {x, -3, 3}, {y, -3, 3}]",
    tooltip: "Vector field",
  },
  {
    label: "Histogram",
    insert: "Histogram[RandomReal[NormalDistribution[0, 1], 300]]",
    tooltip: "Histogram of data",
  },
  {
    label: "Fit",
    insert:
      "data = {{1, 2}, {2, 5}, {3, 7}, {4, 9}}; Show[ListPlot[data], Plot[Fit[data, {1, x}, x], {x, 1, 4}]]",
    tooltip: "Regression: fit the data",
  },
  {
    label: "Plot3D",
    insert: "Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]",
    tooltip: "Surface of a function",
  },
  {
    label: "ListPlot3D",
    insert: "ListPlot3D[Table[Sin[i/2] Cos[j/2], {i, 12}, {j, 12}]]",
    tooltip: "Surface from a table of heights",
  },
  {
    label: "RegionPlot",
    insert: "RegionPlot[x^2 + y^2 < 1, {x, -1.5, 1.5}, {y, -1.5, 1.5}]",
    tooltip: "Implicit region",
  },
  {
    label: "ParametricPlot3D",
    insert: "ParametricPlot3D[{Cos[t], Sin[t], t}, {t, 0, 4 Pi}]",
    tooltip: "Parametric curve in 3D",
  },
  {
    label: "ListLinePlot3D",
    insert: "ListLinePlot3D[Table[{n, n^2, Sin[n]}, {n, 10}]]",
    tooltip: "Line through points in 3D",
  },
  {
    label: "RegionPlot3D",
    insert: "RegionPlot3D[x^2 + y^2 + z^2 < 1, {x, -1.5, 1.5}, {y, -1.5, 1.5}, {z, -1.5, 1.5}]",
    tooltip: "Implicit region in 3D",
  },
  {
    label: "SphericalPlot3D",
    insert: "SphericalPlot3D[1 + 0.4 Sin[4 u] Cos[4 v], {u, 0, Pi}, {v, 0, 2 Pi}]",
    tooltip: "Spherical coordinates",
  },
  {
    label: "ComplexPlot",
    insert: "ComplexPlot[Sin[z], {z, -3 - 3 I, 3 + 3 I}]",
    tooltip: "Complex plane",
  },
  {
    label: "DiscretePlot3D",
    insert: "DiscretePlot3D[Sin[x] Cos[y], {x, 0, 10}, {y, 0, 10}]",
    tooltip: "Values on a lattice",
  },
  {
    label: "VectorPlot3D",
    insert: "VectorPlot3D[{y, -x, z}, {x, -1, 1}, {y, -1, 1}, {z, -1, 1}]",
    tooltip: "Vector field in 3D",
  },
  {
    label: "ComplexPlot3D",
    insert: "ComplexPlot3D[Sin[z], {z, -2 - 2 I, 2 + 2 I}]",
    tooltip: "Modulus of a complex function",
  },
  {
    label: "RevolutionPlot3D",
    insert: "RevolutionPlot3D[Sqrt[x], {x, 0, 4}]",
    tooltip: "Surface of revolution",
  },
  { label: "Table", insert: "Table[i^2, {i, 10}]", tooltip: "A list of values" },
  { label: "Integrate", insert: "Integrate[Sin[x]^2, x]", tooltip: "Symbolic integral" },
  { label: "Solve", insert: "Solve[x^2 - 5 x + 6 == 0, x]", tooltip: "Roots of an equation" },
  {
    label: "Manipulate",
    insert: "Manipulate[Plot[Sin[a x], {x, 0, 2 Pi}], {a, 1, 5}]",
    tooltip: "Slider-driven plot",
  },
];

// Navigation is a graph of pages plus one remembered step. A swipe moves from the
// current page in that direction:
//
// math       left functions  right script  up letters   down plots 2D
// letters    left functions  right script  -            down math
// plots 2D   left functions  right script  up math      down plots 3D
// plots 3D   left functions  right script  up plots 2D  -
// functions  -               right math    up letters   down plots 2D
// script     left math       -             up letters   down plots 2D
//
// The page a swipe came from is remembered together with the direction that led to
// it, and only the exact opposite swipe uses that memory (so every swipe is undone by
// the opposite one). Nothing older is kept: after
// `plots 2D -> right -> script -> down -> plots 2D -> up -> script` a `left` shows the
// math page - the default in that direction - rather than plots 2D again. A swipe at
// the end of an axis changes nothing and keeps the remembered step.
const NEXT = {
  math: { left: "functions", right: "script", up: "letters", down: "plot2d" },
  letters: { left: "functions", right: "script", up: null, down: "math" },
  plot2d: { left: "functions", right: "script", up: "math", down: "plot3d" },
  plot3d: { left: "functions", right: "script", up: "plot2d", down: null },
  functions: { left: null, right: "math", up: "letters", down: "plot2d" },
  script: { left: "math", right: null, up: "letters", down: "plot2d" },
};
const OPPOSITE = { left: "right", right: "left", up: "down", down: "up" };

// The action bar above the keys: three pages, swiped left/right in a loop.
/**
 * @type {import('./types.js').KeySpec[][]}
 */
const BARS = [
  [
    { label: "Eval", action: "enter", classes: "ok", tooltip: "Evaluate this entry" },
    { label: "Plot", insert: "Plot[|]", classes: "fn", tooltip: "Plot[...]" },
    { label: "Solve", insert: "Solve[|]", classes: "fn", tooltip: "Solve[...]" },
    { label: "\u2190", action: "back", classes: "danger", tooltip: "Backspace" },
  ],
  // The state of Undo/Redo (dim when there is nothing to undo or redo) comes from the
  // app through `handlers.keyState`. The keys themselves live here, like every page.
  [
    { label: "Undo", action: "undo", classes: "fn", tooltip: "Undo the last edit" },
    { label: "Redo", action: "redo", classes: "fn", tooltip: "Redo the undone edit" },
    { label: "Insert", action: "new", tooltip: "New entry below" },
    { label: "Delete", action: "delete", classes: "fn danger", tooltip: "Delete this entry" },
  ],
  [
    { label: "Cut", action: "cut", tooltip: "Cut the selection (or the whole entry)" },
    { label: "Copy", action: "copy", tooltip: "Copy the selection (or the whole entry)" },
    { label: "Paste", action: "paste", tooltip: "Paste from the clipboard" },
    { label: "Format", action: "format", tooltip: "Normalize the spacing of this entry" },
  ],
];

export { BARS, EXAMPLES, NEXT, OPPOSITE, PAGES };
