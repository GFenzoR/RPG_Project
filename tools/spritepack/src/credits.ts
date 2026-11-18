// Reads assets/CREDITS.md to know which vendor packs have a registered licence, and a pack's
// per-file credits (LPC's CREDITS.csv) to know which licence each file is used under.

/** Pack folder names registered in the CREDITS.md table as `assets/vendor/<pack>`. */
export function registeredPacks(creditsMd: string): Set<string> {
  const packs = new Set<string>();
  for (const line of creditsMd.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    for (const m of line.matchAll(/assets\/vendor\/([A-Za-z0-9._-]+)/g)) {
      const pack = m[1];
      // The empty template row reads `assets/vendor/...`.
      if (pack && !/^\.+$/.test(pack)) packs.add(pack);
    }
  }
  return packs;
}

/** A pack folder must ship its licence text next to the sprites. */
export function isLicenseFile(name: string): boolean {
  return /^(licen[cs]e|copying)/i.test(name);
}

/**
 * The art licences assets/CREDITS.md accepts, most permissive first. A file that lists
 * several is used under the first of these it lists (OGA-BY before CC-BY: it has no clause
 * against DRM), and a work derived from several files carries the last one any of them is
 * used under (one CC-BY-SA layer makes the whole frame CC-BY-SA).
 */
const ART_LICENSES = [
  /^CC0(?: 1\.0)?$/,
  /^OGA-BY 3\.0$/,
  /^CC-BY [34]\.0$/,
  /^CC-BY-SA [34]\.0$/,
] as const;

const rank = (licence: string): number => ART_LICENSES.findIndex((re) => re.test(licence));

/** The licence a file is used under, from the ones it lists; undefined: none is accepted. */
export function usedLicense(licences: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const l of licences) {
    const r = rank(l);
    if (r >= 0 && (best === undefined || r < rank(best))) best = l;
  }
  return best;
}

/** The licence of a work derived from files used under `licences` (undefined: none given). */
export function derivedLicense(licences: readonly string[]): string | undefined {
  let worst: string | undefined;
  for (const l of licences) if (worst === undefined || rank(l) > rank(worst)) worst = l;
  return worst;
}

/** One row of a per-file credits CSV, its lists split on commas and trimmed. */
export interface FileCreditRow {
  /** The file's path as the CSV names it ("hair/long/adult/walk.png"). */
  file: string;
  authors: string[];
  licenses: string[];
  urls: string[];
}

/**
 * The rows of a per-file credits CSV (the Universal LPC Spritesheet Character Generator's
 * CREDITS.csv: filename,notes,authors,licenses,urls), in file order. Rows without a file
 * name are skipped; a missing column reads as an empty list.
 */
export function parseCreditsRows(text: string): FileCreditRow[] {
  const rows = parseCsv(text);
  const head = rows[0]?.map((c) => c.trim()) ?? [];
  const col = (name: string): number => head.indexOf(name);
  const file = col("filename");
  if (file < 0) return [];
  const list = (row: string[], i: number): string[] =>
    i < 0
      ? []
      : (row[i] ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x !== "");
  const out: FileCreditRow[] = [];
  for (const row of rows.slice(1)) {
    const name = row[file]?.trim();
    if (!name) continue;
    out.push({
      file: name,
      authors: list(row, col("authors")),
      licenses: list(row, col("licenses")),
      urls: list(row, col("urls")),
    });
  }
  return out;
}

/**
 * The rows of a per-file credits CSV: file -> the licences it lists. Empty when the CSV has
 * no `licenses` column.
 */
export function parseCreditsCsv(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!(parseCsv(text)[0] ?? []).some((c) => c.trim() === "licenses")) return out;
  for (const row of parseCreditsRows(text)) out.set(row.file, row.licenses);
  return out;
}

/** Rows of the markdown tables of `md` (cells trimmed), skipping header separators. */
export function markdownTableRows(md: string): string[][] {
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

/** The text of `md` from the heading to the next "## " heading ("" without the heading). */
export function markdownSection(md: string, heading: string): string {
  const start = md.indexOf(heading);
  if (start < 0) return "";
  const next = md.indexOf("\n## ", start + heading.length);
  return md.slice(start, next < 0 ? undefined : next);
}

/** A table cell as plain text: no emphasis or code marks, single spaces. */
export const plainCell = (cell: string): string =>
  cell.replace(/[*`]/g, "").replace(/\s+/g, " ").trim();

/**
 * The licences a per-file credits table lists for a file of its pack, given by its path
 * inside the pack folder: the row is that path or a tail of it ("spritesheets/a/b.png" matches
 * a row "a/b.png", as LPC names files from its spritesheets/ folder). Undefined: no row.
 */
export function fileLicenses(
  credits: ReadonlyMap<string, string[]>,
  pathInPack: string,
): string[] | undefined {
  const exact = credits.get(pathInPack);
  if (exact) return exact;
  for (let i = pathInPack.indexOf("/"); i >= 0; i = pathInPack.indexOf("/", i + 1)) {
    const row = credits.get(pathInPack.slice(i + 1));
    if (row) return row;
  }
  return undefined;
}

/** RFC 4180 fields: quotes, doubled quotes, commas and newlines inside quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}
