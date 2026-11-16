// `mapcli pr-check` (T2.4, docs/04-map-editor-and-ai.md "PR de mapas en CI"): what a pull
// request does to the map, computed from two git refs of the same repo.
//
//   base   the target branch's tip (the official map now);
//   head   the PR's last commit.
//
// The PR is turned into a map patch from merge-base(base, head) to head, and merged onto
// base exactly like `mapcli patch apply` would (tile by tile, entry by entry), in a
// throwaway worktree. Everything is measured against that merge result, not against the
// head's files, so changes that landed on base after the PR branched are not shown as
// reverted. The content the map is read with (data/, i18n/, assets/: CONTENT_DIRS) is the
// one in git's merge tree (`landContent`). The report has:
//   - the `patch diff` summary of every file (status, tiles, bbox, entries, conflicts);
//   - the community plot check against the plots of base (never of the PR);
//   - new validator errors of the merged map (with the merged content; for a non-maintainer
//     whose PR changes content, also with the base's content: see `prCheck`);
//   - before/after PNGs of every changed area (cropped, margin, size and count capped).
// The maintainer list is read from base (`.github/MAINTAINERS`), so a PR cannot add itself;
// the repository owner (author_association OWNER, given by GitHub) always counts as one.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  canonicalPatchText,
  changeBoxes,
  checkPlots,
  communityPlots,
  formatDiagnostic,
  isPatchable,
  loadContent,
  loadWorld,
  parseMaintainers,
  patchHash,
  renderAreas,
  validateWorld,
} from "@rpg/map-format";
import type {
  ContentIndex,
  FileChange,
  FloorRect,
  MapPatch,
  PatchFile,
  PlotViolation,
  World,
} from "@rpg/map-format";
import { diffPatch, planPatch, writePlanned } from "./patch.ts";
import type { FileDiff } from "./patch.ts";
import { TILE_SIZES, loadFrames, renderArea, tryLoadFrames } from "./render.ts";

export const REPORT_FORMAT = 2 as const;
export const MAINTAINERS_FILE = ".github/MAINTAINERS";
/** Render limits: areas per PR, tiles per side, margin around the changes, bytes per PNG. */
export const MAX_AREAS = 6;
export const MAX_AREA_SIDE = 64;
export const AREA_MARGIN = 4;
export const MAX_PNG_BYTES = 2 << 20;
/** Image width budget in pixels: the tile size is the largest that keeps the side under it. */
const MAX_IMAGE_SIDE = 1024;
const MAX_LISTED = 50;
/**
 * What the map is read with besides world/: loadContent (data/, i18n/) for the validator
 * and the renders, and the sprite atlas (assets/, data/) for the renders.
 */
export const CONTENT_DIRS = ["data/", "i18n/", "assets/"] as const;
/**
 * Limits of the content a PR brings into the check (failure "limits" when over): paths to
 * write, and their bytes. A vendor pack is thousands of files: it goes in a PR that does not
 * touch world/, which the check does not measure (docs/04).
 */
export const MAX_CONTENT_FILES = 20000;
export const MAX_CONTENT_BYTES = 64 << 20;
const isContent = (p: string): boolean => CONTENT_DIRS.some((d) => p.startsWith(d));

export interface PrArea extends FloorRect {
  island: string;
  /** File names inside the output directory (absent when the PNG was over the limit). */
  before?: string;
  after?: string;
  tile: number;
}

/**
 * Why a file conflicts, as a fixed code: the comment never repeats parser text (a map file
 * of the PR could put Markdown in it). tiles/entries: changed on both sides (see `at`).
 */
export type ConflictCode = "tiles" | "entries" | "changed_both_sides" | "no_base" | "invalid_file";

export interface PrConflict {
  path: string;
  code: ConflictCode;
  /** Tiles "x,y,z" or entry IDs (first 100). */
  at?: string[];
}

/**
 * Failure codes. plots: outside the community plots and not a maintainer; conflicts: the
 * tile/entry merge conflicts with the current base; validation: new validator errors;
 * invalid: a map file of the PR does not pass its schema, a path of world/ or of the
 * content it changes is not a plain file, or a content path of the merge cannot be written
 * as the merge has it (fails for maintainers too); rebase: git itself cannot merge
 * the branch; merge_mismatch: git would merge the text into something else than the tile
 * merge measured here (chunk palettes), so rebase; limits: the PR's content is over
 * MAX_CONTENT_FILES / MAX_CONTENT_BYTES, so it was not measured (see `notes`).
 */
export const FAILURE_CODES = [
  "plots",
  "conflicts",
  "validation",
  "invalid",
  "rebase",
  "merge_mismatch",
  "limits",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * How the content was measured, as fixed codes (the comment has a text for each).
 * base_content: a non-maintainer's PR changes content, so its map is also validated with
 * the base's content and drawn with it; content_too_large: over the limits, the "after"
 * keeps the base's content; content_skipped: a content path of the merge could not be
 * written as the merge has it (see skipped_content); atlas_fallback: the merge's sprites did not
 * build, so the "after" pictures use the base's.
 */
export const NOTE_CODES = [
  "base_content",
  "content_too_large",
  "content_skipped",
  "atlas_fallback",
] as const;
export type NoteCode = (typeof NOTE_CODES)[number];

export interface PrReport {
  format: typeof REPORT_FORMAT;
  pr: number | null;
  author: string | null;
  maintainer: boolean;
  base: string;
  head: string;
  merge_base: string;
  /** Whether the check passes (what the job's exit code says). */
  ok: boolean;
  /** Why it fails (FAILURE_CODES). */
  failures: FailureCode[];
  /** Whether the branch changes anything under world/ (false: nothing else is computed). */
  map_changes: boolean;
  files: FileDiff[];
  conflicts: PrConflict[];
  /** Map files of the PR that do not pass their schema (failure "invalid"). */
  invalid_files: string[];
  /** Map files of the PR whose text is not their canonical form (failure "invalid"). */
  noncanonical_files: string[];
  /** world/ and content paths the PR or its merge change that are not plain files
   *  (mode ≠ 100644; failure "invalid"): a symlink or an executable bit can hide a change of
   *  content. As `reportPath` shows them. */
  bad_mode_files: string[];
  /** Content paths of the merge that could not be written as it has them (failure
   *  "invalid"): an unsafe name (`insidePath`), a gitlink or a tree under a file's mode, a
   *  file in the way of a folder. As `reportPath` shows them. */
  skipped_content: string[];
  skipped_content_total: number;
  /** World files git would merge differently from the tile merge (failure "merge_mismatch"). */
  merge_mismatch: string[];
  plots: { count: number; violations: PlotViolation[]; violations_total: number };
  /** Errors of the merged map (with the content it lands and, for a non-maintainer whose PR
   *  changes data/ or i18n/, also with the base's), and those base does not have. */
  validation: { errors: number; new_errors: string[]; new_errors_total: number };
  /** Changed files outside world/ (listed for the reviewer; not judged here). */
  other_files: string[];
  other_files_total: number;
  areas: PrArea[];
  omitted_areas: number;
  /** How the content was measured (NOTE_CODES). */
  notes: NoteCode[];
}

export interface PrCheckOptions {
  root: string;
  base: string;
  head: string;
  out: string;
  author?: string;
  /** GitHub's author_association of the PR author (from the event, not the PR): OWNER is
   *  always a maintainer, so the repo owner is one even before .github/MAINTAINERS exists. */
  association?: string;
  /** "owner/name" of the repo the PR comes from and of the base repo. When both are given
   *  and differ, the author is a maintainer only if they own the head repo: otherwise
   *  someone else can push to the branch (S3). */
  headRepo?: string;
  repo?: string;
  pr?: number;
  /** Size limit of each PNG (MAX_PNG_BYTES; tests lower it). */
  maxPngBytes?: number;
  /** Content limits (MAX_CONTENT_FILES / MAX_CONTENT_BYTES; tests lower them). */
  contentLimits?: ContentLimits;
}

const SHA = /^[0-9a-f]{40}$/;
const REF = /^(?!-)[A-Za-z0-9._/@~^-]{1,200}$/;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 << 20,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function resolveRef(root: string, ref: string): string {
  if (!REF.test(ref)) throw new RangeError(`not a git ref: ${JSON.stringify(ref)}`);
  const sha = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  if (!SHA.test(sha)) throw new RangeError(`cannot resolve ${ref}`);
  return sha;
}

function atRef(root: string, ref: string, path: string): string | null {
  try {
    return git(root, ["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/** Raw bytes of `path` at `ref` (null: missing). Map files are judged on bytes (F1). */
function bytesAt(root: string, ref: string, path: string): Buffer | null {
  try {
    return execFileSync("git", ["cat-file", "blob", `${ref}:${path}`], {
      cwd: root,
      maxBuffer: 256 << 20,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Text of the bytes, or undefined when they are not valid UTF-8 (lossy decoding hides it). */
export function decodeStrict(b: Buffer): string | undefined {
  try {
    return strictUtf8.decode(b);
  } catch {
    return undefined;
  }
}

const sameBytes = (a: Buffer | null, b: Buffer | null): boolean =>
  a === null || b === null ? a === b : a.equals(b);

export interface ContentLimits {
  /** Content paths to write (removals do not count: they cost nothing). */
  files: number;
  /** Bytes to write, counted per path (two paths of one blob are written twice). */
  bytes: number;
}

/** A path as the `to` side of a diff has it. mode "000000": absent there. */
export interface ContentEntry {
  path: string;
  mode: string;
  oid: string;
}

/**
 * Content paths (CONTENT_DIRS) that differ from `from` to `to`, two tree-ishes, with the
 * `to` side (`git diff-tree -r --no-renames`: a file moved on one side is a removal and an
 * addition, so writing these over a checkout of `from` reproduces `to` exactly).
 */
export function contentChanges(root: string, from: string, to: string): ContentEntry[] {
  return treeChanges(root, from, to, CONTENT_DIRS);
}

/** Paths under `dirs` that differ from `from` to `to`, with the `to` side. */
function treeChanges(
  root: string,
  from: string,
  to: string,
  dirs: readonly string[],
): ContentEntry[] {
  const fields = git(root, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    from,
    to,
    "--",
    ...dirs,
  ]).split("\0");
  const out: ContentEntry[] = [];
  // Each record is ":<mode> <mode> <oid> <oid> <status>" NUL "<path>" NUL.
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = /^:\d{6} (\d{6}) [0-9a-f]{40,64} ([0-9a-f]{40,64}) [A-Z]$/.exec(fields[i] ?? "");
    const path = fields[i + 1];
    if (meta?.[1] === undefined || meta[2] === undefined || path === undefined) continue;
    out.push({ path, mode: meta[1], oid: meta[2] });
  }
  return out;
}

/** Modes of a blob: a file, an executable or a symlink (whose blob is its target text). */
const BLOB_MODES = new Set(["100644", "100755", "120000"]);
const ABSENT = "000000";

/** Type and size of objects (`git cat-file --batch-check`); a missing one is left out. */
function objectInfo(root: string, oids: string[]): Map<string, { type: string; size: number }> {
  const out = new Map<string, { type: string; size: number }>();
  if (oids.length === 0) return out;
  const lines = execFileSync("git", ["cat-file", "--batch-check"], {
    cwd: root,
    input: oids.map((o) => `${o}\n`).join(""),
    encoding: "utf8",
    maxBuffer: 64 << 20,
    stdio: ["pipe", "pipe", "pipe"],
  }).split("\n");
  for (const l of lines) {
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(l);
    if (m?.[1] !== undefined && m[2] !== undefined)
      out.set(m[1], { type: m[2], size: Number(m[3]) });
  }
  return out;
}

/** Contents of blobs in one `git cat-file --batch`, as views into its output. */
function blobContents(root: string, oids: string[], bytes: number): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (oids.length === 0) return out;
  const raw = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: oids.map((o) => `${o}\n`).join(""),
    maxBuffer: bytes + oids.length * 160 + (1 << 20), // the contents plus a header each
    stdio: ["pipe", "pipe", "pipe"],
  });
  let at = 0;
  while (at < raw.length) {
    const eol = raw.indexOf(0x0a, at);
    if (eol < 0) break;
    const header = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(raw.toString("latin1", at, eol));
    at = eol + 1;
    if (header?.[1] === undefined) continue; // "<oid> missing"
    const size = Number(header[3]);
    if (header[2] === "blob") out.set(header[1], raw.subarray(at, at + size));
    at += size + 1; // the contents end with a newline
  }
  return out;
}

/**
 * Where a path of the PR goes inside `dir`, or null when it is not safe to write: `..`,
 * `.`, empty segments, `.git` in any case, `\`, `:`, NUL or a line break anywhere.
 */
export function insidePath(dir: string, p: string): string | null {
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || /^\.git$/i.test(s))) return null;
  if (/[\\:\0\n\r]/.test(p)) return null;
  const abs = resolve(dir, p);
  return abs.startsWith(resolve(dir) + sep) ? abs : null;
}

/** lstat, or null when nothing is there (or a parent is not a directory). */
function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * Whether the directory of `abs` is really inside `top`: its nearest existing ancestor,
 * symlinks resolved (checked before creating anything under it, and again after).
 */
function realInside(top: string, abs: string): boolean {
  let d = dirname(abs);
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  try {
    const real = realpathSync(d);
    return real === top || real.startsWith(top + sep);
  } catch {
    return false;
  }
}

export interface LandResult {
  /** Content paths written or removed. */
  changed: number;
  /** Over the limits: nothing was written. */
  tooLarge: boolean;
  /** Paths left out: unsafe (`insidePath`), not a blob (a gitlink, or a tree under a
   *  file's mode), or in the way of a directory that still has files. */
  skipped: string[];
}

/**
 * Makes the content of `dir`, a checkout of `from`, the content of `to` (see
 * contentChanges). Every file is written as plain bytes: a symlink becomes a file holding
 * its target, never a link. Only a path absent from `to` is removed, and never a
 * directory: a path can be a file on one side and a directory on the other.
 */
export function landContent(
  root: string,
  dir: string,
  from: string,
  to: string,
  limits: ContentLimits = { files: MAX_CONTENT_FILES, bytes: MAX_CONTENT_BYTES },
): LandResult {
  const tooLarge: LandResult = { changed: 0, tooLarge: true, skipped: [] };
  const entries = contentChanges(root, from, to);
  const writes = entries.filter((e) => e.mode !== ABSENT);
  if (writes.length > limits.files) return tooLarge;
  const info = objectInfo(root, [
    ...new Set(writes.filter((e) => BLOB_MODES.has(e.mode)).map((e) => e.oid)),
  ]);
  const isBlob = (e: ContentEntry): boolean =>
    BLOB_MODES.has(e.mode) && info.get(e.oid)?.type === "blob";
  // Per path, not per blob: a thousand paths of one big blob are a thousand files on disk.
  const bytes = writes.reduce((n, e) => n + (isBlob(e) ? (info.get(e.oid)?.size ?? 0) : 0), 0);
  if (bytes > limits.bytes) return tooLarge;
  const data = blobContents(root, [...new Set(writes.filter(isBlob).map((e) => e.oid))], bytes);
  const dirAbs = resolve(dir);
  const top = realpathSync(dir);
  const skipped: string[] = [];
  const targets = entries.flatMap((e) => {
    const abs = insidePath(dir, e.path);
    if (abs !== null) return [{ ...e, abs }];
    skipped.push(e.path);
    return [];
  });
  let changed = 0;
  // Removals first: what `to` turned into a directory must be gone before writing into it.
  const emptied = new Set<string>();
  for (const t of targets) {
    if (t.mode !== ABSENT) continue;
    const st = lstatOrNull(t.abs);
    if (st === null || st.isDirectory()) continue;
    if (!realInside(top, t.abs)) {
      skipped.push(t.path);
      continue;
    }
    rmSync(t.abs, { force: true });
    changed++;
    for (let d = dirname(t.abs); d.startsWith(dirAbs + sep); d = dirname(d)) emptied.add(d);
  }
  // Folders left empty go too, deepest first, as a checkout of `to` has none: a folder of
  // base that `to` turns into a file is then out of the way.
  for (const d of [...emptied].sort((a, b) => b.length - a.length))
    try {
      const real = realpathSync(d);
      if (real.startsWith(top + sep) && readdirSync(d).length === 0) rmdirSync(d);
    } catch {
      // Gone already, or not a folder we may touch: left as it is.
    }
  for (const t of targets) {
    if (t.mode === ABSENT) continue;
    const blob = BLOB_MODES.has(t.mode) ? data.get(t.oid) : undefined;
    if (blob === undefined) {
      skipped.push(t.path);
      continue;
    }
    try {
      if (!realInside(top, t.abs)) {
        skipped.push(t.path);
        continue;
      }
      mkdirSync(dirname(t.abs), { recursive: true });
      if (!realInside(top, t.abs)) {
        skipped.push(t.path);
        continue;
      }
      const st = lstatOrNull(t.abs);
      if (st?.isDirectory())
        rmdirSync(t.abs); // emptied by the removals, or it throws
      else if (st?.isSymbolicLink()) rmSync(t.abs);
      writeFileSync(t.abs, blob);
      changed++;
    } catch (e) {
      // Only the shapes git trees can disagree on (a file of base in the way of a folder of
      // `to`, a folder that still has files); a full disk or the like is not a skip.
      if (!PATH_SHAPE_ERRORS.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      skipped.push(t.path);
    }
  }
  return { changed, tooLarge: false, skipped: skipped.sort() };
}

const PATH_SHAPE_ERRORS = new Set(["ENOTEMPTY", "ENOTDIR", "EEXIST", "EISDIR"]);

/**
 * A path as the report shows it: characters outside [A-Za-z0-9_.-/] become "?", and so
 * does a dot before another dot (the comment refuses a report with "..": one odd name must
 * not void the whole comment), at most 200 of them.
 */
export function reportPath(p: string): string {
  return p
    .replace(/[^A-Za-z0-9_./-]/g, "?")
    .replace(/\.(?=\.)/g, "?")
    .slice(0, 200);
}

/** GitHub logins of the maintainers (shared with the map PR worker: map-format). */
export { parseMaintainers };

const readOrNull = (root: string, path: string): string | null =>
  existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;

/** Island whose rect contains the area's centre (renderArea draws every island anyway). */
function islandAt(world: World, a: FloorRect): string {
  const cx = a.x + Math.floor(a.w / 2);
  const cy = a.y + Math.floor(a.h / 2);
  for (const [id, isl] of world.islands) {
    const r = isl.meta.rect;
    if (cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h) return id;
  }
  return "";
}

function conflictCode(c: { reason: string; at?: string[] }): ConflictCode {
  if (c.at !== undefined) return c.reason.startsWith("tiles") ? "tiles" : "entries";
  if (c.reason === "the file changed on both sides") return "changed_both_sides";
  if (c.reason === "the base is not available to merge") return "no_base";
  return "invalid_file";
}

/**
 * world/ and content paths that differ from `from` to `to` and are not a plain file (100644)
 * in `to`. Only those: an odd file already on base is not the PR's doing.
 */
function nonPlainChanges(root: string, from: string, to: string): string[] {
  return treeChanges(root, from, to, ["world/", ...CONTENT_DIRS])
    .filter((e) => e.mode !== "100644" && e.mode !== ABSENT)
    .map((e) => e.path);
}

/** Tree of the merge git would make (null: git reports a textual conflict). */
function gitMergeTree(root: string, base: string, head: string): string | null {
  try {
    const tree = git(root, ["merge-tree", "--write-tree", "--no-messages", base, head])
      .split("\n")[0]
      ?.trim();
    return tree !== undefined && /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
  } catch {
    return null; // exit code 1: conflicts
  }
}

/** The smallest tile of the renders (TILE_SIZES goes up from it). */
const MIN_TILE = TILE_SIZES[0];

export function tileFor(a: FloorRect): number {
  const side = Math.max(a.w, a.h);
  return [...TILE_SIZES].reverse().find((t) => side * t <= MAX_IMAGE_SIDE) ?? MIN_TILE;
}

export function prCheck(opts: PrCheckOptions): PrReport {
  const { root } = opts;
  const base = resolveRef(root, opts.base);
  const head = resolveRef(root, opts.head);
  const mergeBase = git(root, ["merge-base", base, head]).trim();
  const changed = git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase, head])
    .split("\0")
    .filter((p) => p !== "");
  const worldFiles = changed.filter((p) => p.startsWith("world/"));
  const other = changed.filter((p) => !p.startsWith("world/"));

  const author = opts.author?.toLowerCase() ?? null;
  const maintainers = parseMaintainers(atRef(root, base, MAINTAINERS_FILE));
  const sameRepo =
    opts.headRepo === undefined || opts.repo === undefined || opts.headRepo === opts.repo;
  const ownsHead =
    sameRepo || (author !== null && opts.headRepo?.split("/")[0]?.toLowerCase() === author);
  const maintainer =
    author !== null && ownsHead && (maintainers.includes(author) || opts.association === "OWNER");
  const empty = {
    format: REPORT_FORMAT,
    pr: opts.pr ?? null,
    author: opts.author ?? null,
    maintainer,
    base,
    head,
    merge_base: mergeBase,
    other_files: other.slice(0, MAX_LISTED).map(reportPath),
    other_files_total: other.length,
  };
  mkdirSync(opts.out, { recursive: true });
  if (worldFiles.length === 0) {
    // Nothing of the map changes: cheap exit, no worktrees, no renders.
    const report: PrReport = {
      ...empty,
      ok: true,
      failures: [],
      map_changes: false,
      files: [],
      conflicts: [],
      invalid_files: [],
      noncanonical_files: [],
      bad_mode_files: [],
      skipped_content: [],
      skipped_content_total: 0,
      merge_mismatch: [],
      plots: { count: 0, violations: [], violations_total: 0 },
      validation: { errors: 0, new_errors: [], new_errors_total: 0 },
      areas: [],
      omitted_areas: 0,
      notes: [],
    };
    writeFileSync(join(opts.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  // The PR as a map patch (merge-base → head) of the files a patch may carry. A file that
  // does not pass its schema is left out of the merge and fails the check by itself (S4).
  const files: PatchFile[] = [];
  const invalid: string[] = [];
  const noncanonical: string[] = [];
  for (const path of worldFiles.filter(isPatchable)) {
    const b = atRef(root, mergeBase, path);
    const raw = bytesAt(root, head, path);
    if (sameBytes(bytesAt(root, mergeBase, path), raw)) continue;
    // Not UTF-8 (a 0xFF byte): the Go server's yaml.v3 refuses it (F1).
    const c = raw === null ? null : decodeStrict(raw);
    if (c === undefined) {
      invalid.push(path);
      continue;
    }
    let canonical: string | null;
    try {
      canonical = canonicalPatchText(path, c);
    } catch {
      invalid.push(path);
      continue;
    }
    // Byte for byte (R2, F1): `x: 03207` is 3207 here but 1671 (octal) for the Go server's
    // yaml.v3. Only the canonical text means the same to every reader.
    if (!sameBytes(canonical === null ? null : Buffer.from(canonical, "utf8"), raw)) {
      noncanonical.push(path);
      continue;
    }
    files.push(
      b === null
        ? { path, base: null, content: c }
        : { path, base: patchHash(b), base_text: b, content: c },
    );
  }
  const patch: MapPatch = { format: 2, kind: "rpg-map-patch", base_ref: mergeBase, files };

  const tmp = mkdtempSync(join(tmpdir(), "mapcli-pr-"));
  const before = join(tmp, "before");
  const after = join(tmp, "after");
  try {
    git(root, ["worktree", "add", "--detach", "--quiet", before, base]);
    git(root, ["worktree", "add", "--detach", "--quiet", after, base]);
    const diff = diffPatch(before, patch);
    const plan = planPatch(after, patch);
    writePlanned(after, plan.files);

    // GitHub merges text, not tiles: the merge it would make must be the one measured here
    // (B3). A chunk's palette can change on one side and a tile row on the other, and git
    // then merges them cleanly into different items.
    const tree = gitMergeTree(root, base, head);

    // The content the merge lands (items, texts, sprites the PR adds or changes). `after` is
    // a checkout of base, so writing what differs from base to git's merge tree makes its
    // content exactly the merge's, files base moved or turned into directories included.
    // When git cannot merge (that fails with `rebase`), the PR's own changes, as the head
    // has them. Without it a PR that adds an item and places it fails with "unknown item".
    // `before` keeps the base's own content.
    const notes: NoteCode[] = [];
    const limits = opts.contentLimits ?? { files: MAX_CONTENT_FILES, bytes: MAX_CONTENT_BYTES };
    const landed =
      tree === null
        ? landContent(root, after, mergeBase, head, limits)
        : landContent(root, after, base, tree, limits);
    if (landed.tooLarge) notes.push("content_too_large");
    if (landed.skipped.length > 0) notes.push("content_skipped");
    const badModes = [
      ...new Set([
        ...nonPlainChanges(root, mergeBase, head),
        ...(tree === null ? [] : nonPlainChanges(root, base, tree)),
      ]),
    ].sort();
    const conflicted = new Set(plan.conflicts.map((c) => c.path));
    const mismatch: string[] = [];
    if (tree !== null)
      for (const f of files) {
        if (conflicted.has(f.path)) continue;
        // The raw blob, not canonicalized: what git writes is what the server reads.
        const ours = existsSync(join(after, f.path)) ? readFileSync(join(after, f.path)) : null;
        if (!sameBytes(bytesAt(root, tree, f.path), ours)) mismatch.push(f.path);
      }

    // Files changed under world/ that a patch cannot carry still count for the plot check.
    const changes: FileChange[] = [
      ...files.map((f) => ({
        path: f.path,
        before: readOrNull(before, f.path),
        after: readOrNull(after, f.path),
      })),
      ...worldFiles
        .filter((p) => !isPatchable(p))
        .map((path) => ({
          path,
          before: atRef(root, mergeBase, path),
          after: atRef(root, head, path),
        })),
    ];
    const plots = communityPlots(loadWorld(before).world);
    const violations = checkPlots(plots, changes);

    const errorsOf = (dir: string, content?: ContentIndex): string[] =>
      validateWorld(dir, content === undefined ? {} : { content })
        .diagnostics.filter((d) => d.severity === "error")
        .map((d) => formatDiagnostic(d));
    // Both sides are whole trees with their own content: base as it is, and the merge with
    // the content it lands. Comparing them shows what the PR breaks, content changes too
    // (an item it deletes that the map uses).
    const baseContent = loadContent(before);
    const old = new Set(errorsOf(before, baseContent));
    const merged = errorsOf(after);
    // Content (data/, i18n/, assets/) needs a maintainer: a community PR's map must also
    // stand on the base's content, so it cannot pass by bringing the items or texts it uses.
    // Same content as `before`, so this comparison is like for like. A union: no error of
    // either is lost.
    const communityContent = !maintainer && other.some(isContent);
    if (communityContent) notes.unshift("base_content");
    const onBase = communityContent ? errorsOf(after, baseContent) : [];
    const nowErrors = [...new Set([...merged, ...onBase])];
    const newErrors = nowErrors.filter((e) => !old.has(e));

    // Renders.
    const { areas, omitted } = renderAreas(changeBoxes(changes), {
      margin: AREA_MARGIN,
      maxSide: MAX_AREA_SIDE,
      maxAreas: MAX_AREAS,
    });
    const maxPng = opts.maxPngBytes ?? MAX_PNG_BYTES;
    // A community PR's "after" is drawn with the base's content and sprites too, like its map
    // is measured; so is any "after" when nothing of the content changed.
    const baseFrames = loadFrames(before);
    let afterContent = baseContent;
    let afterFrames = baseFrames;
    if (!communityContent && landed.changed > 0) {
      afterContent = loadContent(after);
      const merged = tryLoadFrames(after);
      // The merge's sprites do not build (an error in assets/): the base's, not all missing.
      if (merged === undefined) notes.push("atlas_fallback");
      else afterFrames = merged;
    }
    const sides = [
      { name: "before" as const, dir: before, content: baseContent, frames: baseFrames },
      { name: "after" as const, dir: after, content: afterContent, frames: afterFrames },
    ].map((s) => ({ ...s, world: loadWorld(s.dir).world }));
    const prAreas: PrArea[] = areas.map((a, i) => {
      const draw = (tile: number): Buffer[] =>
        sides.map(
          (s) =>
            renderArea(s.world, s.content, s.frames, {
              floor: a.z,
              area: { x: a.x, y: a.y, w: a.w, h: a.h },
              tile,
            }).png,
        );
      // Detailed art can make a PNG go over the limit: halve the tile until both sides fit
      // (one tile for both, so they compare), down to the smallest with whatever fits.
      let tile = tileFor(a);
      let pngs = draw(tile);
      while (tile > MIN_TILE && pngs.some((p) => p.length > maxPng)) {
        tile /= 2;
        pngs = draw(tile);
      }
      const area: PrArea = {
        ...a,
        island: islandAt((sides[1] ?? sides[0])?.world as World, a),
        tile,
      };
      sides.forEach((s, k) => {
        const png = pngs[k];
        if (png === undefined || png.length > maxPng) return;
        const name = `${s.name}-${i + 1}.png`;
        writeFileSync(join(opts.out, name), png);
        area[s.name] = name;
      });
      return area;
    });

    const failures: FailureCode[] = [];
    if (violations.length > 0 && !maintainer) failures.push("plots");
    // A content path that could not land as the merge has it (an unsafe name, a gitlink):
    // the "after" is not the merge, so nothing measured on it can pass.
    if (invalid.length + noncanonical.length + badModes.length + landed.skipped.length > 0)
      failures.push("invalid");
    if (plan.conflicts.length > 0) failures.push("conflicts");
    if (tree === null) failures.push("rebase");
    if (mismatch.length > 0) failures.push("merge_mismatch");
    if (newErrors.length > 0) failures.push("validation");
    if (landed.tooLarge) failures.push("limits");
    const report: PrReport = {
      ...empty,
      ok: failures.length === 0,
      failures,
      map_changes: true,
      files: diff,
      conflicts: plan.conflicts.map((c) => ({
        path: c.path,
        code: conflictCode(c),
        ...(c.at === undefined ? {} : { at: c.at }),
      })),
      invalid_files: invalid.slice(0, MAX_LISTED),
      noncanonical_files: noncanonical.slice(0, MAX_LISTED),
      bad_mode_files: badModes.slice(0, MAX_LISTED).map(reportPath),
      skipped_content: landed.skipped.slice(0, MAX_LISTED).map(reportPath),
      skipped_content_total: landed.skipped.length,
      merge_mismatch: mismatch.slice(0, MAX_LISTED),
      plots: {
        count: plots.length,
        violations: violations.slice(0, MAX_LISTED),
        violations_total: violations.length,
      },
      validation: {
        errors: nowErrors.length,
        new_errors: newErrors.slice(0, MAX_LISTED),
        new_errors_total: newErrors.length,
      },
      areas: prAreas,
      omitted_areas: omitted,
      notes,
    };
    writeFileSync(join(opts.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    for (const dir of [before, after])
      try {
        git(root, ["worktree", "remove", "--force", dir]);
      } catch {
        // Not created (or already gone); the prune below cleans the bookkeeping.
      }
    rmSync(tmp, { recursive: true, force: true });
    git(root, ["worktree", "prune"]);
  }
}
