"""What every track is asked to sound like, in one place.

The twin of `gemini_web.HOUSE_RULES` for music, ported in spirit from Ants of
Neque's `tools/music_style.py`: whatever made one track right is reused
verbatim for the next. The words live in `music_slots.json` (content as data):
`house`, the style every slot shares; `variation`, the line a second take adds;
and the slots, each its place in the game and its own picture.

    python tools/gemini/music_style.py title        # the prompt one slot is asked with
    python tools/gemini/music_style.py --all        # every slot's, with its length

## Rules a prompt is held to (`prompt`)

- **Our own content only** (`prompt_guard`): no game, composer or work named,
  no "in the style of".
- **No word that turns a brief into a refusal** (`SENSITIVE`). In Ants of
  Neque a palette that spoke of the story's violence ("criaturas mezcladas",
  sins, wounds) was answered "solo soy un modelo de lenguaje" with the music
  tool chosen, and the same prompt without them made a track. Music is mood
  and instruments, never plot.
- **Not longer than `MAX_PROMPT`**: Gemini turns the ask into its own brief, so
  length is not its limit; this only stops a prompt growing by accident.
"""

from __future__ import annotations

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prompt_guard  # noqa: E402

SLOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "music_slots.json")
MAX_PROMPT = 1600
## Words a music prompt never carries (matched at the start of a word).
SENSITIVE = (
    "blood", "gore", "kill", "murder", "torture", "suicide", "massacre", "corpse",
    "sangre", "matar", "asesin", "tortura", "masacre", "cadaver", "cadáver",
)


def load(path: str = SLOTS) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def slot_of(book: dict, slot_id: str) -> dict:
    for slot in book["slots"] + book.get("versions", []):
        if slot["id"] == slot_id:
            return slot
    raise SystemExit("no slot %r in %s" % (slot_id, SLOTS))


def has_word(text: str, word: str) -> bool:
    """Whether `word` starts a word of `text` ("kill" is not found in "skill")."""
    return re.search(r"(?<![a-záéíóúñü])" + re.escape(word), text.lower()) is not None


def prompt(book: dict, slot: dict, take: int = 1) -> str:
    """The whole ask for one take of a slot: its text, the house style, and the
    variation line from the second take on. Refuses a prompt that names a work,
    carries a word of `SENSITIVE` or runs past `MAX_PROMPT`."""
    parts = [slot["text"].strip(), book["house"].strip()]
    if take > 1:
        parts.append(book.get("variation", "").strip())
    text = "\n\n".join(part for part in parts if part)
    for word in SENSITIVE:
        if has_word(text, word):
            raise ValueError("%s: the prompt carries %r" % (slot["id"], word))
    if len(text) > MAX_PROMPT:
        raise ValueError("%s: the prompt is %d characters (max %d)" % (slot["id"], len(text), MAX_PROMPT))
    found = prompt_guard.problems(text)
    if found:
        raise ValueError("%s: %s" % (slot["id"], "; ".join(found)))
    return text


def main() -> int:
    sys.stdout.reconfigure(errors="replace")
    book = load()
    wanted = sys.argv[1:]
    if not wanted:
        print(__doc__)
        return 2
    slots = book["slots"] + book.get("versions", []) if wanted == ["--all"] else [slot_of(book, name) for name in wanted]
    for slot in slots:
        text = prompt(book, slot)
        print("== %s (%d characters)\n%s\n" % (slot["id"], len(text), text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
