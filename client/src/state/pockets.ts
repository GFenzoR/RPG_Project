// The character's pockets (docs/02 "Bolsillos"; the owner on 2026-11-19: "al no tener
// contenedor el personaje debiese tener 4 slots (los bolsillos) pero si te compras una mochila
// ganas mas slots"): built-in cells of every character, part of it and never an item. The
// server says how many there are and what they hold in Inventory (pockets, pocket_slots);
// a cell is ItemLocation.pocket. They are not a container window: the inventory draws them as
// a row under the figure (ui/Inventory.tsx). Pure: the server keeps every rule.
import type { ClientContent, ItemMods } from "../content-types.ts";
import type { ItemRef } from "./items.ts";
import type { ItemView } from "./world.ts";

/** What the pockets hold (cell 0 first, without gaps) and how many cells they have. */
export interface PocketsState {
  capacity: number;
  items: ItemView[];
}

/** No pockets yet (before the first Inventory). */
export const NO_POCKETS: PocketsState = { capacity: 0, items: [] };

/**
 * The cells to draw: one per pocket, each with its item or empty; an item past the cells
 * (a balance that lowered their number keeps what was saved) gets one of its own.
 */
export function pocketCells(p: PocketsState): (ItemView | undefined)[] {
  return Array.from({ length: Math.max(p.capacity, p.items.length) }, (_, i) => p.items[i]);
}

/** The item of cell `index` as the client points at it (its menu, card, drag, use). */
export function pocketRef(item: ItemView, index: number): ItemRef {
  return {
    loc: { kind: "pocket", index },
    itemId: item.itemId,
    stackIndex: index,
    count: item.count,
    mods: item.mods,
  };
}

/** An item the player can put in a trade: where it is and what it is. */
export interface Offerable {
  ref: ItemRef;
  itemId: number;
  count: number;
  mods?: ItemMods | undefined;
}

/**
 * The tradeable items of the pockets, cell by cell, for the trade window's picker (the
 * server refuses a container with something inside, as in the backpack).
 */
export function pocketOffers(p: PocketsState, content: ClientContent): Offerable[] {
  const out: Offerable[] = [];
  p.items.forEach((it, index) => {
    if (content.items[it.itemId]?.tradeable)
      out.push({ ref: pocketRef(it, index), itemId: it.itemId, count: it.count, mods: it.mods });
  });
  return out;
}
