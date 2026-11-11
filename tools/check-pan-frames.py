"""Per-frame continuity of a plot gesture, from a screen recording.

A gesture is only smooth if the curve moves by the same small step in every frame, and
if every frame shows the whole curve: the parts that were outside the viewport have to
enter the frame the moment the pan brings them in. This measures the blue ink inside the
plot card on every frame, along the pan's axis (a column profile for a horizontal pan, a
row profile for a vertical one), and cross-correlates consecutive profiles to get the
step the curve actually took. A part that appears late shows up as a frame where the
curve did not move followed by one where it jumped. A resized card shows up as the ink
frame changing.

Usage: python tools/check-pan-frames.py <video> [--axis x|y] [--from S] [--to S]
       [--card x0,y0,x1,y1] [--montage PATH]
"""

import os
import shutil
import subprocess
import sys

from PIL import Image

FRAMES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "screenshots", "pan-frames")
# Inside the plot card's border, for a single-entry document with the keyboard up, at
# 1080x2400. The border itself is blue, so it has to stay outside the crop.
CARD = (90, 560, 1070, 1200)


def ffmpeg_path():
    override = os.environ.get("WOXI_FFMPEG")
    if override:
        return override
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
    except ImportError:
        raise SystemExit("ffmpeg not found: put it on PATH, set WOXI_FFMPEG, or pip install imageio-ffmpeg") from None
    return imageio_ffmpeg.get_ffmpeg_exe()


def modal_color(pixels, card):
    """The color the picture is mostly filled with, inside the card's search area."""
    x0, y0, x1, y1 = card
    counts = {}
    for y in range(y0, y1, 3):
        for x in range(x0, x1, 3):
            color = pixels[x, y]
            counts[color] = counts.get(color, 0) + 1
    return max(counts, key=counts.get)


def picture_box(pixels, card, background, tolerance=3):
    """The box the picture's background fills: the card, as the canvas sizes it."""
    x0, y0, x1, y1 = card

    def matches(pixel):
        return all(abs(pixel[i] - background[i]) <= tolerance for i in range(3))

    rows = []
    for y in range(y0, y1):
        hits = 0
        total = 0
        for x in range(x0, x1, 2):
            total += 1
            hits += matches(pixels[x, y])
        if hits >= total * 0.5:
            rows.append(y)
    cols = []
    for x in range(x0, x1):
        hits = 0
        total = 0
        for y in range(y0, y1, 2):
            total += 1
            hits += matches(pixels[x, y])
        if hits >= total * 0.5:
            cols.append(x)
    if not rows or not cols:
        return None
    return (cols[0], rows[0], cols[-1], rows[-1])


def measure(path, card, background=None):
    image = Image.open(path).convert("RGB")
    pixels = image.load()
    x0, y0, x1, y1 = card
    columns = [0] * (x1 - x0)
    rows = [0] * (y1 - y0)
    box = [x1, y1, x0, y0]
    total = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b = pixels[x, y]
            # Woxi's curve blue. The frame, ticks and labels are gray.
            if b > 140 and b - r > 70 and 90 < g < 220:
                columns[x - x0] += 1
                rows[y - y0] += 1
                total += 1
                box[0] = min(box[0], x)
                box[1] = min(box[1], y)
                box[2] = max(box[2], x)
                box[3] = max(box[3], y)
    if total < 60:
        return None
    if background is None:
        background = modal_color(pixels, card)
    return {
        "columns": columns,
        "rows": rows,
        "box": tuple(box),
        "pixels": total,
        "card": picture_box(pixels, card, background),
    }


def shift_of(profile, reference, limit):
    """The offset that best explains `profile` as `reference` moved by it, in pixels."""
    best = 0
    best_cost = None
    length = len(profile)
    for offset in range(-limit, limit + 1):
        cost = 0
        for index in range(max(0, -offset), min(length, length - offset)):
            difference = profile[index] - reference[index + offset]
            cost += difference if difference > 0 else -difference
        if best_cost is None or cost < best_cost:
            best_cost = cost
            best = offset
    return best


def main():
    arguments = sys.argv[1:]
    if not arguments:
        raise SystemExit(__doc__)
    video = arguments[0]
    axis = "x"
    first = 0
    last = None
    montage = None
    card = CARD
    background = None
    limit = 40
    index = 1
    while index < len(arguments):
        if arguments[index] == "--axis":
            axis = arguments[index + 1]
            index += 2
        elif arguments[index] == "--from":
            first = int(arguments[index + 1])
            index += 2
        elif arguments[index] == "--to":
            last = int(arguments[index + 1])
            index += 2
        elif arguments[index] == "--montage":
            montage = arguments[index + 1]
            index += 2
        elif arguments[index] == "--card":
            card = tuple(int(value) for value in arguments[index + 1].split(","))
            index += 2
        elif arguments[index] == "--background":
            background = tuple(int(value) for value in arguments[index + 1].split(","))
            index += 2
        elif arguments[index] == "--limit":
            # How far the curve may have moved between two frames, in pixels. A periodic curve
            # (a sine) would otherwise match its own next period and report a jump of a whole
            # period on one noisy frame.
            limit = int(arguments[index + 1])
            index += 2
        else:
            raise SystemExit(f"unknown argument {arguments[index]}")
    ffmpeg = ffmpeg_path()
    if os.path.isdir(FRAMES):
        for name in os.listdir(FRAMES):
            os.remove(os.path.join(FRAMES, name))
    else:
        os.makedirs(FRAMES)
    subprocess.run(
        [ffmpeg, "-loglevel", "error", "-i", video, "-fps_mode", "passthrough", os.path.join(FRAMES, "f%05d.png")],
        check=True,
    )
    names = sorted(os.listdir(FRAMES))
    if last is None:
        last = len(names)
    names = names[first:last]
    print(f"{len(names)} frames from {video}")
    if background is None:
        # One background for the whole video: the picture's fill, voted over its frames. Taking
        # each frame's own mode misfires on the frames where the picture is not painted yet, and
        # that would report the card as resized when it is only about to appear.
        votes = {}
        for name in names[::4]:
            image = Image.open(os.path.join(FRAMES, name)).convert("RGB")
            color = modal_color(image.load(), card)
            votes[color] = votes.get(color, 0) + 1
        background = max(votes, key=votes.get)
    print(f"background: {background}")
    measured = [(name, measure(os.path.join(FRAMES, name), card, background)) for name in names]
    known = [(name, result) for name, result in measured if result]
    if not known:
        raise SystemExit("no curve found in the card")
    box0 = known[0][1]["box"]
    card0 = known[0][1]["card"]
    print(f"reference box: {box0} pixels={known[0][1]['pixels']} card={card0}")

    steps = []
    previous = None
    for name, result in measured:
        if not result:
            steps.append((name, None, None))
            previous = None
            continue
        profile = result["columns"] if axis == "x" else result["rows"]
        limit = 90
        if previous is None:
            steps.append((name, None, result))
        else:
            steps.append((name, shift_of(profile, previous, limit), result))
        previous = profile

    shifts = [step for _, step, _ in steps if step is not None and step != 0]
    print(f"  {'frame':>10}  {'step':>6}  {'box':>26}  {'pixels':>7}  card")
    card_changes = []
    for name, step, result in steps:
        if result is None:
            print(f"  {name:>10}  {'-':>6}  no curve")
            continue
        box = result["box"]
        gaps = (box[0] - box0[0], box[1] - box0[1], box0[2] - box[2], box0[3] - box[3])
        crossed = all(value <= 2 for value in gaps) and all(value >= -2 for value in gaps)
        shown = "-" if step is None else f"{step:+d}"
        card = result["card"]
        if card is None:
            card_note = "?"
        elif card0 is None or card == card0:
            card_note = "ok"
        else:
            # The card is the canvas: if its edges move, everything the canvas drew moves too.
            card_changes.append((name, card))
            card_note = ",".join(str(value) for value in card) + (
                " resized"
                if (card[2] - card[0], card[3] - card[1]) != (card0[2] - card0[0], card0[3] - card0[1])
                else " moved"
                if card0
                else ""
            )
        print(
            f"  {name:>10}  {shown:>6}  {box!s:>26}  {result['pixels']:>7}  {card_note}"
            + ("" if crossed else f"  short by {gaps}")
        )
    if card0 is not None:
        width = card0[2] - card0[0] + 1
        height = card0[3] - card0[1] + 1
        print(f"card: {width}x{height} aspect {width / height:.4f}")
    print(f"card changes: {len(card_changes)} {card_changes[:6]}")
    if shifts:
        moves = [abs(step) for step in shifts]
        moves.sort()
        median = moves[len(moves) // 2]
        print(f"moves: {len(moves)} frames, median {median} px, smallest {moves[0]}, largest {moves[-1]}")
        # A recording repeats frames when it runs slower than the app. Those are not
        # stalls. Compare the pixels of consecutive frames to tell the two apart.
        identical = 0
        real = []
        previous_bytes = None
        for name, step, result in steps:
            if result:
                with open(os.path.join(FRAMES, name), "rb") as f:
                    data = f.read()
            else:
                data = None
            same = data is not None and data == previous_bytes
            previous_bytes = data
            if step == 0 and same:
                identical += 1
            elif step is not None and abs(step) < max(1, median / 3):
                real.append(name)
        print(f"  of the still frames, {identical} are repeated by the recorder")
        print(f"stalled frames (curve still while the finger moves): {len(real)} {real[:8]}")
        jumps = [name for name, step, _ in steps if step is not None and abs(step) > max(3, median * 3)]
        print(f"jumping frames (>{max(3, median * 3):.3f} px): {len(jumps)} {jumps[:8]}")
    if montage:
        ranked = []
        for name, step, result in steps:
            if result is None:
                continue
            box = result["box"]
            gaps = (box[0] - box0[0], box[1] - box0[1], box0[2] - box[2], box0[3] - box[3])
            ranked.append((max(gaps), name))
        ranked.sort(reverse=True)
        picks = [name for _, name in ranked[:6]]
        images = [Image.open(os.path.join(FRAMES, name)) for name in picks]
        width, height = images[0].size
        sheet = Image.new("RGB", (width * len(images), height), "black")
        for position, image in enumerate(images):
            sheet.paste(image, (position * width, 0))
        sheet.save(montage)
        print("montage:", montage, picks)


if __name__ == "__main__":
    main()
