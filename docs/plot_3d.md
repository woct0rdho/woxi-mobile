# 3D Plot and Interaction

This document describes the implemented 3D interaction path and the measurements behind it: the split between the engine and the client, what is reused from 2D and what is new, and the supported plot heads. The measurements are on the emulator (Android 16, API 36, x86_64, 1080x2400, WebView 133). Host numbers are with a release build of woxi 0.4.0 on this machine. All times are one-shot unless said otherwise.

## What is implemented

The first version has an engine `scene3d` extraction, a compact `plot3d` output item, a WebGL2 client renderer and camera plus data-view gestures. `Plot3D`, `ListPlot3D`, `ParametricPlot3D`, `ContourPlot3D`, `RegionPlot3D` and `SphericalPlot3D` register as scenes when their structure is a `Graphics3D` of a `GraphicsComplex` with polygons. The extractor accepts both indexed polygons and literal coordinate polygons. A line-only picture (for example a `ListLinePlot3D` or a parametric curve) stays static. A picture with a primitive the extractor cannot express (a `Sphere`, `Cuboid` or `Tube`, a texture, raster data, a chart, `ListLinePlot3D` with no structure) keeps the existing SVG and stays still.

The first device measurement of this path was `Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}]`: 92 ms engine, 70 ms WebView render and 203 KB of JSON, against 238 ms, 233 ms and 1.83 MB through the SVG path. The geometry is 2,601 vertices and 5,000 triangles. A 120-frame `plot3dspin` measured 1995 ms, 61 FPS, with about 0.2 ms of CPU paint per frame. The default 5,000-triangle scene is therefore comfortably inside the display budget. The SVG path was not.

The renderer keeps one WebGL2 context per plot and does not impose a context cap. WebGL2 is required. A device or context that cannot provide it is not a supported 3D renderer, and the card is hidden rather than drawing a second software path.

## Tests now and the option gap

The 3D path now has a statement-level option matrix, a scene fingerprint fixture, a geometry-invariant test and the evaluation-path test. The engine tests assert that a supported head produces a scene and that an option the scene does not model leaves the picture as an SVG. They also cover the per-head `PlotRange` matrix, `Boxed`/`Axes` policy, Spherical's `Graphics3D` padding and data-shaped box, explicit Spherical/Parametric view boxes, the one-axis-empty `Plot3D` rule, the RegionPlot3D cube, reconstructed ParametricPlot3D mesh and palette, the empty `MeshStyle`/`BoundaryStyle` forms, the f32-precision fallback, the explicit-default-color sentinel, the standalone quad diagonal, the corrected Woxi camera distance, the default Plot3D boundary, per-line colours and a Spherical z-only range.

A malformed line, a custom `MeshShading`, an invalid `BoxRatios`, and a `GraphicsComplex` vertex-colour or texture directive make the scene static rather than silently changing the picture. The JS tests cover camera basis (including the pole), perspective and orthographic projection, depth range, data-to-box mapping, view transforms, viewport-plane mapping, range zoom, tick formatting, adaptive axis selection, unboxed axis buffers, geometry decoding and rejection of inconsistent buffers, and the no-WebGL card.

The render tests cover the card, its ImageSize style, its theme, its scene index, SVG absence and malformed-scene rejection. The notebook test covers the custom MIME round trip. It still lacks a golden comparison against Woxi's SVG, a recorded real-gesture test that asserts no plot request is sent, and a non-default-camera notebook test. The 2D path has the scene grammar fixture, picture/option rejection (`unmodeled_options`), layout fingerprints, sample/refine tests and device frame tests.

| Option group | Woxi 3D | Our scene now | Can stay interactive |
|---|---|---|---|
| `ViewPoint`, `ViewVector`, `ViewVertical`, `ViewAngle`, `ViewCenter`, `ViewProjection`, `SphericalRegion` | `Graphics3D` and forwarded plot options | `ViewProjection -> "Orthographic"`/`"Perspective"`, `ViewPoint -> {..., Infinity}`, and a finite `ViewPoint` paired with orthographic projection. Other finite view points and view options stay static | yes: these set the initial camera mode and angles |
| `BoxRatios`, `Axes`, `Boxed`, `PlotRange`, `ImageSize` | yes | `Boxed`, `PlotRange`, `ImageSize`, `Axes -> True`, `SphericalPlot3D` `Axes -> False`, `SphericalPlot3D` `Boxed -> False` unboxed axes, and `ParametricPlot3D`/`SphericalPlot3D` `BoxRatios`. Other heads' `Axes -> False`/`BoxRatios` stay static | yes: parse head-specific flags and the fixed card |
| `AxesEdge`, `Ticks`, `AxesLabel`, `PlotLabel`, `PlotLegends`, `PlotLabels` | `Graphics3D`, some plot heads | ignored. Default ticks and no labels | yes: engine tick/box scene plus the 2D label overlay |
| `AspectRatio`, `Background` | yes | `AspectRatio`, including its `Automatic` form, and `Background` stay static | yes: layout from the scene. Background needs a clear-color pass |
| `PlotStyle`, `Opacity`, `ColorFunction`, `ColorFunctionScaling` | yes | colour/opacity from the structure. Thick/dash/specular forms stay static | yes: material/colour buffer. Exact specular needs Woxi's lighting model |
| `Mesh`, `MeshFunctions`, `MeshShading`, `MeshStyle`, `BoundaryStyle` | yes | default and Parametric mesh lines, per-face colours where the structure carries them. Custom `Mesh`, `MeshFunctions`, `MeshShading` (including Parametric), `MeshStyle` and `BoundaryStyle` stay static | yes after extracting custom line styles and boundaries |
| `RegionFunction`, `Contours`, `ContourStyle` | yes | `RegionFunction` stays static. A clipped Parametric index grid cannot reconstruct Woxi's default mesh. `Contours`/`ContourStyle` are modeled for `ContourPlot3D` | yes |
| `Filling` | `Plot3D` | not in the symbolic structure. The walls are missing | yes after adding the fill geometry |
| `Lighting`, `Specularity`, `Glow` | yes | fixed two-sided light. Options ignored | yes, by porting the lighting model |
| `PlotPoints`, `MaxRecursion` | head-dependent | Woxi's sampled grid is used | yes, as a one-time/quality refine. Never per frame |
| `Epilog`, `Prolog` | yes | ignored | 2D overlays yes. 3D primitives need tessellation |
| `Texture`, `TextureCoordinateFunction` | yes | ignored | possible with UVs and a texture atlas, but not the first version |
| `Sphere`, `Cuboid`, `Cylinder`, `Cone`, `Tube`, 3D text, vector/stream plots | yes | static SVG | yes after engine tessellation. Not now |

Woxi's own support is uneven. `Plot3D` reads `PlotStyle`, `ImageSize`, `Mesh*`, `RegionFunction`, `Filling`, `BoundaryStyle`, `PlotRange`, `Boxed`, `AxesLabel`, `ColorFunction` and `ColorFunctionScaling`. It writes a fixed `BoxRatios` and a default camera, and its sampler uses a fixed 50x50 grid regardless of `PlotPoints`. `ParametricPlot3D`, `ContourPlot3D`, `RegionPlot3D` and `SphericalPlot3D` have their own option loops. `Graphics3D` carries the complete camera, tick, box, lighting and background set, but the plot heads do not all forward or honour the same subset.

## Plot range, box ratios and the card

Three different things are often confused:
- `PlotRange` fixes the data interval on each axis (or only z, or all three). It changes the data-to-box normalization and the tick values.
- `BoxRatios -> {rx, ry, rz}` fixes the shape of the normalized box. It does not fix the data interval. With data spans `sx, sy, sz`, the screen length of one data unit on each axis is proportional to `rx/sx : ry/sy : rz/sz` (the common factor is the camera/fit scale). So once `PlotRange` fixes the spans, choosing `BoxRatios` proportional to the desired unit lengths times the spans gives a chosen ratio of unit lengths. Equal data-unit lengths need `BoxRatios` proportional to the data spans.
- `ImageSize` and `AspectRatio` size the outer card. They do not change the box ratios or the data-unit ratio. The whole projection is scaled into the card.

Measured Woxi behaviour (host, before the JNI/WebView overhead. The SVG root is the card):

| Statement | Woxi SVG card | Meaning |
|---|---:|---|
| `Plot3D[Sin[x] Cos[y], ..., BoxRatios -> {1,2,3}]` | 360x273, same as default | `Plot3D` does not honour `BoxRatios` in its standalone SVG |
| `ParametricPlot3D[torus, ..., BoxRatios -> {1,2,3}]` | 253x432 | `ParametricPlot3D` honours `BoxRatios` |
| `SphericalPlot3D[..., BoxRatios -> {1,2,3}]` | 239x432 | `SphericalPlot3D` honours `BoxRatios` |
| `ContourPlot3D[..., BoxRatios -> {1,2,3}]` | 360x387, same as default | `ContourPlot3D` does not honour it |
| `RegionPlot3D[..., BoxRatios -> {1,2,3}]` | 360x380, same as default | `RegionPlot3D` does not honour it |
| `ListPlot3D[..., BoxRatios -> {1,2,3}]` | 360x270, same as default | `ListPlot3D` does not honour it |
| `Graphics3D[{Sphere[]}, BoxRatios -> {1,2,3}]` | 235x432 | `Graphics3D` honours it |
| `Plot3D[..., ImageSize -> {300,200}]` | 300x200 | Exact outer card |
| `Plot3D[..., ImageSize -> 300]` | 300 wide, height from the box's envelope | Width fixed, height follows the box |
| `Plot3D[..., ImageSize -> Full]` | width 100%, viewBox 720x720 | Full-width form |
| `Plot3D[..., AspectRatio -> 1/2]` | 360x360 | `Plot3D` forces a square card and ignores the value |
| `Graphics3D[{Sphere[]}, AspectRatio -> 1/2]` | 360x180 | `Graphics3D` honours `AspectRatio` (2 gives 360x720) |
| Default `Plot3D` | 360x273 | Auto height follows the projected box, including its labels |

So the exact answer is: Woxi supports the data range everywhere the head reads `PlotRange`. Supports a meaningful box shape through `BoxRatios` only on `ParametricPlot3D`, `SphericalPlot3D` and `Graphics3D`. Supports a fixed outer card through `ImageSize` on the plot heads, and supports a meaningful outer `AspectRatio` only on `Graphics3D`. The plot-head `AspectRatio` behaviour is a square card at the default height, not a ratio. With no explicit height, Woxi re-fits the card to the projected box for every view, so a rotated view changes the card's shape. `ImageSize -> {w,h}` pins it.

Our current path: the scene takes explicit `PlotRange` from the source or structure options, uses the source iterators for the initial view (`Plot3D` x/y, `ContourPlot3D`/`RegionPlot3D` all three), keeps the sampled point extents as `coverage`, sends data-space vertices, and generates ticks from the current view. `Plot3D` x/y ranges are intersected with the caller's iterators, as Woxi does. Both intersections must be non-empty before either domain is narrowed. `Plot3D` also reconstructs Woxi's default black boundary from the grid edges. `BoundaryStyle -> None` removes it.

`SphericalPlot3D` also gets Woxi `Graphics3D`'s automatic 2% padding on each axis when no explicit `PlotRange` pins the region. The box defaults are head-specific and use the effective view: `Plot3D` and `ListPlot3D` use `{1,1,0.4}`, `ContourPlot3D` uses the cube carried by its structure, the signed-field `RegionPlot3D` path uses its cube (the fallback path still uses `{1,1,0.4}`), and `ParametricPlot3D`/`SphericalPlot3D` use the effective view proportions, including an explicit `PlotRange` and `BoxRatios -> Automatic`.

`BoxRatios` is accepted on `ParametricPlot3D` and `SphericalPlot3D`. The heads whose standalone picture ignores it stay static. `Boxed -> False` is static on `ListPlot3D`, whose standalone renderer always draws its axes. `SphericalPlot3D` keeps its default `Axes -> True` when `Boxed -> False`, as `Graphics3D` does. `ImageSize` is accepted on every scene head. `{w,h}` pins both dimensions, `{Automatic,h}` is `h x h`, `{w,Automatic}` is `w x w`, `{Automatic,Automatic}` is Woxi's fixed 360-square pair, a one-element list unwraps to its named or numeric size, the `{{wmin,wmax},{hmin,hmax}}` range form uses 360-square defaults, `UpTo` in either slot is accepted, a bare width lets the card's height follow the box's rotation envelope, and `Full` is a full-width card of the same shape.

`AspectRatio` remains static because the plot heads turn it into a square card in Woxi rather than a usable ratio. The client maps data-space vertices into the fixed box with uniforms, clips them against the view, and updates tick marks and labels locally. The option policy and tests cover these head-specific cases.

Our supported range is therefore closer to 2D than before. 2D models frame/axes labels, ticks, styles, grid, filling, layout and `ImageSize`, and refuses options it cannot draw. 3D supports `ColorFunction`, the default mesh lines, the default `Plot3D` boundary, and the reconstructed default `ParametricPlot3D` mesh. It now also models `PlotRange`, `ImageSize`, `Boxed`, `Axes -> True`, `SphericalPlot3D` `Axes -> False` and unboxed axes, `ParametricPlot3D`/`SphericalPlot3D` `BoxRatios`, orthographic `ViewProjection` (including a finite `ViewPoint` direction), infinite `ViewPoint`, and data-view gestures, while labels, explicit ticks, filling, layout, finite perspective `ViewPoint` and other custom camera options and custom `MeshStyle`/`BoundaryStyle` remain static.

The 3D policy is an allowlist keyed by the direct plot head. `Filling`, `AxesLabel`, `Ticks`, finite perspective `ViewPoint`, `PlotLabel`, `Epilog`, `Texture`, `MeshFunctions`, and the `Plot3D` `RegionFunction`/`MeshShading` cases are the concrete examples that used to pass silently. `PlotRange` is not one generic parser: `Plot3D` supports x/y intersection plus z-only, `ListPlot3D` supports z-only, `ParametricPlot3D` supports the full axis form, `SphericalPlot3D` supports full/scalar/z-only, and `ContourPlot3D`/`RegionPlot3D` stay static for it because Woxi's standalone renderers ignore it. `RegionFunction` stays static because a clipped Parametric index grid cannot reconstruct Woxi's default mesh.

The policy is implemented in `scene3d`: direct supported heads only, known no-op forms allowed, and unsupported options returning the SVG path. `ImageSize` accepts a positive width, `{w}`, `{w,h}`, `{w,Automatic}`, `{Automatic,h}`, `{Automatic,Automatic}`, one-element named or numeric lists, the `{{wmin,wmax},{hmin,hmax}}` range form, `UpTo` in a dimension slot, named sizes (`Tiny`/`Small`/`Medium`/`Large`), `Full`, `Automatic`, and arithmetic forms that round-trip through Woxi's evaluator.

`BoxRatios` is limited to the two heads Woxi honours. `AxesLabel`, `PlotLabel`, `PlotLegends` and `PlotLabels` in their `Automatic` forms stay static because the scene has no label representation. `Filling -> Automatic` is safe because it is a no-op. `Mesh -> All`, `MeshFunctions`, custom `MeshShading` (including on `ParametricPlot3D`), custom `MeshStyle` and custom `BoundaryStyle` stay static. `MeshStyle -> None` suppresses the reconstructed default Parametric mesh. `False` and `{}` are no-ops in Woxi and keep the default mesh.

`BoundaryStyle -> None` removes the default Plot3D boundary. `False` and `{}` keep it. The scene fixture is `tests/fixtures/scenes3d.txt`. regenerate it with `WOXI_UPDATE_SCENES3D=1 cargo test --profile fast the_scene_fingerprint_matches_the_fixture`. The remaining parity work is a golden comparison of the projected box, ticks and labels against the Woxi SVG at the default and a rotated camera. Golden frame images for the supported heads. A recorded real-gesture test that asserts no plot request is sent, and a notebook round trip with a non-default camera. Until that exists, the implementation is a working interactive path, not a full visual parity guarantee.

2D gained one adjacent correctness fix in the same pass: `MeshStyle` is now in `unmodeled_options`, so a custom mesh style is static instead of being silently dropped by the scene canvas. No other 2D option offered an easy interactive win without adding new scene primitives. `ColorFunction` would need a gradient representation and `Mesh` marks would need sample-level marks.

## Verdict

The SVG path is not fast enough for interactive use. Woxi renders a 3D plot to SVG with a CPU painter's algorithm and the frontend used to show that SVG. A basic `Plot3D` takes about 50 ms on the host, 238 ms in the engine and another 233 ms in the WebView, and ships 1.83 MB of JSON (1.67 MB of SVG). A modest `ContourPlot3D` takes about 1.2 s on the device and ships 4.89 MB. Re-rendering that per gesture would be 1-4 FPS, far from the 60 FPS the 2D plots meet.

It is fast enough to render once and interact on the client. Woxi already keeps the symbolic picture in `Expr::Graphics.structure` as a `Graphics3D` with a `GraphicsComplex` of indexed points and polygons. Extracting that geometry gives 2,601 points / 2,500 quads for the basic surface, 6,301 points / 11,244 cells for the sphere contour and 8,790 points / 15,928 cells for the region. Indexed `f32` vertices, `u32` indices and `u8` colours are roughly 100-450 KB raw (130-600 KB base64), 10-20 times smaller than the SVG, and the client can draw them with WebGL2 at the display rate.

WebGL2 benchmark in Chrome 133 on the emulator (one draw, depth and a simple light, with a read-back stall): 5k-200k triangles took 2.0-2.7 ms of CPU per frame. Canvas 2D took 6.8 ms at 5k triangles and 31 ms at 20k. The benchmark used the emulator's host GPU. A SwiftShader AVD is much slower and is not a representative device number. The order is right: a GPU renderer is required for nontrivial meshes, while the default 2.5k quads are easy.

The sampling cost is separate. The default surface grid is cheap. The contour extraction is not (about a second on the device). That is acceptable once, with a busy state, but it must never be on the gesture path. The current data-space scene can rotate, pan and uniformly zoom within its gesture bounds without an engine request. Expanding that coverage still needs a sample. Rotation never needs one.

## Data view versus camera

A 3D box can be the analogue of the 2D frame: the box is a fixed normalized cube, the current `PlotRange` maps into it, and the surface and its ticks move inside the box when the data window is panned or zoomed. The camera rotates that fixed box inside a fixed outer card. This is a sound extension of the 2D model, and the scene keeps three things separate:
- the box (fixed normalized shape from `BoxRatios`. `ImageSize` fixes the outer card).
- the data view (`PlotRange`: the data intervals currently mapped into the box).
- the sample coverage (the larger domain the engine has already sampled, the 3D analogue of the 2D sample pad).

With data spans `sx, sy, sz`, the screen length of one data unit is proportional to `rx/sx : ry/sy : rz/sz`. Panning or zooming a single axis changes that ratio. A uniform zoom preserves it. Tick values come from the current data view and can be generated locally at display rate. The box itself does not move.

### One-finger rotation

The default should be a turntable/orbit about the box centre: yaw and elevation change, the centre stays fixed on screen, and the initial card is not re-fitted. This is what Blender's default MMB orbit, Maya's Alt+MMB tumble, Fusion 360, Sketchfab and Three.js `OrbitControls` effectively do. The touched point does not stay under the finger, but the motion is predictable, the camera keeps its up direction, and the box centre remains fixed.

Exact tracking of the picked surface point is possible but not a turntable. Raycast the finger onto the front-most surface point `P`, keep `p = P - C`, intersect the new finger ray with the sphere of radius `|p|` at `Q`, and rotate the camera by the minimal rotation that maps `p` to `Q`. The projection of `P` then lands exactly under the new finger and the centre stays fixed. This is a full 3D rotation: it can roll the camera, its axis is unstable when `P` is near the centre or nearly antipodal, and a small movement near the centre can cause a pathologically large rotation. It is closer to a trackball with the sphere radius set to the picked point's radius. It should not be the default.

A trackball with a fixed virtual sphere is the natural middle ground: map the pointer to the sphere, apply the quaternion, and accept that only points on that sphere track exactly. The box centre stays fixed and the camera can roll. It is a reasonable optional mode, not the default orbit.

### Two-finger pan and uniform zoom

A plane parallel to the viewport gives an exact, standard solution for translation plus uniform scale. A screen point maps to one point on that plane by intersecting the camera ray with it. A two-finger translation plus scale is a 2D similarity on the plane: translation is the midpoint movement, scale is the finger-distance ratio, and finger twist is ignored. If the data view is translated/scaled about a pivot on that plane, every point on the plane follows the fingers exactly. Points at other depths show the normal perspective parallax. No single plane can make two fingers at different depths exact.

The default plane should be the box-centre plane. It needs no hit-testing, is robust, and makes the box centre the natural anchor. If the first touch hits a visible point, the plane can optionally be taken at that point's depth, making that point exact. For two fingers, the midpoint depth is a compromise. Two different depths cannot both be exact. A camera-distance dolly is a different operation and is not mixed with range zoom under the same gesture.

With data spans `sx, sy, sz` and `BoxRatios {rx, ry, rz}`, a data unit is displayed in the ratio `rx/sx : ry/sy : rz/sz`. Uniform zoom scales all three spans by the same factor and keeps that ratio. Single-axis zoom changes it. Panning translates the intervals without changing their spans. Ticks are generated locally from the new spans at display rate, so the box does not move and no engine request is needed for a tick update.

### Fixed card, the rotation envelope, and label room

Keep the outer card's size and aspect, and keep the box's size inside it, for the whole session. Woxi's automatic height follows the projected box and is re-fitted for every view, so a rotated view changes the picture's shape. That would move the notebook on every frame. Fix the card from `ImageSize`, and fit the box into it once.

The fit has to name what it fits, and the choice decides how much of the card the box uses. The projections the box goes through as it turns are not one rectangle: a flat wide box seen from the side and the same box seen from the top need different room. Three candidates:
- fit the first frame's projected rectangle: the box fills the card at rest, but any turn crops the box and its labels.
- re-fit on every camera change: the box always fills the card and never crops, but it grows and shrinks while a finger turns it, which reads as zooming.
- fit the envelope of every reachable orientation: the box keeps one size, nothing ever crops, and the box is as large as both rules allow.

The client does the third. `projectedEnvelope` samples the turntable (azimuth all round, elevation to `MAX_ELEVATION`, the same limit the gesture uses) and records the largest half-extent the box's projected rectangle reaches on each screen axis, perspective included. `fitScale` maps that envelope onto the card with the same scale on both axes in pixels, so the box keeps its shape. At rest a box that is squarer than its envelope leaves some room, and a box that sweeps a nearly square envelope (the default `Plot3D` box, `{1,1,0.4}`) fills the card almost completely.

The card's own aspect follows the envelope as well (`envelopeAspect`), which is Woxi's "the height follows the box" rule made safe for rotation, capped at Woxi's 1.2 height-to-width limit. A card shaped like the envelope is the only shape in which the box can fill it and still fit at every orientation. `ImageSize -> {w,h}` pins both dimensions instead, and the fit letterboxes inside it.

The tick labels also need room, and they sit a fixed number of pixels out from their ticks, so they are not part of the projection. `labelPads` measures the labels at the trial scale over the reachable orientations (the z labels swap sides and the x/y labels move between edges as the camera turns) and returns how far past the box's rectangle they reach on each side. The box stays centred on the card - the centre is the pivot a pinch zooms about - so the room on one side is taken on both. `fitProjection` measures and re-fits twice, which is enough for a fixed pixel offset. The result is that the box and its labels fill the card and nothing is cut at any angle.

`ImageSize -> {w,h}` pins both dimensions. A bare width lets the height follow the box's envelope, while `{Automatic,h}` is `h x h`, `{w,Automatic}` is `w x w`, and `{Automatic,Automatic}` is Woxi's 360 x 360 pair. `AspectRatio` is a square-card quirk on the plot heads and is not a usable ratio there. `Graphics3D` would honour it if that scene path is added later.

The hard part is coverage, not the mapping. A 3D margin beyond the view is a domain margin in x/y (surface), u/v (parametric) or x/y/z (contour/region), not a 1D pad. `Plot3D` has a fixed 50x50 sampler and ignores `PlotPoints`, so it needs an engine sampler or an upstream change before a data-range pan can reveal new points. `ParametricPlot3D`, `SphericalPlot3D` and the contour/region heads can be re-evaluated with a new range and `PlotPoints`, but that is expensive and belongs on the idle path. The client must keep drawing the old coverage while a new one is in flight, as 2D does.

The geometry is now data-space from extraction onward. The client maps it into the fixed box with the current view uniforms, clips it against the view in the fragment shader, and keeps the surface buffers uploaded while a gesture changes only the camera, the view uniforms and the local tick geometry. `ImageSize`/card aspect are part of the fixed layout: `{w,h}` pins both dimensions, `{Automatic,Automatic}` is 360 x 360, `{Automatic,h}` is `h x h`, `{w,Automatic}` is `w x w`, a one-element list unwraps to its named or numeric size, the min/max range form uses 360-square defaults, a bare width takes the box's rotation envelope as its height, and Woxi's plot-head `AspectRatio` is a square-card quirk rather than a usable ratio.

The interaction is implemented as designed: turntable orbit about the box centre for one finger, and viewport-plane translation plus uniform range zoom about the box-centre plane for two fingers. Exact arbitrary surface-point tracking during rotation remains an optional trackball, not the default. The first two phases are done: (1) explicit `PlotRange`, head-specific `BoxRatios`, `ImageSize` and data-space geometry with local ticks. (2) turntable rotation with a fixed card, plus two-finger centre-plane pan/uniform zoom inside the gesture bounds. The remaining phases are (3) asynchronous re-sampling and margins for the heads that support it, (4) range gestures for `Plot3D` only after it has a sampler that can extend the domain, and (5) golden projection, gesture and coverage-boundary tests.

## Architecture

One evaluation produces one `plot3d` item:

```
Woxi evaluation
  -> Expr::Graphics { is_3d, structure: Graphics3D[GraphicsComplex] }
  -> engine scene3d extraction (vertices, cells, colours, lines, camera, ranges)
  -> compact JSON item (base64 typed arrays)
  -> client WebGL2 renderer + 2D label overlay
```

During a gesture the controller updates the camera and/or the data-view uniforms, and refreshes the local tick geometry. There is no engine request while the view stays inside the gesture bounds. This version does not grow coverage yet. A later version can ask the engine for a larger sampled domain or a higher-resolution mesh on the idle path. Rotation stays camera-only.

### Engine extraction

A new `engine/src/scene3d` module takes the `Graphics` expression after evaluation. It accepts a `Graphics3D[GraphicsComplex[points, primitives], options]` where the primitives are polygons and lines. Supported plot heads are the ones that emit that form:

- `Plot3D`, `ListPlot3D`, `ParametricPlot3D`,
- `ContourPlot3D`, `RegionPlot3D`,
- `SphericalPlot3D`.

`Polygon` may be one indexed cell or a multipolygon (a list of cells). Contour and region plots use the latter. A quadrilateral is split on its b-d diagonal, matching Woxi's standalone surface triangulation. `Line` becomes line segments. Colours and opacities are taken from the `RGBColor`/`Opacity` directives that wrap the faces (a `ColorFunction` wraps each cell. A default surface has one style). Mesh and default-boundary line colours are sent per endpoint. Normals are computed on the client.

Any picture with a primitive the scene cannot express - `Sphere`, `Cuboid`, `Tube`, textures, raster/volume data - is left as the existing static SVG. That includes `Graphics3D` primitives, `VectorPlot3D`, `StreamPlot3D`, `DensityPlot3D`, `Image3D`, charts and `ListLinePlot3D` (which has no structure). There is no second interaction path and no placeholder.

The payload is:

```json
{"camera":{"az":-1.07,"el":0.63,"dist":6.767569726275452,"perspective":true},
 "ranges":[[x0,x1],[y0,y1],[z0,z1]], "box":[1,1,0.4],
 "vertices":"<base64 f32 xyz in data units>", "indices":"<base64 u32>",
 "colors":"<base64 u8 rgba per triangle>",
 "lines":"<base64 f32 xyz endpoint pairs in data units>", "lineColors":"<base64 u8 rgba per line endpoint>",
 "theme":{"background":"#1a1a1a","axis":[153,153,153],"label":[153,153,153]},
 "coverage":[[x0,x1],[y0,y1],[z0,z1]], "card":{"width":300,"height":200,"full":false},
 "axes":true, "boxed":true}
```

Vertices and line endpoints are in data units. The client maps them into the fixed box with `uViewLow`/`uViewSpan`/`uBox`. `ranges` is the current view and `coverage` is the larger sampled extent. The camera is Woxi's default (azimuth -1.07, elevation 0.63, perspective distance 2*|{1.3,-2.4,2}| times the longest box side), with `perspective:false` for `ViewProjection -> "Orthographic"` or an infinite `ViewPoint`. `card.width`/`card.height` come from `ImageSize`. A null width fills the card and a null height uses the fixed aspect. `theme` carries the engine's current light/dark plot palette. `lineColors` carries the complete per-endpoint style. A regular grid can later send a smaller grid form. This version uses indexed vertices for every source.

### Client renderer

`plot3d.js` owns the WebGL2 and overlay canvases, the camera, input and lifecycle. `plot3d-geometry.js` decodes the mesh and builds per-source-vertex normals and transparent index order. `plot3d-axes.js` chooses the view-dependent axis edges and paints the ticks and labels. The controller keeps the camera and the data view, and uploads surface geometry only on setup or after a context restore. The shader maps a data-space vertex into the box from the current view and then uses the same projection as Woxi's `project`: orthographic `dot(p, right)` / `dot(p, up)`, multiplied by `dist / (dist - dot(p, toward))` for perspective. `dist` and the camera basis are uniforms.

The initial camera basis and projection match Woxi. The fixed card fits the box's rotation envelope plus its tick labels, so the box is as large as it can be without a label or an edge leaving the card at any camera angle (see "Fixed card, the rotation envelope, and label room"). The fixed box edges stay uploaded. The three camera-dependent axis lines are rebuilt and uploaded with each draw while the surface buffers stay untouched. The fragment shader discards data fragments outside the current view, so a narrowed `PlotRange` clips the surface and lines at the box.

Rendering order is opaque triangles, transparent triangles sorted back-to-front, mesh lines, box edges and axis lines, then the label overlay. Back-face culling is off and lighting is two-sided, because Woxi lights a facet turned away from the viewer by flipping its normal. Lines get a small depth bias so the mesh does not z-fight.

The axes use view-dependent edges: x on the bottom edge of the nearer y-face and y on the bottom edge of the nearer x-face (each decided by that face's depth, so an axis changes edge only when its own face is the nearer one, and its labels run from the low-value corner so they never slide along the edge), the leftmost or rightmost vertical edge for z (Woxi's rule, so z labels sit beside the silhouette. Which of the two it is changes when the view passes the symmetric camera, and then the z labels move to the other side of the box in one frame - that is what a rule keyed on "outside" has to do, and Woxi's static renderer makes the same choice), fixed screen-perpendicular marks, outward labels, 10 px labels, minor ticks and Woxi's own tick number format.

Labels are thinned so that no two overlap, on one axis or across the shared corner: an axis seen end-on, whose ticks land on one spot, keeps its end labels and drops the interior ones. Box edges and axis lines use separate buffers: the box is fixed, while the three axis lines are refreshed with the camera (including unboxed scenes). The viewport is fixed from the first layout and never re-fitted while a finger is down, so the picture cannot jump. Labels are horizontal and drawn on top, as Woxi draws them. A range change rebuilds only the axis/tick data and labels. The box and surface buffers stay uploaded.

WebGL2 is required. A missing context hides the card. A lost context hides it until the browser restores it. The controller then rebuilds its GPU state from the retained scene and redraws. There is no software fallback and no partial placeholder.

### Interaction

- one-finger drag: turntable orbit (azimuth/elevation, elevation clamped away from the poles). The box centre stays fixed,
- two-finger pinch/drag: a screen-space translation plus uniform scale on the viewport-parallel plane through the box centre, applied as a uniform range zoom/pan. Points on that plane follow the fingers exactly, while other depths show the usual projective parallax under a perspective camera,
- finger twist: ignored, because a pure range pan/zoom cannot represent it,
- range gestures: clamped to the scene's gesture bounds (the sampled coverage plus the initial view). At the initial full view a pinch can zoom in and then pan, but cannot zoom out past those bounds. Zooming in is also limited to `MIN_SPAN_FRACTION` (5%) of the initial span, so repeated pinches cannot collapse the view.
- double tap: reset the camera and the initial data view.

`touch-action: none` on the plot root, pointer capture, and the same scroll arbitration as 2D. There is no request in flight. The controller redraws on the next display frame. A low-resolution mesh is not refined during a gesture. A later version can request a higher-resolution mesh after the gesture goes idle.

### Harness

New actions: `plot3dstate last`, `plot3dperf [reset]`, `plot3dspin frames,dy`, `plot3dpinch factor`. The perf counters are frames, paint time and geometry count. The existing `plotstate`/`plotperf` stay 2D-only.

## Consistent with 2D, and 3D-specific

Consistent:
- the engine owns Woxi evaluation, option coverage, sampling and geometry. The client owns layout, painting, tick generation and gestures.
- one answer per evaluation, async, stale handling, no evaluation while typing.
- a fixed box/canvas, no jumps, labels outside, no label-side flips.
- the same test-harness style and the same static rule for unsupported pictures.
- a disposed controller removes its pointer, resize and context listeners, as the 2D controller does.
- A malformed saved scene with missing fields is rejected before it can break the output. A scene with inconsistent base64 buffers is rejected when its geometry is decoded, rather than drawn partially or silently truncated. It is not migrated.

3D-specific:
- WebGL2, depth buffer, two-sided lighting, transparency order, mesh depth bias.
- camera orbit and data-view range pan/zoom, with the projected box/axes/ticks.
- local tick generation, because the 3D view never asks the engine for a new picture.
- geometry buffers, GPU upload and context lifecycle: one WebGL2 context per plot. WebGL2 is required.
- optional level-of-detail/refine after an idle gesture (later).

## Work order

The work order below is what was done:
- Engine extraction, tests and payload measurements. Supported heads and SVG refusal for unsupported pictures.
- `plot3d` output item, HTML rendering, notebook persistence and client attach.
- WebGL2 renderer, camera, box, mesh and labels. Compare the default view with Woxi.
- Data-space geometry, explicit `PlotRange`/`ImageSize`/head-specific `BoxRatios`, local ticks, turntable rotation, centre-plane range pan/uniform zoom and reset. `plot3dstate`/`plot3dperf` and device tests.
- CSS, docs, and the final static checks.

Known gaps in this version: `coverage` is not expanded after a range gesture, so a plot whose initial coverage is the full domain cannot pan or zoom out beyond it. `Plot3D` still needs an engine sampler or an upstream change before that can happen. A structure line the extractor cannot represent, or an incomplete Parametric grid whose default mesh cannot be reconstructed, makes the whole scene static instead of dropping that geometry silently. `ContourPlot3D` and `RegionPlot3D` carry no default mesh in the symbolic structure. Custom `Mesh -> All`, `MeshFunctions` and custom `MeshStyle` are deliberately static.

A scene whose data would lose too much precision in the f32 payload falls back to SVG. The camera is not written back to the notebook item. Finite perspective view points/lighting options remain static. The client-side lighting is a two-sided approximation of Woxi's view-fixed model, and a box whose rotation envelope is much squarer than its first frame (a long, flat `BoxRatios`) fills the card at rest only to the extent its widest orientation allows, because the box's size is fixed. The measured gesture path is display-rate, and the payload is 10-20 times smaller than the SVG it replaces.
