// Touch actions without a right button or a Shift key (T5.6), as pure rules:
// - the contextual menu of a long press (on a map tile or a DOM item) lists what can be done
//   there: attack or talk to the creature, use or open the top item, look, move;
// - "move" without a drag is a two-tap machine: tap (or pick from the menu) the item, then
//   tap where it goes. The server validates the move like any drag and drop.
import type { ItemLoc, ItemRef } from "../state/items.ts";

/** One button of the contextual menu (i18n: client.touch.action.<kind>). */
export type ActionKind = "attack" | "talk" | "climb" | "use" | "open" | "look" | "move";

/** What the client knows of a long-pressed map tile. */
export interface TileFacts {
  /** The creature on it, if any. */
  creature?: { npc: boolean; self: boolean } | undefined;
  /**
   * Its top item above the ground, if any, but not the look of a portal (state/items.ts
   * menuItem): a bare ladder offers "climb", not "use" and "move" of its own item.
   */
  item?: { container: boolean } | undefined;
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
  if (f.item) out.push(f.item.container ? "open" : "use");
  else if (f.door && !f.climb) out.push("use");
  if (c || f.known) out.push("look");
  if (f.item) out.push("move");
  return out;
}

/** The menu of a long press on a DOM item (inventory slot or container cell). */
export function itemActions(container: boolean): ActionKind[] {
  return [container ? "open" : "use", "look", "move"];
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
