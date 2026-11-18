"""The owner's rule for every prompt sent to Gemini: describe our own content.

Art and music made with the owner's Gemini are allowed since 2026-11-17, on one
condition (docs/17 SRC-1, `assets/CREDITS.md`): **a prompt never names another
game, artist or work**, and never asks to imitate one. It says what the thing
is (a harbour town at dusk, a wolf trotting south), not what it should sound or
look like.

`problems(prompt)` lists what breaks the rule; the drivers refuse to send a
prompt that has any, before they touch the browser. The list of names cannot be
complete, so the phrasings that ask for an imitation ("in the style of",
"al estilo de", "inspired by"...) are refused whatever follows them. A false
positive costs a rewording; a prompt that names a work costs the asset.
"""

from __future__ import annotations

import re
import unicodedata

## Phrasings that ask for an imitation, in both languages the prompts are
## written in. Matched on the folded text (lower case, no accents).
IMITATION = (
    r"\bin the style of\b",
    r"\bin the vein of\b",
    r"\bstyle of [A-Za-z]",
    r"\binspired by\b",
    r"\breminiscent of\b",
    r"\bsounds? like\b",
    r"\blooks? like (?:the |a )?(?:game|soundtrack|movie|film|series|show|anime)\b",
    r"\bsimilar to\b",
    r"\bfrom the (?:game|soundtrack|movie|film|series|anime)\b",
    r"\bal estilo de\b",
    r"\bcon el estilo de\b",
    r"\bestilo de (?:la |el |los |las )?(?:saga|juego|banda sonora|pelicula|serie)\b",
    r"\ba la manera de\b",
    r"\binspirad[oa]s? en\b",
    r"\bque (?:suene|recuerde|se parezca) a\b",
    r"\bparecid[oa]s? a\b",
    r"\bcomo (?:en|la musica de|el arte de|los sprites de) (?:la |el )?(?:saga|juego|pelicula|serie)\b",
)

## Names of games, studios, composers and artists the project learns from or
## that a prompt might reach for (docs/17 §1 lists the references). Folded,
## matched as whole words.
NAMES = (
    # games and series
    "ultima online", "diablo ii", "diablo 2", "diablo iii", "diablo 3", "diablo iv",
    "diablo 4", "diablo immortal", "zelda", "final fantasy", "dark souls",
    "elden ring", "warcraft", "world of warcraft", "runescape", "old school runescape",
    "pokemon", "minecraft", "terraria", "stardew valley", "hollow knight", "castlevania",
    "skyrim", "elder scrolls", "baldur's gate", "baldurs gate", "path of exile",
    "dungeon crawl", "stone soup", "chrono trigger", "secret of mana", "dragon quest",
    "undertale", "witcher", "league of legends", "dota", "starcraft", "metin2",
    "maplestory", "ragnarok online", "lineage ii", "everquest", "albion online",
    "ants of neque",
    # studios
    "cipsoft", "blizzard", "nintendo", "square enix", "fromsoftware", "bethesda",
    "bioware", "disney", "pixar", "ghibli", "konami", "capcom", "riot games",
    # composers and artists
    "matt uelmen", "nobuo uematsu", "koji kondo", "jeremy soule", "yoko shimomura",
    "akira yamaoka", "hans zimmer", "john williams", "howard shore", "ennio morricone",
    "joe hisaishi", "yasunori mitsuda", "hiroki kikuta", "toby fox", "darren korb",
    "miyazaki", "moebius", "frazetta", "giger", "beksinski", "mignola", "tolkien",
)

## Names that are also ordinary words in Spanish or English ("agua tibia",
## "un diablo de ceniza", "la última nota"): matched only as written, with the
## capital and without accents, in the prompt as it is.
PROPER = ("Tibia", "Diablo", "Ultima", "Lineage", "Sega", "Amano")


def fold(text: str) -> str:
    """Lower case without accents, so "Inspirada en" and "inspirada en" match
    one pattern."""
    plain = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in plain if not unicodedata.combining(ch)).lower()


def problems(prompt: str) -> list[str]:
    """What in `prompt` breaks the owner's rule, one line each; [] when it is
    clean."""
    folded = fold(prompt)
    found = []
    for pattern in IMITATION:
        hit = re.search(pattern, folded)
        if hit:
            found.append("asks for an imitation: %r" % hit.group(0))
    for name in NAMES:
        if re.search(r"(?<![a-z0-9])" + re.escape(name) + r"(?![a-z0-9])", folded):
            found.append("names another work, studio or artist: %r" % name)
    for name in PROPER:
        if re.search(r"(?<![A-Za-z0-9])" + re.escape(name) + r"(?![A-Za-z0-9])", prompt):
            found.append("names another work, studio or artist: %r" % name)
    return found


def check(prompt: str) -> None:
    """Raises SystemExit with the reasons when `prompt` breaks the rule."""
    found = problems(prompt)
    if found:
        raise SystemExit(
            "the prompt breaks the owner's rule (describe our own content, never name another "
            "game, artist or work):\n- " + "\n- ".join(found)
        )
