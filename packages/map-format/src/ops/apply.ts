// Applies edit operations to an in-memory world.
//
// - Pure: the input world is never mutated. The result shares every island and chunk the
//   ops did not touch (copy-on-write), so applying a brush stroke is cheap.
// - Atomic: if any op is invalid, an OpError is thrown and nothing is applied.
// - Reversible: the result carries `inverse`, an op list that restores the input exactly
//   (same tiles, same stacks, same chunks), so undo/redo and review are just more ops.
// - A chunk left with no ground and no items is removed, so painting and undoing never
//   leaves an empty chunk file behind.
//
// This module only imports types: it runs in the browser (editor) as well as in Node.
import { CHUNK_SIZE, chunkKey, rectContains } from "../types.ts";
import type { Chunk, Island, ItemStack, Position, World } from "../types.ts";
import { OpError } from "./types.ts";
import type { Cell, EraseOp, MapOp, OpOptions, PaintGroundOp, RemoveItemOp } from "./types.ts";

/** A chunk an op list changed. Chunks are per island: two islands never share one. */
export interface TouchedChunk {
  island: string;
  z: number;
  cx: number;
  cy: number;
}

export interface ApplyResult {
  world: World;
  /** Applying these ops to `world` gives back the input world. */
  inverse: MapOp[];
  /** Every chunk that changed, was created or was removed, with the island that owns it. */
  touched: TouchedChunk[];
}

/** Applies `ops` in order. Throws OpError (and applies nothing) if one is invalid. */
export function applyOps(world: World, ops: readonly MapOp[], opts: OpOptions = {}): ApplyResult {
  const draft = new Draft(world);
  const inverses: MapOp[][] = [];
  for (const [i, op] of ops.entries()) {
    try {
      inverses.push(applyOne(draft, op, opts));
    } catch (e) {
      if (e instanceof InvalidOp) throw new OpError(i, e.message);
      throw e;
    }
  }
  // Undo runs the inverses of later ops first.
  const inverse = inverses.reverse().flat();
  return { world: draft.finish(), inverse, touched: [...draft.touched.values()] };
}

class InvalidOp extends Error {}

function applyOne(d: Draft, op: MapOp, opts: OpOptions): MapOp[] {
  switch (op.op) {
    case "paint_ground":
      return paintGround(d, op, opts);
    case "erase":
      return erase(d, op);
    case "place_item":
      return placeItem(d, op.pos, op.item, op.index, opts);
    case "remove_item":
      return removeItem(d, op);
    default: {
      const unknown: { op?: unknown } = op;
      throw new InvalidOp(`unknown op ${JSON.stringify(unknown.op)}`);
    }
  }
}

// ---- ops -----------------------------------------------------------------------------

function paintGround(d: Draft, op: PaintGroundOp, opts: OpOptions): MapOp[] {
  checkItem(op.item, opts, "ground");
  const before = new Map<string | null, Cell[]>();
  for (const c of cellsOf(op)) {
    const t = d.tile(c.x, c.y, op.floor);
    const prev = t.chunk.ground[t.i] ?? null;
    if (prev === op.item) continue;
    push(before, prev, c);
    t.chunk.ground[t.i] = op.item;
  }
  const inverse: MapOp[] = [];
  for (const [prev, cells] of before) {
    if (prev === null) inverse.push({ op: "erase", floor: op.floor, cells, layer: "ground" });
    else inverse.push({ op: "paint_ground", floor: op.floor, cells, item: prev });
  }
  return inverse;
}

function erase(d: Draft, op: EraseOp): MapOp[] {
  if (op.layer !== "ground" && op.layer !== "items" && op.layer !== "all")
    throw new InvalidOp(`layer must be ground, items or all (got ${JSON.stringify(op.layer)})`);
  const grounds = new Map<string, Cell[]>();
  const restoreItems: MapOp[] = [];
  for (const c of cellsOf(op)) {
    const t = d.peek(c.x, c.y, op.floor);
    if (!t) continue;
    if (op.layer !== "items") {
      const g = t.chunk.ground[t.i] ?? null;
      if (g !== null) {
        const w = d.tile(c.x, c.y, op.floor);
        w.chunk.ground[w.i] = null;
        push(grounds, g, c);
      }
    }
    if (op.layer !== "ground") {
      const stack = stackOf(t.chunk, t.lx, t.ly);
      if (stack && stack.stack.length > 0) {
        const w = d.tile(c.x, c.y, op.floor);
        const ws = stackOf(w.chunk, w.lx, w.ly);
        const pos = { x: c.x, y: c.y, z: op.floor };
        for (const [index, item] of (ws?.stack ?? []).entries())
          restoreItems.push({ op: "place_item", pos, item, index });
        if (ws) ws.stack = [];
      }
    }
  }
  const inverse: MapOp[] = [];
  for (const [item, cells] of grounds)
    inverse.push({ op: "paint_ground", floor: op.floor, cells, item });
  return [...inverse, ...restoreItems];
}

function placeItem(
  d: Draft,
  pos: Position,
  item: string,
  index: number | undefined,
  opts: OpOptions,
): MapOp[] {
  checkItem(item, opts, "stack");
  checkPos(pos);
  const t = d.tile(pos.x, pos.y, pos.z);
  let s = stackOf(t.chunk, t.lx, t.ly);
  if (!s) {
    s = { x: t.lx, y: t.ly, stack: [] };
    t.chunk.items.push(s);
  }
  const at = index ?? s.stack.length;
  if (!Number.isInteger(at) || at < 0 || at > s.stack.length)
    throw new InvalidOp(`index ${at} is outside the stack (0..${s.stack.length})`);
  s.stack.splice(at, 0, item);
  return [{ op: "remove_item", pos: { ...pos }, item, index: at }];
}

function removeItem(d: Draft, op: RemoveItemOp): MapOp[] {
  checkPos(op.pos);
  const where = `${op.pos.x},${op.pos.y},${op.pos.z}`;
  const t = d.peek(op.pos.x, op.pos.y, op.pos.z);
  const current = t ? (stackOf(t.chunk, t.lx, t.ly)?.stack ?? []) : [];
  const at = op.index ?? current.lastIndexOf(op.item);
  if (at < 0) throw new InvalidOp(`no "${op.item}" on the stack at ${where}`);
  if (current[at] !== op.item)
    throw new InvalidOp(
      `stack at ${where} has ${JSON.stringify(current[at] ?? null)} at index ${at}, not "${op.item}"`,
    );
  const w = d.tile(op.pos.x, op.pos.y, op.pos.z);
  stackOf(w.chunk, w.lx, w.ly)?.stack.splice(at, 1);
  return [{ op: "place_item", pos: { ...op.pos }, item: op.item, index: at }];
}

// ---- helpers ---------------------------------------------------------------------------

function push<K>(m: Map<K, Cell[]>, k: K, c: Cell): void {
  const list = m.get(k);
  if (list) list.push(c);
  else m.set(k, [c]);
}

function checkItem(id: string, opts: OpOptions, where: "ground" | "stack"): void {
  if (typeof id !== "string" || id === "") throw new InvalidOp("item must be a non-empty ID");
  if (!opts.itemKind) return;
  const kind = opts.itemKind(id);
  if (kind === undefined) throw new InvalidOp(`unknown item "${id}" (not in data/items/)`);
  if (where === "ground" && kind !== "ground")
    throw new InvalidOp(`"${id}" is a ${kind}, not a ground item`);
  if (where === "stack" && kind === "ground")
    throw new InvalidOp(`ground item "${id}" belongs in the ground layer; use paint_ground`);
}

const isCoord = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 65535;

function checkPos(p: Position): void {
  if (!p || !isCoord(p.x) || !isCoord(p.y) || !isCoord(p.z))
    throw new InvalidOp(`invalid position ${JSON.stringify(p)}`);
}

/** Cells of rect + cells, each once, in row-major order for the rect then list order. */
function cellsOf(op: {
  floor: number;
  rect?: Cell & { w: number; h: number };
  cells?: Cell[];
}): Cell[] {
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

function stackOf(chunk: Chunk, lx: number, ly: number): ItemStack | undefined {
  return chunk.items.find((s) => s.x === lx && s.y === ly);
}

interface TileRef {
  chunk: Chunk;
  /** Index into chunk.ground. */
  i: number;
  lx: number;
  ly: number;
}

/** Copy-on-write view of a world: islands and chunks are cloned the first time they change. */
class Draft {
  /** Keyed by `${island}:${chunkKey}`, so islands sharing a chunk never mix. */
  readonly touched = new Map<string, TouchedChunk>();
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

  private current(id: string): Island {
    return this.islands.get(id) ?? (this.src.islands.get(id) as Island);
  }

  private islandAt(x: number, y: number, z: number): string {
    for (const [id, isl] of this.src.islands) {
      if (!rectContains(isl.meta.rect, x, y)) continue;
      if (!isl.meta.floors.includes(z))
        throw new InvalidOp(`floor ${z} is not in the floors of island "${id}" (${x},${y})`);
      return id;
    }
    throw new InvalidOp(`${x},${y},${z} is not inside any island`);
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
