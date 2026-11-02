// Terrain ops built on the tile primitives: fill, autoborder, scatter, stamp. Each returns
// its inverse as primitive ops (paint_ground / erase / place_item / remove_item), so undo
// never needs the rules, the seed or the prefab again.
import { borderItems, borderPieces, orderedRules } from "./borders.ts";
import type { Draft } from "./draft.ts";
import { InvalidOp, cellsOf, checkItem, checkPos, checkRect, paintCells, push } from "./draft.ts";
import { prefabSize } from "./prefab.ts";
import { seededRandom } from "./rng.ts";
import type { AutoborderOp, Cell, FillOp, MapOp, OpOptions, ScatterOp, StampOp } from "./types.ts";

/** Repaints the 4-connected region of equal ground around `pos`, inside its island. */
export function fill(d: Draft, op: FillOp, opts: OpOptions): MapOp[] {
  checkItem(op.item, opts, "ground");
  checkPos(op.pos);
  const { x, y, z } = op.pos;
  const island = d.islandAt(x, y, z);
  const rect = d.current(island).meta.rect;
  const target = d.groundAt(x, y, z);
  if (target === op.item) return [];
  const cells: Cell[] = [];
  const seen = new Uint8Array(rect.w * rect.h);
  const queue: number[] = [x, y];
  seen[(y - rect.y) * rect.w + (x - rect.x)] = 1;
  for (let head = 0; head < queue.length; head += 2) {
    const cx = queue[head] as number;
    const cy = queue[head + 1] as number;
    cells.push({ x: cx, y: cy });
    for (const [nx, ny] of [
      [cx, cy - 1],
      [cx + 1, cy],
      [cx, cy + 1],
      [cx - 1, cy],
    ] as const) {
      if (nx < rect.x || ny < rect.y || nx >= rect.x + rect.w || ny >= rect.y + rect.h) continue;
      const k = (ny - rect.y) * rect.w + (nx - rect.x);
      if (seen[k]) continue;
      seen[k] = 1;
      if (d.groundAt(nx, ny, z) === target) queue.push(nx, ny);
    }
  }
  return paintCells(d, z, cells, op.item);
}

/** Recomputes the border pieces of every tile in the rect. */
export function autoborder(d: Draft, op: AutoborderOp, opts: OpOptions): MapOp[] {
  if (!opts.borders) throw new InvalidOp("autoborder needs the rules of data/borders.yaml");
  checkRect(op.rect);
  const rules = orderedRules(opts.borders);
  const pieces = borderItems(rules);
  const inverse: MapOp[] = [];
  const groundAt = (x: number, y: number): string | null => d.groundAt(x, y, op.floor);
  for (const c of cellsOf(op)) {
    const pos = { x: c.x, y: c.y, z: op.floor };
    const prev = d.stackAt(c.x, c.y, op.floor);
    const kept = prev.filter((id) => !pieces.has(id));
    const next = [...borderPieces(c.x, c.y, groundAt, rules), ...kept];
    inverse.push(...d.setStack(pos, next));
  }
  return inverse;
}

/** Reproducible decoration of the empty tiles of a rect. */
export function scatter(d: Draft, op: ScatterOp, opts: OpOptions): MapOp[] {
  checkRect(op.rect);
  if (!Array.isArray(op.items) || op.items.length === 0)
    throw new InvalidOp("scatter needs a non-empty items list");
  for (const id of op.items) checkItem(id, opts, "stack");
  if (typeof op.density !== "number" || !(op.density >= 0 && op.density <= 1))
    throw new InvalidOp(`density must be a number in 0..1 (got ${JSON.stringify(op.density)})`);
  if (!Number.isSafeInteger(op.seed))
    throw new InvalidOp(`seed must be an integer (got ${JSON.stringify(op.seed)})`);
  if (op.on_ground !== undefined && !Array.isArray(op.on_ground))
    throw new InvalidOp("on_ground must be a list of ground IDs");
  const on = op.on_ground && op.on_ground.length > 0 ? new Set(op.on_ground) : undefined;
  const rand = seededRandom(op.seed);
  const inverse: MapOp[] = [];
  for (const c of cellsOf(op)) {
    // Two draws per cell whatever happens, so one tile never shifts the rest of the pattern.
    const hit = rand() < op.density;
    const pick = op.items[Math.floor(rand() * op.items.length)] as string;
    const ground = d.groundAt(c.x, c.y, op.floor);
    d.peek(c.x, c.y, op.floor); // validates the cell belongs to an island
    if (!hit || ground === null || (on && !on.has(ground))) continue;
    if (d.stackAt(c.x, c.y, op.floor).length > 0) continue;
    d.writableStack(c.x, c.y, op.floor).stack.push(pick);
    inverse.push({ op: "remove_item", pos: { x: c.x, y: c.y, z: op.floor }, item: pick, index: 0 });
  }
  return inverse;
}

/** Copies a prefab with its top-left corner at `pos`. */
export function stamp(d: Draft, op: StampOp, opts: OpOptions): MapOp[] {
  checkPos(op.pos);
  if (!opts.prefab) throw new InvalidOp("stamp needs the prefabs of world/prefabs/");
  const prefab = opts.prefab(op.prefab);
  if (!prefab) throw new InvalidOp(`unknown prefab "${op.prefab}" (not in world/prefabs/)`);
  const legend = new Map(prefab.legend.map((e) => [e.char, e]));
  for (const e of prefab.legend) {
    if (e.ground !== undefined) checkItem(e.ground, opts, "ground");
    for (const id of e.items ?? []) checkItem(id, opts, "stack");
  }
  const { w, h } = prefabSize(prefab);
  if (op.pos.x + w > 65536 || op.pos.y + h > 65536)
    throw new InvalidOp(
      `prefab "${prefab.id}" (${w}x${h}) does not fit at ${op.pos.x},${op.pos.y}`,
    );
  const grounds = new Map<string, Cell[]>();
  const stacks: { pos: { x: number; y: number; z: number }; items: string[] }[] = [];
  prefab.rows.forEach((row, dy) => {
    [...row].forEach((ch, dx) => {
      if (ch === " ") return;
      const e = legend.get(ch);
      if (!e) throw new InvalidOp(`prefab "${prefab.id}" uses "${ch}", which is not in its legend`);
      const x = op.pos.x + dx;
      const y = op.pos.y + dy;
      d.peek(x, y, op.pos.z); // validates the cell belongs to an island
      if (e.ground !== undefined) push(grounds, e.ground, { x, y });
      if (e.items !== undefined) stacks.push({ pos: { x, y, z: op.pos.z }, items: e.items });
    });
  });
  const inverse: MapOp[] = [];
  for (const [g, cells] of grounds) inverse.push(...paintCells(d, op.pos.z, cells, g));
  for (const s of stacks) inverse.push(...d.setStack(s.pos, s.items));
  return inverse;
}
