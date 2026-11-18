"""Puts the owner's picks of Gemini music in the game: `make music-gemini`.

The main session asked Gemini for two or three takes of each place that has
music (`music_slots.json`, 2026-11-17, `build/music-gemini/<slot>_<n>.mp4` with
their sidecars), and six more versions of the caves on 2026-11-18
(`cave_<name>_1.mp4`); the owner listens and his picks land in
`build/music-gemini/picks.json`:

    {"picks": {"title": "2", "town_puerto": ["1", "2", "3"], "combat": "off",
               "cave": "1", "cave_pool": ["mine", "crystal"]}}

One command then does the rest, every time from the picks, so swapping a pick
is editing that file and running it again:

- **A take** ("1", "2", "3") plays in its slot. **A pool** (a list of takes)
  ships every take of it: the first is the slot's sound (`music_puerto`), the
  others are sounds of their own (`music_puerto_2`...), and the client's music
  director shuffles them (`client/src/audio/director.ts`).
- **The caves' extra versions** (`cave_pool`: names like "mine" or
  "cave_mine_1") join the cave's pool after its pick. Until the owner lists
  them, every version of `Slot.extras` whose take passes the measures
  (`music_convert.piece_problems`) ships, marked `provisional`.
- **A slot that is missing is not picked yet**: its take 1 plays, marked
  `provisional` (in the manifest and in its CREDITS.md row).
- **`none` (or `off`) keeps what played before Gemini**: the soundgen theme of
  that place (`fallback`), or no music of its own where there was none (the
  title screen, the forge's boss: the zone's music plays on). **Fights have
  no music** (the owner, 2026-11-18): `combat` only takes `none`/`off`.
- **Each take ships whole** (the owner, 2026-11-18: a one-minute loop is the
  monotony he does not want): `music_convert` (`loop=False`) turns it into
  Ogg Opus stereo at `KBPS` (`AMBIENT_KBPS` for a slot marked `ambient`, the
  caves), one gain to -14 LUFS under the peak ceiling, and measures where it
  may start (`entries`), where its body ends (`end`) and its holes, into
  `build/gemini/music-import/`; the `.ogg` is copied to
  `assets/sounds/music/gemini/<file>.ogg`. A take already converted with the
  same settings is not converted again. The client streams it (docs/07
  "Audio").
- **`assets/sounds.yaml`** gets its music sounds (with `seconds`, `end` and
  `entries`), the pool of each slot (`music.pools`) and the title and boss
  rules, between its `# gemini-music:sounds:…`, `:pools:…` and `:rules:…`
  marker lines; the rest of it is not touched. The volume makes up for the
  gain the peak ceiling took (`volume_for`).
- **Each take is credited**: its prompt file
  (`assets/prompts/sounds/music/gemini/<file>.txt`, `credit.prompt_text`) and
  its row in `assets/CREDITS.md`, "Generado con IA" (`credit.credits_row`).
- **`assets/sounds/music/gemini.yaml`** says what each slot has: the pick, the
  tracks with their source and the title Gemini gave them, whether each is
  provisional, and its measures (length, entries, loudness, size).

    python tools/gemini/music_import.py [--from build/music-gemini] [--picks <from>/picks.json]
                                        [--kbps 48] [--ambient-kbps 40] [--fresh]

Needs what `music_convert` needs (ffmpeg with libopus). `make music-gemini`
checks the size budget afterwards (`tools/soundgen check`).
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import math
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import credit  # noqa: E402
import music_convert  # noqa: E402
import prompt_guard  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

## Opus stereo, measured on 2026-11-18 (docs/07 "Audio"): 24 kbps folds the
## stereo image (a third of the width gone); from 32 up it stays, and the
## error per third of an octave against Gemini's AAC falls slowly: 2.25, 2.10,
## 2.01, 1.86 dB at 32, 40, 48, 56 kbps on Puerto's take 1. Themes ship at 48
## (~1.1 MiB for three minutes); the caves, sparse drones and drips whose
## source stops at 14 kHz, at 40 (1.72 dB, ~0.8 MiB).
KBPS = 48
AMBIENT_KBPS = 40
CHANNELS = 2
## The volume soundgen's themes play at in sounds.yaml (puerto, bosque).
BASE_VOLUME = 0.7

ASSET_DIR = "sounds/music/gemini"  # under assets/
PROMPT_DIR = "prompts/sounds/music/gemini"  # under assets/
MANIFEST = "sounds/music/gemini.yaml"  # under assets/
WORK = os.path.join("build", "gemini", "music-import")
SOURCES = os.path.join("build", "music-gemini")

BEGIN = "# gemini-music:%s:begin"
END = "# gemini-music:%s:end"
CREDITS_HEADER = "| Archivos | Herramienta | Fecha | Prompt | Notas |"


@dataclasses.dataclass(frozen=True)
class Slot:
    id: str  # also its pool's id in sounds.yaml music.pools
    sound: str
    place: str  # where it plays, for the CREDITS row (Spanish, like the file)
    fallback: str = ""  # soundgen's file (under assets/) that plays with "none"
    fallback_volume: float = 0.0
    rule: str = ""  # "title" or "bosses.<monster id>" in sounds.yaml music:; "" = a zone's pool
    ambient: bool = False  # encoded at AMBIENT_KBPS
    extras_key: str = ""  # the picks.json key of its extra versions
    extras: tuple[str, ...] = ()  # those versions, shipped provisionally until the owner lists his
    off: bool = False  # only "none"/"off": the owner turned it off


## The slots of music_slots.json, in the order sounds.yaml lists them.
SLOTS = (
    Slot("title", "music_title", "la pantalla de título (login y personajes)", rule="title"),
    Slot("town_puerto", "music_puerto", "Puerto (también la isla de inicio y la de pruebas)",
         "sounds/music/puerto.ogg", 0.7),
    Slot("bosque", "music_bosque", "la Isla del Bosque", "sounds/music/bosque.ogg", 0.7),
    Slot("volcan", "music_volcan", "la Isla Volcánica", "sounds/music/volcan.ogg", 0.75),
    Slot("cave", "music_cueva", "las minas y cuevas (pisos bajo el mar)", "sounds/music/cueva.ogg", 0.8,
         ambient=True, extras_key="cave_pool",
         extras=("mine", "crystal", "flooded", "abyss", "ossuary", "ember")),
    Slot("combat", "music_combat", "los combates", off=True),
    Slot("boss_forge", "music_boss_forge", "el guardián de la forja", rule="bosses.slagbound_warden"),
)

## Takes delivered under another name: town_puerto's third is the probe the
## main session asked first (2026-11-17).
ALIASES = {("town_puerto", "3"): "probe_1"}

VERSIONS = ("1", "2", "3")
## File names the page gave a take that had no title of its own (town_puerto_2: "output").
NAMELESS = ("output", "audio", "track", "music", "download")
## What picks.json may say instead of a take: what played before Gemini.
NONE = ("none", "off")
## An extra version: "mine", "mine_2", "cave_mine" or "cave_mine_1".
EXTRA = re.compile(r"^[a-z][a-z0-9]*(_[1-9])?$")


@dataclasses.dataclass
class Track:
    """One take that ships: its sound in sounds.yaml, its file and its measures."""

    take: str  # "1", "2", "3", or an extra version ("mine_1")
    sound: str
    file: str  # under assets/
    volume: float
    source: str
    record: dict = dataclasses.field(default_factory=dict)
    provisional: bool = False


@dataclasses.dataclass
class Entry:
    """What one slot has after an import."""

    slot: Slot
    takes: tuple[str, ...]  # the pick: one take, a pool, or () for none
    provisional: bool
    tracks: list[Track] = dataclasses.field(default_factory=list)
    ## Extra versions left out, with why (not picked and not passing the measures).
    skipped: list[str] = dataclasses.field(default_factory=list)

    @property
    def plays(self) -> tuple[str, float]:
        """The file (under assets/) and volume of the slot's own sound; ("", 0) = none."""
        if self.tracks:
            return self.tracks[0].file, self.tracks[0].volume
        return self.slot.fallback, self.slot.fallback_volume

    @property
    def pool(self) -> list[str]:
        """The sounds of its pool in sounds.yaml: every track, or the fallback; [] = none."""
        if self.tracks:
            return [track.sound for track in self.tracks]
        return [self.slot.sound] if self.slot.fallback else []


# --- the pure parts (tested by test_music_import.py) --------------------------------------


def extra_version(name: str) -> str:
    """An extra version as the picks may write it ("mine", "cave_mine",
    "cave_mine_1", "mine_2") as `<name>_<take>`: "mine_1", "mine_2"."""
    value = str(name).strip().lower()
    if value.startswith("cave_"):
        value = value[len("cave_"):]
    if not EXTRA.match(value):
        raise SystemExit("picks.json: %r is not a version name (\"mine\", \"cave_mine_1\")" % name)
    return value if re.search(r"_[1-9]$", value) else value + "_1"


def read_picks(text: str) -> dict[str, tuple[str, ...]]:
    """The owner's picks from picks.json: {slot: takes}, where takes is one
    take ("1"), a pool (["1", "2", "3"]) or none ("none", "off": ()); and
    {extras key: versions} for a slot's extra versions (`cave_pool`). A slot
    of no SLOTS, a take of no VERSIONS or a take for a slot that is off is
    refused."""
    raw = json.loads(text) if text.strip() else {}
    picks = raw.get("picks", {}) if isinstance(raw, dict) else {}
    if not isinstance(picks, dict):
        raise SystemExit("picks.json: \"picks\" must be an object of slot -> take, [takes] or \"none\"")
    slots = {slot.id: slot for slot in SLOTS}
    extras = {slot.extras_key: slot for slot in SLOTS if slot.extras_key}
    out = {}
    for key, value in picks.items():
        if key in extras:
            names = value if isinstance(value, list) else [value]
            if len(names) == 1 and str(names[0]).strip().lower() in NONE:
                out[key] = ()
                continue
            versions = tuple(extra_version(name) for name in names)
            if not versions or len(set(versions)) != len(versions):
                raise SystemExit("picks.json: %s must list different versions, not %r" % (key, value))
            out[key] = versions
            continue
        if key not in slots:
            raise SystemExit("picks.json: unknown slot %r (one of %s)" % (key, ", ".join(sorted(slots) + sorted(extras))))
        values = [str(v).strip().lower() for v in (value if isinstance(value, list) else [value])]
        if len(values) == 1 and values[0] in NONE:
            out[key] = ()
            continue
        if slots[key].off:
            raise SystemExit("picks.json: %s is off (the owner, 2026-11-18: ordinary fights keep the zone's music; "
                             "a boss has its own slot), so it only takes \"none\" or \"off\", not %r" % (key, value))
        if not values or any(v not in VERSIONS for v in values) or len(set(values)) != len(values):
            raise SystemExit("picks.json: %s must be a take (\"1\", \"2\", \"3\"), a list of different takes "
                             "or \"none\", not %r" % (key, value))
        out[key] = tuple(values)
    return out


def choice(slot: str, picks: dict[str, tuple[str, ...]]) -> tuple[tuple[str, ...], bool]:
    """The takes a slot ships and whether they are provisional: a slot the
    owner has not picked yet plays take 1 until he does (none for one that
    is off)."""
    if slot in picks:
        return picks[slot], False
    if any(s.id == slot and s.off for s in SLOTS):
        return (), False
    return ("1",), True


def extras_choice(slot: Slot, picks: dict[str, tuple[str, ...]]) -> tuple[tuple[str, ...], bool]:
    """A slot's extra versions and whether they are provisional: the owner's
    list, or every version of `slot.extras` until he writes one."""
    if not slot.extras_key:
        return (), False
    if slot.extras_key in picks:
        return picks[slot.extras_key], False
    return tuple(extra_version(name) for name in slot.extras), True


def source_name(slot: str, take: str) -> str:
    """The delivery's file name without extension: `<slot>_<take>`, or its alias."""
    return ALIASES.get((slot, take), "%s_%s" % (slot, take))


def sound_of(slot: Slot, index: int, take: str) -> str:
    """The sound of a pool's track: the slot's for the first, `<sound>_<take>`
    after; an extra version's is `<sound>_<name>` (`_<take>` from its take 2)."""
    if index == 0:
        return slot.sound
    if take in VERSIONS:
        return "%s_%s" % (slot.sound, take)
    return "%s_%s" % (slot.sound, take[: -len("_1")] if take.endswith("_1") else take)


def file_of(slot: Slot, take: str) -> str:
    """Where a track ships, under assets/: `<slot>_<take>.ogg`."""
    return "%s/%s_%s.ogg" % (ASSET_DIR, slot.id, take)


def kbps_of(slot: Slot, kbps: int = KBPS, ambient_kbps: int = AMBIENT_KBPS) -> int:
    return ambient_kbps if slot.ambient else kbps


def title_of(ask: dict) -> str:
    """The title Gemini gave a take: its `title`, or the name of its file
    when that is not a generic one; "" when it gave none."""
    title = str(ask.get("title") or "").strip()
    if title:
        return title
    name = str(ask.get("gemini_title") or "").strip()
    return "" if name.lower() in NAMELESS else name


def volume_for(lufs_out: float | None, base: float = BASE_VOLUME, target: float = music_convert.LUFS) -> float:
    """The volume a piece needs in sounds.yaml to play like a theme at `target`
    LUFS played at `base`: the peak ceiling can hold Gemini's hot masters a few
    dB under the target, and the volume gives that back, up to 1. (ffmpeg's
    meter reads a mono file as dual mono, as both speakers play it: soundgen's
    mono themes and a stereo piece at the same LUFS sound alike, measured on
    2026-11-18.)"""
    if lufs_out is None or not math.isfinite(lufs_out):
        return base
    return round(min(1.0, base * 10.0 ** ((target - lufs_out) / 20.0)), 2)


def number(value: float) -> str:
    """0.7, 0.75, 1: as sounds.yaml writes volumes."""
    return ("%.2f" % value).rstrip("0").rstrip(".")


def pick_text(takes: tuple[str, ...]) -> str:
    """The pick as the manifest writes it: "none", "2" or ["1", "2", "3"]."""
    if not takes:
        return '"none"'
    if len(takes) == 1:
        return json.dumps(takes[0])
    return "[%s]" % ", ".join(json.dumps(t) for t in takes)


def seconds_text(values) -> str:
    """Seconds as sounds.yaml writes them: [12.3, 40, 61.5]."""
    return "[%s]" % ", ".join(number(float(v)) for v in values)


def track_line(track: Track) -> str:
    """One track's sound in sounds.yaml: its file, volume, length, where its
    body ends and where the director may start it."""
    record = track.record
    seconds = float(record.get("seconds") or record.get("source_seconds") or 0.0)
    end = float(record.get("body_end") or seconds)
    return "  %s: { file: %s, channel: music, volume: %s, seconds: %s, end: %s, entries: %s }" % (
        track.sound, track.file, number(track.volume), number(seconds), number(min(end, seconds)),
        seconds_text(record.get("entries") or []))


def sounds_lines(entries: list[Entry]) -> list[str]:
    """The music sounds of sounds.yaml, one line each (indented under `sounds:`)."""
    out = []
    for entry in entries:
        if not entry.tracks:
            file, volume = entry.plays
            if file:
                out.append("  %s: { file: %s, channel: music, volume: %s }  # soundgen: the owner's pick is none"
                           % (entry.slot.sound, file, number(volume)))
            continue
        out.extend(track_line(track) for track in entry.tracks)
    return out


def pools_lines(entries: list[Entry]) -> list[str]:
    """The pool of each slot that has music (indented under `music.pools`)."""
    return ["    %s: [%s]" % (entry.slot.id, ", ".join(entry.pool)) for entry in entries
            if entry.pool and not entry.slot.off]


def rules_lines(entries: list[Entry]) -> list[str]:
    """The title and boss rules of sounds.yaml (indented under `music:`): each names a pool."""
    out, bosses = [], []
    for entry in entries:
        rule = entry.slot.rule
        if not rule or not entry.pool:
            continue
        if rule.startswith("bosses."):
            bosses.append("%s: %s" % (rule[len("bosses."):], entry.slot.id))
        else:
            out.append("  %s: %s" % (rule, entry.slot.id))
    if bosses:
        out.append("  bosses: { %s }" % ", ".join(bosses))
    return out


def replace_block(text: str, name: str, lines: list[str]) -> str:
    """`text` with the lines between its `# gemini-music:<name>:begin` and
    `:end` lines replaced by `lines` (the marker lines stay)."""
    rows = text.split("\n")
    begin = [i for i, row in enumerate(rows) if row.strip().startswith(BEGIN % name)]
    end = [i for i, row in enumerate(rows) if row.strip().startswith(END % name)]
    if len(begin) != 1 or len(end) != 1 or end[0] < begin[0]:
        raise SystemExit("assets/sounds.yaml needs one %r line and one %r line after it" % (BEGIN % name, END % name))
    return "\n".join(rows[: begin[0] + 1] + lines + rows[end[0] :])


def credits_with(text: str, rows: list[str], prefix: str = "| `assets/%s/" % ASSET_DIR) -> str:
    """CREDITS.md with the rows of the Gemini music (those whose files start
    with `prefix`) replaced by `rows`, first in the "Generado con IA" table;
    every other row stays where it was."""
    lines = text.split("\n")
    try:
        header = next(i for i, line in enumerate(lines) if line.strip() == CREDITS_HEADER)
    except StopIteration:
        raise SystemExit("assets/CREDITS.md has no \"Generado con IA\" table (%s)" % CREDITS_HEADER) from None
    body = header + 2  # past the |---| line
    end = body
    while end < len(lines) and lines[end].startswith("|"):
        end += 1
    kept = [line for line in lines[body:end] if not line.startswith(prefix)]
    return "\n".join(lines[:body] + rows + kept + lines[end:])


def _quote(value) -> str:
    """A YAML scalar: JSON's quoting is valid YAML and keeps any title safe."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return number(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, (list, tuple)):
        return seconds_text(value)
    return json.dumps(str(value), ensure_ascii=False)


def manifest_text(entries: list[Entry], kbps: int = KBPS, ambient_kbps: int = AMBIENT_KBPS) -> str:
    """assets/sounds/music/gemini.yaml."""
    out = [
        "# The Gemini music of the game, slot by slot (assets/README.md \"Sonido\"). Written by",
        "# `make music-gemini` (tools/gemini/music_import.py) from the owner's picks in",
        "# build/music-gemini/picks.json: change a pick there and run it again; never by hand.",
        "# pick: a take (1, 2, 3), a pool of takes, or none; provisional: not picked yet (take 1);",
        "# extras: the slot's extra versions (picks.json cave_pool), provisional until listed;",
        "# file/volume: the slot's own sound (its pool's first track); fallback: the soundgen",
        "# theme that plays with none (kept, with its recipe, for that); pool: the sounds the",
        "# music director shuffles; tracks: every take shipped, whole, with where it may start.",
        "format: 2",
        "settings: { channels: %d, kbps: %d, ambient_kbps: %d, lufs: %s, true_peak: %s }"
        % (CHANNELS, kbps, ambient_kbps, number(music_convert.LUFS), number(music_convert.TRUE_PEAK)),
        "slots:",
    ]
    for entry in entries:
        file, volume = entry.plays
        out.append("  %s:" % entry.slot.id)
        out.append("    sound: %s" % _quote(entry.slot.sound))
        out.append("    pick: %s" % pick_text(entry.takes))
        out.append("    provisional: %s" % _quote(entry.provisional))
        extras = [t.take for t in entry.tracks if t.take not in VERSIONS]
        if extras:
            out.append("    extras: [%s]" % ", ".join(json.dumps(t) for t in extras))
        if entry.skipped:
            out.append("    skipped: [%s]" % ", ".join(json.dumps(s, ensure_ascii=False) for s in entry.skipped))
        if file:
            out.append("    file: %s" % _quote(file))
            out.append("    volume: %s" % _quote(float(volume)))
        if entry.slot.fallback:
            out.append("    fallback: %s" % _quote(entry.slot.fallback))
        if entry.pool and not entry.slot.off:
            out.append("    pool: [%s]" % ", ".join(json.dumps(s) for s in entry.pool))
        if not entry.tracks:
            continue
        out.append("    tracks:")
        for track in entry.tracks:
            record, ask = track.record, track.record.get("delivery", {})
            fields = [
                ("take", track.take),
                ("sound", track.sound),
                ("file", track.file),
                ("volume", float(track.volume)),
                ("provisional", track.provisional),
                ("source", track.source),
                ("source_sha256", record.get("source_sha256", "")),
                ("title", title_of(ask)),
                ("made", credit.day_of(ask)),
                ("mode", ask.get("mode", "")),
                ("prompt", credit.prompt_path("assets/" + track.file)[len("assets/") :]),
                ("seconds", float(record.get("seconds") or record.get("source_seconds") or 0.0)),
                ("end", float(record.get("body_end") or 0.0)),
                ("entries", list(record.get("entries") or [])),
                ("longest_quiet", float(record.get("longest_quiet") or 0.0)),
                ("lufs", float(record.get("lufs_out") or 0.0)),
                ("kbps", int(record.get("kbps", 0))),
                ("bytes", int(record.get("bytes", 0))),
            ]
            first = True
            for key, value in fields:
                if value == "":
                    continue
                out.append("%s%s: %s" % ("      - " if first else "        ", key, _quote(value)))
                first = False
    return "\n".join(out) + "\n"


def minutes(seconds: float) -> str:
    return "%d:%02d" % (int(seconds) // 60, int(seconds) % 60)


def credit_note(entry: Entry, track: Track) -> str:
    """The "Notas" cell of a track's CREDITS row (Spanish, like the file)."""
    record = track.record
    ask = record.get("delivery", {})
    seconds = float(record.get("seconds") or record.get("source_seconds") or 0.0)
    title = title_of(ask)
    named = "«%s» (título de Gemini)" % title if title else "Sin título (Gemini no le dio uno)"
    if track.take in VERSIONS:
        note = "%s: toma %s del tema `%s`, para %s" % (named, track.take, entry.slot.id, entry.slot.place)
    else:
        note = "%s: versión `%s` del tema `%s`, para %s" % (named, track.take, entry.slot.id, entry.slot.place)
    if len(entry.tracks) > 1:
        note += " (uno de los %d temas que alterna el director de música)" % len(entry.tracks)
    note += ". Tema completo (%s), Ogg Opus estéreo a %d kbps, con %d puntos de entrada (`make music-gemini`)" % (
        minutes(seconds), int(record.get("kbps", 0)), len(record.get("entries") or []))
    if track.provisional:
        note += ". **Provisional**: el dueño todavía no eligió"
    return note


# --- the import ------------------------------------------------------------------------------


def _sha256(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def _settings_match(record: dict, kbps: int) -> bool:
    return (record.get("kbps") == kbps and record.get("channels") == CHANNELS
            and record.get("analysis") == music_convert.ANALYSIS
            and record.get("lufs_target") == music_convert.LUFS
            and record.get("true_peak_ceiling") == music_convert.TRUE_PEAK)


def convert_take(source: str, work: str, kbps: int, fresh: bool) -> tuple[str, dict]:
    """The converted piece of one delivery and its record: the one in `work`
    when it was made from the same file with the same settings."""
    stem = os.path.splitext(os.path.basename(source))[0]
    out = os.path.join(work, stem + ".ogg")
    record_path = os.path.join(work, stem + ".json")
    if not fresh and os.path.exists(out) and os.path.exists(record_path):
        with open(record_path, encoding="utf-8") as handle:
            record = json.load(handle)
        if (record.get("source_sha256") == _sha256(source) and _settings_match(record, kbps)
                and record.get("sha256") == _sha256(out)):
            return out, record
    record = music_convert.convert(source, out, kbps=kbps, channels=CHANNELS, loop=False)
    return out, record


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def run(root: str, sources: str, picks: dict[str, tuple[str, ...]], kbps: int = KBPS,
        ambient_kbps: int = AMBIENT_KBPS, fresh: bool = False, work: str = "") -> list[Entry]:
    """Imports every slot from `picks` into the repo at `root`."""
    assets = os.path.join(root, "assets")
    work = work or os.path.join(root, WORK)
    entries = []
    for slot in SLOTS:
        takes, provisional = choice(slot.id, picks)
        extras, extras_provisional = extras_choice(slot, picks)
        entry = Entry(slot, takes, provisional)
        rate = kbps_of(slot, kbps, ambient_kbps)
        wanted = [(take, source_name(slot.id, take), provisional, True) for take in takes]
        if takes:  # extras join a pool that has a pick of its own
            wanted += [(version, "%s_%s" % (slot.id, version), extras_provisional, not extras_provisional)
                       for version in extras]
        for take, stem, track_provisional, required in wanted:
            source = os.path.join(sources, stem + ".mp4")
            if not os.path.exists(source):
                if required:
                    raise SystemExit("%s: take %s is %s, which is not there" % (slot.id, take, source))
                entry.skipped.append("%s: no %s" % (take, os.path.basename(source)))
                continue
            out, record = convert_take(source, work, rate, fresh)
            problems = music_convert.piece_problems(record)
            if problems and not required:
                entry.skipped.append("%s: %s" % (take, "; ".join(problems)))
                continue
            if problems:
                print("%s %s: the slot's pick, so it ships, but: %s" % (slot.id, take, "; ".join(problems)))
            ask = credit.delivery_of(record)
            prompt_guard.check(ask["prompt"])
            credit.refs_of(ask, root)
            rel = file_of(slot, take)
            os.makedirs(os.path.join(assets, ASSET_DIR), exist_ok=True)
            shutil.copyfile(out, os.path.join(assets, rel))
            entry.tracks.append(Track(take, sound_of(slot, len(entry.tracks), take), rel,
                                      volume_for(record.get("lufs_out")), os.path.basename(source), record,
                                      track_provisional))
        entries.append(entry)

    # What no slot ships any more goes: its file and its prompt file.
    shipped = {os.path.splitext(os.path.basename(t.file))[0] for e in entries for t in e.tracks}
    for folder, ext in ((ASSET_DIR, ".ogg"), (PROMPT_DIR, ".txt")):
        path = os.path.join(assets, folder)
        if not os.path.isdir(path):
            continue
        for name in sorted(os.listdir(path)):
            if name.endswith(ext) and os.path.splitext(name)[0] not in shipped:
                os.remove(os.path.join(path, name))

    rows = []
    for entry in entries:
        for track in entry.tracks:
            asset = "assets/" + track.file
            ask = credit.delivery_of(track.record)
            prompt_file = credit.prompt_path(asset)
            _write(os.path.join(root, prompt_file), credit.prompt_text(ask, [asset]))
            rows.append(credit.credits_row(ask, [asset], prompt_file, credit_note(entry, track)))

    sounds_yaml = os.path.join(assets, "sounds.yaml")
    text = replace_block(_read(sounds_yaml), "sounds", sounds_lines(entries))
    text = replace_block(text, "pools", pools_lines(entries))
    _write(sounds_yaml, replace_block(text, "rules", rules_lines(entries)))
    credits_md = os.path.join(assets, "CREDITS.md")
    _write(credits_md, credits_with(_read(credits_md), rows))
    _write(os.path.join(assets, MANIFEST), manifest_text(entries, kbps, ambient_kbps))
    return entries


def main() -> int:
    sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="sources", default=os.path.join(ROOT, SOURCES),
                        help="the deliveries: <slot>_<n>.mp4 with their sidecars (default build/music-gemini)")
    parser.add_argument("--picks", default="", help="the owner's picks (default <from>/picks.json)")
    parser.add_argument("--kbps", type=int, default=KBPS, help="Opus stereo kbps of a theme")
    parser.add_argument("--ambient-kbps", type=int, default=AMBIENT_KBPS, help="Opus stereo kbps of an ambient slot (caves)")
    parser.add_argument("--fresh", action="store_true", help="convert every take again")
    args = parser.parse_args()
    picks_path = args.picks or os.path.join(args.sources, "picks.json")
    picks = read_picks(_read(picks_path)) if os.path.exists(picks_path) else {}
    entries = run(ROOT, args.sources, picks, args.kbps, args.ambient_kbps, args.fresh)
    total = 0
    for entry in entries:
        pool = 0
        if not entry.tracks:
            file, volume = entry.plays
            size = os.path.getsize(os.path.join(ROOT, "assets", file)) if file else 0
            pool += size
            print("%-12s %-22s %7.1f KiB  volume %-4s none: %s" % (
                entry.slot.id, entry.slot.sound, size / 1024, number(volume) if file else "-",
                file or "no music of its own"))
        for track in entry.tracks:
            size = os.path.getsize(os.path.join(ROOT, "assets", track.file))
            pool += size
            record = track.record
            print("%-12s %-22s %7.1f KiB  volume %-4s %s%s (%s, %s, %d kbps, %s LUFS, entries %s)" % (
                entry.slot.id, track.sound, size / 1024, number(track.volume), track.take,
                ", provisional" if track.provisional else "", track.source,
                minutes(float(record.get("seconds") or 0.0)), int(record.get("kbps", 0)), record.get("lufs_out"),
                seconds_text(record.get("entries") or [])))
        for skipped in entry.skipped:
            print("%-12s left out: %s" % (entry.slot.id, skipped))
        if len(entry.tracks) > 1:
            print("%-12s pool of %d: %.1f KiB" % (entry.slot.id, len(entry.tracks), pool / 1024))
        total += pool
    print("music-gemini: the music of sounds.yaml takes %.1f KiB; picks from %s" % (total / 1024, picks_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
