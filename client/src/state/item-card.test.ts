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
    // A ring of bands 3 and 4 (lote 11) has armor 0: no "Armor 0" line, like a weapon's
    // defense 0; its type line still says where it goes.
    const ring: ItemDef = { ...base, kind: "armor", armor: { slot: "ring", armor: 0 } };
    expect(itemCard(ring, 1, 1).stats).toEqual([]);
    expect(itemCard(ring, 1, 1).type).toEqual(["client.card.kind.armor", "client.card.slot.ring"]);
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
    // docs/17 UI-6: money's name is gold in the tooltip.
    expect(itemCard({ ...base, kind: "currency" }, 1, 1).currency).toBe(true);
    expect(itemCard(sword, 7, 1).currency).toBeUndefined();
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
    // name, type, 3 stats in 2 rows, the attribute it rolls, 1 requirement, 3 lines of
    // description.
    expect(cardLines(card, true)).toBe(1 + 1 + 2 + 1 + 1 + 3);
    expect(cardLines(card, false)).toBe(8);
  });
});

// docs/02 "Atributos de items": an instance's attribute is a line of its own.
describe("itemCard's attribute", () => {
  const attributes = { attack: { text: "attribute.attack" }, armor: { text: "attribute.armor" } };
  it("an instance with an attribute: its text and value", () => {
    const card = itemCard(
      sword,
      7,
      1,
      {},
      { attribute: "attack", value: 3, refine: 0 },
      attributes,
    );
    expect(card.attribute).toEqual({ text: "attribute.attack", value: 3 });
  });
  it("an equipable without one (a shop's) says it rolls one", () => {
    expect(itemCard(sword, 7, 1).attribute).toEqual({ random: true });
    const tunic: ItemDef = { ...base, kind: "armor", armor: { slot: "body", armor: 2 } };
    expect(itemCard(tunic, 8, 1, {}, undefined, attributes).attribute).toEqual({ random: true });
  });
  it("in the market (any instance) it says each piece has its own, not that it rolls", () => {
    expect(itemCard(sword, 7, 1, {}, undefined, attributes, true).attribute).toEqual({ any: true });
    // An instance shown there is still that instance.
    const own = itemCard(
      sword,
      7,
      1,
      {},
      { attribute: "attack", value: 3, refine: 0 },
      attributes,
      true,
    );
    expect(own.attribute).toEqual({ text: "attribute.attack", value: 3 });
  });
  it("an attribute retired from the pool says so (without the pool, nothing)", () => {
    const gone = { attribute: "gone", value: 2, refine: 0 };
    expect(itemCard(sword, 7, 1, {}, gone, attributes).attribute).toEqual({ retired: true });
    expect(itemCard(sword, 7, 1, {}, gone).attribute).toBeUndefined();
  });
  it("never on a stack, ammo, a container or a consumable", () => {
    const stack: ItemDef = { ...base, kind: "material", stackable: true };
    const arrows: ItemDef = {
      ...base,
      kind: "ammo",
      stackable: true,
      ammo: { type: "arrow", attack: 9 },
    };
    const bag: ItemDef = { ...base, kind: "container", slots: 8 };
    for (const d of [stack, arrows, bag]) expect(itemCard(d, 9, 3).attribute).toBeUndefined();
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

describe('a refined instance (the forge, docs/02 "Forja")', () => {
  const forge = {
    station: 95,
    safeLevel: 4,
    protection: 274,
    smithingBonus: { perLevels: 6, max: 5 },
    jewelryPct: 10,
    levels: [{ chance: 100, stones: 1 }],
    bands: [
      { level: 1, stone: 271, gold: 3, attack: 0.5, armor: 0.2, defense: 0.3 },
      { level: 5, stone: 271, gold: 12, attack: 0.7, armor: 0.2, defense: 0.4 },
    ],
  };

  it("says its level and what it adds; a plain one says nothing", () => {
    const mods = { attribute: "attack", value: 2, refine: 7 };
    expect(itemCard(sword, 20, 1, {}, mods, undefined, false, forge).refine).toEqual({
      level: 7,
      kind: "attack",
      gain: 4,
    });
    // Without the forge's rules, the level alone.
    expect(itemCard(sword, 20, 1, {}, mods).refine).toEqual({ level: 7, kind: "attack", gain: 0 });
    expect(
      itemCard(sword, 20, 1, {}, { ...mods, refine: 0 }, undefined, false, forge).refine,
    ).toBeUndefined();
    const ring: ItemDef = { ...base, kind: "armor", armor: { slot: "ring", armor: 0 } };
    expect(
      itemCard(
        ring,
        21,
        1,
        {},
        { attribute: "max_health", value: 20, refine: 5 },
        undefined,
        false,
        forge,
      ).refine,
    ).toEqual({ level: 5, kind: "jewel", gain: 10 });
  });
});
