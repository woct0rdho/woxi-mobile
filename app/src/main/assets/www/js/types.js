// The shapes a plot's numbers move through, as JSDoc types checked by `pnpm types`
// (`tsc --checkJs`, no emit). A rectangle used as a range, a screen pixel used as a user
// unit, or a payload field that does not exist is a type error instead of a gesture that
// drifts - which is the class of mistake this subsystem kept making.
//
// Nothing here runs: `export {}` keeps the file a module so its types can be imported with
// `@param {import('./types.js').Scene} scene`.
//
// Use minified field names in payloads crossing engine-frontend boundary, and self-evident
// field names in frontend internal payloads.

/**
 * A closed interval, in the space the field that holds it names: data units, or their
 * logarithm (`decades`) on a logarithmic axis.
 * @typedef {[number, number]} Range
 */

/**
 * The range a plot is drawn at: the finger's view, or the picture's own.
 * @typedef {{ id: number, x: Range, y: Range }} View
 */

/**
 * A rectangle in the picture's own user units (SVG units).
 * @typedef {{ x: number, y: number, width: number, height: number }} UserRect
 */

/**
 * One value line: an axis or a grid line. `v` is the value on the axis `o` it sits on, in the
 * drawing space (data units, or decades). `k` says whether it is an axis (`'a'`, it has ticks, so
 * the client clamps it to the rails and hangs its ticks off it) or a grid line (`'g'`, drawn at
 * its value). An axis line's `v` is its origin (0, a user's `AxesOrigin`, or the low end of a log
 * axis), not the edge the renderer clamped it to when the origin is outside the range.
 * @typedef {{ o: 'x'|'y', v: number, k: 'a'|'g', c: string, w: number, d?: number[] | null }} SceneLine
 */

/**
 * The label the renderer printed for a tick: its text and its offset from the tick's base.
 * @typedef {{ t: string, dx: number, dy: number, a: string, s: number, c: string }} TickLabel
 */

/**
 * One tick: `v` on the axis `o`, its mark from `b` to `e` across that axis in user units, its
 * position `at` along its own axis (where the scene's own view put it), its style, and the label
 * when the renderer printed one. `k` is `'a'` when the tick hangs off an axis line (the client
 * places its base at that line's position for the current view, clamped to the rails) or `'f'`
 * when it sits on a frame edge (the base is the place the picture drew it and `s` names the
 * edge). Both kinds take their position along the axis or edge from `v` through the current
 * view's mapping, so a gesture moves them with the curve.
 * @typedef {{
 *   o: 'x'|'y',
 *   v: number,
 *   at: number,
 *   b: number,
 *   e: number,
 *   k: 'a'|'f',
 *   s?: 'l'|'r'|'t'|'b' | null,
 *   c: string,
 *   w: number,
 *   l: TickLabel | null,
 * }} SceneTick
 */

/**
 * A static text (a title or an axis label). `r` is the rotation the renderer asked for, in
 * degrees clockwise about `(r.x, r.y)` in the picture's y-down space. A multi-line label is one
 * text per line: the engine takes the renderer's `<tspan>` children apart and gives each its own
 * baseline.
 * @typedef {{
 *   t: string,
 *   x: number,
 *   y: number,
 *   a: string,
 *   s: number,
 *   c: string,
 *   r?: { a: number, x: number, y: number } | null,
 * }} SceneText
 */

/**
 * One side's room inside the frame, in user units.
 * @typedef {{ left: number, right: number, top: number, bottom: number }} Rails
 */

/**
 * A picture as the engine extracted it (`engine/src/plot/scene/`), in the picture's own user
 * units. This is the one object the canvas draws.
 *
 * `frame` is `[x, y, width, height]`. `rect` is the data rectangle in range order
 * `[x0, y_of_lowest, x1, y_of_highest]`, where the lowest data value maps to the larger user y
 * (SVG y grows down). `box` is the picture's viewBox, `[x, y, width, height]`. The first scene's
 * layout fixes the frame's shape. `normalize` maps the frame, the box and every user-unit number
 * of a later scene onto it, so the box's width stays the reference for the sample stroke/dash/
 * marker fractions. `rails` is added by `normalize`: the room inside the frame a stuck axis
 * keeps for its labels and marks.
 * @typedef {{
 *   box: [number, number, number, number],
 *   frame: [number, number, number, number],
 *   rect: [number, number, number, number],
 *   bg: string,
 *   fs?: { c: string, w: number } | null,
 *   rails?: Rails,
 *   lines: SceneLine[],
 *   ticks: SceneTick[],
 *   texts: SceneText[],
 * }} Scene
 */

/**
 * The layout a plot keeps: the first scene's frame shape at the origin, the card's box (the
 * frame plus the bands the frame's own labels need and the padding), the rails - the room inside
 * the frame that a stuck axis keeps for its labels and its marks, per side - and the padding.
 * @typedef {{
 *   frame: [number, number, number, number],
 *   box: [number, number, number, number],
 *   rails: Rails,
 *   pad: number,
 * }} Layout
 */

/**
 * Data (or decades) to viewport pixels: `screenX = a * x + b`, `screenY = d * y + f`.
 * @typedef {{ a: number, b: number, d: number, f: number }} Affine
 */

/**
 * The affine a canvas draw uses. The data rectangle the picture clips its curves to is
 * `scene.rect`. It is not copied into the mapping.
 * @typedef {{ a: number, b: number, d: number, f: number }} Mapping
 */

/**
 * Which axes are logarithmic, as the payload reports them.
 * @typedef {{ x: boolean, y: boolean }} LogAxes
 */

/**
 * One series of the point layer, as the engine sent it and the canvas draws it.
 * @typedef {{
 *   points: Float64Array,
 *   count: number,
 *   path: Path2D,
 *   color: string,
 *   width: number,
 *   opacity: number,
 *   dashes: number[] | null,
 *   fill: { kind: 'axis'|'bottom'|'top'|'value', value?: number, color: string, opacity: number } | null,
 *   scatter: boolean,
 *   marker: string | null,
 *   markerOpen: boolean,
 *   radius: number,
 * }} LayerSeries
 */

/**
 * The samples of a picture, decoded: what `WoxiPlotLayer.build` returns.
 * @typedef {{ series: LayerSeries[] }} Prepared
 */

/**
 * The canvas mounted over a picture, as `WoxiPlotLayer.mount` returns it.
 * @typedef {{
 *   container: HTMLElement,
 *   svg: SVGSVGElement | null,
 *   canvas: HTMLCanvasElement,
 *   context: CanvasRenderingContext2D,
 *   scene: Scene,
 *   prepared: Prepared | null,
 *   log: LogAxes,
 *   box: UserRect,
 *   scale: number,
 *   observer: ResizeObserver | null,
 *   viewportListener?: (() => void) | null,
 * }} Layer
 */

/**
 * What the markup records about a picture, and what a rebuilt controller reads back
 * (`WoxiRender.plotSummary`). The samples, the scene's numbers and the densify level are
 * session state and are deliberately absent.
 * @typedef {{
 *   id: number,
 *   x: Range,
 *   y: Range,
 *   s: boolean,
 *   dn: boolean,
 * }} PlotSummary
 */

/**
 * A key on the in-app keyboard or the action bar.
 * @typedef {{
 *   label: string,
 *   insert?: string,
 *   shiftLabel?: string,
 *   shiftInsert?: string,
 *   action?: string,
 *   classes?: string,
 *   html?: string,
 *   detail?: { kind: string, name?: string, type?: string, arity?: number },
 *   grow?: number,
 *   span?: number,
 *   tooltip?: string,
 * }} KeySpec
 */

export {};
