"""The art import's pure passes: key, cut, downscale, palette and values, alpha."""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest

from PIL import Image

import import_art as art

MAGENTA = (255, 0, 255, 255)


def sprite(pattern: list[str], colours: dict[str, tuple[int, int, int, int]]) -> Image.Image:
    """A small RGBA picture from rows of letters ('.' is the magenta key)."""
    im = Image.new("RGBA", (len(pattern[0]), len(pattern)))
    for y, row in enumerate(pattern):
        for x, letter in enumerate(row):
            im.putpixel((x, y), MAGENTA if letter == "." else colours[letter])
    return im


WOLF = [
    "........",
    "..aa....",
    ".abba...",
    ".abbbaa.",
    "..bbbb..",
    "..b..b..",
    "..c..c..",
    "........",
]
WOLF_COLOURS = {"a": (60, 50, 40, 255), "b": (120, 100, 80, 255), "c": (30, 25, 20, 255)}


class TheKey(unittest.TestCase):
    def test_magenta_and_its_blend_go_and_browns_stay(self):
        im = Image.new("RGB", (4, 1))
        for x, colour in enumerate([(255, 0, 255), (200, 40, 190), (120, 100, 80), (150, 60, 40)]):
            im.putpixel((x, 0), colour)
        keyed = art.key(im, "magenta")
        self.assertEqual([keyed.getpixel((x, 0))[3] for x in range(4)], [0, 0, 255, 255])

    def test_a_sheet_with_alpha_keeps_it_and_its_purples(self):
        im = Image.new("RGBA", (2, 1), (0, 0, 0, 0))
        im.putpixel((1, 0), (180, 60, 200, 255))  # a violet drawing the hue key would eat
        keyed = art.key(im, "auto")
        self.assertEqual(keyed.getpixel((1, 0)), (180, 60, 200, 255))
        self.assertEqual(keyed.getpixel((0, 0))[3], 0)

    def test_a_violet_drawing_on_its_own_alpha_is_neither_keyed_nor_unfringed(self):
        im = Image.new("RGBA", (3, 1), (0, 0, 0, 0))
        im.putpixel((1, 0), (150, 90, 170, 255))  # leans to magenta by the fringe test
        sheet, used = art.keyed_sheet(im, "auto")
        self.assertEqual(used, "alpha")
        self.assertEqual(sheet.getpixel((1, 0)), (150, 90, 170, 255))
        _sheet, used = art.keyed_sheet(Image.new("RGB", (2, 2), (255, 0, 255)), "auto")
        self.assertEqual(used, "magenta")

    def test_the_fringe_takes_its_honest_neighbours_colour(self):
        im = Image.new("RGBA", (3, 1), (0, 0, 0, 0))
        im.putpixel((0, 0), (100, 80, 60, 255))
        im.putpixel((1, 0), (130, 60, 120, 255))  # a pink blend at the edge, past the key
        fixed = art.unfringe(im)
        self.assertEqual(fixed.getpixel((1, 0)), (100, 80, 60, 255))


class TheCut(unittest.TestCase):
    def test_cells_come_in_reading_order(self):
        sheet = Image.new("RGBA", (40, 20))
        for index in range(8):
            column, row = index % 4, index // 4
            for y in range(row * 10, row * 10 + 10):
                for x in range(column * 10, column * 10 + 10):
                    sheet.putpixel((x, y), (index * 20, 0, 0, 255))
        parts = art.cells(sheet, 4, 2)
        self.assertEqual([part.getpixel((5, 5))[0] for part in parts], [i * 20 for i in range(8)])

    def test_a_sheet_drawn_in_another_shape_is_found(self):
        # Four drawings in one row, asked as 2x2: the 2x2 cut goes through them.
        sheet = Image.new("RGBA", (80, 20), (0, 0, 0, 0))
        for column in range(4):
            for y in range(2, 18):
                for x in range(column * 20 + 3, column * 20 + 17):
                    sheet.putpixel((x, y), (90, 70, 50, 255))
        best, stated, lowest = art.best_grid(sheet, 2, 2)
        self.assertEqual(best, (4, 1))
        self.assertGreater(stated, lowest)


class TheDownscale(unittest.TestCase):
    def test_pixel_art_drawn_four_times_bigger_comes_back_as_its_own_pixels(self):
        small = art.key(sprite(WOLF, WOLF_COLOURS), "magenta")
        big = small.resize((32, 32), Image.Resampling.NEAREST)
        box = art.bbox_of(big)
        scale = art.scale_for(box, (6, 6), 0)  # the drawing is 6x6 of the 8x8
        self.assertEqual(scale, 4.0)
        frame = art.downscale(big, box, (6, 6), scale, "center", 0)
        want = small.crop(art.bbox_of(small))
        got = frame.crop(art.bbox_of(frame))
        self.assertEqual(list(art.pixels(got)), list(art.pixels(want)))

    def test_a_frame_sits_on_the_bottom_line_centred(self):
        cell = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
        for y in range(2, 6):
            for x in range(3, 7):
                cell.putpixel((x, y), (90, 70, 50, 255))
        frame = art.downscale(cell, art.bbox_of(cell), (16, 16), 1.0, "bottom", 1)
        self.assertEqual(art.bbox_of(frame), (6, 11, 10, 15))

    def test_a_small_drawing_is_never_blown_up(self):
        self.assertEqual(art.scale_for((0, 0, 10, 10), (32, 32), 1), 1.0)

    def test_one_box_for_the_whole_animation(self):
        one = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
        two = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
        one.putpixel((2, 15), (1, 1, 1, 255))
        two.putpixel((17, 4), (1, 1, 1, 255))
        self.assertEqual(art.union_box([one, two]), (2, 4, 18, 16))

    def test_alpha_is_zero_or_full(self):
        im = Image.new("RGBA", (3, 1))
        for x, alpha in enumerate((0, 127, 128)):
            im.putpixel((x, 0), (50, 60, 70, alpha))
        out = art.binary_alpha(im)
        self.assertEqual([out.getpixel((x, 0)) for x in range(3)], [(0, 0, 0, 0), (0, 0, 0, 0), (50, 60, 70, 255)])


class ThePalette(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.palette = art.load_palette()

    def test_it_is_read_off_spritegen_with_the_outlines(self):
        text = 'a: material("#b38a58", "#8c6840", "#674a2b", "#47321c"),'
        colours = art.parse_palette(text)
        self.assertEqual(colours[0], (0xB3, 0x8A, 0x58))
        # The outline: the deep shade 45% darker, as palette.ts's darken computes it.
        self.assertEqual(colours[4], (39, 28, 15))
        self.assertGreater(len(self.palette), 100)

    def test_the_outline_rounds_halves_up_as_math_round_does(self):
        # Each pair checked against palette.ts's darken in Node: Python's round
        # goes to the even integer and drew outlines spritegen never does.
        for deep, outline in (
            ("#46443f", (39, 37, 35)),
            ("#46433f", (39, 37, 35)),
            ("#3e241e", (34, 20, 17)),
            ("#665b46", (56, 50, 39)),
            ("#1e3716", (17, 30, 12)),
        ):
            text = 'x: material("#ffffff", "#eeeeee", "#dddddd", "%s"),' % deep
            self.assertEqual(art.parse_palette(text)[4], outline, deep)
            self.assertEqual(art.outline_colours(text), [outline], deep)
        self.assertEqual([art.js_round(x) for x in (0.5, 1.5, 2.5, 2.4999, -0.5)], [1, 2, 3, 2, 0])

    def test_lab_of_the_ends_and_grey(self):
        self.assertAlmostEqual(art.lab((255, 255, 255))[0], 100.0, places=1)
        self.assertAlmostEqual(art.lab((0, 0, 0))[0], 0.0, places=1)
        self.assertAlmostEqual(art.lab((119, 119, 119))[0], 50.0, delta=0.5)

    def test_a_colour_is_moved_into_its_band_and_its_chroma_capped(self):
        lightness, a, b = art.banded((80.0, 60.0, 0.0), art.BANDS["ground"])
        self.assertEqual(lightness, 50.0)
        self.assertAlmostEqual((a * a + b * b) ** 0.5, 35.0, places=6)

    def test_every_ground_pixel_lands_on_a_palette_colour_inside_the_band(self):
        snap = art.Snapper(self.palette, art.BANDS["ground"])
        for colour in [(250, 250, 240), (5, 5, 5), (255, 40, 40), (40, 200, 60)]:
            got = snap(colour)
            self.assertIn(got, self.palette)
            self.assertTrue(art.in_band(art.lab(got), art.BANDS["ground"]), (colour, got, art.lab(got)))

    def test_a_pixel_darker_than_the_band_keeps_a_dark_outline(self):
        outlines = art.load_outlines()
        self.assertTrue(outlines and set(outlines) <= set(self.palette))
        snap = art.Snapper(self.palette, art.BANDS["object"], outlines)
        got = snap((12, 10, 8))
        self.assertIn(got, outlines)
        self.assertLess(art.lab(got)[0], art.BANDS["object"][0])
        # Without the outlines it is clamped into the band, as the surfaces are.
        self.assertGreaterEqual(art.lab(art.Snapper(self.palette, art.BANDS["object"])((12, 10, 8)))[0], 25.0)

    def test_effects_stay_bright(self):
        got = art.Snapper(self.palette, art.BANDS["effect"])((20, 10, 5))
        self.assertGreaterEqual(art.lab(got)[0], 60.0)

    def test_colours_are_reduced_before_the_snap(self):
        im = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
        for i in range(100):
            im.putpixel((i % 16, i // 16), (i * 2, 100, 255 - i * 2, 255))
        flat = art.reduced(im, 8)
        self.assertLessEqual(len({p for p in art.pixels(flat) if p[3] == 255}), 8)
        self.assertEqual(flat.getpixel((15, 15))[3], 0)


class TheWarnings(unittest.TestCase):
    def test_a_cell_drawn_on_no_key_is_reported(self):
        self.assertIn("whole cell", art.unkeyed(Image.new("RGBA", (10, 10), (40, 160, 40, 255))))

    def test_a_cell_on_a_flat_field_is_reported(self):
        cell = Image.new("RGBA", (10, 10), (0, 0, 0, 0))
        for y in range(10):
            for x in range(6):
                cell.putpixel((x, y), (40, 160, 40, 255))
        self.assertIn("flat colour", art.unkeyed(cell))

    def test_a_drawing_is_not(self):
        self.assertEqual(art.unkeyed(art.key(sprite(WOLF, WOLF_COLOURS), "magenta")), "")


class TheWholeImport(unittest.TestCase):
    def test_a_sheet_becomes_named_frames_a_preview_and_a_record(self):
        frames = [sprite(WOLF, WOLF_COLOURS), sprite([row[::-1] for row in WOLF], WOLF_COLOURS)]
        sheet = Image.new("RGBA", (64, 32), MAGENTA)
        for index, frame in enumerate(frames):
            sheet.paste(frame.resize((32, 32), Image.Resampling.NEAREST), (index * 32, 0))
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "wolf_sheet.png")
            sheet.save(path)
            with open(os.path.join(folder, "wolf_sheet.json"), "w", encoding="utf-8") as handle:
                json.dump({"prompt": "a grey wolf, two steps", "tool": "test"}, handle)
            out = os.path.join(folder, "out")
            record = art.import_sheet(path, (2, 1), (16, 16), "creature", ["walk_s_0", "walk_s_1"], out,
                                      colours=24, palette=art.load_palette(), outlines=art.load_outlines())
            self.assertEqual([f["file"] for f in record["frames"]], ["walk_s_0.png", "walk_s_1.png"])
            self.assertEqual(record["delivery"]["prompt"], "a grey wolf, two steps")
            self.assertTrue(os.path.exists(os.path.join(out, "_preview.png")))
            palette = set(art.load_palette())
            for name in ("walk_s_0", "walk_s_1"):
                frame = Image.open(os.path.join(out, name + ".png"))
                self.assertEqual(frame.size, (16, 16))
                for p in art.pixels(frame):
                    self.assertIn(p[3], (0, 255))
                    if p[3]:
                        self.assertIn(p[:3], palette)
                        self.assertLessEqual(art.lab(p[:3])[0], 85.0)
            with open(os.path.join(out, "import.json"), encoding="utf-8") as handle:
                self.assertEqual(json.load(handle)["layer"], "creature")

    def sheet_of(self, folder, colour, name="sheet.png"):
        """A 1x1 sheet: a 24x24 block of `colour` with a 4 px ring of a
        darker one, on the magenta key."""
        sheet = Image.new("RGBA", (32, 32), MAGENTA)
        dark = tuple(c // 4 for c in colour[:3]) + (255,)
        for y in range(4, 28):
            for x in range(4, 28):
                ring = x < 8 or x >= 24 or y < 8 or y >= 24
                sheet.putpixel((x, y), dark if ring else colour)
        path = os.path.join(folder, name)
        sheet.save(path)
        return path

    def cli(self, *argv):
        with contextlib.redirect_stdout(io.StringIO()):
            art.main(list(argv))

    def opaque(self, out, name="frame_0"):
        return [p[:3] for p in art.pixels(Image.open(os.path.join(out, name + ".png"))) if p[3]]

    def test_an_effect_imported_with_the_defaults_stays_in_its_band(self):
        # 2026-11-18 review: with the CLI's outlines, an orange spark at L* 58
        # came out as an outline at L* 15.
        with tempfile.TemporaryDirectory() as folder:
            path = self.sheet_of(folder, (200, 120, 40, 255))
            out = os.path.join(folder, "out")
            self.cli(path, "--grid", "1x1", "--size", "16", "--layer", "effect", "--out-dir", out)
            for colour in self.opaque(out):
                self.assertGreaterEqual(art.lab(colour)[0], 60.0 - 1e-6, colour)

    def test_ground_imported_with_the_defaults_has_no_outline(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.sheet_of(folder, (90, 110, 60, 255))
            out = os.path.join(folder, "out")
            self.cli(path, "--grid", "1x1", "--size", "16", "--layer", "ground", "--out-dir", out)
            # The dark ring (L* ~10) is clamped into the band, never an outline under it.
            for colour in self.opaque(out):
                self.assertTrue(art.in_band(art.lab(colour), art.BANDS["ground"]), colour)
            with open(os.path.join(out, "import.json"), encoding="utf-8") as handle:
                self.assertFalse(json.load(handle)["outlines"])

    def test_a_creature_imported_with_the_defaults_keeps_its_outline(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.sheet_of(folder, (120, 100, 80, 255))
            out = os.path.join(folder, "out")
            self.cli(path, "--grid", "1x1", "--size", "16", "--layer", "creature", "--out-dir", out)
            self.assertTrue(set(self.opaque(out)) & set(art.load_outlines()))

    def test_one_of_several_pictures_of_an_answer_finds_its_ask(self):
        # gemini_web writes <name>_1.png, <name>_2.png and one <name>.json.
        with tempfile.TemporaryDirectory() as folder:
            path = self.sheet_of(folder, (120, 100, 80, 255), "wolf_2.png")
            with open(os.path.join(folder, "wolf.json"), "w", encoding="utf-8") as handle:
                json.dump({"prompt": "a grey wolf", "tool": "gemini_web.py",
                           "refs": [{"file": "assets/sprites/x.png", "sha256": "ab"}],
                           "files": [{"file": "wolf_1.png"}, {"file": "wolf_2.png"}]}, handle)
            record = art.import_sheet(path, (1, 1), (16, 16), "creature", [], os.path.join(folder, "out"))
            self.assertEqual(record["delivery"]["prompt"], "a grey wolf")
            self.assertEqual(record["delivery"]["refs"], [{"file": "assets/sprites/x.png", "sha256": "ab"}])
            # A sidecar that does not list the picture is not its ask.
            other = self.sheet_of(folder, (120, 100, 80, 255), "wolf_3.png")
            record = art.import_sheet(other, (1, 1), (16, 16), "creature", [], os.path.join(folder, "out3"))
            self.assertNotIn("delivery", record)

    def test_rows_of_any_length_keep_one_scale_and_their_registration(self):
        # Two rows as Gemini draws them: three drawings, then two, each on an even share.
        sheet = Image.new("RGBA", (120, 60), MAGENTA)
        def block(x, y, w, h, colour=(120, 100, 80, 255)):
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    sheet.putpixel((xx, yy), colour)
        for i in range(3):
            block(i * 40 + 12, 4, 16, 16)  # a 16x16 body in each 40 px share
        block(i * 40 + 12 + 1, 4, 2, 2, (30, 25, 20, 255))  # the last one a little different
        block(14, 34, 32, 20)  # two wider drawings in 60 px shares
        block(74, 34, 32, 20)
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "rows.png")
            sheet.save(path)
            out = os.path.join(folder, "out")
            record = art.import_sheet(path, None, (16, 16), "creature", ["a_0", "a_1", "a_2", "b_0", "-"], out,
                                      margin=0, colours=8, palette=art.load_palette(), cut="rows",
                                      outlines=art.load_outlines())
            self.assertEqual(record["shape"], "rows of 3+2")
            self.assertEqual([f["file"] for f in record["frames"]], ["a_0.png", "a_1.png", "a_2.png", "b_0.png"])
            self.assertFalse(os.path.exists(os.path.join(out, "-.png")))
            self.assertTrue(os.path.exists(os.path.join(out, "_drawings.png")))
            # One scale for both rows: the wide row's 32 px fit 16, so the 16 px bodies are 8.
            self.assertEqual(record["scale"], 2.0)
            boxes = [art.bbox_of(Image.open(os.path.join(out, n))) for n in ("a_0.png", "a_1.png", "b_0.png")]
            self.assertEqual(boxes[0], boxes[1])
            self.assertEqual(boxes[0][2] - boxes[0][0], 8)
            self.assertEqual(boxes[2][2] - boxes[2][0], 16)

    def test_a_drawing_that_overhangs_its_share_is_not_cut_and_its_neighbour_stays_out(self):
        sheet = Image.new("RGBA", (60, 20), (0, 0, 0, 0))
        for y in range(2, 18):
            for x in range(8, 22):  # spills past x=20, the edge of its 20 px share
                sheet.putpixel((x, y), (120, 100, 80, 255))
            for x in range(24, 36):
                sheet.putpixel((x, y), (30, 25, 20, 255))
            for x in range(44, 52):
                sheet.putpixel((x, y), (60, 50, 40, 255))
        rows, warnings = art.row_cells(sheet, column_gap=2)
        self.assertEqual(warnings, [])
        self.assertEqual(len(rows[0]), 3)
        first, second = art.cell_image(sheet, rows[0][0]), art.cell_image(sheet, rows[0][1])
        self.assertEqual(first.size, second.size)  # one origin for the whole row
        self.assertEqual(art.bbox_of(first)[2] - art.bbox_of(first)[0], 14)  # whole
        self.assertEqual({p[:3] for p in art.pixels(second) if p[3]}, {(30, 25, 20)})  # nothing of the first

    def test_blobs_are_found_in_reading_order_whatever_the_layout(self):
        # Two panels side by side, rows not lined up, a loose speck by the second drawing.
        sheet = Image.new("RGBA", (80, 60), MAGENTA)
        def block(x, y, w, h):
            for yy in range(y, y + h):
                for xx in range(x, x + w):
                    sheet.putpixel((xx, yy), (120, 100, 80, 255))
        block(2, 2, 12, 12)
        block(20, 4, 10, 12)
        block(32, 6, 2, 2)  # a tail tip that came loose: it goes with its nearest drawing
        block(50, 3, 14, 12)
        block(4, 40, 16, 10)
        keyed, _ = art.keyed_sheet(sheet, "magenta")
        parts, boxes, _ = art.blob_cells(keyed, block=1)
        self.assertEqual(len(parts), 4)
        self.assertEqual([b[0] for b in boxes], [2, 20, 50, 4])
        self.assertEqual(boxes[1][2], 34)  # the tip joined the second drawing

    def test_a_body_stays_put_when_a_whip_swings_out(self):
        part = Image.new("RGBA", (40, 10), (0, 0, 0, 0))
        for y in range(0, 10):
            for x in range(4, 12):
                part.putpixel((x, y), (120, 100, 80, 255))
        for x in range(12, 40):
            part.putpixel((x, 5), (60, 50, 40, 255))  # the whip, thin and long
        box = art.massed(part, art.bbox_of(part))
        middle = (box[0] + box[2]) / 2
        self.assertLess(abs(middle - 12), 3)  # near the body (4..12), not the box's middle (22)
        self.assertEqual(box[2] - middle, middle - box[0])

    def test_one_drawing_kept_as_several_frames_and_mirrored(self):
        sheet = Image.new("RGBA", (32, 16), MAGENTA)
        for y in range(4, 14):
            for x in range(4, 10):
                sheet.putpixel((x, y), (120, 100, 80, 255))
            sheet.putpixel((10, y), (30, 25, 20, 255))  # the right side is darker
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "one.png")
            sheet.save(path)
            out = os.path.join(folder, "out")
            art.import_sheet(path, None, (16, 16), "creature", ["idle_w_0+attack_w_0"], out, palette=None,
                             cut="blobs", mirror={"attack_w_0"}, shared_colours=True, colours=8)
            idle = Image.open(os.path.join(out, "idle_w_0.png"))
            attack = Image.open(os.path.join(out, "attack_w_0.png"))
            self.assertEqual(list(art.pixels(attack)), list(art.pixels(idle.transpose(Image.Transpose.FLIP_LEFT_RIGHT))))
            with self.assertRaises(SystemExit):  # a name given twice
                art.import_sheet(path, None, (16, 16), "creature", ["a_0+a_0"], out, cut="blobs")
            with self.assertRaises(SystemExit):  # a mirror that names no frame
                art.import_sheet(path, None, (16, 16), "creature", ["a_0"], out, cut="blobs", mirror={"b_0"})

    def test_a_forced_scale_takes_the_place_of_the_boxes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = self.sheet_of(folder, (120, 100, 80, 255))
            record = art.import_sheet(path, None, (32, 32), "creature", [], os.path.join(folder, "out"),
                                      cut="blobs", forced_scale=2.0)
            self.assertEqual(record["scale"], 2.0)
            self.assertEqual(record["forced_scale"], 2.0)
            frame = Image.open(os.path.join(folder, "out", "frame_0.png"))
            box = art.bbox_of(frame)
            self.assertEqual(box[2] - box[0], 12)  # the 24 px drawing at 2:1

    def test_shared_colours_give_every_frame_the_same_shades(self):
        a = Image.new("RGBA", (4, 1), (0, 0, 0, 0))
        b = Image.new("RGBA", (4, 1), (0, 0, 0, 0))
        for x, c in enumerate([(100, 80, 60), (104, 82, 61), (30, 30, 30), (200, 190, 180)]):
            a.putpixel((x, 0), c + (255,))
        for x, c in enumerate([(101, 80, 60), (30, 31, 30), (199, 190, 180), (60, 60, 200)]):
            b.putpixel((x, 0), c + (255,))
        flat = art.reduced_together([a, b], 4)
        colours = {p[:3] for f in flat for p in art.pixels(f) if p[3]}
        self.assertLessEqual(len(colours), 4)
        self.assertEqual(flat[0].getpixel((0, 0)), flat[1].getpixel((0, 0)))  # one shade for both browns

    def test_the_wrong_number_of_names_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "s.png")
            Image.new("RGBA", (20, 10), MAGENTA).save(path)
            with self.assertRaises(SystemExit):
                art.import_sheet(path, (2, 1), (8, 8), "creature", ["only_one"], folder)


if __name__ == "__main__":
    unittest.main()
