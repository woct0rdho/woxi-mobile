"""Generate the Woxi Mobile launcher icon: the traced W on wheels, on Woxi's black.

The artwork is the composition from tools/make-woxi-mobile.py - Woxi's traced mark
with two wheeled axles - so this script imports that one for the geometry and the
colours instead of keeping a second copy of them.

Layout, in Android's 108 x 108 unit adaptive icon canvas:

- a launcher crops the canvas to the central 72 x 72 units, then applies a mask
  shape inscribed in that box. Android asks for the logo to sit inside the inner
  66 x 66 units that remain visible under every mask, i.e. a circle of radius 33,
  so the car is placed with a circumradius of FOREGROUND_FIT = 33 units. It then
  spans about 50 of the 72 visible units and sits 11 units in from either side.
- the round variant is the exception the docs allow: a launcher only asks for
  android:roundIcon when it masks the icon to a circle, so that foreground can be
  a touch larger (ROUND_FIT = 35) while still clearing the circle.
- the background layer is a full 108 unit sheet of #050505, Woxi's banner black,
  so it bleeds under every mask.
- the wheels are painted after the body, in all three layers, so the W's tips -
  which reach the axle - do not cut spikes out of the rims.

Legacy bitmaps (API 24-25) are not cropped to that 72 unit window - the launcher
shows the whole square or circle - so they are drawn with their own, larger fit.

The layers Android is given, all generated here:

drawable/ic_launcher_background.xml        flat #050505, full bleed to 108 dp
drawable/ic_launcher_foreground.xml        the car, transparent, fitted to 33 units
drawable/ic_launcher_foreground_round.xml  the same at 35 units, for android:roundIcon
drawable/ic_launcher_monochrome.xml        one colour, for Android 13 themed icons
mipmap-anydpi-v26/ic_launcher{,_round}.xml the <adaptive-icon> files naming them
mipmap-{m,h,xh,xxh,xxxh}dpi/*.png          legacy bitmaps for API 24-25

As measured, the standard foreground's furthest point is 31.7 units from the canvas
center: 1.3 units inside the 66 unit safe circle and 4.3 inside the worst case mask, a
circle of radius 36, so the W's top corners and both wheels stay visible under any mask.
The car is then nudged OPTICAL_SHIFT = 2 units of the 108 down. Geometric centring
leaves equal 14 unit gaps, but the W is one broad mass with a long top edge while the
bottom is two small wheels, so it reads as sitting high. The nudge levels it, and because
the extremes move towards the horizontal axis it also brings the furthest point slightly
closer to the center rather than further. Padding ends up 11.1 units left and right,
16.3 above and 12.3 below.

The round variant is the exception the Android docs describe: a launcher only asks for
android:roundIcon when it masks icons to a circle, so that foreground may sit closer to
the edge. Themed icons are a single tinted layer, so the wheel holes would otherwise
show the W's tips through them. The monochrome layer therefore clips the W to the area
outside the wheels and draws the wheels on top, giving the same silhouette the colour
icon has.

Outputs: every file in the table above, plus design/ (a standalone icon.svg, icon-512.png
and a preview sheet with both adaptive masks, the round variant, the legacy pair, the
themed silhouette and 48 px renders).

Usage: python tools/make-icon.py
"""

import importlib.util
import math
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "app", "src", "main", "res")
DESIGN = os.path.join(ROOT, "design")
CAR_TOOL = os.path.join(ROOT, "tools", "make-woxi-mobile.py")

CANVAS = 108.0  # adaptive icon canvas, in dp
VISIBLE = 72.0  # the part a launcher keeps, before masking
MASK_RADIUS = 36.0  # worst-case mask: the circle inscribed in that box
SAFE_RADIUS = 33.0  # the 66 dp circle Android shows "within the masked viewport"
FOREGROUND_FIT = 33.0  # car circumradius: inside that safe circle, as documented
ROUND_FIT = 35.0  # round variant: see the roundIcon note below
LEGACY_FIT = 52.0  # square legacy bitmap: fills most of the 108 sheet
LEGACY_ROUND_FIT = 47.0  # round legacy bitmap: same, inside the circle
MASK_CORNER = 0.2  # mask corner rounding, as a fraction of the mask box
WHEEL_RADIUS = 17.0  # in mark units, matching make-woxi-mobile.py
OPTICAL_SHIFT = 2.0  # canvas units down, see the note in placer()
DENSITIES = [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]
SS = 4
STALE = [f"drawable-{d}/ic_launcher.png" for d in ("ldpi", "mdpi", "hdpi", "xhdpi", "xxhdpi")]


def load_car():
    """The composition module: geometry, colours and the body renderer."""
    spec = importlib.util.spec_from_file_location("woxi_car", CAR_TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


car = load_car()


def fit_scale(width, height, radius, fit):
    """Canvas scale that puts the car's furthest corner `fit` units from the center."""
    return fit / math.hypot(width / 2, (height + radius) / 2)


def placer(width, height, radius, scale):
    """Car coordinates -> canvas coordinates, centerd on the whole car box.

    The box is the mark plus the wheels hanging below it, so its center is
    (width / 2, (height + radius) / 2) - not the center of the mark, which would
    sit the whole car low by half a wheel.

    OPTICAL_SHIFT then nudges everything down a little. Geometric centring leaves
    equal gaps above and below, but the W is one broad mass with a long top edge
    while the bottom is just two small wheels, so at icon size it reads as sitting
    high. Two units out of 108 is enough to look level, and it hardly touches the
    fit: the extremes move towards the horizontal axis, so the furthest point gets
    slightly closer to the center, not further.
    """
    total = height + radius

    def place(x, y):
        return ((x - width / 2) * scale + CANVAS / 2, (y - total / 2) * scale + CANVAS / 2 + OPTICAL_SHIFT)

    return place


def circle_path(cx, cy, radius):
    return f"M{cx - radius:.3f},{cy:.3f} a{radius:.3f},{radius:.3f} 0 1,0 {2 * radius:.3f},0 a{radius:.3f},{radius:.3f} 0 1,0 -{2 * radius:.3f},0 Z"


def body_path(contours, place):
    """The traced W, in canvas coordinates."""
    parts = []
    for contour in contours:
        points = [place(x, y) for x, y in contour]
        parts.append("M" + " L".join("{:.3f},{:.3f}".format(*p) for p in points) + " Z")
    return " ".join(parts)


def wheel_parts(contours, width, height, radius, place, colours):
    """Every wheel circle as (center, radius in canvas units, colour)."""
    unit = unit_scale(place)
    out = []
    for axle in car.axles(contours, height):
        circles = [(radius, colours["tyre"]), (radius * car.WHEEL["rim"], colours["rim"])]
        circles += [(radius * car.WHEEL["hole"], colours["tyre"]) for _ in car.holes((axle, height), radius)]
        circles.append((radius * car.WHEEL["hub"], colours["tyre"]))
        for r, colour in circles:
            out.append((place(axle, height), r * unit, colour))
    return out


def unit_scale(place):
    """How many canvas units one car unit is worth, read back off the placer."""
    return place(1, 0)[0] - place(0, 0)[0]


def background_xml():
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!-- Woxi Mobile background: a flat sheet of Woxi's banner black ({car.BACKGROUND}), full bleed
     so it survives any launcher mask. Generated by tools/make-icon.py. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:fillColor="#FF{car.BACKGROUND}" android:pathData="M0,0h108v108h-108z" />
</vector>
"""


def foreground_xml(contours, width, height, radius, fit, what):
    scale = fit_scale(width, height, radius, fit)
    place = placer(width, height, radius, scale)
    unit_scale(place)
    tops = place(0, 0)[1], place(0, height)[1]
    stops = "\n".join(
        f'                <item android:offset="{offset:g}" android:color="#FF{colour}" />'
        for offset, colour in car.STOPS
    )
    wheels = []
    for (cx, cy), r, fill in wheel_parts(contours, width, height, radius, place, {"tyre": car.TYRE, "rim": car.RIM}):
        wheels.append(f'  <path android:fillColor="#{fill}" android:pathData="{circle_path(cx, cy, r)}" />')
    return """<?xml version="1.0" encoding="utf-8"?>
<!-- {what}
     The car's furthest point is {fit:g} units from the canvas center:
     {pad:.2f} units inside the 36 unit circle a launcher can mask to, and {safe:.2f}
     inside the 66 x 66 unit area Android guarantees to show. Wheels are painted
     after the body on purpose. Generated by tools/make-icon.py. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:pathData="{body}" android:fillType="evenOdd">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="54" android:startY="{top:.3f}"
                android:endX="54" android:endY="{bottom:.3f}">
{stops}
            </gradient>
        </aapt:attr>
    </path>
{wheels}
</vector>
""".format(
        what=what,
        fit=fit,
        pad=MASK_RADIUS - fit,
        safe=SAFE_RADIUS - fit,
        body=body_path(contours, place),
        top=tops[0],
        bottom=tops[1],
        stops=stops,
        wheels="\n".join(wheels),
    )


def monochrome_xml(contours, width, height, radius):
    """One-colour version for Android 13 themed icons.

    In colour the tyres are opaque and hide the W's tips. In a single tint those tips
    would show through the wheels' drilled holes, so the W is clipped to the area
    outside the wheels and the wheels are drawn on top, giving the same silhouette the
    coloured icon has. The clip uses plain winding (canvas rect one way, the two disc
    outlines the other) because <clip-path> has no fill-rule attribute. This layer is
    shared by both adaptive icons, so it keeps the safe fit rather than the round one.
    """
    scale = fit_scale(width, height, radius, FOREGROUND_FIT)
    place = placer(width, height, radius, scale)
    unit = unit_scale(place)
    discs = [circle_path(*place(axle, height), radius * unit) for axle in car.axles(contours, height)]
    parts = [
        '  <group>\n    <clip-path android:pathData="M0,0 H108 V108 H0 Z {}" />'.format(" ".join(discs)),
        (
            '    <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd"\n'
            f'        android:pathData="{body_path(contours, place)}" />\n  </group>'
        ),
    ]
    for axle in car.axles(contours, height):
        center = place(axle, height)
        outline = [circle_path(*center, radius * unit)]
        for hx, hy in car.holes((axle, height), radius):
            outline.append(circle_path(*place(hx, hy), radius * car.WHEEL["hole"] * unit))
        outline.append(circle_path(*center, radius * car.WHEEL["hub"] * unit))
        parts.append(
            '  <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd"\n      android:pathData="{}" />'.format(
                " ".join(outline)
            )
        )
    return """<?xml version="1.0" encoding="utf-8"?>
<!-- Woxi Mobile themed icon (Android 13+): the same artwork in one colour, tinted by
     the system. Tyre and rim merge into a disc. The drilled holes and the W's
     counters stay as holes, so the wheel still reads as a wheel.
     Generated by tools/make-icon.py. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
{parts}
</vector>
""".format(parts="\n".join(parts))


def adaptive_xml(foreground):
    return f"""<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/{foreground}" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
"""


def draw_car(img, contours, width, height, radius, fit):
    """Paint the car into `img`, centerd with circumradius `fit`, in canvas units.

    The body goes down first and the wheels over it, matching the SVG: the W's tips
    reach the axle, so a body painted last would cut spikes out of the rims.
    """
    size = img.size
    place = placer(width, height, radius, fit_scale(width, height, radius, fit))
    unit = size[0] / CANVAS

    def at(x, y):
        px, py = place(x, y)
        return px * unit, py * unit

    mask = np.zeros((size[1], size[0]), dtype=bool)
    for contour in contours:
        layer = Image.new("1", size, 0)
        ImageDraw.Draw(layer).polygon([at(x, y) for x, y in contour], fill=1)
        mask ^= np.asarray(layer, dtype=bool)

    top = at(0, 0)[1]
    bottom = at(0, height)[1]
    gradient = Image.new("RGB", size)
    painter = ImageDraw.Draw(gradient)
    for y in range(size[1]):
        painter.line([(0, y), (size[0], y)], fill=tuple(int(v) for v in car.gradient_at((y - top) / (bottom - top))))
    img.paste(gradient, (0, 0), Image.fromarray((mask * 255).astype(np.uint8)))

    draw = ImageDraw.Draw(img)
    for axle in car.axles(contours, height):
        circles = [(radius, car.rgb(car.TYRE)), (radius * car.WHEEL["rim"], car.rgb(car.RIM))]
        circles += [(radius * car.WHEEL["hole"], car.rgb(car.TYRE)) for _ in car.holes((axle, height), radius)]
        circles.append((radius * car.WHEEL["hub"], car.rgb(car.TYRE)))
        for r, colour in circles:
            box = [at(axle - r, height - r), at(axle + r, height + r)]
            draw.ellipse([box[0][0], box[0][1], box[1][0], box[1][1]], fill=colour)


def masked(img, shape, span):
    """Clip `img` to what a launcher shows: a box of `span` canvas units wide.

    72 units is the adaptive icon window (cropped, then masked). 108 is the whole
    bitmap, which is what a legacy icon gets.
    """
    size = img.width
    inset = (CANVAS - span) / 2 / CANVAS * size
    box = [inset, inset, size - 1 - inset, size - 1 - inset]
    mask = Image.new("L", (size, size), 0)
    painter = ImageDraw.Draw(mask)
    if shape == "circle":
        painter.ellipse(box, fill=255)
    else:
        painter.rounded_rectangle(box, radius=round((box[2] - box[0]) * MASK_CORNER), fill=255)
    out = img.copy()
    out.putalpha(Image.composite(img.getchannel("A"), Image.new("L", (size, size), 0), mask))
    return out


def icon(px, shape, span, fit, background=None):
    """One icon bitmap: full-bleed background plus the car, clipped to `span` units."""
    size = px * SS
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if background is not None:
        img.paste(Image.new("RGBA", (size, size), car.rgb(background) + (255,)), (0, 0))
    contours, width, height, _ = car.load_mark()
    draw_car(img, contours, width, height, WHEEL_RADIUS, fit)
    return masked(img, shape, span).resize((px, px), Image.LANCZOS)


def monochrome_icon(px, fit, tint, background):
    """The themed silhouette: W clipped outside the wheels, wheels with holes."""
    contours, width, height, _ = car.load_mark()
    size = px * SS
    place = placer(width, height, WHEEL_RADIUS, fit_scale(width, height, WHEEL_RADIUS, fit))
    unit = size / CANVAS

    def at(x, y):
        px_, py_ = place(x, y)
        return px_ * unit, py_ * unit

    def disc(cx, cy, r):
        layer = Image.new("1", (size, size), 0)
        box = [at(cx - r, cy - r), at(cx + r, cy + r)]
        ImageDraw.Draw(layer).ellipse([box[0][0], box[0][1], box[1][0], box[1][1]], fill=1)
        return np.asarray(layer, dtype=bool)

    body = np.zeros((size, size), dtype=bool)
    for contour in contours:
        layer = Image.new("1", (size, size), 0)
        ImageDraw.Draw(layer).polygon([at(x, y) for x, y in contour], fill=1)
        body ^= np.asarray(layer, dtype=bool)

    wheels = np.zeros((size, size), dtype=bool)
    holes = np.zeros((size, size), dtype=bool)
    for axle in car.axles(contours, height):
        wheels |= disc(axle, height, WHEEL_RADIUS)
        for hx, hy in car.holes((axle, height), WHEEL_RADIUS):
            holes |= disc(hx, hy, WHEEL_RADIUS * car.WHEEL["hole"])
        holes |= disc(axle, height, WHEEL_RADIUS * car.WHEEL["hub"])

    silhouette = (body & ~wheels) | (wheels & ~holes)
    img = Image.new("RGBA", (size, size), car.rgb(background) + (255,))
    img.paste(
        Image.new("RGBA", (size, size), car.rgb(tint) + (255,)),
        (0, 0),
        Image.fromarray((silhouette * 255).astype(np.uint8)),
    )
    return masked(img, "circle", VISIBLE).resize((px, px), Image.LANCZOS)


def svg_source(contours, width, height, radius):
    """A standalone icon SVG: the 108 unit canvas, background included."""
    scale = fit_scale(width, height, radius, FOREGROUND_FIT)
    place = placer(width, height, radius, scale)
    unit = unit_scale(place)
    place(0, 0)[1], place(0, height)[1]
    stops = "\n".join(f'      <stop offset="{o * 100:g}%" stop-color="#{c}" />' for o, c in car.STOPS)
    wheels = []
    for axle in car.axles(contours, height):
        circles = [(radius, car.TYRE), (radius * car.WHEEL["rim"], car.RIM)]
        circles += [(radius * car.WHEEL["hole"], car.TYRE) for _ in car.holes((axle, height), radius)]
        circles.append((radius * car.WHEEL["hub"], car.TYRE))
        for r, colour in circles:
            cx, cy = place(axle, height)
            wheels.append(f'    <circle cx="{cx:.3f}" cy="{cy:.3f}" r="{r * unit:.3f}" fill="#{colour}" />')
    return """<?xml version="1.0" encoding="utf-8"?>
<!-- Woxi Mobile icon. Generated by tools/make-icon.py from the traced mark in
     design/woxi-mark.json. Shown at the full 108 unit canvas. The launcher crops
     this to the central 72 units and masks it, which is what the fit above allows
     for. -->
<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108">
  <defs>
    <linearGradient id="woxi" x1="0" y1="0" x2="0" y2="1">
{stops}
    </linearGradient>
  </defs>
  <rect width="108" height="108" fill="#{bg}" />
  <path fill="url(#woxi)" fill-rule="evenodd" d="{body}" />
{wheels}
</svg>
""".format(
        stops=stops,
        bg=car.BACKGROUND,
        body=body_path(contours, place),
        wheels="\n".join(wheels),
    )


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    print(f"wrote {os.path.relpath(path, ROOT)}")


def main():
    contours, width, height, _ = car.load_mark()

    write(os.path.join(RES, "drawable", "ic_launcher_background.xml"), background_xml())
    write(
        os.path.join(RES, "drawable", "ic_launcher_foreground.xml"),
        foreground_xml(
            contours, width, height, WHEEL_RADIUS, FOREGROUND_FIT, "Woxi Mobile foreground: Woxi's traced W on wheels."
        ),
    )
    write(
        os.path.join(RES, "drawable", "ic_launcher_foreground_round.xml"),
        foreground_xml(
            contours,
            width,
            height,
            WHEEL_RADIUS,
            ROUND_FIT,
            "Woxi Mobile foreground for android:roundIcon. Only launchers\n     that mask icons to a circle ask for this one, so it may sit closer to the edge.",
        ),
    )
    write(
        os.path.join(RES, "drawable", "ic_launcher_monochrome.xml"),
        monochrome_xml(contours, width, height, WHEEL_RADIUS),
    )
    write(os.path.join(RES, "mipmap-anydpi-v26", "ic_launcher.xml"), adaptive_xml("ic_launcher_foreground"))
    write(os.path.join(RES, "mipmap-anydpi-v26", "ic_launcher_round.xml"), adaptive_xml("ic_launcher_foreground_round"))

    for density, px in DENSITIES:
        folder = os.path.join(RES, "mipmap-" + density)
        os.makedirs(folder, exist_ok=True)
        icon(px, "squircle", CANVAS, LEGACY_FIT, background=car.BACKGROUND).save(
            os.path.join(folder, "ic_launcher.png")
        )
        icon(px, "circle", CANVAS, LEGACY_ROUND_FIT, background=car.BACKGROUND).save(
            os.path.join(folder, "ic_launcher_round.png")
        )
        print(f"wrote mipmap-{density}/ic_launcher{{,_round}}.png ({px}x{px})")

    for stale in STALE:
        path = os.path.join(RES, stale)
        if os.path.exists(path):
            os.remove(path)
            print(f"removed old res/{stale}")

    os.makedirs(DESIGN, exist_ok=True)
    write(os.path.join(DESIGN, "icon.svg"), svg_source(contours, width, height, WHEEL_RADIUS))

    tiles = [
        icon(192, "circle", VISIBLE, FOREGROUND_FIT, car.BACKGROUND),
        icon(192, "squircle", VISIBLE, FOREGROUND_FIT, car.BACKGROUND),
        icon(192, "circle", VISIBLE, ROUND_FIT, car.BACKGROUND),
        icon(192, "squircle", CANVAS, LEGACY_FIT, car.BACKGROUND),
        icon(192, "circle", CANVAS, LEGACY_ROUND_FIT, car.BACKGROUND),
        monochrome_icon(192, FOREGROUND_FIT, "202024", "E9E9EE"),
        icon(48, "circle", VISIBLE, FOREGROUND_FIT, car.BACKGROUND),
        icon(48, "squircle", CANVAS, LEGACY_FIT, car.BACKGROUND),
    ]
    scaled = [t if t.width >= 96 else t.resize((t.width * 4, t.height * 4), Image.NEAREST) for t in tiles]
    sheet = Image.new(
        "RGB",
        (sum(t.width for t in scaled) + 8 * (len(scaled) + 1), max(t.height for t in scaled) + 16),
        (128, 128, 132),
    )
    x = 8
    for tile in scaled:
        sheet.paste(tile.convert("RGB"), (x, 8), tile)
        x += tile.width + 8
    sheet.save(os.path.join(DESIGN, "preview.png"))
    print(f"wrote design/preview.png ({sheet.size[0]}x{sheet.size[1]})")
    icon(512, "squircle", CANVAS, LEGACY_FIT, background=car.BACKGROUND).convert("RGB").save(
        os.path.join(DESIGN, "icon-512.png")
    )
    print("wrote design/icon-512.png (512x512)")


if __name__ == "__main__":
    main()
