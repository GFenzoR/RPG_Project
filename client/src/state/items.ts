// Where an item is, as the client addresses it in UseItem / MoveItem / LookAt
// (docs/05, "ItemLocation"), and helpers to point at the top item of a tile.
import type { EquipmentSlot } from "@rpg/protocol";
import type { Pos } from "./geometry.ts";
import type { ItemMods } from "../content-types.ts";
import type { WorldState } from "./world.ts";

export type ItemLoc =
  | { kind: "pos"; pos: Pos }
  | { kind: "slot"; slot: EquipmentSlot }
  | { kind: "container"; id: number; index: number }
  /** A cell of the character's pockets (docs/02 "Bolsillos", state/pockets.ts). */
  | { kind: "pocket"; index: number };

/** An item the player points at: where it is, what the client thinks it is, how many. */
export interface ItemRef {
  loc: ItemLoc;
  itemId: number;
  /** Index in the tile stack (ground = 0); 0 for slots, the index for containers and pockets. */
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
    | { case: "container"; value: { containerId: number; index: number } }
    | { case: "pocket"; value: number };
} {
  switch (loc.kind) {
    case "pos":
      return { location: { case: "pos", value: { ...loc.pos } } };
    case "slot":
      return { location: { case: "slot", value: loc.slot } };
    case "container":
      return { location: { case: "container", value: { containerId: loc.id, index: loc.index } } };
    case "pocket":
      return { location: { case: "pocket", value: loc.index } };
  }
}

/** A stable key of a place (a list's key, a candidate's). */
export function locKey(l: ItemLoc): string {
  switch (l.kind) {
    case "slot":
      return `slot:${l.slot}`;
    case "container":
      return `c:${l.id}:${l.index}`;
    case "pocket":
      return `pocket:${l.index}`;
    case "pos":
      return `p:${l.pos.x},${l.pos.y},${l.pos.z}`;
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
 * ground gives undefined; looking accepts the ground. Border pieces (the fringe of a
 * neighbour's ground, always at the bottom of the stack) are part of the ground's look, not
 * items: a tile with only them is its ground, named as such when looked at.
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
  let i = t.length - 1;
  while (i > 0 && world.item(t[i] ?? 0)?.border) i--;
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

/**
 * Whether nobody moves an item: a map fixture (`pickupable: false`), but for the remains
 * of a creature (a monster's, `remainsOf`, or a player's body, `bodyOf`), which are
 * dragged a tile at a time (docs/02 "Arrastrar un cuerpo"; the server decides).
 */
export function immovable(
  def: { fixed?: boolean | undefined } | undefined,
  mods: Pick<ItemMods, "remainsOf" | "bodyOf"> | undefined,
): boolean {
  return def?.fixed === true && !mods?.remainsOf && !mods?.bodyOf;
}

/** Whether an item is the remains of a creature (a monster's, or a player's body). */
export function isRemains(mods: Pick<ItemMods, "remainsOf" | "bodyOf"> | undefined): boolean {
  return Boolean(mods?.remainsOf) || Boolean(mods?.bodyOf);
}

/**
 * Whether a press on the tile `at` may turn into a drag of the item on top of it. The
 * remains of a creature only from the tile next to them (or on them), where the server
 * lets them be dragged: after a fight the ground is full of them, and a press held on one
 * farther away has to keep walking toward the cursor (docs/17 MOV-3).
 */
export function dragFromTile(
  def: { fixed?: boolean | undefined } | undefined,
  mods: Pick<ItemMods, "remainsOf" | "bodyOf"> | undefined,
  self: Pos | undefined,
  at: Pos,
): boolean {
  if (immovable(def, mods)) return false;
  if (!isRemains(mods)) return true;
  return self !== undefined && self.z === at.z && tileDistance(self, at) <= 1;
}

/**
 * Whether a drag gesture that ends on `to` is sent as a MoveItem. The remains of a
 * creature go one tile at a time, on their floor: a release anywhere else (a slot, a
 * window, a tile farther away, the tile they lie on) is nothing, not a refusal in the chat.
 */
export function dragLands(
  ref: { loc: ItemLoc; mods?: Pick<ItemMods, "remainsOf" | "bodyOf"> | undefined },
  to: ItemLoc,
): boolean {
  if (!isRemains(ref.mods) || ref.loc.kind !== "pos") return true;
  return to.kind === "pos" && to.pos.z === ref.loc.pos.z && tileDistance(ref.loc.pos, to.pos) === 1;
}

function tileDistance(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
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
