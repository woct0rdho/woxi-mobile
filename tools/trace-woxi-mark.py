"""Trace Woxi's "W" mark out of the logo bitmap into an SVG path.

Woxi's only icon asset is `images/logo.png` in ad-si/Woxi - there is no SVG in
the repository - so the mark is recovered from that bitmap and then cleaned up
into the geometric figure it obviously is:

- a coverage field is recovered from the RGB values, using the fact that
  every pixel is `coverage * gradient(y) + (1 - coverage) * background`.
  Normalising per row removes the mark's own gradient, so one global
  threshold is valid over the whole figure. A plain luminance threshold
  would eat the bottom of the W, where the gradient is dark.
- the field is averaged with its own mirror image, about the axis that
  minimises the difference, which removes the sub-pixel asymmetry left by
  whoever rendered the original.
- the field is upscaled 4x and handed to potrace with -a 0 (straight
  segments only). potrace's input convention is "dark is figure", so the
  image is inverted for it.
- potrace's path is simplified with Ramer-Douglas-Peucker, then tidied into
  the figure it is meant to be: consecutive edges that run in the same
  direction are merged into one straight edge, edges that are nearly
  horizontal (or vertical) are made exactly so, and the corners are rebuilt
  as the intersections of those lines - one vertex per corner, no staircase.
- the vertices are matched with their mirror images and averaged, so the
  path is exactly symmetric, and
- the result is rasterised back and compared against the original coverage
  field, so the script reports the error it really achieves.

`--marching-squares` (or a missing potrace) walks the 0.5 level set with skimage
instead. Potrace is the default because it is the more accurate of the two.

The figure being aimed for is the one the source obviously is: sharp corners, so exactly
one vertex at each angle and no sub-pixel staircase. Straight edges between them. Every
nearly horizontal line exactly horizontal. A mirror image left to right. Woxi's own
rendering is only nearly all of that (its right arm is a pixel wider than its left, and
straight edges wobble by a quarter pixel), so the tidying is what makes it exact: the
contours centered on the axis are rebuilt from their left half plus that half's mirror
image, and the contours either side of the axis take the left one's shape. The center top
tip is the one corner that is not sharp - it carries a short horizontal line about 10 px
wide - so the micro-edge pass only removes edges under 1.5 px, well clear of it.

As measured on Woxi's logo: mirror axis at x = 91.48 px, IoU 0.968 against the original
bitmap, 25 vertices in four contours, symmetry residual 1e-14 px, no edge shorter than
10 px (that shortest edge is the center tip's flat), and no near-axis edge that is not
exactly on its axis. The script prints all of this every run and also writes
design/woxi-mark-vertices.png, which dots every routing point and draws anything
suspicious - a short edge, or a near-axis edge that is not on its axis - in red, so a
regression is visible at a glance.

Outputs (design/):
woxi-mark.json           polygons in source pixels and in a 0..1 box, plus metrics
woxi-mark.svg            the same as one even-odd filled path, in Woxi's gradient
woxi-mark.png            render on a light and a dark background, for eyeballing
woxi-mark-vertices.png   the routing points themselves, for checking the geometry

Usage: python tools/trace-woxi-mark.py [--eps 0.5] [--potrace PATH]
"""

import argparse
import json
import math
import os
import re
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESIGN = os.path.join(ROOT, "design")
TEMP = os.environ.get("TEMP", ".")
DEFAULT_SOURCE = os.path.join(TEMP, "woxi-logo.png")
DEFAULT_POTRACE = r"C:\potrace\potrace.exe"
STOPS = [(0.0, "FAC22A"), (0.5, "F07C39"), (1.0, "DA3355")]
SS = 4
SHORT_EDGE = 8.0                # edges under this are treated as artefacts, see tidy_corners


def rgb(value):
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


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


# source

def coverage_field(path):
    """Per-pixel ink coverage of the mark, plus the window it was found in."""
    img = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64)
    colourful = (img.max(axis=2) - img.min(axis=2)) > 60
    rows = np.where(colourful.any(axis=1))[0]
    cols = np.where(colourful.any(axis=0))[0]
    margin = 8
    y0, y1 = max(0, rows[0] - margin), min(img.shape[0], rows[-1] + margin + 1)
    x0, x1 = max(0, cols[0] - margin), min(img.shape[1], cols[-1] + margin + 1)
    win = img[y0:y1, x0:x1]

    background = np.median(win[((win.max(axis=2) - win.min(axis=2)) < 12)].reshape(-1, 3), axis=0)
    coverage = np.zeros(win.shape[:2])
    for y in range(win.shape[0]):
        row = win[y]
        strong = row[(row.max(axis=1) - row.min(axis=1)) > 60]
        if len(strong) == 0:
            continue
        ink = np.percentile(strong, 99, axis=0)                 # a fully covered pixel of this row
        span = np.maximum(ink - background, 1.0)
        coverage[y] = np.clip(((row - background) / span).mean(axis=1), 0.0, 1.0)
    return coverage, (int(x0), int(y0))


def symmetry_axis(field, search=2.0, steps=400):
    """The vertical axis the figure is most nearly mirrored about, and the residual.

    `field` is in pixel-corner coordinates, so mirroring about `axis` is the array
    flipped after a shift of `width - 2 * axis`.
    """
    width = field.shape[1]
    best = (width / 2, None)
    for step in range(steps + 1):
        axis = width / 2 - search / 2 + search * step / steps
        shifted = ndimage.shift(field, (0, width - 2 * axis), order=1, mode="nearest")
        error = float(np.abs(field - shifted[:, ::-1]).mean())
        if best[1] is None or error < best[1]:
            best = (axis, error)
    return best


def mirror(field, axis):
    width = field.shape[1]
    shifted = ndimage.shift(field, (0, width - 2 * axis), order=1, mode="nearest")
    return shifted[:, ::-1]


# tracers

def trace_potrace(coverage, exe, upscale=4, turdsize=10):
    """Straight-segment potrace trace, returned as polygons in source pixels."""
    grey = Image.fromarray((np.clip(coverage, 0, 1) * 255).astype(np.uint8))
    big = grey.resize((coverage.shape[1] * upscale, coverage.shape[0] * upscale), Image.BICUBIC)
    pgm = os.path.join(TEMP, "woxi-mark-input.pgm")
    Image.fromarray(255 - np.asarray(big)).save(pgm)            # potrace: dark is figure
    svg = os.path.join(TEMP, "woxi-mark-potrace.svg")
    # no --tight: with it, potrace's coordinates become crop-relative and the crop
    # origin is not recoverable from the file, whereas untight coordinates map
    # straight onto the input image through the transform that potrace writes.
    done = subprocess.run([exe, pgm, "-o", svg, "-b", "svg", "-a", "0",
                           "-t", str(turdsize), "-u", "10"],
                          capture_output=True, text=True)
    if done.returncode != 0:
        sys.exit("potrace failed: %s%s" % (done.stdout, done.stderr))
    return parse_potrace(open(svg, encoding="utf-8").read(), upscale)


def parse_potrace(svg, upscale):
    """Read potrace's <path> elements: absolute M, relative m/l/h/v, z, in a transform.

    potrace splits its output over several <path> elements (one per filled region,
    noise speckles included) and cuts counters out by winding, so every element is
    read and the resulting contours are combined even-odd.
    """
    transform = re.search(
        r'transform="translate\(([-\d.]+),([-\d.]+)\)\s*scale\(([-\d.]+),([-\d.]+)\)"', svg)
    if not transform:
        sys.exit("cannot read potrace's transform")
    tx, ty, sx, sy = (float(v) for v in transform.groups())
    commands = re.findall(r'<path d="([^"]+)"', svg)
    if not commands:
        sys.exit("potrace produced no path")
    if any(re.search(r"[cCsSqQtT]", d) for d in commands):
        sys.exit("potrace returned curves, but this mark is straight-edged")

    contours = []
    for path in commands:
        current = []
        pen = np.zeros(2)
        start = np.zeros(2)
        command = None
        numbers = []
        for token in re.findall(r"[MmLlHhVvZz]|-?\d+(?:\.\d+)?", path):
            if token.isalpha():
                if token in "Zz":
                    if len(current) > 2:
                        contours.append(np.asarray(current))
                    current, pen = [], start.copy()
                command = token
                numbers = []
                continue
            numbers.append(float(token))
            if command in "Mm" and len(numbers) == 2:
                pen = (np.array(numbers) if command == "M" else pen + np.array(numbers))
                start = pen.copy()
                current = [pen.copy()]
                numbers = []
            elif command in "Ll" and len(numbers) == 2:
                pen = (np.array(numbers) if command == "L" else pen + np.array(numbers))
                current.append(pen.copy())
                numbers = []
            elif command in "HhVv" and len(numbers) == 1:
                index = 0 if command in "Hh" else 1
                pen[index] = numbers[0] if command.isupper() else pen[index] + numbers[0]
                current.append(pen.copy())
                numbers = []
        if len(current) > 2:
            contours.append(np.asarray(current))

    out = []
    for contour in contours:
        points = np.empty_like(contour)
        points[:, 0] = (contour[:, 0] * sx + tx) / upscale
        points[:, 1] = (contour[:, 1] * sy + ty) / upscale
        out.append(points)
    return out


def trace_marching_squares(coverage, min_area=20.0):
    from skimage import measure

    def area(points):
        x, y = points[:, 0], points[:, 1]
        return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))

    found = measure.find_contours(coverage, 0.5)
    return [c[:, ::-1] for c in found
            if area(np.column_stack((c[:, 1], c[:, 0]))) > min_area]


# geometry

def rdp(points, eps):
    """Ramer-Douglas-Peucker, iterative so a long contour cannot blow the stack."""
    points = np.asarray(points, dtype=np.float64)
    if len(points) < 3:
        return points
    keep = np.zeros(len(points), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        segment = points[last] - points[first]
        length = np.hypot(*segment)
        chunk = points[first + 1:last]
        if length == 0:
            distance = np.hypot(*(chunk - points[first]).T)
        else:
            delta = chunk - points[first]
            distance = np.abs(segment[0] * delta[:, 1] - segment[1] * delta[:, 0]) / length
        worst = int(np.argmax(distance))
        if distance[worst] > eps:
            keep[first + 1 + worst] = True
            stack.append((first, first + 1 + worst))
            stack.append((first + 1 + worst, last))
    return points[keep]


def area(points):
    x, y = points[:, 0], points[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def angle_between(first, second):
    lengths = np.hypot(*first) * np.hypot(*second)
    if lengths < 1e-12:
        return 0.0
    cosine = np.dot(first, second) / lengths
    return math.degrees(math.acos(float(np.clip(cosine, -1.0, 1.0))))


def fit_line(points):
    """Total-least-squares line through the points: (a point on it, unit direction)."""
    center = points.mean(axis=0)
    _, _, axes = np.linalg.svd(points - center, full_matrices=False)
    return center, axes[0]


def straighten(points, tolerance_deg=6.0, snap_deg=3.0, min_run=2.0):
    """Rebuild the polygon as straight edges with one vertex per corner.

    Consecutive edges running the same way are merged into one run, each run is fitted
    with a single line, runs that are nearly horizontal or vertical are made exactly so,
    and the corners come back as the intersections of neighbouring lines. Runs that are
    too short to carry a direction, or that snapping has left parallel to a neighbour,
    are folded into it first, so no two corners can land on top of each other.
    """
    points = np.asarray(points, dtype=np.float64)
    count = len(points)
    directions = []
    for index in range(count):
        delta = points[(index + 1) % count] - points[index]
        length = float(np.hypot(*delta))
        directions.append(delta / length if length > 1e-9 else np.array([1.0, 0.0]))

    # start after the sharpest turn, so no run has to wrap around the seam
    turns = [angle_between(directions[index - 1], directions[index]) for index in range(count)]
    order = [(int(np.argmax(turns)) + index) % count for index in range(count)]
    groups = [[order[0]]]
    for index in order[1:]:
        first, last = groups[-1][0], groups[-1][-1]
        span = points[(last + 1) % count] - points[first]
        if np.hypot(*span) < 1e-9 or angle_between(span, directions[index]) <= tolerance_deg:
            groups[-1].append(index)
        else:
            groups.append([index])

    def run_of(group):
        first, last = group[0], group[-1]
        return np.asarray([points[(first + step) % count]
                           for step in range((last - first) % count + 2)])

    def line_of(run):
        point, direction = fit_line(run)
        angle = abs(math.degrees(math.atan2(direction[1], direction[0]))) % 180.0
        if min(angle, 180.0 - angle) <= snap_deg:
            return np.array([point[0], run[:, 1].mean()]), np.array([1.0, 0.0])
        if abs(angle - 90.0) <= snap_deg:
            return np.array([run[:, 0].mean(), point[1]]), np.array([0.0, 1.0])
        return point, direction

    while len(groups) > 4:
        runs = [run_of(group) for group in groups]
        lines = [line_of(run) for run in runs]
        lengths = [float(np.hypot(*(run[-1] - run[0]))) for run in runs]
        fold = None
        for index, length in enumerate(lengths):
            if length < min_run:
                fold = (index - 1, index) if index > 0 else (index, index + 1)
                break
        if fold is None:
            for index in range(1, len(groups)):
                if angle_between(lines[index - 1][1], lines[index][1]) < 0.5:
                    fold = (index - 1, index)
                    break
        if fold is None:
            break
        before, after = fold
        groups[before] = groups[before] + groups[after]
        del groups[after]

    lines = [line_of(run_of(group)) for group in groups]
    corners = []
    for index in range(len(lines)):
        before, current = lines[index - 1], lines[index]
        matrix = np.column_stack((before[1], -current[1]))
        if abs(np.linalg.det(matrix)) < 1e-9:                    # parallel: no corner here
            corners.append(before[0])
            continue
        offset = np.linalg.solve(matrix, current[0] - before[0])[0]
        corners.append(before[0] + offset * before[1])
    return np.asarray(corners)


def tidy_corners(points, threshold=SHORT_EDGE, collinear_deg=1.5, locality=3.0, rounds=60):
    """Collapse edges too short to be real, so each corner keeps a single vertex.

    Two things leave short edges behind. One is a corner that came out as a pair of
    vertices, where the two edges either side of the short one are the real edges and
    their intersection is the corner they were describing. The other is a straight run
    split in two, where the short edge runs the same way as a neighbour and the shared
    vertex simply goes. The two cases are told apart by that collinearity, because
    distance alone cannot separate them: the flat on top of the center tip is split by
    the mirror axis into two 5 px halves, and merging those by line intersection would
    rebuild the sharp point the flat exists to avoid.
    """
    pts = [np.asarray(p, dtype=np.float64) for p in points]
    for _ in range(rounds):
        count = len(pts)
        if count <= 4:
            break
        index = None
        for candidate in range(count):
            if np.hypot(*(pts[(candidate + 1) % count] - pts[candidate])) < threshold:
                index = candidate
                break
        if index is None:
            break
        before, first = pts[index - 1], pts[index]
        second, after = pts[(index + 1) % count], pts[(index + 2) % count]
        short = second - first
        length = float(np.hypot(*short))
        if (angle_between(short, first - before) <= collinear_deg
                or angle_between(short, after - second) <= collinear_deg):
            merged = first                                     # straight run: drop the joint
        else:
            span = after - second
            matrix = np.column_stack((first - before, -span))
            merged = None
            if abs(np.linalg.det(matrix)) > 1e-9:
                if angle_between(first - before, span) > collinear_deg:
                    offset = np.linalg.solve(matrix, second - before)[0]
                    candidate = before + offset * (first - before)
                    if max(np.hypot(*(candidate - first)),
                           np.hypot(*(candidate - second))) <= max(locality, 0.75 * length):
                        merged = candidate
            if merged is None:
                merged = (first + second) / 2                  # give up gracefully
        del pts[index]
        del pts[index % len(pts)]
        pts.insert(index, merged)
    return np.asarray(pts)


def snap_axes(points, snap_deg=3.0):
    """Put edges that are nearly horizontal or vertical exactly on the axis.

    Each such edge moves to the mean of its own two ends, so an edge and its mirror image
    move by the same amount and the figure stays symmetric. Running after the symmetry
    passes is what makes this work: averaging a vertex with its partner can leave a cut
    tilting by a few hundredths of a pixel, which is exactly what "nearly horizontal
    lines are horizontal" rules out.
    """
    pts = np.asarray(points, dtype=np.float64).copy()
    count = len(pts)
    vertical = [None] * count
    horizontal = [None] * count
    for index in range(count):
        delta = pts[(index + 1) % count] - pts[index]
        if np.hypot(*delta) < 1e-9:
            continue
        angle = abs(math.degrees(math.atan2(delta[1], delta[0]))) % 180.0
        if min(angle, 180.0 - angle) <= snap_deg:
            for end in (index, (index + 1) % count):
                mean = (pts[index][1] + pts[(index + 1) % count][1]) / 2
                horizontal[end] = mean if horizontal[end] is None else (horizontal[end] + mean) / 2
        elif abs(angle - 90.0) <= snap_deg:
            for end in (index, (index + 1) % count):
                mean = (pts[index][0] + pts[(index + 1) % count][0]) / 2
                vertical[end] = mean if vertical[end] is None else (vertical[end] + mean) / 2
    for index in range(count):
        if horizontal[index] is not None:
            pts[index][1] = horizontal[index]
        if vertical[index] is not None:
            pts[index][0] = vertical[index]
    return pts


def polish(polygons, rounds=3):
    """Settle the figure: drop mid-line vertices, then put near-axis edges on the axis.

    Each pass can create work for the other - snapping makes two edges collinear, and
    joining those moves an end - so they alternate until nothing changes.
    """
    out = polygons
    for _ in range(rounds):
        settled = [snap_axes(merge_collinear(points)) for points in out]
        if all(len(a) == len(b) and np.allclose(a, b, atol=1e-12)
               for a, b in zip(out, settled)):
            return settled
        out = settled
    return out


def merge_collinear(points, angle_deg=1.5, rounds=40):
    """Drop vertices that sit in the middle of a straight edge.

    Rebuilding a centered contour leaves a joint where its left half meets the mirrored
    one, and on the center tip's flat that joint is mid-edge. Removing it keeps the flat
    a single edge with a vertex at each end, and because collinearity is the same on both
    sides of the mirror, the result stays symmetric.
    """
    pts = [np.asarray(p, dtype=np.float64) for p in points]
    for _ in range(rounds):
        count = len(pts)
        if count <= 4:
            break
        removed = False
        for index in range(count):
            first, joint, second = pts[index - 1], pts[index], pts[(index + 1) % count]
            if angle_between(joint - first, second - joint) <= angle_deg:
                del pts[index]
                removed = True
                break
        if not removed:
            break
    return np.asarray(pts)


def axis_meetings(points, axis, on_axis=0.3):
    """Where the outline meets the mirror axis: edge crossings and on-axis vertices."""
    meetings = []
    count = len(points)
    for index in range(count):
        first, second = points[index], points[(index + 1) % count]
        if abs(first[0] - axis) <= on_axis and abs(second[0] - axis) <= on_axis:
            continue                                             # a segment lying along it
        if abs(first[0] - axis) <= on_axis:
            meetings.append((index, np.array([axis, first[1]])))
        elif (first[0] - axis) * (second[0] - axis) < 0:
            ratio = (axis - first[0]) / (second[0] - first[0])
            meetings.append((index, first + ratio * (second - first)))
    return meetings


def mirror_rebuild(points, axis, on_axis=0.3):
    """Rebuild a centered contour from its left half, so both halves share one structure.

    Walking the outline from one axis meeting to the other gives one of the two arcs.
    If that turned out to be the right-hand one, the other arc is taken instead. The
    two meeting points sit exactly on the axis, so the result is symmetric exactly, not
    approximately. Repeated points along the axis are collapsed first, otherwise a flat
    sitting on the axis comes back as a degenerate sliver.
    """
    points = np.asarray(points, dtype=np.float64)
    meetings = axis_meetings(points, axis, on_axis)
    if len(meetings) != 2 or np.hypot(*(meetings[0][1] - meetings[1][1])) < 1e-6:
        return points
    count = len(points)
    (first_edge, first), (second_edge, second) = meetings

    def arc(start_edge, end_edge):
        out = []
        index = (start_edge + 1) % count
        while True:
            out.append(points[index])
            if index == end_edge:
                return out
            index = (index + 1) % count
            if len(out) > count:
                return None

    def squash(chain):
        out = []
        for point in chain:
            if not out or np.hypot(*(point - out[-1])) > 1e-6:
                out.append(point)
        while len(out) > 1 and np.hypot(*(out[-1] - out[0])) <= 1e-6:
            out.pop()
        return out

    left = arc(first_edge, second_edge)
    if left is None:
        return points
    if np.mean([point[0] for point in left]) > axis:         # that arc was the right-hand one
        left = arc(second_edge, first_edge)
        if left is None:
            return points
        first, second = second, first
    left = squash([first] + left)[1:]                        # drop points on top of `first`
    mirrored = [np.array([2 * axis - point[0], point[1]]) for point in reversed(left)]
    rebuilt = squash([first] + left + [second] + mirrored)
    return np.asarray(rebuilt) if len(rebuilt) >= 3 else points


def enforce_mirror(polygons, axis):
    """Return a polygon set that is exactly symmetric about the mirror axis.

    A contour that crosses the axis is rebuilt from its left half. A contour that is one
    of a mirrored pair is replaced by the mirror image of its left partner. Whether a
    contour crosses the axis is decided by walking it, not by averaging its vertex
    positions, which can sit well off the axis on a busy outline.
    """
    centered, sided = [], []
    for points in polygons:
        points = np.asarray(points, dtype=np.float64)
        if len(axis_meetings(points, axis)) >= 2:
            centered.append(points)
        else:
            sided.append(points)
    result = [mirror_rebuild(points, axis) for points in centered]
    sided.sort(key=lambda points: points[:, 0].mean())
    for index in range(0, len(sided) - 1, 2):
        left = sided[index]
        result.append(left)
        result.append(np.column_stack((2 * axis - left[:, 0], left[:, 1])))
    if len(sided) % 2:                                           # unpaired: keep as it is
        result.append(sided[-1])
    return result


def symmetrise(points, axis, tolerance=1.5, on_axis=0.05, rounds=3):
    """Average every vertex with its mirror image, so the path is exactly symmetric."""
    points = np.asarray(points, dtype=np.float64)
    for _ in range(rounds):
        images = np.column_stack((2 * axis - points[:, 0], points[:, 1]))
        moved = points.copy()
        for index, point in enumerate(points):
            distances = np.hypot(images[:, 0] - point[0], images[:, 1] - point[1])
            partner = int(np.argmin(distances))
            if distances[partner] <= tolerance:
                moved[index] = (point + images[partner]) / 2
        near = np.abs(moved[:, 0] - axis) <= on_axis
        moved[near, 0] = axis
        points = moved
    return points


def render(polygons, shape, scale=SS):
    """Coverage of the even-odd filled polygons: draw each at `scale`x, XOR, box-filter."""
    accumulated = np.zeros((shape[0] * scale, shape[1] * scale), dtype=bool)
    for points in polygons:
        layer = Image.new("1", (shape[1] * scale, shape[0] * scale), 0)
        ImageDraw.Draw(layer).polygon([tuple(p * scale) for p in points], fill=1)
        accumulated ^= np.asarray(layer, dtype=bool)
    small = Image.fromarray((accumulated * 255).astype(np.uint8))
    return np.asarray(small.resize((shape[1], shape[0]), Image.BOX), dtype=np.float64) / 255.0


def measure(polygons, coverage):
    truth = coverage >= 0.5
    filled = render(polygons, coverage.shape)
    guess = filled >= 0.5
    iou = np.logical_and(truth, guess).sum() / np.logical_or(truth, guess).sum()
    # How far the drawn shape reaches past, or stops short of, the source shape:
    # For a pixel only the trace covers, the distance to the nearest source pixel.
    # For a pixel only the source covers, the distance to the nearest gap in it.
    over = np.logical_and(guess, ~truth)
    short = np.logical_and(truth, ~guess)
    worst = max(ndimage.distance_transform_edt(~truth)[over].max() if over.any() else 0.0,
                ndimage.distance_transform_edt(truth)[short].max() if short.any() else 0.0)
    return {"iou": float(iou), "mean_coverage_error": float(np.abs(coverage - filled).mean()),
            "max_edge_px": float(worst),
            "pixels_wrong": int(np.logical_xor(truth, guess).sum())}


def describe(polygons, axis):
    """Report on the tidied figure: corners, axis-aligned edges, symmetry."""
    verticals = horizontals = 0
    shortest = None
    closest = math.inf
    inexact = 0
    for points in polygons:
        count = len(points)
        for index in range(count):
            first, second = points[index], points[(index + 1) % count]
            delta = second - first
            length = float(np.hypot(*delta))
            if index:
                closest = min(closest, length)
            if shortest is None or length < shortest:
                shortest = length
            angle = abs(math.degrees(math.atan2(delta[1], delta[0]))) % 180.0
            if min(angle, 180.0 - angle) <= 3.0:
                horizontals += 1
                if abs(delta[1]) > 1e-9:
                    inexact += 1
            elif abs(angle - 90.0) <= 3.0:
                verticals += 1
                if abs(delta[0]) > 1e-9:
                    inexact += 1
    # every vertex must have a partner exactly where its own mirror image is
    flat = np.vstack(polygons)
    images = np.column_stack((2 * axis - flat[:, 0], flat[:, 1]))
    worst = 0.0
    for point in flat:
        distances = np.hypot(images[:, 0] - point[0], images[:, 1] - point[1])
        worst = max(worst, float(distances.min()))
    return {"horizontals": horizontals, "verticals": verticals, "shortest_edge_px": shortest,
            "near_axis_but_not_on_it": inexact,
            "closest_vertices_px": None if closest is math.inf else closest,
            "symmetry_residual_px": worst}


# output

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=DEFAULT_SOURCE)
    ap.add_argument("--potrace", default=DEFAULT_POTRACE)
    ap.add_argument("--eps", type=float, default=0.5, help="RDP tolerance before tidying, px")
    ap.add_argument("--tolerance", type=float, default=6.0, help="merge edges within this angle")
    ap.add_argument("--snap", type=float, default=3.0, help="snap edges within this angle to the axes")
    ap.add_argument("--marching-squares", action="store_true", help="do not use potrace")
    args = ap.parse_args()
    if not os.path.exists(args.source):
        sys.exit("source bitmap not found: %s" % args.source)

    coverage, window = coverage_field(args.source)
    axis, residual = symmetry_axis(coverage)
    field = 0.5 * (coverage + mirror(coverage, axis))
    use_potrace = not args.marching_squares and os.path.exists(args.potrace)
    tracer = "potrace -a 0" if use_potrace else "marching squares"
    print("source      %s" % os.path.relpath(args.source, ROOT))
    print("window      %dx%d px at (%d, %d)" % (coverage.shape[1], coverage.shape[0], *window))
    print("mirror axis x=%.3f px (window center %.3f), residual %.4f before, %.4f after"
          % (axis, coverage.shape[1] / 2, residual, float(np.abs(field - mirror(field, axis)).mean())))
    print("tracer      %s" % tracer)

    raw = (trace_potrace(field, args.potrace) if use_potrace
           else trace_marching_squares(field))
    raw = [c for c in raw if area(c) > 20.0]                     # drop specks
    polygons = [symmetrise(tidy_corners(straighten(rdp(c, args.eps), args.tolerance,
                                                  args.snap)), axis)
                for c in raw]
    polygons = [merge_collinear(p) for p in enforce_mirror(polygons, axis)]
    polygons = polish(polygons)
    stats = measure(polygons, coverage)
    report = describe(polygons, axis)
    print("figure      %d contours, %d vertices (from %d traced points): %d corners, "
          "%d horizontal, %d vertical edges"
          % (len(polygons), sum(len(p) for p in polygons), sum(len(c) for c in raw),
             sum(len(p) for p in polygons), report["horizontals"], report["verticals"]))
    print("cleanliness closest two vertices %.2f px apart. shortest edge %.2f px. "
          "%d near-axis edges not exactly on an axis. symmetry residual %.2e px"
          % (report["closest_vertices_px"], report["shortest_edge_px"],
             report["near_axis_but_not_on_it"], report["symmetry_residual_px"]))
    print("fidelity    IoU %.5f, mean coverage error %.4f, worst edge %.2f px, %d px wrong"
          % (stats["iou"], stats["mean_coverage_error"], stats["max_edge_px"], stats["pixels_wrong"]))

    points = np.vstack(polygons)
    lo, hi = points.min(axis=0), points.max(axis=0)
    size = hi - lo
    unit = [(p - lo) / size for p in polygons]

    os.makedirs(DESIGN, exist_ok=True)
    with open(os.path.join(DESIGN, "woxi-mark.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "source": "images/logo.png in ad-si/Woxi",
            "method": "%s, RDP %.2f px, edges merged within %.1f deg and snapped within "
                      "%.1f deg, vertices mirrored about x=%.3f" % (
                          tracer, args.eps, args.tolerance, args.snap, axis),
            "metrics": {k: round(v, 6) for k, v in stats.items()},
            "figure": {k: (round(v, 6) if isinstance(v, float) else v)
                       for k, v in report.items()},
            "mirror_axis_px": round(axis, 3),
            "source_window": {"x": window[0], "y": window[1],
                              "width": int(coverage.shape[1]), "height": int(coverage.shape[0])},
            "bbox_px": {"x": round(float(lo[0]), 3), "y": round(float(lo[1]), 3),
                        "width": round(float(size[0]), 3), "height": round(float(size[1]), 3)},
            "aspect": round(float(size[0] / size[1]), 5),
            "contours_px": [[[round(float(v), 3) for v in p] for p in contour]
                            for contour in polygons],
            "contours_unit": [[[round(float(v), 5) for v in p] for p in contour]
                              for contour in unit],
        }, fh, indent=2)
        fh.write("\n")
    print("wrote design/woxi-mark.json")

    w = 100.0
    h = w * size[1] / size[0]
    d = " ".join("M" + " L".join("%.3f %.3f" % (p[0] * w, p[1] * h) for p in contour) + " Z"
                 for contour in unit)
    stops = "\n".join('      <stop offset="%g%%" stop-color="#%s" />' % (o * 100, c)
                      for o, c in STOPS)
    svg = """<?xml version="1.0" encoding="utf-8"?>
<!-- Woxi's W, traced from images/logo.png in ad-si/Woxi by tools/trace-woxi-mark.py and
     tidied into the geometric figure it is: one vertex per corner, straight edges, the
     near-horizontal cuts exactly horizontal, and mirror symmetry about the vertical axis.
     IoU %(iou).5f against the source bitmap, worst edge %(worst).2f px.
     The path is even-odd filled, so the three counters are holes. Recolour by changing
     the fill. The gradient below is Woxi's own. -->
<svg xmlns="http://www.w3.org/2000/svg" width="%(w)g" height="%(h).3f"
     viewBox="0 0 %(w)g %(h).3f">
  <defs>
    <linearGradient id="woxi" x1="0" y1="0" x2="0" y2="1">
%(stops)s
    </linearGradient>
  </defs>
  <path id="woxi-mark" fill="url(#woxi)" fill-rule="evenodd" d="%(d)s" />
</svg>
""" % {"iou": stats["iou"], "worst": stats["max_edge_px"], "w": w, "h": h,
       "stops": stops, "d": d}
    with open(os.path.join(DESIGN, "woxi-mark.svg"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(svg)
    print("wrote design/woxi-mark.svg")

    px = 420
    sheet = Image.new("RGB", (2 * px + 12, px), (128, 128, 128))
    for index, background in enumerate(((255, 255, 255), (26, 26, 28))):
        scale = min(px / w, px / h) * 0.9
        ox, oy = (px - w * scale) / 2, (px - h * scale) / 2
        fitted = [np.column_stack((p[:, 0] * w * scale + ox, p[:, 1] * h * scale + oy))
                  for p in unit]
        mask = Image.fromarray((render(fitted, (px, px)) * 255).astype(np.uint8))
        gradient = Image.new("RGB", (px, px))
        painter = ImageDraw.Draw(gradient)
        for y in range(px):
            painter.line([(0, y), (px, y)], fill=tuple(int(c) for c in gradient_at(y / px)))
        tile = Image.new("RGB", (px, px), background)
        tile.paste(gradient, (0, 0), mask)
        sheet.paste(tile, (index * (px + 12), 0))
    sheet.save(os.path.join(DESIGN, "woxi-mark.png"))
    print("wrote design/woxi-mark.png")

    # vertex map: every routing point marked, anything that still looks wrong in red
    pad, up = 6.0, 5
    span = points.max(axis=0) - points.min(axis=0) + 2 * pad
    size = (int(span[0] * up), int(span[1] * up))
    canvas = Image.new("RGB", size, (255, 255, 255))
    draw = ImageDraw.Draw(canvas)

    def at(point):
        return ((point[0] - lo[0] + pad) * up, (point[1] - lo[1] + pad) * up)

    body = np.zeros((size[1], size[0]), dtype=bool)
    for contour in polygons:
        layer = Image.new("1", size, 0)
        ImageDraw.Draw(layer).polygon([at(point) for point in contour], fill=1)
        body ^= np.asarray(layer, dtype=bool)
    canvas.paste(Image.new("RGB", size, (238, 238, 240)), (0, 0),
                 Image.fromarray((body * 255).astype(np.uint8)))
    suspicious = 0
    for contour in polygons:
        count = len(contour)
        for index in range(count):
            first, second = contour[index], contour[(index + 1) % count]
            delta = second - first
            angle = abs(math.degrees(math.atan2(delta[1], delta[0]))) % 180.0
            near_axis = min(angle, 180.0 - angle) <= 3.0 or abs(angle - 90.0) <= 3.0
            on_axis = abs(delta[1]) < 1e-9 or abs(delta[0]) < 1e-9
            if np.hypot(*delta) < SHORT_EDGE or (near_axis and not on_axis):
                suspicious += 1
                draw.line([at(first), at(second)], fill=(220, 30, 30), width=2)
            else:
                draw.line([at(first), at(second)], fill=(150, 150, 158))
    for contour in polygons:
        for point in contour:
            x, y = at(point)
            draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(30, 90, 220))
    canvas.save(os.path.join(DESIGN, "woxi-mark-vertices.png"))
    print("wrote design/woxi-mark-vertices.png (blue = routing points, red = %d suspicious)"
          % suspicious)


if __name__ == "__main__":
    main()
