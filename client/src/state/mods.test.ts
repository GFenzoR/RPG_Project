// Item attributes on the wire (docs/05 ItemMods, docs/02 "Atributos de items"): what the
// client keeps of an instance's mods and how a DOM item names them for its card.
import { ContainerOpenSchema, InventorySchema, ItemStackSchema, create } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent } from "../content-types.ts";
import { modsOf, parseTipMods, sameMods, tipMods } from "./mods.ts";
import { WorldState } from "./world.ts";

describe("item mods", () => {
  it("keeps an ItemStack's mods; a plain item has none", () => {
    const sword = create(ItemStackSchema, {
      itemId: 60,
      mods: { attribute: "attack", value: 3, refine: 0 },
    });
    expect(modsOf(sword)).toEqual({ attribute: "attack", value: 3, refine: 0 });
    expect(modsOf(create(ItemStackSchema, { itemId: 68, count: 5 }))).toBeUndefined();
    expect(modsOf(create(ItemStackSchema, { itemId: 1, mods: {} }))).toBeUndefined();
  });

  it("keeps the mods of the equipment and of an open container", () => {
    const w = new WorldState({ items: {} } as unknown as ClientContent);
    w.apply(
      {
        case: "inventory",
        value: create(InventorySchema, {
          slots: [{ slot: 5, item: { itemId: 60, mods: { attribute: "life_leech", value: 2 } } }],
        }),
      },
      0,
    );
    w.apply(
      {
        case: "containerOpen",
        value: create(ContainerOpenSchema, {
          containerId: 1,
          itemId: 66,
          capacity: 4,
          items: [
            { itemId: 63, mods: { attribute: "armor", value: 1, refine: 2 } },
            { itemId: 68, count: 7 },
          ],
        }),
      },
      0,
    );
    expect(w.inventory.get(5)).toEqual({
      itemId: 60,
      count: 0,
      mods: { attribute: "life_leech", value: 2, refine: 0 },
    });
    const c = w.containers.find((x) => x.id === 1);
    expect(c?.items).toEqual([
      { itemId: 63, count: 0, mods: { attribute: "armor", value: 1, refine: 2 } },
      { itemId: 68, count: 7 },
    ]);
  });

  it("names them in data-tip-mods and reads them back", () => {
    const m = { attribute: "fire_protection", value: 4, refine: 1 };
    expect(tipMods(m)).toBe("fire_protection:4:1");
    expect(parseTipMods(tipMods(m))).toEqual(m);
    expect(tipMods(undefined)).toBeUndefined();
    expect(parseTipMods(undefined)).toBeUndefined();
    expect(parseTipMods("")).toBeUndefined();
    expect(parseTipMods("attack")).toBeUndefined();
    expect(parseTipMods("attack:x:0")).toBeUndefined();
    expect(sameMods(m, { ...m })).toBe(true);
    expect(sameMods(m, { ...m, value: 5 })).toBe(false);
    expect(sameMods(undefined, undefined)).toBe(true);
  });
});
