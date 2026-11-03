// Map patches on disk (docs/04-map-editor-and-ai.md, "Map patches"). The format, its checks,
// the merge and the diff live in @rpg/map-format (shared with the editor); this file adds
// what needs git and the file system:
//   - createPatch: the map files of world/ that differ from a git ref (format 2, with the
//     base text of each file so it can be merged later);
//   - planPatch: three-way merge of every file against what is on disk now (tile by tile,
//     entry by entry); conflicts are listed with their tile or entry;
//   - writePlanned: writes the merged files, all or nothing, only inside world/.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  PATCH_FORMAT,
  PATCH_KIND,
  PatchError,
  describeConflict,
  isPatchable,
  mergePatchFile,
  parsePatch,
  patchHash,
  summarizeFileChange,
} from "@rpg/map-format";
import type { FileSummary, MapPatch, MergeConflict, PatchFile } from "@rpg/map-format";

export { isPatchable, parsePatch, patchHash as hash };
export type { MapPatch, PatchFile };

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 << 20,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function readOrNull(root: string, path: string): string | null {
  const abs = join(root, path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** Text of `path` at git `ref`, or null when it does not exist there. */
function atRef(root: string, ref: string, path: string): string | null {
  try {
    return git(root, ["show", `${ref}:${path}`]);
  } catch {
    return null;
  }
}

/** Patch with every patchable file under world/ that differs from `ref` (default HEAD). */
export function createPatch(root: string, ref = "HEAD", island?: string): MapPatch {
  const scope = island === undefined ? "world" : `world/islands/${island}`;
  const changed = new Set(
    [
      ...git(root, ["diff", "--name-only", "--no-renames", ref, "--", scope]).split("\n"),
      ...git(root, ["ls-files", "--others", "--exclude-standard", "--", scope]).split("\n"),
    ].filter((p) => p !== "" && isPatchable(p)),
  );
  const files: PatchFile[] = [];
  for (const path of [...changed].sort()) {
    const baseText = atRef(root, ref, path);
    const content = readOrNull(root, path);
    if (baseText === content) continue;
    files.push(
      baseText === null
        ? { path, base: null, content }
        : { path, base: patchHash(baseText), base_text: baseText, content },
    );
  }
  return { format: PATCH_FORMAT, kind: PATCH_KIND, base_ref: ref, files };
}

/**
 * Base text of a patch file: `base_text` (format 2), null when the patch creates it, or
 * for format 1 the version at `base_ref` or on disk whose hash matches. Undefined when it
 * cannot be found (then only a trivial merge is possible).
 */
function baseOf(root: string, patch: MapPatch, f: PatchFile): string | null | undefined {
  if (f.base === null) return null;
  if (f.base_text !== undefined) return f.base_text;
  const cur = readOrNull(root, f.path);
  if (cur !== null && patchHash(cur) === f.base) return cur;
  const old = atRef(root, patch.base_ref, f.path);
  return old !== null && patchHash(old) === f.base ? old : undefined;
}

export interface Conflict {
  path: string;
  reason: string;
  /** Tiles ("x,y,z") or entry IDs changed differently on both sides (first 100). */
  at?: string[];
}

export interface PlannedFile {
  path: string;
  /** Text to write, or null to remove the file. */
  text: string | null;
  /** Whether it was merged with changes made after the patch (not a plain copy). */
  merged: boolean;
}

function conflictOf(path: string, list: MergeConflict[]): Conflict {
  const file = list.find((c) => c.kind === "file");
  if (file) return { path, reason: describeConflict(file) };
  const tiles = list[0]?.kind === "tile";
  return {
    path,
    reason: tiles ? "tiles changed on both sides" : "entries changed on both sides",
    at: list.slice(0, 100).map((c) => describeConflict(c).replace(/^(tile|entry) /, "")),
  };
}

/** What applying the patch writes, merged with the current files, and where it conflicts. */
export function planPatch(
  root: string,
  patch: MapPatch,
): { files: PlannedFile[]; conflicts: Conflict[] } {
  const files: PlannedFile[] = [];
  const conflicts: Conflict[] = [];
  for (const f of patch.files) {
    const cur = readOrNull(root, f.path);
    const base = baseOf(root, patch, f);
    const m = mergePatchFile(f.path, base, cur, f.content);
    if (m.conflicts.length > 0) conflicts.push(conflictOf(f.path, m.conflicts));
    if (m.text !== cur)
      files.push({ path: f.path, text: m.text, merged: base !== cur && cur !== f.content });
  }
  return { files, conflicts };
}

/**
 * Absolute path of a file to write, checked to stay inside world/ even through symlinks:
 * the deepest existing directory must resolve inside world/ and the file must not be a link.
 */
function safeTarget(root: string, path: string): string {
  if (!isPatchable(path)) throw new PatchError(`${path} is not a map file of world/`);
  const top = realpathSync(resolve(root, "world")) + sep;
  const abs = resolve(root, path);
  if (!abs.startsWith(resolve(root, "world") + sep))
    throw new PatchError(`${path} resolves outside world/`);
  let dir = dirname(abs);
  while (!existsSync(dir)) dir = dirname(dir);
  if (!(realpathSync(dir) + sep).startsWith(top))
    throw new PatchError(`${path} resolves outside world/ (symlink)`);
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink())
    throw new PatchError(`${path} is a symlink`);
  return abs;
}

/** Writes the planned files (all or none of the writes; removals after). */
export function writePlanned(
  root: string,
  files: PlannedFile[],
): { written: string[]; removed: string[] } {
  const targets = files.map((f) => ({ ...f, abs: safeTarget(root, f.path) }));
  const staged: [string, string][] = [];
  try {
    for (const f of targets) {
      if (f.text === null) continue;
      mkdirSync(dirname(f.abs), { recursive: true });
      const tmp = `${f.abs}.tmp-${process.pid}`;
      writeFileSync(tmp, f.text);
      staged.push([tmp, f.abs]);
    }
  } catch (e) {
    for (const [tmp] of staged) rmSync(tmp, { force: true });
    throw e;
  }
  for (const [tmp, abs] of staged) renameSync(tmp, abs);
  const removed: string[] = [];
  for (const f of targets)
    if (f.text === null) {
      rmSync(f.abs, { force: true });
      removed.push(f.path);
    }
  return { written: files.filter((f) => f.text !== null).map((f) => f.path), removed };
}

export interface FileDiff extends FileSummary {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  /** Whether the current file is the patch's base (false: applying needs a merge). */
  base_matches: boolean;
  /** Tiles/entries that would conflict when merging (only when base_matches is false). */
  conflicts?: number;
}

/** What applying the patch would change in the current files. */
export function diffPatch(root: string, patch: MapPatch): FileDiff[] {
  return patch.files.map((f) => {
    const cur = readOrNull(root, f.path);
    const base_matches =
      cur === f.content ||
      (f.base === null ? cur === null : cur !== null && patchHash(cur) === f.base);
    const status: FileDiff["status"] =
      cur === f.content
        ? "unchanged"
        : cur === null
          ? "added"
          : f.content === null
            ? "removed"
            : "modified";
    const d: FileDiff = { path: f.path, status, base_matches };
    if (!base_matches)
      d.conflicts = mergePatchFile(f.path, baseOf(root, patch, f), cur, f.content).conflicts.length;
    return { ...d, ...summarizeFileChange(f.path, cur, f.content) };
  });
}
