"""Compare the curve's ink box between screenshots of the same plot.

Run with adb: python tools/check-ink-box.py shot1.png [shot2.png ...]

Prints, per image, the bounding box and pixel count of the plot's series color inside the
plot region, so a gesture that draws the curve a few percent larger (or moves it) shows up
as a different box.
"""

import sys

from PIL import Image

# Woxi's first palette color (#3D99CC), tight enough to exclude the card's own lighter
# blue border (77,140,223) and loose enough for the curve's antialiased edges.
SERIES = (61, 153, 204)
TOLERANCE = 12
# Between the top bar and the keyboard: the only series-colored ink there is the curve
# (the card's own border is a lighter blue, excluded by the tolerance).
REGION = (0, 300, 1080, 1800)


def ink_box(path):
    image = Image.open(path).convert("RGB")
    pixels = image.load()
    x0, y0, x1, y1 = REGION
    box = [None, None, None, None]
    count = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = pixels[x, y]
            if abs(r - SERIES[0]) <= TOLERANCE and abs(g - SERIES[1]) <= TOLERANCE and abs(b - SERIES[2]) <= TOLERANCE:
                count += 1
                box[0] = x if box[0] is None else min(box[0], x)
                box[1] = y if box[1] is None else min(box[1], y)
                box[2] = x if box[2] is None else max(box[2], x)
                box[3] = y if box[3] is None else max(box[3], y)
    return box, count


def main():
    for path in sys.argv[1:]:
        box, count = ink_box(path)
        if not count:
            print(f"{path}: no series ink")
            continue
        width = box[2] - box[0] + 1
        height = box[3] - box[1] + 1
        print(f"{path}: box={box} {width}x{height} pixels={count}")


if __name__ == "__main__":
    main()
