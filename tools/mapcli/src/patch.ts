// Map patches (.rpgpatch.json, docs/03-world-and-maps.md "Contribuciones"): the files of
// world/ that changed against a git ref, each with the hash of its base version and its
// new content. Minimal version (T1.15): `create` from the working tree, `apply` only when
// every base still matches (otherwise nothing is applied and the conflicts are listed),
// `diff` to summarise a patch against the current files. A tile-level merge of conflicting
// chunks is pending.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { CHUNK_SIZE, parseChunk, parseYamlText } from "@rpg/map-format";

export const PATCH_FORMAT = 1;

export interface PatchFile {
  /** Path relative to the repo root, under world/. */
  path: string;
  /** sha256 of the base version, or null when the patch creates the file. */
  base: string | null;
  /** New content, or null when the patch removes the file. */
  content: string | null;
}

export interface MapPatch {
  format: 1;
  kind: "rpg-map-patch";
  /** Git ref the patch was made against. */
  base_ref: string;
  files: PatchFile[];
}

/** Files a patch may touch: maps and prefabs, never data/ or anything outside world/. */
const PATCHABLE =
  /^world\/(world\.yaml|islands\/[a-z][a-z0-9_]*\/([a-z]+\.yaml|chunks\/z\d{2}\/c\d{4}_\d{4}\.json)|prefabs\/[a-z][a-z0-9_]*\.yaml)$/;

export const isPatchable = (path: string): boolean => PATCHABLE.test(path);

export const hash = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });
}

function readOrNull(root: string, path: string): string | null {
  const abs = join(root, path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
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
    let baseText: string | null;
    try {
      baseText = git(root, ["show", `${ref}:${path}`]);
    } catch {
      baseText = null; // new file
    }
    const content = readOrNull(root, path);
    if (baseText === content) continue;
    files.push({ path, base: baseText === null ? null : hash(baseText), content });
  }
  return { format: PATCH_FORMAT, kind: "rpg-map-patch", base_ref: ref, files };
}

/** Throws RangeError when the patch is malformed or names a file it may not touch. */
export function parsePatch(text: string): MapPatch {
  let p: unknown;
  try {
    p = JSON.parse(text);
  } catch (e) {
    throw new RangeError(`patch is not JSON: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  const o = p as Partial<MapPatch>;
  if (o?.kind !== "rpg-map-patch" || o.format !== PATCH_FORMAT || !Array.isArray(o.files))
    throw new RangeError(`not an rpg-map-patch of format ${PATCH_FORMAT}`);
  const seen = new Set<string>();
  for (const f of o.files) {
    if (typeof f?.path !== "string" || !isPatchable(f.path))
      throw new RangeError(
        `patch touches ${JSON.stringify(f?.path)}, outside the map files of world/`,
      );
    if (seen.has(f.path)) throw new RangeError(`patch lists ${f.path} twice`);
    seen.add(f.path);
    if (f.base !== null && (typeof f.base !== "string" || !/^sha256:[0-9a-f]{64}$/.test(f.base)))
      throw new RangeError(`${f.path}: base must be null or sha256:<hex>`);
    if (f.content !== null && typeof f.content !== "string")
      throw new RangeError(`${f.path}: content must be a string or null`);
  }
  return o as MapPatch;
}

export interface Conflict {
  path: string;
  reason: string;
}

/** Files whose current version is not the patch's base. */
export function conflicts(root: string, patch: MapPatch): Conflict[] {
  const out: Conflict[] = [];
  for (const f of patch.files) {
    const cur = readOrNull(root, f.path);
    if (f.base === null && cur !== null && cur !== f.content)
      out.push({ path: f.path, reason: "the patch creates it, but it already exists" });
    else if (f.base !== null && cur === null)
      out.push({ path: f.path, reason: "the file no longer exists" });
    else if (f.base !== null && cur !== null && hash(cur) !== f.base && cur !== f.content)
      out.push({ path: f.path, reason: "the file changed since the patch was made" });
  }
  return out;
}

/** Writes the patch (all files or none). Call only after conflicts() came back empty. */
export function writePatch(
  root: string,
  patch: MapPatch,
): { written: string[]; removed: string[] } {
  const top = resolve(root, "world") + sep;
  const staged: [string, string][] = [];
  const removed: string[] = [];
  try {
    for (const f of patch.files) {
      const abs = resolve(root, f.path);
      if (!abs.startsWith(top)) throw new RangeError(`${f.path} resolves outside world/`);
      if (f.content === null) continue;
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp-${process.pid}`;
      writeFileSync(tmp, f.content);
      staged.push([tmp, abs]);
    }
  } catch (e) {
    for (const [tmp] of staged) rmSync(tmp, { force: true });
    throw e;
  }
  for (const [tmp, abs] of staged) renameSync(tmp, abs);
  for (const f of patch.files)
    if (f.content === null) {
      rmSync(resolve(root, f.path), { force: true });
      removed.push(f.path);
    }
  return { written: patch.files.filter((f) => f.content !== null).map((f) => f.path), removed };
}

export interface FileDiff {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  /** Whether the current file is the patch's base (false = conflict). */
  base_matches: boolean;
  /** Chunks: tiles whose ground or stack differ, and their bounding box. */
  tiles_changed?: number;
  bbox?: { x: number; y: number; w: number; h: number; z: number };
  /** YAML lists: entry IDs (or NPC IDs) added, removed and changed. */
  added?: string[];
  removed?: string[];
  changed?: string[];
}

function chunkDiff(path: string, before: string | null, after: string | null): Partial<FileDiff> {
  const parse = (t: string | null) => (t === null ? undefined : parseChunk(t, path, []));
  const a = parse(before);
  const b = parse(after);
  const c = a ?? b;
  if (!c) return {};
  let n = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const stack = (ch: typeof a, x: number, y: number) =>
    (ch?.items.find((s) => s.x === x && s.y === y)?.stack ?? []).join(",");
  for (let y = 0; y < CHUNK_SIZE; y++)
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const i = y * CHUNK_SIZE + x;
      if ((a?.ground[i] ?? null) === (b?.ground[i] ?? null) && stack(a, x, y) === stack(b, x, y))
        continue;
      n++;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  if (n === 0) return { tiles_changed: 0 };
  const gx = c.cx * CHUNK_SIZE;
  const gy = c.cy * CHUNK_SIZE;
  return {
    tiles_changed: n,
    bbox: { x: gx + x0, y: gy + y0, w: x1 - x0 + 1, h: y1 - y0 + 1, z: c.z },
  };
}

function listDiff(path: string, before: string | null, after: string | null): Partial<FileDiff> {
  const entries = (t: string | null): Map<string, string> => {
    const m = new Map<string, string>();
    if (t === null) return m;
    const data = parseYamlText(t, path, [])?.data;
    if (!Array.isArray(data)) return m;
    data.forEach((e: unknown, i) => {
      const o = e as { id?: unknown; npc?: unknown };
      const key = typeof o?.id === "string" ? o.id : typeof o?.npc === "string" ? o.npc : `#${i}`;
      m.set(key, JSON.stringify(e));
    });
    return m;
  };
  const a = entries(before);
  const b = entries(after);
  return {
    added: [...b.keys()].filter((k) => !a.has(k)),
    removed: [...a.keys()].filter((k) => !b.has(k)),
    changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)),
  };
}

/** What applying the patch would change in the current files. */
export function diffPatch(root: string, patch: MapPatch): FileDiff[] {
  return patch.files.map((f) => {
    const cur = readOrNull(root, f.path);
    const base_matches =
      f.base === null
        ? cur === null || cur === f.content
        : cur !== null && (hash(cur) === f.base || cur === f.content);
    const status: FileDiff["status"] =
      cur === f.content
        ? "unchanged"
        : cur === null
          ? "added"
          : f.content === null
            ? "removed"
            : "modified";
    const d: FileDiff = { path: f.path, status, base_matches };
    if (f.path.endsWith(".json")) Object.assign(d, chunkDiff(f.path, cur, f.content));
    else if (/\/(spawns|npcs|zones|portals|texts)\.yaml$/.test(f.path))
      Object.assign(d, listDiff(f.path, cur, f.content));
    return d;
  });
}
