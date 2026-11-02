import {
  ContainerCloseSchema,
  ContainerOpenSchema,
  ContainerUpdateSchema,
  EquipmentSlot,
  InventorySchema,
  TileUpdateSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ClientContent, ItemDef } from "../content-types.ts";
import { translator } from "../i18n/i18n.ts";
import { formatOz, locationInit, topItem } from "./items.ts";
import { formatMessage } from "./messages.ts";
import { WorldState } from "./world.ts";

type Msg = ServerMessage["message"];

const def = (id: string, more: Partial<ItemDef> = {}): ItemDef => ({
  id,
  sprite: "",
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
  ...more,
});

const content: ClientContent = {
  items: {
    1: def("grass", { ground: true, walkable: true }),
    8: def("copper_coin", { stackable: true }),
    20: def("iron_sword"),
    48: def("backpack", { slots: 20 }),
  },
  monsterSprites: {},
  vocations: [],
  spells: [],
  movement: { baseStepMs: 1000, diagonalCost: 1.5, maxPathTiles: 100 },
  i18n: {},
};

describe("inventory state", () => {
  it("keeps equipment, open containers and tile stack sizes", () => {
    const w = new WorldState(content);
    const apply = (m: Msg): void => w.apply(m, 0);
    apply({
      case: "inventory",
      value: create(InventorySchema, {
        slots: [{ slot: EquipmentSlot.BACKPACK, item: { itemId: 48 } }],
      }),
    });
    expect(w.inventory.get(EquipmentSlot.BACKPACK)).toEqual({ itemId: 48, count: 0 });

    apply({
      case: "containerOpen",
      value: create(ContainerOpenSchema, {
        containerId: 3,
        itemId: 48,
        capacity: 20,
        items: [{ itemId: 8, count: 12 }],
      }),
    });
    apply({
      case: "containerUpdate",
      value: create(ContainerUpdateSchema, { containerId: 3, items: [{ itemId: 20 }] }),
    });
    expect(w.containers).toEqual([
      { id: 3, itemId: 48, capacity: 20, items: [{ itemId: 20, count: 0 }], hasParent: false },
    ]);
    apply({ case: "containerClose", value: create(ContainerCloseSchema, { containerId: 3 }) });
    expect(w.containers).toEqual([]);

    apply({
      case: "tileUpdate",
      value: create(TileUpdateSchema, {
        pos: { x: 5, y: 6, z: 7 },
        tile: { items: [{ itemId: 1 }, { itemId: 8, count: 30 }] },
      }),
    });
    expect(topItem(w, 5, 6, 7, false)).toEqual({
      loc: { kind: "pos", pos: { x: 5, y: 6, z: 7 } },
      itemId: 8,
      stackIndex: 1,
      count: 30,
    });
    apply({
      case: "tileUpdate",
      value: create(TileUpdateSchema, {
        pos: { x: 5, y: 6, z: 7 },
        tile: { items: [{ itemId: 1 }] },
      }),
    });
    expect(topItem(w, 5, 6, 7, false)).toBeUndefined();
    expect(topItem(w, 5, 6, 7, true)?.itemId).toBe(1);
    expect(w.tileCounts(5, 6, 7)).toBeUndefined();
  });

  it("builds protocol locations", () => {
    expect(locationInit({ kind: "container", id: 2, index: 4 })).toEqual({
      location: { case: "container", value: { containerId: 2, index: 4 } },
    });
    expect(locationInit({ kind: "slot", slot: EquipmentSlot.RIGHT_HAND })).toEqual({
      location: { case: "slot", value: EquipmentSlot.RIGHT_HAND },
    });
  });
});

describe("look messages", () => {
  const t = translator({
    "look.weapon": "You see {items} (attack {attack}). It weighs {weight} oz.",
    "item.iron_sword.name": "iron sword",
    "item.iron_sword.desc": "A reliable sword.",
    "item.copper_coin.name": "copper coin",
    "look.item": "You see {items}. It weighs {weight} oz.",
    "client.log.item_count": "{count} {name}",
  });
  const look = (key: string, itemId: number, count: number, weight: number): string =>
    formatMessage(
      {
        key,
        at: 0,
        params: [
          {
            $typeName: "game.v1.TextParam",
            name: "item",
            value: { case: "item", value: { $typeName: "game.v1.ItemStack", itemId, count } },
          },
          { $typeName: "game.v1.TextParam", name: "attack", value: { case: "number", value: 13n } },
          {
            $typeName: "game.v1.TextParam",
            name: "weight",
            value: { case: "number", value: BigInt(weight) },
          },
        ],
      },
      content,
      t,
    );

  it("adds the description and shows the weight in oz", () => {
    expect(look("look.weapon", 20, 0, 3300)).toBe(
      "You see iron sword (attack 13). It weighs 33.00 oz. A reliable sword.",
    );
    expect(look("look.item", 8, 5, 50)).toBe("You see 5 copper coin. It weighs 0.50 oz.");
    expect(formatOz(420000)).toBe("4200.00");
  });
});
