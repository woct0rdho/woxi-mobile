# Plot Interaction

## Scope

This page describes how a plot on the phone is drawn and how gestures change it: the one mechanism behind every interactive plot, what a picture the engine sends has to satisfy, what it costs, and how each claim is tested. Numbers marked 'host' were measured with a release build of woxi 0.4.0 on a desktop CPU (they exclude JNI and the WebView, so they are a lower bound for the device). Numbers marked 'device' were measured on the emulator (Android 16, API 36, x86_64).

JavaScript is under `app/src/main/assets/www/js/`, Kotlin under `app/src/main/kotlin/com/woctordho/woximobile/`, and the engine is `engine/src/`. The web layer is ES modules, loaded by one `<script type="module">`. The plot modules are type-checked as JavaScript (`js/types.js` holds the JSDoc shapes, `pnpm types`) and their pure maths is covered by `tests/plot-maths.test.js`, `tests/plot-props.test.js`, `tests/plot-metrics.test.js`, `tests/notebook.test.js` and the engine tests.

## One mechanism

Every interactive plot is the scene plus the samples, drawn by one canvas. There is no second rendering path. The same `paint` runs at rest and while a finger is down:
- The engine renders the picture and extracts a scene from its SVG (`plot/scene/`): the frame rectangle, the data rectangle, the background, the frame style, value lines (axes and grid lines), ticks with their values and the labels the renderer printed, static texts (titles and axis labels, with their rotation. A multi-line label arrives as one text per line), and the picture's own `box` (its viewBox). Numbers are in the picture's user units. A tick's value is in the drawing space the samples use (data units, or their logarithm on a log axis).
- The engine also sends the samples (`plot/frame.rs`): per series, base64 `u16` pairs on a shared grid over the drawing range, plus color, width, dashing, opacity, filling and markers. The points reach `SAMPLE_PAD` (0.5) of a view past the view on each side, so a pan brings the curve in without a round trip. On a log axis the margin is counted in decades.
- The client draws the scene and the samples on one canvas (`js/plot-layer.js`). It measures the picture's box (the SVG's rect) but does not read its contents during a gesture, and the hidden SVG is never the picture on screen.
- The scene is also the contract. A picture with an element the scene cannot express - a raster, an `Epilog` primitive, a legend, a mesh mark - is not registered at all: no handle, no canvas, and the SVG stays a still picture (trimmed like any other graphic). Likewise a call whose options add such shapes (`Prolog`, `Epilog`, `Mesh`, `MeshStyle`, `Exclusions`, `ColorFunction`, `PlotLabels`, `PlotLegends`, `RegionFunction`, a reversed `ScalingFunctions`, clipping off) is refused before its picture is looked at. One rule, no fallback path, and the refusal is what the "still picture" the user sees is.

The markup the engine sends with every picture is inserted hidden: it is what the notebook saves, not what the app shows. What is saved never contains a canvas (`markupOf` strips them and shows the SVG). A rebuilt notebook seeds its plots from the samples and scenes still in memory (and the first scene's layout) and draws at once. A reopened notebook restores the saved picture without evaluating it. The plot becomes live again when its entry is evaluated.

## One layout: the frame is the plot area

The first scene fixes the layout: its frame's shape, and the rails and the bands its labels need. Every later scene is mapped onto that layout (`normalize` in `js/plot-layer.js`): a scale per axis takes the new frame onto the pinned one, and every number in user units travels with it (the data rectangle, a tick's base and tip, a label's offset and size, a text's position and its rotation center, line and tick widths). The frame is the plot area: the card is the frame plus the padding and the bands the frame's own labels need (`boxOf`), and the SVG's CSS aspect is pinned to the same box, so the card cannot resize between answers.

Why this is needed: Woxi lays a picture out again at every range, and the margins depend on the tick labels. A framed plot whose y labels grow from "1.0" to "-1.0" comes back with a frame a few percent wider (measured on device: 3352 -> 3415 user units for the same card) and with the frame's left edge moved by 83 units (~1.5 px). A plot with an explicit `PlotRange` whose y axis crosses zero moves the frame from 232 to 5 user units when the axis stops being pinned - a 6 % jump of the frame. Pinning the first layout removes both: the curve moves, the frame does not.

The frame's shape is pinned a second way: the client sends the frame's height over width with every view request (`aspect`), and the engine lays the crop out with `AspectRatio -> aspect`. A square contour stays square, a user's `AspectRatio -> 1/2` stays 1/2, and a crop cannot come back at the renderer's default 1/φ. A two-axis picture is evaluated at the view instead of cropped, so it keeps its own options. Both are normalized by the same rule afterward.

The engine-side half of the same rule: a view's picture must yield a scene, or the view fails and the client keeps the scene it has. A range is never half-applied.

### Rails: room inside the frame for a stuck axis

An unframed plot draws its axes at their values: the origin (`{0, 0}` by default, or the user's `AxesOrigin`). When a pan takes the origin out of the view, Woxi draws that axis on the range's edge or on the plot range's boundary, but the scene's line still carries the origin (`v`), never the edge it was clamped to. That is what keeps a stuck axis still: an origin outside the current view clamps to the same rail on every answer, a scene that arrives one answer late cannot move it, and when the view brings the origin inside the axis moves in from the rail without a jump.

The client keeps every axis label inside the frame: `layoutOf` measures, for each side, the farthest an axis label reaches from its axis (the label's own box, offset included) and the farthest a tick mark reaches on the side it points to, and reserves that much rail inside the frame. `axisPosition` clamps an axis line to the rails, so a stuck axis never comes closer to the frame's border than its labels (or its marks) need, and the labels stay between the axis and the border. The rail is plot area: the curve is drawn under it and the labels are painted last.

A label never changes sides: its side is the one in the scene (`a`, `dx`, `dy`. A y label at `dx < 0` stays left of its axis wherever the axis is). A mark never changes direction either: the mark rail is measured from every axis tick, labeled or not, so a stuck axis stops far enough inside the frame for the marks the renderer drew. Frame ticks are not clamped: their base is on the frame and their labels are outside it.

Label metrics are the renderer's: the line box is Woxi's own (Arial ascent 1854/2048 em, line height 2288/2048 em, from `plot_padding.rs`), the advance table is vendored from the same file, and `tests/plot-metrics.test.js` pins the widths to the numbers Woxi's padding tests assert. The device measures the Atkinson Hyperlegible Next face the saved SVG uses (waiting for `document.fonts.ready` before it evaluates a restored notebook). The vendored table lives in `tests/plot-metrics-fallback.js` and is installed by the headless tests, not shipped in the app.

### Bands: room outside the frame for labels that are always outside

Some labels are outside the picture by construction: the labels of a frame tick (Woxi prints them outside the edge the tick sits on) and static texts (`FrameLabel`, `PlotLabel`) the renderer placed beyond the frame. `layoutOf` reserves a band outside the frame for those, on exactly the sides they occur, and `boxOf` adds the bands to the padding to make the card. The edge is the scene's (`tick.s`), not inferred from the base: a frame's stroke is centered on its outline and a tick can start a stroke's width inside the rectangle.

A label centered near the edge's end overhangs the frame along that edge, so that side's band grows too - the same room Woxi's own padding reserves (`along_x`/`along_y`). A band exists only when such a label does: an unframed plot has none, and a framed plot with labels on the left and bottom has none on the right or top. Such a label is drawn at its scene offset and clamped to the card so a wider value cannot leave it. The clamp uses the ink's box about the label's baseline, not the layout's box about the tick base, or it would count the offset twice and push a bottom label back into the frame.

Why not resize the frame per answer: the frame's shape and the card's shape must not change under a gesture (I4). The rails and bands are measured once, from the first picture - the shape the user saw. A label whose width changes a little during a pan (Woxi's re-typesetting) still fits the slack in its rail or band. A much wider one is clamped into the card and still readable.

### Which sides Woxi can put a frame label on

`FrameTicks -> {{left, right}, {bottom, top}}` chooses the edges (Mathematica's order). `All` labels all four and `None` none. Woxi prints the label of every chosen edge outside that edge and lays the picture out with margins for it (measured: `{{None, All}, {None, All}}` puts the right labels at x = 3388 and the top labels at y = 90.8 around a frame at [5, 142]-[3357, 2213]). Unframed `Ticks` has no side option in Woxi - its labels are always left of the y axis and below the x axis - and there is no `TickLabelPositioning` option, so these are the sides the client has to support. The scene carries them: a frame tick's base is on its edge (as far as the stroke reaches), its label's `dx`/`dy` points outward, and `tick.s` names the edge the band grows on.

## Ticks follow their axes, and axes stay in their rails

A tick is one of two kinds, and the scene says which (`k`): `'a'` hangs off an axis line, `'f'` sits on the frame. A line is `'a'` when it is an axis (it has ticks) and `'g'` when it is a grid line (it is drawn at its value). Both kinds follow their values when the view moves. An axis tick's base is the position `axisPosition` gives its line for the current view, clamped to the rails. Its position along the axis is its value through the view's mapping.

A frame tick's base is its frame edge and its `s` says which edge that is. Its position along the edge is also its value through the view, so a pinch or a pan moves the tick along the frame with the curve at display rate instead of leaving it at the position of the answer it came from. (`at` is where the scene's own view put it. The layout uses it to reserve the room a label centered near an edge's end overhangs.) The scene fits its position-to-value map in the drawing space: on a log axis the view's bounds are converted to decades first, or a tick labeled 0.05 would come back at +1.3 instead of -1.3 and would be drawn at the top of the axis instead of the bottom.

Both kinds place their labels with one rule: the label's `dx`/`dy` from the tick, an along-edge fit check, and a clamp. Only the area differs, because Woxi puts the labels on different sides of the frame: an axis label belongs inside the frame (its rail), a frame label outside it (its band, still inside the card). A label that would cross the end of its area along the edge is left out. The band reserves a frame label's overhang, so it passes there.

A log axis's origin is its low end (the left of an x axis, the bottom of a y axis), which is where `axisPosition` puts an axis line with a log coordinate. A linear axis whose origin left the view is clamped to the near rail. The ticks stay on the line and the labels stay inside the frame.

## Gestures

A gesture turns finger pixels into a new view (a data range) through the same mapping the canvas draws with (`dataMapping`), never through the frame - a contour's data rectangle is inset from its frame by `PlotRangePadding`, and scaling a drag by the frame would move the plot 4 % short of the finger. One finger pans (`panViewFrom`). Two fingers scale about the data point between them at the start (`zoomAxesViewFrom`) and then pan by the midpoint's movement, so a two-finger drag that keeps the gap still moves the plot and a spread that keeps the midpoint still zooms it. The pointer coordinates arrive in page pixels and the mapping is relative to the container, so the pinch takes the container's corner off first (`pinchAnchor`).

The line through the two fingers when the second lands chooses the zoom: within `PINCH_AXIS_DEGREES` (15°) of horizontal only x is scaled, within 15° of vertical only y, and anything else scales both axes by the same factor, preserving the data aspect at the start of the gesture (which may already be different from the initial plot's). The mode is latched until both fingers lift. A twist is ignored, because a 2D view is never rotated. The gesture keeps its own range: every move is applied to that, not to what the picture shows, so an answer still in flight cannot make a drag lose distance. A tap (a finger that does not move) asks for nothing.

While a finger is down, every display frame is repainted locally at the gesture's view. The engine is asked for a scene at the same view as fast as it answers, but never more than one request in flight and one per display frame. A gesture frame asks for the scene only (`"picture": false`). The markup is brought back at rest, so the live session has a picture of the range the user left. The saved `.ipynb` keeps the picture from the evaluation until the entry is evaluated again. A plot is attached only when the evaluation that produced it (or a notebook rebuild) handed the controller that evaluation's samples: a saved picture whose handle belongs to an earlier app session is left as a still picture instead of sending a request against a dead handle.

An evicted or forgotten handle puts the controller in `stale`: the engine is not asked again, the canvas keeps panning the scene and samples it has, and a re-evaluation of the entry is what registers a live handle. It never falls back to the hidden SVG. A scene is applied to the canvas as soon as it arrives, with or without markup: the canvas reads the scene from the plot's handle, so a scene that only updated the controller's copy would leave the ticks of an older picture on screen while the curve moved.

A re-sample is not queued behind the views. When the samples' margin falls to the trigger (`REFINE_NEAR`, 0.3 of a view) the client sends `plot_refine` with a margin in views (`pad`), and the queue gives that request the next free slot even when a view is waiting. After it, one view goes first, so the ticks cannot starve behind a fast finger. A fresh plot is drawn with only its own range (no pre-sample: the plot appears as fast as the engine can draw it), and the first coverage re-sample asks for 2.5 views. The user is allowed one evaluation of lag on the first pan.

Afterward the margin is `max(1, speed * (p90 round trip + 150 ms) + 0.5)` views, capped at 4: a fast finger gets more than a slow one. The engine clamps the request to 4 views, and to 1 view for a two-axis plot, whose re-sample evaluates an area. A zoom-in that makes the samples too coarse asks for a tighter 0.5-view re-sample instead. The reply's `d` is the padded range, so the client knows the new margin. `coverageShort` and the `basis` of the view span at the last re-sample decide coverage versus resolution.

Measured on the device (550 px swipe): a quick swipe (250 ms) had a curve-edge gap of 22-52 px for the first two frames, then none. A slow swipe (1200 ms) 4-8 px for two frames, then none. A second swipe inside the re-sample's margin needed no re-sample at all. The first-interaction lag is the price of the small initial sample. The later margins are deliberately larger than the old half-view pad.

A gesture frame's scene also carries the ticks of a second render, at the engine's tick margin (half a view past the view): for a one-axis plot with axes the engine renders the picture again at that padded range and merges the axis ticks it has and the view's does not (`Scene::absorb_ticks`). The layout is still the view's, and the reply still reports the view as `x`/`y`. The extra axis ticks are outside the frame until the finger reaches them, so they appear at display rate instead of the picture rate. A frame tick's base lies on the margin render's own frame, not the view's, so a framed plot has nothing to absorb and its second render is skipped. The margin render picks its own tick step, and so its own number format: a value the view prints "2.0" can be printed "2" there.

An absorbed label is kept only when it is exactly the text the view's own labels give it (plain decimal labels. Custom, exponent and log labels are left off). Otherwise the mark enters early and its label arrives with the first view scene that includes it, so a new tick never flashes a different format for one answer. The samples' own margin is the re-sample's `pad` (above), which can be larger than the tick render's. A two-axis plot is not rendered twice (that would evaluate a range four times the area). Its ticks arrive with the next answer. A picture reply (no `"picture": false`) holds only the ticks inside its range, because the markup it carries has to match the range it claims.

At rest `reconcile()` asks for whatever is owed: a re-sample when the samples' coverage comes within `REFINE_NEAR` (0.3) of a view of the view on either axis (a fixed parameter domain is densified instead, up to `DENSIFY_MAX_LEVEL` 3), and a scene when the scene on screen is not at the current view, and a picture when the markup does not show the current range. The re-sample is sent with the margin policy above. The initial layer's coverage is seeded from the registration reply, so a rebuilt plot starts from what it already has. That is the "whole picture at rest" rule: a plot the user is not touching always has a picture at the range it shows, with curves and labels, and a lift ends with exactly that.

A logarithmic axis never shows a non-positive bound: the client repairs a stored view at the first touch and the engine repairs any request (`LOG_FALLBACK_DECADES` in `plot/handle.rs`), so the reply reports a drawable range and the next gesture starts from it. A bound at the wall stops that axis while the other keeps moving.

## What Woxi can customize, and what is interactive

The scene is extracted from the picture, so an option is supported exactly when the picture it produces is a scene. Checked on the device (screenshots) and in `plot/scene/tests/`:

| Option | Supported | How it shows |
|---|---|---|
| `Frame -> True`, `FrameStyle` | yes | the frame is a closed polyline. Its color and width travel in `fs` |
| `Axes`, `AxesStyle`, `AxesOrigin` | yes | axes are value lines with their own color and width |
| `Ticks -> Automatic / None / {...}` | yes | ticks are the picture's tick marks plus the texts printed for them. Custom labels are kept verbatim |
| `TicksStyle`, `LabelStyle` | yes | a tick carries its color and width. A label its color and size |
| `FrameTicks`, `FrameTicksStyle` | yes | the ticks of every chosen edge. Labels stay on the side Woxi printed them (left/bottom, or right/top) |
| `AxesLabel`, `FrameLabel`, `PlotLabel` | yes | static texts. The y `FrameLabel` keeps its quarter turn (`rotate(-90, cx, cy)`) and is drawn rotated about the same anchor |
| `AspectRatio`, `ImageSize` | yes | the frame and box change. The first scene pins both |
| `PlotStyle` (color, `Thick`, `Dashed`, `Opacity`) | yes | carried by the samples (color, width, dash pattern) |
| `PlotMarkers`, `ListPlot` points | yes | automatic markers are in the samples with the glyph's filled/outlined shape (`●■◆▲▼` vs `○□◇△▽`). A scatter without markers draws its dots. A marker glyph the renderer draws as a path stays a picture |
| `Filling`, `FillingStyle` | yes | the fill polygon is ignored by the scene and redrawn from the samples (color, opacity, and a reference that travels as a kind: `axis`, `value`, or the view's `bottom`/`top`, which the client resolves against the range it is drawing so a pan keeps the fill at the edge. A negative or non-positive value on a log axis, and a fill to another series, stay still pictures) |
| `GridLines`, `GridLinesStyle` | yes | grid lines are value lines, dashed as drawn |
| `PlotRange`, `PlotRangePadding` | yes | the view starts at the drawn range. A pan replaces the range while it lasts (Woxi's merged renderer ignores a `PlotRangePadding` option on the re-render, so only the first picture's padding is kept) |
| `LogPlot`, `LogLinearPlot`, `ScalingFunctions -> "Log"` | yes | samples and ticks are in the same (log) drawing space |
| `Prolog`, `Epilog`, `Mesh`, `MeshStyle`, `MeshFunctions`, `Exclusions`, `ColorFunction`, `PlotLabels`, `PlotLegends`, `RegionFunction`, `ClippingStyle`, `PlotRangeClipping -> False`, reversed `ScalingFunctions` | no | the plot stays a still picture (option-level refusal, before the SVG is read) |
| `DensityPlot`, `ArrayPlot`, `Graphics` primitives, rasters, insets | no | the picture has an element the scene cannot express (SVG-level refusal) |

`ContourPlot` and other two-axis plots are interactive when their picture is a scene: their frame is a fill-less rect, and the data rectangle is measured from the curves (`picture_rect`) because the frame sits outside the data by `PlotRangePadding`. A two-axis picture whose curves cannot give that rectangle (a degenerate extent) is refused rather than mapped onto its frame.

The client's rendering of the same grammar: the background covers the box. Value lines are clipped to the frame. An axis line is clamped to its rails and a grid line drawn at its value. The frame is drawn only when the picture really has one (an unframed plot's data area is the extents of its axes, and drawing a rectangle there would add ink the renderer never put on the page).

Ticks and labels are drawn at their values through the view's mapping, an axis tick on its clamped axis and a frame tick along its edge, and their labels share the placement, fit and clamp rule with the area chosen by kind (axis labels inside the frame, frame labels in their bands). Static texts (and rotated labels) are drawn where the renderer put them, in user units.

## Protocol

Messages follow Jupyter's shape (`msg_type` + `content`, a reply with `status` and `ename`/`evalue` on error). The plot messages are `plot_view`, `plot_refine`, `plot_densify` and `plot_release`.

```jsonc
// plot_view
{"handle": 7, "x": [x0, x1], "y": [y0, y1], "aspect": 0.618,
 "picture": false}       // only during a gesture: no svg in the reply
```

```jsonc
// reply plot payload
{"id": 7, "x": [...], "y": [...], "d": [...], "dy": [...] | null, "s": true, "dn": false,
 "scene": {"box": [...], "frame": [...], "rect": [...], "bg": "#FFFFFF", "fs": {...},
           "lines": [...], "ticks": [...], "texts": [...]}}
```

`x`/`y` is what the picture shows (not what the finger wants). `d`/`dy` is the range the samples cover: the iterator's domain (Woxi's `data_x_range`), not the picture's padded range, so a `PlotRange` wider than the iterator leaves space the samples do not have and a pan into it asks for a re-sample. `s` says the plot has iterators to re-sample and `dn` that it can be densified. A reply that carries samples (`"data"`) describes the data grid, the series and their styles. A reply that carries a picture (`"svg"`) is complete on its own. A re-sample reply carries samples only and claims no range for a picture.

The scene's fields:

| Field | Meaning |
|---|---|
| `box` | the picture's viewBox `[x, y, w, h]`. `normalize` maps it like the frame onto the first layout, and its width is what the sample stroke/dash/marker fractions are scaled by |
| `frame` | the frame (data area) `[x, y, w, h]` in user units |
| `rect` | the data rectangle in range order `[x0, y_of_lowest, x1, y_of_highest]`. The lowest data value maps to the larger user y, because SVG y grows down |
| `bg` | the picture's background color |
| `fs` | the frame's style `{c, w}`, absent when the picture has no frame |
| `lines` | value lines `{o: "x"/"y", v, k, c, w, d}` - `v` is the value in the drawing space. A line with `o: "x"` is vertical at x = v, one with `o: "y"` horizontal at y = v. `k` is `"a"` for an axis (it has ticks) or `"g"` for a grid line. An axis's `v` is its origin (0, the user's `AxesOrigin`, or the low end of a log axis), not the edge Woxi clamped it to |
| `ticks` | `{o, v, at, k, b, e, s, c, w, l}` - `o` is the axis the tick is on (an x tick's mark is vertical), `v` its value, `at` its position along that axis. `b..e` is the mark across the axis in user units. `k` is `"a"` (hangs off an axis line) or `"f"` (sits on a frame edge, with `s` naming the edge). `l` its label `{t, dx, dy, a, s, c}` (offsets from the base) |
| `texts` | `{t, x, y, a, s, c, r}` - a static text. `r = {a, x, y}` is a rotation about that anchor. A multi-line renderer label is one text per line, each at its own baseline |

## Invariants

| Invariant | Enforced | Checked |
|---|---|---|
| At every display frame while a finger is down, the curve is drawn at the finger's range. | `plot-layer.paint` maps the samples through the view. `requestDraw` on every pointer move | `tools/check-pan-frames.py` over a `record-gesture.ps1` swipe: a step every frame it repaints |
| At rest the markup is a whole picture at the range it shows. | `reconcile()`, asked after every answer and at the end of every gesture | `plotstate`'s `shown` inside `coverage.d`, `frames` on the release reply |
| A lift changes neither the range nor the frame. | the gesture keeps its own view. The release asks for that view. The scene is drawn in the pinned layout | `plotstate` before/after a 0-px swipe (no request) and across a swipe, the frame's box in the recording |
| Pan and zoom change no frame or box aspect, whatever the renderer lays out. | `normalize` (first layout) and the `aspect` sent with every view | `plot-props.test.js`'s layout case, the frame's bbox across a pan through a label-width change |
| The curve reaches the frame where the data continues. | `SAMPLE_PAD` half a view. The canvas clips to the data rectangle | the curve's ink against the frame after a pan (`check-pan-frames.py`'s "short by") |
| A stuck axis keeps its labels and marks inside the frame. A frame label stays outside it. | the axis is clamped to `rails` (inside the frame), a frame label is drawn in its `band` (outside it), and neither side is ever flipped | `plot-props.test.js`'s rail, band and mark tests, screenshots at both rails and with `FrameTicks -> All` |
| A log axis never shows a non-positive bound. | `positiveView` (client), `drawable_view` (engine), `LOG_FALLBACK_DECADES` | `a_log_axis_is_never_asked_for_a_range_through_zero`, `plot-maths.test.js` |
| The data-to-screen map is never mirrored. | one `dataMapping` (`a > 0`, `d < 0`). One `Draw` in the engine, with the two-axis mirror undone there | the mapping tests, `a_two_axis_plot_sends_its_points_unmirrored` |
| One finger pans. Two fingers pan and scale (x, y or both according to the initial finger line). Never both paths. | `onMove`'s pinch branch requires two pointers. `pinchMode`/`zoomAxesViewFrom` latch the axis mode | `plot-maths.test.js`, a real pinch (`inject-pinch.ps1`) and `plotpinch` angles |
| One rule per kind of plot, from one place. | `Samples` (engine) and the scene's `rect`/`box` (client) | the one/two-axis mapping tests |
| Nothing is throttled below the rate the device answers (floor: one request per display frame). | one request in flight, one per frame (`pump`), no other cap | `plotperf`'s `views`/`frames` against a gesture's duration |
| A constant is a protocol value, a measured quantity or a documented rule. | `tests/fixtures/protocol.json` (read by both languages) and each constant's comment | `the_protocol_constants_match_the_fixture_the_client_reads`, `plot-maths.test.js` |
| A picture the scene cannot express is a still picture, not an approximation. | `scene()` returns `None`. `register_plot` does not register. `unmodeled_options` refuses the call | `a_picture_the_scene_cannot_express_is_not_interactive`, the device's `dump` (`plot=` absent) |
| Every interactive picture is drawn in the first picture's layout. | `layoutOf`/`normalize` on every scene. The box comes from the frame plus the bands, and the SVG's CSS aspect is pinned | `plot-props.test.js`'s "a later scene is drawn in the first scene's layout", `plotperf`'s `geom=0` across a gesture |
| The ticks and labels move with their axes and are replaced at the rate the display repaints, not only when the next markup lands. | a tick's kind (`k`) says whether it follows an axis: an `"a"` tick's base is its line's position (clamped to the rails), an `"f"` tick's is the edge. A frame's scene is applied to the canvas on arrival. A gesture scene carries the ticks of the samples' margin | `a_gesture_frame_brings_the_ticks_just_outside_the_view`, `plot-props.test.js`'s tick/line tests, a frame-by-frame montage of a recorded swipe |

## Anti-drift: what keeps the two sides honest

The engine reads Woxi's picture grammar and the client reads the engine's scene. The contract has two fixtures and a test on each side, so a Woxi upgrade cannot silently change it:
- `tests/fixtures/protocol.json` - the constants both languages use (`u16_max`, `sample_pad`, `log_fallback_decades`, `refine_near`, `zoom_in`, `densify_max_level`, `max_refine_pad`, `two_axis_max_refine_pad`). Read by `plot/frame.rs`'s protocol test and by `tests/plot-props.test.js`.
- `tests/fixtures/scenes.txt` - one fingerprint per statement in `plot/scene/tests/grammar.rs`'s `GRAMMAR`: the box, frame and data rectangle rounded to 0.1, the frame style, the counts of lines, ticks, labeled ticks, texts, dashed lines and rotated texts, and the labels. It is Woxi's picture grammar as the scene reads it. `WOXI_UPDATE_FIXTURES=1 cargo test --profile fast the_scene_grammar_matches_the_fixture` rewrites it so the diff is reviewed rather than absorbed.
- `tests/fixtures/scene.json` - one whole scene of a framed plot with a rotated frame label and dashed grid lines, written by the same regeneration. `tests/plot-props.test.js` reads it and asserts every field the canvas draws (including a frame tick's edge `s` and along-edge position `at`), so a renamed or dropped field in either language fails a test.
- The label metrics are vendored from Woxi's `plot_padding.rs` (Arial advances, ascent and line height) in `tests/plot-metrics-fallback.js`. `tests/plot-metrics.test.js` pins the widths to the values Woxi's own padding tests assert, so a Woxi change fails a test instead of quietly changing the rails.
- The scene tests render every supported option matrix entry through Woxi and assert what the scene makes of it (frame from a polyline, rotated frame label, custom ticks, dashes, aspect, refusals, the edge a `FrameTicks` option puts a label on, and the stroke width a frame tick's base may sit inside). The client's `normalize`, mapping and gesture maths are covered by the JS test files.

## Testing a gesture

A gesture is measured frame by frame, not by its end points:
- `tools/record-gesture.ps1 -Steps 'wait|1500;swipe|540,860,760,860,600;wait|1500;action|plotperf'` records the screen while injecting a real touch swipe (`adb shell input swipe`) or a real two-finger pinch (`tools/inject-pinch.ps1`, which writes the touch panel's multi-touch protocol). `action|...` steps drive the app's own harness. It does not reload the page by default, so the plot's appearance is not part of the recording.
- `tools/record-pan.ps1` does the same for the app's synthetic `plotsweep`, which moves at display frame rate.
- `tools/check-pan-frames.py <video>` extracts the frames and measures, per frame: the curve's blue ink (its box and column/row profile), the step it took (cross-correlated to the previous frame, limited to `--limit` px so a periodic curve cannot match its own next period), the picture's background box (`--card`, `--background`), and the curve's shortfall against the reference box. It reports still frames, jumping frames and card changes, and `--montage` writes the worst frames side by side. A frame in the recording may repeat or skip the app's repaint. The tool compares PNG bytes to tell a repeated frame from a stall.
- `plotperf` reports the counters a gesture problem needs: `frames`, `views`/`refines` (with the last re-sample's margin and reason, `pad=<views>/<coverage|resolution>`), `checks` and their answer, `rt` and `paint` percentiles, payload bytes (the picture and the samples. A scene-only gesture frame carries neither and counts 0), `box`/`scale`, `draws`, `dropped`, `sends`, `failed=<n>:<ename>: <message>/<kind>` (the kind says whether a view or a re-sample was refused) and `geom` (repaints whose scale differed from the previous one - a visual jump of everything the canvas drew. It must stay 0 during a gesture. The box is pinned at mount).
- `plotstate` prints the first plot's controller state (append `last` for the newest plot): `status`, `layer`, `prepared`, `series`, `gesture`, `wanted`, `scene`, `shown`, `coverage`, `box`, `scale`, the data `mapping`, the scene's `frame` and `rails`, and the tick summary.
- `plotscene` prints the scene the canvas is drawing, rounded (append `last` for the newest plot): its box, frame, rails, frame style, lines (with their value and kind), ticks (with their value, kind, edge `s`, along-edge position `at`, base, tip and label offsets) and texts. It is the fastest way to see which side a label was put on or where an axis was clamped, without a screenshot. It reads the layer, so it also works for a gesture frame that has no markup.

## What it costs

Measured on the emulator this project's gesture work uses (Android 16, API 36, x86_64, 1080x2400), after a fresh boot. A `plotsweep` of 90 display frames takes 1493-1498 ms, so the WebView's rAF is ~60 Hz and the canvas repaints while the finger moves. `plotperf` reads `draws` (canvas paints), `views` (scenes applied), `rt` (request sent to answer applied, including JNI and the bridge) and `paint`. The answer rate is lower than the draw rate by design: one request is in flight and one goes out per display frame, and a gesture frame carries the scene only, not the samples.

| Plot, 90-frame sweep | Draws | Answers | rt p50/p95 | paint | Note |
|---|---|---|---|---|---|
| `Plot[Sin[100 x], {x, 0, 30}]` (a usual plot with re-sampling) | 93 (60 fps) | 60, 1 refine (`pad 1`, coverage) | 3/5 ms | <1 ms | the refine re-evaluates the call and does not stall the draw |
| `Plot[Sin[x], {x, -5, 5}, Frame -> True, FrameTicks -> All]` | 93 (60 fps) | 60, 1 refine | 3/5 ms | <1 ms | one render per gesture frame: the padded render is skipped |
| `ListPlot[Table[{x, Sin[x]}, {x, 0, 100, 0.02}], Joined -> True]` (5001 points) | 92 (60 fps) | 60 | 4/6 ms | <1 ms | |
| the same with 50001 points | 93 (60 fps) | 59 | 12/15 ms | 1 ms | 20/30 ms and 47 answers before the polyline parse fix |
| `ContourPlot[x^2 + y^2 == 4, {x, -3, 3}, {y, -3, 3}]` (two-axis) | 63 (60 fps) | 40, 1 refine (`pad 1`, coverage) | 5/6 ms | <1 ms | a view re-evaluates the call, see below |

The `draws` column is the interaction rate: the curve, axes, frame and the positions of every tick are recomputed and painted every display frame. The `answers` column is the rate at which the tick text and the saved picture are replaced. On a normal plot that is 25-33 ms behind at worst, and a 50k-point list gets ~40 answers/s. Only the text is on that rate. The tick positions move with the curve at the draw rate.

Why a two-axis view re-evaluates the captured call while a one-axis view is a `Show` crop: a one-axis picture is faithfully croppable - `Show` with the requested range and the frame's aspect draws the same stored curve clipped to that range, and the frame is the data rectangle, which is what the client maps the view onto. A two-axis picture is not: Woxi stores its field primitives in the producer's mirrored y space, and `Show` re-lays the picture out with its own data area (measured earlier: a 3600x3680 canvas at one range and 3600x3570 at the next), so a crop would come back upside down and re-shaped, with the data rectangle no longer where the client draws.

Evaluating the call at the view is what keeps the orientation, shape and data rectangle right. The cost is one call evaluation per answer. The canvas still draws the curve from the samples at 60 fps, and the measured common case (an unfilled contour) is 5 ms p50. Removing even that would mean generating ticks and the data rectangle locally and asking for a picture only when the samples' coverage runs out, as a one-axis view does. That is a larger change and the current numbers do not justify it.

Two per-frame costs found by this profiling were fixed:
- `parse_picture` collected every point of every polyline into a `Vec<(&str, &str)>` to decide whether it was a two-point segment, the five-point frame or a series. A 50k-point curve therefore allocated ~50k pairs on every rendered gesture frame. It now peeks at six tokens: a long series is recognized without being parsed, and only a short segment, a frame (or a rare longer non-series polyline) has its points read. The 50k `ListPlot` went from 20/30 ms to 12/15 ms per answer, and from 47 to 59 answers per 90 frames. Draws stayed at 60 fps.
- `render_view` cloned the stored graphic - with every source point - for a two-axis view, which never reads it: that path re-evaluates the captured call. Only a one-axis crop clones the graphic now.

Remaining known costs, left in place because the interaction still draws at 60 fps and the simple part is done:
- a one-axis crop still clones the stored graphic into `Show` (the entry must keep its own copy). For a 50k-point list that is ~0.8 MB per answer, and Woxi's re-render is O(points) in any case.
- a two-axis scene re-scans the SVG (`picture_rect` measures the polyline extent after `parse_picture`) and the source points. Interactive two-axis pictures are rare, and the cost is per answer, not per draw.
- `paintSeries` copies the whole `Path2D` per paint, because a uniform stroke under a non-uniform data-to-user transform cannot be drawn with a canvas transform. At 50k points paint is 1 ms p50.
- `textWidth` measures each label on each paint. That is inside the <1 ms paint.

A long-running or loaded emulator measured much slower (p50 33-172 ms, p95 200+ ms). Reboot it before drawing conclusions from a latency number, and always set `plotlatency 0` (`plotlatency` is harness state in the page, not a build option). The 3-4 s latency the held-gesture tests use is what makes labels look frozen. It is not part of the implementation.

## Open findings

- Two-axis pictures are mirrored by Woxi's `Show`. A probe on `ContourPlot[y == 2 - x^2, {x, -2, 2}, {y, -2, 3}]` cropped with `Show[..., PlotRange -> {{-1.5, 1.5}, {-1, 2.5}}, AspectRatio -> 1]` shows the crop's frame, y tick labels and their positions normal (2.5 at the top, -1.0 at the bottom), while the contour is drawn vertically mirrored (its apex `y = 2` sits at the frame's bottom). The merged `PlotSource` still carries the original ranges (`x_range [-2,2]`, `y_range [-2,3]`) and 257 original points, not the crop's. The crop's frame is a closed polyline rather than a rect, and the picture's height changes (350 vs 359 user units). Evaluating the same statement at the view instead gives a normal apex, the view's ranges and 227 points.
  - The engine therefore re-evaluates the call at the view. A mirror-aware crop is possible without touching Woxi: use the crop only for the frame, ticks and labels, and fit the data rectangle and each frame tick's value from the printed tick labels (which are correct) rather than from the mirrored curves or the stale source. The client already draws the curve from unmirrored samples, so the crop's contours can be ignored. Ask for a re-sample only when the samples' coverage runs out, as a one-axis view does.
  - That needs a label-based mapping with a fallback when labels are missing or not numeric (`FrameTicks -> None`, custom ticks). The cleaner fix is in Woxi: `Show` should unmirror the stored field primitives and keep the merged source/range consistent with the crop, so a two-axis crop is as faithful as a one-axis one and the engine's re-evaluation can go. On the measured interactive contour (a circle) the re-evaluation is 5 ms p50 and the interaction still draws at 60 fps, so neither change is urgent. The performance case is a heavy field, where `Show` re-renders stored contours (O(points)) instead of re-evaluating the field.
- Log axes need no layout special case: the renderer draws the log line at the low end, the client clamps it to that rail (`axisPosition` treats the log origin as the low end), and the tick machinery is the same as for a crossing linear axis. What stays is the domain rule (a log range must remain positive, because Woxi draws an axis-less picture for a range through zero, which yields no scene, and because the u16 sample grid bounds how many decades are worth drawing).
- A view that cannot be expressed fails, and the plot keeps its last scene. That is the right trade for a picture the grammar does not cover, but a transient failure (a range that is momentarily undrawable) looks like a stalled frame. The `failed:` counter in `plotperf` is the way to see it, and `failedView` stops the same refused range being asked for again.
- No raster interaction. `DensityPlot`/`ArrayPlot` pictures are pixels by construction, so they are still pictures. Supporting them would need a separate range/color-map model, not this scene.
- A label wider than its rail or band is clamped. Normalizing the layout pins the frame and the card, not the width of a future label: a pan can replace "-1.0" with "-100.0", which is wider than the slack the first picture reserved. The label is shifted back inside the card, so it stays readable but can overlap the frame by a few pixels. Reserving for the widest label the axis can ever show is not knowable from Woxi's picture. Measuring a label and widening the card would break I4.
- A very deep pinch-in produced one `plot_view` `RenderFailed`. In a 4x pinch-in on `Plot[Sin[x], {x, -5, 5}]`, one gesture frame's view was refused (`plotperf failed=1:RenderFailed: the plot did not render/view`). The client kept the last scene and latched that range, and the next frame at a new range recovered. A picture at that intermediate range came back without a scene, which the engine correctly refuses rather than drawing a partial one. If it ever shows as a visible stall, log the refused range and make `scene()` accept or repair that picture. The `plotperf` failure now names the job kind, which is how this was identified.
- A scatter's dots are a payload default, not a scene element. They are drawn from the samples. The SVG's circles are ignored, which is why `Mesh -> ...` (whose circles are not in the payload) is refused at the option level instead of showing marks that would vanish.

## Open ideas (not implemented)

The margin policy above removed the gap for a normal pan/pinch. These are the next steps for a fling or a heavier plot, kept here so the measurements that suggested them are not lost:
- Piggyback the gesture render's samples. Every one-axis gesture frame already renders the picture at view ±0.5 for ticks (`render_view`). Its points are discarded. Sending that layer with the gesture reply would give a fresh half-view margin every frame without another Woxi evaluation, on top of the re-sample's larger margin. Costs: a few KB and a Path2D rebuild per frame (throttle, or send only the entering strip). This is the cheapest fix for a fling that outruns the last re-sample.
- Keep sample layers. A re-sample replaces the client's only layer. The previous ranges (and the original plot's data) are lost. Keeping the last few layers and drawing their union would make panning back instantaneous and give the curve ink while the next re-sample is in flight. A decimated "far" layer over several views would cover a fling. The seam is outside the view.
- A directional pad. The re-sample's pad is symmetric, so half of the extra points are behind the direction of motion. A leading/trailing pair (`padLow`, `padHigh`, chosen from the recent velocity) would double the useful margin for the same sample count.
- Scale `PlotPoints` with the pad. A 2.5-view pad has ~1/6 of the point density per view of the initial sample, which is fine for `Sin` but coarse for a wiggly function. The engine could ask Woxi for more points in proportion to the pad (the `with_plot_points` path exists for densify), capped by Woxi's parametric limit. The u16 grid has room.
- A pre-warm on the first move. The first quick swipe still gaps for the first two frames (the first re-sample's evaluation). Sending that re-sample on the first move instead of after the first view reply would save one round trip. Sending it on pointerdown would also fire for a tap, which the gesture contract avoids.
- An engine worker or far cache. A re-sample is a full Woxi `Plot` evaluation and shares the engine's serial request stream. For expensive calls, a background worker (a second session, hard because Woxi's evaluator is thread-local and user definitions live in the session) or a cache rendered wide at registration would keep the serial stream free for views. Not worth it for `Sin`. The protocol has the `pad` hook for it.
- A gap metric. `check-pan-frames.py` measures ink, which on a zoom-out shrinks with the data's amplitude and is not a coverage gap. A per-frame `gapPx` from `coverage` vs `wanted`, and `refineAsks`/`refineSent`/`refineMs`, would make the margin tunable on the device. `plotperf`'s `checks/asks` and `pad` are the current proxies.
- Fling inertia. Not implemented. If it is added, the prefetch distance must include the inertia and the first pad may need to be larger than 2.5 views.
