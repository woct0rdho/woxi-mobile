"""Measure how much empty margin a plot card carries on its left and bottom.

A plot card is Woxi's own background rectangle: a large run of one flat colour,
slightly different from the page background, spanning most of the screen width.
"Card rows" are the rows whose most common colour is that colour - axis lines,
grid lines and the curve only occupy a few pixels per row, so they do not break
the run. Inside the card, "ink" is any pixel clearly brighter than the card
colour: tick labels, axes, the curve and any title.

Usage:
    python tools/measure-plot-padding.py screenshots/before.png screenshots/after.png
    python tools/measure-plot-padding.py --probe-x 150 shot.png
"""

import argparse
import sys
from collections import Counter
from PIL import Image

DARK_TOLERANCE = 2      # the page (30,30,30) and a plot card (26,26,26) differ by only 4
INK_DELTA = 60          # how much brighter than the card ink has to be (sum of RGB)
MIN_CARD_HEIGHT = 150   # px, a plot is tall, the entry box and the keyboard are not
MIN_CARD_LEFT = 20      # px, the page background starts at x=0, a card does not


def same(a, b, tol=DARK_TOLERANCE):
    return all(abs(a[i] - b[i]) <= tol for i in range(3))


def find_card(px, width, height, probe_x):
    """Return (top, bottom, colour) of the first plot card at probe_x.

    A card is a tall, flat band of one colour that is not the page background
    and does not start at the left edge of the screen.
    """
    page = Counter(px[x, y] for y in range(0, height, 7) for x in range(0, width, 7)).most_common(1)[0][0]
    y = 0
    while y < height:
        colour = px[probe_x, y]
        if same(colour, page):
            y += 1
            continue
        start = y
        while y < height and same(px[probe_x, y], colour):
            y += 1
        if y - start > MIN_CARD_HEIGHT:
            row = start + min(40, (y - start) // 4)
            left = next((x for x in range(width) if same(px[x, row], colour)), None)
            right = next((x for x in range(width - 1, -1, -1) if same(px[x, row], colour)), None)
            if left is not None and right is not None and left >= MIN_CARD_LEFT:
                return start, y - 1, colour
        y += 1
    return None


def analyse(path, probe_x):
    img = Image.open(path).convert("RGB")
    width, height = img.size
    px = img.load()
    # The trimmed margin can be only a dozen pixels wide, so try several columns
    # near the left edge of a card and keep the tallest band found.
    candidates = [probe_x, 100, 120, 140, 170, 200, 250, 300]
    best = None
    for x in dict.fromkeys(candidates):
        card = find_card(px, width, height, x)
        if card and (best is None or (card[1] - card[0]) > (best[1] - best[0])):
            best = card
    if not best:
        print(f"{path}: no plot card found")
        return
    top, bottom, colour = best

    # Horizontal extent of the card, measured on a row inside it.
    row = min(bottom - 10, top + 40)
    left = next((x for x in range(width) if same(px[x, row], colour)), None)
    right = next((x for x in range(width - 1, -1, -1) if same(px[x, row], colour)), None)
    if left is None or right is None:
        print(f"{path}: could not measure the card's width")
        return

    base = sum(colour)
    inset = 4

    def is_ink(x, y):
        return sum(px[x, y]) > base + INK_DELTA

    ink_left = next((x for x in range(left + inset, right - inset)
                     if any(is_ink(x, y) for y in range(top + inset, bottom - inset))), None)
    ink_bottom = next((y for y in range(bottom - inset, top + inset, -1)
                       if any(is_ink(x, y) for x in range(left + inset, right - inset))), None)

    card_w = right - left
    card_h = bottom - top
    print(f"{path}")
    print(f"  card: x {left}..{right} ({card_w} px), y {top}..{bottom} ({card_h} px), colour {colour}")
    if ink_left is not None:
        print(f"  left gap  : {ink_left - left:4} px  ({100.0 * (ink_left - left) / card_w:5.1f}% of card width)")
    if ink_bottom is not None:
        print(f"  bottom gap: {bottom - ink_bottom:4} px  ({100.0 * (bottom - ink_bottom) / card_h:5.1f}% of card height)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("shots", nargs="+", help="screenshot PNGs to measure")
    parser.add_argument("--probe-x", type=int, default=150,
                        help="column used to find the card's top and bottom (default 150)")
    args = parser.parse_args()
    for path in args.shots:
        analyse(path, args.probe_x)
    return 0


if __name__ == "__main__":
    sys.exit(main())
