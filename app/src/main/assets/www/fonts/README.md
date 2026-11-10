# Fonts

Every SVG the engine typesets is laid out with fixed glyph advances. The device only draws it. Bundling the faces those advances belong to is what makes the rendering independent of the system fonts:
- `AtkinsonHyperlegibleMono-Regular.ttf`, `AtkinsonHyperlegibleMono-Bold.ttf`: the face of the box layout in Woxi (`MONO_ADVANCE = 0.632`, every glyph 632/1000). Taken unmodified from the `woxi` crate, `resources/`.
- `AtkinsonHyperlegibleNext-VariableFont_wght.ttf`: the face `plot_padding` measures plot labels with (`exported_text_extent`, `keep_text_in_view`, the left side bearings). Taken unmodified from the `woxi` crate, `resources/`.
- `WoxiMonoFallback.ttf`: a subset of DejaVu Sans Mono covering ASCII, Latin-1, Greek, general punctuation, letterlike symbols, arrows, mathematical operators, technical brackets and angle brackets. It fills the glyphs Atkinson Mono does not have (`→`, `θ`, `∈`, ...). Its 0.602 em advance is 0.3 px narrower than the cell the layout reserves at 14 px, so it cannot collide with the next run. Made with `pyftsubset` (fontTools) from the Matplotlib copy of DejaVu Sans Mono, renamed to `Woxi Mono Fallback` as the Bitstream Vera licence requires for modified faces.

Licences: `OFL-AtkinsonHyperlegible.txt` (SIL OFL 1.1) for the Atkinson faces, `LICENSE-DejaVu.txt` (Bitstream Vera / Arev) for the subset.

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
subsetter.populate(unicodes=[
    *range(0x20, 0x7F), *range(0xA0, 0x100), *range(0x370, 0x400),
    *range(0x2000, 0x2070), *range(0x2100, 0x2150), *range(0x2190, 0x2200),
    *range(0x2200, 0x2300), *range(0x2300, 0x2400), *range(0x27C0, 0x27F0),
])
subsetter.subset(font)
# rename name IDs 1/3/4/6/16/18/21/22 to "Woxi Mono Fallback", then save.
```
