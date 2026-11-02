// Where an item is, as the client addresses it in UseItem / MoveItem / LookAt
// (docs/05, "ItemLocation"), and helpers to point at the top item of a tile.
import type { EquipmentSlot } from "@rpg/protocol";
import type { Pos } from "./geometry.ts";
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
  return { loc: { kind: "pos", pos: { x, y, z } }, itemId: t[i] ?? 0, stackIndex: i, count };
}
