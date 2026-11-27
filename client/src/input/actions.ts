// Touch actions without a right button or a Shift key (T5.6), as pure rules:
// - the contextual menu of a long press (on a map tile or a DOM item) lists what can be done
//   there: attack or talk to the creature, use or open the top item, look, move;
// - "move" without a drag is a two-tap machine: tap (or pick from the menu) the item, then
//   tap where it goes. The server validates the move like any drag and drop.
import type { ItemLoc, ItemRef } from "../state/items.ts";

/** One button of the contextual menu (i18n: client.touch.action.<kind>). */
export type ActionKind =
  | "attack"
  | "talk"
  | "climb"
  | "use"
  | "open"
  | "read"
  | "use_with"
  | "eat"
  | "equip"
  | "look"
  | "move"
  | "split"
  | "hotkey";

/**
 * What the client knows of an item a menu offers buttons for (docs/17 UI-6): its first
 * button (open, read, use with, eat, equip or use) is its default action, the one a double
 * click does. `split`: a stack of more than one unit can move part of it.
 */
export interface ItemFacts {
  container: boolean;
  /** A book or scroll (docs/02 "Libros y cofres"): "Read" opens the reading window. */
  book?: boolean | undefined;
  /** A reward chest of the map: "Open" asks the server for what it holds. */
  chest?: boolean | undefined;
  /** A tool: "Use with…" (the next click picks where). */
  useWith?: boolean | undefined;
  /** Food: "Eat". */
  food?: boolean | undefined;
  /** Equipment not in a slot yet: "Equip" moves it to its slot. */
  equip?: boolean | undefined;
  /** Food, a potion or a rune: "Assign to a quick key" (an item hotkey, docs/02). */
  hotkey?: boolean | undefined;
  /** More than one unit: "Move part…". */
  split?: boolean | undefined;
  /** A map fixture nobody carries (a station, a board): nothing to move. */
  fixed?: boolean | undefined;
  /**
   * A fixture that does something when used (a door, a crafting station, the market
   * board), unlike a tree or a wall: its use is a default action worth showing.
   */
  usable?: boolean | undefined;
}

/** The default action of an item: the first button of its menu. */
export function itemPrimary(f: ItemFacts): ActionKind {
  if (f.container || f.chest) return "open";
  if (f.book) return "read";
  if (f.useWith) return "use_with";
  if (f.food) return "eat";
  if (f.equip) return "equip";
  return "use";
}

/** What the client knows of a long-pressed map tile. */
export interface TileFacts {
  /** The creature on it, if any. */
  creature?:
    | {
        npc: boolean;
        self: boolean;
        /** Another player's character (the context button never attacks one). */
        player?: boolean | undefined;
      }
    | undefined;
  /**
   * Its top item above the ground, if any, but not the look of a portal (state/items.ts
   * menuItem): a bare ladder offers "climb", not "use" and "move" of its own item.
   */
  item?: ItemFacts | undefined;
  /** A bare house door (T5.4) or rope spot: using its ground opens the house window, or says a rope is needed. */
  door?: boolean;
  /** A ladder: climbing it comes first, whatever lies on it (the item there keeps its own buttons). */
  climb?: boolean;
  /** There is something to look at (any known tile has at least its ground). */
  known: boolean;
}

/** The menu of a long press on a map tile, in the order the buttons show. */
export function tileActions(f: TileFacts): ActionKind[] {
  const out: ActionKind[] = [];
  const c = f.creature;
  if (c && !c.self) out.push(c.npc ? "talk" : "attack");
  if (f.climb) out.push("climb");
  if (f.item) out.push(itemPrimary(f.item));
  else if (f.door && !f.climb) out.push("use");
  if (c || f.known) out.push("look");
  if (f.item && !f.item.fixed) {
    out.push("move");
    if (f.item.split) out.push("split");
  }
  return out;
}

/**
 * The default action on a map tile (docs/17 UI-5, MOV-7: the text beside the cursor): the
 * first button of its menu, what the classic right click and the menu's double click do.
 * Undefined when that is only looking (bare ground, the own tile with nothing on it).
 */
export function defaultAction(f: TileFacts): ActionKind | undefined {
  const first = tileActions(f)[0];
  if (first === "look") return undefined;
  // A tree, a wall or a fountain: using it does nothing, so the cursor says nothing.
  if (first === "use" && f.item?.fixed === true && f.item.usable !== true) return undefined;
  return first;
}

/** The menu of a DOM item (inventory slot, container cell): its default action first. */
export function itemActions(f: ItemFacts): ActionKind[] {
  const out: ActionKind[] = [itemPrimary(f), "look", "move"];
  if (f.split) out.push("split");
  if (f.hotkey) out.push("hotkey");
  return out;
}

/** Same item at the same place (the client's view of the stack may lag a step). */
export function sameRef(a: ItemRef, b: ItemRef): boolean {
  return a.itemId === b.itemId && a.stackIndex === b.stackIndex && sameLoc(a.loc, b.loc);
}

export function sameLoc(a: ItemLoc, b: ItemLoc): boolean {
  switch (a.kind) {
    case "pos":
      return b.kind === "pos" && a.pos.x === b.pos.x && a.pos.y === b.pos.y && a.pos.z === b.pos.z;
    case "slot":
      return b.kind === "slot" && a.slot === b.slot;
    case "container":
      return b.kind === "container" && a.id === b.id && a.index === b.index;
    case "pocket":
      return b.kind === "pocket" && a.index === b.index;
  }
}

/** A move the picker decided: send MoveItem(ref → to). */
export interface PickedMove {
  ref: ItemRef;
  to: ItemLoc;
}

/** Tap an item, then tap its destination. Tapping the picked item again drops the pick. */
export class ItemPicker {
  private ref: ItemRef | undefined;

  get picked(): ItemRef | undefined {
    return this.ref;
  }

  /** Picks ref (or drops the pick when it is the picked one); returns what is picked now. */
  pick(ref: ItemRef): ItemRef | undefined {
    this.ref = this.ref && sameRef(this.ref, ref) ? undefined : ref;
    return this.ref;
  }

  /** The destination was tapped: the move to send, or undefined (nothing picked, or the
   * item's own place). The pick ends either way. */
  place(to: ItemLoc): PickedMove | undefined {
    const ref = this.ref;
    this.ref = undefined;
    if (!ref || sameLoc(ref.loc, to)) return undefined;
    return { ref, to };
  }

  /** Drops the pick; reports whether there was one. */
  cancel(): boolean {
    const had = this.ref !== undefined;
    this.ref = undefined;
    return had;
  }
}
