"""The music conversion's pure parts: fades, the loop seam, loudness; and one real run when ffmpeg is there."""

from __future__ import annotations

import array
import json
import math
import os
import subprocess
import tempfile
import unittest
import wave

import music_convert as mc


def tone(seconds: float, rate: int, hz: float = 220.0, amp: float = 0.5, channels: int = 1, phase: float = 0.0):
    out = array.array("f")
    for i in range(int(seconds * rate)):
        value = amp * math.sin(phase + 2.0 * math.pi * hz * i / rate)
        out.extend([value] * channels)
    return out


def faded(rate: int, fade_in: float, body: float, fade_out: float, channels: int = 1):
    """A tone with linear fades at both ends."""
    x = tone(fade_in + body + fade_out, rate, channels=channels)
    n = len(x) // channels
    for i in range(n):
        t = i / rate
        if t < fade_in:
            gain = t / fade_in
        elif t > fade_in + body:
            gain = max(0.0, (fade_in + body + fade_out - t) / fade_out)
        else:
            gain = 1.0
        for c in range(channels):
            x[i * channels + c] *= gain
    return x


class TheFades(unittest.TestCase):
    def test_they_are_found_where_the_level_reaches_half_the_body(self):
        rate = 2000
        head, tail = mc.fade_bounds(faded(rate, 2.0, 12.0, 3.0), rate)
        # A linear fade reaches half the body's level halfway through.
        self.assertAlmostEqual(head, 1.0, delta=0.15)
        self.assertAlmostEqual(tail, 1.5, delta=0.15)

    def test_a_piece_without_fades_loses_nothing(self):
        rate = 2000
        self.assertEqual(mc.fade_bounds(tone(14.0, rate), rate), (0.0, 0.0))

    def test_silence_is_left_alone(self):
        self.assertEqual(mc.fade_bounds(array.array("f", [0.0] * 4000), 1000), (0.0, 0.0))

    def test_trim_cuts_frames_not_samples(self):
        x = array.array("f", [0, 0, 1, 1, 2, 2, 3, 3, 4, 4])
        self.assertEqual(list(mc.trim(x, 2, 1, 2)), [1, 1, 2, 2])


class TheLoopSeam(unittest.TestCase):
    def test_the_loop_is_the_crossfade_shorter(self):
        x = array.array("f", range(100))
        self.assertEqual(len(mc.close_loop(x, 1, 20)), 80)
        stereo = array.array("f", [v for i in range(100) for v in (i, -i)])
        self.assertEqual(len(mc.close_loop(stereo, 2, 20)), 160)

    def test_the_wrap_follows_the_piece(self):
        # On a ramp, the loop's last sample is n-span-1 and its first is n-span:
        # the wrap is one ordinary step of the piece.
        x = array.array("f", range(100))
        loop = mc.close_loop(x, 1, 20)
        self.assertEqual(loop[-1], 79.0)
        self.assertEqual(loop[0], 80.0)
        self.assertEqual(loop[19], 19.0)  # the head itself at the end of the crossfade
        self.assertEqual(loop[20], 20.0)

    def test_equal_power_keeps_the_level_of_two_unrelated_signals(self):
        # The head is all on the left and the tail all on the right, so each
        # crossfaded frame holds the head's gain on one channel and the tail's
        # on the other: equal power is their squares summing to one at every
        # frame (a linear crossfade would sink to a half in the middle).
        n, span = 100, 20
        x = array.array("f", [0.5, 0.5] * n)
        for i in range(span):
            x[2 * i], x[2 * i + 1] = 1.0, 0.0
            tail = n - span + i
            x[2 * tail], x[2 * tail + 1] = 0.0, 1.0
        loop = mc.close_loop(x, 2, span)
        for i in range(span):
            head, tail = loop[2 * i], loop[2 * i + 1]
            self.assertAlmostEqual(head * head + tail * tail, 1.0, places=5)
        self.assertAlmostEqual(loop[1], 1.0, places=6)  # starts as the tail
        self.assertAlmostEqual(loop[2 * (span - 1)], 1.0, places=6)  # ends as the head

    def test_a_cut_piece_clicks_and_the_closed_loop_does_not(self):
        rate = 8000
        # 2.3 s of this tone ends a quarter cycle off: wrapped as it is, the seam jumps.
        x = tone(2.3, rate, hz=517.25 / 2.3, amp=0.8, phase=0.3)
        naive = mc.seam_score(x, 1, rate)
        closed = mc.seam_score(mc.close_loop(x, 1, int(0.5 * rate)), 1, rate)
        self.assertGreater(naive, 2.0)
        self.assertLess(closed, 1.05)

    def test_the_worse_channel_decides(self):
        rate = 8000
        left = tone(1.0, rate, hz=100.0)
        x = array.array("f")
        for i, value in enumerate(left):
            x.extend([value, value if i else 0.9])  # a click on the right only
        self.assertGreater(mc.seam_score(x, 2, rate), 2.0)

    def test_a_turned_loop_is_the_same_circle_started_later(self):
        x = array.array("f", [v for i in range(10) for v in (i, -i)])
        turned = mc.turn(x, 2, 3)
        self.assertEqual(list(turned[:4]), [3, -3, 4, -4])
        self.assertEqual(list(turned[-2:]), [2, -2])
        self.assertEqual(sorted(turned), sorted(x))
        self.assertEqual(list(mc.turn(x, 2, 10)), list(x))

    def test_percentile_by_nearest_rank(self):
        self.assertEqual(mc.percentile([5, 1, 4, 2, 3], 0.99), 5)
        self.assertEqual(mc.percentile([5, 1, 4, 2, 3], 0.4), 2)
        self.assertEqual(mc.percentile([], 0.5), 0.0)


class TheLoudness(unittest.TestCase):
    def test_a_loud_track_comes_down_to_the_target(self):
        self.assertEqual(mc.loudness_gain(-12.0, -0.5, -18.0, -1.5), -6.0)

    def test_a_quiet_one_comes_up_only_to_the_peak_ceiling(self):
        self.assertEqual(mc.loudness_gain(-24.0, -3.0, -18.0, -1.5), 1.5)

    def test_silence_gets_no_gain(self):
        self.assertEqual(mc.loudness_gain(float("-inf"), float("-inf")), 0.0)

    def test_the_report_is_read_off_ffmpegs_output(self):
        said = 'noise\n[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-23.40",\n\t"input_tp" : "-4.10",\n\t"input_lra" : "5.20"\n}\n'
        got = mc.parse_loudnorm(said)
        self.assertEqual((got["input_i"], got["input_tp"]), (-23.4, -4.1))


def _has_opus() -> bool:
    try:
        exe = mc.ffmpeg()
    except SystemExit:
        return False
    done = subprocess.run([exe, "-hide_banner", "-encoders"], capture_output=True)
    return b"libopus" in done.stdout


@unittest.skipUnless(_has_opus(), "no ffmpeg with libopus (PATH or imageio-ffmpeg)")
class TheWholeStep(unittest.TestCase):
    def test_a_faded_piece_becomes_a_level_loop_with_a_clean_seam(self):
        rate = 48000
        x = faded(rate, 2.0, 8.0, 2.0, channels=2)
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, "piece.wav")
            with wave.open(source, "wb") as out:
                out.setnchannels(2)
                out.setsampwidth(2)
                out.setframerate(rate)
                out.writeframes(array.array("h", (int(v * 32767) for v in x)).tobytes())
            with open(os.path.join(folder, "piece.json"), "w", encoding="utf-8") as handle:
                json.dump({"kind": "music", "prompt": "a calm test tone", "mode": "4 Hydrogen"}, handle)
            ogg = os.path.join(folder, "out", "piece.ogg")
            record = mc.convert(source, ogg, kbps=48, crossfade=1.0)
            self.assertTrue(os.path.exists(ogg))
            self.assertAlmostEqual(record["fade_in_cut"], 1.0, delta=0.2)
            self.assertAlmostEqual(record["loop_seconds"], 12.0 - 1.0 - 1.0 - 1.0, delta=0.3)
            self.assertLess(record["seam_loop"], 1.05)
            self.assertLess(record["seam_encoded"], 3.0)
            self.assertEqual(record["seam_encoded"], min(record["seam_turns"]))
            self.assertLess(abs(record["length_error_frames"]), 48000 * 0.05)
            self.assertAlmostEqual(record["lufs_out"], mc.LUFS, delta=1.5)
            self.assertEqual(record["delivery"]["prompt"], "a calm test tone")
            with open(os.path.join(folder, "out", "piece.json"), encoding="utf-8") as handle:
                self.assertEqual(json.load(handle)["sha256"], record["sha256"])


MUSIC = os.path.join(mc.ROOT, "assets", "sounds", "music")


@unittest.skipUnless(_has_opus(), "no ffmpeg with libopus (PATH or imageio-ffmpeg)")
class TheGameMusic(unittest.TestCase):
    def test_a_converted_track_plays_as_loud_as_the_music_the_game_ships(self):
        # 2026-11-18 review: at -18 LUFS a Gemini track played some 4 dB under
        # the themes soundgen made. One target for all of them.
        measured = []
        for name in sorted(os.listdir(MUSIC)):
            if name.endswith(".ogg"):
                x = mc.decode(os.path.join(MUSIC, name), mc.RATE, mc.CHANNELS)
                measured.append(float(mc.measure_loudness(x, mc.RATE, mc.CHANNELS)["input_i"]))
        self.assertTrue(measured)
        mean = sum(measured) / len(measured)
        self.assertAlmostEqual(mc.LUFS, mean, delta=1.5, msg="the game's music measures %s LUFS" % measured)


if __name__ == "__main__":
    unittest.main()
