"""Turns a delivered track (Gemini's MP4/AAC) into Ogg Opus the client can play: a loop, or the whole piece.

The port of Ants of Neque's `tools/convert_beds.py`, for this game's audio. A
loop is the whole file, wrapped sample for sample (the client loops a file
with no entry points, `client/src/audio/engine.ts`), and Ogg Opus is the
format `assets/sounds/` ships (`tools/soundgen`). Since 2026-11-18 the game
ships whole pieces instead (see "A whole piece" below); the loop steps stay
for a cue that has to loop.

Every delivery is a finished *piece*: it opens, it closes, and it ends in
silence, so it cannot loop as it is. These steps get from one to the other:

1. **The fades come off** (`fade_bounds`): walked in from each end, a tenth of
   a second at a time, while the level is under half the body's. Blunt on
   purpose: what matters is that the crossfade meets music at both ends.
2. **A shorter loop, when asked** (`--max-seconds`, `loop_length`): the game
   keeps the loops it plays decoded in memory (docs/07 "Audio": ~11 MB a
   minute in mono at 48 kHz) and every file inside the size budget, so a
   three-minute piece can ship as a loop of about a minute. The length is
   picked between `LOOP_RANGE` of the maximum and the maximum, where what
   follows the cut looks most like the head over the crossfade (the onsets of
   both in step, so a beat falls on a beat; the energy contour alike; the same
   level), because that is exactly what the crossfade lays over the head.
3. **The loop is closed** (`close_loop`): the last `--crossfade` seconds are
   folded back over the head with an equal-power crossfade (a linear one dips
   about 3 dB in the middle, a hole at the exact moment the seam hides). The
   loop's last sample is followed by the sample that came after it in the
   piece, so the wrap is continuous by construction, not by luck.
4. **Loudness normalised with one constant gain** (`loudness_gain`): ffmpeg's
   EBU R128 meter (`loudnorm`, measuring only) reads the loop's integrated
   loudness and true peak, and a single gain brings it to `--lufs`, never past
   `--true-peak`. A time-varying normaliser would end the loop at a different
   gain from the one it starts at, and the seam would jump. A mono loop is
   measured as mono, like soundgen's themes (the browser plays both alike on
   two speakers). Gemini masters run hot (+1.5 to +5 dBTP on 2026-11-17's
   takes), so the peak ceiling, not the target, usually sets the gain:
   `music_import` makes up the difference with the volume in `sounds.yaml`.
5. **Encoded to Ogg Opus** at 48 kHz, and decoded back to measure what ships:
   the seam (`seam_score`: the step across the wrap against the ordinary steps
   around it; under 1 is quieter than the music) and the length.
6. **The seam survives the encoder** (`turn`): the last frame's coding error
   and the first's come from two unrelated frames, so a seam that is clean in
   the samples can step after encoding (3.3 on the first real track,
   2026-11-18, from 0.81 before it). The loop is a circle, so it is turned by
   `TURN_MS` at a time, encoded again, and kept at the first turn whose
   encoded seam is ordinary (`SEAM_GOOD`), or the best of `TURNS` (Ants of
   Neque did the same for MP3). A turn starts the music a few hundred
   milliseconds later; nothing is lost.

**A whole piece** (`--no-loop`): what the game ships since the owner's request
of 2026-11-18 (`music_import`): the full take, nothing cut or folded, one gain
and Ogg Opus. The client's music director (`client/src/audio/director.ts`)
streams it and starts it at one of its **entry points** (`entry_points`: where
a phrase begins, read off the level envelope, never at 0, 15 s apart and none
in the last 30 s of its body), so the record also keeps its fades, where the
body ends (`body_end`: the composed ending starts) and its longest hole
(`longest_quiet`); `piece_problems` says whether it may play.

Needs ffmpeg with libopus: the one on PATH (as `make sounds` uses) or the copy
inside `imageio-ffmpeg`. Build-time only; nothing of it reaches the game.

    python tools/gemini/music_convert.py <track.mp4> [--out build/gemini/convert/<stem>.ogg]
        [--kbps 32] [--channels 2] [--lufs -14] [--true-peak -1.5] [--crossfade 4] [--no-loop]
        [--max-seconds 72]

It never writes into `assets/` by itself: the owner listens first.
`music_import.py` (`make music-gemini`) runs it on the owner's picks and puts
the results in the game, with their prompt files and `CREDITS.md` rows. `<out stem>.json` beside it holds the measures and, when the
delivery has a `music_web` sidecar beside it, the prompt it was asked with.
"""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(ROOT, "build", "gemini", "convert")

RATE = 48000  # Opus's own rate
ANALYSIS_RATE = 8000  # the fades are found on a light mono copy
## **One loudness for all the game's music**: the four themes soundgen made
## measure -11.3 (bosque), -13.7 (puerto), -14.2 (volcan) and -15.8 (cueva)
## LUFS, about -14 together (2026-11-18 review), so a Gemini track comes to
## that, never to -18, where it played some 4 dB under the rest. The test
## `TheGameMusic` measures the shipped themes against it when ffmpeg is there.
LUFS = -14.0
TRUE_PEAK = -1.5
CROSSFADE = 4.0
KBPS = 32
CHANNELS = 2
## A level under this share of the body's RMS is still fade.
FADED = 0.5
## The body's level is read away from the ends, where the fades are.
BODY_SKIP = 5.0
## The turns tried to keep the encoded seam ordinary (`turn`).
TURNS = 8
TURN_MS = 97  # odd against Opus's 20 ms frames, so every turn lands elsewhere in one
SEAM_GOOD = 1.0
## `--max-seconds`: the loop's length is picked between this share of the
## maximum and the maximum (`loop_length`).
LOOP_RANGE = 0.75
## The hop of the envelopes `loop_length` compares (10 ms: a beat lands within 5 ms).
ENVELOPE_HOP = 0.01
## docs/07 "Audio": one music file of assets/sounds.yaml (soundgen's budget).
MUSIC_FILE_BUDGET = 1536 * 1024
## A whole piece (`--no-loop`, what `music_import` ships since 2026-11-18): the
## envelope its entry points are read from (`entry_points`), one value a tenth
## of a second.
ENTRY_HOP = 0.1
## No entry before this second (the piece's own start is not one), none in the
## last ENTRY_TAIL seconds of its body, ENTRY_GAP apart, at most ENTRY_MOST.
ENTRY_HEAD = 10.0
ENTRY_TAIL = 30.0
ENTRY_GAP = 15.0
ENTRY_MOST = 8
## What a piece needs to play (`piece_problems`): a whole take, music you can
## hear, no hole longer than MAX_QUIET_SECONDS (QUIET_DB under the body), and
## places to start.
MIN_PIECE_SECONDS = 120.0
MIN_LUFS = -40.0
QUIET_DB = 30.0
MAX_QUIET_SECONDS = 6.0
MIN_ENTRIES = 2
## The version of a piece's measures (entries, holes): `music_import` converts
## again a piece measured by an older one, or with other entry settings
## (`entry_settings`: changing ENTRY_* is enough).
ANALYSIS = 1


def entry_settings() -> dict:
    """What `entry_points` measures a piece with (ENTRY_*), kept in its record."""
    return {"head": ENTRY_HEAD, "tail": ENTRY_TAIL, "gap": ENTRY_GAP, "most": ENTRY_MOST, "hop": ENTRY_HOP}


# --- the pure parts (tested by test_music_convert.py) ------------------------------------


def frames_of(x, channels: int) -> int:
    return len(x) // channels


def rms(values, start: int = 0, end: int | None = None) -> float:
    """Root mean square of `values[start:end]` (a flat sequence)."""
    end = len(values) if end is None else end
    count = max(end - start, 1)
    total = 0.0
    for index in range(start, end):
        value = values[index]
        total += value * value
    return math.sqrt(total / count)


def fade_bounds(mono, rate: int, step: float = 0.1, faded: float = FADED, skip: float = BODY_SKIP) -> tuple[float, float]:
    """The seconds of fade at the head and at the tail of a mono signal: walked
    in from each end, `step` seconds at a time, while the level is under
    `faded` of the body's (read `skip` seconds away from both ends)."""
    n = len(mono)
    hop = max(int(rate * step), 1)
    away = int(rate * skip)
    body = rms(mono, away, n - away) if n > 2 * away + hop else rms(mono)
    if body <= 0.0:
        return 0.0, 0.0
    head = 0
    while head + hop < n and rms(mono, head, head + hop) <= body * faded:
        head += hop
    tail = n
    while tail - hop > head and rms(mono, tail - hop, tail) <= body * faded:
        tail -= hop
    return head / rate, (n - tail) / rate


def trim(x, channels: int, head_frames: int, tail_frames: int):
    """`x` (interleaved) without its first and last frames."""
    n = frames_of(x, channels)
    return x[head_frames * channels : (n - tail_frames) * channels]


def close_loop(x, channels: int, span: int):
    """Folds the last `span` frames over the head with an equal-power
    crossfade; the loop is `span` frames shorter than `x`. Frame `i` of the
    head becomes sin(t)·head + cos(t)·tail, t from 0 to π/2: at the first frame
    it is the tail's first frame (which follows the loop's last frame in the
    piece), at the last it is the head itself (which the next frame follows)."""
    n = frames_of(x, channels)
    span = max(0, min(span, n // 3))
    out = array.array("f", x[: (n - span) * channels])
    if span < 2:
        return out
    for i in range(span):
        turn = (math.pi / 2.0) * i / (span - 1)
        rise, fall = math.sin(turn), math.cos(turn)
        at, tail = i * channels, (n - span + i) * channels
        for c in range(channels):
            out[at + c] = x[at + c] * rise + x[tail + c] * fall
    return out


def turn(x, channels: int, frames: int):
    """The loop started `frames` later: the same circle of samples, its wrap
    moved to a point that was inside it (continuous, like every point)."""
    n = frames_of(x, channels)
    if n == 0:
        return array.array("f", x)
    at = (frames % n) * channels
    return array.array("f", x[at:]) + array.array("f", x[:at])


def envelope(mono, rate: int, hop: float = ENVELOPE_HOP) -> list[float]:
    """The level of a mono signal in dB, one value per `hop` seconds (RMS)."""
    size = max(int(rate * hop), 1)
    out = []
    for start in range(0, len(mono) - size + 1, size):
        total = 0.0
        for index in range(start, start + size):
            value = mono[index]
            total += value * value
        out.append(10.0 * math.log10(total / size + 1e-10))
    return out


def onset_curve(levels: list[float]) -> list[float]:
    """Where something starts: the rises of a level envelope (a beat, a note),
    nothing where it falls or holds."""
    return [0.0] + [max(0.0, b - a) for a, b in zip(levels, levels[1:])]


def correlation(a, b) -> float:
    """Pearson's correlation of two sequences (their common length); 0 when
    either is flat."""
    n = min(len(a), len(b))
    if n < 2:
        return 0.0
    mean_a = sum(a[:n]) / n
    mean_b = sum(b[:n]) / n
    cov = var_a = var_b = 0.0
    for i in range(n):
        da, db = a[i] - mean_a, b[i] - mean_b
        cov += da * db
        var_a += da * da
        var_b += db * db
    if var_a <= 0.0 or var_b <= 0.0:
        return 0.0
    return cov / math.sqrt(var_a * var_b)


def loop_length(mono, rate: int, shortest: float, longest: float, window: float,
                hop: float = ENVELOPE_HOP) -> tuple[float, float]:
    """The loop length, in seconds between `shortest` and `longest`, whose next
    `window` seconds look most like the first `window` (what `close_loop` lays
    over the head), and its score. The score adds the correlation of the
    onsets (beats in step), half the correlation of the energy contours, and
    takes off a sixth per dB of difference in level; a longer loop wins a tie
    (up to 0.05). `mono` starts where the loop does; a length whose window
    runs past its end is not tried."""
    levels = envelope(mono, rate, hop)
    onsets = onset_curve(levels)
    span = max(int(round(window / hop)), 2)
    low = max(int(round(shortest / hop)), 1)
    high = min(int(round(longest / hop)), len(levels) - span)
    if high < low:
        return max(min(longest, (len(levels) - span) * hop), 0.0), 0.0
    head_onsets, head_levels = onsets[:span], levels[:span]
    head_mean = sum(head_levels) / span
    best = (float("-inf"), high)
    for lag in range(low, high + 1):
        tail_levels = levels[lag : lag + span]
        score = correlation(head_onsets, onsets[lag : lag + span])
        score += 0.5 * correlation(head_levels, tail_levels)
        score -= abs(sum(tail_levels) / span - head_mean) / 6.0
        score += 0.05 * (lag - low) / max(high - low, 1)
        if score > best[0]:
            best = (score, lag)
    return round(best[1] * hop, 6), round(best[0], 3)


def _mean(values, start: int, end: int) -> float:
    start, end = max(start, 0), min(end, len(values))
    return sum(values[start:end]) / (end - start) if end > start else float("-inf")


def entry_points(levels: list[float], hop: float, body_start: float, body_end: float,
                 head: float = ENTRY_HEAD, tail: float = ENTRY_TAIL, gap: float = ENTRY_GAP,
                 most: int = ENTRY_MOST) -> list[float]:
    """Where the music director may start a piece (seconds, ascending): places
    where a phrase begins, read off its level envelope (`levels`, dB, one per
    `hop`). A place scores the rise from the second and a half before it to
    the one after (a phrase starting) plus half of how far the level just
    before it dips under the twelve seconds around (a breath between
    phrases). The best places are taken while they are at least `gap`
    seconds from every one taken, from `head` seconds on (never at 0: the
    piece's own start is not an entry) and never in the last `tail` seconds
    of the body (`body_end`, where the composed ending fades), so an entry
    always has that much music after it. A place whose next second and a
    half is 20 dB under the body (a hole) is never one. Up to `most`."""
    n = len(levels)
    if n == 0 or hop <= 0:
        return []
    near = max(int(round(1.5 / hop)), 1)
    around = max(int(round(6.0 / hop)), 1)
    first = max(int(math.ceil(max(head, body_start) / hop)), 1)
    last = min(int(math.floor((body_end - tail) / hop)), n - near)
    if last < first:
        return []
    body = _mean(levels, int(body_start / hop), int(body_end / hop))
    scored = []
    for i in range(first, last + 1):
        before, after = _mean(levels, i - near, i), _mean(levels, i, i + near)
        if after < body - 20.0:
            continue
        dip = max(0.0, _mean(levels, i - around, i + around) - before)
        scored.append((after - before + 0.5 * dip, i))
    scored.sort(key=lambda s: (-s[0], s[1]))
    taken: list[int] = []
    span = gap / hop
    for _score, i in scored:
        if all(abs(i - t) >= span for t in taken):
            taken.append(i)
            if len(taken) >= most:
                break
    return [round(i * hop, 2) for i in sorted(taken)]


def longest_quiet(levels: list[float], hop: float, start: float, end: float, under: float = QUIET_DB) -> float:
    """The longest run, in seconds, of the envelope between `start` and `end`
    that stays `under` dB below the body's mean level there: a hole in the
    music (a take that cut out, or a long pause)."""
    a, b = max(int(start / hop), 0), min(int(end / hop), len(levels))
    if b <= a:
        return 0.0
    floor = _mean(levels, a, b) - under
    best = run = 0
    for value in levels[a:b]:
        run = run + 1 if value < floor else 0
        best = max(best, run)
    return round(best * hop, 2)


def piece_problems(record: dict) -> list[str]:
    """Why a converted piece should not play in the game, from its measures
    (`convert(loop=False)`): too short to be a whole take, silent or unmeasured
    loudness, a hole in the music, or no place to start but its beginning.
    Empty: it passes."""
    problems = []
    seconds = float(record.get("source_seconds") or 0.0)
    if seconds < MIN_PIECE_SECONDS:
        problems.append("%.0f s long, under %.0f s" % (seconds, MIN_PIECE_SECONDS))
    lufs = record.get("lufs_in")
    if not isinstance(lufs, (int, float)) or not math.isfinite(lufs) or lufs < MIN_LUFS:
        problems.append("loudness %s LUFS, under %.0f" % (lufs, MIN_LUFS))
    quiet = float(record.get("longest_quiet") or 0.0)
    if quiet > MAX_QUIET_SECONDS:
        problems.append("%.1f s of near silence inside the music" % quiet)
    if len(record.get("entries") or []) < MIN_ENTRIES:
        problems.append("%d entry points, under %d" % (len(record.get("entries") or []), MIN_ENTRIES))
    return problems


def percentile(values: list[float], share: float) -> float:
    """The `share` (0..1) percentile of `values`, nearest rank."""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = min(max(int(math.ceil(share * len(ordered))) - 1, 0), len(ordered) - 1)
    return ordered[rank]


def seam_score(x, channels: int, rate: int, window: float = 0.25) -> float:
    """How big the step across the wrap (last frame to first) is, against the
    99th percentile of the ordinary steps within `window` seconds either side
    of it. Under 1.0 the seam is quieter than the music around it; a click
    reads several times over. On every channel, the worse."""
    n = frames_of(x, channels)
    span = max(min(int(rate * window), n // 2), 2)
    worst = 0.0
    for c in range(channels):
        tail = [x[(n - span + i) * channels + c] for i in range(span)]
        head = [x[i * channels + c] for i in range(span)]
        steps = [abs(b - a) for a, b in zip(tail, tail[1:])] + [abs(b - a) for a, b in zip(head, head[1:])]
        jump = abs(head[0] - tail[-1])
        worst = max(worst, jump / max(percentile(steps, 0.99), 1e-9))
    return worst


def loudness_gain(input_i: float, input_tp: float, target_i: float = LUFS, ceiling_tp: float = TRUE_PEAK) -> float:
    """The one gain, in dB, that brings integrated loudness `input_i` to
    `target_i` without the true peak passing `ceiling_tp`. A silent input
    (no loudness) gets none."""
    if not math.isfinite(input_i):
        return 0.0
    gain = target_i - input_i
    if math.isfinite(input_tp):
        gain = min(gain, ceiling_tp - input_tp)
    return round(gain, 2)


def parse_loudnorm(stderr: str) -> dict:
    """The JSON block ffmpeg's `loudnorm=print_format=json` prints last, as
    floats ("-inf" for silence)."""
    end = stderr.rfind("}")
    start = stderr.rfind("{", 0, end)
    if start < 0 or end < 0:
        raise ValueError("no loudnorm report in ffmpeg's output")
    raw = json.loads(stderr[start : end + 1])
    out = {}
    for key, value in raw.items():
        try:
            out[key] = float(value)
        except (TypeError, ValueError):
            out[key] = value
    return out


# --- ffmpeg -------------------------------------------------------------------------------


def ffmpeg() -> str:
    """The ffmpeg on PATH (the one `make sounds` uses), or the copy bundled
    with imageio-ffmpeg."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg
    except ImportError as missing:
        raise SystemExit("no ffmpeg: install one with libopus, or pip install imageio-ffmpeg") from missing
    return imageio_ffmpeg.get_ffmpeg_exe()


def decode(path: str, rate: int, channels: int):
    """The file as interleaved 32-bit floats at `rate`."""
    done = subprocess.run(
        [ffmpeg(), "-v", "error", "-i", path, "-f", "f32le", "-acodec", "pcm_f32le", "-ac", str(channels), "-ar", str(rate), "-"],
        capture_output=True,
    )
    if done.returncode != 0:
        raise SystemExit("could not decode %s\n%s" % (path, done.stderr.decode(errors="replace")[:400]))
    samples = array.array("f")
    samples.frombytes(done.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def _pcm_input(rate: int, channels: int) -> list[str]:
    return ["-f", "f32le", "-ar", str(rate), "-ac", str(channels), "-i", "pipe:0"]


def _bytes_of(x) -> bytes:
    if sys.byteorder != "little":
        x = array.array("f", x)
        x.byteswap()
    return x.tobytes()


def measure_loudness(x, rate: int, channels: int) -> dict:
    """Integrated loudness, true peak and range of `x`, measured by ffmpeg's
    loudnorm filter (its first pass: nothing is changed)."""
    done = subprocess.run(
        [ffmpeg(), "-hide_banner", "-nostats", *_pcm_input(rate, channels), "-af",
         "loudnorm=I=%s:TP=%s:LRA=11:print_format=json" % (LUFS, TRUE_PEAK), "-f", "null", "-"],
        input=_bytes_of(x),
        capture_output=True,
    )
    if done.returncode != 0:
        raise SystemExit("ffmpeg could not measure the loudness\n%s" % done.stderr.decode(errors="replace")[-400:])
    return parse_loudnorm(done.stderr.decode(errors="replace"))


def encode_opus(x, rate: int, channels: int, kbps: int, gain_db: float, out: str) -> None:
    """`x` with `gain_db` applied, as Ogg Opus at `kbps`."""
    done = subprocess.run(
        [ffmpeg(), "-hide_banner", "-loglevel", "error", "-y", *_pcm_input(rate, channels),
         "-af", "volume=%.2fdB" % gain_db, "-c:a", "libopus", "-b:a", "%dk" % kbps, "-vbr", "on",
         "-application", "audio", "-map_metadata", "-1", "-f", "ogg", out],
        input=_bytes_of(x),
        capture_output=True,
    )
    if done.returncode != 0:
        raise SystemExit("ffmpeg could not encode Opus (does it have libopus?)\n%s" % done.stderr.decode(errors="replace")[-400:])


# --- the step ------------------------------------------------------------------------------


def _delivery_record(source: str) -> dict:
    """What `music_web` wrote about this delivery (its sidecar), when there is one."""
    path = os.path.splitext(source)[0] + ".json"
    try:
        with open(path, encoding="utf-8") as handle:
            record = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(record, dict):
        return {}
    keep = ("tool", "slot", "prompt", "mode", "started", "finished", "title", "gemini_title", "track_seconds", "sha256", "url",
            "refs")
    return {key: record[key] for key in keep if key in record}


def convert(source: str, out: str, kbps: int = KBPS, channels: int = CHANNELS, lufs: float = LUFS,
            true_peak: float = TRUE_PEAK, crossfade: float = CROSSFADE, loop: bool = True,
            max_seconds: float = 0.0) -> dict:
    """Converts one delivery and returns the record written beside it. With
    `max_seconds`, a longer piece loops over its first `loop_length` seconds."""
    record: dict = {"source": os.path.basename(source)}
    with open(source, "rb") as handle:
        record["source_sha256"] = hashlib.sha256(handle.read()).hexdigest()
    x = decode(source, RATE, channels)
    record["source_seconds"] = round(frames_of(x, channels) / RATE, 2)
    if loop:
        light = decode(source, ANALYSIS_RATE, 1)
        head, tail = fade_bounds(light, ANALYSIS_RATE)
        x = trim(x, channels, int(head * RATE), int(tail * RATE))
        record["fade_in_cut"] = round(head, 2)
        record["fade_out_cut"] = round(tail, 2)
        span = int(crossfade * RATE)
        if max_seconds > 0 and frames_of(x, channels) > int(max_seconds * RATE) + span:
            body = light[int(head * ANALYSIS_RATE) : len(light) - int(tail * ANALYSIS_RATE)]
            length, score = loop_length(body, ANALYSIS_RATE, max_seconds * LOOP_RANGE, max_seconds, crossfade)
            x = x[: (int(round(length * RATE)) + span) * channels]
            record.update({"max_seconds": max_seconds, "excerpt_seconds": length, "excerpt_score": score})
        record["seam_uncut"] = round(seam_score(x, channels, RATE), 3)
        x = close_loop(x, channels, span)
        record["crossfade"] = crossfade
        record["seam_loop"] = round(seam_score(x, channels, RATE), 3)
    else:
        # A whole piece: nothing is cut; its fades, its entry points and its holes are
        # measured for the music director (client/src/audio/director.ts).
        light = decode(source, ANALYSIS_RATE, 1)
        head, tail = fade_bounds(light, ANALYSIS_RATE)
        levels = envelope(light, ANALYSIS_RATE, ENTRY_HOP)
        body_end = len(light) / ANALYSIS_RATE - tail
        record.update({
            "analysis": ANALYSIS,
            "entry_settings": entry_settings(),
            "fade_in": round(head, 2),
            "fade_out": round(tail, 2),
            "body_end": round(body_end, 2),
            "entries": entry_points(levels, ENTRY_HOP, head, body_end),
            "longest_quiet": longest_quiet(levels, ENTRY_HOP, head, body_end),
        })
    record["loop_seconds" if loop else "seconds"] = round(frames_of(x, channels) / RATE, 3)
    measured = measure_loudness(x, RATE, channels)
    gain = loudness_gain(float(measured.get("input_i", float("-inf"))), float(measured.get("input_tp", float("-inf"))), lufs, true_peak)
    record.update({"lufs_in": measured.get("input_i"), "true_peak_in": measured.get("input_tp"),
                   "lufs_target": lufs, "true_peak_ceiling": true_peak, "gain_db": gain})
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    turns = TURNS if loop else 1
    best = None
    record["seam_turns"] = []
    for index in range(turns):
        candidate = turn(x, channels, int(index * TURN_MS * RATE / 1000)) if index else x
        trial = out if index == 0 else out + ".turn"
        encode_opus(candidate, RATE, channels, kbps, gain, trial)
        decoded = decode(trial, RATE, channels)
        score = seam_score(decoded, channels, RATE) if loop else 0.0
        record["seam_turns"].append(round(score, 3))
        if best is None or score < best[0]:
            if trial != out:
                os.replace(trial, out)
            best = (score, index, candidate, decoded)
        elif os.path.exists(trial):
            os.remove(trial)
        if score <= SEAM_GOOD:
            break
    _score, kept, x, shipped = best
    record["turn_ms"] = kept * TURN_MS
    record.update({
        "out": os.path.basename(out),
        "kbps": kbps,
        "channels": channels,
        "bytes": os.path.getsize(out),
        "decoded_seconds": round(frames_of(shipped, channels) / RATE, 3),
        "length_error_frames": frames_of(shipped, channels) - frames_of(x, channels),
        "over_music_budget": os.path.getsize(out) > MUSIC_FILE_BUDGET,
    })
    if loop:
        record["seam_encoded"] = round(seam_score(shipped, channels, RATE), 3)
    record["lufs_out"] = measure_loudness(shipped, RATE, channels).get("input_i")
    with open(out, "rb") as handle:
        record["sha256"] = hashlib.sha256(handle.read()).hexdigest()
    delivery = _delivery_record(source)
    if delivery:
        record["delivery"] = delivery
    with open(os.path.splitext(out)[0] + ".json", "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=1, ensure_ascii=False)
        handle.write("\n")
    return record


def main() -> int:
    sys.stdout.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tracks", nargs="+")
    parser.add_argument("--out", default="", help="output .ogg (one track only); default build/gemini/convert/<stem>.ogg")
    parser.add_argument("--out-dir", default=OUT_DIR)
    parser.add_argument("--kbps", type=int, default=KBPS)
    parser.add_argument("--channels", type=int, choices=(1, 2), default=CHANNELS)
    parser.add_argument("--lufs", type=float, default=LUFS)
    parser.add_argument("--true-peak", type=float, default=TRUE_PEAK)
    parser.add_argument("--crossfade", type=float, default=CROSSFADE)
    parser.add_argument("--no-loop", action="store_true", help="a cue that plays once: no fades cut, no fold")
    parser.add_argument("--max-seconds", type=float, default=0.0,
                        help="loop a longer piece over its first ~N seconds (loop_length picks them); 0 = all of it")
    args = parser.parse_args()
    if args.out and len(args.tracks) > 1:
        raise SystemExit("--out names one file: pass one track, or use --out-dir")
    for track in args.tracks:
        out = args.out or os.path.join(args.out_dir, os.path.splitext(os.path.basename(track))[0] + ".ogg")
        record = convert(track, out, args.kbps, args.channels, args.lufs, args.true_peak, args.crossfade, not args.no_loop,
                         args.max_seconds)
        print(
            "%s: %s s loop, fades cut %s/%s s, %s -> %s LUFS (gain %s dB), seam %s, %d KB%s"
            % (out, record.get("loop_seconds", record.get("seconds")), record.get("fade_in_cut", 0), record.get("fade_out_cut", 0),
               record["lufs_in"], record["lufs_out"], record["gain_db"], record.get("seam_encoded", "-"),
               record["bytes"] // 1024, " (over docs/07's 256 KB a music file)" if record["over_music_budget"] else "")
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
