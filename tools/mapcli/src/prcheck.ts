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
  changeBoxes,
  checkPlots,
  communityPlots,
  formatDiagnostic,
  isPatchable,
  loadContent,
  loadWorld,
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
import type { Conflict, FileDiff } from "./patch.ts";
import { loadFrames, renderArea } from "./render.ts";

export const REPORT_FORMAT = 1;
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
  /** Why it fails, as stable codes: plots, conflicts, validation, invalid_patch. */
  failures: string[];
  files: FileDiff[];
  conflicts: Conflict[];
  plots: { count: number; violations: PlotViolation[] };
  validation: { errors: number; new_errors: string[] };
  /** Changed files outside world/ (listed for the reviewer; not judged here). */
  other_files: string[];
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

/** GitHub logins of the maintainers: one per line, `#` comments, case-insensitive. */
export function parseMaintainers(text: string | null): string[] {
  if (text === null) return [];
  return text
    .split("\n")
    .map((l) => (l.split("#")[0] ?? "").trim().replace(/^@/, "").toLowerCase())
    .filter((l) => /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(l));
}

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

  // The PR as a map patch (merge-base → head) of the files a patch may carry.
  const files: PatchFile[] = [];
  for (const path of worldFiles.filter(isPatchable)) {
    const b = atRef(root, mergeBase, path);
    const c = atRef(root, head, path);
    if (b === c) continue;
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

    const maintainers = parseMaintainers(atRef(root, base, MAINTAINERS_FILE));
    const author = opts.author?.toLowerCase() ?? null;
    const maintainer =
      author !== null && (maintainers.includes(author) || opts.association === "OWNER");

    // Renders.
    mkdirSync(opts.out, { recursive: true });
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

    const failures: string[] = [];
    if (violations.length > 0 && !maintainer) failures.push("plots");
    if (plan.conflicts.length > 0) failures.push("conflicts");
    if (newErrors.length > 0) failures.push("validation");
    const report: PrReport = {
      format: REPORT_FORMAT,
      pr: opts.pr ?? null,
      author: opts.author ?? null,
      maintainer,
      base,
      head,
      merge_base: mergeBase,
      ok: failures.length === 0,
      failures,
      files: diff,
      conflicts: plan.conflicts,
      plots: { count: plots.length, violations: violations.slice(0, MAX_LISTED) },
      validation: { errors: nowErrors.length, new_errors: newErrors.slice(0, MAX_LISTED) },
      other_files: other.slice(0, MAX_LISTED),
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
