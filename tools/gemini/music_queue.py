"""Asks for the slots of `music_slots.json` one ask at a time, and never hammers.

A port of Ants of Neque's `tools/music_queue.py`, cut to what this game needs
today: no auditions or measures (the owner listens to the files, and
`music_convert.py` measures the one that ships), the same rules for the browser
and the quota.

    python tools/gemini/music_queue.py status [--into build/gemini/music]
    python tools/gemini/music_queue.py run [--into DIR] [--slots title,bosque] [--takes 2]
                                       [--retries 2] [--limit N] [--wait 720] [--max-sleep 21600]
                                       [--modes Hydrogen,Argon] [--stall-cooldown 300]

## What is on disk is the truth

Each ask is `<into>/<slot>_<n>.mp4` and `music_web`'s sidecar `<slot>_<n>.json`,
and a slot's state is read back from those every time: nothing else keeps a
list. A slot wants `--takes` tracks (an `ok` sidecar with its file); it is
asked again until it has them, at most `--retries` asks more, counted across
runs. Only asks that reached Gemini and were answered count (`spent_of`).

## Never hammer

- **One ask at a time**, through `music_web.py`, which holds `browser_lock`.
- **A stated reset hour is slept to** (`--max-sleep` caps it; past it the run
  stops and says when to come back). The menu's own "el límite se restablece"
  is read the same way.
- **Paced by the window** Ants of Neque measured: about `WINDOW_TRACKS` tracks
  in any `WINDOW`. With that many delivered in the last hour the queue sleeps
  until the oldest ages out. A masked wall with no hour is slept to that once a
  run; a second one stops it.
- **A masked wall moves to the next mode** (`--modes`, best first): Hydrogen's
  own cap answering as a text model leaves Argon to try (`page_rules.next_modes`).
- **Stalls and unsent asks are trouble, not answers**: never spent up to
  `STALLS_FREE` stalls a slot, `--stall-cooldown` before the next ask, and
  `TROUBLE_LIMIT` in a row (or `UNSENT_LIMIT` unsent) stop the run. A driver
  that fails after the ask went, a signed-out browser or a lock held past its
  wait stop it at once.
- **A track still generating** when the wait ran out is fetched off its
  conversation, never asked again (`FETCHES` times across runs).

A run can sleep for hours, so start it in the background, never inside a shell
with a ten-minute limit. When its output is rejected, stop the queue's process
too (a sleeping queue keeps delivering), then delete the files.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import music_style  # noqa: E402
import page_rules as rules  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
INTO = os.path.join(ROOT, "build", "gemini", "music")

UNSENT = ("not_sent", "signed_out", "busy", "")
STALLED = ("stalled",)
NOT_SPENT = ("quota", "masked") + STALLED + UNSENT
DELIVERED = ("ok", "twice", "fast")
UNSENT_LIMIT = 2
STALLS_FREE = 2
TROUBLE_LIMIT = 6
STALL_COOLDOWN = 300.0
FETCHES = 3
## About seven tracks in any sixty minutes (Ants of Neque, 2026-10-03,
## measured once and not proven), so the queue paces itself by it.
WINDOW = 3600.0
WINDOW_TRACKS = 7


def _read(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as handle:
            found = json.load(handle)
    except (OSError, ValueError):
        return None
    return found if isinstance(found, dict) else None


def asks_of(into: str, slot_id: str) -> dict[int, dict]:
    """Every ask made for a slot, by its number: the sidecar and the track if
    one came."""
    found = {}
    if not os.path.isdir(into):
        return found
    for name in os.listdir(into):
        hit = re.fullmatch(re.escape(slot_id) + r"_(\d+)\.json", name)
        if not hit:
            continue
        number = int(hit.group(1))
        stem = os.path.join(into, "%s_%d" % (slot_id, number))
        found[number] = {
            "stem": stem,
            "sidecar": _read(stem + ".json") or {},
            "track": stem + ".mp4" if os.path.exists(stem + ".mp4") else "",
        }
    return dict(sorted(found.items()))


def outcome_of(sidecar: dict) -> str:
    """An ask's outcome as the queue reads it: music_web's own, but a
    `timeout` whose address never left the fresh chat's is a stall."""
    outcome = sidecar.get("outcome", "")
    if outcome == "timeout" and not rules.is_conversation(sidecar.get("url", "")):
        return "stalled"
    return outcome


def paid_stalls_of(asks: dict[int, dict]) -> list[int]:
    """A slot's stalls past the first `STALLS_FREE`, which count as spent."""
    stalls = [n for n, ask in asks.items() if outcome_of(ask["sidecar"]) in STALLED]
    return stalls[STALLS_FREE:]


def spent_of(asks: dict[int, dict]) -> list[int]:
    """The asks that count against a slot's retries: every one that reached
    Gemini, but a quota's answer and a stall up to `STALLS_FREE`."""
    paid = paid_stalls_of(asks)
    return [n for n, ask in asks.items() if outcome_of(ask["sidecar"]) not in NOT_SPENT or n in paid]


def live_of(asks: dict[int, dict]) -> list[int]:
    """The asks that delivered a new track."""
    return [n for n, ask in asks.items() if ask["track"] and ask["sidecar"].get("outcome") == "ok"]


def recent_tracks(into: str, now: datetime.datetime) -> list[datetime.datetime]:
    """When each track delivered in the last `WINDOW` finished, oldest first."""
    found = []
    if not os.path.isdir(into):
        return found
    for name in os.listdir(into):
        if not name.endswith(".json"):
            continue
        record = _read(os.path.join(into, name))
        if not record or record.get("kind") != "music" or record.get("outcome") not in DELIVERED:
            continue
        try:
            done = datetime.datetime.fromisoformat(record.get("finished", ""))
        except ValueError:
            continue
        if (now - done).total_seconds() < WINDOW:
            found.append(done)
    return sorted(found)


def window_reopens(into: str, now: datetime.datetime, any_count: bool = False) -> str:
    """The hour a track can be asked for again, or "" when it can be now: the
    oldest delivery in the window plus `WINDOW`, once the window holds
    `WINDOW_TRACKS` (or any, after a masked refusal: `any_count`)."""
    recent = recent_tracks(into, now)
    if not recent or (len(recent) < WINDOW_TRACKS and not any_count):
        return ""
    oldest = recent[0] if any_count else recent[len(recent) - WINDOW_TRACKS]
    return (oldest + datetime.timedelta(seconds=WINDOW)).isoformat(timespec="seconds")


def seconds_until(when: str, now: datetime.datetime) -> float | None:
    """Seconds from `now` to an ISO hour (plus a minute of slack), or None when
    it does not read."""
    try:
        target = datetime.datetime.fromisoformat(when)
    except ValueError:
        return None
    return max((target - now).total_seconds() + 60.0, 0.0)


class Queue:
    """One run. The browser (`ask`, `fetch`), the clock (`now`) and `sleep` are
    injected, so the rules are tested without Gemini or waiting."""

    def __init__(self, args, ask=None, fetch=None, sleep=time.sleep, now=datetime.datetime.now, say=print):
        self.args = args
        self.ask = ask or ask_one
        self.fetch = fetch or fetch_one
        self.sleep = sleep
        self.now = now
        self.say = say
        self.modes = rules.configured_modes(getattr(args, "modes", ""))

    def sleep_until(self, when: str) -> bool:
        """Sleeps to a stated hour, or says it will not (past `--max-sleep`)."""
        seconds = seconds_until(when, self.now())
        if seconds is None:
            return False
        if seconds > self.args.max_sleep:
            self.say("the quota comes back at %s, past --max-sleep; run again then" % when)
            return False
        self.say("the quota comes back at %s: sleeping %.0f s" % (when, seconds))
        self.sleep(seconds)
        return True

    def run(self, slots: list[dict], book: dict) -> int:
        """Asks every slot until it has its takes or its retries are spent.
        Returns the number of asks that reached Gemini."""
        args = self.args
        asked = unsent = trouble = 0
        cool = masked_once = False
        for slot in slots:
            pending = self.collect(slot)
            if pending:
                self.say("%s: an earlier ask may still be generating; not asked again yet" % slot["id"])
                continue
            while True:
                asks = asks_of(args.into, slot["id"])
                live = live_of(asks)
                if len(live) >= args.takes:
                    break
                spent = spent_of(asks)
                if len(spent) >= args.takes + args.retries:
                    self.say("%s: %d asks, %d tracks; the retries are spent" % (slot["id"], len(spent), len(live)))
                    break
                if args.limit and asked >= args.limit:
                    self.say("the limit of %d asks is reached" % args.limit)
                    return asked
                reopens = window_reopens(args.into, self.now())
                if reopens and not self.sleep_until(reopens):
                    return asked
                if cool:
                    self.say("the last ask stalled: waiting %.0f s before the next" % args.stall_cooldown)
                    self.sleep(args.stall_cooldown)
                    cool = False
                number = max(asks) + 1 if asks else 1
                text = music_style.prompt(book, slot, len(live) + 1)
                code = self.ask(slot["id"], number, text, self.modes)
                sidecar = _read(os.path.join(args.into, "%s_%d.json" % (slot["id"], number))) or {}
                outcome = outcome_of(sidecar)
                if code == rules.BUSY:
                    self.say("another driver held the browser past the wait; stopping")
                    return asked
                if code == rules.SIGNED_OUT:
                    self.say("the browser is signed out: the owner signs in in its window; stopping")
                    return asked
                if outcome in UNSENT:
                    unsent += 1
                    trouble += 1
                    self.say("%s: nothing reached Gemini (%s, exit %d)" % (slot["id"], outcome or "no outcome", code))
                    if unsent >= UNSENT_LIMIT or trouble >= TROUBLE_LIMIT:
                        self.say("%d asks in a row never reached Gemini or stalled; stopping. Look at the page "
                                 "(`gemini_web.py check`) and the driver's last lines" % trouble)
                        return asked
                    continue
                unsent = 0
                asked += 1
                if code not in rules.CODES:
                    self.say("%s: music_web failed (exit %d) after the ask went (%s); stopping" % (slot["id"], code, outcome))
                    return asked
                if outcome in STALLED:
                    trouble += 1
                    cool = True
                    self.say("%s: stalled, no conversation was made: nothing to fetch" % slot["id"])
                    if trouble >= TROUBLE_LIMIT:
                        self.say("%d troubles in a row; stopping: run again later" % trouble)
                        return asked
                    continue
                if outcome not in NOT_SPENT:
                    trouble = 0
                if code == rules.TIMEOUT and rules.is_conversation(sidecar.get("url", "")):
                    code = self.fetch(slot["id"], number, sidecar["url"])
                    sidecar = _read(os.path.join(args.into, "%s_%d.json" % (slot["id"], number))) or {}
                    if code == rules.TIMEOUT:
                        self.say("%s: still generating at %s; the next run fetches it" % (slot["id"], sidecar["url"]))
                        break
                if code in (rules.OK, rules.STALE):
                    continue
                if code == rules.QUOTA:
                    after = rules.next_modes(sidecar, self.modes)
                    if after:
                        self.say("masked in %r: that mode's own cap; asking in %s from here"
                                 % (sidecar.get("mode"), ", ".join(after)))
                        self.modes = after
                        continue
                    when = sidecar.get("reset", "")
                    if not when and sidecar.get("outcome") == "masked" and not masked_once:
                        when = window_reopens(args.into, self.now(), any_count=True)
                        masked_once = True
                    if not when:
                        self.say("the quota states no hour, and the window does not explain it; run again later")
                        return asked
                    if not self.sleep_until(when):
                        return asked
                    continue
                self.say("%s: %s, an ask spent" % (slot["id"], sidecar.get("outcome", "no answer")))
        self.say("asked %d this run" % asked)
        return asked

    def collect(self, slot: dict) -> bool:
        """Fetches what earlier runs left generating (`timeout`, or `sent` by a
        driver that was killed). Returns whether one may still land."""
        pending = False
        for number, ask in asks_of(self.args.into, slot["id"]).items():
            sidecar = ask["sidecar"]
            if (
                not ask["track"]
                and sidecar.get("outcome") in ("timeout", "sent")
                and rules.is_conversation(sidecar.get("url", ""))
                and len(sidecar.get("fetched", [])) < FETCHES
            ):
                self.say("%s #%d: fetching what %s left" % (slot["id"], number, sidecar["url"]))
                self.fetch(slot["id"], number, sidecar["url"])
                again = (_read(ask["stem"] + ".json") or {}).get("fetched", [])
                waiting = bool(again) and again[-1].get("outcome") == "timeout"
                if not os.path.exists(ask["stem"] + ".mp4") and len(again) < FETCHES and waiting:
                    pending = True
        return pending


def ask_one(slot_id: str, number: int, text: str, modes: tuple[str, ...], args=None) -> int:
    """One ask through music_web.py, in the foreground of this process."""
    args = args or ARGS
    print("asking %s (#%d) at %s in %s" % (slot_id, number, datetime.datetime.now().strftime("%H:%M"), ", ".join(modes)), flush=True)
    command = [
        sys.executable, os.path.join(HERE, "music_web.py"), "ask", text,
        "--name", "%s_%d" % (slot_id, number), "--out-dir", args.into, "--slot", slot_id,
        "--seen", args.into, "--wait", str(args.wait), "--modes", ",".join(modes),
    ]
    return subprocess.run(command, cwd=ROOT).returncode


def fetch_one(slot_id: str, number: int, url: str, args=None) -> int:
    """Takes a track off a conversation already asked: no quota spent."""
    args = args or ARGS
    command = [
        sys.executable, os.path.join(HERE, "music_web.py"), "fetch", url,
        "--name", "%s_%d" % (slot_id, number), "--out-dir", args.into, "--seen", args.into,
        "--wait", str(args.fetch_wait),
    ]
    return subprocess.run(command, cwd=ROOT).returncode


ARGS = None


def pick(slots: list[dict], wanted: str) -> list[dict]:
    if not wanted:
        return slots
    names = wanted.split(",")
    missing = [name for name in names if name not in {slot["id"] for slot in slots}]
    if missing:
        raise SystemExit("no such slot: %s" % ", ".join(missing))
    return [slot for slot in slots if slot["id"] in names]


def do_status(args) -> int:
    book = music_style.load()
    for slot in pick(book["slots"], args.slots):
        asks = asks_of(args.into, slot["id"])
        live = live_of(asks)
        spent = spent_of(asks)
        last = outcome_of(asks[max(asks)]["sidecar"]) if asks else "-"
        print("%-14s %d track(s), %d ask(s), %d spent, last %s" % (slot["id"], len(live), len(asks), len(spent), last))
        for number in live:
            record = asks[number]["sidecar"]
            print("    #%d %s (%s s, mode %r)" % (number, record.get("title") or record.get("gemini_title", ""),
                                                  record.get("track_seconds", "?"), record.get("mode", "")))
    return 0


def do_run(args) -> int:
    global ARGS
    ARGS = args
    os.makedirs(args.into, exist_ok=True)
    book = music_style.load()
    Queue(args).run(pick(book["slots"], args.slots), book)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="what", required=True)
    status = sub.add_parser("status", help="what is on disk, slot by slot")
    status.add_argument("--into", default=INTO)
    status.add_argument("--slots", default="")
    status.set_defaults(run=do_status)
    run = sub.add_parser("run", help="ask until every slot has its takes")
    run.add_argument("--into", default=INTO)
    run.add_argument("--slots", default="")
    run.add_argument("--takes", type=int, default=2, help="tracks wanted per slot")
    run.add_argument("--retries", type=int, default=2, help="asks allowed beyond the takes")
    run.add_argument("--limit", type=int, default=0, help="asks this run at most (0: no limit)")
    run.add_argument("--wait", type=float, default=720.0)
    run.add_argument("--fetch-wait", type=float, default=120.0)
    run.add_argument("--max-sleep", type=float, default=6 * 3600.0)
    run.add_argument("--stall-cooldown", type=float, default=STALL_COOLDOWN)
    run.add_argument("--modes", default="", help="mode patterns, best first (default GEMINI_MODES or Hydrogen,Argon)")
    run.set_defaults(run=do_run)
    return parser


def main() -> int:
    sys.stdout.reconfigure(errors="replace", line_buffering=True)
    args = build_parser().parse_args()
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
