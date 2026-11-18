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
   (`seam_cost`); a better one is reported, and taken with `--auto-grid`.
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
    `margin`) or centred down."""
    wide = max(int(round((box[2] - box[0]) / scale)), 1)
    tall = max(int(round((box[3] - box[1]) / scale)), 1)
    src = cell.load()
    small = Image.new("RGBA", (wide, tall), (0, 0, 0, 0))
    out = small.load()
    for v in range(tall):
        sy = min(int(box[1] + (v + 0.5) * scale), box[3] - 1, cell.height - 1)
        for u in range(wide):
            sx = min(int(box[0] + (u + 0.5) * scale), box[2] - 1, cell.width - 1)
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


def import_sheet(sheet_path: str, grid: tuple[int, int], size: tuple[int, int], layer: str, names: list[str],
                 out_dir: str, key_mode: str = "auto", fit: str = "union", anchor: str = "bottom", margin: int = 1,
                 colours: int | None = None, palette: list[tuple[int, int, int]] | None = None,
                 auto_grid: bool = False, outlines: list[tuple[int, int, int]] | None = None) -> dict:
    """Runs every pass on one sheet and writes the frames, the preview and
    `import.json`. Returns that record."""
    if layer not in BANDS:
        raise SystemExit("--layer is one of %s" % ", ".join(BANDS))
    source = Image.open(sheet_path)
    sheet, keyed_by = keyed_sheet(source, key_mode)
    warnings: list[str] = []
    best, stated, lowest = best_grid(sheet, *grid)
    if best != grid and stated > lowest * GRID_TOLERANCE + 1.0:
        warnings.append("the %dx%d grid cuts through drawings (%.0f); %dx%d cuts %.0f" % (grid + (stated,) + best + (lowest,)))
        if auto_grid:
            grid = best
    parts = cells(sheet, *grid)
    if names and len(names) != len(parts):
        raise SystemExit("%d names for %d cells (grid %dx%d)" % (len(names), len(parts), grid[0], grid[1]))
    names = names or ["frame_%d" % n for n in range(len(parts))]
    for name, part in zip(names, parts):
        why = unkeyed(part)
        if why:
            warnings.append("%s %s" % (name, why))
    shared = union_box(parts) if fit == "union" else None
    outlines = outlines if layer in OUTLINED else None
    snap = Snapper(palette, BANDS[layer], outlines) if palette else None
    os.makedirs(out_dir, exist_ok=True)
    frames, written = [], []
    scales = []
    for name, part in zip(names, parts):
        box = shared if fit == "union" else (bbox_of(part) if fit == "each" else (0, 0, part.width, part.height))
        if not box:
            warnings.append("%s is empty" % name)
            frame = Image.new("RGBA", size, (0, 0, 0, 0))
        else:
            scale = scale_for(box, size, margin)
            scales.append(scale)
            frame = downscale(part, box, size, scale, anchor, margin)
            frame = binary_alpha(frame)
            if colours:
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
    with open(sheet_path, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    record = {
        "source": os.path.basename(sheet_path),
        "source_sha256": digest,
        "grid": list(grid),
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
    parser.add_argument("--grid", required=True, help="COLUMNSxROWS, e.g. 4x2")
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
    grid = parse_grid(args.grid)
    names = [n.strip() for n in args.names.split(",") if n.strip()]
    if not names and args.prefix:
        names = ["%s_%d" % (args.prefix, n) for n in range(grid[0] * grid[1])]
    out_dir = args.out_dir or os.path.join(OUT_DIR, os.path.splitext(os.path.basename(args.sheet))[0])
    colours = COLOURS[args.layer] if args.colors < 0 else (args.colors or None)
    record = import_sheet(args.sheet, grid, parse_size(args.size), args.layer, names, out_dir, args.key, args.fit,
                          args.anchor, args.margin, colours, None if args.no_palette else load_palette(), args.auto_grid,
                          None if args.no_outline else load_outlines())
    for line in record["warnings"]:
        print("warning: %s" % line)
    print("wrote %d frames of %dx%d into %s (scale %s:1); look at %s" % (
        len(record["frames"]), record["size"][0], record["size"][1], out_dir, record["scale"],
        os.path.join(out_dir, "_preview.png")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
