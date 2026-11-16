// Comment of the map PR check (T2.4, docs/04-map-editor-and-ai.md "PR de mapas en CI").
//
// Runs in the `map-pr-comment` workflow (workflow_run), which has `pull-requests: write`
// and `statuses: write` and must never run anything from the pull request. So this file:
//   - is self-contained (Node built-ins only, no workspace packages, no pnpm install), and
//     is checked out from the default branch, never from the PR;
//   - treats report.json (an artifact the PR's own job wrote) as untrusted data: size cap,
//     every field type-checked and every string matched against a strict pattern, and the
//     PR number, head commit and author checked against the GitHub API;
//   - writes one comment per PR, found by a hidden marker and updated on every map-pr run;
//     the comment also records the run that wrote it, and an older run never overwrites it
//     (nor, when the PR is the only open one with its commit from its repo, does any run
//     older than the newest map-pr run of that commit: newerRunOfCommit);
//   - sets the commit status STATUS_CONTEXT on the PR's head commit: pending while map-pr
//     runs, then success or failure (commitStatus). A status belongs to one commit, so a
//     push that never gets a map-pr run has none, and an old pass never covers it. The
//     verdict depends on the base and on the author and head repo (maintainer), the status
//     only on the commit, so only a PR into the default branch sets it, and only while no
//     other open PR into that branch has the same commit from another head repo or author
//     (another PR of the same commit into an old branch, or a copy of a maintainer's PR
//     opened by someone else, must not reach main's merge box), and only from a report
//     computed against that branch's tip now (defaultTip: a run of a PR whose base changed
//     since, or one main moved past, is no verdict for it).
//
//   node --experimental-strip-types tools/mapcli/src/prcomment.ts            (in CI, env below)
//   node --experimental-strip-types tools/mapcli/src/prcomment.ts --pending  (map-pr started)
//   node --experimental-strip-types tools/mapcli/src/prcomment.ts --dry-run REPORT.json
//                                                     prints the Markdown, no network
import { readFileSync, statSync } from "node:fs";

export const MARKER = "<!-- rpg-map-pr-check -->";
/** Second hidden line of the comment: the map-pr run that wrote it (stampRun). */
const RUN_LINE = /^<!-- map-pr-run (\d{1,20}) -->$/;
/** Commit status the comment workflow sets on the PR's head commit (docs/04). */
export const STATUS_CONTEXT = "map-pr/verdict";
/** `name:` of map-pr.yml: the workflow whose runs map-pr-comment follows. */
export const CHECK_WORKFLOW = "map-pr";
/** The file of that workflow, under .github/workflows/: whose runs newerRunOfCommit lists. */
export const CHECK_WORKFLOW_FILE = "map-pr.yml";
/** Pages of 100 runs newerRunOfCommit reads at most (GitHub lists 1000 with head_sha). */
export const MAX_RUN_PAGES = 10;
/**
 * Conclusions of a map-pr run that carry no verdict: it was cancelled (a newer run of the
 * PR follows), or it waits for a maintainer to approve a first-time contributor's run (it
 * runs, and completes again, once approved). The workflow skips them; this is the backstop.
 */
export const NO_VERDICT: readonly string[] = ["cancelled", "action_required"];
export const RENDERS_ARTIFACT = "map-pr-renders";
export const MAX_REPORT_BYTES = 1 << 20;
const MAX_BODY = 60000;
const MAX_ROWS = 40;

export class ReportError extends Error {}

// ---- untrusted report → checked report ---------------------------------------------------

const SHA = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ID = /^[a-z][a-z0-9_]{0,63}$/;
const WORLD_PATH = /^world\/(?:[a-z0-9_-]+\/)*[A-Za-z0-9_.-]{1,100}$/;
/**
 * A path of world/ or of the content the check reads (bad_mode_files, skipped_content), as
 * prcheck's reportPath writes it: any other character is already "?".
 */
const CHECKED_PATH = /^(?:world|data|i18n|assets)\/[A-Za-z0-9_.?/-]{1,200}$/;
const ANY_PATH = /^[A-Za-z0-9_./ +@?-]{1,300}$/; // "?": reportPath's stand-in
const TILE = /^\d{1,5},\d{1,5},\d{1,2}$/;
const PNG = /^(?:before|after)-\d{1,2}\.png$/;
const STATUSES = ["added", "removed", "modified", "unchanged", "conflict"] as const;
export const FAILURES = [
  "plots",
  "conflicts",
  "validation",
  "invalid",
  "rebase",
  "merge_mismatch",
  "limits",
] as const;
/** prcheck.ts NOTE_CODES (this file runs without dependencies, so it has its own copy). */
export const NOTES = [
  "base_content",
  "content_too_large",
  "content_skipped",
  "atlas_fallback",
] as const;
export const CONFLICT_CODES = [
  "tiles",
  "entries",
  "changed_both_sides",
  "no_base",
  "invalid_file",
] as const;

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ReportError(`${what}: not an object`);
  return v as Obj;
}
function arr(v: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new ReportError(`${what}: not a list ≤ ${max}`);
  return v;
}
function int(v: unknown, what: string, max = 1e7): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max)
    throw new ReportError(`${what}: not an integer`);
  return v;
}
function str(v: unknown, what: string, re: RegExp): string {
  if (typeof v !== "string" || !re.test(v) || v.includes(".."))
    throw new ReportError(`${what}: unexpected value`);
  return v;
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new ReportError(`${what}: not a boolean`);
  return v;
}
function oneOf<T extends string>(v: unknown, what: string, values: readonly T[]): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v))
    throw new ReportError(`${what}: unexpected value`);
  return v as T;
}
const opt = <T>(v: unknown, f: (v: unknown) => T): T | undefined =>
  v === undefined ? undefined : f(v);

export interface CheckedFile {
  path: string;
  status: (typeof STATUSES)[number];
  base_matches: boolean;
  conflicts?: number;
  tiles_changed?: number;
  bbox?: { x: number; y: number; w: number; h: number; z: number };
  added?: string[];
  removed?: string[];
  changed?: string[];
}

export type CheckedViolation =
  | { kind: "tiles"; path: string; tiles: number; at: string[] }
  | { kind: "entry"; path: string; entry: string; change: string; reason: string }
  | { kind: "file"; path: string; reason: string };

export interface CheckedReport {
  pr: number;
  author: string;
  maintainer: boolean;
  base: string;
  head: string;
  ok: boolean;
  failures: (typeof FAILURES)[number][];
  map_changes: boolean;
  files: CheckedFile[];
  conflicts: { path: string; code: (typeof CONFLICT_CODES)[number]; at: string[] }[];
  invalid_files: string[];
  noncanonical_files: string[];
  bad_mode_files: string[];
  skipped_content: string[];
  skipped_content_total: number;
  merge_mismatch: string[];
  plots: { count: number; violations: CheckedViolation[]; violations_total: number };
  validation: { errors: number; new_errors: string[]; new_errors_total: number };
  other_files: string[];
  other_files_total: number;
  areas: {
    island: string;
    x: number;
    y: number;
    w: number;
    h: number;
    z: number;
    tile: number;
    before?: string;
    after?: string;
  }[];
  omitted_areas: number;
  notes: (typeof NOTES)[number][];
}

const ids = (v: unknown, what: string): string[] =>
  arr(v, what, 10000).map((x, i) => str(x, `${what}[${i}]`, ID));

/** Rebuilds the report field by field; throws ReportError on anything unexpected. */
export function checkReport(raw: unknown): CheckedReport {
  const r = obj(raw, "report");
  if (r.format !== 2) throw new ReportError("report: unknown format");
  const files = arr(r.files, "files", 4096).map((x, i): CheckedFile => {
    const f = obj(x, `files[${i}]`);
    const out: CheckedFile = {
      path: str(f.path, `files[${i}].path`, WORLD_PATH),
      status: oneOf(f.status, `files[${i}].status`, STATUSES),
      base_matches: bool(f.base_matches, `files[${i}].base_matches`),
    };
    const conflicts = opt(f.conflicts, (v) => int(v, "conflicts"));
    if (conflicts !== undefined) out.conflicts = conflicts;
    const tiles = opt(f.tiles_changed, (v) => int(v, "tiles_changed"));
    if (tiles !== undefined) out.tiles_changed = tiles;
    if (f.bbox !== undefined) {
      const b = obj(f.bbox, "bbox");
      out.bbox = {
        x: int(b.x, "bbox.x", 1e5),
        y: int(b.y, "bbox.y", 1e5),
        w: int(b.w, "bbox.w", 1e5),
        h: int(b.h, "bbox.h", 1e5),
        z: int(b.z, "bbox.z", 15),
      };
    }
    for (const k of ["added", "removed", "changed"] as const) {
      const v = opt(f[k], (x) => ids(x, `files[${i}].${k}`));
      if (v !== undefined) out[k] = v;
    }
    return out;
  });
  const plots = obj(r.plots, "plots");
  const violations = arr(plots.violations, "violations", 1000).map((x, i): CheckedViolation => {
    const v = obj(x, `violations[${i}]`);
    const path = str(v.path, `violations[${i}].path`, WORLD_PATH);
    if (v.kind === "tiles")
      return {
        kind: "tiles",
        path,
        tiles: int(v.tiles, "tiles"),
        at: arr(v.at, "at", 100).map((t) => str(t, "at", TILE)),
      };
    if (v.kind === "entry")
      return {
        kind: "entry",
        path,
        entry: str(v.entry, "entry", ID),
        change: oneOf(v.change, "change", ["added", "removed", "changed"]),
        reason: oneOf(v.reason, "reason", ["outside_plot", "plot_definition", "cross_island"]),
      };
    if (v.kind === "file")
      return {
        kind: "file",
        path,
        reason: oneOf(v.reason, "reason", ["not_map_file", "invalid", "island_meta"]),
      };
    throw new ReportError(`violations[${i}]: unknown kind`);
  });
  const validation = obj(r.validation, "validation");
  return {
    pr: int(r.pr, "pr", 1e9),
    author: str(r.author, "author", LOGIN),
    maintainer: bool(r.maintainer, "maintainer"),
    base: str(r.base, "base", SHA),
    head: str(r.head, "head", SHA),
    ok: bool(r.ok, "ok"),
    failures: arr(r.failures, "failures", 10).map((f) => oneOf(f, "failures", FAILURES)),
    map_changes: bool(r.map_changes, "map_changes"),
    files,
    conflicts: arr(r.conflicts, "conflicts", 4096).map((x, i) => {
      const c = obj(x, `conflicts[${i}]`);
      return {
        path: str(c.path, "conflicts.path", WORLD_PATH),
        code: oneOf(c.code, "conflicts.code", CONFLICT_CODES),
        at:
          c.at === undefined
            ? []
            : arr(c.at, "at", 100).map((t) => str(t, "at", /^[a-z0-9_,]{1,64}$/)),
      };
    }),
    invalid_files: arr(r.invalid_files, "invalid_files", 100).map((p) =>
      str(p, "invalid_files", WORLD_PATH),
    ),
    noncanonical_files: arr(r.noncanonical_files, "noncanonical_files", 100).map((p) =>
      str(p, "noncanonical_files", WORLD_PATH),
    ),
    bad_mode_files: arr(r.bad_mode_files, "bad_mode_files", 100).map((p) =>
      str(p, "bad_mode_files", CHECKED_PATH),
    ),
    // Absent in reports from before the content was landed path by path.
    skipped_content:
      opt(r.skipped_content, (v) =>
        arr(v, "skipped_content", 100).map((p) => str(p, "skipped_content", CHECKED_PATH)),
      ) ?? [],
    skipped_content_total:
      opt(r.skipped_content_total, (v) => int(v, "skipped_content_total")) ?? 0,
    merge_mismatch: arr(r.merge_mismatch, "merge_mismatch", 100).map((p) =>
      str(p, "merge_mismatch", WORLD_PATH),
    ),
    plots: {
      count: int(plots.count, "plots.count"),
      violations,
      violations_total: int(plots.violations_total, "plots.violations_total"),
    },
    validation: {
      errors: int(validation.errors, "validation.errors"),
      new_errors: arr(validation.new_errors, "new_errors", 100).map((e) => {
        if (typeof e !== "string") throw new ReportError("new_errors: not a string");
        return e;
      }),
      new_errors_total: int(validation.new_errors_total, "validation.new_errors_total"),
    },
    other_files: arr(r.other_files, "other_files", 100).map((p) => str(p, "other_files", ANY_PATH)),
    other_files_total: int(r.other_files_total, "other_files_total"),
    areas: arr(r.areas, "areas", 20).map((x, i) => {
      const a = obj(x, `areas[${i}]`);
      const out: CheckedReport["areas"][number] = {
        island: a.island === "" ? "" : str(a.island, "island", ID),
        x: int(a.x, "x", 1e5),
        y: int(a.y, "y", 1e5),
        w: int(a.w, "w", 256),
        h: int(a.h, "h", 256),
        z: int(a.z, "z", 15),
        tile: Number(oneOf(String(a.tile), "tile", ["4", "8", "16", "32"])),
      };
      const before = opt(a.before, (v) => str(v, "before", PNG));
      const after = opt(a.after, (v) => str(v, "after", PNG));
      if (before !== undefined) out.before = before;
      if (after !== undefined) out.after = after;
      return out;
    }),
    omitted_areas: int(r.omitted_areas, "omitted_areas", 1e6),
    // Absent in reports from before the notes.
    notes: opt(r.notes, (v) => arr(v, "notes", 10).map((n) => oneOf(n, "notes", NOTES))) ?? [],
  };
}

// ---- trusted facts -----------------------------------------------------------------------

/** Paths that change what the check runs or how: listed first, and the verdict is void. */
export const SENSITIVE = [
  ".github/",
  "tools/",
  "packages/",
  "server/",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
] as const;
const isSensitive = (p: string): boolean => SENSITIVE.some((s) => p === s || p.startsWith(s));
/** What a map PR may change without making the check's own verdict suspect. */
const isHarmless = (p: string): boolean => p.startsWith("world/") || p.startsWith("docs/");

/** Facts the comment takes from GitHub and the default branch, never from the report. */
export interface Trusted {
  /** Files of the PR outside world/, sensitive ones first (from the API). */
  otherFiles: string[];
  /** Changed files of the PR (the PR's count when the API list is shorter). */
  filesTotal: number;
  /** The API did not list every file (3000 at most). */
  truncated: boolean;
  /** Files the API did not list (counted in the "… y N más" of the file list). */
  unlisted: number;
  /** Whether the author may change the map outside the plots. */
  maintainer: boolean;
  /** The PR changes code or configuration of the check (anything outside world/ and docs/). */
  checkChanged: boolean;
  /**
   * The commit has a check run named STATUS_CONTEXT: a job of some workflow (a PR can add
   * one, also from a fork) posing as the status. Branch protection matches required
   * checks by name only, so it could satisfy the rule; the comment and the status say so.
   */
  impostor: boolean;
}

/** The API lists at most this many files of a PR. */
export const MAX_API_FILES = 3000;

/**
 * `files` are every path the PR touches, renames counted by both ends (see filePaths).
 * `changedFiles` is the PR's own count (`changed_files`): when the list is shorter, or at
 * the API's cap, unseen files could be anything, so the verdict is not trustworthy (R4).
 */
export function trustedFacts(
  files: readonly string[],
  maintainer: boolean,
  changedFiles = files.length,
  impostor = false,
): Trusted {
  const other = [...new Set(files.filter((p) => !p.startsWith("world/")))];
  other.sort((a, b) => Number(isSensitive(b)) - Number(isSensitive(a)) || (a < b ? -1 : 1));
  const truncated = files.length >= MAX_API_FILES || changedFiles > files.length;
  return {
    otherFiles: other,
    filesTotal: Math.max(files.length, changedFiles),
    truncated,
    unlisted: Math.max(0, changedFiles - files.length),
    maintainer,
    checkChanged: truncated || files.some((p) => !isHarmless(p)),
    impostor,
  };
}

/**
 * Paths of the API's file list: a rename counts by its source too (R1), so moving
 * `.github/workflows/ci.yml` to `docs/` is a change to `.github/`.
 */
export function filePaths(
  list: readonly { filename: string; previous_filename?: string }[],
): string[] {
  return list.flatMap((f) =>
    f.previous_filename !== undefined && f.previous_filename !== f.filename
      ? [f.filename, f.previous_filename]
      : [f.filename],
  );
}

/** GitHub logins of the maintainers: one per line, `#` comments, case-insensitive. */
export function parseMaintainers(text: string): string[] {
  return text
    .split("\n")
    .map((l) => (l.split("#")[0] ?? "").trim().replace(/^@/, "").toLowerCase())
    .filter((l) => /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(l));
}

export interface PullFacts {
  author: string;
  association: string;
  /** "owner/name" of the head repo (null: deleted fork). */
  headRepo: string | null;
  /** "owner/name" of the base repo. */
  repo: string;
}

/**
 * Maintainer: listed in .github/MAINTAINERS of the default branch, or the repo owner; and
 * only if nobody else can push to the PR's branch: it is a branch of the base repo, or
 * the author owns the fork it comes from.
 */
export function isMaintainer(p: PullFacts, maintainers: readonly string[]): boolean {
  const author = p.author.toLowerCase();
  const ownsHead =
    p.headRepo !== null &&
    (p.headRepo === p.repo || p.headRepo.split("/")[0]?.toLowerCase() === author);
  return ownsHead && (p.association === "OWNER" || maintainers.includes(author));
}

// ---- Markdown ------------------------------------------------------------------------------

/** Inline code: the only way untrusted-but-checked strings reach the comment. */
const code = (s: string): string => `\`${s.replace(/[`\r\n]/g, "")}\``;

/** Validator messages are free text: a fenced block, no backticks, no line breaks, capped. */
const plain = (s: string): string =>
  s
    .replace(/[`\r\n]/g, " ")
    .replace(/[^\x20-\x7e¡-ɏ]/g, "?")
    .slice(0, 300);

const VIOLATION_TEXT: Record<string, string> = {
  outside_plot: "fuera de toda parcela",
  plot_definition: "define, mueve o quita una parcela (solo maintainers)",
  cross_island:
    "portal entre islas: se saltaría el barco y su bloqueo de combate (solo maintainers)",
  not_map_file: "archivo de world/ que no es de mapa",
  invalid: "archivo inválido (no pasa su esquema)",
  island_meta: "world.yaml, island.yaml o prefab (solo maintainers)",
};
const CHANGE_TEXT: Record<string, string> = {
  added: "agregada",
  removed: "quitada",
  changed: "cambiada",
};
const FAILURE_TEXT: Record<(typeof FAILURES)[number], string> = {
  plots:
    "toca el mapa fuera de las parcelas `community_plot` (o une dos islas con un portal) y el autor no es maintainer",
  conflicts: "choca con cambios posteriores de la rama base (rebase y vuelve a empujar)",
  validation: "el mapa fusionado tiene errores nuevos del validador",
  invalid:
    "un archivo de mapa del PR no pasa su esquema, no está en formato canónico (corre `mapcli fmt`), un archivo de mapa o de contenido no es un archivo normal, o una ruta de contenido no se pudo escribir como la deja el merge",
  rebase: "git no puede fusionar la rama con la base (rebase y vuelve a empujar)",
  merge_mismatch:
    "git fusionaría el texto de un archivo distinto de como se revisó (paletas de chunk): rebase y vuelve a empujar",
  limits:
    "el contenido que trae el PR (`data/`, `i18n/`, `assets/`) pasa el límite de archivos o de tamaño del check y no se midió",
};
const NOTE_TEXT: Record<(typeof NOTES)[number], string> = {
  base_content:
    "el autor no es maintainer y el PR cambia contenido: el mapa también se validó y se dibujó con el contenido de la base",
  content_too_large:
    "el contenido del PR pasa el límite del check: el después se midió con el contenido de la base",
  content_skipped:
    "algunas rutas de contenido del merge no se pudieron escribir como las deja el merge (ver la lista): el después no es el merge",
  atlas_fallback:
    "los sprites del merge no se pudieron armar: las imágenes del después usan los de la base",
};
const CONFLICT_TEXT: Record<(typeof CONFLICT_CODES)[number], string> = {
  tiles: "casillas cambiadas en los dos lados",
  entries: "entradas cambiadas en los dos lados",
  changed_both_sides: "el archivo cambió en los dos lados",
  no_base: "no hay base para mezclar",
  invalid_file: "archivo inválido",
};
export const REPORT_ERRORS = {
  no_report: "el job no dejó reporte",
  too_large: "el reporte es demasiado grande",
  invalid_report: "el reporte no tiene el formato esperado",
  other_pr: "el reporte es de otro pull request",
  other_commit: "el reporte es de otro commit",
  other_author: "el reporte nombra a otro autor",
  other_base:
    "el reporte se calculó contra otra base, no contra la punta actual de la rama por defecto: hace falta una corrida nueva de `map-pr` (editar el título, cerrar y reabrir el PR o empujar)",
} as const;
export type ReportErrorCode = keyof typeof REPORT_ERRORS;
const IMPOSTOR_TEXT = `🚨 **Otro check de este commit se llama \`${STATUS_CONTEXT}\`** (un job de algún workflow, por ejemplo uno que agrega este PR). La protección de \`main\` busca el check requerido solo por nombre, así que ese job podría pasar por el veredicto: no fusiones sin revisar \`.github/\` a mano.`;

export interface CommentContext {
  runUrl: string;
  /** Link to the renders artifact (zip), when the run uploaded one. */
  artifactUrl?: string;
  /** Conclusion of the check job (success, failure...), as GitHub reports it. */
  conclusion: string;
}

function fileDetail(f: CheckedFile): string {
  const parts: string[] = [];
  if (f.tiles_changed !== undefined) parts.push(`${f.tiles_changed} casillas`);
  if (f.bbox) parts.push(`bbox ${f.bbox.x},${f.bbox.y} ${f.bbox.w}x${f.bbox.h} piso ${f.bbox.z}`);
  const list = (sign: string, xs: string[] | undefined): void => {
    if (xs && xs.length > 0)
      parts.push(
        `${sign}${xs.length} (${xs.slice(0, 5).map(code).join(", ")}${xs.length > 5 ? ", …" : ""})`,
      );
  };
  list("+", f.added);
  list("−", f.removed);
  list("~", f.changed);
  if (!f.base_matches)
    parts.push(`base distinta${f.conflicts ? `, ${f.conflicts} conflictos` : ""}`);
  return parts.join("; ") || "—";
}

const more = (n: number, shown: number): string[] =>
  n > shown ? ["", `… y ${n - shown} más (ver Files changed).`] : [];

/** Failures as the trusted side sees them: "plots" depends on its own maintainer answer. */
export function verdict(r: CheckedReport, t: Trusted): (typeof FAILURES)[number][] {
  const out: (typeof FAILURES)[number][] = r.failures.filter((f) => f !== "plots");
  if (r.plots.violations_total > 0 && !t.maintainer) out.unshift("plots");
  return out;
}

/** The comment body; `report` null means the run left no usable report (`error` says why). */
export function buildComment(
  report: CheckedReport | null,
  ctx: CommentContext,
  t: Trusted,
  error?: ReportErrorCode,
): string {
  const out: string[] = [MARKER, "## Revisión de mapa (CI)", ""];
  if (t.impostor) out.push(IMPOSTOR_TEXT, "");
  const conclusion = ctx.conclusion.replace(/[^a-z_]/g, "");
  if (report === null) {
    out.push(
      `⚠️ El job \`map-pr\` terminó con \`${conclusion}\` y no dejó un reporte utilizable` +
        (error ? ` (${REPORT_ERRORS[error]})` : "") +
        ".",
      "",
      `[Ver la ejecución](${ctx.runUrl})`,
    );
    return out.join("\n");
  }
  const r = report;
  const failures = verdict(r, t);
  if (t.truncated)
    out.push(
      `⚠️ **El veredicto no es confiable: la API de GitHub lista solo una parte de los ${t.filesTotal} archivos del PR.** Un maintainer tiene que revisarlo a mano.`,
    );
  else if (t.checkChanged)
    out.push(
      "⚠️ **El veredicto no es confiable: este PR cambia el código o la configuración del check.** Un maintainer tiene que revisar esos archivos a mano.",
    );
  else if (failures.length === 0 && !t.impostor)
    out.push("✅ **Pasa.** Todos los cambios de mapa se pueden fusionar.");
  if (failures.length > 0)
    out.push(`❌ **No pasa:** ${failures.map((f) => FAILURE_TEXT[f]).join("; ")}.`);
  out.push(
    "",
    `Vale para el commit ${code(r.head.slice(0, 12))} contra la base ${code(r.base.slice(0, 12))} · autor ${code(r.author)}${t.maintainer ? " (maintainer)" : ""}`,
    "",
    "### Parcelas de comunidad",
  );
  const v = r.plots.violations;
  if (r.plots.violations_total === 0)
    out.push(
      `Todo lo que cambia cae dentro de las parcelas \`community_plot\` abiertas (${r.plots.count}).`,
    );
  else {
    out.push(
      t.maintainer
        ? "Fuera de parcelas (permitido porque el autor es maintainer, ver `.github/MAINTAINERS`):"
        : "Fuera de parcelas (solo un maintainer puede tocar esto, ver `.github/MAINTAINERS`):",
      "",
      "| Archivo | Qué | Por qué |",
      "|---|---|---|",
    );
    for (const x of v.slice(0, MAX_ROWS)) {
      if (x.kind === "tiles")
        out.push(
          `| ${code(x.path)} | ${x.tiles} casillas (${x.at.slice(0, 5).map(code).join(", ")}${x.at.length > 5 ? ", …" : ""}) | ${VIOLATION_TEXT.outside_plot} |`,
        );
      else if (x.kind === "entry")
        out.push(
          `| ${code(x.path)} | entrada ${code(x.entry)} ${CHANGE_TEXT[x.change] ?? ""} | ${VIOLATION_TEXT[x.reason] ?? ""} |`,
        );
      else out.push(`| ${code(x.path)} | archivo | ${VIOLATION_TEXT[x.reason] ?? ""} |`);
    }
    out.push(...more(r.plots.violations_total, Math.min(v.length, MAX_ROWS)));
  }

  out.push("", "### Cambios (resumen de `mapcli patch diff` contra el merge)");
  const changed = r.files.filter((f) => f.status !== "unchanged");
  if (changed.length === 0) out.push("Ningún archivo de mapa cambia al fusionar.");
  else {
    out.push("", "| Archivo | Estado | Detalle |", "|---|---|---|");
    for (const f of changed.slice(0, MAX_ROWS))
      out.push(`| ${code(f.path)} | ${f.status} | ${fileDetail(f)} |`);
    out.push(...more(changed.length, MAX_ROWS));
  }
  const pathList = (title: string, paths: string[]): void => {
    if (paths.length === 0) return;
    out.push("", title, "", ...paths.slice(0, MAX_ROWS).map((p) => `- ${code(p)}`));
  };
  pathList("**Archivos de mapa que no pasan su esquema:**", r.invalid_files);
  pathList(
    "**Archivos de mapa que no están en formato canónico** (corre `mapcli fmt` y vuelve a empujar):",
    r.noncanonical_files,
  );
  pathList(
    "**Rutas de `world/` o de contenido que no son archivos normales** (symlink, ejecutable o submódulo):",
    r.bad_mode_files,
  );
  pathList(
    "**Rutas de contenido que el check no pudo escribir como las deja el merge** (un nombre con `:`, `\\`, un salto de línea, `..` o `.git`, un submódulo, o un archivo donde el merge tiene una carpeta; `?` marca un carácter que no se muestra):",
    r.skipped_content,
  );
  if (r.skipped_content_total > r.skipped_content.length)
    out.push(`… y ${r.skipped_content_total - r.skipped_content.length} más.`);
  pathList(
    "**Archivos que git fusionaría distinto de lo revisado** (rebase sobre la base):",
    r.merge_mismatch,
  );
  if (r.conflicts.length > 0) {
    out.push("", "**Conflictos con la base actual:**", "");
    for (const c of r.conflicts.slice(0, MAX_ROWS))
      out.push(
        `- ${code(c.path)}: ${CONFLICT_TEXT[c.code]}${c.at.length > 0 ? ` (${c.at.slice(0, 10).map(code).join(", ")})` : ""}`,
      );
  }

  if (r.notes.length > 0)
    out.push("", "**Cómo se midió:**", "", ...r.notes.map((n) => `- ${NOTE_TEXT[n]}.`));

  out.push("", "### Validación");
  if (r.validation.new_errors_total === 0)
    out.push(
      `Sin errores nuevos (el mapa fusionado tiene ${r.validation.errors} errores en total).`,
    );
  else {
    const shown = r.validation.new_errors.slice(0, 20);
    out.push(
      `${r.validation.new_errors_total} errores nuevos:`,
      "",
      "```text",
      ...shown.map(plain),
      "```",
    );
    if (r.validation.new_errors_total > shown.length)
      out.push("", `… y ${r.validation.new_errors_total - shown.length} más.`);
  }

  out.push("", "### Antes / después");
  if (r.areas.length === 0) out.push("No hay áreas para renderizar.");
  else {
    out.push(
      ctx.artifactUrl
        ? `Las imágenes están en el artifact [\`${RENDERS_ARTIFACT}\`](${ctx.artifactUrl}) (zip, hace falta haber iniciado sesión en GitHub): \`before-N.png\` es la base actual y \`after-N.png\` el resultado del merge.`
        : `Las imágenes están en el artifact \`${RENDERS_ARTIFACT}\` de [la ejecución](${ctx.runUrl}).`,
      "",
      "| N | Isla | Piso | Área (x,y w×h) | Imágenes |",
      "|---|---|---|---|---|",
    );
    r.areas.forEach((a, i) => {
      const imgs = [a.before, a.after].filter((x): x is string => x !== undefined).map(code);
      out.push(
        `| ${i + 1} | ${a.island ? code(a.island) : "—"} | ${a.z} | ${a.x},${a.y} ${a.w}×${a.h} | ${imgs.join(" ") || "demasiado grande"} |`,
      );
    });
    if (r.omitted_areas > 0)
      out.push("", `${r.omitted_areas} áreas más sin renderizar (límite por PR).`);
  }
  if (t.otherFiles.length > 0 || t.unlisted > 0) {
    out.push(
      "",
      "### Fuera de `world/`",
      "Este PR también cambia archivos que no son de mapa; revísalos aparte:",
      "",
      ...t.otherFiles.slice(0, MAX_ROWS).map((p) => `- ${code(p)}${isSensitive(p) ? " ⚠️" : ""}`),
      ...more(t.otherFiles.length + t.unlisted, Math.min(t.otherFiles.length, MAX_ROWS)),
    );
  }
  out.push("", footer(ctx.runUrl));
  let body = out.join("\n");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n… (recortado)`;
  return body;
}

/**
 * Last line of every comment. The comment changes only when map-pr runs: a push that gets
 * no run (the PR renamed or deleted map-pr.yml) leaves it as it was, so it says which
 * commit it is about and where each commit's own verdict is (its commit status).
 */
function footer(runUrl: string): string {
  return `<sub>[Ejecución del check](${runUrl}) · se actualiza con cada corrida de \`map-pr\`. Vale solo para el commit que nombra: si el PR tiene uno más nuevo y esto no pasó a ⏳, el check no corrió para ese commit (le falta el status \`${STATUS_CONTEXT}\`).</sub>`;
}

/** Body for a PR whose current commit no longer changes world/ (the old verdict is void). */
export function noMapComment(headSha: string, runUrl: string, impostor = false): string {
  return [
    MARKER,
    "## Revisión de mapa (CI)",
    "",
    ...(impostor ? [IMPOSTOR_TEXT, ""] : []),
    `El commit ${code(headSha.slice(0, 12))} ya no cambia nada en \`world/\`: la revisión de mapa anterior no aplica.`,
    "",
    footer(runUrl),
  ].join("\n");
}

/** Body while map-pr runs for `headSha`: whatever the comment said before no longer applies. */
export function pendingComment(headSha: string, runUrl: string): string {
  return [
    MARKER,
    "## Revisión de mapa (CI)",
    "",
    `⏳ **Pendiente:** revisando el commit ${code(headSha.slice(0, 12))}. El veredicto anterior ya no vale.`,
    "",
    footer(runUrl),
  ].join("\n");
}

export interface CommitStatus {
  state: "pending" | "success" | "failure";
  /** At most 140 characters (GitHub's limit). */
  description: string;
}

const status = (state: CommitStatus["state"], description: string): CommitStatus => ({
  state,
  description: description.slice(0, 140),
});

/**
 * The commit status of the PR's head commit once map-pr finished, from the trusted side
 * (the API's file list and check runs, the default branch's MAINTAINERS) and the checked
 * report:
 * - another check run of the commit is named STATUS_CONTEXT: failure, always;
 * - the commit does not change world/: success, unless the API did not list every file
 *   and the author is not a maintainer (a world/ file could be among the unlisted ones).
 *   There is no map to judge: what such a PR changes in .github/ or elsewhere is for
 *   CODEOWNERS and the reviewer, not for this status (docs/04);
 * - no usable report, or any failure: failure;
 * - a pass the comment does not trust (the PR changes files outside world/ and docs/, or
 *   the file list is cut short): failure unless the author is a maintainer, whom the
 *   check already trusts with the whole map. The comment still says what to review;
 * - otherwise success. So a success is the comment's ✅, a maintainer's pass, or no map.
 */
export function commitStatus(
  report: CheckedReport | null,
  t: Trusted,
  touchesWorld: boolean,
): CommitStatus {
  if (t.impostor)
    return status("failure", `Otro check se llama ${STATUS_CONTEXT}: revisar .github/ a mano`);
  if (!touchesWorld)
    return t.truncated && !t.maintainer
      ? status("failure", "La API no lista todos los archivos del PR: revisión a mano")
      : status("success", "Este commit no cambia world/");
  if (report === null) return status("failure", "map-pr no dejó un reporte utilizable");
  const failures = verdict(report, t);
  if (failures.length > 0) return status("failure", `No pasa: ${failures.join(", ")}`);
  if (t.truncated || t.checkChanged)
    return t.maintainer
      ? status("success", "Pasa (autor maintainer); revisar a mano lo que cambia fuera de world/")
      : status("failure", "El PR cambia archivos fuera de world/ y docs/: revisión a mano");
  return status("success", "Pasa");
}

// ---- GitHub ---------------------------------------------------------------------------------

/**
 * What the workflow passes in. Every value comes from the workflow_run event, whose
 * head_* fields the PR's author controls: readEnv checks each one by pattern, and none of
 * them is ever run, only compared or used in an API path.
 */
export interface Env {
  token: string;
  repo: string;
  runId: string;
  headSha: string;
  /** "owner/name" of the PR's head repo; empty when the fork is gone. */
  headRepo: string;
  conclusion: string;
  report: string;
  maintainers: string;
  prHint: string;
  /** The repo's default branch (the event's repository, not the PR's): the status is its. */
  defaultBranch: string;
  api: string;
  server: string;
}

/** One GitHub API call: method, path under the API root, JSON body. */
export type Gh = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** "owner/name": a GitHub login, then a repo name that is not "." or "..". */
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
/**
 * A plain branch name: compared with the API's base.ref and put in the path of its git ref
 * (defaultTip), so no "..", "//", trailing "/", spaces, "?", "#" or "%".
 */
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!.*\/$)[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/;

/** Reads and checks the workflow's environment; throws on anything unexpected. */
export function readEnv(ev: Record<string, string | undefined>): Env {
  const env: Env = {
    token: ev.GITHUB_TOKEN ?? "",
    repo: ev.GITHUB_REPOSITORY ?? "",
    runId: ev.RUN_ID ?? "",
    headSha: ev.HEAD_SHA ?? "",
    headRepo: ev.HEAD_REPO ?? "",
    conclusion: ev.CONCLUSION ?? "unknown",
    report: ev.REPORT ?? "report/report.json",
    maintainers: ev.MAINTAINERS ?? ".github/MAINTAINERS",
    prHint: ev.PR_HINT ?? "",
    defaultBranch: ev.DEFAULT_BRANCH ?? "",
    api: ev.GITHUB_API_URL ?? "https://api.github.com",
    server: ev.GITHUB_SERVER_URL ?? "https://github.com",
  };
  if (!REPO.test(env.repo) || !/^\d{1,20}$/.test(env.runId) || !SHA.test(env.headSha))
    throw new Error("GITHUB_REPOSITORY, RUN_ID and HEAD_SHA are required");
  if (!BRANCH.test(env.defaultBranch)) throw new Error("DEFAULT_BRANCH is required");
  if (env.headRepo !== "" && !REPO.test(env.headRepo)) throw new Error("bad HEAD_REPO");
  if (env.prHint !== "" && !/^\d{1,9}$/.test(env.prHint)) throw new Error("bad PR_HINT");
  return env;
}

/** The real API, with the workflow's token. Any HTTP error throws (the job turns red). */
export function fetchGh(env: Env): Gh {
  return async (method, path, body) => {
    const res = await fetch(`${env.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
}

interface Pull {
  number: number;
  state: string;
  author_association: string;
  user: { login: string };
  head: { sha: string; repo: { full_name: string } | null };
  base: { ref: string };
}

const headRepoOf = (p: Pull): string | undefined => p.head.repo?.full_name;

/**
 * Every open PR whose head is the run's commit, from any head repo (workflow_run gives no
 * PR for forks). Usually one. The run's own PR is among those from the run's head repo;
 * the others only matter for the status (currentPull).
 */
async function findPulls(env: Env, gh: Gh): Promise<Pull[]> {
  const out: Pull[] = [];
  const add = (p: Pull): void => {
    if (
      p.state === "open" && // the hint is fetched by number: it may be closed
      p.head.sha === env.headSha &&
      !out.some((q) => q.number === p.number)
    )
      out.push(p);
  };
  // The hint first: it may be past the listing's 1000 newest open PRs.
  if (env.prHint !== "") add((await gh("GET", `/repos/${env.repo}/pulls/${env.prHint}`)) as Pull);
  for (let page = 1; page <= 10; page++) {
    const list = (await gh(
      "GET",
      `/repos/${env.repo}/pulls?state=open&per_page=100&page=${page}`,
    )) as Pull[];
    list.forEach(add);
    if (list.length < 100) break;
  }
  return out;
}

/**
 * Which of those PRs the run is for. The report's PR number picks among them: it is
 * untrusted, but it can only name a PR with this same commit and head repo, whose own
 * trusted facts then decide, and the report must still match that PR (matchReport).
 * Without it (the --pending job, a run with no usable report), PRs that all go into one
 * branch are one case (the first); PRs into different branches cannot be told apart, so
 * nothing is picked and nothing is written: a run for the PR into an old branch must not
 * write the verdict, nor a pending status, of the one into main.
 */
export function pickPull<P extends { number: number; base: { ref: string } }>(
  pulls: readonly P[],
  reportPr?: number,
): P | undefined {
  const named = pulls.find((p) => p.number === reportPr);
  if (named) return named;
  return new Set(pulls.map((p) => p.base.ref)).size > 1 ? undefined : pulls[0];
}

/** Changed files of the PR, from the API (at most 3000, GitHub's own limit). */
async function pullFiles(env: Env, gh: Gh, pr: number): Promise<string[]> {
  const out: { filename: string; previous_filename?: string }[] = [];
  for (let page = 1; page <= MAX_API_FILES / 100; page++) {
    const list = (await gh(
      "GET",
      `/repos/${env.repo}/pulls/${pr}/files?per_page=100&page=${page}`,
    )) as { filename: string; previous_filename?: string }[];
    out.push(...list);
    if (list.length < 100) break;
  }
  return filePaths(out);
}

/** The PR's comment: its id and the map-pr run that last wrote it (none: older format). */
interface OurComment {
  id: number;
  run?: bigint;
}

async function findComment(env: Env, gh: Gh, pr: number): Promise<OurComment | undefined> {
  for (let page = 1; page <= 30; page++) {
    const list = (await gh(
      "GET",
      `/repos/${env.repo}/issues/${pr}/comments?per_page=100&page=${page}`,
    )) as { id: number; body?: string; user?: { login?: string } }[];
    const mine = list.find(
      (c) => c.user?.login === "github-actions[bot]" && c.body?.startsWith(MARKER) === true,
    );
    if (mine) {
      const run = RUN_LINE.exec((mine.body?.split("\n")[1] ?? "").trim())?.[1];
      return run === undefined ? { id: mine.id } : { id: mine.id, run: BigInt(run) };
    }
    if (list.length < 100) break;
  }
  return undefined;
}

/** The body with the run that writes it on its second (hidden) line. */
export function stampRun(body: string, runId: string): string {
  return `${MARKER}\n<!-- map-pr-run ${runId} -->${body.slice(MARKER.length)}`;
}

/**
 * Run ids only grow, so a comment written by a newer run means this event arrived late
 * (GitHub may deliver workflow_run events out of order): it must not replace what a newer
 * run of the same PR wrote, nor that run's status. Re-running the newest run is allowed.
 */
function newerRun(c: OurComment | undefined, runId: string): string | undefined {
  return c?.run !== undefined && c.run > BigInt(runId)
    ? `run ${c.run} of map-pr is newer than ${runId}; nothing to do`
    : undefined;
}

/**
 * Any check run on the commit named like the status. map-pr-comment only sets a commit
 * status, so a check run with that name is some workflow's job posing as it (a PR can add
 * such a workflow, also from a fork). This sees the ones that exist when the verdict is
 * written, not one a job creates later (`needs:` a slow job): it warns, it cannot prevent.
 */
async function impostorCheck(env: Env, gh: Gh): Promise<boolean> {
  const res = (await gh(
    "GET",
    `/repos/${env.repo}/commits/${env.headSha}/check-runs?check_name=${encodeURIComponent(STATUS_CONTEXT)}&filter=all&per_page=1`,
  )) as { total_count?: unknown } | null;
  // Fail closed: an answer without the count turns the job red, the status stays unset.
  if (typeof res?.total_count !== "number") throw new Error("check-runs: no total_count");
  return res.total_count > 0;
}

/** Sets STATUS_CONTEXT on the run's head commit, linked to the map-pr run. */
async function setStatus(env: Env, gh: Gh, s: CommitStatus): Promise<void> {
  await gh("POST", `/repos/${env.repo}/statuses/${env.headSha}`, {
    state: s.state,
    context: STATUS_CONTEXT,
    description: s.description,
    target_url: runUrlOf(env),
  });
}

const runUrlOf = (env: Env): string => `${env.server}/${env.repo}/actions/runs/${env.runId}`;

/**
 * Any run of map-pr.yml for the same commit from the same head repo newer than this one.
 * Run ids only grow, so this event is late (GitHub may deliver workflow_run events out of
 * order). Only asked when the PR is the only open one with that head from that repo: then
 * every such run is for this PR (or for a closed PR, or for an open one that moved on to
 * another commit), and an older one must write nothing, not even where the comment's own
 * stamp cannot tell (no comment yet, or a PR that does not change world/). With other open
 * PRs of that head from that repo, a newer run may be theirs and is no reason to hold this
 * one back; a verdict computed against another base never sets the status (defaultTip).
 * The listing is newest first: it is read page by page until a run as old as this one (or
 * its end). Fail closed: an answer without the list, or more than MAX_RUN_PAGES pages of
 * newer runs (GitHub lists no further), turns the job red before anything is written.
 */
async function newerRunOfCommit(env: Env, gh: Gh): Promise<string | undefined> {
  const mine = BigInt(env.runId);
  for (let page = 1; page <= MAX_RUN_PAGES; page++) {
    const res = (await gh(
      "GET",
      `/repos/${env.repo}/actions/workflows/${CHECK_WORKFLOW_FILE}/runs?head_sha=${env.headSha}&event=pull_request&per_page=100&page=${page}`,
    )) as { workflow_runs?: unknown } | null;
    if (!Array.isArray(res?.workflow_runs)) throw new Error("actions/runs: no workflow_runs");
    const runs = res.workflow_runs as {
      id?: unknown;
      head_repository?: { full_name?: unknown } | null;
    }[];
    let reachedMine = false;
    for (const r of runs) {
      if (typeof r.id !== "number" || !Number.isSafeInteger(r.id)) continue;
      const id = BigInt(r.id);
      if (id <= mine) reachedMine = true;
      else if (r.head_repository?.full_name === env.headRepo)
        return `run ${id} of map-pr is newer than ${env.runId} for this commit; nothing to do`;
    }
    if (reachedMine || runs.length < 100) return undefined;
  }
  throw new Error(
    `actions/runs: more than ${MAX_RUN_PAGES * 100} runs of the commit newer than ${env.runId}`,
  );
}

/**
 * The default branch's tip now (its git ref). A report is a verdict against the base tip
 * its run checked out (report.base, the sha prcheck resolved from base.ref). Only one
 * against this tip may become the status: the run of a PR that went into another branch
 * when it started (its base changed to main since), or one that main moved past, never
 * sets it, however late its event arrives and whatever other PRs share the commit. An
 * answer without a sha turns the job red before anything is written.
 */
async function defaultTip(env: Env, gh: Gh): Promise<string> {
  const res = (await gh("GET", `/repos/${env.repo}/git/ref/heads/${env.defaultBranch}`)) as {
    object?: { sha?: unknown };
  } | null;
  const sha = res?.object?.sha;
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("git/ref: no sha");
  return sha;
}

/** The PR a run is for, as currentPull finds it. */
interface Current {
  pull: Pull;
  changedFiles: number | undefined;
  /** Why this run sets no commit status (undefined: it sets it). */
  noStatus?: string;
}

/**
 * The PR this run is for, if its head is still the run's commit. A run for an older
 * commit changes nothing: its own (newer) run comments, and an old report must never
 * replace "pending" or a newer verdict. Nor does a run older than the newest map-pr run
 * of the commit when the PR is the only one with that head (newerRunOfCommit).
 *
 * The commit status is written only for a PR into the default branch, and only if no
 * other open PR into it has the same commit from another head repo or author. The status
 * is per commit but the verdict depends on who opened the PR from where (maintainer):
 * GitHub allows one open PR per head branch and base, but anyone can push a maintainer's
 * commit to a fork, or open a PR from another branch of the repo with the same tip, and
 * with every run of that copy turn the commit's status to failure. With such a copy
 * open, neither run writes the status: it keeps what it had (pending or none blocks the
 * merge) until the copy is closed and the PR's map-pr runs again (a new run).
 */
async function currentPull(env: Env, gh: Gh, reportPr?: number): Promise<Current | string> {
  const all = await findPulls(env, gh);
  const pulls = all.filter((p) => headRepoOf(p) === env.headRepo);
  if (pulls.length === 0)
    return `no open pull request has head ${env.headSha} from the run's repo; nothing to do`;
  const picked = pickPull(pulls, reportPr);
  if (!picked)
    return `PRs ${pulls.map((p) => `#${p.number}`).join(", ")} share head ${env.headSha} and go into different branches, and the run does not say which it is for; nothing to do`;
  // The single-PR endpoint has the PR's own file count (the list endpoint does not), and
  // is the freshest view of its head and base.
  const full = (await gh("GET", `/repos/${env.repo}/pulls/${picked.number}`)) as Pull & {
    changed_files?: number;
  };
  if (full.head.sha !== env.headSha)
    return `PR #${full.number} moved on to ${full.head.sha}; nothing to do`;
  if (pulls.length === 1) {
    const late = await newerRunOfCommit(env, gh);
    if (late) return `PR #${full.number}: ${late}`;
  }
  const who = (p: Pull): string => `${headRepoOf(p) ?? ""} ${p.user.login.toLowerCase()}`;
  const copies = all.filter(
    (p) => p.number !== full.number && p.base.ref === env.defaultBranch && who(p) !== who(full),
  );
  const noStatus =
    full.base.ref !== env.defaultBranch
      ? `PR into ${full.base.ref}`
      : copies.length > 0
        ? `${copies.map((p) => `#${p.number}`).join(", ")} into ${env.defaultBranch} has the same commit from another repo or author`
        : undefined;
  return {
    pull: full,
    changedFiles: full.changed_files,
    ...(noStatus === undefined ? {} : { noStatus }),
  };
}

/**
 * A map-pr run started (workflow_run `requested`): the head commit gets a pending status
 * (when currentPull allows it) and the comment, if there is one, turns to "pending".
 * Nothing is read from the PR's run. If the run already finished, the completed job
 * writes the verdict, so this does nothing.
 */
export async function markPending(env: Env, gh: Gh): Promise<string> {
  const cur = await currentPull(env, gh);
  if (typeof cur === "string") return cur;
  const run = (await gh("GET", `/repos/${env.repo}/actions/runs/${env.runId}`)) as {
    status?: string;
  };
  if (run.status === "completed")
    return `run ${env.runId} already completed; the verdict job writes the result`;
  const n = cur.pull.number;
  const existing = await findComment(env, gh, n);
  const late = newerRun(existing, env.runId);
  if (late) return `PR #${n}: ${late}`;
  const done: string[] = [];
  if (cur.noStatus === undefined) {
    await setStatus(env, gh, status("pending", `Revisando el commit ${env.headSha.slice(0, 12)}`));
    done.push("status pending");
  } else done.push(`no status (${cur.noStatus})`);
  if (existing === undefined) done.push("no comment yet");
  else {
    await gh("PATCH", `/repos/${env.repo}/issues/comments/${existing.id}`, {
      body: stampRun(pendingComment(env.headSha, runUrlOf(env)), env.runId),
    });
    done.push(`comment ${existing.id} marked pending`);
  }
  return `PR #${n}: ${done.join(", ")}`;
}

/**
 * A map-pr run finished (workflow_run `completed`): the comment gets the verdict and the
 * head commit its final status (when currentPull allows it). A report computed against
 * anything but the default branch's tip now is no verdict for a PR into it (other_base:
 * a failure, never a success of another base). The comment is written first; if the
 * status call fails the job is red and the commit keeps the status it had: `pending` when
 * the pending job marked this run, none for a new commit.
 */
export async function postVerdict(env: Env, gh: Gh): Promise<string> {
  if (NO_VERDICT.includes(env.conclusion))
    return `run ${env.runId} ended ${env.conclusion}: no verdict; nothing to do`;
  let { report, error } = readReport(env.report);
  const cur = await currentPull(env, gh, report?.pr);
  if (typeof cur === "string") return cur;
  const { pull } = cur;
  const existing = await findComment(env, gh, pull.number);
  const late = newerRun(existing, env.runId);
  if (late) return `PR #${pull.number}: ${late}`;
  const runUrl = runUrlOf(env);
  const files = await pullFiles(env, gh, pull.number);
  const impostor = await impostorCheck(env, gh);
  let maintainersText = "";
  try {
    maintainersText = readFileSync(env.maintainers, "utf8");
  } catch {
    // No file on the default branch: only the owner is a maintainer.
  }
  const maintainer = isMaintainer(
    {
      author: pull.user.login,
      association: pull.author_association,
      headRepo: pull.head.repo?.full_name ?? null,
      repo: env.repo,
    },
    parseMaintainers(maintainersText),
  );
  const t = trustedFacts(files, maintainer, cur.changedFiles ?? files.length, impostor);
  const touchesWorld = files.some((p) => p.startsWith("world/")) || report?.map_changes === true;
  let body: string | undefined;
  if (!touchesWorld) {
    if (existing !== undefined) body = noMapComment(env.headSha, runUrl, impostor);
  } else {
    if (report) {
      error = matchReport(report, pull.number, env.headSha, pull.user.login);
      // Into the default branch the verdict may become the status: only one computed
      // against its tip now (defaultTip). Not asked for a PR into another branch, which
      // sets no status.
      if (
        !error &&
        pull.base.ref === env.defaultBranch &&
        report.base !== (await defaultTip(env, gh))
      )
        error = "other_base";
      if (error) report = null;
    }
    const ctx: CommentContext = { runUrl, conclusion: env.conclusion };
    const arts = (await gh("GET", `/repos/${env.repo}/actions/runs/${env.runId}/artifacts`)) as {
      artifacts: { id: number; name: string }[];
    };
    const art = arts.artifacts.find((a) => a.name === RENDERS_ARTIFACT);
    if (art) ctx.artifactUrl = `${runUrl}/artifacts/${art.id}`;
    body = buildComment(report, ctx, t, error);
  }
  const done: string[] = [];
  if (body !== undefined && existing !== undefined) {
    await gh("PATCH", `/repos/${env.repo}/issues/comments/${existing.id}`, {
      body: stampRun(body, env.runId),
    });
    done.push(`updated comment ${existing.id}`);
  } else if (body !== undefined) {
    await gh("POST", `/repos/${env.repo}/issues/${pull.number}/comments`, {
      body: stampRun(body, env.runId),
    });
    done.push("created comment");
  } else done.push("no comment (does not change world/)");
  const s = commitStatus(report, t, touchesWorld);
  if (cur.noStatus === undefined) {
    await setStatus(env, gh, s);
    done.push(`status ${s.state}`);
  } else done.push(`no status (${cur.noStatus}; would be ${s.state})`);
  return `PR #${pull.number}: ${done.join(", ")}`;
}

/** Reads and checks the report file (missing or invalid: null plus the reason code). */
export function readReport(path: string): {
  report: CheckedReport | null;
  error?: ReportErrorCode;
} {
  try {
    if (statSync(path).size > MAX_REPORT_BYTES) return { report: null, error: "too_large" };
    return { report: checkReport(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (e) {
    if (e instanceof ReportError || e instanceof SyntaxError)
      return { report: null, error: "invalid_report" };
    return { report: null, error: "no_report" };
  }
}

/** The report must be about this PR, this commit and this author (it is the PR's output). */
export function matchReport(
  r: CheckedReport,
  pr: number,
  headSha: string,
  author: string,
): ReportErrorCode | undefined {
  if (r.pr !== pr) return "other_pr";
  if (r.head !== headSha) return "other_commit";
  if (r.author.toLowerCase() !== author.toLowerCase()) return "other_author";
  return undefined;
}

async function main(argv: string[]): Promise<number> {
  const ev = process.env;
  if (argv[0] === "--dry-run") {
    // Local runs and the check job's step summary: no network. The trusted facts come from
    // the report itself here, so this output is only a preview.
    const { report, error } = readReport(argv[1] ?? "report.json");
    const runUrl =
      ev.GITHUB_REPOSITORY && ev.GITHUB_RUN_ID
        ? `${ev.GITHUB_SERVER_URL ?? "https://github.com"}/${ev.GITHUB_REPOSITORY}/actions/runs/${ev.GITHUB_RUN_ID}`
        : "https://github.com/OWNER/REPO/actions/runs/RUN_ID";
    const t = trustedFacts(report?.other_files ?? [], report?.maintainer ?? false);
    const conclusion = report?.ok ? "success" : "failure";
    process.stdout.write(`${buildComment(report, { runUrl, conclusion }, t, error)}\n`);
    return report ? 0 : 1;
  }
  const env = readEnv(ev);
  const gh = fetchGh(env);
  const out = argv[0] === "--pending" ? await markPending(env, gh) : await postVerdict(env, gh);
  process.stdout.write(`${out}\n`);
  return 0;
}

if (process.argv[1]?.endsWith("prcomment.ts"))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`prcomment: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
