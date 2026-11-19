import { describe, expect, it } from "vitest";
import { EquipmentSlot, InventorySchema, create } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import { sameLoc, sameRef } from "../input/actions.ts";
import { forgeCandidates, sameLoc as forgeSameLoc } from "./forge.ts";
import { locKey, locationInit } from "./items.ts";
import { NO_POCKETS, pocketCells, pocketOffers, pocketRef } from "./pockets.ts";
import { WorldState } from "./world.ts";

const content = {
  items: {
    8: { id: "copper_coin", tradeable: true, stackable: true },
    48: { id: "backpack", slots: 20, tradeable: true },
    60: { id: "iron_sword", tradeable: true, weapon: { type: "sword", attack: 13 } },
    70: { id: "quest_note", tradeable: false },
  },
  forge: undefined,
} as unknown as ClientContent;

describe("pockets (docs/02 Bolsillos)", () => {
  it("follow the Inventory: how many cells and what they hold, the equipment apart", () => {
    const w = new WorldState(content);
    expect(w.pockets).toEqual(NO_POCKETS);
    w.apply(
      {
        case: "inventory",
        value: create(InventorySchema, {
          slots: [{ slot: EquipmentSlot.RIGHT_HAND, item: { itemId: 60 } }],
          pockets: [{ itemId: 8, count: 40 }, { itemId: 70 }],
          pocketSlots: 4,
        }),
      },
      0,
    );
    expect(w.pockets).toEqual({
      capacity: 4,
      items: [
        { itemId: 8, count: 40 },
        { itemId: 70, count: 0 },
      ],
    });
    expect(w.inventory.size).toBe(1);
    // A death took what they held: the next Inventory empties them, the cells stay.
    w.apply({ case: "inventory", value: create(InventorySchema, { pocketSlots: 4 }) }, 0);
    expect(w.pockets).toEqual({ capacity: 4, items: [] });
  });

  it("draw one cell per pocket, and one for each item past them", () => {
    expect(pocketCells(NO_POCKETS)).toEqual([]);
    expect(pocketCells({ capacity: 4, items: [{ itemId: 8, count: 3 }] })).toEqual([
      { itemId: 8, count: 3 },
      undefined,
      undefined,
      undefined,
    ]);
    const over = {
      capacity: 1,
      items: [
        { itemId: 8, count: 3 },
        { itemId: 70, count: 0 },
      ],
    };
    expect(pocketCells(over)).toHaveLength(2);
  });

  it("address a cell as ItemLocation.pocket", () => {
    const ref = pocketRef(
      { itemId: 60, count: 0, mods: { attribute: "attack", value: 2, refine: 0 } },
      2,
    );
    expect(ref).toEqual({
      loc: { kind: "pocket", index: 2 },
      itemId: 60,
      stackIndex: 2,
      count: 0,
      mods: { attribute: "attack", value: 2, refine: 0 },
    });
    expect(locationInit(ref.loc)).toEqual({ location: { case: "pocket", value: 2 } });
    expect(locationInit({ kind: "pocket", index: 0 })).toEqual({
      location: { case: "pocket", value: 0 },
    });
    expect(locKey(ref.loc)).toBe("pocket:2");
    expect(sameLoc(ref.loc, { kind: "pocket", index: 2 })).toBe(true);
    expect(sameLoc(ref.loc, { kind: "pocket", index: 1 })).toBe(false);
    expect(sameLoc(ref.loc, { kind: "container", id: 2, index: 2 })).toBe(false);
    expect(forgeSameLoc(ref.loc, { kind: "pocket", index: 2 })).toBe(true);
    expect(sameRef(ref, pocketRef({ itemId: 60, count: 0 }, 2))).toBe(true);
  });

  it("offer their tradeable items to a trade, cell by cell", () => {
    const offers = pocketOffers(
      {
        capacity: 4,
        items: [
          { itemId: 70, count: 0 },
          { itemId: 8, count: 12 },
        ],
      },
      content,
    );
    expect(offers.map((o) => [o.itemId, o.count, o.ref.loc])).toEqual([
      [8, 12, { kind: "pocket", index: 1 }],
    ]);
  });

  it("show their pieces to the forge, after the equipment", () => {
    const forge = {
      ...content,
      forge: { bands: [], stones: [] },
    } as unknown as ClientContent;
    const got = forgeCandidates(
      forge,
      new Map([[EquipmentSlot.RIGHT_HAND, { itemId: 60, count: 0 }]]),
      [],
      [
        { itemId: 8, count: 3 },
        { itemId: 60, count: 0 },
      ],
    );
    expect(got.map((c) => c.loc)).toEqual([
      { kind: "slot", slot: EquipmentSlot.RIGHT_HAND },
      { kind: "pocket", index: 1 },
    ]);
  });
});
