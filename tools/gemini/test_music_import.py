"""music_import: the owner's picks into sounds.yaml, CREDITS.md and the manifest; the pools and the caves'
extra versions; one real import when ffmpeg is there."""

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
NL = chr(10)


MEASURES = {"seconds": 176.43, "body_end": 171.83, "entries": [10.0, 26.7, 53.4], "kbps": 48}


def entry(slot: str, takes: tuple[str, ...] = ("1",), provisional: bool = False, volume: float = 1.0,
          record: dict | None = None, extras: tuple[str, ...] = ()) -> mi.Entry:
    """A slot with a track for each take (and extra version), as run() leaves it."""
    tracks = [mi.Track(take, mi.sound_of(SLOT[slot], i, take), mi.file_of(SLOT[slot], take), volume,
                       "%s_%s.mp4" % (slot, take), MEASURES if record is None else record,
                       provisional or take in extras)
              for i, take in enumerate(takes + extras)]
    return mi.Entry(SLOT[slot], takes, provisional, tracks)


SOUNDS_YAML = """format: 1
sounds:
  hit: { file: sounds/sfx/hit.ogg, channel: sfx }
  # gemini-music:sounds:begin (make music-gemini)
  music_puerto: { file: sounds/music/puerto.ogg, channel: music, volume: 0.7 }
  # gemini-music:sounds:end
  amb_olas: { file: sounds/ambient/olas.ogg, channel: ambient, volume: 0.5 }
music:
  islands: { puerto: town_puerto }
  pools:
    # gemini-music:pools:begin
    # gemini-music:pools:end
    quest_shrine: [music_puerto]
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
    def test_they_are_read_as_takes_pools_or_none(self):
        # The shape of the owner's first picks (2026-11-18 09:05).
        self.assertEqual(
            mi.read_picks('{"_note": "x", "picks": {"title": "1", "town_puerto": ["1", "2", "3"], "volcan": 2, '
                          '"cave": "None", "combat": "off"}, "owner_requirements": {}}'),
            {"title": ("1",), "town_puerto": ("1", "2", "3"), "volcan": ("2",), "cave": (), "combat": ()})

    def test_the_caves_extra_versions_are_read_by_name(self):
        self.assertEqual(mi.read_picks('{"picks": {"cave": "1", "cave_pool": ["mine", "cave_crystal_1", "Ember_2"]}}'),
                         {"cave": ("1",), "cave_pool": ("mine_1", "crystal_1", "ember_2")})
        self.assertEqual(mi.read_picks('{"picks": {"cave_pool": "none"}}'), {"cave_pool": ()})
        for bad in ('{"picks": {"cave_pool": ["mine", "cave_mine_1"]}}', '{"picks": {"cave_pool": ["../x"]}}',
                    '{"picks": {"cave_pool": []}}'):
            with self.assertRaises(SystemExit, msg=bad):
                mi.read_picks(bad)

    def test_fights_only_take_none(self):
        # The owner (2026-11-18): an ordinary fight keeps the zone's music.
        with self.assertRaises(SystemExit):
            mi.read_picks('{"picks": {"combat": "1"}}')
        self.assertEqual(mi.choice("combat", {}), ((), False))
        self.assertEqual(mi.read_picks('{"_note": "empty until the owner picks", "picks": {}}'), {})
        self.assertEqual(mi.read_picks(""), {})

    def test_an_unknown_slot_or_take_is_refused(self):
        for bad in ('{"picks": {"tavern": "1"}}', '{"picks": {"title": "4"}}', '{"picks": ["title"]}',
                    '{"picks": {"title": []}}', '{"picks": {"title": ["1", "1"]}}',
                    '{"picks": {"title": ["1", "none"]}}'):
            with self.assertRaises(SystemExit, msg=bad):
                mi.read_picks(bad)

    def test_a_slot_not_picked_yet_plays_take_one_provisionally(self):
        self.assertEqual(mi.choice("title", {}), (("1",), True))
        self.assertEqual(mi.choice("title", {"title": ("2",)}), (("2",), False))
        self.assertEqual(mi.choice("cave", {"cave": ()}), ((), False))

    def test_a_pools_first_track_is_the_slots_sound(self):
        puerto = SLOT["town_puerto"]
        self.assertEqual([mi.sound_of(puerto, i, t) for i, t in enumerate(("2", "1", "3"))],
                         ["music_puerto", "music_puerto_1", "music_puerto_3"])
        cave = SLOT["cave"]
        self.assertEqual([mi.sound_of(cave, 1, "mine_1"), mi.sound_of(cave, 2, "mine_2")],
                         ["music_cueva_mine", "music_cueva_mine_2"])
        self.assertEqual(mi.file_of(cave, "mine_1"), "sounds/music/gemini/cave_mine_1.ogg")
        self.assertEqual(mi.extras_choice(cave, {}), (tuple("%s_1" % n for n in cave.extras), True))
        self.assertEqual(mi.extras_choice(cave, {"cave_pool": ("mine_1",)}), (("mine_1",), False))
        self.assertEqual(mi.extras_choice(SLOT["title"], {}), ((), False))
        self.assertEqual((mi.kbps_of(cave), mi.kbps_of(puerto)), (mi.AMBIENT_KBPS, mi.KBPS))
        self.assertEqual([mi.pick_text(t) for t in ((), ("2",), ("1", "3"))], ['"none"', '"2"', '["1", "3"]'])

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
            entry("title", ()),
            entry("town_puerto", ("1", "2", "3"), volume=0.96),
            entry("cave", ("1",), extras=("mine_1",)),
            entry("combat", ()),
            entry("boss_forge", ("2",)),
        ]

    def test_each_track_is_a_music_sound_with_its_measures(self):
        self.assertEqual(mi.sounds_lines(self.entries()), [
            "  music_puerto: { file: sounds/music/gemini/town_puerto_1.ogg, channel: music, volume: 0.96, "
            "seconds: 176.43, end: 171.83, entries: [10, 26.7, 53.4] }",
            "  music_puerto_2: { file: sounds/music/gemini/town_puerto_2.ogg, channel: music, volume: 0.96, "
            "seconds: 176.43, end: 171.83, entries: [10, 26.7, 53.4] }",
            "  music_puerto_3: { file: sounds/music/gemini/town_puerto_3.ogg, channel: music, volume: 0.96, "
            "seconds: 176.43, end: 171.83, entries: [10, 26.7, 53.4] }",
            "  music_cueva: { file: sounds/music/gemini/cave_1.ogg, channel: music, volume: 1, "
            "seconds: 176.43, end: 171.83, entries: [10, 26.7, 53.4] }",
            "  music_cueva_mine: { file: sounds/music/gemini/cave_mine_1.ogg, channel: music, volume: 1, "
            "seconds: 176.43, end: 171.83, entries: [10, 26.7, 53.4] }",
            "  music_boss_forge: { file: sounds/music/gemini/boss_forge_2.ogg, channel: music, volume: 1, "
            "seconds: 176.43, end: 171.83, entries: [10, 26.7, 53.4] }",
        ])

    def test_a_none_keeps_soundgens_loop_file(self):
        self.assertEqual(mi.sounds_lines([entry("cave", ())]), [
            "  music_cueva: { file: sounds/music/cueva.ogg, channel: music, volume: 0.8 }"
            "  # soundgen: the owner's pick is none"])
        self.assertEqual(mi.pools_lines([entry("cave", ())]), ["    cave: [music_cueva]"])

    def test_each_slot_with_music_is_a_pool_and_fights_have_none(self):
        self.assertEqual(mi.pools_lines(self.entries()), [
            "    town_puerto: [music_puerto, music_puerto_2, music_puerto_3]",
            "    cave: [music_cueva, music_cueva_mine]",
            "    boss_forge: [music_boss_forge]",
        ])

    def test_the_title_and_boss_rules_name_pools(self):
        # The title's pick is none and it had no music before Gemini: no rule, the menus
        # stay silent; the zones' rules are not the importer's.
        self.assertEqual(mi.rules_lines(self.entries()), ["  bosses: { slagbound_warden: boss_forge }"])
        self.assertEqual(mi.rules_lines([entry("title", ("1",))]), ["  title: title"])

    def test_the_blocks_are_rewritten_and_the_rest_kept(self):
        def write(text):
            text = mi.replace_block(text, "sounds", mi.sounds_lines(self.entries()))
            text = mi.replace_block(text, "pools", mi.pools_lines(self.entries()))
            return mi.replace_block(text, "rules", mi.rules_lines(self.entries()))

        text = write(SOUNDS_YAML)
        self.assertIn("  hit: { file: sounds/sfx/hit.ogg, channel: sfx }\n  # gemini-music:sounds:begin", text)
        self.assertNotIn("sounds/music/puerto.ogg", text)
        self.assertIn("    # gemini-music:pools:begin\n    town_puerto: [music_puerto, music_puerto_2, "
                      "music_puerto_3]\n", text)
        self.assertIn("    # gemini-music:pools:end\n    quest_shrine: [music_puerto]\n", text)  # a hand-made pool
        self.assertIn("  # gemini-music:rules:begin\n  bosses: { slagbound_warden: boss_forge }\n", text)
        self.assertIn("  # gemini-music:rules:end\nambient:", text)
        self.assertEqual(write(text), text)  # again with the same picks: the same file

    def test_a_file_without_the_marker_lines_is_refused(self):
        with self.assertRaises(SystemExit):
            mi.replace_block("sounds:\n  hit: {}\n", "sounds", [])


class TheCredits(unittest.TestCase):
    def test_the_music_rows_are_replaced_and_every_other_row_kept(self):
        rows = ["| `assets/sounds/music/gemini/title_1.ogg` | Gemini | 2026-11-17 | `p` | n |"]
        text = mi.credits_with(CREDITS_MD, rows)
        self.assertNotIn("gemini/old.ogg", text)
        self.assertIn("|---|---|---|---|---|\n| `assets/sounds/music/gemini/title_1.ogg`", text)
        self.assertIn("title_1.ogg` | Gemini | 2026-11-17 | `p` | n |\n| `assets/sprites/creatures/wolf", text)
        self.assertTrue(text.endswith("\n\nDespués de la tabla.\n"))
        self.assertEqual(mi.credits_with(text, rows), text)
        self.assertNotIn("gemini/title_1.ogg", mi.credits_with(text, []))

    def test_a_file_without_the_table_is_refused(self):
        with self.assertRaises(SystemExit):
            mi.credits_with("# Créditos\n", [])

    def test_the_note_says_what_it_is_and_whether_it_is_provisional(self):
        record = dict(MEASURES, source_seconds=176.5, delivery={"title": "Salt on the Altar"})
        title = entry("title", ("1",), True, record=record)
        note = mi.credit_note(title, title.tracks[0])
        self.assertIn("«Salt on the Altar» (título de Gemini)", note)
        self.assertIn("toma 1 del tema `title`", note)
        self.assertIn("Tema completo (2:56), Ogg Opus estéreo a 48 kbps, con 3 puntos de entrada", note)
        self.assertIn("Provisional", note)
        picked = entry("title", ("2",), record=record)
        self.assertNotIn("Provisional", mi.credit_note(picked, picked.tracks[0]))
        nameless = entry("town_puerto", ("2",), record={"delivery": {"title": "", "gemini_title": "output"}})
        self.assertIn("Sin título (Gemini no le dio uno): toma 2", mi.credit_note(nameless, nameless.tracks[0]))
        # A take's file is named after its title: such a name reads as that title again.
        self.assertEqual(mi.title_of({"gemini_title": "iron_in_the_deep"}), "Iron in the Deep")
        self.assertEqual(mi.title_of({"gemini_title": "the_sunless_vault"}), "The Sunless Vault")
        self.assertEqual(mi.title_of({"gemini_title": "beneath_the_blackened_ridge"}),
                         "Beneath the Blackened Ridge")
        self.assertEqual(mi.title_of({"gemini_title": "weight_of_the_mountain"}),
                         mi.title_of({"title": "Weight of the Mountain"}))
        self.assertEqual(mi.title_of({"gemini_title": "Salt-Stained Shore"}), "Salt-Stained Shore")
        self.assertEqual(mi.title_of({"gemini_title": "Output"}), "")
        pool = entry("town_puerto", ("1", "2", "3"), record=record)
        self.assertIn("uno de los 3 temas que alterna el director de música", mi.credit_note(pool, pool.tracks[2]))
        cave = entry("cave", ("1",), record=record, extras=("mine_1",))
        self.assertNotIn("Provisional", mi.credit_note(cave, cave.tracks[0]))
        extra = mi.credit_note(cave, cave.tracks[1])
        self.assertIn("versión `mine_1` del tema `cave`", extra)
        self.assertIn("Provisional", extra)

    def test_the_manifest_lists_every_track_of_a_slot(self):
        record = dict(MEASURES, lufs_out=-14.2, bytes=1100000, longest_quiet=0.3,
                      delivery={"title": "Shore", "started": "2026-11-17T22:00:00", "mode": "Hydrogen"})
        text = mi.manifest_text([entry("town_puerto", ("1", "3"), record=record), entry("cave", ())])
        self.assertIn("settings: { channels: 2, kbps: 48, ambient_kbps: 40, lufs: -14, true_peak: -1.5 }", text)
        self.assertIn(NL.join([
            '  town_puerto:', '    sound: "music_puerto"', '    pick: ["1", "3"]', '    provisional: false',
            '    file: "sounds/music/gemini/town_puerto_1.ogg"', '    volume: 1',
            '    fallback: "sounds/music/puerto.ogg"', '    pool: ["music_puerto", "music_puerto_3"]', '    tracks:',
            '      - take: "1"', '        sound: "music_puerto"',
        ]), text)
        self.assertIn(NL.join(['        seconds: 176.43', '        end: 171.83', '        entries: [10, 26.7, 53.4]']),
                      text)
        self.assertIn(NL.join(['      - take: "3"', '        sound: "music_puerto_3"',
                               '        file: "sounds/music/gemini/town_puerto_3.ogg"']), text)
        self.assertIn('        prompt: "prompts/sounds/music/gemini/town_puerto_3.txt"', text)
        self.assertIn(NL.join(['  cave:', '    sound: "music_cueva"', '    pick: "none"', '    provisional: false',
                               '    file: "sounds/music/cueva.ogg"', '    volume: 0.8',
                               '    fallback: "sounds/music/cueva.ogg"', '    pool: ["music_cueva"]']), text)
        extras = mi.manifest_text([entry("cave", ("1",), record=record, extras=("mine_1",))])
        self.assertIn('    extras: ["mine_1"]', extras)
        self.assertIn(NL.join(['      - take: "mine_1"', '        sound: "music_cueva_mine"',
                               '        file: "sounds/music/gemini/cave_mine_1.ogg"', '        volume: 1',
                               '        provisional: true']), extras)


def fake_import(root: str, sources: str, names: list[str], problems: dict[str, list[str]]):
    """Deliveries with sidecars, and a convert_take that writes a stand-in file with
    the measures of a whole take (or the ones `problems` gives a piece)."""
    os.makedirs(sources, exist_ok=True)
    for name in names:
        with open(os.path.join(sources, name + ".mp4"), "wb") as h:
            h.write(name.encode())
        with open(os.path.join(sources, name + ".json"), "w", encoding="utf-8") as h:
            json.dump({"kind": "music", "prompt": "Sparse cave drones for %s." % name, "mode": "Hydrogen",
                       "started": "2026-11-18T09:00:00", "title": name.title(), "refs": []}, h)

    def convert(source, work, kbps, fresh):
        stem = os.path.splitext(os.path.basename(source))[0]
        os.makedirs(work, exist_ok=True)
        out = os.path.join(work, stem + ".ogg")
        with open(out, "wb") as h:
            h.write(b"OggS" + stem.encode())
        with open(os.path.splitext(source)[0] + ".json", encoding="utf-8") as h:
            delivery = json.load(h)
        bad = problems.get(stem)
        record = dict(MEASURES, kbps=kbps, channels=2, lufs_out=-14.0, bytes=8, source_seconds=176.43,
                      lufs_in=-12.0, longest_quiet=0.0, delivery=delivery)
        if bad:
            record.update(source_seconds=40.0, entries=[])
        return out, record

    return convert


class TheCaves(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, "assets"))
        with open(os.path.join(self.root, "assets", "sounds.yaml"), "w", encoding="utf-8") as h:
            h.write(SOUNDS_YAML)
        with open(os.path.join(self.root, "assets", "CREDITS.md"), "w", encoding="utf-8") as h:
            h.write(CREDITS_MD)
        self.sources = os.path.join(self.root, "build", "music-gemini")
        self.convert = mi.convert_take

    def tearDown(self):
        mi.convert_take = self.convert
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def run_with(self, picks, problems=None):
        names = ["cave_1", "cave_mine_1", "cave_crystal_1", "cave_ember_1"]
        mi.convert_take = fake_import(self.root, self.sources, names, problems or {})
        others = {slot.id: () for slot in mi.SLOTS if slot.id != "cave"}
        return {e.slot.id: e for e in mi.run(self.root, self.sources, dict(others, **picks))}["cave"]

    def test_unpicked_versions_that_pass_ship_provisionally_and_the_others_are_left_out(self):
        cave = self.run_with({"cave": ("1",)}, {"cave_ember_1": ["short"]})
        self.assertEqual([t.take for t in cave.tracks], ["1", "mine_1", "crystal_1"])
        self.assertEqual([t.provisional for t in cave.tracks], [False, True, True])
        self.assertEqual(cave.pool, ["music_cueva", "music_cueva_mine", "music_cueva_crystal"])
        left = " ".join(cave.skipped)
        self.assertIn("ember_1", left)  # failed its measures
        self.assertIn("flooded_1: no cave_flooded_1.mp4", left)  # not delivered
        with open(os.path.join(self.root, "assets", "sounds.yaml"), encoding="utf-8") as h:
            sounds = h.read()
        self.assertIn("    cave: [music_cueva, music_cueva_mine, music_cueva_crystal]\n", sounds)
        with open(os.path.join(self.root, "assets", "CREDITS.md"), encoding="utf-8") as h:
            credits = h.read()
        row = next(line for line in credits.split("\n") if "cave_mine_1.ogg" in line)
        self.assertIn("Provisional", row)

    def test_the_owners_list_ships_as_picked(self):
        cave = self.run_with({"cave": ("1",), "cave_pool": ("crystal_1",)})
        self.assertEqual([(t.take, t.provisional) for t in cave.tracks], [("1", False), ("crystal_1", False)])
        self.assertFalse(os.path.exists(os.path.join(self.root, "assets", "sounds", "music", "gemini", "cave_mine_1.ogg")))

    def test_a_listed_version_that_is_not_there_is_refused(self):
        with self.assertRaises(SystemExit):
            self.run_with({"cave": ("1",), "cave_pool": ("flooded_1",)})

    def test_no_cave_pick_ships_no_extra_version(self):
        cave = self.run_with({"cave": ()})
        self.assertEqual(cave.tracks, [])
        self.assertEqual(cave.pool, ["music_cueva"])


def write_piece(path: str, seconds: float, rate: int = 48000) -> None:
    """A stereo beat as a WAV (named .mp4 like a delivery: ffmpeg reads the content)."""
    x = clicks(seconds, rate, 0.5, amp=0.5)
    with wave.open(path, "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(array.array("h", (int(max(-1.0, min(1.0, v)) * 32767) for v in x for _ in (0, 1))).tobytes())


@unittest.skipUnless(_has_opus(), "no ffmpeg with libopus (PATH or imageio-ffmpeg)")
class TheReuse(unittest.TestCase):
    RECORD = {"kbps": 48, "channels": mi.CHANNELS, "analysis": mc.ANALYSIS, "lufs_target": mc.LUFS,
              "true_peak_ceiling": mc.TRUE_PEAK}

    def test_a_piece_measured_with_other_entry_settings_is_converted_again(self):
        now = mc.entry_settings()
        self.assertTrue(mi._settings_match(dict(self.RECORD, entry_settings=now), 48))
        self.assertFalse(mi._settings_match(dict(self.RECORD, entry_settings=dict(now, most=now["most"] - 2)), 48))
        gap = mc.ENTRY_GAP
        try:
            mc.ENTRY_GAP = gap + 5  # raised in music_convert.py: every piece is measured again
            self.assertFalse(mi._settings_match(dict(self.RECORD, entry_settings=now), 48))
        finally:
            mc.ENTRY_GAP = gap
        # A record of before they were kept was measured with the settings of ANALYSIS 1.
        self.assertEqual(mi._settings_match(self.RECORD, 48), now == mi.ENTRY_SETTINGS_1)

    def test_other_settings_are_converted_again_too(self):
        now = dict(self.RECORD, entry_settings=mc.entry_settings())
        self.assertFalse(mi._settings_match(now, 40))
        self.assertFalse(mi._settings_match(dict(now, analysis=mc.ANALYSIS - 1), 48))


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
            others = {slot.id: () for slot in mi.SLOTS if slot.id != "title"}

            entries = mi.run(root, sources, others, kbps=24)
            title = entries[0]
            self.assertEqual((title.takes, title.provisional, title.plays[0]),
                             (("1",), True, "sounds/music/gemini/title_1.ogg"))
            self.assertAlmostEqual(title.tracks[0].record["seconds"], 12.0, delta=0.05)  # whole
            ogg = os.path.join(root, "assets", "sounds", "music", "gemini", "title_1.ogg")
            self.assertTrue(os.path.exists(ogg))
            prompt = os.path.join(root, "assets", "prompts", "sounds", "music", "gemini", "title_1.txt")
            with open(prompt, encoding="utf-8") as h:
                self.assertIn("A calm test beat for the main menu.", h.read())
            with open(os.path.join(root, "assets", "sounds.yaml"), encoding="utf-8") as h:
                sounds = h.read()
            self.assertIn("  music_title: { file: sounds/music/gemini/title_1.ogg, channel: music, volume: ", sounds)
            self.assertIn("seconds: 12, end: ", sounds)
            self.assertIn("  music_puerto: { file: sounds/music/puerto.ogg, channel: music, volume: 0.7 }", sounds)
            self.assertIn("    title: [music_title]\n", sounds)
            self.assertIn("  title: title\n", sounds)
            with open(os.path.join(root, "assets", "CREDITS.md"), encoding="utf-8") as h:
                credits = h.read()
            self.assertIn("| `assets/sounds/music/gemini/title_1.ogg` | Gemini, app web con la cuenta del dueño (modo Hydrogen) "
                          "| 2026-11-17 | `assets/prompts/sounds/music/gemini/title_1.txt` | «Test Beat»", credits)
            self.assertNotIn("gemini.google.com", credits)
            with open(os.path.join(root, "assets", "sounds", "music", "gemini.yaml"), encoding="utf-8") as h:
                manifest = h.read()
            self.assertIn('  title:\n    sound: "music_title"\n    pick: "1"\n    provisional: true\n', manifest)
            self.assertIn('        title: "Test Beat"\n', manifest)
            self.assertIn('  cave:\n    sound: "music_cueva"\n    pick: "none"\n    provisional: false\n'
                          '    file: "sounds/music/cueva.ogg"\n    volume: 0.8\n', manifest)
            self.assertNotIn("gemini.google.com", manifest)
            self.assertTrue(math.isfinite(title.plays[1]) and 0 < title.plays[1] <= 1)

            # The same picks again: nothing is converted again.
            convert = mi.music_convert.convert

            def refuse(*_args, **_kwargs):
                raise AssertionError("converted again")

            try:
                mi.music_convert.convert = refuse
                mi.run(root, sources, others, kbps=24)
            finally:
                mi.music_convert.convert = convert

            # The owner says none: the title screen has no music of its own any more.
            mi.run(root, sources, dict(others, title=()), kbps=24)
            self.assertFalse(os.path.exists(ogg))
            self.assertFalse(os.path.exists(prompt))
            with open(os.path.join(root, "assets", "sounds.yaml"), encoding="utf-8") as h:
                sounds = h.read()
            self.assertNotIn("music_title", sounds)
            with open(os.path.join(root, "assets", "CREDITS.md"), encoding="utf-8") as h:
                credits = h.read()
            self.assertNotIn("gemini/title_1.ogg", credits)
            self.assertIn("wolf/walk_s_0.png", credits)

    def test_a_missing_take_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(SystemExit):
                mi.run(root, os.path.join(root, "nowhere"), {})


if __name__ == "__main__":
    unittest.main()
