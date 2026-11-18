// Checks assets/CREDITS.md against the licences of the vendor files (docs/17 SRC): every
// file of a pack with per-file credits (LPC's CREDITS.csv) lists an accepted licence, and
// the "Obras derivadas de terceros" table gives every animation of assets/sprites.yaml that
// is composed from vendor layers the licence those layers carry (one CC-BY-SA layer makes
// the frames CC-BY-SA; layers that all list OGA-BY leave them OGA-BY).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { AnimEntry } from "./anims.ts";
import { listFiles } from "./content.ts";
import { derivedLicense, fileLicenses, parseCreditsCsv, usedLicense } from "./credits.ts";
import { parseManifest } from "./manifest.ts";

const CREDITS_MD = "assets/CREDITS.md";
const MANIFEST = "assets/sprites.yaml";
const VENDOR = "assets/vendor";
/** A pack's per-file credits, next to its LICENSE (the generator's own name for it). */
const PACK_CREDITS = "CREDITS.csv";
const DERIVED_HEADING = "## Obras derivadas de terceros";

/** Rows of the markdown tables of `md` (cells trimmed), skipping header separators. */
function tableRows(md: string): string[][] {
  const rows: string[][] = [];
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

/** The text of `md` from the heading to the next "## " heading. */
function section(md: string, heading: string): string {
  const start = md.indexOf(heading);
  if (start < 0) return "";
  const next = md.indexOf("\n## ", start + heading.length);
  return md.slice(start, next < 0 ? undefined : next);
}

const plain = (cell: string): string => cell.replace(/[*`]/g, "").replace(/\s+/g, " ").trim();

/** Every problem found, as "<where>: <what>" lines; empty when the credits are right. */
export function licenceProblems(root: string): string[] {
  const problems: string[] = [];
  const mdPath = join(root, CREDITS_MD);
  const md = existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";

  // Per-file credits of each pack that has them, and the licence cell of the others' rows.
  const perFile = new Map<string, Map<string, string[]>>();
  const vendorDir = join(root, VENDOR);
  const packs = existsSync(vendorDir)
    ? readdirSync(vendorDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    : [];
  for (const { name: pack } of packs) {
    const csv = join(vendorDir, pack, PACK_CREDITS);
    if (!existsSync(csv)) continue;
    const credits = parseCreditsCsv(readFileSync(csv, "utf8"));
    perFile.set(pack, credits);
    for (const file of listFiles(join(vendorDir, pack), ".png")) {
      const rel = relative(join(vendorDir, pack), file).split(sep).join("/");
      const where = `${VENDOR}/${pack}/${rel}`;
      const listed = fileLicenses(credits, rel);
      if (!listed) problems.push(`${where}: no row in its ${PACK_CREDITS}`);
      else if (!usedLicense(listed))
        problems.push(`${where}: lists no accepted licence (${listed.join(", ")})`);
    }
  }
  const packRow = (pack: string): string | undefined =>
    tableRows(md).find((cells) => cells.length >= 6 && cells[4]?.includes(`vendor/${pack}/`))?.[2];

  // What each layered animation's frames are, from the files of its layers.
  const manifestPath = join(root, MANIFEST);
  const animations = existsSync(manifestPath)
    ? parseManifest(readFileSync(manifestPath, "utf8")).manifest.animations
    : new Map<string, AnimEntry>();
  const expected = new Map<string, string>();
  for (const [sprite, entry] of animations) {
    if (entry.layers.length === 0) continue;
    const used: string[] = [];
    for (const layer of entry.layers) {
      for (const spec of entry.actions.values()) {
        const file = layer.file.split("<sheet>").join(spec.sheet);
        const credits = perFile.get(layer.pack);
        const licence = credits
          ? usedLicense(fileLicenses(credits, file.slice(`vendor/${layer.pack}/`.length)) ?? [])
          : usedLicense([plain(packRow(layer.pack) ?? "")]);
        if (licence) used.push(licence);
        else problems.push(`${sprite}: layer ${file} has no accepted licence in the credits`);
      }
    }
    const licence = derivedLicense(used);
    if (licence) expected.set(sprite, licence);
  }

  // What CREDITS.md says: each row names its sprites in backquotes.
  const documented = new Map<string, string>();
  for (const cells of tableRows(section(md, DERIVED_HEADING)).slice(1)) {
    const licence = plain(cells[2] ?? "");
    for (const m of (cells[0] ?? "").matchAll(/`([^`]+)`/g)) {
      const sprite = m[1] ?? "";
      if (!animations.has(sprite)) continue;
      const before = documented.get(sprite);
      if (before !== undefined && before !== licence)
        problems.push(`${CREDITS_MD}: ${sprite} is listed as ${before} and as ${licence}`);
      documented.set(sprite, licence);
    }
  }

  for (const [sprite, licence] of expected) {
    const doc = documented.get(sprite);
    if (doc === undefined)
      problems.push(
        `${sprite}: its frames come from vendor layers (${licence}); name it in "${DERIVED_HEADING.slice(3)}" of ${CREDITS_MD}`,
      );
    else if (doc !== licence)
      problems.push(`${sprite}: ${CREDITS_MD} says ${doc}, its layers make it ${licence}`);
  }
  for (const sprite of documented.keys())
    if (!expected.has(sprite))
      problems.push(`${CREDITS_MD}: ${sprite} is listed as derived but has no vendor layers`);
  return problems;
}
