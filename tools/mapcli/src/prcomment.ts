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
const TEXT = /^[^`\r\n<>]{0,300}$/;
const PNG = /^(?:before|after)-\d{1,2}\.png$/;
const STATUSES = ["added", "removed", "modified", "unchanged", "conflict"] as const;
const FAILURES = ["plots", "conflicts", "validation"] as const;

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
  failures: string[];
  files: CheckedFile[];
  conflicts: { path: string; reason: string; at: string[] }[];
  plots: { count: number; violations: CheckedViolation[] };
  validation: { errors: number; new_errors: string[] };
  other_files: string[];
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
  if (r.format !== 1) throw new ReportError("report: unknown format");
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
    files,
    conflicts: arr(r.conflicts, "conflicts", 4096).map((x, i) => {
      const c = obj(x, `conflicts[${i}]`);
      return {
        path: str(c.path, "conflicts.path", WORLD_PATH),
        reason: str(c.reason, "conflicts.reason", TEXT),
        at:
          c.at === undefined
            ? []
            : arr(c.at, "at", 100).map((t) => str(t, "at", /^[a-z0-9_,]{1,64}$/)),
      };
    }),
    plots: { count: int(plots.count, "plots.count"), violations },
    validation: {
      errors: int(validation.errors, "validation.errors"),
      new_errors: arr(validation.new_errors, "new_errors", 100).map((e) => {
        if (typeof e !== "string") throw new ReportError("new_errors: not a string");
        return e;
      }),
    },
    other_files: arr(r.other_files, "other_files", 100).map((p) => str(p, "other_files", ANY_PATH)),
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

// ---- Markdown ------------------------------------------------------------------------------

/** Inline code: the only way untrusted-but-checked strings reach the comment. */
const code = (s: string): string => `\`${s.replace(/[`\r\n]/g, "")}\``;

/** Validator messages are free text: a fenced block, no backticks, no line breaks, capped. */
const plain = (s: string): string =>
  s
    .replace(/[`\r\n]/g, " ")
    .replace(/[^\x20-\x7e\u00a1-\u024f]/g, "?")
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
const FAILURE_TEXT: Record<string, string> = {
  plots: "toca el mapa fuera de las parcelas `community_plot` y el autor no es maintainer",
  conflicts: "choca con cambios posteriores de la rama base (rebase y vuelve a empujar)",
  validation: "el mapa fusionado tiene errores nuevos del validador",
};

export interface CommentContext {
  repo: string;
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

/** The comment body; `report` null means the run left no usable report (`error` says why). */
export function buildComment(
  report: CheckedReport | null,
  ctx: CommentContext,
  error?: string,
): string {
  const out: string[] = [MARKER, "## Revisión de mapa (CI)", ""];
  if (report === null) {
    out.push(
      `⚠️ El job \`map-pr\` terminó con \`${ctx.conclusion.replace(/[^a-z_]/g, "")}\` y no dejó un reporte utilizable` +
        (error ? ` (${plain(error)})` : "") +
        ".",
      "",
      `[Ver la ejecución](${ctx.runUrl})`,
    );
    return out.join("\n");
  }
  const r = report;
  out.push(
    r.ok
      ? "✅ **Pasa.** Todos los cambios de mapa se pueden fusionar."
      : `❌ **No pasa:** ${r.failures.map((f) => FAILURE_TEXT[f] ?? f).join("; ")}.`,
    "",
    `Commit ${code(r.head.slice(0, 12))} contra la base ${code(r.base.slice(0, 12))} · autor ${code(r.author)}${r.maintainer ? " (maintainer)" : ""}`,
    "",
    "### Parcelas de comunidad",
  );
  const v = r.plots.violations;
  if (v.length === 0)
    out.push(
      `Todo lo que cambia cae dentro de las ${r.plots.count} parcelas \`community_plot\` abiertas.`,
    );
  else {
    out.push(
      r.maintainer
        ? `Fuera de parcelas (permitido porque el autor es maintainer, ver \`.github/MAINTAINERS\`):`
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
    if (v.length > MAX_ROWS) out.push("", `… y ${v.length - MAX_ROWS} más.`);
  }

  out.push("", "### Cambios (resumen de `mapcli patch diff` contra el merge)");
  const changed = r.files.filter((f) => f.status !== "unchanged");
  if (changed.length === 0) out.push("Ningún archivo de mapa cambia al fusionar.");
  else {
    out.push("", "| Archivo | Estado | Detalle |", "|---|---|---|");
    for (const f of changed.slice(0, MAX_ROWS))
      out.push(`| ${code(f.path)} | ${f.status} | ${fileDetail(f)} |`);
    if (changed.length > MAX_ROWS) out.push("", `… y ${changed.length - MAX_ROWS} archivos más.`);
  }
  if (r.conflicts.length > 0) {
    out.push("", "**Conflictos con la base actual:**", "");
    for (const c of r.conflicts.slice(0, MAX_ROWS))
      out.push(
        `- ${code(c.path)}: ${plain(c.reason)}${c.at.length > 0 ? ` (${c.at.slice(0, 10).map(code).join(", ")})` : ""}`,
      );
  }

  out.push("", "### Validación");
  if (r.validation.new_errors.length === 0)
    out.push(
      `Sin errores nuevos (el mapa fusionado tiene ${r.validation.errors} errores en total).`,
    );
  else
    out.push(
      `${r.validation.new_errors.length} errores nuevos:`,
      "",
      "```text",
      ...r.validation.new_errors.slice(0, 20).map(plain),
      "```",
    );

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
  if (r.other_files.length > 0)
    out.push(
      "",
      "### Fuera de `world/`",
      "Este PR también cambia archivos que no son de mapa; revísalos aparte:",
      "",
      ...r.other_files.slice(0, 20).map((p) => `- ${code(p)}`),
    );
  out.push("", `<sub>[Ejecución del check](${ctx.runUrl}) · se actualiza en cada push.</sub>`);
  let body = out.join("\n");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n… (recortado)`;
  return body;
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

async function upsert(env: Env, pr: number, body: string): Promise<string> {
  for (let page = 1; page <= 30; page++) {
    const list = (await gh(
      env,
      "GET",
      `/repos/${env.repo}/issues/${pr}/comments?per_page=100&page=${page}`,
    )) as { id: number; body?: string; user?: { login?: string } }[];
    const mine = list.find(
      (c) => c.user?.login === "github-actions[bot]" && c.body?.startsWith(MARKER) === true,
    );
    if (mine) {
      await gh(env, "PATCH", `/repos/${env.repo}/issues/comments/${mine.id}`, { body });
      return `updated comment ${mine.id}`;
    }
    if (list.length < 100) break;
  }
  await gh(env, "POST", `/repos/${env.repo}/issues/${pr}/comments`, { body });
  return "created comment";
}

/** Reads and checks the report file (missing or invalid: null plus the reason). */
export function readReport(path: string): { report: CheckedReport | null; error?: string } {
  try {
    if (statSync(path).size > MAX_REPORT_BYTES) return { report: null, error: "report too large" };
    return { report: checkReport(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (e) {
    if (e instanceof ReportError || e instanceof SyntaxError)
      return { report: null, error: `invalid report: ${e.message}` };
    return { report: null, error: "no report" };
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--dry-run") {
    // Local runs and the check job's step summary: no network, links to this run if any.
    const { report, error } = readReport(argv[1] ?? "report.json");
    const ev = process.env;
    const runUrl =
      ev.GITHUB_REPOSITORY && ev.GITHUB_RUN_ID
        ? `${ev.GITHUB_SERVER_URL ?? "https://github.com"}/${ev.GITHUB_REPOSITORY}/actions/runs/${ev.GITHUB_RUN_ID}`
        : "https://github.com/OWNER/REPO/actions/runs/RUN_ID";
    const conclusion = report?.ok ? "success" : "failure";
    process.stdout.write(`${buildComment(report, { repo: "", runUrl, conclusion }, error)}\n`);
    return report ? 0 : 1;
  }
  const e = process.env;
  const env: Env = {
    token: e.GITHUB_TOKEN ?? "",
    repo: e.GITHUB_REPOSITORY ?? "",
    runId: e.RUN_ID ?? "",
    headSha: e.HEAD_SHA ?? "",
    headRepo: e.HEAD_REPO ?? "",
    conclusion: e.CONCLUSION ?? "unknown",
    report: e.REPORT ?? "report/report.json",
    prHint: e.PR_HINT ?? "",
    api: e.GITHUB_API_URL ?? "https://api.github.com",
    server: e.GITHUB_SERVER_URL ?? "https://github.com",
  };
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.repo) || !/^\d+$/.test(env.runId) || !SHA.test(env.headSha))
    throw new Error("GITHUB_REPOSITORY, RUN_ID and HEAD_SHA are required");
  const pull = await findPull(env);
  if (!pull) {
    process.stdout.write(`no open pull request has head ${env.headSha}; nothing to comment\n`);
    return 0;
  }
  let { report, error } = readReport(env.report);
  // The artifact is the PR's own output: it must be about this PR, this commit, this author.
  if (report) {
    if (report.pr !== pull.number) error = "report is about another pull request";
    else if (report.head !== env.headSha) error = "report is about another commit";
    else if (report.author.toLowerCase() !== pull.user.login.toLowerCase())
      error = "report names another author";
    if (error) report = null;
  }
  const runUrl = `${env.server}/${env.repo}/actions/runs/${env.runId}`;
  const ctx: CommentContext = { repo: env.repo, runUrl, conclusion: env.conclusion };
  const arts = (await gh(env, "GET", `/repos/${env.repo}/actions/runs/${env.runId}/artifacts`)) as {
    artifacts: { id: number; name: string }[];
  };
  const art = arts.artifacts.find((a) => a.name === RENDERS_ARTIFACT);
  if (art) ctx.artifactUrl = `${runUrl}/artifacts/${art.id}`;
  process.stdout.write(
    `PR #${pull.number}: ${await upsert(env, pull.number, buildComment(report, ctx, error))}\n`,
  );
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
