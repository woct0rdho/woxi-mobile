# Plot Interaction Review

## Scope

This document lists the plotting findings that are still open. The ones that were fixed have been removed from it. Everything below was re-checked against the current sources, and the numbers quoted were measured on the emulator (Android 16, API 36, x86_64).

Source references use function names rather than line numbers, because the files have moved. JavaScript is under `app/src/main/assets/www/js/`, Kotlin under `app/src/main/kotlin/com/woctordho/woximobile/`, and the engine is `engine/src/lib.rs`.

## Remaining issues

### R1 [P2] `Manipulate` plots have no handle, so they cannot be panned or zoomed

`evaluate_manipulate()` renders the body through `render_body()` and returns `{"svg": ...}` directly. It never calls `register_plot()`, so the picture a Manipulate shows has no view handle: moving a slider redraws it, but dragging it does nothing.

Making it interactive needs three things that are all local: register a plot after each body render, keep the control bindings with the `PlotCall` so `plot_refine` can re-run `With[bindings, body]` with rewritten iterators, and re-wire the controller after a slider move (the render replaces the SVG in place, so the existing controller would otherwise keep addressing a handle that no longer exists).

Acceptance: a `Manipulate[Plot[...], ...]` can be panned and zoomed, a slider move produces a new picture at the plot's original view, and no handle survives its slider move.

### R2 [P2] A running refinement cannot be preempted

Views are served before background re-sampling now, and a queued re-sample is dropped as soon as a view arrives, so a re-sample no longer delays a gesture frame. What is left is the running case: `render_refine()` is one `evaluate_expr_to_expr()` call, and nothing can interrupt it. A gesture that starts while it runs waits for it to finish before its first frame reaches the engine.

Interrupting it needs cooperation from the engine - a flag checked between sampling chunks, which a single `interpret` call cannot provide - or a different way of sampling (several smaller calls with a checkpoint between them). Neither is possible without changing Woxi, so this stays open. The current mitigation is to make refinements cheap enough not to matter: the sampling density is fixed and the interval between re-samples is enforced.

Acceptance: begin a pan during a deliberately slow refinement. The first engine frame must arrive before the refinement finishes.

### R3 [P2] Every frame is still a complete SVG, and gestures have no local preview

A frame replaces the picture with a newly rendered SVG, and a contour plot's SVG is 319 KB with 2,119 elements, measured at 82 ms round trip plus 11 ms of DOM work. There is no local preview between frames either: an attempt that transformed the whole SVG moved the frame axes, ticks and labels along with the curve and snapped them back on every answer, which looked worse than waiting, so it was removed rather than kept as a compromise.

The next step is the one the first review outlined: split the data layer from the axes and labels, so a preview can transform a clipped copy of the drawing and leave the frame where it is. For heavy plots, render from a reusable data or canvas representation instead of transporting complete SVG strings. Neither is a small change, and neither is needed for correctness.

Until then the frame is kept still by geometry, not by a preview: a gesture freezes the crop it started with, so every engine frame lands in the same box, and the crop is re-trimmed only when the finger lifts. If the tighter trim would only remove margin it is kept, so a pan does not move the frame at all. If the labels grew and would be cut, the crop is interpolated over about 160 ms instead of jumping. The cost of the second rule is a single smooth settle at lift, which is why the layered renderer is still the right fix.

Acceptance: a contour frame costs under 16 ms including paint, and a gesture shows a preview in which the frame does not move.

### R4 [P3] `Out[n]` is not maintained

`%` and `Out[]` now agree with the last result, including cells that the interpreter answers without recording history (bare numbers, strings, simple lists). `Out[3]`, however, never resolves: Woxi keeps only the latest output, so a notebook that refers back to an earlier cell's result gets `Out[3]` unevaluated.

The wrapper could keep its own list and substitute the value before evaluation, but that is a text rewrite of user input with real failure modes (strings, comments, shadowed `Out`). The honest fix is in the interpreter, so this is documented rather than worked around.

Acceptance: `1`, `2`, `Out[1]` returns 1.

### R5 [P3] One engine thread, so a long evaluation blocks plot frames

The interpreter is stateful and not thread safe, so all work - evaluation, views, re-sampling - runs on one thread. A heavy evaluation therefore delays the next gesture frame, just as a refinement used to. Moving the interpreter onto parallel threads is not safe. The alternatives are to bound evaluation time or to give plot re-rendering a separate path that does not touch the interpreter, which is R3's data-layer work.

Acceptance: a pan during a multi-second evaluation still shows preview frames.

## Out of scope

3D gestures, full-screen plot view, and plot interactivity for `Show`-composed graphics are not covered in the above review findings.
