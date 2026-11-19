import { describe, expect, it } from "vitest";
import { EquipmentSlot, RefineOutcome } from "@rpg/protocol";
import type { ClientContent, ForgeRules, ItemDef } from "../content-types.ts";
import {
  attemptStep,
  chosenPiece,
  forgeBand,
  forgeCandidates,
  forgeChance,
  forgeView,
  IN_FLIGHT_MS,
  refineGain,
  refineInFlight,
  refineKind,
  refineMessage,
  refineOutcome,
  refinedName,
  sameLoc,
  sameMods,
  smithingBonus,
} from "./forge.ts";
import type { ForgeCandidate, RefineState } from "./forge.ts";
import type { StationState } from "./recipes.ts";

// data/balance.yaml forge, with numeric ids: stones 306-308, the amber 309.
const RULES: ForgeRules = {
  station: 95,
  safeLevel: 4,
  protection: 309,
  smithingBonus: { skill: "smithing", perLevels: 6, max: 5 },
  jewelryPct: 10,
  levels: [100, 100, 100, 100, 70, 55, 40, 25, 15, 8].map((chance, i) => ({
    chance,
    stones: i < 4 ? 1 : i < 7 ? 2 : 3,
  })),
  bands: [
    { level: 1, stone: 306, gold: 3, attack: 0.5, armor: 0.2, defense: 0.3 },
    { level: 5, stone: 306, gold: 12, attack: 0.7, armor: 0.2, defense: 0.4 },
    { level: 10, stone: 307, gold: 40, attack: 1, armor: 0.3, defense: 0.6 },
    { level: 30, stone: 307, gold: 120, attack: 1.4, armor: 0.3, defense: 0.8 },
    { level: 50, stone: 308, gold: 300, attack: 1.8, armor: 0.4, defense: 1 },
    { level: 75, stone: 308, gold: 700, attack: 2.2, armor: 0.5, defense: 1.2 },
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
    expect(forgeBand(RULES, 0).stone).toBe(306);
    expect(forgeBand(RULES, 15).stone).toBe(307);
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
          [307, 5],
          [309, 1],
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
      stone: { itemId: 307, need: 2, have: 5 },
      protection: { itemId: 309, have: 1 },
      gain: { kind: "attack", now: 8, next: 9 },
      blocks: [],
    });
    expect(v && attemptStep(v)).toBe("confirm");
  });

  it("a safe level goes at once and has no bonus", () => {
    const cap = { itemId: 2, mods: { attribute: "armor", value: 1, refine: 2 } };
    const v = forgeView(RULES, content, station([[306, 1]], 9), cap, 30, true);
    expect(v).toMatchObject({ next: 3, risky: false, chance: 100, bonus: 0, gold: 9, blocks: [] });
    expect(v && attemptStep(v)).toBe("send");
  });

  it("says what is missing: stones, money; a +10 goes no further", () => {
    const v = forgeView(RULES, content, station([[307, 1]], 100), sabre, 0, false);
    expect(v?.blocks).toEqual(["stones", "money"]);
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

describe("the protection toggle", () => {
  const sabre = { itemId: 1, mods: { attribute: "attack", value: 3, refine: 6 } };
  const rich = (ambers: number): StationState =>
    station(
      [
        [307, 5],
        [309, ambers],
      ],
      5000,
    );

  it("goes in the attempt when asked for where it counts and carried", () => {
    expect(forgeView(RULES, content, rich(1), sabre, 0, true)).toMatchObject({
      protect: true,
      blocks: [],
    });
    expect(forgeView(RULES, content, rich(1), sabre, 0, false)?.protect).toBe(false);
    // A safe level: nothing to protect, nothing spent.
    const safe = { itemId: 1, mods: { attribute: "attack", value: 3, refine: 1 } };
    expect(forgeView(RULES, content, rich(1), safe, 0, true)?.protect).toBe(false);
  });

  it("left on after the last amber was spent: off, never a block (the toggle hides)", () => {
    // The StationOpen after an attempt says 0 ambers while the toggle's state is still on:
    // the window must not lock its button nor promise the amber's safety.
    const v = forgeView(RULES, content, rich(0), sabre, 0, true);
    expect(v).toMatchObject({ protect: false, blocks: [], protection: { have: 0 } });
  });
});

describe("the chosen piece", () => {
  const mods = (refine: number, value = 3) => ({ attribute: "attack", value, refine });
  const at = (index: number, m = mods(6)): ForgeCandidate => ({
    loc: { kind: "container", id: 4, index },
    itemId: 1,
    mods: m,
  });
  const result = (outcome: RefineState["outcome"], refine: number, t: number): RefineState => ({
    outcome,
    level: refine,
    itemId: 1,
    mods: outcome === "broken" ? undefined : mods(refine),
    from: 6,
    at: t,
  });

  it("is the piece at its place with the same item and mods", () => {
    const pick = at(1);
    expect(chosenPiece([at(0, mods(2)), at(1)], pick, undefined, 0)).toEqual(at(1));
    expect(chosenPiece([], pick, undefined, 0)).toBeUndefined();
    expect(chosenPiece([at(1)], undefined, undefined, 0)).toBeUndefined();
    expect(sameMods(undefined, { attribute: "", value: 0, refine: 0 })).toBe(true);
  });

  it("lets a broken piece go: the next one moving up into its place is not it", () => {
    const pick = at(1);
    // After the break, the bag's third sword (same item, same level, another roll) is at
    // index 1: even before the result it is not the chosen one.
    const shifted = [at(0, mods(2)), at(1, mods(6, 5))];
    expect(chosenPiece(shifted, pick, undefined, 0)).toBeUndefined();
    // Same item, level and roll in its place: only the result tells them apart.
    const twin = [at(0, mods(2)), at(1)];
    expect(chosenPiece(twin, pick, result("broken", 0, 20), 10)).toBeUndefined();
  });

  it("follows the level a success or a protected failure left it at", () => {
    const pick = at(1);
    expect(chosenPiece([at(1, mods(7))], pick, result("success", 7, 20), 10)).toEqual(
      at(1, mods(7)),
    );
    expect(chosenPiece([at(1, mods(5))], pick, result("protected", 5, 20), 10)).toEqual(
      at(1, mods(5)),
    );
    // A result from before the first attempt on this choice (another piece's) does not count.
    expect(chosenPiece([at(1)], pick, result("broken", 0, 5), 10)).toEqual(at(1));
    expect(chosenPiece([at(1)], pick, result("broken", 0, 5), 0)).toEqual(at(1));
  });
});

describe("the attempt on the wire", () => {
  const piece = (mods?: ForgeCandidate["mods"]): ForgeCandidate => ({
    loc: { kind: "container", id: 4, index: 1 },
    itemId: 1,
    mods,
  });

  it("names the piece with all of its mods, so the server never takes another one", () => {
    const m = refineMessage(
      { x: 1, y: 2, z: 7 },
      piece({ attribute: "attack", value: 3, refine: 4 }),
      true,
    );
    expect(m).toEqual({
      station: { x: 1, y: 2, z: 7 },
      item: { location: { case: "container", value: { containerId: 4, index: 1 } } },
      itemId: 1,
      mods: { attribute: "attack", value: 3, refine: 4 },
      protect: true,
    });
    // A plain piece goes without mods (the server reads none as a plain one).
    expect("mods" in refineMessage({ x: 1, y: 2, z: 7 }, piece(), false)).toBe(false);
  });

  it("waits for the answer: a result or a system message after it was sent, or the time out", () => {
    const result = (at: number): RefineState => ({
      outcome: "broken",
      level: 0,
      itemId: 1,
      mods: undefined,
      from: 4,
      at,
    });
    expect(refineInFlight(0, undefined, [], 50)).toBe(false); // nothing sent
    expect(refineInFlight(100, undefined, [], 150)).toBe(true);
    // An answer from before this attempt does not count.
    expect(refineInFlight(100, result(90), [{ at: 95 }], 150)).toBe(true);
    expect(refineInFlight(100, result(120), [], 150)).toBe(false);
    expect(refineInFlight(100, undefined, [{ at: 130 }], 150)).toBe(false); // refused
    expect(refineInFlight(100, undefined, [], 100 + IN_FLIGHT_MS)).toBe(false);
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
      // A corpse or a chest (top-level, not worn): the server would refuse its pieces.
      { id: 5, itemId: 99, capacity: 8, hasParent: false, items: [{ itemId: 1, count: 1 }] },
      // A bag inside another container: it may be carried.
      { id: 6, itemId: 98, capacity: 8, hasParent: true, items: [{ itemId: 2, count: 1 }] },
    ];
    const got = forgeCandidates(content, inventory, containers);
    expect(got.map((c) => [c.loc, c.itemId])).toEqual([
      [{ kind: "slot", slot: EquipmentSlot.HEAD }, 2],
      [{ kind: "slot", slot: EquipmentSlot.RIGHT_HAND }, 1],
      [{ kind: "container", id: 4, index: 1 }, 4],
      [{ kind: "container", id: 6, index: 0 }, 2],
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
