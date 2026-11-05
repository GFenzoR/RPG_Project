// What the worker writes for one approved submission (T4.5), without GitHub or Postgres:
// the patch merged onto the current base with packages/map-format (the same three-way
// merge as `mapcli patch apply`), the checks it repeats on its own, and the texts of the
// commit and the pull request. The patch is untrusted input even though a moderator
// approved it: nothing in it is executed, and only map files of world/ are written.
import {
  PATCH_FORMAT,
  checkPlots,
  isPatchable,
  mergePatchFile,
  parsePatch,
  parsePatchFile,
} from "@rpg/map-format";
import type { FileChange, Plot, Zone } from "@rpg/map-format";

/** Why a submission cannot become a pull request (map_submissions.failure). */
export type FailureCode = "invalid_patch" | "conflict" | "outside_plot" | "no_changes" | "github";

/** The submission as the worker reads it from map_submissions. */
export interface Submission {
  id: number;
  title: string;
  description: string;
  author: string;
  sha256: string;
  baseRef: string;
  patch: string;
  /** When a moderator approved it (the date of the credit). */
  reviewedAt: Date;
}

export const CONTRIBUTORS = "world/CONTRIBUTORS.md";

/** The branch of a submission: one per submission, so a retry finds it. */
export const branchOf = (id: number): string => `map-submission/${String(id)}`;

/** Files to write: path → new text, or null to delete. */
export type Writes = Map<string, string | null>;

export type BuildResult =
  { ok: true; writes: Writes; islands: string[] } | { ok: false; code: FailureCode };

/** Reads a file of the base commit (null: it does not exist). */
export type ReadBase = (path: string) => Promise<string | null>;

const ISLAND = /^world\/islands\/([a-z][a-z0-9_]*)\//;

/**
 * The only paths a commit may touch: map files of world/ (the list of parsePatch) and the
 * credits file. Checked again here, whatever the server and parsePatch said.
 */
export function writablePath(path: string): boolean {
  if (path === CONTRIBUTORS) return true;
  return path.startsWith("world/") && !path.split("/").includes("..") && isPatchable(path);
}

/** Community plots of some islands of the base (never from the change). */
async function plotsOf(islands: readonly string[], read: ReadBase): Promise<Plot[] | undefined> {
  const out: Plot[] = [];
  for (const island of islands) {
    const path = `world/islands/${island}/zones.yaml`;
    const text = await read(path);
    if (text === null) continue;
    let zones: Zone[];
    try {
      zones = parsePatchFile(path, text) as Zone[];
    } catch {
      return undefined;
    }
    for (const z of zones)
      if (z.type === "community_plot")
        out.push({
          island,
          id: z.id,
          floors: [...z.floors],
          rects: z.rects.map((r) => ({ ...r })),
        });
  }
  return out;
}

/**
 * Merges a submission's patch onto the base. Fails with a fixed code: invalid_patch (does
 * not parse, format 1, or touches anything but map files), conflict (the base changed
 * under it), outside_plot (a change outside the community plots, which the portal is
 * for), no_changes (the base already has it).
 */
export async function buildChange(s: Submission, read: ReadBase): Promise<BuildResult> {
  let patch;
  try {
    patch = parsePatch(s.patch);
  } catch {
    return { ok: false, code: "invalid_patch" };
  }
  if (patch.format !== PATCH_FORMAT) return { ok: false, code: "invalid_patch" };
  if (patch.files.some((f) => !writablePath(f.path) || f.path === CONTRIBUTORS))
    return { ok: false, code: "invalid_patch" };

  const writes: Writes = new Map();
  const changes: FileChange[] = [];
  for (const f of patch.files) {
    const ours = await read(f.path);
    const base = f.base === null ? null : (f.base_text ?? undefined);
    const m = mergePatchFile(f.path, base, ours, f.content);
    if (m.conflicts.length > 0) return { ok: false, code: "conflict" };
    if (m.text === ours) continue;
    writes.set(f.path, m.text);
    changes.push({ path: f.path, before: ours, after: m.text });
  }
  if (writes.size === 0) return { ok: false, code: "no_changes" };

  const islands = [
    ...new Set(changes.map((c) => ISLAND.exec(c.path)?.[1]).filter((i) => i !== undefined)),
  ].sort();
  const plots = await plotsOf(islands, read);
  if (plots === undefined) return { ok: false, code: "conflict" };
  if (checkPlots(plots, changes).length > 0) return { ok: false, code: "outside_plot" };

  const credits = await read(CONTRIBUTORS);
  if (credits !== null) writes.set(CONTRIBUTORS, withCredit(credits, s, islands));
  return { ok: true, writes, islands };
}

/** Letters, spaces and the punctuation a character name may have; anything else goes. */
const safeName = (name: string): string => name.replace(/[^\p{L}\p{M} '-]/gu, "").trim() || "?";

/** The credits row of a submission: author, islands, the submission, the approval date. */
export function creditRow(s: Submission, islands: readonly string[]): string {
  const date = s.reviewedAt.toISOString().slice(0, 10);
  return `| ${safeName(s.author)} | ${islands.join(", ")} | envío #${String(s.id)} | ${date} |`;
}

/** The credits file with the submission's row appended (once). */
export function withCredit(text: string, s: Submission, islands: readonly string[]): string {
  if (text.includes(`| envío #${String(s.id)} |`)) return text;
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `${body}${creditRow(s, islands)}\n`;
}

/** One line, without control characters, at most n characters. */
function oneLine(s: string, n: number): string {
  const t = s
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Title of the commit and of the pull request. */
export function prTitle(s: Submission): string {
  return `map: ${oneLine(s.title, 60)} (envío #${String(s.id)})`;
}

export function commitMessage(s: Submission): string {
  return `${prTitle(s)}\n\nMap-Submission: ${String(s.id)}\nSha256: ${s.sha256}\n`;
}

/**
 * The author's description as a code block, so it never renders as Markdown or HTML and
 * its @mentions or #references notify nobody: a fence longer than any run of backticks in
 * it.
 */
export function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text.replace(/\r\n?/g, "\n")}\n${fence}`;
}

/** The map files a submission's patch touches and their islands (empty if it does not parse). */
export function patchFiles(s: Submission): { files: string[]; islands: string[] } {
  try {
    const files = parsePatch(s.patch)
      .files.map((f) => f.path)
      .filter(writablePath)
      .sort();
    const islands = [
      ...new Set(files.map((p) => ISLAND.exec(p)?.[1]).filter((i) => i !== undefined)),
    ].sort();
    return { files, islands };
  } catch {
    return { files: [], islands: [] };
  }
}

/** Body of the pull request: who, what and how to check it. Nothing private. */
export function prBody(s: Submission): string {
  const { files, islands } = patchFiles(s);
  const lines = [
    `<!-- rpg-map-submission: ${String(s.id)} -->`,
    `Envío #${String(s.id)} del portal de mapas, aprobado por un moderador (docs/04, "Portal de envío de mapas").`,
    "",
    `- **Autor:** ${safeName(s.author)} (nombre de su personaje)`,
    "- **Licencia:** CC BY 4.0 (`cc-by-4.0`), aceptada al enviar",
    `- **Islas:** ${islands.join(", ") || "—"}`,
    `- **Patch:** sha256 \`${s.sha256}\`, hecho sobre \`${oneLine(s.baseRef, 64).replace(/`/g, "")}\``,
    "",
    "Archivos:",
    ...files.map((p) => `- \`${p}\``),
    "",
    "El patch se mezcló sobre la rama base actual con el merge de `packages/map-format`. El check `map-pr` revisa parcelas, validador y conflictos como en cualquier PR de mapas.",
    `El crédito ya está en \`${CONTRIBUTORS}\` (\`envío #${String(s.id)}\`).`,
  ];
  if (s.description.trim() !== "")
    lines.push(
      "",
      "Descripción del autor (texto tal cual lo escribió):",
      "",
      fenced(s.description),
    );
  return `${lines.join("\n")}\n`;
}
