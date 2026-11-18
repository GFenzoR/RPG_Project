"""What the Gemini web app's words mean, without a browser.

Everything here is pure (text in, verdict out), so `make test-gemini` checks it
without Playwright or Chrome. The drivers (`gemini_web.py`, `music_web.py`)
read the page and ask these functions what it said.

The lessons come from Ants of Neque's drivers (same owner, same account), where
they cost real asks; the dates name the day each one was learned.
"""

from __future__ import annotations

import datetime
import os
import re

## Exit codes every driver here means. Anything else (Python's 1) is the
## driver failing, never a refusal.
OK = 0
QUOTA = 2
POLICY = 3
ERROR = 4
NOTHING = 5
STALE = 6
BUSY = 7
TIMEOUT = 8
SIGNED_OUT = 9
## The ask went, and no conversation was ever made of it: nothing to fetch.
STALLED = 10
CODES = (OK, QUOTA, POLICY, ERROR, NOTHING, STALE, BUSY, TIMEOUT, SIGNED_OUT, STALLED)

## **The composer's modes, by preference** (verified 2026-11-17 in the owner's
## account): the mode menu offers "Ayuda todos los días 4 Hydrogen", "Código y
## análisis 4 Argon" and "3.5 Flash-Lite". Music works in Hydrogen, and Argon
## is the fallback when Hydrogen's own cap answers as a text model (Ants of
## Neque saw the same with Pro and Flash on 2026-10-06: a mode can have a music
## cap the usage page does not show). Each entry is a regular expression read
## against the menu's labels; `GEMINI_MODES` or `--modes` replaces the list
## when Gemini renames its models again. A Lite mode is never one of them: its
## music, image and video tools are greyed out.
DEFAULT_MODES = ("Hydrogen", "Argon")
LIMIT_WORDS = (r"l[ií]mite se restablece", r"limit resets")


def modes_from(text: str | None) -> tuple[str, ...]:
    """The mode list a `--modes` value (or `GEMINI_MODES`) names, comma
    separated, best first; the defaults when it names none."""
    found = tuple(part.strip() for part in (text or "").split(",") if part.strip())
    return found or DEFAULT_MODES


def configured_modes(flag: str | None = None) -> tuple[str, ...]:
    """`--modes` when given, else `GEMINI_MODES`, else `DEFAULT_MODES`."""
    return modes_from(flag or os.environ.get("GEMINI_MODES", ""))


def is_lite(mode: str | None) -> bool:
    return bool(re.search(r"Lite", mode or "", re.I))


def matches_mode(label: str | None, pattern: str) -> bool:
    """Whether a menu label (or the picker's) is the mode `pattern` names."""
    return bool(label) and not is_lite(label) and re.search(pattern, label or "", re.I) is not None


def mode_index(label: str | None, modes: tuple[str, ...]) -> int:
    """Which of `modes` a label is, or -1."""
    for index, pattern in enumerate(modes):
        if matches_mode(label, pattern):
            return index
    return -1


def pick_mode(items: list[dict], modes: tuple[str, ...]) -> tuple[str, str]:
    """What the mode menu allows: ("pick", label) for the best open mode of
    `modes`, ("wall", reset) when every such mode is greyed out and one names
    the hour it comes back ("" when none does), or ("none", "") when the menu
    shows none of them. `items` are {"said": label, "off": greyed}."""
    walls = []
    for pattern in modes:
        for item in items:
            if not matches_mode(item.get("said", ""), pattern):
                continue
            if not item.get("off"):
                return "pick", item["said"]
            if any(re.search(word, item["said"], re.I) for word in LIMIT_WORDS):
                walls.append(item["said"])
    if walls:
        return "wall", reset_of(walls[0])
    return "none", ""


def menu_index(labels: list[str], said: str) -> int:
    """Which of the menu's items is the mode `said` names: the item whose
    whole label it is, or else the first that holds its last word and is not
    a Lite, or -1."""
    if said in labels:
        return labels.index(said)
    last = said.split(" ")[-1] if said else ""
    for index, label in enumerate(labels):
        if last and last in label and not is_lite(label):
            return index
    return -1


def next_modes(sidecar: dict, modes: tuple[str, ...]) -> tuple[str, ...] | None:
    """**A masked wall moves the queue to the next mode** (Ants of Neque,
    2026-10-06): when an ask was answered as a text model (`masked`) in one of
    `modes` that is not the last, the asks after it go to the modes after that
    one. None when the wall is the quota as it stands: masked in the last mode,
    or in a mode nobody read."""
    if sidecar.get("outcome") != "masked":
        return None
    index = mode_index(sidecar.get("mode", ""), modes)
    if index < 0 or index >= len(modes) - 1:
        return None
    return modes[index + 1 :]


# --- the replies -----------------------------------------------------------------

## The refusals, read only when no media came. Spanish first: the owner's
## Gemini is es_419. Quota is matched before policy because a quota sentence
## often also says it "cannot" do something.
QUOTA_WORDS = (
    r"l[ií]mite",
    r"\blimit\b",
    r"cuota",
    r"\bquota\b",
    r"restablec",
    r"\bresets?\b",
    r"(?:vuelve|volver) a intentarlo (?:m[aá]s tarde|ma[nñ]ana|en|a las|el)",
    r"try again (?:later|tomorrow|in|at|on)",
    r"has alcanzado",
    r"you'?ve reached",
    r"alcanzaste",
)
ERROR_WORDS = (
    r"problema t[eé]cnico",
    r"no pude generar",
    r"technical (?:problem|issue)",
    r"couldn'?t generate",
    r"encountering an error",
    r"something went wrong",
    r"algo sali[oó] mal",
    r"se produjo un error",
    r"ocurri[oó] un error",
    r"encontr[eé] un error",
)
POLICY_WORDS = (
    # The music tool's own refusal (Ants of Neque, 2026-10-03, a track asked
    # "in the same style as" an attached recording).
    r"nota discordante",
    r"fase beta",
    r"prefiero ser precavido",
    r"no podr[eé] generar",
    r"\bin beta\b",
    r"sour note",
    r"third-party",
    r"terceros",
    r"pol[ií]tica",
    r"\bpolic(?:y|ies)\b",
    r"no puedo (?:crear|generar)",
    r"can'?t (?:create|generate)",
    r"no es posible",
    r"isn'?t something I can",
)
## **The quota does not say it is one** (Ants of Neque, 2026-10-03). After
## about seven tracks in an hour every ask was answered with a sentence about
## being a text model, with no hour and no limit named. With no media, these
## are `masked`: a spent quota (or a mode's own cap) until shown otherwise.
## They never end a wait early: the probe's first track arrived under exactly
## such a sentence. 2026-11-17 added "the audio generation tool isn't
## available" (Neque's Realm's first queue, combat_1 #1).
MASKED_WORDS = (
    r"modelo de lenguaje",
    r"basada en texto",
    r"no tengo esa capacidad",
    r"solo genero texto",
    r"capacidades programadas",
    r"no puedo ayudarte",
    r"no te puedo ayudar",
    r"language model",
    r"text-based",
    r"only generate text",
    r"me han programado",
    r"generaci[oó]n musical no est[aá] disponible",
    r"generation tool isn'?t available",
    r"unable to generate (?:audio|music|images?)",
)


def _matches(text: str, words: tuple[str, ...]) -> bool:
    return any(re.search(word, text, re.I) for word in words)


def classify(text: str) -> str:
    """Why a reply with no media in it is not one: `quota`, `error`, `policy`,
    `masked`, or `nothing` when its words say none of those. **Never asked
    when media came**: the reply text can deny a track that is attached right
    under it (Ants of Neque, 2026-10-03)."""
    if _matches(text, QUOTA_WORDS):
        return "quota"
    if _matches(text, ERROR_WORDS):
        return "error"
    if _matches(text, POLICY_WORDS):
        return "policy"
    if _matches(text, MASKED_WORDS):
        return "masked"
    return "nothing"


def fail_code(outcome: str) -> int:
    """The exit code an outcome with no media ends in."""
    return {
        "quota": QUOTA,
        "masked": QUOTA,
        "policy": POLICY,
        "error": ERROR,
        "nothing": NOTHING,
        "gone": NOTHING,
        "timeout": TIMEOUT,
        "stalled": STALLED,
    }.get(outcome, NOTHING)


def reset_of(text: str, now: datetime.datetime | None = None) -> str:
    """When a quota sentence says the quota comes back, as a local ISO time, or
    "" when it states no hour. Reads "a las 14:30", "at 2:30 PM", "mañana",
    "tomorrow", "en 3 horas" and "in 3 hours"; an hour already past today is
    taken as tomorrow's."""
    now = now or datetime.datetime.now()
    hours = re.search(r"\b(?:en|in)\s+(\d{1,2})\s+(?:horas?|hours?)\b", text, re.I)
    if hours:
        return (now + datetime.timedelta(hours=int(hours.group(1)))).isoformat(timespec="minutes")
    clock = re.search(r"\b(\d{1,2})[:.](\d{2})\s*(a\.?\s*m\.?|p\.?\s*m\.?)?(?![\d])", text, re.I)
    if clock is None:
        return ""
    hour, minute = int(clock.group(1)), int(clock.group(2))
    half = (clock.group(3) or "").replace(".", "").replace(" ", "").lower()
    if half == "pm" and hour < 12:
        hour += 12
    if half == "am" and hour == 12:
        hour = 0
    if hour > 23 or minute > 59:
        return ""
    when = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    day = date_of(text, now)
    if day is not None:
        # The mode menu names the day ("El límite se restablece el 18 nov,
        # 11:53 p.m."): that day, never today by default.
        return when.replace(year=day.year, month=day.month, day=day.day).isoformat(timespec="minutes")
    if re.search(r"ma[nñ]ana|tomorrow", text, re.I) or when <= now:
        when += datetime.timedelta(days=1)
    return when.isoformat(timespec="minutes")


MONTHS = {
    "ene": 1, "jan": 1, "feb": 2, "mar": 3, "abr": 4, "apr": 4, "may": 5, "jun": 6, "jul": 7,
    "ago": 8, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dic": 12, "dec": 12,
}


def date_of(text: str, now: datetime.datetime) -> datetime.date | None:
    """The day a sentence names ("el 18 nov", "18 de noviembre", "Nov 18"), in
    `now`'s year or the next when that day is long past; None when it names
    none."""
    names = "|".join(MONTHS)
    found = re.search(r"\b(\d{1,2})\s+(?:de\s+)?(%s)[a-z]*\.?" % names, text, re.I)
    if found:
        day, month = int(found.group(1)), MONTHS[found.group(2).lower()]
    else:
        found = re.search(r"\b(%s)[a-z]*\.?\s+(\d{1,2})\b" % names, text, re.I)
        if not found:
            return None
        day, month = int(found.group(2)), MONTHS[found.group(1).lower()]
    try:
        when = datetime.date(now.year, month, day)
    except ValueError:
        return None
    if (now.date() - when).days > 180:
        when = when.replace(year=now.year + 1)
    return when


# --- the composer ------------------------------------------------------------------

## What a contenteditable reads back that the prompt never held: zero-width
## marks. **Escapes, never the characters themselves**: written as themselves
## they look like empty strings to a reader and to an editor that drops them.
INVISIBLE = ("​", "‌", "‍", "⁠", "﻿")


def composed(text: str) -> str:
    """Text as the composer comparison sees it: the zero-width marks out, and
    every run of whitespace, line breaks included, one space."""
    for mark in INVISIBLE:
        text = text.replace(mark, "")
    return " ".join(text.split())


## A conversation's own address, as opposed to the app's fresh chat.
CONVERSATION = re.compile(r"/app/[0-9a-f]{6,}")


def is_conversation(url: str | None) -> bool:
    """Whether a URL is a conversation that can be opened again (`fetch`),
    rather than the app's fresh chat."""
    return bool(CONVERSATION.search(url or ""))
