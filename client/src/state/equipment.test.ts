import { EquipmentSlot } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ItemDef } from "../content-types.ts";
import {
  DOLL,
  DOLL_COLS,
  DOLL_GAP,
  DOLL_MAX_CELL,
  DOLL_MIN_CELL,
  DOLL_ROWS,
  HEAVY_LOAD,
  capacityLoad,
  dollCell,
  dollSize,
  iconScale,
  slotAccepts,
  slotBox,
  wornIn,
} from "./equipment.ts";

const base: ItemDef = {
  id: "x",
  sprite: "",
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
};
const sword: ItemDef = {
  ...base,
  id: "iron_sword",
  kind: "weapon",
  weapon: { type: "sword", attack: 13, defense: 9, hands: 1, range: 0, element: "", ammo: "" },
};
const shield: ItemDef = { ...base, id: "plank_shield", kind: "shield", shield: { defense: 8 } };
const armor = (slot: string): ItemDef => ({ ...base, kind: "armor", armor: { slot, armor: 2 } });
const arrows: ItemDef = { ...base, id: "arrow", kind: "ammo", ammo: { type: "arrow", attack: 3 } };
const backpack: ItemDef = { ...base, id: "backpack", kind: "container", slots: 20 };
const corpse: ItemDef = { ...base, id: "remains", kind: "container", slots: 8, fixed: true };
const fish: ItemDef = { ...base, id: "raw_fish", kind: "consumable", stackable: true };

describe("the figure (docs/17 UI-5, Diablo II style)", () => {
  it("places every slot once, inside the 8x9 grid, without overlaps", () => {
    const taken = new Map<string, EquipmentSlot>();
    for (const p of DOLL) {
      expect(p.col).toBeGreaterThanOrEqual(1);
      expect(p.row).toBeGreaterThanOrEqual(1);
      expect(p.col + p.w - 1).toBeLessThanOrEqual(DOLL_COLS);
      expect(p.row + p.h - 1).toBeLessThanOrEqual(DOLL_ROWS);
      for (let c = p.col; c < p.col + p.w; c++)
        for (let r = p.row; r < p.row + p.h; r++) {
          expect(taken.get(`${c},${r}`), `cell ${c},${r}`).toBeUndefined();
          taken.set(`${c},${r}`, p.slot);
        }
    }
    const slots = DOLL.map((p) => p.slot).sort((a, b) => a - b);
    expect(slots).toEqual([
      EquipmentSlot.HEAD,
      EquipmentSlot.NECK,
      EquipmentSlot.BACKPACK,
      EquipmentSlot.ARMOR,
      EquipmentSlot.RIGHT_HAND,
      EquipmentSlot.LEFT_HAND,
      EquipmentSlot.LEGS,
      EquipmentSlot.FEET,
      EquipmentSlot.RING,
      EquipmentSlot.AMMO,
    ]);
  });

  it("follows the spec: the body down the middle, the hands at the sides, small ring and neck", () => {
    const at = (slot: EquipmentSlot) => DOLL.find((p) => p.slot === slot);
    expect(at(EquipmentSlot.HEAD)).toMatchObject({ col: 4, row: 1, w: 2, h: 2 });
    expect(at(EquipmentSlot.NECK)).toMatchObject({ col: 6, row: 2, w: 1, h: 1 });
    expect(at(EquipmentSlot.LEFT_HAND)).toMatchObject({ col: 1, row: 2, w: 2, h: 4 });
    expect(at(EquipmentSlot.ARMOR)).toMatchObject({ col: 4, row: 3, w: 2, h: 3 });
    expect(at(EquipmentSlot.RIGHT_HAND)).toMatchObject({ col: 7, row: 2, w: 2, h: 4 });
    expect(at(EquipmentSlot.RING)).toMatchObject({ col: 3, row: 6, w: 1, h: 1 });
    expect(at(EquipmentSlot.LEGS)).toMatchObject({ col: 4, row: 6, w: 2, h: 2 });
    expect(at(EquipmentSlot.BACKPACK)).toMatchObject({ col: 1, row: 7, w: 2, h: 2 });
    expect(at(EquipmentSlot.AMMO)).toMatchObject({ col: 7, row: 7, w: 2, h: 2 });
    expect(at(EquipmentSlot.FEET)).toMatchObject({ col: 4, row: 8, w: 2, h: 2 });
  });

  it("takes the largest even cell that fits the width, within its limits", () => {
    // The dock at 1280 px (300 px inside its window), at 1920 px and at 960 px.
    expect(dollCell(300)).toBe(34);
    expect(dollCell(364)).toBe(42);
    expect(dollCell(252)).toBe(28);
    expect(dollCell(10_000)).toBe(DOLL_MAX_CELL);
    expect(dollCell(0)).toBe(DOLL_MIN_CELL); // a hidden tab
    for (let w = 200; w <= 400; w++) {
      const cell = dollCell(w);
      expect(cell % 2).toBe(0);
      if (cell > DOLL_MIN_CELL) expect(dollSize(cell).width).toBeLessThanOrEqual(w);
    }
    expect(dollSize(34)).toEqual({ width: 8 * 34 + 7 * DOLL_GAP, height: 9 * 34 + 8 * DOLL_GAP });
  });

  it("sizes a slot by its cells and the gaps inside it", () => {
    const head = DOLL.find((p) => p.slot === EquipmentSlot.HEAD);
    const hand = DOLL.find((p) => p.slot === EquipmentSlot.LEFT_HAND);
    if (!head || !hand) throw new Error("no slot");
    expect(slotBox(head, 34)).toEqual({ width: 70, height: 70 });
    expect(slotBox(hand, 34)).toEqual({ width: 70, height: 4 * 34 + 3 * DOLL_GAP });
  });
});

describe("iconScale", () => {
  const icon = { width: 32, height: 32 };
  it("draws an icon at the largest whole scale its slot holds, never under 1x", () => {
    expect(iconScale({ width: 70, height: 70 }, icon)).toBe(2); // a 2x2 slot at 1280 px
    expect(iconScale({ width: 58, height: 58 }, icon)).toBe(1); // a 2x2 slot at 960 px
    expect(iconScale({ width: 70, height: 142 }, icon)).toBe(2); // a hand: the width decides
    expect(iconScale({ width: 34, height: 34 }, icon)).toBe(1);
    expect(iconScale({ width: 26, height: 26 }, icon)).toBe(1); // spills, pixel for pixel
    expect(iconScale({ width: 100, height: 100 }, icon)).toBe(3);
    expect(iconScale({ width: 70, height: 70 }, { width: 64, height: 64 })).toBe(1);
  });
});

describe("slotAccepts (docs/17 UI-5: the slots that take a held item glow)", () => {
  it("knows the one slot of each kind, as the server's slotFor", () => {
    expect(wornIn(sword)).toBe(EquipmentSlot.RIGHT_HAND);
    expect(wornIn(shield)).toBe(EquipmentSlot.LEFT_HAND);
    expect(wornIn(armor("head"))).toBe(EquipmentSlot.HEAD);
    expect(wornIn(armor("body"))).toBe(EquipmentSlot.ARMOR);
    expect(wornIn(armor("legs"))).toBe(EquipmentSlot.LEGS);
    expect(wornIn(armor("feet"))).toBe(EquipmentSlot.FEET);
    expect(wornIn(armor("neck"))).toBe(EquipmentSlot.NECK);
    expect(wornIn(armor("ring"))).toBe(EquipmentSlot.RING);
    expect(wornIn(arrows)).toBe(EquipmentSlot.AMMO);
    expect(wornIn(backpack)).toBe(EquipmentSlot.BACKPACK);
    expect(wornIn(fish)).toBeUndefined();
    expect(wornIn(corpse)).toBeUndefined(); // nobody picks it up
    expect(wornIn(undefined)).toBeUndefined();
  });

  it("accepts an item only in its slot", () => {
    for (const p of DOLL) {
      expect(slotAccepts(sword, p.slot)).toBe(p.slot === EquipmentSlot.RIGHT_HAND);
      expect(slotAccepts(backpack, p.slot)).toBe(p.slot === EquipmentSlot.BACKPACK);
      expect(slotAccepts(fish, p.slot)).toBe(false);
      expect(slotAccepts(undefined, p.slot)).toBe(false);
    }
    // A sword is not a shield: the left hand refuses it (the server says the same).
    expect(slotAccepts(sword, EquipmentSlot.LEFT_HAND)).toBe(false);
    expect(slotAccepts(shield, EquipmentSlot.LEFT_HAND)).toBe(true);
  });
});

describe("capacityLoad", () => {
  it("is what is carried over the maximum, warning from 85 % and full at 0 free", () => {
    expect(capacityLoad(66000, 66000)).toEqual({ fraction: 0, level: "ok" });
    expect(capacityLoad(41250, 66000)).toEqual({ fraction: 0.375, level: "ok" });
    expect(capacityLoad(66000 * (1 - HEAVY_LOAD), 66000).level).toBe("heavy");
    expect(capacityLoad(0, 66000)).toEqual({ fraction: 1, level: "full" });
    expect(capacityLoad(-5, 66000)).toEqual({ fraction: 1, level: "full" });
    expect(capacityLoad(0, 0)).toEqual({ fraction: 1, level: "full" });
  });
});
