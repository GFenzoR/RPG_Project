// Comment of the map PR check (T2.4, docs/04-map-editor-and-ai.md "PR de mapas en CI").
//
// Runs in the `map-pr-comment` workflow (workflow_run), which has `pull-requests: write`
// and must never run anything from the pull request. So this file:
//   - is self-contained (Node built-ins only, no workspace packages, no pnpm install), and
//     is checked out from the default branch, never from the PR;
//   - treats report.json (an artifact the PR's own job wrote) as untrusted data: size cap,
//     every field type-checked and every string matched against a strict pattern, and the
//     PR number, head commit and author checked against the GitHub API;
//   - writes one comment per PR, found by a hidden marker and updated on every push.
//
//   node --experimental-strip-types tools/mapcli/src/prcomment.ts            (in CI, env below)
//   node --experimental-strip-types tools/mapcli/src/prcomment.ts --dry-run REPORT.json
//                                                     prints the Markdown, no network
import { readFileSync, statSync } from "node:fs";

export const MARKER = "<!-- rpg-map-pr-check -->";
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
const ANY_PATH = /^[A-Za-z0-9_./ +@-]{1,300}$/;
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
        reason: oneOf(v.reason, "reason", ["outside_plot", "plot_definition"]),
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
      str(p, "bad_mode_files", WORLD_PATH),
    ),
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
  plots: "toca el mapa fuera de las parcelas `community_plot` y el autor no es maintainer",
  conflicts: "choca con cambios posteriores de la rama base (rebase y vuelve a empujar)",
  validation: "el mapa fusionado tiene errores nuevos del validador",
  invalid:
    "un archivo de mapa del PR no pasa su esquema, no está en formato canónico (corre `mapcli fmt`) o no es un archivo normal",
  rebase: "git no puede fusionar la rama con la base (rebase y vuelve a empujar)",
  merge_mismatch:
    "git fusionaría el texto de un archivo distinto de como se revisó (paletas de chunk): rebase y vuelve a empujar",
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
} as const;
export type ReportErrorCode = keyof typeof REPORT_ERRORS;

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
  else if (failures.length === 0)
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
    "**Rutas de `world/` que no son archivos normales** (symlink, ejecutable o submódulo):",
    r.bad_mode_files,
  );
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
  out.push("", `<sub>[Ejecución del check](${ctx.runUrl}) · se actualiza en cada push.</sub>`);
  let body = out.join("\n");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n… (recortado)`;
  return body;
}

/** Body for a PR whose current commit no longer changes world/ (the old verdict is void). */
export function noMapComment(headSha: string, runUrl: string): string {
  return [
    MARKER,
    "## Revisión de mapa (CI)",
    "",
    `El commit ${code(headSha.slice(0, 12))} ya no cambia nada en \`world/\`: la revisión de mapa anterior no aplica.`,
    "",
    `<sub>[Ejecución del check](${runUrl}) · se actualiza en cada push.</sub>`,
  ].join("\n");
}

// ---- GitHub ---------------------------------------------------------------------------------

interface Env {
  token: string;
  repo: string;
  runId: string;
  headSha: string;
  headRepo: string;
  conclusion: string;
  report: string;
  maintainers: string;
  prHint: string;
  api: string;
  server: string;
}

async function gh(env: Env, method: string, path: string, body?: unknown): Promise<unknown> {
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
}

interface Pull {
  number: number;
  author_association: string;
  user: { login: string };
  head: { sha: string; repo: { full_name: string } | null };
}

/** The open PR whose head is the run's commit (workflow_run gives no PR for forks). */
async function findPull(env: Env): Promise<Pull | undefined> {
  const matches = (p: Pull): boolean =>
    p.head.sha === env.headSha && p.head.repo?.full_name === env.headRepo;
  if (/^\d{1,9}$/.test(env.prHint)) {
    const p = (await gh(env, "GET", `/repos/${env.repo}/pulls/${env.prHint}`)) as Pull;
    if (matches(p)) return p;
  }
  for (let page = 1; page <= 10; page++) {
    const list = (await gh(
      env,
      "GET",
      `/repos/${env.repo}/pulls?state=open&per_page=100&page=${page}`,
    )) as Pull[];
    const p = list.find(matches);
    if (p) return p;
    if (list.length < 100) break;
  }
  return undefined;
}

/** Changed files of the PR, from the API (at most 3000, GitHub's own limit). */
async function pullFiles(env: Env, pr: number): Promise<string[]> {
  const out: { filename: string; previous_filename?: string }[] = [];
  for (let page = 1; page <= MAX_API_FILES / 100; page++) {
    const list = (await gh(
      env,
      "GET",
      `/repos/${env.repo}/pulls/${pr}/files?per_page=100&page=${page}`,
    )) as { filename: string; previous_filename?: string }[];
    out.push(...list);
    if (list.length < 100) break;
  }
  return filePaths(out);
}

async function findComment(env: Env, pr: number): Promise<number | undefined> {
  for (let page = 1; page <= 30; page++) {
    const list = (await gh(
      env,
      "GET",
      `/repos/${env.repo}/issues/${pr}/comments?per_page=100&page=${page}`,
    )) as { id: number; body?: string; user?: { login?: string } }[];
    const mine = list.find(
      (c) => c.user?.login === "github-actions[bot]" && c.body?.startsWith(MARKER) === true,
    );
    if (mine) return mine.id;
    if (list.length < 100) break;
  }
  return undefined;
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
    api: ev.GITHUB_API_URL ?? "https://api.github.com",
    server: ev.GITHUB_SERVER_URL ?? "https://github.com",
  };
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.repo) || !/^\d+$/.test(env.runId) || !SHA.test(env.headSha))
    throw new Error("GITHUB_REPOSITORY, RUN_ID and HEAD_SHA are required");
  const pull = await findPull(env);
  if (!pull) {
    process.stdout.write(`no open pull request has head ${env.headSha}; nothing to comment\n`);
    return 0;
  }
  const runUrl = `${env.server}/${env.repo}/actions/runs/${env.runId}`;
  const files = await pullFiles(env, pull.number);
  // The single-PR endpoint has the PR's own file count (the list endpoint does not).
  const full = (await gh(env, "GET", `/repos/${env.repo}/pulls/${pull.number}`)) as {
    changed_files?: number;
    head: { sha: string };
  };
  if (full.head.sha !== env.headSha) {
    // A newer push: its own run will comment; an old report must not replace "pending".
    process.stdout.write(`PR #${pull.number} moved on to ${full.head.sha}; nothing to do\n`);
    return 0;
  }
  const existing = await findComment(env, pull.number);
  let { report, error } = readReport(env.report);
  const touchesWorld = files.some((p) => p.startsWith("world/")) || report?.map_changes === true;
  let body: string;
  if (!touchesWorld) {
    if (existing === undefined) {
      process.stdout.write(`PR #${pull.number} does not change world/; no comment\n`);
      return 0;
    }
    body = noMapComment(env.headSha, runUrl);
  } else {
    if (report) {
      error = matchReport(report, pull.number, env.headSha, pull.user.login);
      if (error) report = null;
    }
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
    const ctx: CommentContext = { runUrl, conclusion: env.conclusion };
    const arts = (await gh(
      env,
      "GET",
      `/repos/${env.repo}/actions/runs/${env.runId}/artifacts`,
    )) as { artifacts: { id: number; name: string }[] };
    const art = arts.artifacts.find((a) => a.name === RENDERS_ARTIFACT);
    if (art) ctx.artifactUrl = `${runUrl}/artifacts/${art.id}`;
    body = buildComment(
      report,
      ctx,
      trustedFacts(files, maintainer, full.changed_files ?? files.length),
      error,
    );
  }
  if (existing !== undefined) {
    await gh(env, "PATCH", `/repos/${env.repo}/issues/comments/${existing}`, { body });
    process.stdout.write(`PR #${pull.number}: updated comment ${existing}\n`);
  } else {
    await gh(env, "POST", `/repos/${env.repo}/issues/${pull.number}/comments`, { body });
    process.stdout.write(`PR #${pull.number}: created comment\n`);
  }
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
