// Curated argument shapes for the typing bar and the sheet.
//
// Woxi's registry has a description and sometimes an arity, but no parameter names, so
// the slot names below are presentation only: the caret is placed by counting commas,
// nothing is validated. Slot roles (iterator, option, data, ...) come from the shape of
// the slot text, and `prototypes_request` adds the concrete examples it learns from the
// shipped gallery.

(function (global) {
  'use strict';

  // Curated argument names, one or more variants per head. Woxi's data has a
  // description and sometimes an arity, but no parameter names, so these are
  // presentation only: the caret is placed by counting commas, nothing is validated.
  var PROTOTYPES = {
    Plot: ['f, {x, xmin, xmax}', '{f1, f2, ...}, {x, xmin, xmax}'],
    Plot3D: ['f, {x, xmin, xmax}, {y, ymin, ymax}', '{f1, f2, ...}, {x, xmin, xmax}, {y, ymin, ymax}'],
    ContourPlot: ['f, {x, xmin, xmax}, {y, ymin, ymax}', '{eqns, vars}'],
    DensityPlot: 'f, {x, xmin, xmax}, {y, ymin, ymax}',
    RegionPlot: 'cond, {x, xmin, xmax}, {y, ymin, ymax}',
    VectorPlot: '{vx, vy}, {x, xmin, xmax}, {y, ymin, ymax}',
    StreamPlot: '{vx, vy}, {x, xmin, xmax}, {y, ymin, ymax}',
    PolarPlot: 'r, {t, tmin, tmax}',
    ParametricPlot: '{xexpr, yexpr}, {t, tmin, tmax}',
    ParametricPlot3D: '{xexpr, yexpr, zexpr}, {t, tmin, tmax}',
    SphericalPlot3D: 'r, {u, umin, umax}, {v, vmin, vmax}',
    RevolutionPlot3D: 'f, {x, xmin, xmax}',
    ComplexPlot: 'f, {z, zmin, zmax}',
    ComplexPlot3D: 'f, {z, zmin, zmax}',
    DiscretePlot3D: 'f, {x, xmin, xmax}, {y, ymin, ymax}',
    ListPlot: 'data, opts',
    ListLinePlot: 'data, opts',
    ListPlot3D: 'data, opts',
    ArrayPlot: 'array',
    Histogram: 'data, opts',
    BoxWhiskerChart: 'data, opts',
    Table: 'expr, {i, imax}',
    Sum: 'expr, {i, imax}',
    Product: 'expr, {i, imax}',
    NSum: 'expr, {i, imax}',
    Integrate: 'f, x',
    D: 'f, x',
    Solve: ['eqns, vars', 'eqns, vars, domain'],
    NSolve: 'eqns, vars',
    NDSolve: 'eqns, y, {x, xmin, xmax}',
    FindRoot: 'eqns, {x, x0}',
    Minimize: 'f, vars',
    Maximize: 'f, vars',
    Limit: 'f, x -> x0',
    Series: 'f, {x, x0, n}',
    Fit: 'data, basis, vars',
    Manipulate: 'expr, {u, umin, umax}',
    Animate: 'expr, {u, umin, umax}',
    Show: 'graphics',
    Graphics: 'primitives',
    Piecewise: 'pairs, x',
    Simplify: 'expr',
    Expand: 'expr',
    Factor: 'expr',
    Length: 'expr',
    Total: 'list',
    Map: 'f, list',
    Select: 'list, test',
    Cases: 'list, pattern',
    NestList: 'f, x0, n',
    Range: 'n',
    RandomReal: 'n',
    Print: 'expr',
  };

  // Example values per slot shape. The engine adds the concrete values it learns from
  // the gallery, which is why these are only a starting point.
  var ROLE_EXAMPLES = {
    expression: ['Sin[x]', 'x^2', '1/(1 + x)'],
    number: ['10', '0.5'],
    data: ['{1, 4, 9, 16}', '{{1, 2}, {2, 5}, {3, 7}}'],
    list: ['{1, 2, 3}', '{Sin[x], Cos[x]}'],
    symbol: ['x'],
    options: ['PlotRange -> All'],
    option: ['Automatic'],
  };

  var STATUS_LABEL = {
    implemented: 'implemented',
    partial: 'partially implemented',
    not_implemented: 'not implemented',
    not_planned: 'not supported',
    unknown: '',
  };

  // Symbols that stand for a value rather than a call. Accepting one inserts just the
  // name: `Pi[` or `False[` would be nonsense. System variables (`$Name`) are values too.
  var CONSTANTS = [
    'All', 'Automatic', 'Catalan', 'ComplexInfinity', 'Degree', 'E', 'EulerGamma',
    'False', 'Glaisher', 'GoldenRatio', 'I', 'Indeterminate', 'Infinity', 'Khinchin',
    'MachinePrecision', 'None', 'Null', 'Pi', 'True',
  ];

  // Whether accepting `name` should open a call (`Sin[`) or insert the name alone
  // (`Pi`, a session variable, `$Failed`).
  function isCallName(name, type) {
    if (!name) return false;
    if (type === 'variable') return false;
    if (name.charAt(0) === '$') return false;
    return CONSTANTS.indexOf(name) < 0;
  }

  // Splits a prototype into its top-level slots (`f, {x, a, b}` -> two slots).
  function slotsOf(prototype) {
    var slots = [];
    var depth = 0;
    var current = '';
    for (var i = 0; i < prototype.length; i += 1) {
      var ch = prototype.charAt(i);
      if (ch === '{' || ch === '[' || ch === '(') depth += 1;
      if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        slots.push(current.trim());
        current = '';
        continue;
      }
      current += ch;
    }
    if (current.trim()) slots.push(current.trim());
    return slots;
  }

  // slot shapes

  function roleOf(text) {
    if (/->|:>/.test(text)) return 'option';
    if (text.charAt(0) === '{') {
      if (/^\{[^}]*->/.test(text)) return 'options';
      // An iterator names a variable and a bound: `{x, xmin, xmax}`, `{i, imax}`,
      // `{x, x0, n}`. `{f1, f2, ...}`, `{vx, vy}` and `{eqns, vars}` are lists.
      if (/^\{\s*[A-Za-z][A-Za-z0-9]*\s*,\s*(?:[A-Za-z][A-Za-z0-9]*(?:min|max)|[A-Za-z][A-Za-z0-9]*0|-?[0-9.]+|Pi|Infinity)\s*[,}]/.test(text)) {
        return 'iterator';
      }
      return 'list';
    }
    if (text === 'n') return 'number';
    if (text === 'vars' || text === 'vars?' || text === 'sym') return 'symbol';
    if (text === 'data' || text === 'array') return 'data';
    if (text === 'list') return 'list';
    if (text === 'opts') return 'options';
    return 'expression';
  }

  function iteratorVariable(text) {
    var match = /^\{\s*([A-Za-z][A-Za-z0-9]*)/.exec(text);
    return match ? match[1] : '';
  }

  function examplesFor(slot) {
    if (slot.role === 'iterator') {
      var variable = iteratorVariable(slot.text) || 'x';
      return ['{' + variable + ', -5, 5}', '{' + variable + ', 0, 2 Pi}'];
    }
    if (slot.role === 'option') return [slot.text + ' -> Automatic'];
    return (ROLE_EXAMPLES[slot.role] || ROLE_EXAMPLES.expression).slice();
  }

  function curatedVariant(text) {
    return slotsOf(text).map(function (slotText) {
      var slot = { text: slotText, role: roleOf(slotText), examples: [] };
      slot.examples = examplesFor(slot);
      return slot;
    });
  }

  function roleLabel(role) {
    if (role === 'iterator') return 'iterator';
    if (role === 'option') return 'option';
    if (role === 'options') return 'options';
    if (role === 'number') return 'number';
    if (role === 'data') return 'data';
    if (role === 'list') return 'list';
    if (role === 'symbol') return 'symbol';
    return 'expression';
  }

  global.WoxiPrototypes = {
    PROTOTYPES: PROTOTYPES,
    ROLE_EXAMPLES: ROLE_EXAMPLES,
    STATUS_LABEL: STATUS_LABEL,
    slotsOf: slotsOf,
    roleOf: roleOf,
    iteratorVariable: iteratorVariable,
    examplesFor: examplesFor,
    curatedVariant: curatedVariant,
    roleLabel: roleLabel,
    isCallName: isCallName,
  };
})(window);
