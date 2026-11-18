"""Turns a delivered track (Gemini's MP4/AAC) into an Ogg Opus loop the client can play.

The port of Ants of Neque's `tools/convert_beds.py`, for this game's audio: the
client plays music with a Web Audio `AudioBufferSourceNode` and `loop = true`
(`client/src/audio/engine.ts`), so a loop is the whole file, wrapped sample for
sample, and Ogg Opus is the format `assets/sounds/` ships (`tools/soundgen`).

Every delivery is a finished *piece*: it opens, it closes, and it ends in
silence, so it cannot loop as it is. Four steps get from one to the other:

1. **The fades come off** (`fade_bounds`): walked in from each end, a tenth of
   a second at a time, while the level is under half the body's. Blunt on
   purpose: what matters is that the crossfade meets music at both ends.
2. **The loop is closed** (`close_loop`): the last `--crossfade` seconds are
   folded back over the head with an equal-power crossfade (a linear one dips
   about 3 dB in the middle, a hole at the exact moment the seam hides). The
   loop's last sample is followed by the sample that came after it in the
   piece, so the wrap is continuous by construction, not by luck.
3. **Loudness normalised with one constant gain** (`loudness_gain`): ffmpeg's
   EBU R128 meter (`loudnorm`, measuring only) reads the loop's integrated
   loudness and true peak, and a single gain brings it to `--lufs`, never past
   `--true-peak`. A time-varying normaliser would end the loop at a different
   gain from the one it starts at, and the seam would jump.
4. **Encoded to Ogg Opus** at 48 kHz, and decoded back to measure what ships:
   the seam (`seam_score`: the step across the wrap against the ordinary steps
   around it; under 1 is quieter than the music) and the length.
5. **The seam survives the encoder** (`turn`): the last frame's coding error
   and the first's come from two unrelated frames, so a seam that is clean in
   the samples can step after encoding (3.3 on the first real track,
   2026-11-18, from 0.81 before it). The loop is a circle, so it is turned by
   `TURN_MS` at a time, encoded again, and kept at the first turn whose
   encoded seam is ordinary (`SEAM_GOOD`), or the best of `TURNS` (Ants of
   Neque did the same for MP3). A turn starts the music a few hundred
   milliseconds later; nothing is lost.

Needs ffmpeg with libopus: the one on PATH (as `make sounds` uses) or the copy
inside `imageio-ffmpeg`. Build-time only; nothing of it reaches the game.

    python tools/gemini/music_convert.py <track.mp4> [--out build/gemini/convert/<stem>.ogg]
        [--kbps 32] [--channels 2] [--lufs -18] [--true-peak -1.5] [--crossfade 4] [--no-loop]

It never writes into `assets/`: the owner listens to the `.ogg` first, and then
it is copied by hand with its prompt file and its `CREDITS.md` row
(`credit.py`). `<out stem>.json` beside it holds the measures and, when the
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
LUFS = -18.0
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
## docs/07 "Audio": one music file of assets/sounds.yaml (soundgen's budget).
MUSIC_FILE_BUDGET = 256 * 1024


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
    keep = ("tool", "slot", "prompt", "mode", "started", "finished", "title", "gemini_title", "track_seconds", "sha256", "url")
    return {key: record[key] for key in keep if key in record}


def convert(source: str, out: str, kbps: int = KBPS, channels: int = CHANNELS, lufs: float = LUFS,
            true_peak: float = TRUE_PEAK, crossfade: float = CROSSFADE, loop: bool = True) -> dict:
    """Converts one delivery and returns the record written beside it."""
    record: dict = {"source": os.path.basename(source)}
    with open(source, "rb") as handle:
        record["source_sha256"] = hashlib.sha256(handle.read()).hexdigest()
    x = decode(source, RATE, channels)
    record["source_seconds"] = round(frames_of(x, channels) / RATE, 2)
    if loop:
        head, tail = fade_bounds(decode(source, ANALYSIS_RATE, 1), ANALYSIS_RATE)
        x = trim(x, channels, int(head * RATE), int(tail * RATE))
        record["fade_in_cut"] = round(head, 2)
        record["fade_out_cut"] = round(tail, 2)
        record["seam_uncut"] = round(seam_score(x, channels, RATE), 3)
        x = close_loop(x, channels, int(crossfade * RATE))
        record["crossfade"] = crossfade
        record["seam_loop"] = round(seam_score(x, channels, RATE), 3)
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
    args = parser.parse_args()
    if args.out and len(args.tracks) > 1:
        raise SystemExit("--out names one file: pass one track, or use --out-dir")
    for track in args.tracks:
        out = args.out or os.path.join(args.out_dir, os.path.splitext(os.path.basename(track))[0] + ".ogg")
        record = convert(track, out, args.kbps, args.channels, args.lufs, args.true_peak, args.crossfade, not args.no_loop)
        print(
            "%s: %s s loop, fades cut %s/%s s, %s -> %s LUFS (gain %s dB), seam %s, %d KB%s"
            % (out, record.get("loop_seconds", record.get("seconds")), record.get("fade_in_cut", 0), record.get("fade_out_cut", 0),
               record["lufs_in"], record["lufs_out"], record["gain_db"], record.get("seam_encoded", "-"),
               record["bytes"] // 1024, " (over docs/07's 256 KB a music file)" if record["over_music_budget"] else "")
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
