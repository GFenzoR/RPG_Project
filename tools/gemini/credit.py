"""Records an asset made with the owner's Gemini: its prompt file and its CREDITS.md row.

Art and music generated with the owner's Gemini are allowed since 2026-11-17
(docs/17 SRC-1). Each one that ships is recorded in `assets/CREDITS.md`
("Generado con IA") with the tool, the date and **a committed prompt file**:
the exact words it was asked with, so anyone can see it describes our own
content (`prompt_guard`) and ask again.

    python tools/gemini/credit.py <sidecar.json> --asset assets/sounds/music/title.ogg
                                  [--asset ...] [--prompt-file assets/prompts/...txt] [--note "..."]

`<sidecar.json>` is what the ask or a later step left: `music_web`'s or
`gemini_web`'s sidecar, or `music_convert`'s / `import_art`'s record, whose
`delivery` carries the prompt. The prompt file goes to
`assets/prompts/<the first asset's path under assets/, without extension>.txt`
unless `--prompt-file` names one (one file for the frames of one sheet, say
`assets/prompts/sprites/creatures/wolf.txt`). The row is printed, to paste
into the table: the tool does not edit CREDITS.md.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prompt_guard  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROMPTS = "assets/prompts"


def delivery_of(record: dict) -> dict:
    """The ask behind a record: itself when it holds the prompt, else its
    `delivery` (music_convert, import_art)."""
    if record.get("prompt"):
        return record
    inner = record.get("delivery")
    if isinstance(inner, dict) and inner.get("prompt"):
        return inner
    raise SystemExit("no prompt in that record: pass the sidecar of the ask, or a record whose delivery has one")


def prompt_path(asset: str) -> str:
    """`assets/prompts/<asset under assets/, no extension>.txt`, with forward slashes."""
    rel = asset.replace("\\", "/")
    if rel.startswith("./"):
        rel = rel[2:]
    if not rel.startswith("assets/"):
        raise SystemExit("%s is not under assets/" % asset)
    return "%s/%s.txt" % (PROMPTS, os.path.splitext(rel[len("assets/") :])[0])


def day_of(ask: dict) -> str:
    """The day the ask was made, from its sidecar; today when it says none."""
    started = str(ask.get("started", ""))
    return started[:10] if len(started) >= 10 else datetime.date.today().isoformat()


def prompt_text(ask: dict, assets: list[str]) -> str:
    """The prompt file: a short header, then the prompt exactly as sent."""
    lines = [
        "# Prompt enviado a Gemini (app web, cuenta del dueño). No nombra otros juegos, artistas ni obras.",
        "# Assets: %s" % ", ".join(a.replace("\\", "/") for a in assets),
        "# Herramienta: %s" % ask.get("tool", "Gemini web app"),
        "# Fecha: %s" % day_of(ask),
    ]
    if ask.get("mode"):
        lines.append("# Modo: %s" % ask["mode"])
    if ask.get("url"):
        lines.append("# Conversación: %s" % ask["url"])
    return "\n".join(lines) + "\n\n" + ask["prompt"].strip() + "\n"


def credits_row(ask: dict, assets: list[str], prompt_file: str, note: str = "") -> str:
    """The row of CREDITS.md's "Generado con IA" table:
    | Archivos | Herramienta | Fecha | Prompt | Notas |"""
    files = ", ".join("`%s`" % a.replace("\\", "/") for a in assets)
    mode = (" (modo %s)" % ask["mode"]) if ask.get("mode") else ""
    return "| %s | Gemini, app web con la cuenta del dueño%s | %s | `%s` | %s |" % (
        files, mode, day_of(ask), prompt_file, note or "—")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("record")
    parser.add_argument("--asset", action="append", required=True, help="a shipped file, under assets/")
    parser.add_argument("--prompt-file", default="")
    parser.add_argument("--note", default="")
    args = parser.parse_args()
    with open(args.record, encoding="utf-8") as handle:
        ask = delivery_of(json.load(handle))
    prompt_guard.check(ask["prompt"])
    target = (args.prompt_file or prompt_path(args.asset[0])).replace("\\", "/")
    path = os.path.join(ROOT, target)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(prompt_text(ask, args.asset))
    print("wrote %s; paste this row into assets/CREDITS.md, \"Generado con IA\":" % target)
    print(credits_row(ask, args.asset, target, args.note))
    return 0


if __name__ == "__main__":
    sys.exit(main())
