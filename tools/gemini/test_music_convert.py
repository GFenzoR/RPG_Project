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


def clicks(seconds: float, rate: int, every: float, amp: float = 0.8, seed: int = 7):
    """Short decaying noise bursts every `every` seconds over a faint hiss: a beat."""
    import random

    noise = random.Random(seed)
    out = array.array("f", (0.01 * (noise.random() - 0.5) for _ in range(int(seconds * rate))))
    burst = int(0.03 * rate)
    beat = 0.0
    while beat < seconds:
        start = int(beat * rate)
        for i in range(min(burst, len(out) - start)):
            out[start + i] += amp * (1.0 - i / burst) * (noise.random() - 0.5)
        beat += every
    return out


class TheLoopLength(unittest.TestCase):
    def test_the_envelope_is_the_level_in_db_hop_by_hop(self):
        levels = mc.envelope(array.array("f", [0.5] * 400), 1000, hop=0.1)
        self.assertEqual(len(levels), 4)
        for level in levels:
            self.assertAlmostEqual(level, 20 * math.log10(0.5), places=3)

    def test_onsets_are_the_rises_only(self):
        self.assertEqual(mc.onset_curve([-20.0, -10.0, -10.0, -30.0, -25.0]), [0.0, 10.0, 0.0, 0.0, 5.0])

    def test_correlation(self):
        self.assertAlmostEqual(mc.correlation([1, 2, 3, 4], [2, 4, 6, 8]), 1.0)
        self.assertAlmostEqual(mc.correlation([1, 2, 3, 4], [4, 3, 2, 1]), -1.0)
        self.assertEqual(mc.correlation([1, 1, 1], [1, 2, 3]), 0.0)

    def test_a_beat_falls_on_a_beat(self):
        # Beats every 0.5 s: of the lengths between 10.13 and 12.37 s, the cut lays
        # a beat over a beat only at a whole number of beats, and the longest wins.
        rate = 8000
        length, score = mc.loop_length(clicks(16.0, rate, 0.5), rate, 10.13, 12.37, 2.0)
        self.assertAlmostEqual(length, 12.0, delta=0.011)
        self.assertGreater(score, 1.0)

    def test_the_level_after_the_cut_matches_the_head(self):
        # Loud for 15 s, then 20 dB down: a cut whose next 2 s are quiet would fold a
        # quiet tail over a loud head; the length stays where the music is as loud.
        rate = 4000
        loud = clicks(15.0, rate, 0.37, amp=0.6, seed=1)
        quiet = clicks(15.0, rate, 0.37, amp=0.06, seed=2)
        length, _score = mc.loop_length(loud + quiet, rate, 8.0, 20.0, 2.0)
        self.assertLessEqual(length, 13.0)

    def test_a_piece_too_short_for_the_range_loops_as_far_as_it_can(self):
        rate = 2000
        length, score = mc.loop_length(tone(6.0, rate), rate, 8.0, 10.0, 2.0)
        self.assertAlmostEqual(length, 4.0, delta=0.011)
        self.assertEqual(score, 0.0)


def phrases(seconds: float, hop: float, every: float, rest: float, loud: float = -12.0, quiet: float = -40.0):
    """A level envelope (dB, one per hop): `every` seconds of music, the last
    `rest` of them a breath `quiet` dB down, over and over."""
    out = []
    for i in range(int(round(seconds / hop))):
        t = (i * hop) % every
        out.append(quiet if t >= every - rest else loud)
    return out


class TheEntryPoints(unittest.TestCase):
    def test_they_fall_where_a_phrase_begins_after_a_breath(self):
        # Phrases of 8 s with a 1 s breath at their end: each phrase starts at a multiple of 8.
        levels = phrases(180.0, 0.1, 8.0, 1.0)
        entries = mc.entry_points(levels, 0.1, 0.0, 180.0)
        self.assertGreaterEqual(len(entries), 4)
        for e in entries:
            self.assertAlmostEqual(e / 8.0, round(e / 8.0), delta=0.02, msg=entries)

    def test_never_at_the_start_nor_in_the_last_seconds_and_spaced(self):
        levels = phrases(180.0, 0.1, 8.0, 1.0)
        entries = mc.entry_points(levels, 0.1, 0.0, 170.0)
        self.assertGreaterEqual(entries[0], mc.ENTRY_HEAD)
        self.assertLessEqual(entries[-1], 170.0 - mc.ENTRY_TAIL)
        for a, b in zip(entries, entries[1:]):
            self.assertGreaterEqual(b - a, mc.ENTRY_GAP - 1e-6)
        self.assertLessEqual(len(entries), mc.ENTRY_MOST)
        self.assertEqual(entries, sorted(entries))

    def test_a_steady_drone_still_gets_places_to_start(self):
        entries = mc.entry_points([-20.0] * 1800, 0.1, 0.0, 180.0)
        self.assertGreaterEqual(len(entries), 2)

    def test_never_where_the_music_is_a_hole(self):
        # 60 s of music, 20 s of near silence, 100 s of music: no entry inside the hole.
        levels = [-15.0] * 600 + [-60.0] * 200 + [-15.0] * 1000
        for e in mc.entry_points(levels, 0.1, 0.0, 180.0):
            self.assertFalse(59.0 <= e < 80.0, e)

    def test_a_short_piece_has_none(self):
        self.assertEqual(mc.entry_points([-15.0] * 390, 0.1, 0.0, 39.0), [])  # 30 s after 10 s: none fit
        self.assertEqual(mc.entry_points([], 0.1, 0.0, 0.0), [])

    def test_the_longest_hole_is_measured_against_the_body(self):
        levels = [-15.0] * 600 + [-60.0] * 70 + [-15.0] * 300
        self.assertAlmostEqual(mc.longest_quiet(levels, 0.1, 0.0, 97.0), 7.0, delta=0.11)
        self.assertEqual(mc.longest_quiet([-15.0] * 100, 0.1, 0.0, 10.0), 0.0)

    def test_a_piece_passes_its_measures_or_says_why_not(self):
        good = {"source_seconds": 176.0, "lufs_in": -12.0, "longest_quiet": 0.5, "entries": [12.0, 40.0, 70.0]}
        self.assertEqual(mc.piece_problems(good), [])
        bad = mc.piece_problems({"source_seconds": 60.0, "lufs_in": float("-inf"), "longest_quiet": 9.0,
                                 "entries": [12.0]})
        self.assertEqual(len(bad), 4)
        self.assertIn("60 s long", bad[0])


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

    def test_a_whole_piece_is_kept_whole_with_its_measures(self):
        rate = 48000
        x = faded(rate, 0.5, 58.0, 4.0, channels=2)
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, "piece.wav")
            with wave.open(source, "wb") as out:
                out.setnchannels(2)
                out.setsampwidth(2)
                out.setframerate(rate)
                out.writeframes(array.array("h", (int(v * 32767) for v in x)).tobytes())
            record = mc.convert(source, os.path.join(folder, "piece.ogg"), kbps=48, channels=2, loop=False)
            self.assertAlmostEqual(record["seconds"], 62.5, delta=0.05)
            self.assertAlmostEqual(record["body_end"], 62.5 - 2.0, delta=0.2)  # half of the 4 s fade
            self.assertEqual(record["analysis"], mc.ANALYSIS)
            for e in record["entries"]:
                self.assertTrue(mc.ENTRY_HEAD <= e <= record["body_end"] - mc.ENTRY_TAIL, record["entries"])
            self.assertEqual(record["longest_quiet"], 0.0)
            self.assertNotIn("loop_seconds", record)
            self.assertEqual(record["channels"], 2)
            self.assertAlmostEqual(record["lufs_out"], mc.LUFS, delta=1.5)

    def test_a_long_piece_loops_over_its_first_seconds_in_mono(self):
        rate = 48000
        x = clicks(20.0, rate, 0.5, amp=0.5)
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, "beat.wav")
            with wave.open(source, "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(rate)
                out.writeframes(array.array("h", (int(max(-1.0, min(1.0, v)) * 32767) for v in x)).tobytes())
            record = mc.convert(source, os.path.join(folder, "beat.ogg"), kbps=24, channels=1, crossfade=1.0,
                                max_seconds=8.0)
            # A whole number of beats between 6 and 8 s, the longest.
            self.assertAlmostEqual(record["excerpt_seconds"], 8.0, delta=0.011)
            self.assertAlmostEqual(record["loop_seconds"], record["excerpt_seconds"], delta=0.001)
            self.assertEqual(record["channels"], 1)
            self.assertLess(record["seam_encoded"], 3.0)
            self.assertLess(abs(record["length_error_frames"]), 48000 * 0.05)


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
