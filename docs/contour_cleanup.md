# Contour cleanup

Woxi draws contour lines with plain marching squares. The grid is not one constant: ordinary `ContourPlot` and equation contours use `FIELD_GRID = 100`, a `RegionFunction` contour uses `FIELD_GRID * 4`, and `ListContourPlot` uses the data grid's dimensions. Woxi's SVG frame is the outer, padded rectangle. The contour cells are measured on the data rectangle inside it. At a saddle the two segments are emitted separately. `chain_segments` may then join them at a shared cell-edge endpoint, or leave them as two chains. When the crossing lies near that edge, the four arms can come back as two U hooks linked by a one-cell bridge, or as two contours whose ends stop a cell or two apart. The data series and the SVG are both traces of that same grid, so both can show the artifact.

The cleanup reconstructs the contour graph after Woxi has sampled it. It does not move individual points and it does not change the plot ranges or the interaction padding.

## Algorithm

- Estimate the grid from the raw chains. Each marching-squares segment spans at most one cell. Take the median of the per-chain maximum x/y steps, so a repaired junction-to-arm segment or one unrelated long polyline cannot set the scale. If that estimate is within 10% of the data rectangle divided by 100, use the exact fallback. This absorbs one-decimal SVG coordinates. A genuinely finer `RegionFunction` grid or a coarser `ListContourPlot` grid is outside that tolerance and keeps the measured cell.
- A repaired SVG stores its cell in the root `data-woxi-contour-cell` attribute before another repair. A source is measured once per `repair_source` call. A source's fallback is `x_range`/`y_range` divided by 100. An SVG's is the data rectangle divided by 100. A frame-less SVG falls back to median point spacing. The graph works in cell coordinates, one unit per cell on each axis. An SVG's outer fill-less, stroked frame is inset by `WOXI_FIELD_RANGE_PADDING` (2%, Woxi's default) to recover the data rectangle before cells are normalized.
- Find junction zones. Vertices of different chains within two cell spacings are joined into a zone. Two cells cover the one-cell saddle bridge and the endpoint offset of adjacent segments. Contact vertices on the same chain form one run only when they are at most two indices apart and within the maximum continuation gap. This keeps a point that merely lies elsewhere on a long chain from joining the run. Contact clusters whose centres are within that same radius are merged: a saddle at a grid node can produce one cluster for the vertical arms and another for the horizontal arms.
- Decide what is already continuous. A chain whose sampled run through the zone stays within `0.55` cell of the chord and whose consecutive segments turn by no more than the line-angle tolerance is a line passing through the zone. It is left untouched. Only a U hook or a chain end is split. This prevents a near pass from being turned into a false crossing.
- Match arms globally. Every split run that has an outside arm is an all-or-nothing unit: arms from the same original chain are never paired, and a run with no outside arm is left untouched. The remaining arms are matched at each zone by a minimum-cost assignment over the armed split runs (a bitmask dynamic-program), with a bounded arm count. An arm may be left unmatched at a penalty. A pair is scored from the oriented angle between the outward tangents (a continuation points within `35°` of opposite), the perpendicular offset from the line joining the two boundary points, and the gap between the two inside run tips.
- The tangent uses two consecutive chain segments because Woxi's marching-squares output is piecewise straight between cell edges. A pair of chain ends is scored by the same matching and gap rule as every other arm.
- Compute one junction point. The paired arms give one or more lines through their outside boundary points. A least-squares intersection of those lines gives the X. If the lines are nearly parallel, or the intersection is not local, the mean of the paired run tips is used. Bridges and the inside of the zone are discarded.
- Trace the graph. Each outside run is an arc. The matching tells which arc end continues into which other arc end. Tracing from free ends produces the final polylines. A chain with no active zone is copied exactly, which keeps the pass idempotent and avoids touching ordinary curves. Isolated fragments and one-point chains are preserved. The graph does not have enough contour identity to prove that a short fragment is an artifact rather than a real island. If a matched arm cannot be mapped to an outside arc, the whole style group is left as Woxi drew it rather than cutting away geometry.

Reconstruction is iterated at most four times. The grid is measured once from the raw chains and reused for every pass. A repaired chain has longer junction-to-arm segments and must not be allowed to change the cell scale. The SVG stores the measured cell in its root `data-woxi-contour-cell` attribute so a repeated repair is idempotent. The source has no metadata field in `PlotSource`. It is measured once per call and its own fixed-point passes reuse that measurement. The cap prevents a pathological graph cycle from making cleanup unbounded.

A source boundary is its `x_range`/`y_range`. An SVG boundary is the data rectangle inside its padded frame. The cleanup does not invent a boundary from the extent of emitted points, and it does not drop short chains: a short chain may be a real contour island.

There is deliberately no point smoothing before tracing. Topology is solved first. Any future smoothing must run only on the already-connected chains.

The SVG pass has two entry modes. A standalone SVG is processed only when its polylines carry Woxi's contour attributes (`fill="none"` and round caps/joins). A `Graphics` with a `PlotSource`, or a caller that already knows it is rendering a contour (a `Manipulate` body), uses the permissive mode: the merged `Show` renderer can emit plain `<polyline>` tags without those attributes, so every polyline in that source-backed picture is eligible. The same permissive mode is used for a wrapped contour with no direct `Graphics`.

## Parameter derivation

The only external calibration is Woxi's own grid:
- Woxi samples a 100-cell grid for ordinary `ContourPlot`, a 400-cell grid for `RegionFunction`, and the data grid for `ListContourPlot`. The cleanup does not assume one of those counts: it measures the cell from the raw point steps. The source fallback uses `x_range`/`y_range` divided by 100. The SVG fallback uses the data rectangle divided by 100.
- `WOXI_FIELD_RANGE_PADDING = 0.02` is Woxi's default field-plot padding. The SVG fill-less frame is inset by this fraction to get the data rectangle.
- The cell estimate is the median of the per-chain maximum x/y steps. Raw Woxi chains contain full-cell steps. A repaired SVG carries its measured cell in metadata so a second repair does not measure junction-to-arm segments instead. A source has no metadata field, so it is measured once per call.
- `CELL_ESTIMATE_TOLERANCE = 0.1`: a measured cell within 10% of the 100-cell fallback is treated as that fallback. This absorbs one-decimal SVG rounding while allowing 400-cell and data-sized grids to differ measurably.
- `CONTACT_STEPS = 2` cells: a saddle bridge spans one cell and its two adjacent segments can be offset by one more.
- `TANGENT_STEPS = 2`: two consecutive straight segments determine the tangent.
- `MAX_CONTACT_INDEX_GAP = 2` lets one non-contact sample sit between two contact samples on the same chain. Larger gaps are separate runs. The same run also has to stay within `MAX_GAP_STEPS` geometrically.
- `MAX_OFFSET_STEPS = 0.8 * CONTACT_STEPS`: a conservative fraction of the contact radius for the perpendicular offset of an arm from its partner's boundary line.
- `THROUGH_OFFSET_STEPS = 0.55` and the `35°` adjacent-segment turn limit reject a U hook. A path-length ratio is deliberately not used: the offset plus local turn test already rejects the observed hooks, and a ratio would reject valid curved through-lines.
- Offsets and gaps are expressed in cell units. The angular tolerance is the uncertainty of a tangent measured from a two-segment sample, not a screen-size constant.
- `CONTACT_STEPS * 2` is the largest tip-to-tip gap accepted for a continuation.
- `UNMATCHED_PENALTY = 3 / 2`: a pair has three normalized terms, so half their maximum is the point at which a pair is no better than leaving both arms alone.
- `MAX_ZONE_ARMS = 8` bounds the exact bitmask assignment: two full Woxi saddles. Only split runs that contribute an outside arm enter the mask. A run with no arm is left untouched. A larger zone is left as Woxi drew it. This is a deliberate complexity guard.
- `MAX_JUNCTION_RADIUS_STEPS = MAX_GAP_STEPS + 1`: conservative slack around the fitted junction.
- `BOUNDARY_MARGIN_STEPS = 0.5` is half a cell. A junction closer than that to the data rectangle is a boundary artifact.
- `MAX_REPAIR_PASSES = 4` is a termination budget for cascading graph repairs, not a quality threshold.
- `MIN_CELL` and `MIN_DETERMINANT` name the numerical tolerances instead of leaving bare `1e-12`/`1e-9` values at their call sites.

## Why the padded two-axis view is not changed

`docs/plot_interaction.md` requires a padded re-sample (up to one view of margin) so panning can draw from cached samples. Making the re-sample use the exact view made the crossings geometrically simpler, but it caused a re-sample on almost every frame and made panning less smooth. That change was reverted.

This cleanup works on the padded source and the padded SVG. It does not alter `TWO_AXIS_MAX_REFINE_PAD`, the client `TWO_AXIS_REFINE_PAD`, or the interaction constants.

## Tests

The module tests are split under `engine/src/plot/contour/tests/`. They cover:
- a clean crossing and a near pass being returned bit-for-bit unchanged.
- a T junction and a junction on the sampled frame not being joined.
- source cell scales, measured source/SVG cell rates, a non-square SVG frame, the outer-frame/data-rectangle padding, and a one-long-segment cell estimate.
- a small-cell SVG metadata round trip, and an unstroked rectangle not being mistaken for a frame.
- non-contour polylines being left alone (the SVG pass only recognizes Woxi's fill-less, round-cap contour polylines).
- source `Filling -> Series[index]` references preventing all reordering.
- same-chain arms, same-direction arms, and opposite arms with a gap.
- the raw `Sin[x] Sin[y] == 0` grid source and SVG: the rounded hooks become a true crossing.
- different styles never being joined, and labeled source series never being joined.
- an invalid source range being left unchanged.
- idempotence of graph, source, and SVG repair, including the measured-cell metadata that keeps the SVG on one grid across passes.
- source and SVG versions of the same crossing, and a shared source/SVG chain count for the padded fixture.
- actual `RegionFunction`, `ListContourPlot`, custom-padding, and wrapped `Show` outputs through the evaluation path, carrying the measured cell. These registration tests assert the cell marker, while the geometry tests above assert the reconstructed crossings.
- a `Rule`-wrapped `Graphics` being visited by the complete expression walk, and a source-backed graphics accepting plain `Show` polylines.
- the real 34-chain padded `Sin[x] == Cos[y]` fixture through the actual source fixed-point loop and through the SVG parser: no interior bridges.
- a one-point chain, a pile of zero-arm fragments, SVG frame bounds, static SVG parsing, and preservation of unrelated polylines.

Device checks:
- initial `ContourPlot[Sin[x] == Cos[y], ...]`: interior crossings are clean. Woxi's own frame-edge V hooks remain where a contour turns at the domain boundary.
- after a `plotsweep`, every interior crossing is a clean X with no hooks or gaps.
- circle, diamond, non-square range, `ListContourPlot`, `ComplexContourPlot`, `RegionFunction`, `Show[..., Frame -> False]`, and a `Manipulate` contour with its slider moved still render with clean crossings.
- panning remains smooth because the two-axis pad and request policy are unchanged.

## Remaining limits

The graph repair can only use the segments Woxi emitted. A saddle cell that contains no reliable continuation evidence is left as Woxi drew it rather than being guessed. A contour that touches the exact domain boundary can still be clipped or hooked by Woxi's boundary rule. That is sampler clipping, not an interior crossing. Styling is still the only identity available: two contour levels or functions drawn with the same style are one graph, constrained by geometry and the zone arm cap, and a `Show` that deliberately copies style and contour attributes remains ambiguous.

Cleanup is selected by the statement mentioning a contour head. A contour returned by a user-defined function or an earlier `%` output without that head is not identified by the current dispatch. The SVG pass recognizes only `<polyline>` tags with Woxi's contour attributes (`fill="none"` and round caps/joins). A contour SVG from a different producer, or a frame that is not a stroked fill-less rectangle, is left unchanged. A source-backed or known-contour picture uses the permissive mode, which treats every polyline as eligible. An unrelated polyline that copies contour attributes and lies near the contour still cannot be distinguished.

The SVG path uses Woxi's default 2% `PlotRangePadding`. A custom padding is not carried by a standalone SVG. The symbolic `Graphics` structure is not rewritten. The app displays the repaired SVG and source series. The correct long-term fix inside the sampler is the asymptotic decider or adaptive subdivision at the saddle cell. That requires changing the field sampler, not the rendered polyline. The graph repair is the safe post-processing layer and remains compatible with the current Woxi dependency.
