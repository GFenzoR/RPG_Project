"""music_import: the owner's picks into sounds.yaml, CREDITS.md and the manifest; one real import when ffmpeg is there."""

from __future__ import annotations

import array
import json
import math
import os
import tempfile
import unittest
import wave

import music_convert as mc
import music_import as mi
from test_music_convert import _has_opus, clicks

SLOT = {slot.id: slot for slot in mi.SLOTS}


def entry(slot: str, pick: str = "1", provisional: bool = False, file: str = "", volume: float = 1.0,
          source: str = "", record: dict | None = None) -> mi.Entry:
    return mi.Entry(SLOT[slot], pick, provisional, file, volume, source, record or {})


SOUNDS_YAML = """format: 1
sounds:
  hit: { file: sounds/sfx/hit.ogg, channel: sfx }
  # gemini-music:sounds:begin (make music-gemini)
  music_puerto: { file: sounds/music/puerto.ogg, channel: music, volume: 0.7 }
  # gemini-music:sounds:end
  amb_olas: { file: sounds/ambient/olas.ogg, channel: ambient, volume: 0.5 }
music:
  islands: { puerto: music_puerto }
  combat_hold_ms: 8000
  # gemini-music:rules:begin
  # gemini-music:rules:end
ambient:
  islands: { puerto: amb_olas }
"""

CREDITS_MD = """# Créditos

## Generado con IA

Texto.

| Archivos | Herramienta | Fecha | Prompt | Notas |
|---|---|---|---|---|
| `assets/sprites/creatures/wolf/walk_s_0.png` | Gemini | 2026-11-18 | `assets/prompts/sprites/creatures/wolf.txt` | — |
| `assets/sounds/music/gemini/old.ogg` | Gemini | 2026-11-17 | `assets/prompts/sounds/music/gemini/old.txt` | — |

Después de la tabla.
"""


class ThePicks(unittest.TestCase):
    def test_they_are_read_as_takes_or_none(self):
        self.assertEqual(mi.read_picks('{"picks": {"title": 2, "cave": "None", "combat": " 3 "}}'),
                         {"title": "2", "cave": "none", "combat": "3"})
        self.assertEqual(mi.read_picks('{"_note": "empty until the owner picks", "picks": {}}'), {})
        self.assertEqual(mi.read_picks(""), {})

    def test_an_unknown_slot_or_take_is_refused(self):
        with self.assertRaises(SystemExit):
            mi.read_picks('{"picks": {"tavern": "1"}}')
        with self.assertRaises(SystemExit):
            mi.read_picks('{"picks": {"title": "4"}}')
        with self.assertRaises(SystemExit):
            mi.read_picks('{"picks": ["title"]}')

    def test_a_slot_not_picked_yet_plays_take_one_provisionally(self):
        self.assertEqual(mi.choice("title", {}), ("1", True))
        self.assertEqual(mi.choice("title", {"title": "2"}), ("2", False))
        self.assertEqual(mi.choice("cave", {"cave": "none"}), ("none", False))

    def test_takes_are_found_by_name_or_alias(self):
        self.assertEqual(mi.source_name("title", "2"), "title_2")
        self.assertEqual(mi.source_name("town_puerto", "3"), "probe_1")
        self.assertEqual(mi.source_name("town_puerto", "1"), "town_puerto_1")

    def test_every_slot_of_the_asks_has_a_place_in_the_game(self):
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "music_slots.json"), encoding="utf-8") as h:
            asked = [slot["id"] for slot in json.load(h)["slots"]]
        self.assertEqual(sorted(asked), sorted(SLOT))
        self.assertEqual(len({slot.sound for slot in mi.SLOTS}), len(mi.SLOTS))


class TheVolume(unittest.TestCase):
    def test_a_loop_at_the_target_plays_at_the_base_volume(self):
        self.assertEqual(mi.volume_for(mc.LUFS), mi.BASE_VOLUME)

    def test_a_quieter_loop_is_turned_up_until_one(self):
        self.assertEqual(mi.volume_for(mc.LUFS - 2.0), round(mi.BASE_VOLUME * 10 ** 0.1, 2))
        self.assertEqual(mi.volume_for(-19.5), 1.0)

    def test_a_louder_one_is_turned_down_and_an_unmeasured_one_left_at_the_base(self):
        self.assertLess(mi.volume_for(-10.0), mi.BASE_VOLUME)
        self.assertEqual(mi.volume_for(None), mi.BASE_VOLUME)
        self.assertEqual(mi.volume_for(float("-inf")), mi.BASE_VOLUME)

    def test_volumes_are_written_like_sounds_yaml_does(self):
        self.assertEqual([mi.number(v) for v in (0.7, 0.75, 1.0, 0.8)], ["0.7", "0.75", "1", "0.8"])


class TheSoundsYaml(unittest.TestCase):
    def entries(self):
        return [
            entry("title", "none"),
            entry("town_puerto", "2", file="sounds/music/gemini/town_puerto.ogg", volume=0.96, source="town_puerto_2.mp4"),
            entry("cave", "none", file="sounds/music/cueva.ogg", volume=0.8),
            entry("combat", "1", True, "sounds/music/gemini/combat.ogg", 1.0, "combat_1.mp4"),
            entry("boss_forge", "3", file="sounds/music/gemini/boss_forge.ogg", source="boss_forge_3.mp4"),
        ]

    def test_each_slot_with_music_is_a_music_sound(self):
        self.assertEqual(mi.sounds_lines(self.entries()), [
            "  music_puerto: { file: sounds/music/gemini/town_puerto.ogg, channel: music, volume: 0.96 }",
            "  music_cueva: { file: sounds/music/cueva.ogg, channel: music, volume: 0.8 }"
            "  # soundgen: the owner's pick is none",
            "  music_combat: { file: sounds/music/gemini/combat.ogg, channel: music, volume: 1 }",
            "  music_boss_forge: { file: sounds/music/gemini/boss_forge.ogg, channel: music, volume: 1 }",
        ])

    def test_the_title_fight_and_boss_rules_follow_what_plays(self):
        # The title's pick is none and it had no music before Gemini: no rule, the menus
        # stay silent; the zones' rules are not the importer's.
        self.assertEqual(mi.rules_lines(self.entries()), [
            "  combat: music_combat",
            "  bosses: { slagbound_warden: music_boss_forge }",
        ])

    def test_the_blocks_are_rewritten_and_the_rest_kept(self):
        text = mi.replace_block(SOUNDS_YAML, "sounds", mi.sounds_lines(self.entries()))
        text = mi.replace_block(text, "rules", mi.rules_lines(self.entries()))
        self.assertIn("  hit: { file: sounds/sfx/hit.ogg, channel: sfx }\n  # gemini-music:sounds:begin", text)
        self.assertIn("music_combat: { file: sounds/music/gemini/combat.ogg", text)
        self.assertNotIn("sounds/music/puerto.ogg", text)
        self.assertIn("  # gemini-music:rules:begin\n  combat: music_combat\n", text)
        self.assertIn("  # gemini-music:rules:end\nambient:", text)
        # Again with the same picks: the same file.
        again = mi.replace_block(text, "sounds", mi.sounds_lines(self.entries()))
        self.assertEqual(mi.replace_block(again, "rules", mi.rules_lines(self.entries())), text)

    def test_a_file_without_the_marker_lines_is_refused(self):
        with self.assertRaises(SystemExit):
            mi.replace_block("sounds:\n  hit: {}\n", "sounds", [])


class TheCredits(unittest.TestCase):
    def test_the_music_rows_are_replaced_and_every_other_row_kept(self):
        rows = ["| `assets/sounds/music/gemini/title.ogg` | Gemini | 2026-11-17 | `p` | n |"]
        text = mi.credits_with(CREDITS_MD, rows)
        self.assertNotIn("gemini/old.ogg", text)
        self.assertIn("|---|---|---|---|---|\n| `assets/sounds/music/gemini/title.ogg`", text)
        self.assertIn("title.ogg` | Gemini | 2026-11-17 | `p` | n |\n| `assets/sprites/creatures/wolf", text)
        self.assertTrue(text.endswith("\n\nDespués de la tabla.\n"))
        self.assertEqual(mi.credits_with(text, rows), text)
        self.assertNotIn("gemini/title.ogg", mi.credits_with(text, []))

    def test_a_file_without_the_table_is_refused(self):
        with self.assertRaises(SystemExit):
            mi.credits_with("# Créditos\n", [])

    def test_the_note_says_what_it_is_and_whether_it_is_provisional(self):
        record = {"source_seconds": 176.5, "loop_seconds": 63.8, "delivery": {"title": "Salt on the Altar"}}
        note = mi.credit_note(entry("title", "1", True, record=record), 20)
        self.assertIn("«Salt on the Altar» (título de Gemini)", note)
        self.assertIn("toma 1 del tema `title`", note)
        self.assertIn("Loop de 64 s de los 2:56", note)
        self.assertIn("Provisional", note)
        self.assertNotIn("Provisional", mi.credit_note(entry("title", "2", record=record), 20))


def write_piece(path: str, seconds: float, rate: int = 48000) -> None:
    """A stereo beat as a WAV (named .mp4 like a delivery: ffmpeg reads the content)."""
    x = clicks(seconds, rate, 0.5, amp=0.5)
    with wave.open(path, "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(array.array("h", (int(max(-1.0, min(1.0, v)) * 32767) for v in x for _ in (0, 1))).tobytes())


@unittest.skipUnless(_has_opus(), "no ffmpeg with libopus (PATH or imageio-ffmpeg)")
class TheImport(unittest.TestCase):
    def test_a_pick_comes_in_credited_and_none_takes_it_out(self):
        with tempfile.TemporaryDirectory() as root:
            sources = os.path.join(root, "build", "music-gemini")
            os.makedirs(sources)
            os.makedirs(os.path.join(root, "assets"))
            with open(os.path.join(root, "assets", "sounds.yaml"), "w", encoding="utf-8") as h:
                h.write(SOUNDS_YAML)
            with open(os.path.join(root, "assets", "CREDITS.md"), "w", encoding="utf-8") as h:
                h.write(CREDITS_MD)
            write_piece(os.path.join(sources, "title_1.mp4"), 12.0)
            with open(os.path.join(sources, "title_1.json"), "w", encoding="utf-8") as h:
                json.dump({"kind": "music", "prompt": "A calm test beat for the main menu.", "mode": "Hydrogen",
                           "started": "2026-11-17T22:52:46", "title": "Test Beat", "refs": [],
                           "url": "https://gemini.google.com/app/private"}, h)
            others = {slot.id: "none" for slot in mi.SLOTS if slot.id != "title"}

            entries = mi.run(root, sources, others, kbps=24, max_seconds=6.0)
            title = entries[0]
            self.assertEqual((title.pick, title.provisional, title.file), ("1", True, "sounds/music/gemini/title.ogg"))
            self.assertAlmostEqual(title.record["loop_seconds"], 6.0, delta=1.6)
            self.assertTrue(os.path.exists(os.path.join(root, "assets", "sounds", "music", "gemini", "title.ogg")))
            prompt = os.path.join(root, "assets", "prompts", "sounds", "music", "gemini", "title.txt")
            with open(prompt, encoding="utf-8") as h:
                self.assertIn("A calm test beat for the main menu.", h.read())
            with open(os.path.join(root, "assets", "sounds.yaml"), encoding="utf-8") as h:
                sounds = h.read()
            self.assertIn("  music_title: { file: sounds/music/gemini/title.ogg, channel: music, volume: ", sounds)
            self.assertIn("  music_puerto: { file: sounds/music/puerto.ogg, channel: music, volume: 0.7 }", sounds)
            self.assertIn("  title: music_title\n", sounds)
            with open(os.path.join(root, "assets", "CREDITS.md"), encoding="utf-8") as h:
                credits = h.read()
            self.assertIn("| `assets/sounds/music/gemini/title.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) "
                          "| 2026-11-17 | `assets/prompts/sounds/music/gemini/title.txt` | «Test Beat»", credits)
            self.assertNotIn("gemini.google.com", credits)
            with open(os.path.join(root, "assets", "sounds", "music", "gemini.yaml"), encoding="utf-8") as h:
                manifest = h.read()
            self.assertIn('  title:\n    sound: "music_title"\n    pick: "1"\n    provisional: true\n', manifest)
            self.assertIn('    title: "Test Beat"\n', manifest)
            self.assertIn('  cave:\n    sound: "music_cueva"\n    pick: "none"\n    provisional: false\n'
                          '    file: "sounds/music/cueva.ogg"\n    volume: 0.8\n', manifest)
            self.assertNotIn("gemini.google.com", manifest)
            self.assertTrue(math.isfinite(title.volume) and 0 < title.volume <= 1)

            # The same picks again: nothing is converted again.
            convert = mi.music_convert.convert

            def refuse(*_args, **_kwargs):
                raise AssertionError("converted again")

            try:
                mi.music_convert.convert = refuse
                mi.run(root, sources, others, kbps=24, max_seconds=6.0)
            finally:
                mi.music_convert.convert = convert

            # The owner says none: the title screen has no music of its own any more.
            mi.run(root, sources, dict(others, title="none"), kbps=24, max_seconds=6.0)
            self.assertFalse(os.path.exists(os.path.join(root, "assets", "sounds", "music", "gemini", "title.ogg")))
            self.assertFalse(os.path.exists(prompt))
            with open(os.path.join(root, "assets", "sounds.yaml"), encoding="utf-8") as h:
                sounds = h.read()
            self.assertNotIn("music_title", sounds)
            with open(os.path.join(root, "assets", "CREDITS.md"), encoding="utf-8") as h:
                credits = h.read()
            self.assertNotIn("gemini/title.ogg", credits)
            self.assertIn("wolf/walk_s_0.png", credits)

    def test_a_missing_take_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(SystemExit):
                mi.run(root, os.path.join(root, "nowhere"), {})


if __name__ == "__main__":
    unittest.main()
