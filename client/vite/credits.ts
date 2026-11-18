// The /credits page's data (docs/17 A1): the third-party art and fonts the game ships and
// what their licences ask to show the player (author, title, licence and link). Read at
// build time from the same records spritepack checks the licences against:
//
//   assets/CREDITS.md                    the pack table, "Fuentes (OFL 1.1)" and
//                                        "Obras derivadas de terceros"
//   assets/vendor/<pack>/CREDITS.csv     per-file authors, licences and links (LPC)
//
// Only names, licences and links come from here; every sentence of the page is i18n
// (site.credits.*), a pack's name and author too (site.credits.pack.<pack>.*).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  markdownSection,
  markdownTableRows,
  parseCreditsRows,
  plainCell,
  usedLicense,
} from "@rpg/spritepack";
import type { Credits, DerivedCredit, FileCredit, PackCredit } from "../src/content-types.ts";

const CREDITS_MD = join("assets", "CREDITS.md");
const PACK_CREDITS = "CREDITS.csv";
const FONTS_HEADING = "## Fuentes";
const DERIVED_HEADING = "## Obras derivadas de terceros";
/** The pack table ends where "Obra propia" begins. */
const OWN_HEADING = "## Obra propia";

/** Licence names a CREDITS.md cell may give, as CREDITS.md and the CSVs write them. */
const LICENCE_NAME = /\b(CC0 1\.0|OGA-BY 3\.0|CC-BY(?:-SA)? [34]\.0|OFL 1\.1)\b/g;
/** A link in a cell: up to a space, a backquote or a closing parenthesis. */
const URL = /https:\/\/[^\s`)]+/;
/** A sprite id in a derived-works row: `outfits/citizen`, never a frame pattern. */
const SPRITE_ID = /^[a-z0-9_]+\/[a-z0-9_]+$/;

/** The licence names of a cell, in order, each once (GPL and prose left out). */
export function licenceNames(cell: string): string[] {
  return [...new Set([...plainCell(cell).matchAll(LICENCE_NAME)].map((m) => m[1] ?? ""))];
}

const firstUrl = (cell: string): string => URL.exec(cell)?.[0] ?? "";

/**
 * The credits of CREDITS.md and of the per-file CSV of each pack that has one (`perFile`
 * gives its text, or undefined). Pure: loadCredits reads the files.
 */
export function creditsFrom(md: string, perFile: (pack: string) => string | undefined): Credits {
  const own = md.indexOf(OWN_HEADING);
  const packs: PackCredit[] = [];
  const files: FileCredit[] = [];
  for (const cells of markdownTableRows(own < 0 ? md : md.slice(0, own))) {
    // | Pack / archivo | Autor | Licencia | Fuente (URL) | Carpeta | Atribución requerida |
    const pack = /assets\/vendor\/([A-Za-z0-9._-]+)\//.exec(cells[4] ?? "")?.[1];
    if (cells.length < 6 || !pack || /^\.+$/.test(pack)) continue;
    const csv = perFile(pack);
    packs.push({
      pack,
      licences: licenceNames(cells[2] ?? ""),
      url: firstUrl(cells[3] ?? ""),
      perFile: csv !== undefined,
    });
    if (csv !== undefined) files.push(...fileCredits(pack, csv));
  }

  const fonts = markdownTableRows(markdownSection(md, FONTS_HEADING))
    .slice(1)
    .filter((cells) => cells.length >= 4)
    .map((cells) => ({
      // "Cinzel (`Cinzel[wght].ttf`)" names the family before its files.
      family: plainCell(cells[0] ?? "").replace(/\s*\(.*$/, ""),
      copyright: plainCell(cells[1] ?? ""),
      licence: licenceNames(cells[2] ?? "")[0] ?? plainCell(cells[2] ?? ""),
      url: firstUrl(cells[3] ?? ""),
    }));

  const derived: DerivedCredit[] = [];
  for (const cells of markdownTableRows(markdownSection(md, DERIVED_HEADING)).slice(1)) {
    const licence = licenceNames(cells[2] ?? "")[0];
    if (!licence) continue;
    const sprites = [...(cells[0] ?? "").matchAll(/`([^`]+)`/g)]
      .map((m) => m[1] ?? "")
      .filter((s) => SPRITE_ID.test(s));
    let entry = derived.find((d) => d.licence === licence);
    if (!entry) derived.push((entry = { licence, sprites: [] }));
    for (const s of sprites) if (!entry.sprites.includes(s)) entry.sprites.push(s);
  }
  return { packs, files, derived, fonts };
}

/**
 * A pack's per-file rows with an accepted licence, grouped by authors, licence and links;
 * each group names its works by folder ("beards/beard/basic"), in the CSV's order.
 */
export function fileCredits(pack: string, csv: string): FileCredit[] {
  const out: FileCredit[] = [];
  const byKey = new Map<string, FileCredit>();
  for (const row of parseCreditsRows(csv)) {
    const licence = usedLicense(row.licenses);
    if (!licence) continue;
    const slash = row.file.lastIndexOf("/");
    const work = slash < 0 ? row.file : row.file.slice(0, slash);
    const urls = row.urls.filter((u) => /^https?:\/\//.test(u));
    const key = JSON.stringify([row.authors, licence, urls]);
    let group = byKey.get(key);
    if (!group) {
      group = { pack, works: [], authors: row.authors, licence, urls };
      byKey.set(key, group);
      out.push(group);
    }
    if (!group.works.includes(work)) group.works.push(work);
  }
  return out;
}

/** The credits of the repository at `root`; an empty page without CREDITS.md. */
export function loadCredits(root: string): Credits {
  const mdPath = join(root, CREDITS_MD);
  const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
  return creditsFrom(md, (pack) => {
    const csv = join(root, "assets", "vendor", pack, PACK_CREDITS);
    return existsSync(csv) ? readFileSync(csv, "utf8") : undefined;
  });
}
