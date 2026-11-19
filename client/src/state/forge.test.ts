import { describe, expect, it } from "vitest";
import { EquipmentSlot, RefineOutcome } from "@rpg/protocol";
import type { ClientContent, ForgeRules, ItemDef } from "../content-types.ts";
import {
  attemptStep,
  forgeBand,
  forgeCandidates,
  forgeChance,
  forgeView,
  refineGain,
  refineKind,
  refineOutcome,
  refinedName,
  sameLoc,
  smithingBonus,
} from "./forge.ts";
import type { StationState } from "./recipes.ts";

// data/balance.yaml forge, with numeric ids: stones 271-273, the amber 274.
const RULES: ForgeRules = {
  station: 95,
  safeLevel: 4,
  protection: 274,
  smithingBonus: { perLevels: 6, max: 5 },
  jewelryPct: 10,
  levels: [100, 100, 100, 100, 70, 55, 40, 25, 15, 8].map((chance, i) => ({
    chance,
    stones: i < 4 ? 1 : i < 7 ? 2 : 3,
  })),
  bands: [
    { level: 1, stone: 271, gold: 3, attack: 0.5, armor: 0.2, defense: 0.3 },
    { level: 5, stone: 271, gold: 12, attack: 0.7, armor: 0.2, defense: 0.4 },
    { level: 10, stone: 272, gold: 40, attack: 1, armor: 0.3, defense: 0.6 },
    { level: 30, stone: 272, gold: 120, attack: 1.4, armor: 0.3, defense: 0.8 },
    { level: 50, stone: 273, gold: 300, attack: 1.8, armor: 0.4, defense: 1 },
    { level: 75, stone: 273, gold: 700, attack: 2.2, armor: 0.5, defense: 1.2 },
  ],
};

const def = (id: string, extra: Partial<ItemDef>): ItemDef => ({
  id,
  sprite: "",
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
  ...extra,
});

const weapon = {
  type: "sword",
  attack: 30,
  defense: 15,
  hands: 1,
  range: 0,
  element: "",
  ammo: "",
};
const ITEMS: Record<number, ItemDef> = {
  1: def("embersteel_sabre", { weapon, requires: { level: 30, vocations: [] } }),
  2: def("sailcloth_cap", { armor: { slot: "head", armor: 1 } }),
  3: def("plank_shield", { shield: { defense: 12 }, requires: { level: 5, vocations: [] } }),
  4: def("briar_ring", { armor: { slot: "ring", armor: 0 } }),
  5: def("arrow", { stackable: true, ammo: { type: "arrow", attack: 9 } }),
  6: def("backpack", { slots: 20 }),
  7: def("tidesteel_sword", { weapon, requires: { level: 80, vocations: [] } }),
};
const content = { items: ITEMS } as unknown as ClientContent;

const station = (owned: [number, number][], money: number): StationState => ({
  pos: { x: 0, y: 0, z: 7 },
  itemId: 95,
  owned: new Map(owned),
  tools: new Set(),
  money,
});

describe("the forge's rules on the client (server/internal/content/forge.go)", () => {
  it("knows what each item raises, and that ammo and containers are not taken", () => {
    expect(refineKind(ITEMS[1])).toBe("attack");
    expect(refineKind(ITEMS[2])).toBe("armor");
    expect(refineKind(ITEMS[3])).toBe("defense");
    expect(refineKind(ITEMS[4])).toBe("jewel");
    expect(refineKind(ITEMS[5])).toBeUndefined();
    expect(refineKind(ITEMS[6])).toBeUndefined();
  });

  it("picks the band by requires.level and adds the smithing bonus only where it can fail", () => {
    expect(forgeBand(RULES, 0).stone).toBe(271);
    expect(forgeBand(RULES, 15).stone).toBe(272);
    expect(forgeBand(RULES, 80).gold).toBe(700);
    expect(smithingBonus(RULES, 11)).toBe(1);
    expect(smithingBonus(RULES, 99)).toBe(5);
    expect(forgeChance(RULES, 3, 30)).toBe(100);
    expect(forgeChance(RULES, 5, 0)).toBe(70);
    expect(forgeChance(RULES, 5, 30)).toBe(75);
    expect(forgeChance(RULES, 10, 30)).toBe(13);
  });

  it("gains floor(level × the band's value), a jewel a share of its attribute", () => {
    expect(refineGain(RULES, ITEMS[1] as ItemDef, 7)).toBe(9);
    expect(refineGain(RULES, ITEMS[7] as ItemDef, 10)).toBe(22);
    expect(refineGain(RULES, ITEMS[2] as ItemDef, 4)).toBe(0);
    expect(refineGain(RULES, ITEMS[2] as ItemDef, 5)).toBe(1);
    expect(refineGain(RULES, ITEMS[3] as ItemDef, 10)).toBe(4);
    expect(refineGain(RULES, ITEMS[4] as ItemDef, 5, 20)).toBe(10);
    expect(refineGain(RULES, ITEMS[1] as ItemDef, 0)).toBe(0);
  });
});

describe("forgeView", () => {
  const sabre = { itemId: 1, mods: { attribute: "attack", value: 3, refine: 6 } };

  it("shows the next level, the chance, the cost and the gain", () => {
    const v = forgeView(
      RULES,
      content,
      station(
        [
          [272, 5],
          [274, 1],
        ],
        5000,
      ),
      sabre,
      12,
      false,
    );
    expect(v).toMatchObject({
      level: 6,
      next: 7,
      top: 10,
      risky: true,
      chance: 42,
      bonus: 2,
      gold: 840,
      money: 5000,
      stone: { itemId: 272, need: 2, have: 5 },
      protection: { itemId: 274, have: 1 },
      gain: { kind: "attack", now: 8, next: 9 },
      blocks: [],
    });
    expect(v && attemptStep(v)).toBe("confirm");
  });

  it("a safe level goes at once and has no bonus", () => {
    const cap = { itemId: 2, mods: { attribute: "armor", value: 1, refine: 2 } };
    const v = forgeView(RULES, content, station([[271, 1]], 9), cap, 30, true);
    expect(v).toMatchObject({ next: 3, risky: false, chance: 100, bonus: 0, gold: 9, blocks: [] });
    expect(v && attemptStep(v)).toBe("send");
  });

  it("says what is missing: stones, the protection asked for, money; a +10 goes no further", () => {
    const v = forgeView(RULES, content, station([[272, 1]], 100), sabre, 0, true);
    expect(v?.blocks).toEqual(["stones", "protection", "money"]);
    const top = forgeView(
      RULES,
      content,
      station([], 0),
      { itemId: 1, mods: { attribute: "attack", value: 3, refine: 10 } },
      0,
      false,
    );
    expect(top?.blocks).toEqual(["top"]);
    expect(top?.chance).toBe(0);
    expect(forgeView(RULES, content, station([], 0), { itemId: 5 }, 0, false)).toBeUndefined();
  });
});

describe("forgeCandidates", () => {
  it("lists the worn items first, then each open container's, only what the forge takes", () => {
    const inventory = new Map([
      [
        EquipmentSlot.RIGHT_HAND,
        { itemId: 1, count: 1, mods: { attribute: "attack", value: 3, refine: 2 } },
      ],
      [EquipmentSlot.HEAD, { itemId: 2, count: 1 }],
      [EquipmentSlot.BACKPACK, { itemId: 6, count: 1 }],
      [EquipmentSlot.AMMO, { itemId: 5, count: 30 }],
    ]);
    const containers = [
      {
        id: 4,
        itemId: 6,
        capacity: 20,
        hasParent: false,
        items: [
          { itemId: 5, count: 3 },
          { itemId: 4, count: 1 },
        ],
      },
    ];
    const got = forgeCandidates(content, inventory, containers);
    expect(got.map((c) => [c.loc, c.itemId])).toEqual([
      [{ kind: "slot", slot: EquipmentSlot.HEAD }, 2],
      [{ kind: "slot", slot: EquipmentSlot.RIGHT_HAND }, 1],
      [{ kind: "container", id: 4, index: 1 }, 4],
    ]);
    expect(got[1]?.mods?.refine).toBe(2);
    expect(
      sameLoc({ kind: "container", id: 4, index: 1 }, { kind: "container", id: 4, index: 1 }),
    ).toBe(true);
    expect(
      sameLoc({ kind: "container", id: 4, index: 1 }, { kind: "slot", slot: EquipmentSlot.HEAD }),
    ).toBe(false);
  });
});

describe("names and results", () => {
  const t = (key: string, p?: Record<string, string | number>): string =>
    p ? `${key}${JSON.stringify(p)}` : key;

  it("names a refined item through i18n with its level, a plain one as it is", () => {
    expect(refinedName(t, "espada", 7)).toBe('client.item.refined{"level":7,"name":"espada"}');
    expect(refinedName(t, "espada", 0)).toBe("espada");
    expect(refinedName(t, "espada", undefined)).toBe("espada");
  });

  it("reads the protocol's outcome", () => {
    expect(refineOutcome(RefineOutcome.SUCCESS)).toBe("success");
    expect(refineOutcome(RefineOutcome.BROKEN)).toBe("broken");
    expect(refineOutcome(RefineOutcome.PROTECTED)).toBe("protected");
  });
});
