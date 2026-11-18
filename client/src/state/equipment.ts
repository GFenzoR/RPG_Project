// The equipment window in the Diablo II style (docs/17 UI-5, the owner on 2026-11-18: "creo
// que sería más cómodo estilo Diablo II"): the slots over a figure on a grid of square
// cells, big slots for big items, the icon at the largest whole scale its slot holds, the
// slots that take a held item lit, and the load as a bar. Only the layout idea comes from
// that game; the art, the names and the texts are the game's own. Pure: ui/Inventory.tsx
// draws it, the server keeps every rule.
import { EquipmentSlot } from "@rpg/protocol";
import type { ItemDef } from "../content-types.ts";
import { equipSlot } from "./item-card.ts";

/** The figure's grid: columns and rows of square cells. */
export const DOLL_COLS = 8;
export const DOLL_ROWS = 9;
/** Space between two cells, CSS px. Even, with an even cell: every icon lands on a whole px. */
export const DOLL_GAP = 2;
/** The smallest and the largest cell, CSS px (even). */
export const DOLL_MIN_CELL = 24;
export const DOLL_MAX_CELL = 44;
/** Room an icon keeps around itself inside its slot (the slot's rim and a breath), CSS px. */
export const SLOT_PAD = 4;

/** Where a slot sits on the grid: its first column and row (1-based) and its size in cells. */
export interface DollPlace {
  slot: EquipmentSlot;
  col: number;
  row: number;
  w: number;
  h: number;
}

/**
 * The figure, top to bottom: the head with the neck beside it; the hands at the sides, as
 * tall as the body (the left hand on the left, as before); the body; the ring at the hip;
 * the legs; the backpack and the ammunition (a quiver, its count shown) at the sides of the
 * legs; the feet. Columns 3 and 6 only hold the ring and the neck: the gaps D2's panel has
 * between the hands and the body.
 */
export const DOLL: readonly DollPlace[] = [
  { slot: EquipmentSlot.HEAD, col: 4, row: 1, w: 2, h: 2 },
  { slot: EquipmentSlot.NECK, col: 6, row: 2, w: 1, h: 1 },
  { slot: EquipmentSlot.LEFT_HAND, col: 1, row: 2, w: 2, h: 4 },
  { slot: EquipmentSlot.ARMOR, col: 4, row: 3, w: 2, h: 3 },
  { slot: EquipmentSlot.RIGHT_HAND, col: 7, row: 2, w: 2, h: 4 },
  { slot: EquipmentSlot.RING, col: 3, row: 6, w: 1, h: 1 },
  { slot: EquipmentSlot.LEGS, col: 4, row: 6, w: 2, h: 2 },
  { slot: EquipmentSlot.BACKPACK, col: 1, row: 7, w: 2, h: 2 },
  { slot: EquipmentSlot.AMMO, col: 7, row: 7, w: 2, h: 2 },
  { slot: EquipmentSlot.FEET, col: 4, row: 8, w: 2, h: 2 },
];

/**
 * The cell for a figure `width` CSS px wide: the largest even whole px at which the eight
 * columns and their gaps fit, between DOLL_MIN_CELL and DOLL_MAX_CELL (a hidden tab measures
 * 0: the smallest).
 */
export function dollCell(width: number): number {
  const fit = Math.floor((width - (DOLL_COLS - 1) * DOLL_GAP) / DOLL_COLS);
  const even = fit - (fit % 2);
  return Math.max(DOLL_MIN_CELL, Math.min(DOLL_MAX_CELL, even));
}

/** The figure's width and height at a cell, CSS px. */
export function dollSize(cell: number): { width: number; height: number } {
  return {
    width: DOLL_COLS * cell + (DOLL_COLS - 1) * DOLL_GAP,
    height: DOLL_ROWS * cell + (DOLL_ROWS - 1) * DOLL_GAP,
  };
}

/** A slot's box at a cell, CSS px: its cells and the gaps between them. */
export function slotBox(place: DollPlace, cell: number): { width: number; height: number } {
  return {
    width: place.w * cell + (place.w - 1) * DOLL_GAP,
    height: place.h * cell + (place.h - 1) * DOLL_GAP,
  };
}

/**
 * The whole scale an icon is drawn at in a box (docs/17 UI-5: big slots, big icons): the
 * largest at which it fits with SLOT_PAD around it, never under 1x (a 32 px icon in a
 * smaller ring or neck slot spills over its rim a little, still pixel for pixel).
 */
export function iconScale(
  box: { width: number; height: number },
  icon: { width: number; height: number },
): number {
  const w = Math.max(icon.width, 1);
  const h = Math.max(icon.height, 1);
  return Math.max(1, Math.floor(Math.min((box.width - SLOT_PAD) / w, (box.height - SLOT_PAD) / h)));
}

/**
 * The only slot an item can be worn in, as the server sees it (session/inventory.go slotFor:
 * a weapon in the right hand, a shield in the left, armour in its own slot, ammunition in
 * the ammo slot, a container on the back), or undefined. Fixtures nobody picks up go nowhere.
 */
export function wornIn(def: ItemDef | undefined): EquipmentSlot | undefined {
  if (!def || def.fixed) return undefined;
  const slot = equipSlot(def);
  if (slot !== undefined) return slot;
  return def.slots > 0 ? EquipmentSlot.BACKPACK : undefined;
}

/**
 * Whether a slot takes an item (docs/17 UI-5: while one is dragged or picked, the slots that
 * take it glow and the others tint red under the pointer). Only the slot's kind: the level,
 * the vocation and the hands are the server's to check, and its refusal says why.
 */
export function slotAccepts(def: ItemDef | undefined, slot: EquipmentSlot): boolean {
  return wornIn(def) === slot;
}

/** How loaded the character is (the bar under the inventory): 0..1 and a level for its colour. */
export interface Load {
  /** Carried weight over the maximum, 0..1. */
  fraction: number;
  level: "ok" | "heavy" | "full";
}

/** From 85 % of the capacity on, the bar warns. */
export const HEAVY_LOAD = 0.85;

/** The load from the free and the maximum capacity (PlayerStats, grams). */
export function capacityLoad(free: number, max: number): Load {
  if (max <= 0) return { fraction: 1, level: "full" };
  const fraction = Math.min(1, Math.max(0, (max - Math.max(0, free)) / max));
  return { fraction, level: free <= 0 ? "full" : fraction >= HEAVY_LOAD ? "heavy" : "ok" };
}
