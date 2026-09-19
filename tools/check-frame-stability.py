"""Measures, frame by frame, whether a plot's frame moves during a gesture.

The plot card sits between the entry row and the keyboard. Inside it the two
frame lines are the only long, grey, straight runs: the curve is coloured, the
tick labels are outside, and the tick marks are short. So each frame gives two
numbers - the column of the y axis and the row of the x axis - and a smooth
gesture means both are constant.

Usage: python tools/check-frame-stability.py <video> [every_nth_frame]
"""
import os
import subprocess
import sys
from collections import Counter

from PIL import Image

FFMPEG = r'C:\ffmpeg\bin\ffmpeg.exe'
FRAMES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'screenshots', 'frames')

# Where the plot card is, in screen pixels (1080x2400). Generous on purpose: the
# search bands below are what actually isolate the axes.
CARD = (100, 560, 1000, 1250)


def grey(pixel):
    r, g, b = pixel
    return abs(r - g) < 14 and abs(g - b) < 14 and 70 <= g <= 200


def axes(path):
    image = Image.open(path).convert('RGB')
    # Quarter resolution is plenty for a line position and keeps this fast.
    small = image.resize((image.width // 4, image.height // 4))
    width, height = small.size
    pixels = small.load()
    x0, y0, x1, y1 = (value // 4 for value in CARD)

    columns = [0] * width
    rows = [0] * height
    for y in range(y0, y1):
        for x in range(x0, x1):
            if grey(pixels[x, y]):
                columns[x] += 1
                rows[y] += 1

    # The y axis is the tallest vertical grey run. The x axis the widest horizontal
    # one. Both are inside the card, and both are much longer than a tick mark.
    y_axis = max(range(x0, x1), key=lambda x: columns[x])
    x_axis = max(range(y0, y1), key=lambda y: rows[y])
    return y_axis * 4, x_axis * 4, columns[y_axis], rows[x_axis]


def main():
    video = sys.argv[1]
    step = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    if os.path.isdir(FRAMES):
        for name in os.listdir(FRAMES):
            os.remove(os.path.join(FRAMES, name))
    else:
        os.makedirs(FRAMES)

    subprocess.run(
        [FFMPEG, '-loglevel', 'error', '-i', video, '-fps_mode', 'passthrough',
         os.path.join(FRAMES, 'f%05d.png')],
        check=True,
    )
    names = sorted(os.listdir(FRAMES))[::step]
    print(f'{len(names)} frames sampled from {video}')

    samples = []
    for name in names:
        y_axis, x_axis, column_mass, row_mass = axes(os.path.join(FRAMES, name))
        samples.append((name, y_axis, x_axis, column_mass, row_mass))

    ys = Counter(sample[1] for sample in samples)
    xs = Counter(sample[2] for sample in samples)
    print('y-axis column values:', ys.most_common(6))
    print('x-axis row values:   ', xs.most_common(6))

    deltas = [
        max(abs(samples[i][1] - samples[i - 1][1]), abs(samples[i][2] - samples[i - 1][2]))
        for i in range(1, len(samples))
    ]
    print(f'largest single-frame move: {max(deltas)} px')

    base_y, base_x = samples[0][1], samples[0][2]
    jumps = [(name, y, x) for name, y, x, _, _ in samples if abs(y - base_y) > 2 or abs(x - base_x) > 2]
    print(f'frame position: first=({base_y},{base_x})  distinct columns={len(ys)}  distinct rows={len(xs)}')
    if jumps:
        print(f'{len(jumps)} of {len(samples)} frames differ by more than 2 px:')
        for name, y, x in jumps[:20]:
            print(f'  {name}: axis at ({y},{x})')
    else:
        print('every sampled frame has the frame in the same place')


if __name__ == '__main__':
    main()
