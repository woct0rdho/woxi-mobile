"""Per-frame continuity of a 3D plot gesture, from a screen recording.

A rotation, pan or zoom is only smooth if every frame moves the picture by about the same
small amount. This crops the plot card on every frame of the video, and measures how much
each frame differs from the one before (the mean absolute pixel difference inside the card,
and the count of pixels that changed). A frame that is identical to its predecessor while its
neighbours move is a stall. A frame whose change is far larger than its neighbours' is a jump.
The card's background box is measured too, so a card that moved or resized during the gesture
is reported: the card must stay fixed.

Usage: python tools/check-3d-frames.py <video> --card x0,y0,x1,y1 [--from S] [--to S]
       [--stall N] [--jump R] [--montage PATH]
`--card` is in video pixels. `--stall N` flags a frame whose changed-pixel count is below N
while both neighbours are above 4N (default 40). `--jump R` flags a frame whose change is more
than R times the median of the moving frames (default 4).
"""

import argparse
import os
import shutil
import subprocess
import sys

from PIL import Image, ImageChops, ImageStat


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


def extract_frames(video, out_dir, start=None, end=None):
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)
    cmd = [ffmpeg_path(), "-loglevel", "quiet", "-i", video]
    if start is not None:
        cmd += ["-ss", str(start)]
    if end is not None:
        cmd += ["-to", str(end)]
    cmd += ["-fps_mode", "passthrough", os.path.join(out_dir, "%05d.png")]
    subprocess.run(cmd, check=True)
    if not os.listdir(out_dir):
        raise SystemExit(f"ffmpeg extracted no frames from {video}")
    return sorted(os.listdir(out_dir))


def card_box(crop, background, tolerance=6):
    """The box the card's background fills inside the crop. The crop is the card itself
    (give or take a few pixels), so this is the extent of the rows and columns that are
    mostly the card's colour. The plot ink in the middle does not matter."""
    width, height = crop.size
    pixels = crop.load()

    def row_is_card(y):
        return sum(1 for x in range(0, width, 8) if all(abs(pixels[x, y][i] - background[i]) <= tolerance for i in range(3))) > (width // 8) // 2

    def col_is_card(x):
        return sum(1 for y in range(0, height, 8) if all(abs(pixels[x, y][i] - background[i]) <= tolerance for i in range(3))) > (height // 8) // 2

    y0 = 0
    while y0 < height and not row_is_card(y0):
        y0 += 1
    y1 = height - 1
    while y1 > 0 and not row_is_card(y1):
        y1 -= 1
    x0 = 0
    while x0 < width and not col_is_card(x0):
        x0 += 1
    x1 = width - 1
    while x1 > 0 and not col_is_card(x1):
        x1 -= 1
    return (x0, y0, x1, y1)


def gray_box(image, top=0):
    """The box of the gray ink (box edges and tick labels) below row `top`, or None."""
    pixels = image.load()
    width, height = image.size
    x0, y0, x1, y1 = width, height, -1, -1
    for y in range(top, height, 2):
        for x in range(0, width, 2):
            r, g, b = pixels[x, y][:3]
            # Gray: its channels agree and it is clearly brighter than the card.
            if abs(r - g) < 14 and abs(g - b) < 14 and r > 70:
                x0 = min(x0, x)
                y0 = min(y0, y)
                x1 = max(x1, x)
                y1 = max(y1, y)
    if x1 < 0:
        return (0, 0, 0, 0)
    return (x0, y0, x1, y1)


def modal_color(image):
    pixels = image.load()
    counts = {}
    for y in range(0, image.size[1], 4):
        for x in range(0, image.size[0], 4):
            color = pixels[x, y][:3]
            counts[color] = counts.get(color, 0) + 1
    return max(counts, key=counts.get)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("video")
    parser.add_argument("--card", required=True, help="x0,y0,x1,y1 in video pixels")
    parser.add_argument("--from", dest="t0", type=float, default=None)
    parser.add_argument("--to", dest="t1", type=float, default=None)
    parser.add_argument("--stall", type=int, default=40)
    parser.add_argument("--jump", type=float, default=4.0)
    parser.add_argument("--montage", default=None)
    args = parser.parse_args()

    card = tuple(int(v) for v in args.card.split(","))
    frames_dir = os.path.join(os.environ.get("TEMP", "."), "p3d", "frames")
    names = extract_frames(args.video, frames_dir, args.t0, args.t1)
    if len(names) < 2:
        raise SystemExit(f"{len(names)} frames: the gesture changed nothing")

    crops = []
    for name in names:
        image = Image.open(os.path.join(frames_dir, name)).convert("RGB")
        crops.append(image.crop(card))
    background = modal_color(crops[0])

    rows = []
    previous = None
    for index, crop in enumerate(crops):
        box = card_box(crop, background)
        # The tick labels and the box edges are gray. The surface is yellow. Their box
        # per frame shows an axis edge flipping from one side of the box to the other.
        gray = gray_box(crop)
        if previous is None:
            rows.append((index, 0.0, 0, box, gray))
        else:
            diff = ImageChops.difference(crop, previous).convert("L")
            stat = ImageStat.Stat(diff)
            mean = stat.mean[0]
            changed = sum(1 for v in diff.get_flattened_data() if v > 24) if hasattr(diff, "get_flattened_data") else sum(1 for v in diff.getdata() if v > 24)
            rows.append((index, mean, changed, box, gray))
        previous = crop

    print(f"{len(names)} frames from {args.video}, card {card}, background {background}")
    boxes = {row[3] for row in rows}
    if len(boxes) > 1:
        print(f"CARD CHANGED during the gesture: {sorted(boxes)}")
    else:
        print(f"card fixed: {rows[0][3]}")

    # The gray ink (box edges and labels) must move continuously: its left and right
    # edges stepping by more than a share of the card in one frame, while the frame
    # before and after stepped little, is an axis edge or a label flipping sides.
    lefts = [row[4][0] for row in rows]
    rights = [row[4][2] for row in rows]
    flips = []
    for i in range(2, len(rows) - 1):
        step = abs(lefts[i] - lefts[i - 1]) + abs(rights[i] - rights[i - 1])
        before = abs(lefts[i - 1] - lefts[i - 2]) + abs(rights[i - 1] - rights[i - 2])
        after = abs(lefts[i + 1] - lefts[i]) + abs(rights[i + 1] - rights[i])
        if step > 40 and before < step / 3 and after < step / 3:
            flips.append((i, step))
    if flips:
        print(f"GRAY INK JUMPS (an edge or label changed side in one frame): {flips[:12]}")
    else:
        print("gray ink: no single-frame side flips")

    moving = [row for row in rows[1:] if row[2] >= args.stall]
    if moving:
        changes = sorted(row[2] for row in moving)
        median = changes[len(changes) // 2]
        print(f"moving frames: {len(moving)}, changed pixels median {median}, min {changes[0]}, max {changes[-1]}")

    stalls = []
    jumps = []
    # The emulator's recorder repeats a frame when it captures nothing new (a frame with
    # no change at all, mean ~ 0): that is the recorder, not the plot. A stall is a frame
    # that changed far less than its neighbours while they moved.
    repeats = []
    for i in range(1, len(rows) - 1):
        _, mean, changed, _, _ = rows[i]
        before = rows[i - 1][2]
        after = rows[i + 1][2]
        if changed == 0:
            repeats.append(i)
            continue
        if changed < args.stall and before >= 4 * args.stall and after >= 4 * args.stall:
            stalls.append(i)
        if moving and changed > args.jump * max(1, median) and changed > 4 * args.stall:
            jumps.append(i)

    print(f"{'frame':>6} {'mean':>7} {'changed':>8}  card          gray ink")
    for index, mean, changed, box, gray in rows:
        flag = ""
        if index in stalls:
            flag = "  <-- stall"
        if index in jumps:
            flag += "  <-- JUMP"
        if index in repeats:
            flag += "  (recorder repeat)"
        print(f"{index:>6} {mean:7.3f} {changed:>8}  {box}  {gray}{flag}")
    print(f"stalls (still while both neighbours move): {len(stalls)} {stalls[:12]}")
    print(f"jumps (>{args.jump}x median change): {len(jumps)} {jumps[:12]}")
    print(f"recorder repeats (identical frame): {len(repeats)}")

    if args.montage:
        worst = sorted(set(stalls[:6] + jumps[:6] + [0, len(rows) - 1]))
        tiles = []
        for index in worst:
            tile = crops[index].copy()
            tiles.append((index, tile))
        if tiles:
            width = sum(tile.width for _, tile in tiles) + 8 * len(tiles)
            height = max(tile.height for _, tile in tiles) + 24
            sheet = Image.new("RGB", (width, height), (255, 255, 255))
            x = 4
            from PIL import ImageDraw

            draw = ImageDraw.Draw(sheet)
            for index, tile in tiles:
                sheet.paste(tile, (x, 20))
                draw.text((x, 2), f"#{index}", fill=(0, 0, 0))
                x += tile.width + 8
            sheet.save(args.montage)
            print(f"montage: {args.montage}")


if __name__ == "__main__":
    main()
