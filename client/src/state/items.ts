// Where an item is, as the client addresses it in UseItem / MoveItem / LookAt
// (docs/05, "ItemLocation"), and helpers to point at the top item of a tile.
import type { EquipmentSlot } from "@rpg/protocol";
import type { Pos } from "./geometry.ts";
import type { ItemMods } from "../content-types.ts";
import type { WorldState } from "./world.ts";

/** Grams per displayed "oz" (docs/06: weights in grams, shown in oz). */
export const GRAMS_PER_OZ = 100;

/** A weight in grams as the UI shows it: oz with two decimals. */
export const formatOz = (grams: number): string => (grams / GRAMS_PER_OZ).toFixed(2);

export type ItemLoc =
  | { kind: "pos"; pos: Pos }
  | { kind: "slot"; slot: EquipmentSlot }
  | { kind: "container"; id: number; index: number };

/** An item the player points at: where it is, what the client thinks it is, how many. */
export interface ItemRef {
  loc: ItemLoc;
  itemId: number;
  /** Index in the tile stack (ground = 0); 0 for slots, the index for containers. */
  stackIndex: number;
  /** Units to move (the whole stack; 1 for items that do not stack). */
  count: number;
  /** The instance's mods (an equipable's attribute), for its card. */
  mods?: ItemMods | undefined;
}

/** The ItemLocation init of the protocol for loc. */
export function locationInit(loc: ItemLoc): {
  location:
    | { case: "pos"; value: Pos }
    | { case: "slot"; value: EquipmentSlot }
    | { case: "container"; value: { containerId: number; index: number } };
} {
  switch (loc.kind) {
    case "pos":
      return { location: { case: "pos", value: { ...loc.pos } } };
    case "slot":
      return { location: { case: "slot", value: loc.slot } };
    case "container":
      return { location: { case: "container", value: { containerId: loc.id, index: loc.index } } };
  }
}

/**
 * What using a known map tile uses (a right click, the touch menu's "use"):
 * - "first" (a ladder): its ground (stack index 0), whatever lies on it. The server climbs
 *   on a UseItem of the ground; what lies on top cannot hide the ladder.
 * - "bare" (a house door, a rope spot): the top item, or its ground if nothing lies on it.
 * - "never": the top item; a bare tile uses nothing.
 */
export function tileUse(
  world: WorldState,
  x: number,
  y: number,
  z: number,
  ground: "first" | "bare" | "never",
): ItemRef | undefined {
  if (ground === "first") {
    const t = world.tile(x, y, z);
    if (!t || t.length === 0) return undefined;
    const count = world.tileCounts(x, y, z)?.[0] ?? 0;
    return { loc: { kind: "pos", pos: { x, y, z } }, itemId: t[0] ?? 0, stackIndex: 0, count };
  }
  return (
    topItem(world, x, y, z, false) ??
    (ground === "bare" ? topItem(world, x, y, z, true) : undefined)
  );
}

/**
 * The item a long press on a map tile offers its buttons for ("use"/"open", "move"): the
 * top item above the ground, but not the look of a portal (stairs, a ladder, a hole...: a
 * map item nobody moves, always under what is dropped there, whose use is the menu's
 * "climb" or nothing). What lies on it (a corpse) is the top item all the same.
 */
export function menuItem(world: WorldState, x: number, y: number, z: number): ItemRef | undefined {
  const top = topItem(world, x, y, z, false);
  return top && !world.item(top.itemId)?.portal ? top : undefined;
}

/**
 * The top item of a known tile. With `withGround` false (use, move) a tile with only its
 * ground gives undefined; looking accepts the ground.
 */
export function topItem(
  world: WorldState,
  x: number,
  y: number,
  z: number,
  withGround: boolean,
): ItemRef | undefined {
  const t = world.tile(x, y, z);
  if (!t || t.length === 0) return undefined;
  const i = t.length - 1;
  if (i === 0 && !withGround) return undefined;
  const count = world.tileCounts(x, y, z)?.[i] ?? 0;
  const mods = world.tileMods(x, y, z)?.[i];
  const ref: ItemRef = {
    loc: { kind: "pos", pos: { x, y, z } },
    itemId: t[i] ?? 0,
    stackIndex: i,
    count,
  };
  return mods ? { ...ref, mods } : ref;
}

/** Whether a stack of `count` units can be split (a Shift+drag, docs/17 UI-6). */
export function splittable(def: { stackable: boolean } | undefined, count: number): boolean {
  return def?.stackable === true && count > 1;
}

/** What a split prompt starts at: half the stack, rounded down (1 at least). */
export const halfStack = (count: number): number => Math.max(1, Math.floor(count / 2));

/**
 * The units a split moves (the menu's "Move part…" and a Shift+drag): a whole number from
 * 1 to the stack less one (the whole stack is a plain move); not a number moves 1.
 */
export function splitCount(n: number, stack: number): number {
  const max = Math.max(1, stack - 1);
  return Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : 1;
}
