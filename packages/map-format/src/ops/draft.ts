// Copy-on-write view of a world used while applying an op list, plus the helpers the ops
// share. Internal to ops/: nothing here is exported from the package.
import { CHUNK_SIZE, chunkKey, rectContains } from "../types.ts";
import type { Chunk, Island, ItemStack, Position, Rect, World } from "../types.ts";
import type { Cell, MapOp, OpOptions } from "./types.ts";

/** A chunk an op list changed. Chunks are per island: two islands never share one. */
export interface TouchedChunk {
  island: string;
  z: number;
  cx: number;
  cy: number;
}

/** Auxiliary lists ops can edit (one YAML file each). */
export type EntityList = "spawns" | "zones" | "portals" | "npcs";

/** An auxiliary file an op list changed. */
export interface TouchedAux {
  island: string;
  file: EntityList;
}

/** Thrown inside an op; applyOps turns it into an OpError with the op's index. */
export class InvalidOp extends Error {}

export interface TileRef {
  chunk: Chunk;
  /** Index into chunk.ground. */
  i: number;
  lx: number;
  ly: number;
}

export class Draft {
  /** Keyed by `${island}:${chunkKey}`, so islands sharing a chunk never mix. */
  readonly touched = new Map<string, TouchedChunk>();
  readonly touchedAux = new Map<string, TouchedAux>();
  private readonly src: World;
  private readonly islands = new Map<string, Island>();

  constructor(world: World) {
    this.src = world;
  }

  private island(id: string): Island {
    let isl = this.islands.get(id);
    if (!isl) {
      const orig = this.src.islands.get(id) as Island;
      isl = { ...orig, chunks: new Map(orig.chunks) };
      this.islands.set(id, isl);
    }
    return isl;
  }

  current(id: string): Island {
    return this.islands.get(id) ?? (this.src.islands.get(id) as Island);
  }

  islandIds(): string[] {
    return [...this.src.islands.keys()];
  }

  /** Island that owns (x, y) on floor z; throws InvalidOp when there is none. */
  islandAt(x: number, y: number, z: number): string {
    for (const [id, isl] of this.src.islands) {
      if (!rectContains(isl.meta.rect, x, y)) continue;
      if (!isl.meta.floors.includes(z))
        throw new InvalidOp(`floor ${z} is not in the floors of island "${id}" (${x},${y})`);
      return id;
    }
    throw new InvalidOp(`${x},${y},${z} is not inside any island`);
  }

  /** Island whose rect contains (x, y) and lists floor z, or undefined (never throws). */
  islandAtOrNone(x: number, y: number, z: number): string | undefined {
    for (const [id, isl] of this.src.islands)
      if (rectContains(isl.meta.rect, x, y)) return isl.meta.floors.includes(z) ? id : undefined;
    return undefined;
  }

  private ref(chunk: Chunk, x: number, y: number): TileRef {
    const lx = x - chunk.cx * CHUNK_SIZE;
    const ly = y - chunk.cy * CHUNK_SIZE;
    return { chunk, i: ly * CHUNK_SIZE + lx, lx, ly };
  }

  /** Read-only lookup; undefined when the chunk does not exist. Validates the position. */
  peek(x: number, y: number, z: number): TileRef | undefined {
    const id = this.islandAt(x, y, z);
    const key = chunkKey(z, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
    const chunk = this.current(id).chunks.get(key);
    return chunk ? this.ref(chunk, x, y) : undefined;
  }

  /** Ground at any tile; null outside every island, on unlisted floors or with no tile. */
  groundAt(x: number, y: number, z: number): string | null {
    if (x < 0 || y < 0) return null;
    const id = this.islandAtOrNone(x, y, z);
    if (id === undefined) return null;
    const key = chunkKey(z, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
    const chunk = this.current(id).chunks.get(key);
    if (!chunk) return null;
    return chunk.ground[this.ref(chunk, x, y).i] ?? null;
  }

  /** Stack of a tile (a copy; empty when there is none). Validates the position. */
  stackAt(x: number, y: number, z: number): string[] {
    const t = this.peek(x, y, z);
    return t ? [...(stackOf(t.chunk, t.lx, t.ly)?.stack ?? [])] : [];
  }

  /** Writable tile: clones (or creates) its chunk the first time. */
  tile(x: number, y: number, z: number): TileRef {
    const id = this.islandAt(x, y, z);
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const key = chunkKey(z, cx, cy);
    const isl = this.island(id);
    const owned = `${id}:${key}`;
    if (!this.touched.has(owned)) {
      const orig = isl.chunks.get(key);
      const copy: Chunk = orig
        ? {
            cx,
            cy,
            z,
            ground: [...orig.ground],
            items: orig.items.map((s) => ({ x: s.x, y: s.y, stack: [...s.stack] })),
          }
        : {
            cx,
            cy,
            z,
            ground: new Array<string | null>(CHUNK_SIZE * CHUNK_SIZE).fill(null),
            items: [],
          };
      isl.chunks.set(key, copy);
      this.touched.set(owned, { island: id, z, cx, cy });
    }
    return this.ref(isl.chunks.get(key) as Chunk, x, y);
  }

  /** Writable stack of a tile (created empty when missing). */
  writableStack(x: number, y: number, z: number): ItemStack {
    const t = this.tile(x, y, z);
    let s = stackOf(t.chunk, t.lx, t.ly);
    if (!s) {
      s = { x: t.lx, y: t.ly, stack: [] };
      t.chunk.items.push(s);
    }
    return s;
  }

  /**
   * Replaces a tile's stack and returns the ops that restore the old one. Only the part
   * between the common prefix and suffix is undone, so inverses stay small.
   */
  setStack(pos: Position, next: readonly string[]): MapOp[] {
    const prev = this.stackAt(pos.x, pos.y, pos.z);
    if (prev.length === next.length && prev.every((v, i) => v === next[i])) return [];
    let pre = 0;
    while (pre < prev.length && pre < next.length && prev[pre] === next[pre]) pre++;
    let suf = 0;
    while (
      suf < prev.length - pre &&
      suf < next.length - pre &&
      prev[prev.length - 1 - suf] === next[next.length - 1 - suf]
    )
      suf++;
    this.writableStack(pos.x, pos.y, pos.z).stack = [...next];
    const inverse: MapOp[] = [];
    const p = { x: pos.x, y: pos.y, z: pos.z };
    for (let i = next.length - suf - 1; i >= pre; i--)
      inverse.push({ op: "remove_item", pos: { ...p }, item: next[i] as string, index: i });
    for (let i = pre; i < prev.length - suf; i++)
      inverse.push({ op: "place_item", pos: { ...p }, item: prev[i] as string, index: i });
    return inverse;
  }

  /** Current entries of an island's auxiliary list (do not mutate). */
  list<K extends EntityList>(island: string, file: K): Island[K] {
    return this.current(island)[file];
  }

  /** Writable copy of an island's auxiliary list, cloned on first write. */
  editList<K extends EntityList>(island: string, file: K): Island[K] {
    const isl = this.island(island);
    const key = `${island}:${file}`;
    if (!this.touchedAux.has(key)) {
      (isl as Record<K, unknown>)[file] = [...isl[file]];
      this.touchedAux.set(key, { island, file });
    }
    return isl[file];
  }

  finish(): World {
    for (const t of this.touched.values()) {
      const key = chunkKey(t.z, t.cx, t.cy);
      const isl = this.island(t.island);
      const c = isl.chunks.get(key) as Chunk;
      c.items = c.items.filter((s) => s.stack.length > 0).sort((a, b) => a.y - b.y || a.x - b.x);
      if (c.items.length === 0 && c.ground.every((g) => g === null)) isl.chunks.delete(key);
    }
    if (this.islands.size === 0) return this.src;
    const islands = new Map(this.src.islands);
    for (const [id, isl] of this.islands) islands.set(id, isl);
    return { meta: this.src.meta, islands };
  }
}

// ---- shared helpers -------------------------------------------------------------------

export function stackOf(chunk: Chunk, lx: number, ly: number): ItemStack | undefined {
  return chunk.items.find((s) => s.x === lx && s.y === ly);
}

/** Paints `item` on `cells`; returns the inverse (grouped by previous ground). */
export function paintCells(d: Draft, floor: number, cells: Cell[], item: string): MapOp[] {
  const before = new Map<string | null, Cell[]>();
  for (const c of cells) {
    const t = d.tile(c.x, c.y, floor);
    const prev = t.chunk.ground[t.i] ?? null;
    if (prev === item) continue;
    push(before, prev, c);
    t.chunk.ground[t.i] = item;
  }
  const inverse: MapOp[] = [];
  for (const [prev, list] of before) {
    if (prev === null) inverse.push({ op: "erase", floor, cells: list, layer: "ground" });
    else inverse.push({ op: "paint_ground", floor, cells: list, item: prev });
  }
  return inverse;
}

export function push<K>(m: Map<K, Cell[]>, k: K, c: Cell): void {
  const list = m.get(k);
  if (list) list.push(c);
  else m.set(k, [c]);
}

export function checkItem(id: string, opts: OpOptions, where: "ground" | "stack"): void {
  if (typeof id !== "string" || id === "") throw new InvalidOp("item must be a non-empty ID");
  if (!opts.itemKind) return;
  const kind = opts.itemKind(id);
  if (kind === undefined) throw new InvalidOp(`unknown item "${id}" (not in data/items/)`);
  if (where === "ground" && kind !== "ground")
    throw new InvalidOp(`"${id}" is a ${kind}, not a ground item`);
  if (where === "stack" && kind === "ground")
    throw new InvalidOp(`ground item "${id}" belongs in the ground layer; use paint_ground`);
}

export const isCoord = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 65535;

export function checkPos(p: Position, what = "position"): void {
  if (!p || !isCoord(p.x) || !isCoord(p.y) || !isCoord(p.z) || p.z > 15)
    throw new InvalidOp(`invalid ${what} ${JSON.stringify(p)}`);
}

export function checkRect(r: Rect | undefined, what = "rect"): Rect {
  if (
    !r ||
    !isCoord(r.x) ||
    !isCoord(r.y) ||
    ![r.w, r.h].every((n) => Number.isInteger(n) && n > 0) ||
    r.x + r.w > 65536 ||
    r.y + r.h > 65536
  )
    throw new InvalidOp(`invalid ${what} ${JSON.stringify(r)}`);
  return r;
}

export function checkId(id: unknown, what: string): string {
  if (typeof id !== "string" || !/^[a-z][a-z0-9_]*$/.test(id) || id.length > 64)
    throw new InvalidOp(`${what} must be a lowercase snake_case ID (got ${JSON.stringify(id)})`);
  return id;
}

/** Cells of rect + cells, each once, in row-major order for the rect then list order. */
export function cellsOf(op: { floor: number; rect?: Rect; cells?: Cell[] }): Cell[] {
  if (!isCoord(op.floor)) throw new InvalidOp(`invalid floor ${JSON.stringify(op.floor)}`);
  if (!op.rect && !op.cells) throw new InvalidOp("needs rect or cells");
  const out: Cell[] = [];
  const seen = new Set<string>();
  const add = (x: number, y: number): void => {
    if (!isCoord(x) || !isCoord(y)) throw new InvalidOp(`invalid cell ${x},${y}`);
    const k = `${x},${y}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ x, y });
  };
  if (op.rect) {
    const r = op.rect;
    if (![r.w, r.h].every((n) => Number.isInteger(n) && n > 0))
      throw new InvalidOp(`invalid rect ${JSON.stringify(r)}`);
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) add(x, y);
  }
  for (const c of op.cells ?? []) add(c?.x, c?.y);
  return out;
}

/** Index for inserting into a list of `length` entries (default: append). */
export function insertIndex(index: number | undefined, length: number): number {
  const at = index ?? length;
  if (!Number.isInteger(at) || at < 0 || at > length)
    throw new InvalidOp(`index ${at} is outside the list (0..${length})`);
  return at;
}
