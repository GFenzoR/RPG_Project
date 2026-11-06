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
// reverted. The report has:
//   - the `patch diff` summary of every file (status, tiles, bbox, entries, conflicts);
//   - the community plot check against the plots of base (never of the PR);
//   - new validator errors of the merged map;
//   - before/after PNGs of every changed area (cropped, margin, size and count capped).
// The maintainer list is read from base (`.github/MAINTAINERS`), so a PR cannot add itself;
// the repository owner (author_association OWNER, given by GitHub) always counts as one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  FileChange,
  FloorRect,
  MapPatch,
  PatchFile,
  PlotViolation,
  World,
} from "@rpg/map-format";
import { diffPatch, planPatch, writePlanned } from "./patch.ts";
import type { FileDiff } from "./patch.ts";
import { loadFrames, renderArea } from "./render.ts";

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
 * invalid: a map file of the PR does not pass its schema (fails for maintainers too);
 * rebase: git itself cannot merge the branch; merge_mismatch: git would merge the text
 * into something else than the tile merge measured here (chunk palettes), so rebase.
 */
export const FAILURE_CODES = [
  "plots",
  "conflicts",
  "validation",
  "invalid",
  "rebase",
  "merge_mismatch",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

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
  /** world/ paths that are not plain files (mode ≠ 100644) in the head or the merge
   *  (failure "invalid"): a symlink or an executable bit can hide a change of content. */
  bad_mode_files: string[];
  /** World files git would merge differently from the tile merge (failure "merge_mismatch"). */
  merge_mismatch: string[];
  plots: { count: number; violations: PlotViolation[]; violations_total: number };
  validation: { errors: number; new_errors: string[]; new_errors_total: number };
  /** Changed files outside world/ (listed for the reviewer; not judged here). */
  other_files: string[];
  other_files_total: number;
  areas: PrArea[];
  omitted_areas: number;
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

/** world/ paths of a tree-ish whose mode is not a plain file (100644), from git ls-tree. */
function nonPlainFiles(root: string, treeish: string): string[] {
  return git(root, ["ls-tree", "-r", "-z", "--full-tree", treeish, "--", "world/"])
    .split("\0")
    .filter((l) => l !== "")
    .flatMap((l) => {
      const [meta, path] = l.split("\t");
      return meta !== undefined && path !== undefined && !meta.startsWith("100644 ") ? [path] : [];
    });
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

export function tileFor(a: FloorRect): number {
  const side = Math.max(a.w, a.h);
  return [32, 16, 8, 4].find((t) => side * t <= MAX_IMAGE_SIDE) ?? 4;
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
    other_files: other.slice(0, MAX_LISTED),
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
      merge_mismatch: [],
      plots: { count: 0, violations: [], violations_total: 0 },
      validation: { errors: 0, new_errors: [], new_errors_total: 0 },
      areas: [],
      omitted_areas: 0,
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
    const badModes = [
      ...new Set([
        ...nonPlainFiles(root, head),
        ...(tree === null ? [] : nonPlainFiles(root, tree)),
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

    const errorsOf = (dir: string): string[] =>
      validateWorld(dir)
        .diagnostics.filter((d) => d.severity === "error")
        .map((d) => formatDiagnostic(d));
    const old = new Set(errorsOf(before));
    const nowErrors = errorsOf(after);
    const newErrors = nowErrors.filter((e) => !old.has(e));

    // Renders.
    const { areas, omitted } = renderAreas(changeBoxes(changes), {
      margin: AREA_MARGIN,
      maxSide: MAX_AREA_SIDE,
      maxAreas: MAX_AREAS,
    });
    const sides = [
      { name: "before" as const, dir: before },
      { name: "after" as const, dir: after },
    ].map((s) => {
      const loaded = loadWorld(s.dir);
      return { ...s, world: loaded.world, content: loadContent(s.dir), frames: loadFrames(s.dir) };
    });
    const prAreas: PrArea[] = areas.map((a, i) => {
      const tile = tileFor(a);
      const area: PrArea = {
        ...a,
        island: islandAt((sides[1] ?? sides[0])?.world as World, a),
        tile,
      };
      for (const s of sides) {
        const r = renderArea(s.world, s.content, s.frames, {
          floor: a.z,
          area: { x: a.x, y: a.y, w: a.w, h: a.h },
          tile,
        });
        if (r.png.length > MAX_PNG_BYTES) continue;
        const name = `${s.name}-${i + 1}.png`;
        writeFileSync(join(opts.out, name), r.png);
        area[s.name] = name;
      }
      return area;
    });

    const failures: FailureCode[] = [];
    if (violations.length > 0 && !maintainer) failures.push("plots");
    if (invalid.length + noncanonical.length + badModes.length > 0) failures.push("invalid");
    if (plan.conflicts.length > 0) failures.push("conflicts");
    if (tree === null) failures.push("rebase");
    if (mismatch.length > 0) failures.push("merge_mismatch");
    if (newErrors.length > 0) failures.push("validation");
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
      bad_mode_files: badModes.slice(0, MAX_LISTED),
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
