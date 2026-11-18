"""Drives the Gemini web app in the owner's own Chrome: the smoke check and the image ask.

Ported from Ants of Neque's `tools/gemini_web.py` (same owner, same account),
with the web UI as it was on 2026-11-17. `music_web.py` asks for music through
the same door.

## It attaches; it never signs in, and it never handles a credential

Google refuses a sign-in in a browser started by automation, and copying
Chrome's cookie store into a profile the automation owns is the shape of
credential theft. So this never signs in, never reads, copies or stores a
cookie in its own code, and never starts or closes the owner's Chrome. The
owner starts it, signs in once in that window, and this **attaches over the
DevTools protocol**:

    chrome.exe --remote-debugging-port=9222 --user-data-dir=%USERPROFILE%/chrome-gemini

A profile of its own because Chrome 136 stopped honouring the debugging port on
the default profile. Every ask opens a tab of its own on a fresh chat and closes
only that tab; the browser is detached, never shut down.

**One thing is not the page's own doing**: an answer at an `http(s)` address is
downloaded with Playwright's request API of the attached context
(`page.request.get`). Playwright takes that context's cookies over the DevTools
protocol and sends them with that one request from its own (Node) side. Nothing
here sees, logs or keeps them, but it is a request made beside the page, not by
it. A `blob:` answer is read inside the page.

    python tools/gemini/gemini_web.py check [--list-modes]
    python tools/gemini/gemini_web.py image "<prompt>" --name wolf_walk [--ref a.png ...]
                                      [--out-dir build/gemini/art] [--plain] [--edit]
                                      [--modes Hydrogen,Argon]

## What changed in the web UI (verified 2026-11-17 by the main session)

- **The modes**: the menu offers "Ayuda todos los días 4 Hydrogen", "Código y
  análisis 4 Argon" and "3.5 Flash-Lite" instead of Pro and Flash. The list
  the drivers prefer is configurable (`--modes`, `GEMINI_MODES`;
  `page_rules.DEFAULT_MODES`), never a Lite.
- **The tools**: "Crear música", "Crear imagen", "Crear video", "Canvas" and
  "Deep Research" in "Cargas y herramientas" are `<gem-menu-item
  role=menuitemcheckbox>`, not buttons (`CLICK_TOOL_JS`).

## What it keeps from Ants of Neque

- **Detect the media, never trust the reply text**: a reply that says it only
  makes text can sit right over the picture or the track.
- **One driver in the browser at a time** (`browser_lock`).
- **The composer is emptied and read back before every ask**: Gemini puts an
  unsent question back in the next fresh chat as a draft, and a prompt spliced
  into it was sent four copies long (2026-10-05). An ask whose composer will
  not hold exactly the prompt ends `NotSent`, Enter never pressed.
- **Quota is read, never hammered**: a stated reset hour goes into the sidecar
  (`reset`), and the queue sleeps to it.
- **A JSON sidecar per output**, written on success and failure alike.
- **What we uploaded is not an answer**: references are recognised by their
  pixels, and anything under `MIN_SIDE` is a thumbnail.

Nothing here writes into `assets/`: outputs land under `build/gemini/` (or
`--out-dir`) and reach the game only through `import_art.py` and a human look.
"""

from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import io
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import browser_lock  # noqa: E402
import page_rules as rules  # noqa: E402
import prompt_guard  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BUILD = os.path.join(ROOT, "build", "gemini")

## Where the browser being driven listens. Nothing here creates it.
CDP = "http://127.0.0.1:9222"
APP = "https://gemini.google.com/app"

## The editor Gemini types into: a contenteditable, filled by inserting text.
PROMPT_BOX = "rich-textarea div[contenteditable='true']"
## Shown only while signed out, which makes its absence the login check.
SIGNED_OUT = "a[href*='ServiceLogin']"
## The composer's mode picker; its text is the mode the composer is in.
MODE_PICKER = "[data-test-id='bard-mode-menu-button']"
## The uploads and tools menu ("Cargas y herramientas"), matched on its label in
## Spanish and English: the owner's account is Spanish.
TOOLS_OPENER = (
    "button[aria-label*='Cargas' i], button[aria-label*='herramientas' i],"
    " button[aria-label*='upload' i], button[aria-label*='tools' i]"
)
IMAGE_TOOL = ("Crear imagen", "Create image")

## How long a drawing is waited for, how often the page is read, and how long
## an answer that has arrived is given to stop changing.
DRAW_TIMEOUT = 420.0
POLL_MS = 1000
SETTLE_MS = 8000
## A reply that stopped working, holds no picture and has not changed for this
## long is a refusal, classified by its words.
QUIET_SECONDS = 20.0
## How long an ask waits for another driver to give the browser back: a music
## ask holds it up to twelve minutes and its fetch two more.
LOCK_WAIT = 1800.0
## How many times the composer is filled before the ask gives up as not sent.
FILL_TRIES = 2

## The narrowest a generated sheet has ever come back. The composer's thumbnail
## of an uploaded reference is about 64 across; a sheet has never been under a
## thousand.
MIN_SIDE = 400
## How alike two pictures may be before one is taken for the other (a canvas
## read re-encodes, so the reference is recognised by its pixels).
LIKENESS = 0.94
THUMB_SIDE = 32
## An edit is meant to look like its reference: only a near copy is not an answer.
EDIT_LIKENESS = 0.995
EDIT_SIDE = 128
IMAGE_SIGNATURES = (b"\x89PNG", b"\xff\xd8\xff", b"RIFF", b"GIF8")

## What every image ask is told unless `--plain`: the rules that make a sheet
## importable by `import_art.py` (the magenta key, the even grid, flat light)
## and the look of docs/17 (3/4 view, light from the top left, ART-6 values).
## **Our own content only**: no game, artist or work is named here or in a
## prompt (`prompt_guard`).
HOUSE_RULES = """
Hard technical requirements, these matter more than the art direction:
- Solid flat magenta background, exactly RGB(255, 0, 255), filling every pixel that is
  not part of a drawing. No gradient, no vignette, no texture, no shadow cast onto it.
- Lay the subjects out in an even grid with equal spacing. Every cell the same size.
  No labels, no captions, no text of any kind anywhere in the image.
- Every subject fully inside its own cell, centred, touching neither its neighbours nor
  the edge of the image. In an animation, the same size and the same ground line in
  every cell.
- Three-quarter top-down view: the camera looks down from the south at about 45
  degrees, so the top and the south face of things show. Light from the top left.
- Pixel art: crisp square pixels, hard edges, no anti-aliasing, no blur, no soft
  airbrush shading. Limited palette, flat shading in three or four tones, and a dark
  outline of the local colour (never pure black).
- Dark fantasy colours: muted and earthy, with one brighter accent at most. Nothing in
  a subject may be magenta, pink, purple or violet: those hues are the background key.
- They are read at 32x32 pixels in game (people at 64x64), so favour a strong
  silhouette and clear separation of parts over fine detail.
"""

## The page, read in one call: every media source (through shadow roots, and
## whether it sits inside <generated-music>), the buttons' labels (for the stop
## button), the last reply's text, how many replies and questions there are,
## the composer's mode, and how many characters the composer holds. `words` are
## the mode patterns, used when the picker cannot be found.
STATE_JS = """({box, words}) => {
    const media = [];
    const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
            const tag = el.tagName.toLowerCase();
            if (tag === 'video' || tag === 'audio' || tag === 'source') {
                const src = el.currentSrc || el.src || '';
                if (src) {
                    let inside = false;
                    for (let up = el; up; up = up.parentNode || up.host) {
                        if (up.tagName && up.tagName.toLowerCase() === 'generated-music') {
                            inside = true;
                            break;
                        }
                    }
                    media.push({src: src, music: inside});
                }
            }
            if (el.shadowRoot) {
                walk(el.shadowRoot);
            }
        }
    };
    walk(document);
    const labels = [];
    for (const b of document.querySelectorAll('button')) {
        const label = (b.getAttribute('aria-label') || b.innerText || '').trim();
        if (label) {
            labels.push(label.slice(0, 80));
        }
    }
    const replies = document.querySelectorAll('model-response');
    const last = replies.length ? replies[replies.length - 1].innerText : '';
    const picker = document.querySelector("[data-test-id='bard-mode-menu-button']");
    let mode = picker ? (picker.innerText || '').trim().replace(/\\s+/g, ' ') : '';
    if (!mode) {
        const patterns = (words || []).map((w) => new RegExp(w, 'i'));
        for (const b of document.querySelectorAll('button')) {
            const said = (b.innerText || '').trim();
            if (said && said.length < 40 && patterns.some((p) => p.test(said))) {
                mode = said;
                break;
            }
        }
    }
    const composer = box ? document.querySelector(box) : null;
    return {
        media: media,
        labels: labels,
        text: last,
        replies: replies.length,
        asked: document.querySelectorAll('user-query').length,
        music_elements: document.querySelectorAll('generated-music').length,
        mode: mode,
        composer: composer ? (composer.innerText || '').trim().length : 0,
    };
}"""

STOP_LABELS = ("Detener respuesta", "Stop response", "Detener", "Stop generating")

## The tools in "Cargas y herramientas" are <gem-menu-item role=menuitemcheckbox>
## since late 2026, the music tool's controls (duration, vocals) still buttons:
## both are searched, short labels only (a chat title in the sidebar reads
## longer). A greyed-out item (a Lite mode greys the media tools) is reported,
## never clicked.
CLICK_TOOL_JS = """(words) => {
    const found = document.querySelectorAll(
        'button, [role=menuitemcheckbox], [role=menuitem], gem-menu-item');
    for (const b of found) {
        const said = (b.innerText || '').trim().replace(/\\s+/g, ' ');
        if (said.length < 40 && words.some((word) => said.includes(word))) {
            const off = Boolean(b.disabled) || b.getAttribute('aria-disabled') === 'true';
            if (!off) {
                b.click();
            }
            return {said: said, off: off};
        }
    }
    return null;
}"""
CLICK_OPTION_JS = """(words) => {
    const options = document.querySelectorAll(
        '[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option]');
    for (const o of options) {
        const said = (o.innerText || '').trim();
        if (words.some((word) => said.startsWith(word))) {
            o.click();
            return said;
        }
    }
    return null;
}"""
MODE_ITEMS_JS = """() => Array.from(document.querySelectorAll(
        '[role=menuitem], [role=menuitemradio], [role=option], gem-menu-item, button'))
    .map((b) => ({
        said: (b.innerText || '').trim().replace(/\\s+/g, ' '),
        off: Boolean(b.disabled) || b.getAttribute('aria-disabled') === 'true',
    }))
    .filter((item) => item.said && item.said.length < 120)"""


# --- small helpers ---------------------------------------------------------------------


def now_iso() -> str:
    return datetime.datetime.now().isoformat(timespec="seconds")


def sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def digest_of(path: str) -> str:
    with open(path, "rb") as handle:
        return sha256(handle.read())


def say(line: str) -> None:
    """Prints a line that may carry the page's words: a console that cannot
    spell one of them gets a '?' and never a `UnicodeEncodeError` (a cp1252
    pipe once stopped an ask at a draft holding an emoji)."""
    encoding = getattr(sys.stdout, "encoding", None) or "ascii"
    print(line.encode(encoding, "replace").decode(encoding), flush=True)


def write_sidecar(stem: str, record: dict) -> str:
    """`<stem>.json`, the record of one ask, beside its output."""
    folder = os.path.dirname(stem)
    if folder:
        os.makedirs(folder, exist_ok=True)
    path = stem + ".json"
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(record, handle, indent=1, ensure_ascii=False)
        handle.write("\n")
    return path


def slug(name: str) -> str:
    """A file name for an output: lower case, letters, digits, `_` and `-`."""
    cleaned = re.sub(r"[^a-z0-9_-]+", "_", name.strip().lower()).strip("_")
    if not cleaned:
        raise SystemExit("--name must hold a letter or a digit")
    return cleaned


# --- the browser ---------------------------------------------------------------------------


def playwright():
    """Playwright, imported only by the commands that drive the browser, so
    the pure parts and their tests need nothing but Pillow."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as missing:
        raise SystemExit(
            "Playwright for Python is missing: pip install -r tools/gemini/requirements.txt"
        ) from missing
    return sync_playwright()


def open_tab(pw, cdp: str):
    """Attached, a tab of our own on a fresh chat, and the browser to detach
    from. **Never a tab the owner has open**: only the one opened here is
    closed (`close_tab`)."""
    try:
        browser = pw.chromium.connect_over_cdp(cdp)
    except Exception as failed:
        raise SystemExit(
            "no Chrome answers on %s: the owner starts it with --remote-debugging-port=9222 "
            "--user-data-dir=%%USERPROFILE%%/chrome-gemini (%s)" % (cdp, str(failed).splitlines()[0])
        ) from failed
    if not browser.contexts:
        raise SystemExit("attached, but that Chrome has no window open")
    page = browser.contexts[0].new_page()
    page.goto(APP, wait_until="domcontentloaded", timeout=90000)
    for ready in (PROMPT_BOX, MODE_PICKER):
        try:
            page.wait_for_selector(ready, timeout=SETTLE_MS * 2)
        except Exception:
            # Not fatal here: `signed_in` is the real gate and says why.
            pass
    return browser, page


def close_tab(browser, page) -> None:
    """The tab we opened, closed; the browser detached, never shut down."""
    try:
        page.close()
    except Exception:
        pass
    try:
        browser.close()
    except Exception:
        pass


def signed_in(page) -> bool:
    return page.locator(SIGNED_OUT).count() == 0 and page.locator(PROMPT_BOX).count() > 0


def state(page, modes: tuple[str, ...] = rules.DEFAULT_MODES) -> dict:
    return page.evaluate(STATE_JS, {"box": PROMPT_BOX, "words": list(modes)})


def busy(st: dict) -> str:
    """Why the page is still working, or "": a stop button is up, or a
    `<generated-music>` holds no player yet, or the reply says it is making
    the track."""
    if any(label in STOP_LABELS for label in st["labels"]):
        return "stop button"
    if st["music_elements"] > len([item for item in st["media"] if item["music"]]):
        return "empty player"
    if any(word in st["text"] for word in ("Generando tu pista", "Generating your track")):
        return "generating"
    return ""


## The open menu's own items (no buttons): what `check --list-modes` prints.
MENU_ITEMS_JS = """() => Array.from(document.querySelectorAll(
        '[role=menuitem], [role=menuitemradio], [role=option], gem-menu-item'))
    .map((b) => ({
        said: (b.innerText || '').trim().replace(/\\s+/g, ' '),
        off: Boolean(b.disabled) || b.getAttribute('aria-disabled') === 'true',
    }))
    .filter((item) => item.said && item.said.length < 120)"""


def mode_menu(page) -> list[dict]:
    """The mode menu's items, read with the menu open and closed again: the
    one read-only look at it. Each item once, in the menu's order."""
    page.locator(MODE_PICKER).first.click()
    page.wait_for_timeout(1500)
    items = page.evaluate(MENU_ITEMS_JS)
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    seen, unique = set(), []
    for item in items:
        if item["said"] not in seen:
            seen.add(item["said"])
            unique.append(item)
    return unique


class ModeWall(Exception):
    """Every mode of the list is spent until an hour (or names none)."""

    def __init__(self, reset: str, said: str):
        super().__init__(said)
        self.reset = reset


def ensure_mode(page, modes: tuple[str, ...]) -> str:
    """Leaves the composer in the best open mode of `modes` (never a Lite), or
    raises `ModeWall` with the hour the menu names. Keeps the mode it is in
    only when that is the first of them: a composer left in the fallback by an
    earlier run goes back to the preferred mode when it is open. Returns the
    mode it asks in. The menu's own items are read (the picker button, which
    says the current mode, is not one of them); buttons only when the menu
    shows none."""
    mode = state(page, modes)["mode"]
    if rules.mode_index(mode, modes) == 0:
        return mode
    page.locator(MODE_PICKER).first.click()
    page.wait_for_timeout(1500)
    items = page.evaluate(MENU_ITEMS_JS) or page.evaluate(MODE_ITEMS_JS)
    verdict, said = rules.pick_mode(items, modes)
    if verdict == "pick":
        choices = page.locator("[role=menuitem], [role=menuitemradio], [role=option], gem-menu-item").all()
        labels = [" ".join((item.inner_text() or "").split()) for item in choices]
        index = rules.menu_index(labels, said)
        if index >= 0:
            choices[index].click()
        page.wait_for_timeout(1500)
        return state(page, modes)["mode"]
    page.keyboard.press("Escape")
    if verdict == "none":
        # A menu that shows none of the modes (empty, or every one renamed) is
        # the page changing, not the quota: nothing was sent.
        raise NotSent("the mode menu shows none of %s (%d items read): has the page changed? "
                      "`gemini_web.py check --list-modes`" % (", ".join(modes), len(items or [])))
    walled = [item["said"] for item in items if any(re.search(w, item["said"], re.I) for w in rules.LIMIT_WORDS)]
    raise ModeWall(said, "; ".join(walled) or "every mode of %s is greyed out" % (modes,))


def choose_tool(page, words: tuple[str, ...]) -> dict | None:
    """Opens "Cargas y herramientas" and picks the tool whose label holds one
    of `words`: {"said", "off"}, or None when the menu has no such tool. The
    button toggles and the tab may arrive with the menu open, so Escape goes
    first and the click is tried three times."""
    opener = page.locator(TOOLS_OPENER).first
    chosen = None
    for attempt in range(3):
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        opener.click()
        page.wait_for_timeout(1500 * (attempt + 1))
        chosen = page.evaluate(CLICK_TOOL_JS, list(words))
        if chosen:
            break
    page.wait_for_timeout(800)
    return chosen


# --- the composer ---------------------------------------------------------------------------


class NotSent(SystemExit):
    """The composer would not hold exactly the prompt, so Enter was not pressed
    on what it held. `enters` is how many times Enter had already gone on the
    exact prompt (more than 0 only from `music_web`'s resend loop)."""

    def __init__(self, why: str, enters: int = 0):
        if enters:
            why += "; Enter went %d time(s) before, only on the exact prompt, and it never showed as sent" % enters
        else:
            why += "; nothing was sent and Enter never pressed"
        super().__init__(why)
        self.enters = enters


def composer_text(page) -> str:
    """What the composer holds; "" when it cannot be read, which no prompt equals."""
    try:
        return page.locator(PROMPT_BOX).first.inner_text(timeout=3000) or ""
    except Exception:
        return ""


def clear(page) -> bool:
    """Empties the composer and says whether it reads back empty: select-all
    and Delete on the focused editor first, then Playwright's `fill("")`."""
    if not rules.composed(composer_text(page)):
        return True
    box = page.locator(PROMPT_BOX).first
    for means in ("keys", "fill"):
        try:
            box.click()
            if means == "keys":
                page.keyboard.press("ControlOrMeta+A")
                page.keyboard.press("Delete")
            else:
                box.fill("")
        except Exception:
            pass
        page.wait_for_timeout(300)
        if not rules.composed(composer_text(page)):
            return True
    return False


def fill(page, prompt: str, report: dict, enters: int = 0) -> None:
    """The composer emptied, the prompt inserted, and the composer read back as
    exactly the prompt; once more if not, and `NotSent` if it still is not."""
    want = rules.composed(prompt)
    why = ""
    for _try in range(FILL_TRIES):
        report["fills"] = report.get("fills", 0) + 1
        if not clear(page):
            report["left"] = len(composer_text(page).strip())
            why = "the composer would not empty (%d characters stayed in it)" % report["left"]
            continue
        page.locator(PROMPT_BOX).first.click()
        # Inserted, not typed: the editor submits on Enter, so the prompt goes
        # in as one operation with its line breaks intact.
        page.keyboard.insert_text(prompt)
        page.wait_for_timeout(800)
        read = composer_text(page)
        held = rules.composed(read)
        if held == want:
            return
        report["held"] = len(read.strip())
        why = "the composer read back %d characters (%d folded), not the prompt's %d" % (
            report["held"],
            len(held),
            len(want),
        )
    raise NotSent("%s after %d fills" % (why, FILL_TRIES), enters)


def emptied(page, report: dict) -> None:
    """Writes into `report` what the composer held before anything was put in
    it (`draft`, `restored`, `head`), and empties it, or raises `NotSent`."""
    held = composer_text(page)
    report["draft"] = len(held.strip())
    report["restored"] = bool(rules.composed(held))
    report["head"] = rules.composed(held)[:80]
    cleared = clear(page)
    if report["restored"]:
        say(
            "the composer held a draft Gemini kept (%d characters, %r...): %s"
            % (report["draft"], report["head"][:40], "emptied first" if cleared else "stuck")
        )
    if not cleared:
        report["left"] = len(composer_text(page).strip())
        raise NotSent("the composer would not empty (%d characters stayed in it)" % report["left"])


def attach_files(page, refs: list[str]) -> None:
    """Hangs the references on the request. **There is no file input until the
    uploads menu is opened**, so the menu is opened (Escape first: it toggles),
    the files set on the input it builds, and the composer waited on until it
    shows a thumbnail, the old flat wait kept as the ceiling."""
    opener = page.locator(TOOLS_OPENER).first
    for attempt in range(3):
        if page.locator("input[type='file']").count() > 0:
            break
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)
        opener.click()
        page.wait_for_timeout(2000 * (attempt + 1))
    if page.locator("input[type='file']").count() == 0:
        raise NotSent("could not open the uploads menu")
    page.locator("input[type='file']").first.set_input_files(refs)
    page.keyboard.press("Escape")
    ceiling = 2500.0 * len(refs) + 6000.0
    spent = 0.0
    while spent < ceiling:
        if page.locator("img[src^='blob:'], img[src^='data:']").count() > 0:
            page.wait_for_timeout(1200)
            return
        page.wait_for_timeout(400)
        spent += 400.0


# --- pictures -------------------------------------------------------------------------------


def is_image(blob: bytes) -> bool:
    return blob.startswith(IMAGE_SIGNATURES)


def width_of(blob: bytes) -> int:
    """How wide an encoded image is, or 0 when it will not decode."""
    from PIL import Image

    try:
        return Image.open(io.BytesIO(blob)).width if blob else 0
    except Exception:
        return 0


def thumb_of(blob: bytes, side: int = THUMB_SIDE) -> list[int]:
    """A small grey thumbnail of an encoded image, for comparing pictures."""
    from PIL import Image

    art = Image.open(io.BytesIO(blob)).convert("L").resize((side, side), Image.Resampling.BOX)
    return list(art.tobytes())


def likeness(blob: bytes, thumbs: list[list[int]], side: int) -> float:
    """How alike this picture is to the most alike of `thumbs`, 0..1."""
    if not thumbs:
        return 0.0
    try:
        mine = thumb_of(blob, side)
    except Exception:
        return 0.0
    best = 0.0
    for other in thumbs:
        close = sum(1 for a, b in zip(mine, other) if abs(a - b) <= 12)
        best = max(best, close / float(len(mine)))
    return best


def is_one_of(blob: bytes, thumbs: list[list[int]], edit: bool = False) -> bool:
    """Whether this picture is one we uploaded ourselves (in an edit round,
    only a near copy of it)."""
    if edit:
        return likeness(blob, thumbs, EDIT_SIDE) >= EDIT_LIKENESS
    return likeness(blob, thumbs, THUMB_SIDE) >= LIKENESS


def bytes_of(page, src: str) -> bytes:
    """The image behind a src: an `http(s)` one through Playwright's request
    API of the attached context (which sends that context's cookies from
    Playwright's side; see the module's notes), or, for a `blob:` the request
    API refuses, read off the decoded element through a canvas inside the page
    (same origin, so not tainted)."""
    if src.startswith("http"):
        return page.request.get(src).body()
    encoded = page.evaluate(
        """(url) => {
            const picture = Array.from(document.images).find((img) => img.src === url);
            if (!picture) {
                return "";
            }
            const canvas = document.createElement("canvas");
            canvas.width = picture.naturalWidth;
            canvas.height = picture.naturalHeight;
            canvas.getContext("2d").drawImage(picture, 0, 0);
            return canvas.toDataURL("image/png");
        }""",
        src,
    )
    text = str(encoded)
    if "," not in text:
        return b""
    return base64.b64decode(text.split(",", 1)[1])


def drawn(page, known: set[str]) -> list[str]:
    """Every image on the page that was not there before and is wide enough to
    be an answer. **The size is the test, not the host**: answers have come
    from more than one host, and a picture the browser gave up painting
    (`complete` and 0 wide) is measured by its own bytes."""
    found = []
    for element in page.locator("img").all():
        src = element.get_attribute("src") or ""
        if not src or src in known:
            continue
        try:
            wide, broken = element.evaluate("node => [node.naturalWidth, node.complete && node.naturalWidth === 0]")
            wide = int(wide or 0)
        except Exception:
            wide, broken = 0, False
        if broken:
            wide = width_of(bytes_of(page, src))
        if wide >= MIN_SIDE:
            found.append(src)
    return found


# --- commands --------------------------------------------------------------------------------


def do_check(args) -> int:
    """The read-only smoke: attaches, opens a fresh chat in a tab of its own,
    and says whether the browser is signed in and which mode the composer is
    in (with `--list-modes`, also what the mode menu offers: opened, read and
    closed). Sends nothing, and closes only its own tab."""
    modes = rules.configured_modes(args.modes)
    if not browser_lock.take(wait=args.lock_wait):
        return rules.BUSY
    try:
        with playwright() as pw:
            browser, page = open_tab(pw, args.cdp)
            try:
                ready = signed_in(page)
                st = state(page, modes)
                say(
                    "attached to %s: %s; mode %r%s"
                    % (
                        args.cdp,
                        "signed in" if ready else "SIGNED OUT (sign in in that window)",
                        st["mode"],
                        "" if rules.mode_index(st["mode"], modes) >= 0 else " (not one of %s)" % ", ".join(modes),
                    )
                )
                if ready and args.list_modes:
                    for item in mode_menu(page):
                        mark = " <- %s" % modes[rules.mode_index(item["said"], modes)] if rules.mode_index(item["said"], modes) >= 0 else ""
                        say("  menu: %s%s%s" % (item["said"], " (greyed out)" if item["off"] else "", mark))
                return rules.OK if ready else rules.SIGNED_OUT
            finally:
                close_tab(browser, page)
    finally:
        browser_lock.drop()


def _prompt_of(args) -> str:
    prompt_guard.check(args.prompt)
    return args.prompt if args.plain else args.prompt.strip() + "\n" + HOUSE_RULES


def _wait_for_pictures(page, before: set[str], sent: list[list[int]], edit: bool, modes) -> tuple[str, list[str], dict]:
    """Waits for the drawing: ("ok", sources, state) once new pictures that are
    not our references hold still; a reply that stopped working and has not
    changed for `QUIET_SECONDS` with no picture is a refusal, classified by its
    words; ("timeout", [], state) at `DRAW_TIMEOUT`."""
    start = time.time()
    last_text = None
    quiet_since = time.time()
    st = state(page, modes)
    while time.time() - start < DRAW_TIMEOUT:
        page.wait_for_timeout(POLL_MS)
        fresh = [src for src in drawn(page, before) if not is_one_of(bytes_of(page, src), sent, edit)]
        if fresh:
            # The first thing to appear is a low-resolution stand-in: what says
            # "done" is the set of sources holding still across two reads.
            settled = 0
            while settled < SETTLE_MS:
                page.wait_for_timeout(POLL_MS)
                settled += POLL_MS
                again = [src for src in drawn(page, before) if not is_one_of(bytes_of(page, src), sent, edit)]
                if again == fresh:
                    break
                fresh = again
            return "ok", fresh, state(page, modes)
        st = state(page, modes)
        if st["text"] != last_text:
            last_text, quiet_since = st["text"], time.time()
            continue
        elapsed = time.time() - start
        if busy(st) or not st["replies"] or elapsed < 15.0:
            continue
        if time.time() - quiet_since >= QUIET_SECONDS and st["text"].strip():
            return rules.classify(st["text"]), [], st
    return "timeout", [], st


def do_image(args) -> int:
    """Asks for a picture (a sheet, most often) and saves every new PNG it
    answers with under `--out-dir`, with `<name>.json` beside them."""
    refs = [prompt_guard.ref_record(path) for path in args.ref]
    prompt = _prompt_of(args)
    modes = rules.configured_modes(args.modes)
    name = slug(args.name)
    stem = os.path.join(args.out_dir, name)
    record = {
        "kind": "image",
        "tool": "Gemini web app (owner's account), gemini_web.py",
        "name": name,
        "prompt": prompt,
        "user_prompt": args.prompt,
        "refs": refs,
        "started": now_iso(),
        "outcome": "not_sent",
        "seconds": 0.0,
        "url": "",
        "mode": "",
        "reply": "",
        "files": [],
    }
    if not browser_lock.take(wait=args.lock_wait):
        record["outcome"] = "busy"
        write_sidecar(stem, record)
        return rules.BUSY
    code = rules.NOTHING
    try:
        with playwright() as pw:
            browser, page = open_tab(pw, args.cdp)
            try:
                if not signed_in(page):
                    record["outcome"] = "signed_out"
                    say("that browser is signed out: sign in in its window")
                    return rules.SIGNED_OUT
                try:
                    record["mode"] = ensure_mode(page, modes)
                except ModeWall as wall:
                    record["outcome"] = "quota"
                    record["reset"] = wall.reset
                    say("quota: no mode of %s is open (%s)" % (", ".join(modes), wall))
                    return rules.QUOTA
                before = set(drawn(page, set()))
                side = EDIT_SIDE if args.edit else THUMB_SIDE
                sent = []
                for path in args.ref:
                    with open(path, "rb") as handle:
                        sent.append(thumb_of(handle.read(), side))
                record["composer"] = {}
                try:
                    emptied(page, record["composer"])
                    tool = None if args.no_tool else choose_tool(page, IMAGE_TOOL)
                    if tool and tool.get("off"):
                        raise NotSent("the %s tool is greyed out in mode %r" % (tool["said"], record["mode"]))
                    record["settings"] = {"tool": tool["said"] if tool else ""}
                    page.keyboard.press("Escape")
                    if args.ref:
                        attach_files(page, args.ref)
                    fill(page, prompt, record["composer"])
                except NotSent as why:
                    page.screenshot(path=stem + ".state.png")
                    say("not sent: %s" % why)
                    raise
                started = time.time()
                page.keyboard.press("Enter")
                record["outcome"] = "sent"
                record["sent_at"] = now_iso()
                write_sidecar(stem, record)
                outcome, fresh, st = _wait_for_pictures(page, before, sent, args.edit, modes)
                record["seconds"] = round(time.time() - started, 1)
                record["url"] = page.url if rules.is_conversation(page.url) else record["url"]
                record["reply"] = st["text"][-3000:]
                if outcome != "ok":
                    record["outcome"] = outcome
                    if outcome in ("quota", "masked"):
                        record["reset"] = rules.reset_of(st["text"])
                    page.screenshot(path=stem + ".state.png")
                    say("%s after %.0f s: %s" % (outcome, record["seconds"], st["text"].strip()[-300:] or "(no text)"))
                    return rules.fail_code(outcome)
                os.makedirs(args.out_dir, exist_ok=True)
                kept = 0
                for src in fresh:
                    blob = bytes_of(page, src)
                    if not is_image(blob) or is_one_of(blob, sent, args.edit):
                        # A page is not a picture: a 403 HTML page once arrived
                        # as the answer (Ants of Neque, 2026-09-26).
                        say("skipped a fetch that is not a new image (%d bytes)" % len(blob))
                        continue
                    kept += 1
                    path = stem + ("" if len(fresh) == 1 else "_%d" % kept) + ".png"
                    _save_png(blob, path)
                    record["files"].append(_file_record(path))
                    say("wrote %s" % path)
                if not kept:
                    record["outcome"] = "nothing"
                    page.screenshot(path=stem + ".state.png")
                    say("only our own references came back; the page is in %s.state.png" % stem)
                    return rules.NOTHING
                record["outcome"] = "ok"
                code = rules.OK
            finally:
                close_tab(browser, page)
    finally:
        record["finished"] = now_iso()
        write_sidecar(stem, record)
        browser_lock.drop()
    return code


def _save_png(blob: bytes, path: str) -> None:
    """Writes the answer as PNG whatever it was served as (a JPEG or WebP is
    converted: `import_art.py` reads PNG)."""
    from PIL import Image

    if blob.startswith(b"\x89PNG"):
        with open(path, "wb") as handle:
            handle.write(blob)
        return
    Image.open(io.BytesIO(blob)).save(path, "PNG")


def _file_record(path: str) -> dict:
    from PIL import Image

    with Image.open(path) as im:
        size = im.size
    return {"file": os.path.basename(path), "sha256": digest_of(path), "bytes": os.path.getsize(path), "size": list(size)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="what", required=True)

    check = sub.add_parser("check", help="read-only: is the owner's Chrome reachable, signed in, and in which mode")
    check.add_argument("--list-modes", action="store_true", help="also open the mode menu, read it and close it")
    check.add_argument("--modes", default="", help="mode patterns, best first (default GEMINI_MODES or Hydrogen,Argon)")
    check.add_argument("--lock-wait", type=float, default=60.0)
    check.add_argument("--cdp", default=CDP)
    check.set_defaults(run=do_check)

    image = sub.add_parser("image", help="ask for a picture and save its PNGs")
    image.add_argument("prompt")
    image.add_argument("--name", required=True, help="file name of the output, without extension")
    image.add_argument("--out-dir", default=os.path.join(BUILD, "art"))
    image.add_argument("--ref", action="append", default=[], metavar="PNG")
    image.add_argument("--plain", action="store_true", help="skip the house rules (magenta key, grid, 3/4 view)")
    image.add_argument("--edit", action="store_true", help="the answer is meant to look like the reference")
    image.add_argument("--no-tool", action="store_true", help="send as a plain prompt, without choosing Crear imagen")
    image.add_argument("--modes", default="")
    image.add_argument("--lock-wait", type=float, default=LOCK_WAIT)
    image.add_argument("--cdp", default=CDP)
    image.set_defaults(run=do_image)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    sys.stdout.reconfigure(errors="replace", line_buffering=True)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
