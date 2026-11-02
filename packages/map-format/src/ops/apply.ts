// Applies edit operations to an in-memory world.
//
// - Pure: the input world is never mutated. The result shares every island and chunk the
//   ops did not touch (copy-on-write), so applying a brush stroke is cheap.
// - Atomic: if any op is invalid, an OpError is thrown and nothing is applied.
// - Reversible: the result carries `inverse`, an op list that restores the input exactly
//   (same tiles, same stacks, same chunks, same auxiliary lists), so undo/redo and review
//   are just more ops.
// - A chunk left with no ground and no items is removed, so painting and undoing never
//   leaves an empty chunk file behind.
//
// This module only imports types and browser-safe code: it runs in the browser (editor) as
// well as in Node.
import type { Position, World } from "../types.ts";
import {
  Draft,
  InvalidOp,
  cellsOf,
  checkItem,
  checkPos,
  paintCells,
  push,
  stackOf,
} from "./draft.ts";
import type { TouchedAux, TouchedChunk } from "./draft.ts";
import {
  addPortal,
  addSpawn,
  addZone,
  placeNpc,
  removeNpc,
  removePortal,
  removeSpawn,
  removeZone,
} from "./entities.ts";
import { autoborder, fill, scatter, stamp } from "./terrain.ts";
import { OpError } from "./types.ts";
import type { Cell, EraseOp, MapOp, OpOptions, PaintGroundOp, RemoveItemOp } from "./types.ts";

export type { TouchedAux, TouchedChunk } from "./draft.ts";

export interface ApplyResult {
  world: World;
  /** Applying these ops to `world` gives back the input world. */
  inverse: MapOp[];
  /** Every chunk that changed, was created or was removed, with the island that owns it. */
  touched: TouchedChunk[];
  /** Every auxiliary list (spawns, zones, portals, npcs) that changed, per island. */
  touchedAux: TouchedAux[];
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
  return {
    world: draft.finish(),
    inverse,
    touched: [...draft.touched.values()],
    touchedAux: [...draft.touchedAux.values()],
  };
}

function applyOne(d: Draft, op: MapOp, opts: OpOptions): MapOp[] {
  if (typeof op !== "object" || op === null) throw new InvalidOp("an op must be an object");
  switch (op.op) {
    case "paint_ground":
      return paintGround(d, op, opts);
    case "erase":
      return erase(d, op);
    case "place_item":
      return placeItem(d, op.pos, op.item, op.index, opts);
    case "remove_item":
      return removeItem(d, op);
    case "fill":
      return fill(d, op, opts);
    case "autoborder":
      return autoborder(d, op, opts);
    case "scatter":
      return scatter(d, op, opts);
    case "stamp":
      return stamp(d, op, opts);
    case "add_spawn":
      return addSpawn(d, op, opts);
    case "remove_spawn":
      return removeSpawn(d, op);
    case "add_zone":
      return addZone(d, op);
    case "remove_zone":
      return removeZone(d, op);
    case "add_portal":
      return addPortal(d, op);
    case "remove_portal":
      return removePortal(d, op);
    case "place_npc":
      return placeNpc(d, op, opts);
    case "remove_npc":
      return removeNpc(d, op);
    default: {
      const unknown: { op?: unknown } = op;
      throw new InvalidOp(`unknown op ${JSON.stringify(unknown.op)}`);
    }
  }
}

// ---- tile ops ---------------------------------------------------------------------------

function paintGround(d: Draft, op: PaintGroundOp, opts: OpOptions): MapOp[] {
  checkItem(op.item, opts, "ground");
  return paintCells(d, op.floor, cellsOf(op), op.item);
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
  const s = d.writableStack(pos.x, pos.y, pos.z);
  const at = index ?? s.stack.length;
  if (!Number.isInteger(at) || at < 0 || at > s.stack.length)
    throw new InvalidOp(`index ${at} is outside the stack (0..${s.stack.length})`);
  s.stack.splice(at, 0, item);
  return [{ op: "remove_item", pos: { x: pos.x, y: pos.y, z: pos.z }, item, index: at }];
}

function removeItem(d: Draft, op: RemoveItemOp): MapOp[] {
  checkPos(op.pos);
  const where = `${op.pos.x},${op.pos.y},${op.pos.z}`;
  const current = d.stackAt(op.pos.x, op.pos.y, op.pos.z);
  const at = op.index ?? current.lastIndexOf(op.item);
  if (at < 0) throw new InvalidOp(`no "${op.item}" on the stack at ${where}`);
  if (current[at] !== op.item)
    throw new InvalidOp(
      `stack at ${where} has ${JSON.stringify(current[at] ?? null)} at index ${at}, not "${op.item}"`,
    );
  d.writableStack(op.pos.x, op.pos.y, op.pos.z).stack.splice(at, 1);
  return [
    { op: "place_item", pos: { x: op.pos.x, y: op.pos.y, z: op.pos.z }, item: op.item, index: at },
  ];
}
