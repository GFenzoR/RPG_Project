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

The references the ask was sent with (`--ref`) go into both, by path and
sha256, and must be files of the repo's `assets/` still as they were sent
(`refs_of`): an asset asked with anything else is not credited. The
conversation's address stays in the sidecar: it is the owner's private chat.
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


def refs_of(ask: dict, root: str = ROOT) -> list[dict]:
    """The references the ask was sent with, each checked to be a file of the
    repo's `assets/` (`prompt_guard`: our own, already credited) and still the
    file that was sent (same sha256). SystemExit otherwise: an asset whose
    reference cannot be shown to be ours is not credited."""
    refs = ask.get("refs") or []
    for ref in refs:
        if not isinstance(ref, dict):
            raise SystemExit("the reference %r was recorded without its path and sha256: it cannot be credited" % (ref,))
        name = str(ref.get("file", ""))
        rel = name.replace("\\", "/")
        if not rel.startswith(prompt_guard.REF_FOLDER + "/") or ".." in rel.split("/"):
            raise SystemExit("the ask was sent with the reference %r, not a file of the repo's assets/: "
                             "it cannot be credited (docs/17 SRC-5)" % name)
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            raise SystemExit("the reference %s is not in the repo: it cannot be credited (docs/17 SRC-5)" % rel)
        if ref.get("sha256") != prompt_guard.digest_of(path):
            raise SystemExit("%s is no longer the file the ask was sent with (sha256 differs): restore it, "
                             "or ask again with the file as it is" % rel)
    return refs


def import_command(record: dict) -> str:
    """The `import_art.py` command that turned the sheet into these frames,
    read back from its `import.json`: with the frame names, anyone can cut the
    same sheet again (`<hoja>` is the sheet the ask returned, `source`)."""
    words = ["python tools/gemini/import_art.py <hoja>"]
    if record.get("cut", "grid") == "grid":
        grid = record.get("grid") or []
        if len(grid) == 2:
            words.append("--grid %dx%d" % tuple(grid))
        if record.get("fit", "union") != "union":
            words.append("--fit %s" % record["fit"])
    else:
        words.append("--cut %s" % record["cut"])
    size = record.get("size") or []
    if len(size) == 2:
        words.append("--size %s" % (size[0] if size[0] == size[1] else "%dx%d" % tuple(size)))
    words.append("--layer %s" % record.get("layer", "creature"))
    if record.get("anchor", "bottom") != "bottom":
        words.append("--anchor %s" % record["anchor"])
    words.append("--margin %d" % record.get("margin", 1))
    if record.get("forced_scale"):
        words.append("--scale %s" % record["forced_scale"])
    words.append("--colors %d" % (record.get("colours") or 0))
    if record.get("shared_colours"):
        words.append("--shared-colours")
    if not record.get("palette"):
        words.append("--no-palette")
    elif not record.get("outlines") and record.get("layer") in ("creature", "character", "object", "wall"):
        words.append("--no-outline")
    if record.get("names"):
        words.append('--names "%s"' % ",".join(record["names"]))
    if record.get("mirrored"):
        words.append('--mirror "%s"' % ",".join(record["mirrored"]))
    return " ".join(words)


def prompt_text(ask: dict, assets: list[str], imported: dict | None = None) -> str:
    """The prompt file: a short header (with every reference sent, by path and
    sha256, and, from an `import_art` record, the sheet's sha256 and the
    command that cut it), then the prompt exactly as sent. **Never the
    conversation's address**: it is the owner's private chat, of no use to
    anyone else in a public repo, and it stays in the sidecar."""
    lines = [
        "# Prompt enviado a Gemini (app web, cuenta del dueño). No nombra otros juegos, artistas ni obras.",
        "# Assets: %s" % ", ".join(a.replace("\\", "/") for a in assets),
        "# Herramienta: %s" % ask.get("tool", "Gemini web app"),
        "# Fecha: %s" % day_of(ask),
    ]
    if ask.get("mode"):
        lines.append("# Modo: %s" % ask["mode"])
    for ref in ask.get("refs") or []:
        lines.append("# Referencia: %s (sha256 %s)" % (ref.get("file", ""), ref.get("sha256", "?")))
    if imported:
        lines.append("# Hoja devuelta: %s (sha256 %s)" % (imported.get("source", "?"), imported.get("source_sha256", "?")))
        lines.append("# Importada con: %s" % import_command(imported))
    return "\n".join(lines) + "\n\n" + ask["prompt"].strip() + "\n"


def credits_row(ask: dict, assets: list[str], prompt_file: str, note: str = "") -> str:
    """The row of CREDITS.md's "Generado con IA" table:
    | Archivos | Herramienta | Fecha | Prompt | Notas |
    The references the ask was sent with lead the notes."""
    files = ", ".join("`%s`" % a.replace("\\", "/") for a in assets)
    mode = (" (modo %s)" % ask["mode"]) if ask.get("mode") else ""
    refs = [str(ref.get("file", "")) for ref in ask.get("refs") or []]
    notes = ["Referencias: %s" % ", ".join("`%s`" % ref for ref in refs)] if refs else []
    notes += [note] if note else []
    return "| %s | Gemini, app web con la cuenta del dueño%s | %s | `%s` | %s |" % (
        files, mode, day_of(ask), prompt_file, ". ".join(notes) or "—")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("record")
    parser.add_argument("--asset", action="append", required=True, help="a shipped file, under assets/")
    parser.add_argument("--prompt-file", default="")
    parser.add_argument("--note", default="")
    args = parser.parse_args()
    with open(args.record, encoding="utf-8") as handle:
        record = json.load(handle)
    ask = delivery_of(record)
    imported = record if record is not ask and "source_sha256" in record else None
    prompt_guard.check(ask["prompt"])
    refs_of(ask)
    target = (args.prompt_file or prompt_path(args.asset[0])).replace("\\", "/")
    path = os.path.join(ROOT, target)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(prompt_text(ask, args.asset, imported))
    print("wrote %s; paste this row into assets/CREDITS.md, \"Generado con IA\":" % target)
    print(credits_row(ask, args.asset, target, args.note))
    return 0


if __name__ == "__main__":
    sys.exit(main())
