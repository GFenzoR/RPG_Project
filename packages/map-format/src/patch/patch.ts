// Map patches (.rpgpatch.json, docs/04-map-editor-and-ai.md "Map patches"): the map files
// of world/ a change touches, each with its base version and its new content. A patch is
// untrusted input (it comes from the community): parsePatch checks its size, every path,
// every hash and every file against the map schemas before anything looks at it.
//
// Format 2 carries the base text of each file (`base_text`), so applying it can merge
// tile by tile against whatever the files are now. Format 1 (T1.15) only has the base
// hash; it is still read, and the caller finds the base elsewhere (git, the disk).
//
// Node only (hashing, schemas); the model-level merge lives in merge.ts (browser-safe).
import { createHash } from "node:crypto";
import { formatChunk, parseChunk } from "../chunk.ts";
import type { Diagnostic } from "../diagnostics.ts";
import { checkSchema } from "../schemas.ts";
import type { MapSchemaName } from "../schemas.ts";
import { CHUNK_SIZE, MAX_FLOOR } from "../types.ts";
import type { Chunk, Rect } from "../types.ts";
import { formatYaml, parseYamlText } from "../yaml.ts";
import { formatPrefab } from "../prefabs.ts";
import type { Prefab } from "../ops/prefab.ts";
import { MERGE_LISTS, chunkChanges, listChanges, mergeChunk, mergeList } from "./merge.ts";
import type { ListChanges, ListEntry, MergeConflict, MergeList } from "./merge.ts";

export const PATCH_KIND = "rpg-map-patch";
export const PATCH_FORMAT = 2;
/** Largest patch accepted, in characters of JSON (a whole 512x512 island is ~10 MB). */
export const MAX_PATCH_SIZE = 32 << 20;
export const MAX_PATCH_FILES = 4096;

export interface PatchFile {
  /** Path relative to the repo root, under world/. */
  path: string;
  /** "sha256:<hex>" of the base version, or null when the patch creates the file. */
  base: string | null;
  /** Format 2: text of the base version (present whenever `base` is not null). */
  base_text?: string;
  /** New content, or null when the patch removes the file. */
  content: string | null;
}

export interface MapPatch {
  format: 1 | 2;
  kind: typeof PATCH_KIND;
  /** Where the base comes from: a git ref (mapcli, MCP) or "editor". */
  base_ref: string;
  files: PatchFile[];
}

/** What a patchable path is. */
export type PatchPath =
  | { kind: "chunk"; island: string; z: number; cx: number; cy: number }
  | { kind: "list"; island: string; list: MergeList }
  | { kind: "island"; island: string }
  | { kind: "world" }
  | { kind: "prefab"; id: string };

const ID = "[a-z][a-z0-9_]*";
const CHUNK = new RegExp(`^world/islands/(${ID})/chunks/z(\\d{2})/c(\\d{4})_(\\d{4})\\.json$`);
const ISLAND_FILE = new RegExp(`^world/islands/(${ID})/(island|${MERGE_LISTS.join("|")})\\.yaml$`);
const PREFAB = new RegExp(`^world/prefabs/(${ID})\\.yaml$`);
const REF = /^(?!-)[A-Za-z0-9._/@{}~^-]{1,200}$/;

/**
 * Classifies a path a patch may touch: chunks, island files, world.yaml and prefabs of
 * world/. Undefined for anything else (data/, other dirs, "..", absolute paths, odd names).
 */
export function patchPath(path: string): PatchPath | undefined {
  if (path.length > 200) return undefined;
  if (path === "world/world.yaml") return { kind: "world" };
  const c = CHUNK.exec(path);
  if (c) {
    const z = Number(c[2]);
    if (z > MAX_FLOOR) return undefined;
    return { kind: "chunk", island: c[1] ?? "", z, cx: Number(c[3]), cy: Number(c[4]) };
  }
  const f = ISLAND_FILE.exec(path);
  if (f) {
    const island = f[1] ?? "";
    return f[2] === "island"
      ? { kind: "island", island }
      : { kind: "list", island, list: f[2] as MergeList };
  }
  const p = PREFAB.exec(path);
  if (p) return { kind: "prefab", id: p[1] ?? "" };
  return undefined;
}

export const isPatchable = (path: string): boolean => patchPath(path) !== undefined;

export const patchHash = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** A patch that is malformed, too big or touches what it may not. */
export class PatchError extends RangeError {}

function schemaOf(p: PatchPath): MapSchemaName {
  if (p.kind === "chunk") return "chunk";
  if (p.kind === "list") return p.list;
  return p.kind;
}

/**
 * Parses one file of a patch into the model: a Chunk, a list, or the YAML data. Throws
 * PatchError when it is not valid against its schema or a chunk's coordinates do not
 * match its path.
 */
export function parsePatchFile(path: string, text: string): unknown {
  const p = patchPath(path);
  if (!p) throw new PatchError(`${JSON.stringify(path)} is not a map file of world/`);
  if (p.kind === "chunk") {
    const diags: Diagnostic[] = [];
    const c = parseChunk(text, path, diags);
    if (!c) throw new PatchError(`${path}: ${diags[0]?.message ?? "invalid chunk"}`);
    if (c.z !== p.z || c.cx !== p.cx || c.cy !== p.cy)
      throw new PatchError(`${path}: the chunk says cx=${c.cx} cy=${c.cy} z=${c.z}`);
    return c;
  }
  const diags: Diagnostic[] = [];
  const parsed = parseYamlText(text, path, diags);
  if (!parsed) throw new PatchError(`${path}: ${diags[0]?.message ?? "invalid YAML"}`);
  const errors = checkSchema(schemaOf(p), parsed.data);
  if (errors.length > 0)
    throw new PatchError(`${path}: ${errors[0]?.message ?? "does not match its schema"}`);
  return parsed.data;
}

/** Throws PatchError when the patch is malformed, too big or names a file it may not touch. */
export function parsePatch(text: string): MapPatch {
  if (typeof text !== "string" || text.length > MAX_PATCH_SIZE)
    throw new PatchError(`patch is larger than ${MAX_PATCH_SIZE >> 20} MB`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new PatchError(`patch is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const o = raw as Partial<MapPatch> | null;
  if (o?.kind !== PATCH_KIND || (o.format !== 1 && o.format !== 2) || !Array.isArray(o.files))
    throw new PatchError(`not an ${PATCH_KIND} of format 1 or 2`);
  if (typeof o.base_ref !== "string" || !REF.test(o.base_ref))
    throw new PatchError(`base_ref ${JSON.stringify(o.base_ref)} is not a valid ref`);
  if (o.files.length > MAX_PATCH_FILES)
    throw new PatchError(`patch has more than ${MAX_PATCH_FILES} files`);
  const seen = new Set<string>();
  const files: PatchFile[] = [];
  for (const f of o.files as Partial<PatchFile>[]) {
    if (typeof f?.path !== "string" || !isPatchable(f.path))
      throw new PatchError(
        `patch touches ${JSON.stringify(f?.path)}, outside the map files of world/`,
      );
    if (seen.has(f.path)) throw new PatchError(`patch lists ${f.path} twice`);
    seen.add(f.path);
    if (f.base !== null && (typeof f.base !== "string" || !/^sha256:[0-9a-f]{64}$/.test(f.base)))
      throw new PatchError(`${f.path}: base must be null or sha256:<hex>`);
    if (f.content !== null && typeof f.content !== "string")
      throw new PatchError(`${f.path}: content must be a string or null`);
    if (f.base === null && f.content === null)
      throw new PatchError(`${f.path}: neither a base nor a content`);
    if (f.content !== null) parsePatchFile(f.path, f.content);
    const file: PatchFile = { path: f.path, base: f.base, content: f.content };
    if (f.base_text !== undefined) {
      if (o.format !== 2 || f.base === null || typeof f.base_text !== "string")
        throw new PatchError(`${f.path}: unexpected base_text`);
      if (patchHash(f.base_text) !== f.base)
        throw new PatchError(`${f.path}: base_text does not match its base hash`);
      parsePatchFile(f.path, f.base_text);
      file.base_text = f.base_text;
    } else if (o.format === 2 && f.base !== null)
      throw new PatchError(`${f.path}: format 2 needs the base_text of every base`);
    files.push(file);
  }
  return { format: o.format, kind: PATCH_KIND, base_ref: o.base_ref, files };
}

/** Canonical text of a merged file (null: the file goes away). */
function formatMerged(p: PatchPath, data: Chunk | ListEntry[] | undefined): string | null {
  if (data === undefined) return null;
  if (p.kind === "chunk") return formatChunk(data as Chunk);
  const list = data as ListEntry[];
  return list.length === 0 ? null : formatYaml(list);
}

/**
 * Canonical text of a patch file (what `mapcli fmt` writes), or null when it should not
 * exist: an empty chunk or an empty list. Patches may be written by hand: their texts are
 * never written as they come (a YAML `01056` or `0x4` reads differently in other parsers).
 * Throws PatchError if the text does not parse.
 */
export function canonicalPatchText(path: string, text: string | null): string | null {
  if (text === null) return null;
  const p = patchPath(path);
  if (!p) throw new PatchError(`${JSON.stringify(path)} is not a map file of world/`);
  const data = parsePatchFile(path, text);
  if (p.kind === "chunk") {
    const c = data as Chunk;
    return formatMerged(p, isEmptyChunk(c) ? undefined : c);
  }
  if (p.kind === "list") return formatMerged(p, data as ListEntry[]);
  if (p.kind === "prefab") return formatPrefab(data as Prefab);
  return formatYaml(data);
}

const isEmptyChunk = (c: Chunk): boolean =>
  c.items.length === 0 && c.ground.every((g) => g === null);

export interface FileMerge {
  /** Merged text (null: no file). Conflicting tiles/entries keep the current version. */
  text: string | null;
  conflicts: MergeConflict[];
}

/**
 * Three-way merge of one file. `base` undefined = unknown (format 1 without a way to get
 * it): only a trivial merge is possible. Texts are compared first; only when both sides
 * changed does it merge chunks by tile and lists by entry (other files conflict whole).
 */
export function mergePatchFile(
  path: string,
  base: string | null | undefined,
  ours: string | null,
  theirs: string | null,
): FileMerge {
  const conflict = (reason: string): FileMerge => ({
    text: ours,
    conflicts: [{ kind: "file", reason }],
  });
  // Compare canonical texts: a hand-written patch is written in canonical form, so applying
  // it again must see the file as already patched, not as changed on both sides.
  const canon = (t: string | null): string | null => {
    try {
      return canonicalPatchText(path, t);
    } catch {
      return t; // not parseable: compared as is (and merged as a conflict below)
    }
  };
  let ct: string | null;
  try {
    ct = canonicalPatchText(path, theirs);
  } catch (e) {
    return conflict(e instanceof Error ? e.message : String(e));
  }
  const co = canon(ours);
  const cb = base === undefined ? undefined : canon(base);
  if (co === ct) return { text: ours, conflicts: [] };
  if (cb !== undefined && ct === cb) return { text: ours, conflicts: [] };
  // Fast-forward (or creation): the patch's text, in canonical form.
  if (cb !== undefined && co === cb) return { text: ct, conflicts: [] };
  if (base === undefined) return conflict("the base is not available to merge");
  const p = patchPath(path);
  if (!p || (p.kind !== "chunk" && p.kind !== "list"))
    return conflict("the file changed on both sides");
  let parsed: unknown[];
  try {
    parsed = [base, ours, theirs].map((t) => (t === null ? undefined : parsePatchFile(path, t)));
  } catch (e) {
    return conflict(e instanceof Error ? e.message : String(e));
  }
  if (p.kind === "chunk") {
    const [b, o, t] = parsed as (Chunk | undefined)[];
    const m = mergeChunk(b, o, t, p);
    return { text: formatMerged(p, m.result), conflicts: m.conflicts };
  }
  const [b, o, t] = parsed.map((l) => (l ?? []) as ListEntry[]) as ListEntry[][];
  const m = mergeList(b ?? [], o ?? [], t ?? []);
  return { text: formatMerged(p, m.result), conflicts: m.conflicts };
}

export interface FileSummary extends Partial<ListChanges> {
  /** Chunks: tiles whose ground or stack differ, and their bounding box. */
  tiles_changed?: number;
  bbox?: Rect & { z: number };
}

/** What changes from `before` to `after` in one file (tiles for chunks, entries for lists). */
export function summarizeFileChange(
  path: string,
  before: string | null,
  after: string | null,
): FileSummary {
  const p = patchPath(path);
  const parse = (t: string | null): unknown => {
    if (t === null) return undefined;
    try {
      return parsePatchFile(path, t);
    } catch {
      return undefined;
    }
  };
  if (p?.kind === "chunk") {
    const changed = chunkChanges(
      parse(before) as Chunk | undefined,
      parse(after) as Chunk | undefined,
    );
    if (changed.length === 0) return { tiles_changed: 0 };
    const xs = changed.map((i) => i % CHUNK_SIZE);
    const ys = changed.map((i) => Math.floor(i / CHUNK_SIZE));
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    return {
      tiles_changed: changed.length,
      bbox: {
        x: p.cx * CHUNK_SIZE + x0,
        y: p.cy * CHUNK_SIZE + y0,
        w: Math.max(...xs) - x0 + 1,
        h: Math.max(...ys) - y0 + 1,
        z: p.z,
      },
    };
  }
  if (p?.kind === "list")
    return listChanges((parse(before) ?? []) as ListEntry[], (parse(after) ?? []) as ListEntry[]);
  return {};
}

/** Human-readable conflict ("tile 10,4,7", "entry wolf_den", or the file reason). */
export function describeConflict(c: MergeConflict): string {
  if (c.kind === "tile") return `tile ${c.x},${c.y},${c.z}`;
  if (c.kind === "entry") return `entry ${c.key}`;
  return c.reason;
}
