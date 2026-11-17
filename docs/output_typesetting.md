# Output Typesetting

## Scope

This page is about how an evaluated result is drawn. It does not touch input, the keyboard, or plot interaction. Everything below was checked against the current sources and against the engine crate (`woxi` 0.4.0) with probe binaries, and the screenshots were taken on the emulator (Android 16, API 36, x86_64, 393*827 CSS, dpr 2.75).

The relevant sources are `engine/src/eval.rs` (which asks Woxi for an SVG), `engine/src/typeset.rs` (the spacing pass), `engine/src/output.rs` (the output item shape), `app/src/main/assets/www/js/render-output.js` (item -> HTML) and `app/src/main/assets/www/css/app.css` (`.woxi-out-math`, `.woxi-out-text`, `.woxi-out-graphic`).

## What happens today

Woxi typesets every result itself. `generate_output_svg()` converts the result expression to box form (`expr_to_box_form`, or `expr_to_box_form_traditional` for `TraditionalForm[...]`), lays the boxes out at 14 px (`layout_box`), serializes the layout to an SVG (`layout_to_svg`) and hands it to the typesetting pass. That SVG is what `InterpretResult::output_svg` carries, and the app shows it in `.woxi-out-math`. When there is no SVG the app falls back to the plain result text in `.woxi-out-text`. A bare symbol or literal (`x`, `Pi`, `True`, `"s"`) is such a result, because Woxi prints the echo of a value as text and never typesets it. A text item whose document carries its own root font size is not a layout either: that is how Woxi draws a `QuestionObject` panel, and the client shows it as a picture.

Graphics are separate SVGs (`InterpretResult::graphics`), and some formatting heads come through that pipeline rather than the box layout: `Grid`, `TableForm`, `MatrixForm`, `Framed`, `Row` and `Column`. Their text is placed by the graphics renderer (cells measured in character advances), and a `Framed` box embeds the typeset SVG of its content as a nested `<svg>`. They are pictures, so they keep their own size instead of being em-sized like a result.

The SVG is plain `<text>` markup. Three text elements and their positions are all a result like `x -> 1` is:

```
<svg xmlns="http://www.w3.org/2000/svg" width="27" height="15">
<g fill="black" stroke="black" color="black">
<g transform="translate(0.0,0.0)"><text x="0" y="11.2" font-family="monospace" font-size="14.0" stroke="none" font-style="italic">x</text></g>
<g transform="translate(8.8,0.0)"><text x="0" y="11.2" font-family="monospace" font-size="14.0" stroke="none">→</text></g>
<g transform="translate(17.7,0.0)"><text x="0" y="11.2" font-family="monospace" font-size="14.0" stroke="none">1</text></g>
</g></svg>
```

The layout advances by `font_size * 0.632` per character (`MONO_ADVANCE` in `functions::graphics`), i.e. 8.85 px per cell. It never measures the font it names: the text elements simply say `font-family="monospace"`. That is what the layout emits. The engine's typesetting pass then rewrites the gaps between the runs (the arrow above gets `0.60` cell on each side) and records the layout size on the root element.

## What Phase A fixed

### The metric the layout assumes is not the metric the device rendered

0.632 em is exactly the advance of Atkinson Hyperlegible Mono (units per em 1000, every glyph 632, verified with `fontTools`). The font arrives inside the Woxi crate and is now bundled by the app, so the cell the layout reserves and the advance the device draws are the same number.

Before that, Android resolved `monospace` to DroidSansMono (0.600 em) and had no U+2192 `→` at all, so the arrow came from a proportional fallback font about 0.9 em wide, and the `1` at x = 17.7 px landed on its head. The same drift applied to every run: digit groups, italic words, superscripts.

`→` is not an exotic case: it is the operator a rule result is made of. Atkinson Mono covers `π ∑ ∫ ∞ ± × ÷ ≤ ≥ ≠ ≈ √` but not `→ ← ↔ θ λ ∈ ⊂ ⊆ ∪ ∩ ∅ ∀ ∃ ⊕ ⊗`, which is what the DejaVu subset is for.

### The CSS forced every result to one height

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

A simple result was drawn 35 % larger than the input text while a fraction was drawn at half size, so the same expression class changed size by a factor of 2.6 depending on how many rows it had. On the device the `π²/6` result was unreadable next to its own input.

### The spacing of an unknown operator

The layout's `operator_space` table gives `= < > ≤ ≥ + - ∧ ∨ ...` a margin on each side. It does not know the ASCII spellings the StandardForm box formatter emits for the same relations (`==`, `!=`, `<=`, `>=`, `===`, `=!=`, `<>`, `&&`, `||`, `|`, `+=`, `:=`, ...), and it does not know the private-use codepoints the box formatter uses for rules (`U+F522` -> `→`, `U+F51F` -> `⧴`) even though it lists the public `U+2192`/`U+29F4` glyphs. A result like `x -> 1` was therefore drawn as three adjacent cells: `x→1`.

The spacing pass gives such a token the margin of the tier its glyph has in that table: `0.60` cell for rules, `0.44` for equalities and the ASCII assignments, `0.34` for `&&`/`||`, and `0.2` for `|` (`Alternatives` is the table's `VerticalSeparator`, not its `Conditioned` `∣`). The token list is explicit, not a character class, so an operator the table does not name (`f'[x]`, `a[[1]]`) keeps the gap the layout chose. It acts only when the token ends exactly where the next operand begins, which is how it leaves the operators the layout already spaced - including `TraditionalForm`'s - alone.

### The client guessed the layout scale

`render-output.js` re-expressed the SVG size in em by dividing by the largest `font-size` it could find in the drawing. That is the layout's 14 px only as long as no run is styled larger: `Style[x, 24]` was scaled by 15/24 instead of 15/14, drawing a 24 px glyph at 15 px, and `Style[x, 24] + y` shrank the `y` to 8.75 px. The pass now records the size the layout was asked for on the root element (`data-woxi-font-size`), and the client divides by that.

### The result draws at the layout size

Recording the base was not enough: the em was resolved against the body text of 15 px, so a typeset result drew 7 % larger than its layout while a plain-text result stayed at 14 px. `.woxi-out-math` now sets `font-size: 14px`, so 1 em is one layout pixel. `x -> 1` occupies the layout's 38*15 px with 14 px glyphs, a `Style[x, 24]` run stays 24 px, and the `.woxi-out-text` fallback and a `Print` line use the same size.

### A picture keeps its size, only a plot fills the card

Every graphics SVG used to be stretched to the card (`width: 100%`), which turned `Grid[{{a, b}, {c, d}}]` from 32*32 into 347 px wide with 150 px letters and a `Framed[x]` into a 347*457 box. A picture now keeps the size its renderer gave it and shrinks only when it is wider than the card. Only a plot (`.woxi-plot`) fills the width and takes the card's rounded corners. A `QuestionObject` panel is a picture too, so a long question shrinks to the card instead of scrolling sideways with the Submit button off-screen.

### The face follows the drawing

Plot labels are measured with Atkinson Next, so they are drawn with it. But `.woxi-out-graphic svg text` also matched two kinds of text that are not plot labels: the typeset SVG nested in a `Framed` box and the rows of a panel, both laid out in 0.632 em cells. They were drawn proportionally over mono positions, overflowing their own box (a 21-digit framed number measured 163.9 wide in a 186 box). A document that names `monospace` - on its root or on each run - now gets the mono stack. Everything else in a graphic keeps Next.

### The last glyphs without a face

`〚` and `〛` (U+301A/U+301B, the Part brackets) were in neither bundled face, so the system fallback drew each one em wide inside a 0.602 em cell and `a[[1]]` put the `1` under the opening bracket. The subset already carried the mathematical double brackets `⟦` `⟧` at the same advance. Those two codepoints now map onto them.

### A Manipulate view reads like a result

A `Manipulate` whose body is not a graphic used to show a bare `<span>` in the UI font. It now uses `.woxi-out-text`, the same face and size as a result, and the live update builds the same markup as the first render (`manipulateView`), so a slider change cannot change the typography. A body that is a graphic still fills its view.

## What Woxi can display

- `StandardForm` is the default. `output_svg` comes from `expr_to_box_form`, except where `generate_output_svg` declines to typeset at all: Graphics/Image results (they have their own SVG), `FullForm`/`InputForm`/`CForm`/`TeXForm`/`FortranForm` (printed as text), `RawBoxes`/`DisplayForm` (their contents are already boxes) and `QuestionObject` (a drawn panel, not a box layout).
- `TraditionalForm[expr]` typesets through the dedicated traditional box path. A probe of `TraditionalForm[Sum[1/n^2, {n, 1, Infinity}]]` renders a stacked `π²/6` (π as a glyph), and `TraditionalForm[Sin[x]^2]` renders `sin²(x)`. The interpreter then keeps the box form itself as the last output (`FormBox[RowBox[...], TraditionalForm]`), and the printed result text remains `TraditionalForm[...]`. So it works for display, but it is a wrapper in the input rather than a display setting, and `%` sees a box expression.
- `InputForm[expr]` prints its content as text and skips the SVG.
- `TeXForm`, `FullForm`, `CForm` and `FortranForm` also skip the SVG, but in this printing path the result text is the wrapper itself (`TeXForm[1/2 + x]`), while the converted value only becomes the interpreter's last output. They are not a display path today.
- `expr_to_tex(&Expr)` is public (`woxi::functions::string_ast::expr_to_tex`) and produces TraditionalForm-flavored TeX: `x\to 1`, `\frac{13}{21}`, `\sqrt{x^2+y^2}`, `\cos ^2(y)`, `\left(\begin{array}{cc}...\end{array}\right)`, `\begin{cases}...\end{cases}`, `\binom{n}{k}`. It reorders terms the way TraditionalForm does (`x^2 + 3x + 2` becomes `3 x+x^2+2`), a few heads come out as `\text{SeriesData}`, and a form wrapper is not unwrapped.
- There is no front-end output-form setting: no `$OutputForm`, `FormatType` or equivalent. `output_svg` has no option for the form.

## Plot text

Plot SVGs are a different pipeline: `<text x=... y=... font-family="sans-serif" font-size="100">` at a canvas around 4000 px wide, scaled down to the card width by CSS. Ticks and labels are short plain strings (`1`, `-1.0`, `x`, `WWWWWW`). Each is a single anchored run, so there is no intra-label kerning problem - only the font choice and the width estimates.

Those estimates are written against the faces the SVG is meant to be drawn with: `plot_padding::tick_label_width` uses an Arial table (its test says "Arial's width, but Atkinson's ink"), while `exported_text_extent` and `keep_text_in_view` use Atkinson Hyperlegible Next advances and left side bearings, i.e. the face Woxi's own rasterizer substitutes. The app resolves `sans-serif` to Roboto, so none of those tables matched what the device drew. Pinning plot text to the bundled Atkinson Next makes the device match them exactly. That is the first CSS rule (`.woxi-out-graphic svg text`). A document that names `monospace` keeps the mono stack, because its cells were measured that way.

The same rule cannot be made right for grid text: `Grid`/`TableForm` cells are measured with the 0.632 em advance but the renderer names `sans-serif`, so a wide string (`"MMMMMMMMMM"`) is drawn wider than the column it was measured for. That is an upstream fix (name `monospace` for a cell laid out on the cell grid, or measure with the face it names). Maths inside labels (a `Plot` label built from boxes) still goes through Woxi's inline text renderer and is out of scope here.

## Why the pass works on the SVG

The spacing decision belongs in the box formatter, which is where the space between two boxes is chosen. The pass works one layer below that, on the drawing, and pays for it by re-deriving the layout's model of a row. Two things make that the cheaper path today:
- The display form of a number is private. `generate_output_svg` does the step between "boxes" and "what a notebook shows": `strip_number_precision_markers` drops the backtick precision marker, rounds a machine real to six significant figures, truncates an arbitrary-precision real to its precision, turns `mantissa*^exp` into `×10^exp` and groups long integers in threes. That is 241 lines across `strip_number_precision_markers`, `precision_number_display`, `round_significant`, `drop_trailing_frac_zeros`, `scientific_string_to_box` and `group_digits_str`, all `pub(crate)`. Laying the box tree out ourselves would mean reproducing them, and a second formatter to keep in step with the one that decides the digits. (The notebook export's `text/plain` already differs from the picture there: `1/3.0` is drawn `0.333333` and the item stores `0.3333333333333333`, because the app keeps the interpreter's result text.)
- The box language can express only one spacing unit. A box string holding `U+2009` becomes a 0.32 cell gap, and a string holding a space becomes a whole cell. The layout's own relation margins (0.2-0.60 cell) are not expressible in box form. A box rewrite could therefore space a relation only at 0.32 cell, thinner than the `+` the layout already spaces, so the pass would trade a correct look for a correct layer.

The SVG route keeps Woxi's numbers, Woxi's layout and Woxi's palette, and changes only the gaps (plus the one attribute that records the layout size). Its cost is this module's parser.

### What the pass may touch

The document is parsed into elements, and re-emitted with a shift threaded through each row. What changes are six numbers:
- the `translate()` of a group,
- the `x2` of a fraction's bar,
- the position of the two rows that bar centers,
- the end of a radical's vinculum,
- the `width` of the document,
- the layout's font size, recorded once on the root element.

Every distance it applies is derived from the document itself: a product's gap is a fraction of the cell the layout left (`0.32`), a relation's margin is that same cell times the tier of its glyph (`0.60`/`0.44`/`0.34`/`0.2`), a fraction's row widths come from the layout's own centering (`width = bar - 2x`), and a radical's overbar follows its content by the same delta. The one measurement it does need is the advance of a token (`font size * 0.632`). That is the cell the layout reserved, not a property of the drawing or of the bundled face (which happens to advance the same). It is used only to tell a token the layout spaced from one it did not. Re-running the pass over its own output changes nothing.

A radical is therefore re-spaced as a whole: its content is laid out first and the path's last point (the end of the vinculum) moves by the content's width change, so `Hold[Sqrt[2 x] + y z]` has one product style. A box the layout composed around content it cannot re-measure - a stretched delimiter, a frame - is still re-emitted exactly as it was. An output the parser does not recognise is returned untouched rather than half-rewritten. The root `font-size` guard is what keeps a `QuestionObject` panel, whose rows are drawn by another renderer, out of the pass, and the client uses the same attribute (`isDrawing`) to show such a document as a picture.

Two kinds of typeset text do not go through this pass at all: a typeset SVG nested in a graphic (`Framed`), whose host drew the frame around the old width, and a `Grid`/`TableForm` cell, which the graphics renderer draws from a string. `Framed[x -> 1]` still prints `x→1` inside its frame, and `Framed[a b]` keeps the wide product. Fixing that belongs in the box tree, which is where the frame's width is decided. Patching the nested `<svg>` here would leave the frame's rect and the sibling layout behind.

## What modern web front ends do

- Jupyter, Colab and VSCode notebooks carry the result as `text/latex` (and `text/plain`, `text/html`) in the output's MIME bundle. The front end typesets the LaTeX. JupyterLab uses MathJax 3, the Markdown previews in VSCode and most static-site generators use KaTeX. The engine never renders the math itself.
- KaTeX resolves every box to HTML/CSS up front (fast, no reflow, needs the TeX and the fonts). MathJax is slower and larger but covers more LaTeX and can emit SVG paths, which removes font dependence at the cost of size.
- Wolfram Cloud does what Woxi does: boxes are typeset on the server, not in the client.

The transferable lesson is the MIME bundle (a portable `text/latex` next to `text/plain`), not a particular library.

## Options

| Option | Quality | Effort | Size | Risk |
|---|---|---|---|---|
| A. Keep Woxi's SVG, bundle fonts, fix the CSS height, normalize the spacing | Mono/typewriter, but correct spacing, readable fractions, same look on every device | Small: four font files, a few CSS rules, em sizing, one engine pass | ~270 KB (Atkinson Mono regular+bold, Next variable, fallback subset) | Font licensing, synthetic italics, missing glyphs beyond the fallback, a parser to maintain |
| B. A + TeX path with KaTeX | Proportional math, TeX spacing, π/sin, scalable, consistent. TraditionalForm look | Medium: `tex` in the engine item, KaTeX bundle, fallback chain, a display-form decision | ~0.8 MB (JS + CSS + fonts) | TeX coverage of `expr_to_tex`, TraditionalForm reordering changes what a result looks like, output persistence |
| C. MathJax instead of KaTeX | Same as B, more coverage, SVG output is font-independent | Medium-large | 1.5 MB+ | Startup cost, weight on a phone |
| D. Own the box layout (a KaTeX-shaped row model over `expr_to_box_form`) | Exact structure: radicals, nested fractions, grids. Spacing decided in box space | Large: the display formatter above plus a layout for every box type, or an upstream hook | none | Two sources of truth for the digits until the formatter is upstreamed |
| E. Box -> MathML rendered natively | TeX-like spacing, StandardForm tokens, semantic/copyable, no JS engine | Medium: the converter, a math font, and the display formatter above | ~0.7-1.5 MB for the font | MathML Core completeness in the WebView, glyph coverage of the bundled font |

Nothing in B/C is a substitute for A: a TeX renderer would be judged against a baseline that currently draws a fraction at half size.

## Plan

### Phase A: make the current renderer right (done)

- Bundled the four faces under `app/src/main/assets/www/fonts/` with their licences. Provenance and the regeneration script are in `fonts/README.md`. The fallback also carries a composed `⧴` (the delayed rule), which neither source face has, and maps the Part brackets `〚` `〛` onto its `⟦` `⟧`. Without those, the system fallback drew each glyph wider than the one cell the layout reserves and the operand after it nearly touched it.
- Pinned the SVG text to those faces: `.woxi-out-math .woxi-svg text` to the mono stack and `.woxi-out-graphic svg text` to Atkinson Next. The second rule is what makes `plot_padding`'s Next-based measurements true on the device. A document in a graphic that names `monospace` keeps the mono stack, so the math inside a `Framed` box and the rows of a panel stay on their cells.
- Replaced the fixed height with the layout's own scale: the pass records the font size the layout was asked for on the root element, and `typesetSvg` rewrites the SVG `width`/`height` to em against it. `.woxi-out-math` sets that size (14 px), so a one-line result draws at its layout size, a fraction is taller, and a `Style[..., 24]` run stays larger. Wide results scroll instead of shrinking. A document the pass refused has no recorded size and keeps its pixels. There is no guessed fallback.
- Kept the synthesized oblique for `font-style="italic"` (Atkinson Mono has no italic file). The advance is unchanged, so the layout holds.
- Two entry points instead of a flag: `typesetSvg` (em, mono face) and `graphicSvg` (pixels, plot face), so a call site cannot pair the wrong size unit with the wrong container. A document that drew itself (a root font size, which is how a `QuestionObject` panel arrives) is shown as a picture instead.
- A picture keeps its own size and shrinks only when it is wider than the card. Only a plot fills. `fitGraphics` trims the graphic's own root SVG only, so a nested typeset SVG keeps the scale its host gave it, and a frame's outline is no longer stretched past the box's edge.
- A `Manipulate` view reports its value as text when the body is not a graphic, in the same face and size as a result (`manipulateView` is shared by the first render and the live update), instead of putting a typeset SVG in a box that holds pictures.
- Normalized the horizontal spacing (`engine/src/typeset.rs`): products get the layout's thin space, unspaced operator tokens the margin of the tier their glyph has in `operator_space` (`|` at the `VerticalSeparator` tier, 0.2), fractions a re-centered bar (nested ones included), and a radical's content is re-spaced with its vinculum shortened to the new width. Pictures and `TraditionalForm`'s spaced tokens are left alone. The group transform stays in the attribute list (one copy, re-emitted in place), so a document that does not move is byte-identical. 30 unit tests, including idempotence, a re-emission check, a thin-space check against the layout and a corpus pinning that every supported output parses.
- Checked on the emulator (dark and light) with `x -> 1`, `x :> 1`, `1/2 + x^2`, `(3 x)/2`, `√(x²+y²) + Sin[x]²`, `π²/6`, a 30-digit integer, `N[Pi, 30]`, a list, `Expand[(x+y)^10]`, a radical with a product inside and outside it, a fraction with a radical, `Hold[a | b]`, a matrix (`MatrixForm` and a nested list), a `Grid`, a `Framed` number, a held `Part`, a short and a long `QuestionObject` panel, a labeled plot and a `Manipulate`.

### Phase B: optional TeX path

- Engine: add `tex` to text output items, computed from `get_last_output()` with `expr_to_tex`, under the same token budget `generate_output_svg` uses. Keep `svg` and `text`.
- Client: bundle KaTeX, render `tex` with `throwOnError: false`, fall back to the SVG when KaTeX rejects it and to the text when there is no SVG. Because `expr_to_tex` is TraditionalForm-flavored, this display looks like `TraditionalForm`, not like the StandardForm the SVG shows - either make the default explicit (a notebook option "Output: StandardForm / TraditionalForm") or keep StandardForm as the default and offer TeX as an option.
- Decide with a side-by-side of the same survey: glyph quality, size, APK delta, first-paint cost, and how `\text{...}` fallbacks read. If KaTeX wins, persist `text/latex` next to `text/plain` in the saved outputs (the notebook format supports the MIME bundle) instead of persisting rendered HTML, and re-render on load.
- A form selector (StandardForm/TraditionalForm) is the same engine change. Do it once, not per renderer.

### Phase C: long term

One pipeline: TeX or boxes to a single renderer, math in plot labels from the same renderer, `TraditionalForm` as a display option rather than an input wrapper, and no dependence on device fonts.

Upstream asks to Woxi, in the order they would pay off:
- `pub fn display_boxes(expr: &Expr) -> Expr` (and the traditional variant): `expr_to_box_form` plus the display-only number formatting. With that public, this module becomes a box rewrite of about forty lines and the SVG parser goes away. Radicals, nested fractions, grids and style boxes come out right by construction. That is option D, and it is the shape to move to.
- The ASCII operator tokens (`== != <= >= === =!= <> && || | += -= *= /= ^= :=`) and the private-use rule arrows (`U+F522`, `U+F51F`) in `operator_space`, at the tier each glyph already has there (`|` is `VerticalSeparator`, 0.2), so relations get their margin from the table that already owns that decision. That alone deletes the relation half of `engine/src/typeset.rs`.
- A thin space between the factors of a product, instead of the whole cell (`str_expr(" ")` in the `Times`/`HoldForm` path), which deletes the product half.
- Real glyph metrics (or `textLength`) in the box layout instead of the 0.632 constant, so a face that is not the bundled mono still lays out.

## Open questions

- StandardForm (mono boxes, `Sin[x]`) or TraditionalForm (TeX, `sin(x)`, π) as the default output look? The TeX path renders the second one.
- Should `TraditionalForm` become a display-only setting (engine option) or stay an input wrapper as it is today?
