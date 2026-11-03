"""Compose "Woxi Mobile": the traced W with two wheels under it.

The body is exactly the traced mark (design/woxi-mark.json, produced by
tools/trace-woxi-mark.py) - none of it is redrawn. The wheels sit under the
two outer bottom tips, the places where the W's outline comes down to a point,
and the middle tip is then left hanging between the wheels, the way a car's
underside does. There is no chassis bar: the wheels stand on their own. The
wheels are drawn in front of the body: with the tips reaching all the way to
the axle, drawing them behind would break the rims and leave notches in the
wheels.

The background is #050505, the flat black of Woxi's own banner artwork (the
dominant colour in images/logo.png and images/favicon.png in ad-si/Woxi - not
pure #000000, which is only about 8% of the favicon). The tyre is #2E2E34, the
darkest rubber grey that still separates clearly from that background (19.6%
brightness against its 5.2%), and the rim is a grey disc #A8ABB2 with five
drilled holes and a small center bore - holes and a bore still read as a wheel
at 64 px, where concentric rings or spokes turn to mush.

Outputs (design/):
woxi-mobile.svg            background + car, viewBox in mark units
woxi-mobile-foreground.svg car only, transparent - for splitting into an
                           adaptive icon's foreground layer
woxi-mobile.png            preview: banner black, both adaptive-icon fits
                           (the safe circle and the full visible box), 64 px,
                           and the car over Woxi's gradient

Usage: python tools/make-woxi-mobile.py [--radius 17] [--body gradient|white]
"""

import argparse
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESIGN = os.path.join(ROOT, "design")
STOPS = [(0.0, "FAC22A"), (0.5, "F07C39"), (1.0, "DA3355")]
BACKGROUND = "050505"  # Woxi's banner black, sampled from their artwork
TYRE = "2E2E34"  # rubber: dark, but clearly above the background
RIM = "A8ABB2"  # grey alloy
SAFE_RADIUS = 33.0  # adaptive icon safe circle, in 108 unit canvas
WHEEL = {"rim": 0.74, "hole_orbit": 0.42, "hole": 0.15, "hub": 0.14, "count": 5}
SS = 4


def rgb(value):
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def gradient_at(t):
    t = min(1.0, max(0.0, t))
    for i in range(len(STOPS) - 1):
        (t0, c0), (t1, c1) = STOPS[i], STOPS[i + 1]
        if t <= t1:
            span = t1 - t0
            return mix(rgb(c0), rgb(c1), 0.0 if span == 0 else (t - t0) / span)
    return rgb(STOPS[-1][1])


def load_mark():
    """The trace, in mark units: width 100, height from the traced aspect ratio."""
    with open(os.path.join(DESIGN, "woxi-mark.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    width = 100.0
    height = width / data["aspect"]
    contours = [[(p[0] * width, p[1] * height) for p in c] for c in data["contours_unit"]]
    return contours, width, height, data["metrics"]


def axles(contours, height):
    """The two outer bottom tips: the lowest vertices, leftmost and rightmost."""
    outer = np.asarray(contours[0])
    tips = outer[outer[:, 1] > height - 1.0]
    return float(tips[:, 0].min()), float(tips[:, 0].max())


def holes(center, radius):
    """Centers of the rim's drilled holes."""
    out = []
    for index in range(WHEEL["count"]):
        angle = 2 * math.pi * index / WHEEL["count"] - math.pi / 2
        out.append(
            (
                center[0] + math.cos(angle) * radius * WHEEL["hole_orbit"],
                center[1] + math.sin(angle) * radius * WHEEL["hole_orbit"],
            )
        )
    return out


def body_mask(contours, size, scale):
    """Even-odd filled body, at `scale` times mark units."""
    mask = np.zeros((size[1], size[0]), dtype=bool)
    for contour in contours:
        layer = Image.new("1", size, 0)
        ImageDraw.Draw(layer).polygon([(x * scale, y * scale) for x, y in contour], fill=1)
        mask ^= np.asarray(layer, dtype=bool)
    return mask


def paint_body(img, contours, scale, body):
    """Fill the body: Woxi's gradient, or a flat colour."""
    size = img.size
    layer = Image.new("RGB", size)
    if body == "gradient":
        painter = ImageDraw.Draw(layer)
        for y in range(size[1]):
            painter.line([(0, y), (size[0], y)], fill=tuple(int(v) for v in gradient_at(y / size[1])))
    else:
        layer.paste(rgb(body), (0, 0, size[0], size[1]))
    img.paste(layer, (0, 0), Image.fromarray((body_mask(contours, size, scale) * 255).astype(np.uint8)))


def disc_svg(cx, cy, r, fill):
    return '    <circle cx="{:.3f}" cy="{:.3f}" r="{:.3f}"{} />'.format(cx, cy, r, f' fill="#{fill}"' if fill else "")


def svg(contours, width, height, radius, iou, body, background):
    left, right = axles(contours, height)
    total = height + radius
    parts = ['  <g id="wheels">']
    for cx in (left, right):
        center = (cx, height)
        parts.append(disc_svg(cx, height, radius, TYRE))
        parts.append(disc_svg(cx, height, radius * WHEEL["rim"], RIM))
        for hx, hy in holes(center, radius):
            parts.append(disc_svg(hx, hy, radius * WHEEL["hole"], TYRE))
        parts.append(disc_svg(cx, height, radius * WHEEL["hub"], TYRE))
    parts.append("  </g>")
    stops = "\n".join(f'      <stop offset="{o * 100:g}%" stop-color="#{c}" />' for o, c in STOPS)
    defines = (
        (
            '  <defs>\n    <linearGradient id="woxi" x1="0" y1="0" x2="0" y2="1">\n'
            f"{stops}\n    </linearGradient>\n  </defs>\n"
        )
        if body == "gradient"
        else ""
    )
    fill = "url(#woxi)" if body == "gradient" else f"#{body}"
    path = " ".join("M" + " L".join(f"{x:.3f} {y:.3f}" for x, y in c) + " Z" for c in contours)
    backdrop = f'  <rect width="{width:g}" height="{total:.3f}" fill="#{background}" />\n' if background else ""
    return """<?xml version="1.0" encoding="utf-8"?>
<!-- {what}
     Generated by tools/make-woxi-mobile.py from the trace in design/woxi-mark.json,
     which matches Woxi's own logo bitmap to IoU {iou:.5f}. The background is #{bg},
     the flat black of Woxi's banner. Recount the wheels by editing WHEEL in that
     script, or recolour them here: tyre #{tyre}, rim #{rim}. -->
<svg xmlns="http://www.w3.org/2000/svg" width="{w:g}" height="{h:.3f}"
     viewBox="0 0 {w:g} {h:.3f}">
{defines}{backdrop}  <path id="woxi-mark" fill="{fill}" fill-rule="evenodd" d="{path}" />
{wheels}
</svg>
""".format(
        what="Woxi Mobile: Woxi's traced W on wheels."
        if background
        else "Woxi Mobile foreground: the car alone, for an adaptive icon layer.",
        iou=iou,
        bg=background or "none",
        tyre=TYRE,
        rim=RIM,
        w=width,
        h=total,
        defines=defines,
        backdrop=backdrop,
        fill=fill,
        path=path,
        wheels="\n".join(parts),
    )


def render(contours, width, height, radius, scale, background, body):
    """The composition at `scale`x, on `background` (a colour, 'gradient' or None)."""
    left, right = axles(contours, height)
    px = (round(width * scale), round((height + radius) * scale))
    size = (px[0] * SS, px[1] * SS)
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    paint_body(img, contours, scale * SS, body)  # body first: wheels sit in front
    for cx in (left, right):

        def circle(center, r, fill=None, outline=None, stroke=0):
            draw.ellipse(
                [
                    (center[0] - r) * scale * SS,
                    (center[1] - r) * scale * SS,
                    (center[0] + r) * scale * SS,
                    (center[1] + r) * scale * SS,
                ],
                fill=fill,
                outline=outline,
                width=stroke,
            )

        circle((cx, height), radius, fill=rgb(TYRE))
        circle((cx, height), radius * WHEEL["rim"], fill=rgb(RIM))
        for hx, hy in holes((cx, height), radius):
            circle((hx, hy), radius * WHEEL["hole"], fill=rgb(TYRE))
        circle((cx, height), radius * WHEEL["hub"], fill=rgb(TYRE))
    if background is None:
        out = img
    elif background == "gradient":
        out = Image.new("RGBA", size, (0, 0, 0, 0))
        painter = ImageDraw.Draw(out)
        for y in range(size[1]):
            painter.line([(0, y), (size[0], y)], fill=tuple(int(v) for v in gradient_at(y / size[1])) + (255,))
        out.alpha_composite(img)
    else:
        out = Image.new("RGBA", size, rgb(background) + (255,))
        out.alpha_composite(img)
    return out.resize(px, Image.LANCZOS)


def adaptive_preview(contours, width, height, radius, scale, background, body, mode="safe"):
    """How it looks under a round launcher mask.

    `safe` fits the composition's circumradius to the 66 unit safe circle, so no mask
    of any shape can clip it. `wide` fills the visible 72 unit box instead, which
    looks better and is fine for squircle masks, but a circular one cuts the corners.
    """
    car = render(contours, width, height, radius, scale, None, body)
    span = math.hypot(width / 2, (height + radius) / 2)  # mark units, half diagonal
    shrink = (SAFE_RADIUS / span) if mode == "safe" else (72.0 / width)
    car = car.resize((max(1, round(car.width * shrink)), max(1, round(car.height * shrink))), Image.LANCZOS)
    side = round(108 * scale)
    canvas = Image.new("RGBA", (side * SS, side * SS), rgb(background) + (255,))
    canvas.alpha_composite(
        car.resize((car.width * SS, car.height * SS), Image.LANCZOS),
        ((side - car.width) * SS // 2, (side - car.height) * SS // 2),
    )
    # a launcher crops the 108 unit canvas to the central 72 units, then masks a shape
    inset = round(18 * scale) * SS
    crop = canvas.crop((inset, inset, side * SS - inset, side * SS - inset))
    mask = Image.new("L", crop.size, 0)
    ImageDraw.Draw(mask).ellipse([0, 0, crop.size[0] - 1, crop.size[1] - 1], fill=255)
    crop.putalpha(Image.composite(crop.getchannel("A"), Image.new("L", crop.size, 0), mask))
    return crop.resize((side - 2 * inset // SS, side - 2 * inset // SS), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--radius", type=float, default=17.0, help="wheel radius in mark units")
    ap.add_argument("--body", default="gradient", help="'gradient' (Woxi's own), 'white', 'black', or a hex colour")
    ap.add_argument(
        "--background", default=BACKGROUND, help=f"background colour, 'gradient', or 'none' (default #{BACKGROUND})"
    )
    args = ap.parse_args()

    named = {"white": "FFFFFF", "black": "000000"}
    chosen = args.body.strip().lower()
    body = "gradient" if chosen == "gradient" else named.get(chosen, chosen.lstrip("#").upper())
    if body != "gradient" and (len(body) != 6 or any(c not in "0123456789ABCDEF" for c in body)):
        raise SystemExit("--body must be 'gradient', 'white', 'black' or a six digit hex colour")
    background = None if args.background.lower() == "none" else args.background
    if background is not None and background.lower() != "gradient":
        background = background.lstrip("#").upper()
        if len(background) != 6 or any(c not in "0123456789ABCDEF" for c in background):
            raise SystemExit("--background must be 'gradient', 'none', or a six digit hex colour")

    contours, width, height, metrics = load_mark()
    for name, backdrop in (("woxi-mobile.svg", background), ("woxi-mobile-foreground.svg", None)):
        text = svg(contours, width, height, args.radius, metrics["iou"], body, backdrop)
        with open(os.path.join(DESIGN, name), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        print(
            "wrote design/{} ({:.1f} x {:.1f} mark units, wheels r={:.1f}, body {}, background #{})".format(
                name, width, height + args.radius, args.radius, args.body, backdrop or "none"
            )
        )

    scale = 3.0
    shots = [
        render(contours, width, height, args.radius, scale, background, body),
        adaptive_preview(contours, width, height, args.radius, scale, background or BACKGROUND, body, "safe"),
        adaptive_preview(contours, width, height, args.radius, scale, background or BACKGROUND, body, "wide"),
        render(contours, width, height, args.radius, 64.0 / width, background, body),
        render(contours, width, height, args.radius, scale, "gradient", "FFFFFF"),
    ]
    small = shots.pop(3)
    shots.insert(3, small.resize((small.width * 4, small.height * 4), Image.NEAREST))
    sheet = Image.new(
        "RGB", (sum(s.width for s in shots) + 8 * (len(shots) + 1), max(s.height for s in shots) + 16), (128, 128, 132)
    )
    x = 8
    for shot in shots:
        sheet.paste(shot.convert("RGB"), (x, 8), shot)
        x += shot.width + 8
    sheet.save(os.path.join(DESIGN, "woxi-mobile.png"))
    print(f"wrote design/woxi-mobile.png ({sheet.size[0]}x{sheet.size[1]})")


if __name__ == "__main__":
    main()
