# Output Typesetting

## Status

Phase A is implemented. `app/src/main/assets/www/fonts/` now ships Atkinson Hyperlegible Mono (the face the box layout's 0.632 em advance describes), Atkinson Hyperlegible Next (the face the plot padding tables measure with) and a subset of DejaVu Sans Mono for the glyphs the primary mono lacks. `app.css` pins typeset SVG text and plot SVG text to them, and typeset output sizes are expressed in em in `render-output.js` so a result keeps the layout's own scale instead of being fitted to a fixed height. Wide results scroll sideways rather than shrinking.

The horizontal spacing of the layout is normalized in `engine/src/typeset.rs`, which rewrites run positions in the SVG (never glyphs or nesting): a product's word space becomes the thin space the layout itself uses inside a box string (`0.32` cell), a relation the layout leaves unspaced gets the margins of its own operator table (`0.60` cell for rules, `0.44` for equality and comparison, `0.34` for the logical operators), and a fraction whose numerator or denominator got narrower is re-centred with a re-sized bar. `TraditionalForm` output, whose box formatter already writes thin spaces and real operator glyphs, is detected by its existing right margin and left untouched.

The one visible gap left is a product inside a radical (the radical path is drawn around the old content width and is not re-generated). The box-formatter-level spacing missing around relations (`x -> 1` is emitted as three adjacent cells) is a Woxi issue, recorded under Phase C.

## Scope

This document is about how an evaluated result is drawn. It does not touch input, the keyboard, or plot interaction. Everything below was checked against the current sources and against the engine crate (`woxi` 0.4.0) with a probe binary, and the screenshots were taken on the emulator (Android 16, API 36, x86_64, 393*827 CSS, dpr 2.75).

The relevant sources are `engine/src/eval.rs` (which asks Woxi for an SVG), `engine/src/output.rs` (the output item shape), `app/src/main/assets/www/js/render-output.js` (item -> HTML) and `app/src/main/assets/www/css/app.css` (`.woxi-out-math`, `.woxi-out-text`, `.woxi-out-graphic`).

## What happens today

Woxi typesets every result itself. `generate_output_svg()` converts the result expression to box form (`expr_to_box_form`, or `expr_to_box_form_traditional` for `TraditionalForm[...]`), lays the boxes out at 14 px (`layout_box`) and serialises the layout to an SVG (`layout_to_svg`). That SVG is what `InterpretResult::output_svg` carries, and the app shows it in `.woxi-out-math`. When there is no SVG the app falls back to the plain result text in `.woxi-out-text`. Graphics are separate SVGs (`InterpretResult::graphics`).

The SVG is plain `<text>` markup. Three text elements and their positions are all that a result like `x -> 1` is:

```
<svg xmlns="http://www.w3.org/2000/svg" width="27" height="15">
<g fill="black" stroke="black" color="black">
<g transform="translate(0.0,0.0)"><text x="0" y="11.2" font-family="monospace" font-size="14.0" stroke="none" font-style="italic">x</text></g>
<g transform="translate(8.8,0.0)"><text x="0" y="11.2" font-family="monospace" font-size="14.0" stroke="none">→</text></g>
<g transform="translate(17.7,0.0)"><text x="0" y="11.2" font-family="monospace" font-size="14.0" stroke="none">1</text></g>
</g></svg>
```

The layout advances by `font_size * 0.632` per character (`MONO_ADVANCE` in `functions::graphics`), i.e. 8.85 px per cell. It never measures the font it names: the text elements simply say `font-family="monospace"`.

## Two independent bugs

### The metric the layout assumes is not the metric the device renders

0.632 em is exactly the advance of Atkinson Hyperlegible Mono (units per em 1000, every glyph 632, verified with `fontTools`). That font is bundled inside the Woxi crate (`resources/AtkinsonHyperlegibleMono-Regular.ttf`, `-Bold.ttf`) and registered in the crate's own SVG rasteriser (`image_ast::load_embedded_fonts`, used for PNG/PDF export). The app bundles no font at all: `assets/www` contains only `css/`, `js/` and `index.html`.

On Android, `monospace` resolves to DroidSansMono, whose advance is 0.600 em (1229/2048), not 0.632. Worse, DroidSansMono has no U+2192 `→` and no `∈`. The arrow falls back to a proportional system font. The arrow, drawn inside a cell reserved for 8.85 px, is about 0.9 em wide, so the `1` at x = 17.7 px lands on its head. That is the tight `x → 1` on the screenshots, and the same drift applies to every run (digit groups, italic words, superscripts).

`→` is not an exotic case: it is the operator a rule result is made of. The glyph set of the bundled mono covers `π ∑ ∫ ∞ ± × ÷ ≤ ≥ ≠ ≈ √`, but not `→ ← ↔ θ λ ∈ ⊂ ⊆ ∪ ∩ ∅ ∀ ∃ ⊕ ⊗`.

### The CSS forces every result to one height

```
.woxi-out-math .woxi-svg { height: 1.35em; width: auto; max-width: 100%; }
```

1.35 em of the 15 px body text is 20.25 px. The layout figures, measured from the actual SVGs:

| result | SVG size | scale to 20.25 px | glyph size |
|---|---|---|---|
| `x -> 1` | 27*15 | 1.35x | 18.9 px |
| `1/2 + x^2` | 45*37 | 0.55x | 7.7 px |
| `TraditionalForm[Sum[1/n^2, ...]]` (`π²/6`) | 20*39 | 0.52x | 7.3 px |
| `Sqrt[x^2 + y^2] + Sin[x]^2` | 132*22 | 0.92x | 12.9 px |
| `N[Pi, 30]` | 275*15 | 1.35x | 18.9 px |

So a simple result is drawn 35 % larger than the input text while a fraction is drawn at half size: the same expression class changes size by a factor of 2.6 depending on how many rows it has. On the device the `π²/6` result is unreadable next to its own input. Typesetting must keep the scale the layout used and let the box grow vertically.

## What Woxi can display

- `StandardForm` is the default. `output_svg` is always generated through `expr_to_box_form`.
- `TraditionalForm[expr]` typesets through the dedicated traditional box path. A probe of `TraditionalForm[Sum[1/n^2, {n, 1, Infinity}]]` renders a stacked `π²/6` (π as a glyph), and `TraditionalForm[Sin[x]^2]` renders `sin²(x)`. The interpreter then keeps the box form itself as the last output (`FormBox[RowBox[...], TraditionalForm]`), and the printed result text remains `TraditionalForm[...]`. So it works for display, but it is a wrapper in the input rather than a display setting, and `%` sees a box expression.
- `InputForm[expr]` prints its content as text and skips the SVG.
- `TeXForm`, `FullForm`, `CForm` and `FortranForm` also skip the SVG, but in this printing path the result text is the wrapper itself (`TeXForm[1/2 + x]`), while the converted value only becomes the interpreter's last output. They are not a display path today. A probe of `FullForm[1/2 + x]` prints `FullForm[1/2 + x]`, not `Plus[1/2, x]`.
- `expr_to_tex(&Expr)` is public (`woxi::functions::string_ast::expr_to_tex`, also re-exported from `functions`) and produces TraditionalForm-flavoured TeX: `x\to 1`, `\frac{13}{21}`, `\sqrt{x^2+y^2}`, `\cos ^2(y)`, `\left(\begin{array}{cc}...\end{array}\right)`, `\begin{cases}...\end{cases}`, `\binom{n}{k}`. It reorders terms the way TraditionalForm does (`x^2 + 3x + 2` becomes `3 x+x^2+2`), a few heads come out as `\text{SeriesData}`, `| x|` is spaced loosely, and a form wrapper is not unwrapped (`expr_to_tex` of a `TraditionalForm[...]` result prints `\text{TraditionalForm}[...]`). Converting a box form needs the box-level TeX converter (`box_ast_to_tex`, private today), which is the same upstream ask as in Phase C.
- There is no front-end output-form setting: no `$OutputForm`, `FormatType` or equivalent. `output_svg` has no option for the form. Choosing a form is therefore either a wrapper in the input or an engine change.

The conclusion for now: the app only has to support the current (StandardForm) display. A form selector is a product decision on top of an engine change, not something Woxi already offers.

## Is a font already bundled?

No. `assets/www` has no font files, `res/font` does not exist, and the CSS only names `system-ui, sans-serif` and `monospace`. The Woxi crate ships Atkinson Hyperlegible Mono (regular, bold, variable), Atkinson Hyperlegible Next (bold, variable) and Leland (music notation, OFL) - a legibility mono and a text face, not a math font. KaTeX, Latin Modern Math, STIX and friends are not present anywhere in the APK.

So a font has to be bundled whichever renderer we keep:
- with Woxi's SVG: Atkinson Hyperlegible Mono (the face its 0.632 assumption describes) plus a mono fallback that has the missing math glyphs. DejaVu Sans Mono is the usual candidate (0.602 em, full arrow/Greek coverage, Bitstream Vera licence). Subsetting it to the glyphs the typesetter actually emits brings it to a few tens of KB. Its 0.602 advance on fallback glyphs is 0.3 px narrower than the reserved cell at 14 px, which is invisible and, unlike the current proportional fallback, cannot collide.
- with a TeX engine: the TeX engine's own font set (KaTeX ships about 400 KB of woff2, OFL). Those are proportional math faces and are incompatible with the 0.632 mono layout, so this is an either/or decision.

## Plot text

Plot SVGs are a different pipeline: `<text x=... y=... font-family="sans-serif" font-size="100">` at a canvas around 4000 px wide, scaled down to the card width by CSS. Ticks and labels are short plain strings (`1`, `-1.0`, `x`, `WWWWWW`). Each is a single anchored run, so there is no intra-label kerning problem - only the font choice and the width estimates.

Those estimates are already written against the fonts the SVG is meant to be drawn with: `plot_padding::tick_label_width` uses an Arial table (its test says "Arial's width, but Atkinson's ink"), while `exported_text_extent` and `keep_text_in_view` use Atkinson Hyperlegible Next advances and left side bearings, i.e. the face Woxi's own rasteriser substitutes for `sans-serif`. The app, however, resolves `sans-serif` to Roboto, so none of those tables matches what the device draws. Pinning plot text to the bundled Atkinson Next makes the device match the tables exactly. That is one CSS rule (`.woxi-graphic svg text`). Maths inside labels (a `Plot` label built from boxes) still goes through Woxi's inline text renderer and is out of scope here. Such text can be treated as plain text for now.

## Lower-level output of Woxi

The box tree is reachable from outside the crate: `evaluator::dispatch::complex_and_special::expr_to_box_form` is `pub`, as are `functions::graphics::layout_box` and `layout_to_svg`. That means an engine can take the boxes of a result, rewrite them and lay them out itself, without changing the Woxi dependency. The box tree is already StandardForm (`RowBox[{"Sin", "[", "x", "]"}]`, `RowBox[{"x", "==", "1"}]`), and the layout understands spacing primitives a box rewrite could use: a `U+2009` inside a string becomes a `0.32` cell gap, and `operator_space` gives its named tokens their margins.

We deliberately did not re-lay out from boxes yet: `generate_output_svg` is private and also performs display-only preprocessing - machine reals rounded to six significant figures (`1/3.0` -> `0.333333`), arbitrary-precision reals truncated to their precision, precision markers and scientific notation turned into boxes, form wrappers unwrapped, a token budget applied. Re-implementing that would change visible digits, so the SVG spacing pass stays on the output Woxi already prepared.

If the output is to go beyond mono spacing, the natural next step is a box -> MathML converter in the engine. MathML is the semantic IR that keeps StandardForm tokens (`<mi>Sin</mi><mo>[</mo>`, `<mo>==</mo>`, `<mo>→</mo>`) while an operator dictionary supplies TeX-like spacing, fractions, scripts, radicals and matrices are structural, and the WebView renders MathML Core natively (a bundled math font removes the platform font dependency). KaTeX's internal IR is not a public/stable format, and a TeX string would have to dress StandardForm tokens up as `\mathord`/`\mathrel`, which is more fragile than emitting MathML. A Rust TeX engine (Typst, ratex) is a much larger integration for the same result, and it would still need the box -> TeX/MathML step.

## What modern web front ends do

- Jupyter, Colab and VSCode notebooks carry the result as `text/latex` (and `text/plain`, `text/html`) in the output's MIME bundle. The front end typesets the LaTeX. JupyterLab uses MathJax 3, the Markdown previews in VSCode and most static-site generators use KaTeX. The engine never renders the math itself.
- KaTeX resolves every box to HTML/CSS up front (fast, no reflow, needs the TeX and the fonts). MathJax is slower and larger but covers more LaTeX and can emit SVG paths, which removes font dependence at the cost of size.
- Wolfram Cloud does what Woxi does: boxes are typeset on the server, not in the client.

The transferable lesson is the MIME bundle (a portable `text/latex` next to `text/plain`), not a particular library.

## Options

| Option | Quality | Effort | Size | Risk |
|---|---|---|---|---|
| A. Keep Woxi's SVG, bundle fonts, fix the CSS height | Mono/typewriter, but correct spacing, readable fractions, same look on every device | Small: three font files, two CSS rules, one `svgTag` change | ~220 KB (Atkinson Mono regular+bold, Next variable, small fallback subset) | Font licensing, synthetic italics, missing glyphs beyond the fallback |
| B. A + TeX path with KaTeX | Proportional math, TeX spacing, π/sin, scalable, consistent. TraditionalForm look | Medium: `tex` in the engine item, KaTeX bundle, fallback chain, a display-form decision | ~0.8 MB (JS + CSS + fonts) | TeX coverage of `expr_to_tex` (some heads loose, form wrappers not unwrapped), TraditionalForm reordering changes what a result looks like, output persistence |
| C. MathJax instead of KaTeX | Same as B, more coverage, SVG output is font-independent | Medium-large | 1.5 MB+ | Startup cost, weight on a phone |
| D. Patch the box layout to measure the real font (fontdb metrics inside the engine) | Removes the 0.632 assumption, but the look stays mono | Medium | none | Touching upstream code we do not own |
| E. Box -> MathML rendered natively | TeX-like spacing, StandardForm tokens, semantic/copyable, no JS engine | Medium: the converter, a math font, and the display-only preprocessing above | ~0.7-1.5 MB for the font | MathML Core completeness in the WebView, glyph coverage of the bundled font |

Nothing in B/C is a substitute for A: a TeX renderer would be judged against a baseline that currently draws a fraction at half size.

## Plan

### Phase A: make the current renderer right (done)

- Bundled `AtkinsonHyperlegibleMono-Regular.ttf`, `-Bold.ttf` and `AtkinsonHyperlegibleNext-VariableFont_wght.ttf` from the Woxi crate under `app/src/main/assets/www/fonts/` with their OFL text, plus `WoxiMonoFallback.ttf` (a subset of DejaVu Sans Mono covering arrows, operators, Greek and the other glyphs the layout can emit) and the Bitstream Vera notice. Provenance and the regeneration script are in `fonts/README.md`.
- Pinned the SVG text to those faces: `.woxi-out-math .woxi-svg text` to the mono stack, `.woxi-graphic svg text` to Atkinson Next. The second rule is what makes `plot_padding`'s Next-based measurements true on the device.
- Replaced the fixed height with the layout's own scale: `svgTag` rewrites the SVG `width`/`height` to em (dividing by the layout font size it finds in the SVG), so a one-line result draws at 1 em of the body text and a fraction is taller. Wide results are not shrunk: `.woxi-out-math` scrolls horizontally and the SVG keeps its size.
- Kept the synthesised oblique for `font-style="italic"` (Atkinson Mono has no italic file). It matches the slant the layout expects because the advance is unchanged. A real italic face would need a metric-compatible family, which no bundled face is.
- Checked on the emulator (dark and light) with `x -> 1`, `1/2 + x^2`, `√(x²+y²) + Sin[x]²`, `π²/6`, a 30-digit integer, `N[Pi, 30]`, `x :> 1`, a list, `Expand[(x+y)^10]` and the labelled plot: no overlapping glyphs, one text size across simple and compound results, fractions legible, plot labels in the intended face, wide output scrollable.
- Normalized the horizontal spacing (`engine/src/typeset.rs`): products get the layout's own thin space, relations the margins of its operator table, fractions with respaced rows are re-centred and re-barred. The pass has unit tests for rules, equality, products, fractions, nested terms, lists and TraditionalForm, and runs on every typeset output before it reaches the client.

### Phase B: optional TeX path (or MathML)

- Engine: add `tex` to text output items, computed from `get_last_output()` with `expr_to_tex`, under the same token budget `generate_output_svg` uses. Keep `svg` and `text`.
- Client: bundle KaTeX, render `tex` with `throwOnError: false`, fall back to the SVG when KaTeX rejects it and to the text when there is no SVG. Because `expr_to_tex` is TraditionalForm-flavoured, this display looks like `TraditionalForm`, not like the StandardForm the SVG shows - either make the default explicit (a notebook option "Output: StandardForm / TraditionalForm") or keep StandardForm as the default and offer TeX as an option.
- Decide with a side-by-side of the same survey: glyph quality, size, APK delta, first-paint cost, and how `\text{...}` fallbacks read. If KaTeX wins, persist `text/latex` next to `text/plain` in the saved outputs (the notebook format supports the MIME bundle) instead of persisting rendered HTML, and re-render on load.
- A form selector (StandardForm/TraditionalForm) is the same engine change. Do it once, not per renderer.

### Phase C: long term

One pipeline: TeX or boxes to a single renderer, math in plot labels from the same renderer, `TraditionalForm` as a display option rather than an input wrapper, and no dependence on device fonts. Upstream asks to Woxi if the plan reaches that point: an option on `generate_output_svg` for the form, a public `box_ast_to_tex` (today private) so TraditionalForm boxes can be TeX'd, real glyph metrics (or `textLength`) in the box layout instead of the 0.632 constant, and spacing around relations in the box formatter (`x -> 1` is emitted as three adjacent cells, so it reads `x→1`. StandardForm would print the ASCII arrow with spaces, TraditionalForm the Unicode arrow with operator spacing).

## Open questions

- StandardForm (mono boxes, `Sin[x]`) or TraditionalForm (TeX, `sin(x)`, π) as the default output look? The TeX path renders the second one.
- Is ~0.8 MB of APK for KaTeX acceptable on top of the engine libraries?
- Should `TraditionalForm` become a display-only setting (engine option) or stay an input wrapper as it is today?
