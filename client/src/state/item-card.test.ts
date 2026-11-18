import { EquipmentSlot } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ItemDef } from "../content-types.ts";
import { cardLines, equipSlot, groundCard, itemCard, shopCategory } from "./item-card.ts";

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
  tradeable: true,
  marketable: true,
};

const sword: ItemDef = {
  ...base,
  id: "iron_sword",
  kind: "weapon",
  weight: 3300,
  desc: "item.iron_sword.desc",
  weapon: { type: "sword", attack: 13, defense: 9, hands: 1, range: 0, element: "", ammo: "" },
  requires: { level: 5, vocations: [] },
};

describe("itemCard", () => {
  it("a weapon: its type line, attack, defense, weight, level and description", () => {
    const card = itemCard(sword, 7, 1, { level: 3 });
    expect(card.type).toEqual([
      "client.card.kind.weapon",
      "client.card.weapon.sword",
      "client.card.hands.one",
    ]);
    expect(card.stats).toEqual([
      { id: "attack", value: 13 },
      { id: "defense", value: 9 },
      { id: "weight", value: "33.00", total: undefined },
    ]);
    expect(card.requires).toEqual([{ id: "level", level: 5, met: false }]);
    expect(card.desc).toBe("item.iron_sword.desc");
    expect(card.marks).toEqual([]);
    expect(itemCard(sword, 7, 1, { level: 5 }).requires[0]?.met).toBe(true);
    // Who looks unknown: the requirement shows without a verdict.
    expect(itemCard(sword, 7, 1).requires[0]?.met).toBeUndefined();
  });

  it("a wand: range, element and the vocations it asks for", () => {
    const wand: ItemDef = {
      ...base,
      id: "coral_wand",
      kind: "weapon",
      weapon: {
        type: "wand",
        attack: 13,
        defense: 0,
        hands: 1,
        range: 4,
        element: "ice",
        ammo: "",
      },
      requires: { level: 6, vocations: ["arcanist"] },
    };
    const card = itemCard(wand, 1, 1, { level: 9, vocation: "guardian" });
    expect(card.stats.map((s) => s.id)).toEqual(["attack", "range"]);
    expect(card.effects).toEqual([{ id: "element", element: "ice" }]);
    expect(card.requires).toEqual([
      { id: "level", level: 6, met: true },
      { id: "vocations", vocations: ["arcanist"], met: false },
    ]);
  });

  it("a bow says what it shoots; an arrow stack weighs per unit and in all", () => {
    const bow: ItemDef = {
      ...base,
      kind: "weapon",
      weapon: {
        type: "distance",
        attack: 2,
        defense: 0,
        hands: 2,
        range: 5,
        element: "",
        ammo: "arrow",
      },
    };
    expect(itemCard(bow, 1, 1).type).toContain("client.card.hands.two");
    expect(itemCard(bow, 1, 1).effects).toEqual([{ id: "shoots", ammo: "arrow" }]);
    const arrow: ItemDef = {
      ...base,
      kind: "ammo",
      stackable: true,
      weight: 70,
      ammo: { type: "arrow", attack: 3 },
    };
    const card = itemCard(arrow, 2, 37);
    expect(card.count).toBe(37);
    expect(card.type).toEqual(["client.card.kind.ammo", "client.card.ammo.arrow"]);
    expect(card.stats).toContainEqual({ id: "weight", value: "0.70", total: "25.90" });
  });

  it("food heals and feeds; a rune names its spell, charges and magic level", () => {
    const fish: ItemDef = {
      ...base,
      kind: "consumable",
      consumable: { healHp: 0, healMp: 0, foodMs: 60000 },
    };
    expect(itemCard(fish, 1, 1).type).toEqual(["client.card.kind.consumable", "client.card.food"]);
    expect(itemCard(fish, 1, 1).effects).toEqual([{ id: "food", seconds: 60 }]);
    const potion: ItemDef = {
      ...base,
      kind: "consumable",
      consumable: { healHp: 0, healMp: 75, foodMs: 0 },
    };
    expect(itemCard(potion, 1, 1).effects).toEqual([{ id: "heal_mp", value: 75 }]);
    const rune: ItemDef = {
      ...base,
      kind: "rune",
      rune: { spell: "ember_bolt", charges: 3, magicLevel: 4 },
    };
    const card = itemCard(rune, 1, 1, { magicLevel: 2 });
    expect(card.stats).toEqual([{ id: "charges", value: 3 }]);
    expect(card.effects).toEqual([{ id: "rune", spell: "ember_bolt" }]);
    expect(card.requires).toEqual([{ id: "magic", level: 4, met: false }]);
  });

  it("armor, shields and containers", () => {
    const helm: ItemDef = { ...base, kind: "armor", armor: { slot: "head", armor: 2 } };
    expect(itemCard(helm, 1, 1).type).toEqual(["client.card.kind.armor", "client.card.slot.head"]);
    expect(itemCard(helm, 1, 1).stats).toEqual([{ id: "armor", value: 2 }]);
    const shield: ItemDef = { ...base, kind: "shield", shield: { defense: 12 } };
    expect(itemCard(shield, 1, 1).stats).toEqual([{ id: "defense", value: 12 }]);
    const bag: ItemDef = { ...base, kind: "container", slots: 20, weight: 1800 };
    expect(itemCard(bag, 1, 1).stats.map((s) => s.id)).toEqual(["slots", "weight"]);
  });

  it("marks what cannot be traded or sold on the market; never the map's fixtures", () => {
    expect(itemCard({ ...sword, tradeable: false }, 1, 1).marks).toEqual([
      "client.card.mark.no_trade",
    ]);
    expect(itemCard({ ...sword, marketable: false }, 1, 1).marks).toEqual([
      "client.card.mark.no_market",
    ]);
    // Money is not sold on the market and needs no mark; a station is not carried.
    expect(itemCard({ ...base, kind: "currency", marketable: false }, 1, 1).marks).toEqual([]);
    const forge: ItemDef = { ...base, kind: "decoration", weight: 90000, tradeable: false };
    expect(itemCard(forge, 1, 1).marks).toEqual([]);
    expect(itemCard(forge, 1, 1).stats).toEqual([]);
  });

  it("a quest item takes the quest colour and says so with a mark (docs/17 UI-6)", () => {
    const tally: ItemDef = { ...base, kind: "material", tradeable: false, quest: true };
    const card = itemCard(tally, 3, 4);
    expect(card.quest).toBe(true);
    expect(card.marks).toEqual(["client.card.mark.quest", "client.card.mark.no_trade"]);
    expect(itemCard(sword, 1, 1).quest).toBeUndefined();
    expect(itemCard(sword, 1, 1).marks).not.toContain("client.card.mark.quest");
  });

  it("a card over the map only for what people carry, never the map itself", () => {
    expect(groundCard(sword)).toBe(true);
    expect(groundCard({ ...base, kind: "currency" })).toBe(true);
    expect(groundCard({ ...base, kind: "wall" })).toBe(false);
    expect(groundCard({ ...base, kind: "decoration" })).toBe(false);
    expect(groundCard({ ...base, kind: "container", fixed: true })).toBe(false); // a station
    expect(groundCard(undefined)).toBe(false);
  });

  it("an unknown item gets an empty card", () => {
    const card = itemCard(undefined, 999, 0);
    expect(card).toMatchObject({ itemId: 999, id: "", count: 1, type: [], stats: [] });
  });

  it("counts the lines it takes (the menu and the tooltip place it before drawing)", () => {
    const card = itemCard(sword, 7, 1, { level: 3 });
    // name, type, 3 stats in 2 rows, 1 requirement, 3 lines of description.
    expect(cardLines(card, true)).toBe(1 + 1 + 2 + 1 + 3);
    expect(cardLines(card, false)).toBe(7);
  });
});

describe("shopCategory and equipSlot", () => {
  it("files each kind under a shop filter", () => {
    expect(shopCategory(sword)).toBe("weapons");
    expect(shopCategory({ ...base, kind: "ammo" })).toBe("weapons");
    expect(shopCategory({ ...base, kind: "shield" })).toBe("armor");
    expect(shopCategory({ ...base, kind: "tool" })).toBe("tools");
    expect(shopCategory({ ...base, kind: "container" })).toBe("tools");
    expect(shopCategory({ ...base, kind: "rune" })).toBe("consumables");
    expect(shopCategory({ ...base, kind: "material" })).toBe("materials");
    expect(shopCategory(undefined)).toBe("materials");
  });

  it("knows the slot of each piece of equipment (docs/02 Items)", () => {
    expect(equipSlot(sword)).toBe(EquipmentSlot.RIGHT_HAND);
    expect(equipSlot({ ...base, shield: { defense: 1 } })).toBe(EquipmentSlot.LEFT_HAND);
    expect(equipSlot({ ...base, ammo: { type: "arrow", attack: 1 } })).toBe(EquipmentSlot.AMMO);
    expect(equipSlot({ ...base, armor: { slot: "body", armor: 1 } })).toBe(EquipmentSlot.ARMOR);
    expect(equipSlot({ ...base, armor: { slot: "feet", armor: 1 } })).toBe(EquipmentSlot.FEET);
    expect(equipSlot({ ...base, kind: "material" })).toBeUndefined();
    expect(equipSlot(undefined)).toBeUndefined();
  });
});
