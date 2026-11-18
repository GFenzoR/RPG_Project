"""Puts the owner's picks of Gemini music in the game: `make music-gemini`.

The main session asked Gemini for two or three takes of each place that has
music (`music_slots.json`, 2026-11-17, `build/music-gemini/<slot>_<n>.mp4` with
their sidecars); the owner listens and his picks land in
`build/music-gemini/picks.json`:

    {"picks": {"title": "2", "town_puerto": ["1", "2", "3"], "combat": "off"}}

One command then does the rest, every time from the picks, so swapping a pick
is editing that file and running it again:

- **A take** ("1", "2", "3") plays in its slot. **A pool** (a list of takes)
  ships every take of it: the first plays where the game expects one track
  (its sound is the slot's, `music_puerto`), the others are sounds of their own
  (`music_puerto_2`...) for the music director that will vary them (docs/14).
- **A slot that is missing is not picked yet**: its take 1 plays, marked
  `provisional` (in the manifest and in its CREDITS.md row).
- **`none` (or `off`) keeps what played before Gemini**: the soundgen theme of
  that place (`fallback`), or no music of its own where there was none (the
  title screen, a fight, the forge's boss: the zone's loop plays on).
- **Each take is converted** by `music_convert` into an Ogg Opus loop of about
  a minute (`MAX_SECONDS`), mono at `KBPS` (docs/07 "Audio": every file of
  `sounds.yaml` within 1.5 MiB, a music file within 256 KiB, and the loops in
  play decoded within the memory budget), into `build/gemini/music-import/`;
  the `.ogg` is copied to `assets/sounds/music/gemini/<slot>_<take>.ogg`. A
  take already converted with the same settings is not converted again.
- **`assets/sounds.yaml`** gets its music sounds and the title, fight and boss
  rules between its `# gemini-music:sounds:begin`/`end` and
  `# gemini-music:rules:begin`/`end` lines; the rest of it is not touched.
  The volume makes up for the gain the peak ceiling took (`volume_for`).
- **Each take is credited**: its prompt file
  (`assets/prompts/sounds/music/gemini/<slot>_<take>.txt`, `credit.prompt_text`)
  and its row in `assets/CREDITS.md`, "Generado con IA" (`credit.credits_row`).
- **`assets/sounds/music/gemini.yaml`** says what each slot has: the pick, the
  tracks with their source and the title Gemini gave them, whether it is
  provisional, and the measures of each loop (length, loudness, seam, size).

    python tools/gemini/music_import.py [--from build/music-gemini] [--picks <from>/picks.json]
                                        [--kbps 20] [--max-seconds 72] [--fresh]

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
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import credit  # noqa: E402
import music_convert  # noqa: E402
import prompt_guard  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

## Mono at 20 kbps and loops of 54 to 72 s: a loop takes 130 to 190 KiB of the
## 1.5 MiB every file of sounds.yaml may (docs/07 "Audio", measured on
## 2026-11-18), and two of them decoded (the one playing and the one before,
## audio/engine.ts KEEP_LOOPS) ~27 MB of the 40 MB.
KBPS = 20
CHANNELS = 1
MAX_SECONDS = 72.0
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
    id: str
    sound: str
    place: str  # where it plays, for the CREDITS row (Spanish, like the file)
    fallback: str = ""  # soundgen's file (under assets/) that plays with "none"
    fallback_volume: float = 0.0
    rule: str = ""  # "title", "combat" or "bosses.<monster id>" in sounds.yaml music:


## The slots of music_slots.json, in the order sounds.yaml lists them.
SLOTS = (
    Slot("title", "music_title", "la pantalla de título (login y personajes)", rule="title"),
    Slot("town_puerto", "music_puerto", "Puerto (también la isla de inicio y la de pruebas)",
         "sounds/music/puerto.ogg", 0.7),
    Slot("bosque", "music_bosque", "la Isla del Bosque", "sounds/music/bosque.ogg", 0.7),
    Slot("volcan", "music_volcan", "la Isla Volcánica", "sounds/music/volcan.ogg", 0.75),
    Slot("cave", "music_cueva", "las minas y cuevas (pisos bajo el mar)", "sounds/music/cueva.ogg", 0.8),
    Slot("combat", "music_combat", "los combates", rule="combat"),
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


@dataclasses.dataclass
class Track:
    """One take that ships: its sound in sounds.yaml, its file and its measures."""

    take: str
    sound: str
    file: str  # under assets/
    volume: float
    source: str
    record: dict = dataclasses.field(default_factory=dict)


@dataclasses.dataclass
class Entry:
    """What one slot has after an import."""

    slot: Slot
    takes: tuple[str, ...]  # the pick: one take, a pool, or () for none
    provisional: bool
    tracks: list[Track] = dataclasses.field(default_factory=list)

    @property
    def plays(self) -> tuple[str, float]:
        """The file (under assets/) and volume of the slot's own sound; ("", 0) = none."""
        if self.tracks:
            return self.tracks[0].file, self.tracks[0].volume
        return self.slot.fallback, self.slot.fallback_volume


# --- the pure parts (tested by test_music_import.py) --------------------------------------


def read_picks(text: str) -> dict[str, tuple[str, ...]]:
    """The owner's picks from picks.json: {slot: takes}, where takes is one
    take ("1"), a pool (["1", "2", "3"]) or none ("none", "off": ()). A slot of
    no SLOTS or a take of no VERSIONS is refused."""
    raw = json.loads(text) if text.strip() else {}
    picks = raw.get("picks", {}) if isinstance(raw, dict) else {}
    if not isinstance(picks, dict):
        raise SystemExit("picks.json: \"picks\" must be an object of slot -> take, [takes] or \"none\"")
    known = {slot.id for slot in SLOTS}
    out = {}
    for slot, value in picks.items():
        if slot not in known:
            raise SystemExit("picks.json: unknown slot %r (one of %s)" % (slot, ", ".join(sorted(known))))
        values = [str(v).strip().lower() for v in (value if isinstance(value, list) else [value])]
        if len(values) == 1 and values[0] in NONE:
            out[slot] = ()
            continue
        if not values or any(v not in VERSIONS for v in values) or len(set(values)) != len(values):
            raise SystemExit("picks.json: %s must be a take (\"1\", \"2\", \"3\"), a list of different takes "
                             "or \"none\", not %r" % (slot, value))
        out[slot] = tuple(values)
    return out


def choice(slot: str, picks: dict[str, tuple[str, ...]]) -> tuple[tuple[str, ...], bool]:
    """The takes a slot ships and whether they are provisional: a slot the
    owner has not picked yet plays take 1 until he does."""
    if slot in picks:
        return picks[slot], False
    return ("1",), True


def source_name(slot: str, take: str) -> str:
    """The delivery's file name without extension: `<slot>_<take>`, or its alias."""
    return ALIASES.get((slot, take), "%s_%s" % (slot, take))


def sound_of(slot: Slot, index: int, take: str) -> str:
    """The sound of a pool's track: the slot's for the first, `<sound>_<take>` after."""
    return slot.sound if index == 0 else "%s_%s" % (slot.sound, take)


def title_of(ask: dict) -> str:
    """The title Gemini gave a take: its `title`, or the name of its file
    when that is not a generic one; "" when it gave none."""
    title = str(ask.get("title") or "").strip()
    if title:
        return title
    name = str(ask.get("gemini_title") or "").strip()
    return "" if name.lower() in NAMELESS else name


def volume_for(lufs_out: float | None, base: float = BASE_VOLUME, target: float = music_convert.LUFS) -> float:
    """The volume a loop needs in sounds.yaml to play like a theme at `target`
    LUFS played at `base`: the peak ceiling holds Gemini's hot masters a few dB
    under the target, and the volume gives that back, up to 1."""
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
        for track in entry.tracks:
            out.append("  %s: { file: %s, channel: music, volume: %s }" % (track.sound, track.file, number(track.volume)))
    return out


def rules_lines(entries: list[Entry]) -> list[str]:
    """The title, fight and boss rules of sounds.yaml (indented under `music:`)."""
    out, bosses = [], []
    for entry in entries:
        rule = entry.slot.rule
        if not rule or not entry.plays[0]:
            continue
        if rule.startswith("bosses."):
            bosses.append("%s: %s" % (rule[len("bosses."):], entry.slot.sound))
        else:
            out.append("  %s: %s" % (rule, entry.slot.sound))
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
    return json.dumps(str(value), ensure_ascii=False)


def manifest_text(entries: list[Entry], kbps: int, max_seconds: float) -> str:
    """assets/sounds/music/gemini.yaml."""
    out = [
        "# The Gemini music of the game, slot by slot (assets/README.md \"Sonido\"). Written by",
        "# `make music-gemini` (tools/gemini/music_import.py) from the owner's picks in",
        "# build/music-gemini/picks.json: change a pick there and run it again; never by hand.",
        "# pick: a take (1, 2, 3), a pool of takes, or none; provisional: not picked yet (take 1);",
        "# file/volume: what the slot's sound plays (a pool's first track); fallback: the soundgen",
        "# theme that plays with none (kept, with its recipe, for that); tracks: every take shipped.",
        "format: 1",
        "settings: { channels: %d, kbps: %d, max_seconds: %s, lufs: %s, true_peak: %s }"
        % (CHANNELS, kbps, number(max_seconds), number(music_convert.LUFS), number(music_convert.TRUE_PEAK)),
        "slots:",
    ]
    for entry in entries:
        file, volume = entry.plays
        out.append("  %s:" % entry.slot.id)
        out.append("    sound: %s" % _quote(entry.slot.sound))
        out.append("    pick: %s" % pick_text(entry.takes))
        out.append("    provisional: %s" % _quote(entry.provisional))
        if file:
            out.append("    file: %s" % _quote(file))
            out.append("    volume: %s" % _quote(float(volume)))
        if entry.slot.fallback:
            out.append("    fallback: %s" % _quote(entry.slot.fallback))
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
                ("source", track.source),
                ("source_sha256", record.get("source_sha256", "")),
                ("title", title_of(ask)),
                ("made", credit.day_of(ask)),
                ("mode", ask.get("mode", "")),
                ("prompt", credit.prompt_path("assets/" + track.file)[len("assets/") :]),
                ("track_seconds", float(record.get("source_seconds", 0.0))),
                ("loop_seconds", float(record.get("loop_seconds", 0.0))),
                ("lufs", float(record.get("lufs_out") or 0.0)),
                ("seam", float(record.get("seam_encoded", 0.0))),
                ("bytes", int(record.get("bytes", 0))),
            ]
            first = True
            for key, value in fields:
                if value == "":
                    continue
                out.append("%s%s: %s" % ("      - " if first else "        ", key, _quote(value)))
                first = False
    return "\n".join(out) + "\n"


def credit_note(entry: Entry, track: Track, kbps: int) -> str:
    """The "Notas" cell of a track's CREDITS row (Spanish, like the file)."""
    ask = track.record.get("delivery", {})
    seconds = float(track.record.get("source_seconds", 0.0))
    title = title_of(ask)
    named = "«%s» (título de Gemini)" % title if title else "Sin título (Gemini no le dio uno)"
    note = "%s: toma %s del tema `%s`, para %s" % (named, track.take, entry.slot.id, entry.slot.place)
    if len(entry.tracks) > 1:
        note += " (una de las %d tomas elegidas; `%s` es la que suena hoy)" % (len(entry.tracks), entry.tracks[0].sound)
    note += ". Loop de %d s de los %d:%02d del tema, Ogg Opus mono a %d kbps (`make music-gemini`)" % (
        round(float(track.record.get("loop_seconds", 0.0))), int(seconds) // 60, int(seconds) % 60, kbps)
    if entry.provisional:
        note += ". **Provisional**: el dueño todavía no eligió entre las tomas"
    return note


# --- the import ------------------------------------------------------------------------------


def _sha256(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def _settings_match(record: dict, kbps: int, max_seconds: float) -> bool:
    return (record.get("kbps") == kbps and record.get("channels") == CHANNELS
            and float(record.get("max_seconds", 0.0)) == float(max_seconds)
            and record.get("lufs_target") == music_convert.LUFS
            and record.get("true_peak_ceiling") == music_convert.TRUE_PEAK
            and record.get("crossfade") == music_convert.CROSSFADE)


def convert_take(source: str, work: str, kbps: int, max_seconds: float, fresh: bool) -> tuple[str, dict]:
    """The converted loop of one delivery and its record: the one in `work`
    when it was made from the same file with the same settings."""
    stem = os.path.splitext(os.path.basename(source))[0]
    out = os.path.join(work, stem + ".ogg")
    record_path = os.path.join(work, stem + ".json")
    if not fresh and os.path.exists(out) and os.path.exists(record_path):
        with open(record_path, encoding="utf-8") as handle:
            record = json.load(handle)
        if (record.get("source_sha256") == _sha256(source) and _settings_match(record, kbps, max_seconds)
                and record.get("sha256") == _sha256(out)):
            return out, record
    record = music_convert.convert(source, out, kbps=kbps, channels=CHANNELS, max_seconds=max_seconds)
    return out, record


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def _read(path: str) -> str:
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def run(root: str, sources: str, picks: dict[str, tuple[str, ...]], kbps: int = KBPS,
        max_seconds: float = MAX_SECONDS, fresh: bool = False, work: str = "") -> list[Entry]:
    """Imports every slot from `picks` into the repo at `root`."""
    assets = os.path.join(root, "assets")
    work = work or os.path.join(root, WORK)
    entries = []
    for slot in SLOTS:
        takes, provisional = choice(slot.id, picks)
        entry = Entry(slot, takes, provisional)
        for index, take in enumerate(takes):
            source = os.path.join(sources, source_name(slot.id, take) + ".mp4")
            if not os.path.exists(source):
                raise SystemExit("%s: take %s is %s, which is not there" % (slot.id, take, source))
            out, record = convert_take(source, work, kbps, max_seconds, fresh)
            ask = credit.delivery_of(record)
            prompt_guard.check(ask["prompt"])
            credit.refs_of(ask, root)
            rel = "%s/%s_%s.ogg" % (ASSET_DIR, slot.id, take)
            os.makedirs(os.path.join(assets, ASSET_DIR), exist_ok=True)
            shutil.copyfile(out, os.path.join(assets, rel))
            entry.tracks.append(Track(take, sound_of(slot, index, take), rel, volume_for(record.get("lufs_out")),
                                      os.path.basename(source), record))
        entries.append(entry)

    # What no slot ships any more goes: its loop and its prompt file.
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
            rows.append(credit.credits_row(ask, [asset], prompt_file, credit_note(entry, track, kbps)))

    sounds_yaml = os.path.join(assets, "sounds.yaml")
    text = replace_block(_read(sounds_yaml), "sounds", sounds_lines(entries))
    _write(sounds_yaml, replace_block(text, "rules", rules_lines(entries)))
    credits_md = os.path.join(assets, "CREDITS.md")
    _write(credits_md, credits_with(_read(credits_md), rows))
    _write(os.path.join(assets, MANIFEST), manifest_text(entries, kbps, max_seconds))
    return entries


def main() -> int:
    sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="sources", default=os.path.join(ROOT, SOURCES),
                        help="the deliveries: <slot>_<n>.mp4 with their sidecars (default build/music-gemini)")
    parser.add_argument("--picks", default="", help="the owner's picks (default <from>/picks.json)")
    parser.add_argument("--kbps", type=int, default=KBPS)
    parser.add_argument("--max-seconds", type=float, default=MAX_SECONDS)
    parser.add_argument("--fresh", action="store_true", help="convert every take again")
    args = parser.parse_args()
    picks_path = args.picks or os.path.join(args.sources, "picks.json")
    picks = read_picks(_read(picks_path)) if os.path.exists(picks_path) else {}
    entries = run(ROOT, args.sources, picks, args.kbps, args.max_seconds, args.fresh)
    total = 0
    for entry in entries:
        if not entry.tracks:
            file, volume = entry.plays
            size = os.path.getsize(os.path.join(ROOT, "assets", file)) if file else 0
            total += size
            print("%-12s %-19s %6.1f KiB  volume %-4s none: %s" % (
                entry.slot.id, entry.slot.sound, size / 1024, number(volume) if file else "-",
                file or "no music of its own"))
        for track in entry.tracks:
            size = os.path.getsize(os.path.join(ROOT, "assets", track.file))
            total += size
            print("%-12s %-19s %6.1f KiB  volume %-4s take %s%s (%s, %.1f s loop, %s LUFS, seam %s)" % (
                entry.slot.id, track.sound, size / 1024, number(track.volume), track.take,
                ", provisional" if entry.provisional else "", track.source, track.record.get("loop_seconds", 0.0),
                track.record.get("lufs_out"), track.record.get("seam_encoded")))
    print("music-gemini: the music of sounds.yaml takes %.1f KiB; picks from %s" % (total / 1024, picks_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
