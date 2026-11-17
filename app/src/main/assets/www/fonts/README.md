# Fonts

Every SVG the engine typesets is laid out with fixed glyph advances. The device only draws it. Bundling the faces those advances belong to is what makes the rendering independent of the system fonts:
- `AtkinsonHyperlegibleMono-Regular.ttf`, `AtkinsonHyperlegibleMono-Bold.ttf`: the face of the box layout in Woxi (`MONO_ADVANCE = 0.632`, every glyph 632/1000). Taken unmodified from the `woxi` crate, `resources/`.
- `AtkinsonHyperlegibleNext-VariableFont_wght.ttf`: the face `plot_padding` measures plot labels with (`exported_text_extent`, `keep_text_in_view`, the left side bearings). Taken unmodified from the `woxi` crate, `resources/`.
- `WoxiMonoFallback.ttf`: a subset of DejaVu Sans Mono covering ASCII, Latin-1, Greek, general punctuation, letterlike symbols, arrows, mathematical operators, technical brackets and angle brackets. It fills the glyphs Atkinson Mono does not have (`→`, `θ`, `∈`, ...). Its 0.602 em advance is 0.3 px narrower than the cell the layout reserves at 14 px, so it cannot collide with the next run. Made with `pyftsubset` (fontTools) from the Matplotlib copy of DejaVu Sans Mono, renamed to `Woxi Mono Fallback` as the Bitstream Vera license requires for modified faces.

The delayed rule `⧴` (U+29F4) is in neither source face. The system fallback that supplied it advanced wider than the cell the layout reserves, so `x :> 1` ran the `1` into the arrowhead. The subset now carries the glyph: the face's own colon and rightwards arrow, the arrow compressed horizontally and both placed to fit the 0.602 em advance. The last steps of the regeneration below add it.

The Part brackets `〚` `〛` (U+301A/U+301B) are in neither source face either, and the system fallback drew each one em wide inside an 0.602 em cell, so `a[[1]]` put the `1` under the opening bracket. The subset already has the mathematical double brackets `⟦` `⟧` (U+27E6/U+27E7) at the same advance as every other glyph. Those two codepoints are mapped onto them.

To regenerate the subset, from a checkout with Python and fontTools:

```python
from fontTools.ttLib import TTFont
from fontTools.subset import Subsetter, Options

font = TTFont("DejaVuSansMono.ttf")
options = Options()
options.name_IDs = ["*"]
options.name_languages = ["*"]
options.layout_features = []
subsetter = Subsetter(options=options)
subsetter.populate(
    unicodes=[
        *range(0x20, 0x7F),
        *range(0xA0, 0x100),
        *range(0x370, 0x400),
        *range(0x2000, 0x2070),
        *range(0x2100, 0x2150),
        *range(0x2190, 0x2200),
        *range(0x2200, 0x2300),
        *range(0x2300, 0x2400),
        *range(0x27C0, 0x27F0),
    ]
)
subsetter.subset(font)
# rename name IDs 1/3/4/6/16/18/21/22 to "Woxi Mono Fallback", then save.
```

The delayed-rule glyph is composed from the subset's own colon and arrow once the face has been renamed (fontTools pens):

```python
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

glyph_set = font.getGlyphSet()
pen = TTGlyphPen(glyph_set)
glyph_set["colon"].draw(TransformPen(pen, (1.0, 0.0, 0.0, 1.0, -430.0, 0.0)))
glyph_set["arrowright"].draw(TransformPen(pen, (0.8, 0.0, 0.0, 0.9, 290.0, 40.0)))
glyph = pen.glyph()
glyph.recalcBounds(font["glyf"])
font.setGlyphOrder(font.getGlyphOrder() + ["uni29F4"])
font["glyf"]["uni29F4"] = glyph
font["hmtx"]["uni29F4"] = (1233, glyph.xMin)
for table in font["cmap"].tables:
    if table.isUnicode():
        table.cmap[0x29F4] = "uni29F4"
        # The Part brackets, on the double brackets the subset already carries.
        table.cmap[0x301A] = "uni27E6"
        table.cmap[0x301B] = "uni27E7"
font.save("WoxiMonoFallback.ttf")
```

Licenses: `OFL-AtkinsonHyperlegible.txt` (SIL OFL 1.1) for the Atkinson faces, `LICENSE-DejaVu.txt` (Bitstream Vera / Arev) for the subset.
