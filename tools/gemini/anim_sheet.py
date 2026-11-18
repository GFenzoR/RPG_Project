"""Lays frames out on one labelled contact sheet, scaled up, to look at them with Read.

Ported from Ants of Neque's `tools/anim_sheet.py`. A frame that has not been
looked at is not done: `import_art.py` writes one of these beside every import
(`_preview.png`), and this command makes one of any folder of frames.

    python tools/gemini/anim_sheet.py <folder> --out sheet.png [--scale 4] [--wrap 8]

Frames are grouped into rows by their name: `walk_s_0.png`, `walk_s_1.png`... is
the row `walk_s`, in number order (ANI-4's `<acción>_<dir>_<n>`). Each row is
wrapped every `--wrap` frames, with its name at the left and each frame's number
under it, on a dark ground with a lighter checker inside each frame, so both the
silhouette and the transparent pixels read.
"""

from __future__ import annotations

import argparse
import os
import re
import sys

from PIL import Image, ImageDraw

LABEL = 12
GAP = 4
GUTTER = 72
INK = (230, 220, 200, 255)
PAPER = (24, 22, 26, 255)
CHECK = ((52, 50, 56, 255), (64, 62, 70, 255))
NAME = re.compile(r"^(?P<row>.+?)_?(?P<tick>\d+)\.png$")


def rows_of(folder: str) -> dict[str, list[tuple[int, str]]]:
    """The frames of a folder, grouped by row in name order."""
    rows: dict[str, list[tuple[int, str]]] = {}
    for name in sorted(os.listdir(folder)):
        found = NAME.match(name)
        if not found or name.startswith("_"):
            continue
        rows.setdefault(found["row"], []).append((int(found["tick"]), os.path.join(folder, name)))
    for frames in rows.values():
        frames.sort()
    return rows


def checker(size: tuple[int, int], cell: int) -> Image.Image:
    """A two-tone checker the size of a scaled frame."""
    board = Image.new("RGBA", size, CHECK[0])
    draw = ImageDraw.Draw(board)
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            if (x // cell + y // cell) % 2:
                draw.rectangle((x, y, x + cell - 1, y + cell - 1), fill=CHECK[1])
    return board


def sheet_size(lines: list[tuple[str, list]], tile: tuple[int, int]) -> tuple[int, int]:
    """The sheet's size for `lines` of tiles of size `tile`."""
    most = max((len(tiles) for _label, tiles in lines), default=0)
    return GUTTER + most * (tile[0] + GAP), max(len(lines), 1) * (tile[1] + LABEL + GAP)


def sheet_of(rows: list[tuple[str, list[Image.Image]]], scale: int = 4, wrap: int = 8) -> Image.Image:
    """The contact sheet of `rows` (a label and its frames each): frames scaled
    by `scale` with nearest-neighbour, `wrap` to a line."""
    lines: list[tuple[str, list[tuple[int, Image.Image]]]] = []
    for label, frames in rows:
        numbered = list(enumerate(frames))
        for start in range(0, max(len(numbered), 1), wrap):
            lines.append((label if start == 0 else "", numbered[start : start + wrap]))
    side_w = max((f.width for _l, tiles in lines for _n, f in tiles), default=1) * scale
    side_h = max((f.height for _l, tiles in lines for _n, f in tiles), default=1) * scale
    sheet = Image.new("RGBA", sheet_size(lines, (side_w, side_h)), PAPER)
    draw = ImageDraw.Draw(sheet)
    y = 0
    for label, tiles in lines:
        draw.text((4, y + side_h // 2 - 6), label[:11], fill=INK)
        for index, (number, frame) in enumerate(tiles):
            x = GUTTER + index * (side_w + GAP)
            big = frame.convert("RGBA").resize((frame.width * scale, frame.height * scale), Image.Resampling.NEAREST)
            ground = checker((side_w, side_h), max(scale * 4, 4))
            ground.alpha_composite(big, (0, side_h - big.height))
            sheet.paste(ground, (x, y))
            draw.text((x + 2, y + side_h + 1), "%d" % number, fill=INK)
        y += side_h + LABEL + GAP
    return sheet


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("folder")
    parser.add_argument("--out", required=True)
    parser.add_argument("--scale", type=int, default=4)
    parser.add_argument("--wrap", type=int, default=8)
    args = parser.parse_args()
    rows = [(row, [Image.open(path) for _tick, path in frames]) for row, frames in rows_of(args.folder).items()]
    if not rows:
        raise SystemExit("no frames named <row>_<n>.png in %s" % args.folder)
    sheet_of(rows, args.scale, args.wrap).save(args.out)
    print("wrote %s: %d rows" % (args.out, len(rows)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
