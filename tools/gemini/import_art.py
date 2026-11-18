"""Turns a sheet Gemini drew into frames on our pixel grid, palette and values.

An illustration is not a sprite: what arrives is a thousand pixels wide with
tens of thousands of colours; what the game draws is a 32x32 frame (64x64 for a
person) with a couple of dozen, its alpha 0 or 255 (docs/17 ART-2, ART-6). Ported
in spirit from Ants of Neque's `tools/import_art.py`, with the passes this game
asked for:

1. **The background keyed out** (`key`): the magenta Gemini is told to draw on
   (`gemini_web.HOUSE_RULES`), keyed **by hue** (red and blue well above green)
   so the anti-aliased blend around a drawing goes too, or the alpha the sheet
   already has. Then the pink fringe is repaired, not cut (`unfringe`): a
   blended pixel is a real edge wearing the wrong colour, and cutting it eats
   the one-pixel legs and tips that make a creature read. **The hue key takes
   every violet and pink too** (red and blue above green is what they are), so
   the house rules forbid those hues in a subject; a violet subject comes on
   its own alpha (`--key alpha`) or not at all.
2. **The grid cut into frames** (`cells`), in reading order. A sheet does not
   always come back in the shape asked for, so every grid with the same number
   of cells is scored by how much drawing its cut lines go through
   (`seam_cost`); a better one is reported, and taken with `--auto-grid`. A
   creature sheet comes back on no even grid at all (rows of 7 over rows of 6,
   two panels side by side): `--cut rows` takes its rows as drawn
   (`row_cells`) and `--cut blobs` every separate drawing (`blob_cells`), and
   the drawings, numbered in `_drawings.png`, are named one by one (`--names`,
   `-` for one not kept, `a+b` for one kept as two frames).
3. **Fitted and downscaled with nearest-neighbour** (`downscale`) onto the
   frame: one box for every frame of an animation (`--fit union`), so the
   frames keep their registration and the feet stay on one line; anchored at
   the bottom centre (ART-2) or the centre. Nearest, sampling the centre of
   each source block: a pixel-art drawing comes back as its own pixels, never
   as a blur of them.
4. **Palette and values** (`to_palette`): optionally reduced to `--colors` first
   (median cut, so noise does not buy colours), then every colour moved into
   its layer's ART-6 band of L* (and chroma, for ground) and snapped to the
   nearest colour of the spritegen palette (`tools/spritegen/src/palette.ts`,
   read from the file: one source of truth) inside that band; on the layers
   that take one (`OUTLINED`: not ground, not effect), a pixel darker than the
   band is an outline (ART-5) and takes spritegen's nearest outline.
5. **1-bit alpha** (`binary_alpha`): 0 or 255, the rule of every sprite.

    python tools/gemini/import_art.py <sheet.png> --grid 4x2 --size 32 --layer creature
        [--names walk_s_0,...|--prefix walk_s] [--out-dir build/gemini/import/<stem>]
        [--key auto|magenta|alpha] [--fit union|each|none] [--anchor bottom|center]
        [--margin 1] [--colors 24] [--no-palette] [--auto-grid]
    python tools/gemini/import_art.py <sheet.png> --cut rows|blobs --size 64 --names "walk_s_0,-,..."
        [--mirror walk_w_0,...] [--shared-colours] [--scale 4.6]

It writes the frames, `_preview.png` (a 4x contact sheet: look at it with Read)
and `import.json` (settings, the source's digest, the prompt from the Gemini
sidecar beside the sheet, warnings, each frame's L* range). Never into
`assets/`: a frame reaches the game when someone has looked at it and copied
it there with its prompt file and its `CREDITS.md` row (`credit.py`).
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import os
import re
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import anim_sheet  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PALETTE_TS = os.path.join(ROOT, "tools", "spritegen", "src", "palette.ts")
OUT_DIR = os.path.join(ROOT, "build", "gemini", "import")

## How far red and blue must stand above green for a pixel to be the key. A
## fixed distance around #FF00FF leaves a pink halo (the blend is nowhere near
## pure magenta); the hue test takes the whole blend and no brown.
KEY_MARGIN = 40
## How far a surviving pixel may still lean to the key before it is fringe.
FRINGE_MARGIN = 12
## A cell covered past this share by its drawing, or this share by one flat
## colour, was drawn on no key or the wrong one (a green or tan ground passed
## the magenta pass untouched in Ants of Neque, 2026-08-31 and 2026-09-01).
MOST_OF_A_CELL = 0.90
FLAT_FIELD_SHARE = 0.35
## How much worse the stated grid may cut than the best one of the same number
## of cells before it is called the wrong grid.
GRID_TOLERANCE = 2.0

## docs/17 ART-6: the L* band of each layer, and the chroma cap where there is
## one (ground: low to medium, C* <= 35).
BANDS: dict[str, tuple[float, float, float | None]] = {
    "ground": (20.0, 50.0, 35.0),
    "wall": (25.0, 65.0, None),
    "object": (25.0, 65.0, None),
    "creature": (10.0, 85.0, None),
    "character": (10.0, 85.0, None),
    "effect": (60.0, 100.0, None),
}
## The layers that take an outline (docs/17 ART-5: creatures and characters
## one dark pixel, objects a softer one, walls as objects). **Ground has none**
## ("suelos: sin contorno") and an effect lives at L* 60-100: on those the
## darkest pixels are clamped into the band like the rest, never turned into
## an outline (an orange spark at L* 58 came out at L* 15 that way).
OUTLINED = ("creature", "character", "object", "wall")
## Colours a frame may keep before the palette snap. Ants of Neque measured
## that a body under ~16 loses its shading and ground past ~12 reads as noise;
## here the snap to spritegen's ramps comes after, and on the first real sheet
## (a lever, 2026-11-18) 16 colours snapped into speckle where 8-10 read clean.
COLOURS = {"ground": 8, "wall": 10, "object": 10, "creature": 16, "character": 16, "effect": 8}


# --- colour ------------------------------------------------------------------------------


## How much darker than its deep shade a material's outline is (`material`
## in palette.ts: `darken(deep, 0.45)`).
OUTLINE_DARKEN = 0.45


def darkened(colour: tuple[int, ...], amount: float = OUTLINE_DARKEN) -> tuple[int, int, int]:
    """palette.ts's `darken`, to the bit: each channel times `1 - amount`
    (computed as it is there, not as 0.55, whose float differs) rounded half
    up as `Math.round` does. Python's `round` goes to the even integer, and on
    the halves (70 x 0.55 is 38.5) it gave outlines spritegen never draws."""
    k = 1 - amount
    return tuple(js_round(c * k) for c in colour[:3])  # type: ignore[return-value]


def js_round(x: float) -> int:
    """JavaScript's `Math.round`: the nearest integer, a half going up."""
    whole = math.floor(x)
    return whole + 1 if x - whole >= 0.5 else whole


def parse_palette(text: str) -> list[tuple[int, int, int]]:
    """The colours of spritegen's `palette.ts`: the four shades of every
    `material(...)` and its outline (the deep shade 45% darker, as `material`
    computes it), each once, in file order."""
    found: list[tuple[int, int, int]] = []
    for match in re.finditer(r'material\(\s*"(#[0-9a-fA-F]{6})",\s*"(#[0-9a-fA-F]{6})",\s*"(#[0-9a-fA-F]{6})",\s*"(#[0-9a-fA-F]{6})"\s*\)', text):
        shades = [tuple(int(h[i : i + 2], 16) for i in (1, 3, 5)) for h in match.groups()]
        outline = darkened(shades[3])
        for colour in shades + [outline]:
            if colour not in found:
                found.append(colour)  # type: ignore[arg-type]
    return found


def outline_colours(text: str) -> list[tuple[int, int, int]]:
    """Only the outlines of `palette.ts`'s materials (the fifth colour of each)."""
    shades = parse_palette(text)
    found = []
    for match in re.finditer(r'material\(\s*"#[0-9a-fA-F]{6}",\s*"#[0-9a-fA-F]{6}",\s*"#[0-9a-fA-F]{6}",\s*"(#[0-9a-fA-F]{6})"\s*\)', text):
        h = match.group(1)
        outline = darkened(tuple(int(h[i : i + 2], 16) for i in (1, 3, 5)))
        if outline in shades and outline not in found:
            found.append(outline)
    return found


def load_palette(path: str = PALETTE_TS) -> list[tuple[int, int, int]]:
    with open(path, encoding="utf-8") as handle:
        colours = parse_palette(handle.read())
    if not colours:
        raise SystemExit("no material() colours in %s" % path)
    return colours


def load_outlines(path: str = PALETTE_TS) -> list[tuple[int, int, int]]:
    with open(path, encoding="utf-8") as handle:
        return outline_colours(handle.read())


def _linear(channel: int) -> float:
    c = channel / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    """CIELAB (D65) of an sRGB colour."""
    r, g, b = (_linear(c) for c in rgb[:3])
    x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883

    def f(t: float) -> float:
        return t ** (1.0 / 3.0) if t > 216.0 / 24389.0 else (24389.0 / 27.0 * t + 16.0) / 116.0

    fx, fy, fz = f(x), f(y), f(z)
    return 116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)


def banded(target: tuple[float, float, float], band: tuple[float, float, float | None]) -> tuple[float, float, float]:
    """`target` (Lab) with its L* clamped into the band and its chroma capped."""
    low, high, cap = band
    lightness, a, b = target
    lightness = min(max(lightness, low), high)
    chroma = math.hypot(a, b)
    if cap is not None and chroma > cap:
        a, b = a * cap / chroma, b * cap / chroma
    return lightness, a, b


def in_band(colour_lab: tuple[float, float, float], band: tuple[float, float, float | None]) -> bool:
    low, high, cap = band
    return low <= colour_lab[0] <= high and (cap is None or math.hypot(colour_lab[1], colour_lab[2]) <= cap + 1e-6)


class Snapper:
    """Maps a colour to the nearest palette colour (ΔE76) inside a layer's
    band, after moving it into the band; the whole palette when no palette
    colour lies in the band.

    **The outline is not a material** (ART-5: one dark pixel of the local
    colour around a shape). ART-6's bands are the values of the surfaces, and
    clamping the outline into them washes it out (the first real sheet, a
    lever, lost its edge at L* 25). So a pixel darker than the band's floor
    goes to the nearest of spritegen's outline colours (`outlines`) instead."""

    def __init__(self, palette: list[tuple[int, int, int]], band: tuple[float, float, float | None],
                 outlines: list[tuple[int, int, int]] | None = None):
        self.band = band
        allowed = [c for c in palette if in_band(lab(c), band)]
        self.choices = [(c, lab(c)) for c in (allowed or palette)]
        self.outlines = [(c, lab(c)) for c in (outlines or [])]
        self.cache: dict[tuple[int, int, int], tuple[int, int, int]] = {}

    def __call__(self, rgb: tuple[int, int, int]) -> tuple[int, int, int]:
        hit = self.cache.get(rgb)
        if hit is None:
            own = lab(rgb)
            if self.outlines and own[0] < self.band[0]:
                hit = min(self.outlines, key=lambda choice: sum((p - q) ** 2 for p, q in zip(choice[1], own)))[0]
            else:
                want = banded(own, self.band)
                hit = min(self.choices, key=lambda choice: sum((p - q) ** 2 for p, q in zip(choice[1], want)))[0]
            self.cache[rgb] = hit
        return hit


# --- the passes ----------------------------------------------------------------------------


def pixels(im: Image.Image) -> list:
    """Every pixel in reading order. `get_flattened_data` since Pillow 12, where
    `getdata` is deprecated; `getdata` before it."""
    flat = getattr(im, "get_flattened_data", None)
    return list(flat() if flat else im.getdata())


def has_alpha(im: Image.Image) -> bool:
    """Whether the image already says what is background (any pixel not opaque)."""
    if im.mode not in ("RGBA", "LA", "PA") and "transparency" not in im.info:
        return False
    low, _high = im.convert("RGBA").getchannel("A").getextrema()
    return low < 255


def key(im: Image.Image, mode: str = "auto", margin: int = KEY_MARGIN) -> Image.Image:
    """The background removed: `magenta` keys by hue, `alpha` trusts the
    alpha the sheet brings, `auto` takes the alpha when there is any and the
    magenta otherwise. Keyed pixels keep their colour under alpha 0."""
    rgba = im.convert("RGBA")
    if mode == "alpha" or (mode == "auto" and has_alpha(im)):
        return rgba
    data = list(pixels(rgba))
    rgba.putdata([(r, g, b, 0) if min(r, b) - g > margin else (r, g, b, a) for r, g, b, a in data])
    return rgba


def keyed_sheet(source: Image.Image, mode: str = "auto") -> tuple[Image.Image, str]:
    """The sheet with its background removed, and which key did it. **A sheet
    that brings its own alpha is neither keyed nor unfringed**: the hue test
    takes every violet (red and blue above green is what a violet is), and a
    lavender spider came back a husk that way in Ants of Neque (2026-09-05)."""
    if mode == "alpha" or (mode == "auto" and has_alpha(source)):
        return key(source, "alpha"), "alpha"
    return unfringe(key(source, "magenta")), "magenta"


def unfringe(im: Image.Image, margin: int = FRINGE_MARGIN) -> Image.Image:
    """The ring where the drawing was blended into the key, repaired: each
    pixel still leaning to magenta takes the mean colour of its neighbours
    that do not, three passes deep; what still leans after that had no honest
    neighbour and goes."""
    im = im.copy()
    px = im.load()

    def leans(x: int, y: int) -> bool:
        r, g, b, a = px[x, y]
        return a > 0 and min(r, b) - g > margin

    for _pass in range(3):
        fringe = [(x, y) for y in range(im.height) for x in range(im.width) if leans(x, y)]
        if not fringe:
            break
        for x, y in fringe:
            honest = []
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < im.width and 0 <= ny < im.height and px[nx, ny][3] > 0 and not leans(nx, ny):
                        honest.append(px[nx, ny])
            if honest:
                px[x, y] = (
                    sum(c[0] for c in honest) // len(honest),
                    sum(c[1] for c in honest) // len(honest),
                    sum(c[2] for c in honest) // len(honest),
                    px[x, y][3],
                )
    for y in range(im.height):
        for x in range(im.width):
            if leans(x, y):
                px[x, y] = (0, 0, 0, 0)
    return im


def cells(im: Image.Image, columns: int, rows: int) -> list[Image.Image]:
    """The sheet cut into an even grid, in reading order."""
    wide, tall = im.width / columns, im.height / rows
    out = []
    for row in range(rows):
        for column in range(columns):
            box = (round(column * wide), round(row * tall), round((column + 1) * wide), round((row + 1) * tall))
            out.append(im.crop(box))
    return out


def seam_cost(sheet: Image.Image, columns: int, rows: int) -> float:
    """How much drawing a grid of this shape would cut through: the mean alpha
    along its cut lines (±1 px), 0 when every line runs through background."""
    alpha = sheet.getchannel("A")
    across = alpha.resize((alpha.width, 1), Image.Resampling.BOX)
    down = alpha.resize((1, alpha.height), Image.Resampling.BOX)
    cost = 0.0
    for k in range(1, columns):
        x = int(alpha.width * k / columns)
        cost += max(across.getpixel((min(max(x + d, 0), alpha.width - 1), 0)) for d in (-1, 0, 1))
    for k in range(1, rows):
        y = int(alpha.height * k / rows)
        cost += max(down.getpixel((0, min(max(y + d, 0), alpha.height - 1))) for d in (-1, 0, 1))
    return cost / max(columns - 1 + rows - 1, 1)


def best_grid(sheet: Image.Image, columns: int, rows: int) -> tuple[tuple[int, int], float, float]:
    """Of the grids with as many cells as the stated one, the one whose lines
    cut the least drawing; with the stated grid's cost and the best's."""
    count = columns * rows
    stated = seam_cost(sheet, columns, rows)
    best, lowest = (columns, rows), stated
    for wide in range(1, count + 1):
        if count % wide:
            continue
        tall = count // wide
        here = seam_cost(sheet, wide, tall)
        if here < lowest:
            best, lowest = (wide, tall), here
    return best, stated, lowest


## `--cut rows`: the least run of empty pixel rows that parts two rows of
## drawings, and of empty columns that parts two drawings of a row (a gap under
## it is a tail tip or an ear that came loose, and stays with its drawing); and
## how many opaque pixels a drawing needs not to be a stray speck.
ROW_GAP = 6
COLUMN_GAP = 3
SPECK = 60


def spans(profile: list[int], gap: int, least: int) -> list[tuple[int, int]]:
    """The runs `[start, end)` where `profile` is above zero, a run joined to
    the next across an empty stretch shorter than `gap`, and a run whose sum
    is under `least` dropped."""
    found: list[list[int]] = []
    for at, count in enumerate(profile):
        if count <= 0:
            continue
        if found and at - found[-1][1] < gap:
            found[-1][1] = at + 1
            found[-1][2] += count
        else:
            found.append([at, at + 1, count])
    return [(start, end) for start, end, total in found if total >= least]


def _opaque_mask(sheet: Image.Image) -> tuple[list[int], int, int]:
    alpha = sheet.getchannel("A")
    return [1 if a >= 128 else 0 for a in pixels(alpha)], sheet.width, sheet.height


## A drawing of a row: the box it is cut with (sheet coordinates; it may run
## past the sheet's edge, where it is transparent) and the columns that are its
## own (`[x0, x1)`): whatever of a neighbour reaches into the box is cleared.
Cell = tuple[tuple[int, int, int, int], tuple[int, int]]


def row_cells(sheet: Image.Image, gap: int = ROW_GAP, column_gap: int = COLUMN_GAP,
              least: int = SPECK) -> tuple[list[list[Cell]], list[str]]:
    """The drawings of a keyed sheet laid out in rows, however many there are
    in each: a sheet does not come back on the even grid it was asked for
    (Gemini drew rows of 7 over rows of 6 on the first creature, 2026-11-18),
    but it keeps its rows, and a row's frames on even cells. Returns, row by
    row, each drawing's `Cell`: when every drawing's middle falls in its own
    even share of the sheet's width, the box is that share (so a row keeps the
    registration it was drawn with), widened on both sides by as much as the
    row's widest overhang so that no drawing is cut and every box of the row
    keeps one origin; else the drawing's own span (with a warning). Plus the
    warnings."""
    mask, wide, tall = _opaque_mask(sheet)
    across = [sum(mask[y * wide : (y + 1) * wide]) for y in range(tall)]
    rows: list[list[Cell]] = []
    warnings: list[str] = []
    for top, bottom in spans(across, gap, least):
        down = [0] * wide
        for y in range(top, bottom):
            line = mask[y * wide : (y + 1) * wide]
            for x in range(wide):
                down[x] += line[x]
        found = spans(down, column_gap, least)
        if not found:
            continue
        share = wide / len(found)
        even = [int(((start + end) / 2) // share) for start, end in found] == list(range(len(found)))
        if even:
            shares = [(round(i * share), round((i + 1) * share)) for i in range(len(found))]
            over = max(max(left - start, end - right, 0) for (left, right), (start, end) in zip(shares, found))
            rows.append([((left - over, top, right + over, bottom), span) for (left, right), span in zip(shares, found)])
        else:
            warnings.append("row %d: its %d drawings are not on even cells; each is aligned by its own box"
                            % (len(rows) + 1, len(found)))
            rows.append([((start, top, end, bottom), (start, end)) for start, end in found])
    return rows, warnings


def cell_image(sheet: Image.Image, cell: Cell) -> Image.Image:
    """The cell's box cut out of the sheet with only its own drawing's columns."""
    box, (own_left, own_right) = cell
    part = sheet.crop(box)
    left, right = own_left - box[0], own_right - box[0]
    if left > 0:
        part.paste((0, 0, 0, 0), (0, 0, left, part.height))
    if right < part.width:
        part.paste((0, 0, 0, 0), (right, 0, part.width, part.height))
    return part


## `--cut blobs`: the side of the blocks a sheet is labelled on (a drawing's
## parts closer than this join), and how big a part must be, against the
## median drawing, to be a drawing of its own rather than a loose tail tip, a
## whisker or a motion mark that goes with its nearest drawing.
BLOB_BLOCK = 3
BLOB_SHARE = 0.15


def blob_cells(sheet: Image.Image, block: int = BLOB_BLOCK, share: float = BLOB_SHARE,
               least: int = SPECK) -> tuple[list[Image.Image], list[tuple[int, int, int, int]], list[str]]:
    """Every separate drawing of a keyed sheet, whatever the layout (Gemini
    put a creature's rows in two panels side by side, 2026-11-18): the opaque
    pixels labelled in `block`-sided blocks (8-connected), a part under
    `share` of the median drawing joined to the nearest drawing, specks under
    `least` pixels dropped. In reading order (rows by their middles, then
    left to right); each drawing cut to its own box with only its own pixels,
    and that box in sheet coordinates. Each one keeps the registration of its
    own box, nothing more."""
    alpha = sheet.getchannel("A")
    wide, tall = (sheet.width + block - 1) // block, (sheet.height + block - 1) // block
    small = alpha.point(lambda a: 255 if a >= 128 else 0).resize((wide, tall), Image.Resampling.BOX)
    on = [v > 0 for v in pixels(small)]
    label = [0] * (wide * tall)
    parts: list[dict] = []
    for start in range(wide * tall):
        if not on[start] or label[start]:
            continue
        number = len(parts) + 1
        label[start] = number
        stack, members = [start], []
        while stack:
            at = stack.pop()
            members.append(at)
            x, y = at % wide, at // wide
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < wide and 0 <= ny < tall:
                        near = ny * wide + nx
                        if on[near] and not label[near]:
                            label[near] = number
                            stack.append(near)
        xs, ys = [m % wide for m in members], [m // wide for m in members]
        parts.append({"labels": {number}, "size": len(members),
                      "box": [min(xs), min(ys), max(xs) + 1, max(ys) + 1]})
    if not parts:
        return [], [], []
    sizes = sorted(p["size"] for p in parts)
    median = sizes[len(sizes) // 2]
    big = [p for p in parts if p["size"] >= share * median]
    for part in parts:
        if part in big:
            continue
        def distance(other: dict) -> float:
            a, b = part["box"], other["box"]
            dx = max(b[0] - a[2], a[0] - b[2], 0)
            dy = max(b[1] - a[3], a[1] - b[3], 0)
            return math.hypot(dx, dy)
        nearest = min(big, key=distance)
        nearest["labels"] |= part["labels"]
        box = nearest["box"]
        nearest["box"] = [min(box[0], part["box"][0]), min(box[1], part["box"][1]),
                          max(box[2], part["box"][2]), max(box[3], part["box"][3])]
    heights = sorted(p["box"][3] - p["box"][1] for p in big)
    tall_one = heights[len(heights) // 2]
    big.sort(key=lambda p: (p["box"][1] + p["box"][3]) / 2)
    rows: list[list[dict]] = []
    for part in big:
        middle = (part["box"][1] + part["box"][3]) / 2
        if rows and middle - rows[-1][0]["middle"] < tall_one / 2:
            rows[-1].append(part)
        else:
            rows.append([part])
        part["middle"] = middle if len(rows[-1]) == 1 else rows[-1][0]["middle"]
    ordered = [part for row in rows for part in sorted(row, key=lambda p: p["box"][0])]
    out, boxes, warnings, src = [], [], [], sheet.load()
    for part in ordered:
        x0, y0 = part["box"][0] * block, part["box"][1] * block
        x1, y1 = min(part["box"][2] * block, sheet.width), min(part["box"][3] * block, sheet.height)
        cut = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
        dst = cut.load()
        count = 0
        for y in range(y0, y1):
            row = (y // block) * wide
            for x in range(x0, x1):
                if label[row + x // block] in part["labels"]:
                    pixel = src[x, y]
                    if pixel[3] >= 128:
                        count += 1
                    dst[x - x0, y - y0] = pixel
        if count < least:
            continue
        out.append(cut)
        boxes.append((x0, y0, x1, y1))
    return out, boxes, warnings


def numbered(sheet: Image.Image, boxes: list[tuple[int, int, int, int]], names: list[str]) -> Image.Image:
    """The keyed sheet on a dark ground with every drawing found boxed and
    numbered in reading order (and named, once named): what `--names` is
    written against under `--cut rows` or `blobs`."""
    from PIL import ImageDraw

    out = Image.new("RGBA", sheet.size, anim_sheet.PAPER)
    out.alpha_composite(sheet)
    pen = ImageDraw.Draw(out)
    for index, box in enumerate(boxes):
        pen.rectangle(box, outline=(90, 200, 120, 255))
        label = "%d %s" % (index, names[index]) if index < len(names) and not names[index].startswith("frame_") else str(index)
        pen.text((box[0] + 2, box[1] + 1), label, fill=anim_sheet.INK)
    return out


def massed(part: Image.Image, box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """`box` widened to be centred, across, on the mean column of the drawing's
    opaque pixels: a body stays put when a tail, a wing or a whip swings out
    (a box's own middle moves with them, and so would the body)."""
    alpha = part.getchannel("A")
    total = weighted = 0
    for x in range(box[0], box[2]):
        column = alpha.crop((x, box[1], x + 1, box[3])).histogram()
        count = sum(column[128:])
        total += count
        weighted += count * x
    if not total:
        return box
    middle = weighted / total + 0.5
    half = max(middle - box[0], box[2] - middle)
    return int(round(middle - half)), box[1], int(round(middle + half)), box[3]


def reduced_together(frames: list[Image.Image], colours: int) -> list[Image.Image]:
    """`reduced` over all the frames at once: one set of colours for the whole
    animation. Reduced one by one, a frame's median cut picks its own shades
    and the snap that follows can land them on neighbouring palette colours,
    so the coat flickers from frame to frame."""
    if not frames:
        return frames
    strip = Image.new("RGBA", (sum(f.width for f in frames), max(f.height for f in frames)), (0, 0, 0, 0))
    x = 0
    for frame in frames:
        strip.paste(frame, (x, 0))
        x += frame.width
    flat = reduced(strip, colours)
    out, x = [], 0
    for frame in frames:
        out.append(flat.crop((x, 0, x + frame.width, frame.height)))
        x += frame.width
    return out


def bbox_of(im: Image.Image) -> tuple[int, int, int, int] | None:
    """The box of the opaque pixels (alpha over half)."""
    return im.getchannel("A").point(lambda a: 255 if a >= 128 else 0).getbbox()


def union_box(frames: list[Image.Image]) -> tuple[int, int, int, int] | None:
    """One box holding the drawing of every frame (in cell coordinates)."""
    boxes = [box for box in (bbox_of(frame) for frame in frames) if box]
    if not boxes:
        return None
    return min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)


def scale_for(box: tuple[int, int, int, int], size: tuple[int, int], margin: int) -> float:
    """Source pixels per frame pixel to fit `box` inside `size` less `margin`
    on each side, never under 1 (a small drawing is not blown up into fat
    pixels)."""
    room_w, room_h = max(size[0] - 2 * margin, 1), max(size[1] - 2 * margin, 1)
    return max((box[2] - box[0]) / room_w, (box[3] - box[1]) / room_h, 1.0)


def downscale(cell: Image.Image, box: tuple[int, int, int, int], size: tuple[int, int], scale: float,
              anchor: str = "bottom", margin: int = 1) -> Image.Image:
    """The drawing inside `box` of `cell`, `scale` source pixels to one,
    nearest-neighbour from the centre of each source block, placed on a
    transparent frame of `size`: centred across, and at the bottom (less
    `margin`) or centred down. What falls outside the frame is cut."""
    wide = max(int(round((box[2] - box[0]) / scale)), 1)
    tall = max(int(round((box[3] - box[1]) / scale)), 1)
    src = cell.load()
    small = Image.new("RGBA", (wide, tall), (0, 0, 0, 0))
    out = small.load()
    for v in range(tall):
        sy = min(int(box[1] + (v + 0.5) * scale), box[3] - 1, cell.height - 1)
        for u in range(wide):
            sx = min(int(box[0] + (u + 0.5) * scale), box[2] - 1)
            # A box may reach past the cell (centred on a drawing's mass): that is nothing.
            if 0 <= sx < cell.width and sy >= 0:
                out[u, v] = src[sx, sy]
    frame = Image.new("RGBA", size, (0, 0, 0, 0))
    x = (size[0] - wide) // 2
    y = size[1] - margin - tall if anchor == "bottom" else (size[1] - tall) // 2
    frame.paste(small, (x, max(y, 0)))
    return frame


def binary_alpha(im: Image.Image, threshold: int = 128) -> Image.Image:
    """Alpha 0 or 255; a transparent pixel's colour is zeroed too."""
    out = im.convert("RGBA")
    out.putdata([(r, g, b, 255) if a >= threshold else (0, 0, 0, 0) for r, g, b, a in pixels(out)])
    return out


def reduced(im: Image.Image, colours: int) -> Image.Image:
    """At most `colours` colours among the opaque pixels (median cut), alpha
    kept. The ground under the drawing is filled with its commonest opaque
    colour first, so it buys no palette entries."""
    alpha = im.getchannel("A")
    opaque = [p[:3] for p in pixels(im) if p[3] >= 128]
    if not opaque or len(set(opaque)) <= colours:
        return im
    common = collections.Counter(opaque).most_common(1)[0][0]
    rgb = im.convert("RGB")
    rgb.paste(Image.new("RGB", rgb.size, common), mask=alpha.point(lambda a: 255 if a < 128 else 0))
    flat = rgb.quantize(colors=colours, method=Image.Quantize.MEDIANCUT).convert("RGBA")
    flat.putalpha(alpha)
    return flat


def to_palette(im: Image.Image, snap: Snapper) -> Image.Image:
    """Every opaque pixel snapped to the palette inside the layer's band."""
    out = im.convert("RGBA")
    out.putdata([snap((r, g, b)) + (a,) if a >= 128 else (r, g, b, a) for r, g, b, a in pixels(out)])
    return out


def coverage(im: Image.Image) -> float:
    alpha = im.getchannel("A")
    return sum(1 for a in pixels(alpha) if a >= 128) / float(im.width * im.height)


def flattest_field(im: Image.Image) -> float:
    """The share of the cell taken by its single commonest opaque colour."""
    counts: dict[tuple, int] = {}
    for p in pixels(im):
        if p[3] >= 128:
            counts[p[:3]] = counts.get(p[:3], 0) + 1
    return max(counts.values(), default=0) / float(im.width * im.height)


def unkeyed(cell: Image.Image) -> str:
    """Why a keyed cell looks like a drawing on a background, or ""."""
    if coverage(cell) > MOST_OF_A_CELL:
        return "fills its whole cell: the sheet was not drawn on the key"
    share = flattest_field(cell)
    if share > FLAT_FIELD_SHARE:
        return "is %.0f%% one flat colour: drawn on the wrong background" % (share * 100.0)
    return ""


def lightness_range(im: Image.Image) -> tuple[float, float] | None:
    """The L* of the darkest and the lightest opaque colour, or None."""
    values = [lab(p[:3])[0] for p in set(pixels(im)) if p[3] >= 128]
    return (round(min(values), 1), round(max(values), 1)) if values else None


# --- the command -----------------------------------------------------------------------------


def parse_size(text: str) -> tuple[int, int]:
    found = re.fullmatch(r"(\d+)(?:x(\d+))?", text.strip())
    if not found:
        raise SystemExit("--size is N or WxH, not %r" % text)
    wide = int(found.group(1))
    return wide, int(found.group(2) or wide)


def parse_grid(text: str) -> tuple[int, int]:
    found = re.fullmatch(r"(\d+)x(\d+)", text.strip())
    if not found or int(found.group(1)) < 1 or int(found.group(2)) < 1:
        raise SystemExit("--grid is COLUMNSxROWS, not %r" % text)
    return int(found.group(1)), int(found.group(2))


def _read_json(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as handle:
            found = json.load(handle)
    except (OSError, ValueError):
        return None
    return found if isinstance(found, dict) else None


def asked_with(sheet_path: str) -> dict | None:
    """The `gemini_web` sidecar of the ask that drew this sheet, or None:
    `<stem>.json` beside it, or, for one of several pictures of one answer
    (`<name>_<n>.png`), the `<name>.json` that lists it in its `files`."""
    stem = os.path.splitext(sheet_path)[0]
    own = _read_json(stem + ".json")
    if own is not None:
        return own
    one_of = re.fullmatch(r"(.+)_\d+", stem)
    if not one_of:
        return None
    shared = _read_json(one_of.group(1) + ".json")
    name = os.path.basename(sheet_path)
    files = shared.get("files", []) if shared else []
    if any(isinstance(f, dict) and f.get("file") == name for f in files):
        return shared
    return None


## A name that keeps no frame (a drawing of the sheet not used), and what joins
## the names of one drawing kept as several frames (`idle_s_0+attack_s_0`: an
## attack that starts from the standing pose).
SKIP = "-"
ALSO = "+"


def import_sheet(sheet_path: str, grid: tuple[int, int] | None, size: tuple[int, int], layer: str, names: list[str],
                 out_dir: str, key_mode: str = "auto", fit: str = "union", anchor: str = "bottom", margin: int = 1,
                 colours: int | None = None, palette: list[tuple[int, int, int]] | None = None,
                 auto_grid: bool = False, outlines: list[tuple[int, int, int]] | None = None,
                 cut: str = "grid", mirror: set[str] | frozenset[str] = frozenset(),
                 shared_colours: bool = False, forced_scale: float | None = None) -> dict:
    """Runs every pass on one sheet and writes the frames, the preview and
    `import.json`. Returns that record.

    `cut="grid"` cuts the even `grid`; `cut="rows"` finds the rows of drawings
    and the drawings of each row (`row_cells`), fits each row in one box of its
    own and every row at one scale (the largest any row needs), so frames keep
    their registration within a row and their size across rows; `cut="blobs"`
    takes every separate drawing (`blob_cells`) at one scale, each centred on
    its mass (`massed`). `forced_scale` (source pixels per frame pixel) takes
    the place of the scale the boxes ask for: two sheets of one creature, or a
    frame whose whip may run off the edge rather than shrink the body. `names` then
    name the drawings in reading order, `SKIP` for one not kept, several
    names joined by `ALSO` for one kept as several frames. `mirror` names
    frames flipped left to right after the fit (a sheet drew the creature
    facing right where the frame faces left). `shared_colours` reduces every
    frame's colours together (`reduced_together`)."""
    if layer not in BANDS:
        raise SystemExit("--layer is one of %s" % ", ".join(BANDS))
    source = Image.open(sheet_path)
    sheet, keyed_by = keyed_sheet(source, key_mode)
    warnings: list[str] = []
    row_of: list[int] = []
    if cut == "rows":
        rows, warnings = row_cells(sheet)
        parts = [cell_image(sheet, cell) for row in rows for cell in row]
        found_at = [(cell[1][0], cell[0][1], cell[1][1], cell[0][3]) for row in rows for cell in row]
        row_of = [index for index, row in enumerate(rows) for _cell in row]
        grid = None
        shape = "rows of %s" % "+".join(str(len(row)) for row in rows)
    elif cut == "blobs":
        parts, found_at, warnings = blob_cells(sheet)
        row_of = list(range(len(parts)))
        grid = None
        shape = "%d drawings" % len(parts)
    else:
        if grid is None:
            raise SystemExit("--grid is required with --cut grid")
        best, stated, lowest = best_grid(sheet, *grid)
        if best != grid and stated > lowest * GRID_TOLERANCE + 1.0:
            warnings.append("the %dx%d grid cuts through drawings (%.0f); %dx%d cuts %.0f" % (grid + (stated,) + best + (lowest,)))
            if auto_grid:
                grid = best
        parts = cells(sheet, *grid)
        shape = "grid %dx%d" % grid
    if names and len(names) != len(parts):
        raise SystemExit("%d names for %d cells (%s)" % (len(names), len(parts), shape))
    names = names or ["frame_%d" % n for n in range(len(parts))]
    targets = [target for name in names if name != SKIP for target in name.split(ALSO)]
    if len(set(targets)) != len(targets):
        raise SystemExit("a frame name is given twice: %s" % ", ".join(sorted({t for t in targets if targets.count(t) > 1})))
    unknown = sorted(set(mirror) - set(targets))
    if unknown:
        raise SystemExit("--mirror names no frame: %s" % ", ".join(unknown))
    for name, part in zip(names, parts):
        why = unkeyed(part) if name != SKIP else ""
        if why:
            warnings.append("%s %s" % (name, why))
    if cut in ("rows", "blobs"):
        row_boxes = [union_box([p for p, r in zip(parts, row_of) if r == index]) for index in range(max(row_of, default=-1) + 1)]
        row_scale = forced_scale or max((scale_for(box, size, margin) for box in row_boxes if box), default=1.0)
        if cut == "blobs":
            row_boxes = [massed(part, box) if box else None for part, box in zip(parts, row_boxes)]
    shared = union_box(parts) if fit == "union" and cut == "grid" else None
    outlines = outlines if layer in OUTLINED else None
    snap = Snapper(palette, BANDS[layer], outlines) if palette else None
    os.makedirs(out_dir, exist_ok=True)
    kept: list[tuple[str, Image.Image]] = []
    scales = []
    for index, (name, part) in enumerate(zip(names, parts)):
        if name == SKIP:
            continue
        if cut in ("rows", "blobs"):
            box, scale = row_boxes[row_of[index]], row_scale
        else:
            box = shared if fit == "union" else (bbox_of(part) if fit == "each" else (0, 0, part.width, part.height))
            scale = forced_scale or (scale_for(box, size, margin) if box else 1.0)
        if not box:
            warnings.append("%s is empty" % name)
            kept.extend((target, Image.new("RGBA", size, (0, 0, 0, 0))) for target in name.split(ALSO))
            continue
        scales.append(scale)
        frame = binary_alpha(downscale(part, box, size, scale, anchor, margin))
        for target in name.split(ALSO):
            kept.append((target, frame.transpose(Image.Transpose.FLIP_LEFT_RIGHT) if target in mirror else frame))
    if colours and shared_colours:
        flat = reduced_together([frame for _name, frame in kept], colours)
        kept = [(name, frame) for (name, _old), frame in zip(kept, flat)]
    frames, written = [], []
    for name, frame in kept:
        if colours and not shared_colours:
            frame = reduced(frame, colours)
        if snap:
            frame = to_palette(frame, snap)
        frame = binary_alpha(frame)
        path = os.path.join(out_dir, name + ".png")
        frame.save(path)
        frames.append(frame)
        written.append({"file": name + ".png", "lightness": lightness_range(frame),
                        "colours": len({p for p in pixels(frame) if p[3] == 255})})
    anim_sheet.sheet_of([(os.path.basename(out_dir.rstrip("/\\")), frames)], scale=4, wrap=8).save(
        os.path.join(out_dir, "_preview.png"))
    if cut != "grid":
        numbered(sheet, found_at, names).save(os.path.join(out_dir, "_drawings.png"))
    with open(sheet_path, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    record = {
        "source": os.path.basename(sheet_path),
        "source_sha256": digest,
        "grid": list(grid) if grid else None,
        "cut": cut,
        "shape": shape,
        "mirrored": sorted(mirror),
        "shared_colours": shared_colours,
        "names": names,
        "forced_scale": forced_scale,
        "size": list(size),
        "layer": layer,
        "band": list(BANDS[layer]),
        "key": keyed_by,
        "fit": fit,
        "anchor": anchor,
        "margin": margin,
        "colours": colours,
        "palette": "tools/spritegen/src/palette.ts" if palette else None,
        "outlines": bool(outlines),
        "scale": round(max(scales), 3) if scales else None,
        "frames": written,
        "warnings": warnings,
    }
    asked = asked_with(sheet_path)
    if asked:
        record["delivery"] = {k: asked[k] for k in ("tool", "prompt", "mode", "started", "url", "refs") if k in asked}
    with open(os.path.join(out_dir, "import.json"), "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=1, ensure_ascii=False)
        handle.write("\n")
    return record


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sheet")
    parser.add_argument("--grid", default="", help="COLUMNSxROWS, e.g. 4x2 (required unless --cut rows)")
    parser.add_argument("--cut", default="grid", choices=("grid", "rows", "blobs"),
                        help="grid: the even --grid; rows: the rows of drawings as the sheet drew them; "
                             "blobs: every separate drawing, each on its own box")
    parser.add_argument("--mirror", default="", help="comma-separated frame names to flip left to right")
    parser.add_argument("--scale", type=float, default=0.0,
                        help="source pixels per frame pixel, in place of the one the boxes ask for")
    parser.add_argument("--shared-colours", action="store_true",
                        help="reduce the colours of all the frames together (one set for the animation)")
    parser.add_argument("--size", default="32", help="frame size, N or WxH (ART-2: 32, people 64)")
    parser.add_argument("--layer", default="creature", choices=sorted(BANDS))
    parser.add_argument("--names", default="", help="comma-separated frame names, reading order")
    parser.add_argument("--prefix", default="", help="frames named <prefix>_<n> (e.g. walk_s)")
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--key", default="auto", choices=("auto", "magenta", "alpha"))
    parser.add_argument("--fit", default="union", choices=("union", "each", "none"))
    parser.add_argument("--anchor", default="bottom", choices=("bottom", "center"))
    parser.add_argument("--margin", type=int, default=1)
    parser.add_argument("--colors", type=int, default=-1, help="colours before the palette snap (default by layer; 0: no limit)")
    parser.add_argument("--no-palette", action="store_true", help="keep the colours (no palette or band snap)")
    parser.add_argument("--no-outline", action="store_true",
                        help="clamp the darkest pixels into the band too (always so for ground and effect)")
    parser.add_argument("--auto-grid", action="store_true", help="take the grid that cuts the least drawing")
    args = parser.parse_args(argv)
    grid = parse_grid(args.grid) if args.grid or args.cut == "grid" else None
    names = [n.strip() for n in args.names.split(",") if n.strip()]
    if not names and args.prefix:
        if grid is None:
            raise SystemExit("--prefix needs --grid: name the drawings with --names under --cut rows or blobs")
        names = ["%s_%d" % (args.prefix, n) for n in range(grid[0] * grid[1])]
    mirror = {n.strip() for n in args.mirror.split(",") if n.strip()}
    out_dir = args.out_dir or os.path.join(OUT_DIR, os.path.splitext(os.path.basename(args.sheet))[0])
    colours = COLOURS[args.layer] if args.colors < 0 else (args.colors or None)
    record = import_sheet(args.sheet, grid, parse_size(args.size), args.layer, names, out_dir, args.key, args.fit,
                          args.anchor, args.margin, colours, None if args.no_palette else load_palette(), args.auto_grid,
                          None if args.no_outline else load_outlines(), args.cut, mirror, args.shared_colours,
                          args.scale or None)
    for line in record["warnings"]:
        print("warning: %s" % line)
    if args.cut != "grid":
        print("found %s" % record["shape"])
    print("wrote %d frames of %dx%d into %s (scale %s:1); look at %s" % (
        len(record["frames"]), record["size"][0], record["size"][1], out_dir, record["scale"],
        os.path.join(out_dir, "_preview.png")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
