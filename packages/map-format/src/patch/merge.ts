// Three-way merge and diff of map files on the in-memory model (docs/04-map-editor-and-ai.md,
// "Map patches"). Shared by mapcli (text files, through patch.ts) and the editor (its
// in-memory world): the same rules decide what a patch changes and where it conflicts.
//
// - Chunks merge tile by tile. A tile is its ground plus its whole item stack. A missing
//   chunk is an empty one, so creating and removing chunk files merge the same way.
// - Auxiliary lists (spawns, npcs, zones, portals, texts) merge entry by entry, keyed by
//   `id` (`npc` for NPC placements). A missing file is an empty list.
// - A tile or entry that changed on one side only is taken from that side; one that
//   changed on both sides to different values is a conflict and keeps the current value.
//
// Browser-safe: only types and plain code (the editor bundles it through ./ops).
import { CHUNK_SIZE, chunkKey, emptyChunk, rectContains } from "../types.ts";
import type {
  Chunk,
  Island,
  MapText,
  NpcPlacement,
  Portal,
  Position,
  Rect,
  Spawn,
  World,
  Zone,
} from "../types.ts";
import type { MapOp } from "../ops/types.ts";

/** Auxiliary lists merged entry by entry. */
export const MERGE_LISTS = ["spawns", "npcs", "zones", "portals", "texts"] as const;
export type MergeList = (typeof MERGE_LISTS)[number];

export type ListEntry = Spawn | NpcPlacement | Zone | Portal | MapText;

/** Why a file could not be merged. */
export type MergeConflict =
  | { kind: "tile"; x: number; y: number; z: number }
  | { kind: "entry"; key: string }
  | { kind: "file"; reason: string };

export interface MergeResult<T> {
  /** Merged value; conflicting tiles/entries keep the current ("ours") value. */
  result: T;
  conflicts: MergeConflict[];
}

/** Key of an entry: `npc` for NPC placements, `id` for the rest. */
export function listKey(e: ListEntry): string {
  return "npc" in e ? e.npc : e.id;
}

/** JSON with sorted object keys, so equal values compare equal however they were built. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

// ---- chunks ---------------------------------------------------------------------------

/** Ground and stack of every tile, in one comparable string per tile. */
function tileKeys(c: Chunk | undefined): string[] {
  const out = new Array<string>(CHUNK_SIZE * CHUNK_SIZE);
  for (let i = 0; i < out.length; i++) out[i] = `${c?.ground[i] ?? ""}|`;
  for (const s of c?.items ?? []) {
    const i = s.y * CHUNK_SIZE + s.x;
    if (i >= 0 && i < out.length) out[i] = `${c?.ground[i] ?? ""}|${s.stack.join(",")}`;
  }
  return out;
}

/** Local indices (y * 32 + x) of the tiles that differ between two versions of a chunk. */
export function chunkChanges(a: Chunk | undefined, b: Chunk | undefined): number[] {
  if (a === b) return [];
  const ka = tileKeys(a);
  const kb = tileKeys(b);
  const out: number[] = [];
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) out.push(i);
  return out;
}

const isEmpty = (c: Chunk): boolean => c.items.length === 0 && c.ground.every((g) => g === null);

/**
 * Three-way merge of one chunk (z, cx, cy). `undefined` = no chunk (all tiles empty);
 * the result is undefined when every tile ends up empty.
 */
export function mergeChunk(
  base: Chunk | undefined,
  ours: Chunk | undefined,
  theirs: Chunk | undefined,
  at: { z: number; cx: number; cy: number },
): MergeResult<Chunk | undefined> {
  const kb = tileKeys(base);
  const ko = tileKeys(ours);
  const kt = tileKeys(theirs);
  const out = emptyChunk(at.cx, at.cy, at.z);
  const conflicts: MergeConflict[] = [];
  const stacks = new Map<number, string[]>();
  const take = (src: Chunk | undefined, i: number): void => {
    out.ground[i] = src?.ground[i] ?? null;
    const s = src?.items.find((e) => e.y * CHUNK_SIZE + e.x === i);
    if (s && s.stack.length > 0) stacks.set(i, [...s.stack]);
  };
  for (let i = 0; i < kb.length; i++) {
    if (ko[i] === kt[i] || kt[i] === kb[i]) take(ours, i);
    else if (ko[i] === kb[i]) take(theirs, i);
    else {
      take(ours, i);
      conflicts.push({
        kind: "tile",
        x: at.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
        y: at.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE),
        z: at.z,
      });
    }
  }
  for (const [i, stack] of [...stacks].sort((a, b) => a[0] - b[0]))
    out.items.push({ x: i % CHUNK_SIZE, y: Math.floor(i / CHUNK_SIZE), stack });
  return { result: isEmpty(out) ? undefined : out, conflicts };
}

// ---- lists ----------------------------------------------------------------------------

function keyed<T extends ListEntry>(list: readonly T[]): Map<string, T> | undefined {
  const m = new Map<string, T>();
  for (const e of list) {
    const k = listKey(e);
    if (typeof k !== "string" || m.has(k)) return undefined;
    m.set(k, e);
  }
  return m;
}

export interface ListChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Keys added, removed and changed from `a` to `b`. */
export function listChanges(a: readonly ListEntry[], b: readonly ListEntry[]): ListChanges {
  const ma = new Map(a.map((e) => [listKey(e), stableJson(e)]));
  const mb = new Map(b.map((e) => [listKey(e), stableJson(e)]));
  return {
    added: [...mb.keys()].filter((k) => !ma.has(k)),
    removed: [...ma.keys()].filter((k) => !mb.has(k)),
    changed: [...mb.keys()].filter((k) => ma.has(k) && ma.get(k) !== mb.get(k)),
  };
}

/**
 * Three-way merge of an auxiliary list by key. Order: the current list with its entries
 * replaced or removed, then the entries the patch added, in the patch's order. When one
 * side did not change at all, the other side is taken as is (order included).
 */
export function mergeList<T extends ListEntry>(
  base: readonly T[],
  ours: readonly T[],
  theirs: readonly T[],
): MergeResult<T[]> {
  const sb = stableJson(base);
  const so = stableJson(ours);
  const st = stableJson(theirs);
  if (so === st || st === sb) return { result: [...ours], conflicts: [] };
  if (so === sb) return { result: [...theirs], conflicts: [] };
  const mb = keyed(base);
  const mo = keyed(ours);
  const mt = keyed(theirs);
  if (!mb || !mo || !mt)
    return {
      result: [...ours],
      conflicts: [{ kind: "file", reason: "an entry is missing its id or is repeated" }],
    };
  const j = (e: T | undefined): string | undefined => (e === undefined ? undefined : stableJson(e));
  const result: T[] = [];
  const conflicts: MergeConflict[] = [];
  const pick = (k: string): T | undefined => {
    const b = j(mb.get(k));
    const o = j(mo.get(k));
    const t = j(mt.get(k));
    if (o === t || t === b) return mo.get(k);
    if (o === b) return mt.get(k);
    conflicts.push({ kind: "entry", key: k });
    return mo.get(k);
  };
  for (const k of mo.keys()) {
    const e = pick(k);
    if (e !== undefined) result.push(e);
  }
  for (const k of mt.keys()) {
    if (mo.has(k)) continue;
    const e = pick(k);
    if (e !== undefined) result.push(e);
  }
  // Removed on our side, unchanged or removed on theirs: pick() already dropped them;
  // removed here but changed there was reported as a conflict when visiting theirs.
  return { result, conflicts };
}

// ---- whole worlds (editor) --------------------------------------------------------------

/** One chunk whose tiles differ between two worlds. */
export interface ChunkDiff {
  island: string;
  z: number;
  cx: number;
  cy: number;
  /** Global coordinates of the changed tiles. */
  tiles: { x: number; y: number }[];
  bbox: Rect;
}

/** One auxiliary list whose entries differ between two worlds. */
export interface ListDiff extends ListChanges {
  island: string;
  list: MergeList;
}

export interface WorldDiff {
  chunks: ChunkDiff[];
  lists: ListDiff[];
}

/** Every chunk and list entry that differs from `before` to `after` (islands of both). */
export function diffWorlds(before: World, after: World): WorldDiff {
  const chunks: ChunkDiff[] = [];
  const lists: ListDiff[] = [];
  const ids = [...new Set([...before.islands.keys(), ...after.islands.keys()])];
  for (const id of ids) {
    const a = before.islands.get(id);
    const b = after.islands.get(id);
    if (a === b) continue;
    const keys = new Set([...(a?.chunks.keys() ?? []), ...(b?.chunks.keys() ?? [])]);
    for (const key of [...keys].sort()) {
      const ca = a?.chunks.get(key);
      const cb = b?.chunks.get(key);
      const changed = chunkChanges(ca, cb);
      if (changed.length === 0) continue;
      const c = (ca ?? cb) as Chunk;
      const tiles = changed.map((i) => ({
        x: c.cx * CHUNK_SIZE + (i % CHUNK_SIZE),
        y: c.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE),
      }));
      const xs = tiles.map((t) => t.x);
      const ys = tiles.map((t) => t.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      chunks.push({
        island: id,
        z: c.z,
        cx: c.cx,
        cy: c.cy,
        tiles,
        bbox: { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 },
      });
    }
    for (const list of MERGE_LISTS) {
      const la = (a?.[list] ?? []) as ListEntry[];
      const lb = (b?.[list] ?? []) as ListEntry[];
      if (la === lb) continue;
      const d = listChanges(la, lb);
      if (d.added.length + d.removed.length + d.changed.length > 0)
        lists.push({ island: id, list, ...d });
      else if (stableJson(la) !== stableJson(lb))
        lists.push({ island: id, list, added: [], removed: [], changed: [] }); // reordered
    }
  }
  return { chunks, lists };
}

// ---- ops that turn the current world into a merged one (editor import) ------------------

/** Tile the entry is shown at (spawn centre, NPC/text tile, portal origin, zone's first rect). */
export function listEntryPos(e: ListEntry): Position {
  if ("center" in e) return e.center;
  if ("pos" in e) return e.pos;
  if ("from" in e) return e.from;
  const r = e.rects[0] ?? { x: 0, y: 0, w: 1, h: 1 };
  return { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2), z: e.floors[0] ?? 7 };
}

/** Lists the editor (and its ops) can change; texts.yaml has no ops yet. */
export type OpList = Exclude<MergeList, "texts">;

/** Op that adds an entry to `list` (fields copied, so the op never aliases the entry). */
export function entryAddOp(list: OpList, e: ListEntry, index: number | undefined): MapOp {
  const at = index === undefined ? {} : { index };
  const notes = e.notes ? { notes: e.notes } : {};
  if (list === "spawns") {
    const s = e as Spawn;
    return {
      op: "add_spawn",
      id: s.id,
      center: { ...s.center },
      radius: s.radius,
      monsters: s.monsters.map((m) => ({ ...m })),
      respawn_seconds: s.respawn_seconds,
      ...notes,
      ...at,
    };
  }
  if (list === "zones") {
    const z = e as Zone;
    return {
      op: "add_zone",
      id: z.id,
      type: z.type,
      floors: [...z.floors],
      rects: z.rects.map((r) => ({ ...r })),
      ...notes,
      ...at,
    };
  }
  if (list === "portals") {
    const p = e as Portal;
    return {
      op: "add_portal",
      id: p.id,
      kind: p.kind,
      from: { ...p.from },
      to: { ...p.to },
      ...notes,
      ...at,
    };
  }
  const n = e as NpcPlacement;
  return { op: "place_npc", npc: n.npc, pos: { ...n.pos }, ...notes, ...at };
}

export function entryRemoveOp(list: OpList, key: string): MapOp {
  if (list === "spawns") return { op: "remove_spawn", id: key };
  if (list === "zones") return { op: "remove_zone", id: key };
  if (list === "portals") return { op: "remove_portal", id: key };
  return { op: "remove_npc", npc: key };
}

/** Thrown when a target cannot be reached with ops (tile outside its island). */
export class SyncError extends Error {}

/**
 * Ops that turn chunk `current` of `island` into `target` (undefined = no chunk): paint or
 * erase the ground of each changed tile, then replace its stack. Throws SyncError if a
 * changed tile is outside the island's rect.
 */
export function chunkSyncOps(
  island: Island,
  current: Chunk | undefined,
  target: Chunk | undefined,
  at: { z: number; cx: number; cy: number },
): MapOp[] {
  const changed = chunkChanges(current, target);
  if (changed.length === 0) return [];
  const paint = new Map<string, { x: number; y: number }[]>();
  const eraseGround: { x: number; y: number }[] = [];
  const eraseItems: { x: number; y: number }[] = [];
  const place: MapOp[] = [];
  const stack = (c: Chunk | undefined, i: number): string[] =>
    c?.items.find((s) => s.y * CHUNK_SIZE + s.x === i)?.stack ?? [];
  for (const i of changed) {
    const x = at.cx * CHUNK_SIZE + (i % CHUNK_SIZE);
    const y = at.cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
    if (!rectContains(island.meta.rect, x, y) || !island.meta.floors.includes(at.z))
      throw new SyncError(`${x},${y},${at.z} is outside island "${island.meta.id}"`);
    const g0 = current?.ground[i] ?? null;
    const g1 = target?.ground[i] ?? null;
    if (g0 !== g1) {
      if (g1 === null) eraseGround.push({ x, y });
      else {
        const cells = paint.get(g1) ?? [];
        cells.push({ x, y });
        paint.set(g1, cells);
      }
    }
    const s0 = stack(current, i);
    const s1 = stack(target, i);
    if (s0.join(",") !== s1.join(",")) {
      if (s0.length > 0) eraseItems.push({ x, y });
      for (const item of s1) place.push({ op: "place_item", pos: { x, y, z: at.z }, item });
    }
  }
  const ops: MapOp[] = [];
  for (const [item, cells] of paint) ops.push({ op: "paint_ground", floor: at.z, cells, item });
  if (eraseGround.length > 0)
    ops.push({ op: "erase", floor: at.z, cells: eraseGround, layer: "ground" });
  if (eraseItems.length > 0)
    ops.push({ op: "erase", floor: at.z, cells: eraseItems, layer: "items" });
  ops.push(...place);
  return ops;
}

/**
 * Ops that turn list `current` of `island` into `target`: removes the entries that changed
 * or left, then adds the new and changed ones at their index. Throws SyncError if a new or
 * changed entry is not inside the island (rect and floors; every rect of a zone). If the entries both keep end up in a
 * different order, every entry is removed and added again.
 */
export function listSyncOps(
  island: Island,
  list: OpList,
  current: readonly ListEntry[],
  target: readonly ListEntry[],
): MapOp[] {
  if (stableJson(current) === stableJson(target)) return [];
  const cur = new Map(current.map((e) => [listKey(e), stableJson(e)]));
  let kept = new Set(target.filter((e) => cur.get(listKey(e)) === stableJson(e)).map(listKey));
  const order = (l: readonly ListEntry[]): string =>
    l
      .map(listKey)
      .filter((k) => kept.has(k))
      .join("\n");
  if (order(current) !== order(target)) kept = new Set();
  // The entity ops pick the island by position: an entry placed in another island would
  // land in that island's file. Refuse it, as chunkSyncOps refuses foreign tiles.
  for (const e of target) if (!kept.has(listKey(e))) checkInIsland(island, list, e);
  const ops: MapOp[] = [];
  for (const e of current) if (!kept.has(listKey(e))) ops.push(entryRemoveOp(list, listKey(e)));
  target.forEach((e, index) => {
    if (!kept.has(listKey(e))) ops.push(entryAddOp(list, e, index));
  });
  return ops;
}

function checkInIsland(island: Island, list: OpList, e: ListEntry): void {
  const m = island.meta;
  const inside = (x: number, y: number, z: number): boolean =>
    rectContains(m.rect, x, y) && m.floors.includes(z);
  let ok: boolean;
  if (list === "zones") {
    const z = e as Zone;
    ok = z.floors.every((f) =>
      z.rects.every((r) => inside(r.x, r.y, f) && inside(r.x + r.w - 1, r.y + r.h - 1, f)),
    );
  } else {
    const p = listEntryPos(e);
    ok = inside(p.x, p.y, p.z);
  }
  if (!ok) throw new SyncError(`${list} entry "${listKey(e)}" is outside island "${m.id}"`);
}

/** Chunk of `island` at (z, cx, cy), if any. */
export const islandChunk = (island: Island | undefined, z: number, cx: number, cy: number) =>
  island?.chunks.get(chunkKey(z, cx, cy));
