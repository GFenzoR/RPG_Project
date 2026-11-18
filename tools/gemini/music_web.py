"""Asks the Gemini web app for a piece of music, through the owner's browser.

The twin of `gemini_web.py` and it uses that file's door: the same attach to the
Chrome the owner started with `--remote-debugging-port=9222`, the same composer,
the same tools menu, the same lock. **It never signs in, never reads a cookie and
never handles a credential**: a download is a request the attached page makes
as itself. Ported from Ants of Neque's `tools/music_web.py`.

    python tools/gemini/music_web.py ask "<prompt>" --name title_1 [--out-dir build/gemini/music]
                                     [--modes Hydrogen,Argon] [--ref a.mp3 ...] [--wait 720]
    python tools/gemini/music_web.py fetch <conversation url> --name title_1

## What an answer is

A `<generated-music>` element holding a `<video>` whose `src` is a download
link: about three minutes of stereo AAC at 44.1 kHz in an MP4 with a square
cover, Gemini's title in its metadata. Every ask chooses the music tool first
("Crear música", a `<gem-menu-item role=menuitemcheckbox>` since late 2026) and
sets it to full length and instrumental. On 2026-11-17 a track took 75-130 s in
Hydrogen.

**The text lies.** A reply can read "solo genero texto" with the track right
under it, so the media decides; the text is only read to say *why* when no
media came (`page_rules.classify`).

## Every ask leaves a sidecar

`<name>.json` beside the file, on success and failure alike: the prompt, the
references and their digests, the outcome, the seconds taken, the conversation
URL (`conversation_at`: how long after sending it appeared), the mode, the
reply's text, what the composer held before it was emptied, and for a track
its title, length, sha256 and bytes. A quota refusal records the hour it
resets when the page states one (`reset`), and the queue sleeps to it.

The outcome starts as `not_sent` and becomes `sent` only once the question is
on the page; the sidecar is written then, before the wait, so a driver killed
mid-track leaves an ask the queue can `fetch`. `unconfirmed` is the one doubt:
the composer emptied but the page never showed the question (counted as spent).

## The tells (Ants of Neque)

- **"ok" in under `FASTEST` seconds** is an old track: flagged `fast`, exit `STALE`.
- **The last answer, served twice**: a digest already in a sidecar under
  `--seen` is flagged `twice`, exit `STALE`.
- **A page is not a track**: what is downloaded must open like an MP4 or an
  audio file, or it is not written.
- **A stall**: an ask whose address never became a conversation's (or whose
  question was handed back to the composer) is `stalled`, not `timeout`:
  there is nothing to fetch, and the queue does not count it against the slot.

Exit codes are `page_rules`': 0 a track; `QUOTA` (stated, or `masked`: the reply
that says it is a text model), `POLICY`, `ERROR`, `NOTHING` the refusals;
`STALE`, `BUSY`, `SIGNED_OUT`, `TIMEOUT` (`fetch` it later), `STALLED`.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import browser_lock  # noqa: E402
import gemini_web as web  # noqa: E402
import page_rules as rules  # noqa: E402
import prompt_guard  # noqa: E402

## How long a music ask is waited for. Ants of Neque saw tracks take up to
## 557 s in a slow hour; neither a bare address nor an empty reply tells a
## stall from a slow track, so only the wait running out does, or the question
## handed back.
MUSIC_WAIT = 720.0
## Nothing generates three minutes of music faster than this.
FASTEST = 45.0
POLL_MS = 2000
QUIET_SECONDS = 25.0
UPLOAD_WAIT_MS = 90000
LOCK_WAIT = 900.0

AUDIO_HEADS = (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"RIFF", b"OggS", b"fLaC")

## The music tool and its controls, by their words (the owner's account is
## Spanish). Choosing the tool puts Duración, Con voces and Género under the
## composer; a track is asked Estándar and Instrumental, its genre left to the
## prompt.
MUSIC_TOOL = ("Crear música", "Create music")
TOOL_CHOSEN = ("Anular la selección de Música", "Deselect Music")
DURATION_WORDS = ("Duración", "Duration", "Corta", "Estándar", "Short", "Standard")
VOICES_WORDS = ("Con voces", "With vocals", "Instrumental", "Personalizada", "Custom")
DURATION = ("Estándar", "Standard")
VOICES = ("Instrumental",)


def is_audio(blob: bytes) -> bool:
    return blob[4:8] == b"ftyp" or blob.startswith(AUDIO_HEADS)


def title_of(src: str) -> str:
    """The track's file name in its download link, without the extension."""
    query = urllib.parse.urlparse(src).query
    name = urllib.parse.parse_qs(query).get("filename", [""])[0]
    return os.path.splitext(name)[0]


def handed_back(st: dict, url: str, asked_before: int) -> bool:
    """Whether the page has given the question back: still the fresh chat's
    address, no new question on the page, no reply, and the composer holding
    words again. It reads no stop button (a stall once showed one for 543 s)."""
    return (
        not rules.is_conversation(url)
        and st.get("asked", 0) <= asked_before
        and not st.get("replies")
        and st.get("composer", 0) > 0
    )


def stall_of(st: dict, url: str, asked_before: int) -> dict:
    """What a stalled page showed, for its sidecar."""
    return {
        "why": "handed back" if handed_back(st, url, asked_before) else "no conversation",
        "address": url,
        "asked": st.get("asked", 0),
        "replies": st.get("replies", 0),
        "composer": st.get("composer", 0),
        "busy": web.busy(st),
        "stops": [label for label in st.get("labels", []) if label in web.STOP_LABELS],
        "worked": bool(st.get("worked", False)),
    }


def digests_beside(out: str, seen: str = "") -> dict[str, str]:
    """Every track digest already recorded in a sidecar under `seen` (by
    default `out`'s own folder), by the sidecar it is in."""
    folder = os.path.abspath(seen) if seen else os.path.dirname(os.path.abspath(out))
    mine = os.path.abspath(os.path.splitext(out)[0] + ".json")
    found = {}
    for here, _dirs, files in os.walk(folder):
        for name in files:
            path = os.path.join(here, name)
            if not name.endswith(".json") or os.path.abspath(path) == mine:
                continue
            try:
                with open(path, encoding="utf-8") as handle:
                    record = json.load(handle)
            except (OSError, ValueError):
                continue
            if isinstance(record, dict) and record.get("sha256") and record.get("kind") in ("music", "fetch"):
                found[record["sha256"]] = path
    return found


def track_tags(path: str) -> dict:
    """Gemini's own title, album and genre off the MP4's metadata, and its
    length, as ffmpeg reads them."""
    import music_convert

    said = subprocess.run([music_convert.ffmpeg(), "-hide_banner", "-i", path], capture_output=True)
    text = said.stderr.decode(errors="replace")
    tags: dict = {}
    for key in ("title", "album", "genre"):
        found = re.search(r"^\s+%s\s*:\s*(.+)$" % key, text, re.M)
        tags[key] = found.group(1).strip() if found else ""
    length = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", text)
    if length:
        h, m, s = length.groups()
        tags["track_seconds"] = round(int(h) * 3600 + int(m) * 60 + float(s), 2)
    audio = re.search(r"Audio: (\w+).*?(\d+) Hz, (\w+)", text)
    if audio:
        tags["audio"] = "%s %s Hz %s" % audio.groups()
    return tags


# --- the page ----------------------------------------------------------------------------


def choose_music(page) -> dict:
    """Picks the music tool and sets it to a full-length instrumental. Returns
    what the controls read afterwards, for the sidecar."""
    chosen = web.choose_tool(page, MUSIC_TOOL)
    if not chosen:
        raise web.NotSent("the tools menu has no %s item" % MUSIC_TOOL[0])
    if chosen.get("off"):
        raise web.NotSent("%s is greyed out (a Lite mode, or the plan's limit)" % chosen["said"])
    chips = ", ".join("button[aria-label='%s']" % label for label in TOOL_CHOSEN)
    for _wait in range(20):
        page.wait_for_timeout(500)
        if page.locator(chips).count():
            break
    settings = {"tool": chosen["said"]}
    for key, words, wanted in (("duration", DURATION_WORDS, DURATION), ("voices", VOICES_WORDS, VOICES)):
        opened = None
        for _wait in range(20):
            opened = page.evaluate(web.CLICK_TOOL_JS, list(words))
            if opened and not opened.get("off"):
                break
            page.wait_for_timeout(500)
        if not opened or opened.get("off"):
            raise web.NotSent("the music tool shows no %s control" % key)
        page.wait_for_timeout(1500)
        picked = page.evaluate(web.CLICK_OPTION_JS, list(wanted))
        page.wait_for_timeout(800)
        if not picked:
            page.keyboard.press("Escape")
            raise web.NotSent("the %s control offers no %s" % (key, wanted[0]))
        settings[key] = picked
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    return settings


class Unconfirmed(Exception):
    """The composer emptied, but the page never showed the question: it may
    have gone. Counted as an ask spent."""


def _went(page, asked: int, replies: int, modes) -> bool:
    st = web.state(page, modes)
    return st["asked"] > asked or st["replies"] > replies or bool(web.busy(st))


def attach_audio(page, refs: list[str]) -> None:
    """The references uploaded and waited for until the composer shows each
    one's name (an audio file shows no thumbnail)."""
    web.attach_files(page, refs)
    stems = [os.path.splitext(os.path.basename(path))[0] for path in refs]
    waited = 0
    while waited < UPLOAD_WAIT_MS:
        body = re.sub(r"\s+", "", page.inner_text("body"))
        if all(stem[:12] in body for stem in stems):
            break
        page.wait_for_timeout(1000)
        waited += 1000
    page.wait_for_timeout(4000)


def send(page, prompt: str, refs: list[str], modes, music: bool = True, composer: dict | None = None) -> dict:
    """The question in, and proof that it went: the count of questions on the
    page has to rise (or a reply appear, or the page start working). The
    composer is emptied before anything else, the tool chosen, the references
    uploaded, the prompt filled and read back; Enter is pressed again only on
    the exact prompt. No proof and the composer still holding the prompt:
    nothing went (`NotSent`); emptied: it may have gone (`Unconfirmed`)."""
    composer = {} if composer is None else composer
    before = web.state(page, modes)
    asked, replies = before["asked"], before["replies"]
    web.emptied(page, composer)
    settings = choose_music(page) if music else {}
    if refs:
        attach_audio(page, refs)
    web.fill(page, prompt, composer)
    page.keyboard.press("Enter")
    enters = 1
    for _attempt in range(10):
        page.wait_for_timeout(1500)
        if _went(page, asked, replies, modes):
            return settings
        held = web.composer_text(page).strip()
        if not held:
            continue
        if rules.composed(held) != rules.composed(prompt):
            composer["refills"] = composer.get("refills", 0) + 1
            web.fill(page, prompt, composer, enters)
        else:
            page.locator(web.PROMPT_BOX).first.click()
        page.keyboard.press("Enter")
        enters += 1
    if web.composer_text(page).strip():
        raise web.NotSent("the question never left the composer", enters)
    raise Unconfirmed("the composer emptied, but the page never showed the question")


def conversation_url(page, seconds: float = 30.0) -> str:
    waited = 0.0
    while waited < seconds and not rules.is_conversation(page.url):
        page.wait_for_timeout(1000)
        waited += 1.0
    return page.url


def track_bytes(page, src: str) -> bytes:
    """The track behind a src: fetched by the page itself (its own session),
    or read out of the page when it is a blob."""
    if src.startswith("http"):
        return page.request.get(src, timeout=180000).body()
    encoded = page.evaluate(
        """async (url) => {
            const answer = await fetch(url);
            const blob = await answer.blob();
            return await new Promise((done) => {
                const reader = new FileReader();
                reader.onload = () => done(reader.result);
                reader.readAsDataURL(blob);
            });
        }""",
        src,
    )
    return base64.b64decode(str(encoded).split(",", 1)[1])


def wait_for_track(page, before: set[str], wait: float, modes, stall: bool = True, asked_before: int = 0, on_conversation=None):
    """Waits for the answer: ("ok", src, state) the moment a new media source
    is on the page; a reply that stopped working with no track, unchanged for
    `QUIET_SECONDS`, is a refusal by its words (a refusal that is not
    `masked`/`nothing` ends it after twice that even while the page claims to
    work); `stalled` when no conversation was ever made (or the question was
    handed back); `timeout` otherwise. One line a minute for the queue's log."""
    start = time.time()
    quiet_since = time.time()
    last_text = None
    seen_busy = False
    said_at = 0.0
    idle_since = None
    handed_since = None
    talked = rules.is_conversation(page.url)
    worked = False
    st = web.state(page, modes)
    while time.time() - start < wait:
        page.wait_for_timeout(POLL_MS)
        st = web.state(page, modes)
        url = page.url
        worked = worked or bool(st["replies"]) or any(w in st["text"] for w in ("Generando tu pista", "Generating your track"))
        if not talked and rules.is_conversation(url):
            talked = True
            if on_conversation:
                on_conversation(url)
        fresh = [item for item in st["media"] if item["src"] not in before]
        if fresh:
            fresh.sort(key=lambda item: not item["music"])
            page.wait_for_timeout(3000)
            return "ok", fresh[0]["src"], web.state(page, modes)
        why = web.busy(st)
        seen_busy = seen_busy or bool(why)
        elapsed = time.time() - start
        if elapsed - said_at >= 60.0:
            said_at = elapsed
            web.say(
                "  %3.0f s: %s; reply %r%s"
                % (elapsed, why or "quiet", st["text"].strip()[-70:].replace("\n", " "), "" if talked else "; no conversation yet")
            )
        if stall and not talked and handed_back(st, url, asked_before):
            handed_since = handed_since or time.time()
            if time.time() - handed_since >= QUIET_SECONDS:
                return "stalled", "", dict(st, worked=worked)
        else:
            handed_since = None
        if st["text"] != last_text:
            last_text, quiet_since = st["text"], time.time()
            continue
        held = time.time() - quiet_since
        verdict = rules.classify(st["text"])
        if verdict not in ("nothing", "masked") and held >= 2.0 * QUIET_SECONDS:
            return verdict, "", st
        if why or st["replies"] == 0 or elapsed < 15.0:
            idle_since = None
            continue
        idle_since = idle_since or time.time()
        if min(held, time.time() - idle_since) >= QUIET_SECONDS and (seen_busy or st["text"].strip()):
            return verdict, "", st
    if stall and not talked:
        return "stalled", "", dict(st, worked=worked)
    return "timeout", "", st


def save_track(page, src: str, out: str, record: dict, started: float | None, seen: str = "") -> int:
    """Downloads the track, checks it is one and is new, and fills the record."""
    blob = track_bytes(page, src)
    record["src_host"] = urllib.parse.urlparse(src).netloc
    record["gemini_title"] = title_of(src)
    if not is_audio(blob):
        record["outcome"] = "not_audio"
        record["head"] = blob[:16].hex()
        web.say("the download is not audio (%d bytes, %r)" % (len(blob), blob[:15]))
        return rules.NOTHING
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "wb") as handle:
        handle.write(blob)
    record["sha256"] = web.sha256(blob)
    record["bytes"] = len(blob)
    try:
        record.update(track_tags(out))
    except Exception as failed:  # ffmpeg missing: the track is still kept
        record["tags_error"] = str(failed)[:200]
    record["outcome"] = "ok"
    code = rules.OK
    twin = digests_beside(out, seen).get(record["sha256"])
    if twin:
        record["outcome"] = "twice"
        record["twin"] = os.path.relpath(twin)
        web.say("the last answer, served twice: the same bytes as %s" % twin)
        code = rules.STALE
    elif started is not None and time.time() - started < FASTEST:
        record["outcome"] = "fast"
        web.say("ok in %.0f s is an old track, not a new one" % (time.time() - started))
        code = rules.STALE
    web.say(
        'wrote %s (%d KB, %s s of audio, "%s")'
        % (out, len(blob) // 1024, record.get("track_seconds", "?"), record.get("title") or record["gemini_title"])
    )
    return code


# --- commands --------------------------------------------------------------------------------


def do_ask(args) -> int:
    for path in args.ref:
        if not os.path.isfile(path):
            raise SystemExit("no reference at %s" % path)
    prompt_guard.check(args.prompt)
    modes = rules.configured_modes(args.modes)
    name = web.slug(args.name)
    stem = os.path.join(args.out_dir, name)
    out = stem + ".mp4"
    record = {
        "kind": "music",
        "tool": "Gemini web app (owner's account), music_web.py",
        "slot": args.slot or name,
        "prompt": args.prompt,
        "refs": [{"file": os.path.basename(p), "sha256": web.digest_of(p)} for p in args.ref],
        "modes": list(modes),
        "started": web.now_iso(),
        "outcome": "not_sent",
        "seconds": 0.0,
        "url": "",
        "mode": "",
        "reply": "",
    }
    if not browser_lock.take(wait=args.lock_wait):
        return rules.BUSY
    code = rules.NOTHING
    try:
        with web.playwright() as pw:
            browser, page = web.open_tab(pw, args.cdp)
            try:
                if not web.signed_in(page):
                    record["outcome"] = "signed_out"
                    web.say("that browser is signed out: sign in in its window")
                    return rules.SIGNED_OUT
                try:
                    record["mode"] = web.ensure_mode(page, modes)
                except web.ModeWall as wall:
                    # Nothing was sent: a quota with the hour the menu names.
                    record["outcome"] = "quota"
                    record["reset"] = wall.reset
                    web.say("quota: no mode of %s is open (%s)" % (", ".join(modes), wall))
                    return rules.QUOTA
                ahead = web.state(page, modes)
                before = {item["src"] for item in ahead["media"]}
                started = time.time()
                record["composer"] = {}
                try:
                    record["settings"] = send(page, args.prompt, args.ref, modes, not args.no_tool, record["composer"])
                except Unconfirmed as why:
                    record["outcome"] = "unconfirmed"
                    record["url"] = page.url
                    raise SystemExit(str(why)) from why
                except web.NotSent as why:
                    record["composer"]["enters"] = why.enters
                    page.screenshot(path=stem + ".state.png")
                    web.say("not sent: %s" % why)
                    raise
                record["outcome"] = "sent"
                record["sent_at"] = web.now_iso()
                sent = time.time()
                record["url"] = conversation_url(page)
                if rules.is_conversation(record["url"]):
                    record["conversation_at"] = round(time.time() - sent, 1)
                web.write_sidecar(stem, record)

                def talked(url):
                    record["url"] = url
                    record["conversation_at"] = round(time.time() - sent, 1)
                    web.write_sidecar(stem, record)

                outcome, src, st = wait_for_track(
                    page, before, args.wait, modes, asked_before=ahead["asked"], on_conversation=talked
                )
                record["seconds"] = round(time.time() - started, 1)
                if rules.is_conversation(page.url):
                    record["url"] = page.url
                record["reply"] = st["text"][-3000:]
                if outcome == "ok":
                    code = save_track(page, src, out, record, started, args.seen)
                else:
                    record["outcome"] = outcome
                    if outcome in ("quota", "masked"):
                        record["reset"] = rules.reset_of(st["text"])
                    if outcome == "stalled":
                        record["stall"] = stall_of(st, page.url, ahead["asked"])
                    page.screenshot(path=stem + ".state.png")
                    web.say("%s after %.0f s: %s" % (outcome, record["seconds"], st["text"].strip()[-300:] or "(no text)"))
                    if outcome == "timeout":
                        web.say("still at %s: `fetch` it when it lands" % record["url"])
                    code = rules.fail_code(outcome)
            finally:
                web.close_tab(browser, page)
    finally:
        record["finished"] = web.now_iso()
        web.write_sidecar(stem, record)
        browser_lock.drop()
    return code


def do_fetch(args) -> int:
    """The track a conversation already holds, taken without asking again:
    the way back from a `TIMEOUT`, and from a driver killed after it sent."""
    modes = rules.configured_modes(args.modes)
    stem = os.path.join(args.out_dir, web.slug(args.name))
    out = stem + ".mp4"
    if not browser_lock.take(wait=args.lock_wait):
        return rules.BUSY
    record = {"kind": "fetch", "url": args.url, "started": web.now_iso(), "outcome": ""}
    code = rules.NOTHING
    try:
        with web.playwright() as pw:
            browser = pw.chromium.connect_over_cdp(args.cdp)
            page = browser.contexts[0].new_page()
            try:
                page.goto(args.url, wait_until="domcontentloaded", timeout=90000)
                # A conversation that failed may not have been kept: the link
                # then opens an empty chat, and waiting on it only times out.
                for _beat in range(15):
                    page.wait_for_timeout(1000)
                    if web.state(page, modes)["replies"]:
                        break
                if not web.state(page, modes)["replies"]:
                    outcome, src, st = "gone", "", web.state(page, modes)
                else:
                    outcome, src, st = wait_for_track(page, set(), args.wait, modes, stall=False)
                record["reply"] = st["text"][-3000:]
                if outcome == "ok":
                    code = save_track(page, src, out, record, None, args.seen)
                else:
                    record["outcome"] = outcome
                    if outcome in ("quota", "masked"):
                        record["reset"] = rules.reset_of(st["text"])
                    web.say("no track in that conversation (%s)" % outcome)
                    code = rules.fail_code(outcome)
            finally:
                web.close_tab(browser, page)
    finally:
        record["finished"] = web.now_iso()
        path = stem + ".json"
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                earlier = json.load(handle)
            earlier.setdefault("fetched", []).append(record)
            for key in ("outcome", "reset", "reply", "sha256", "bytes", "title", "album", "genre",
                        "track_seconds", "audio", "gemini_title", "src_host"):
                if key in record:
                    earlier[key] = record[key]
            record = earlier
        web.write_sidecar(stem, record)
        browser_lock.drop()
    return code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="what", required=True)
    default_dir = os.path.join(web.BUILD, "music")

    ask = sub.add_parser("ask", help="ask for a track")
    ask.add_argument("prompt")
    ask.add_argument("--name", required=True, help="file name of the track, without extension")
    ask.add_argument("--out-dir", default=default_dir)
    ask.add_argument("--slot", default="")
    ask.add_argument("--ref", action="append", default=[], metavar="AUDIO")
    ask.add_argument("--seen", default="", help="where earlier tracks' sidecars are (default: --out-dir)")
    ask.add_argument("--no-tool", action="store_true", help="send as a plain prompt, without choosing Crear música")
    ask.add_argument("--modes", default="", help="mode patterns, best first (default GEMINI_MODES or Hydrogen,Argon)")
    ask.add_argument("--wait", type=float, default=MUSIC_WAIT)
    ask.add_argument("--lock-wait", type=float, default=LOCK_WAIT)
    ask.add_argument("--cdp", default=web.CDP)
    ask.set_defaults(run=do_ask)

    fetch = sub.add_parser("fetch", help="take the track off a conversation already asked")
    fetch.add_argument("url")
    fetch.add_argument("--name", required=True)
    fetch.add_argument("--out-dir", default=default_dir)
    fetch.add_argument("--seen", default="")
    fetch.add_argument("--modes", default="")
    fetch.add_argument("--wait", type=float, default=120.0)
    fetch.add_argument("--lock-wait", type=float, default=LOCK_WAIT)
    fetch.add_argument("--cdp", default=web.CDP)
    fetch.set_defaults(run=do_fetch)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    sys.stdout.reconfigure(errors="replace", line_buffering=True)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
