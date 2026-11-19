import { NO_SOUNDS } from "../audio/cues.ts";
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
import { tileActions } from "../input/actions.ts";
import {
  formatOz,
  halfStack,
  locationInit,
  menuItem,
  splitCount,
  splittable,
  tileUse,
  topItem,
} from "./items.ts";
import { portalKey, useMode } from "./portals.ts";
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
    48: def("backpack", { slots: 24 }),
    60: def("brasal_dock_sign", { blocks: true, desc: "text.volcan.dock_sign" }),
    218: def("ladder_up", { portal: true }),
  },
  monsterSprites: {},
  vocations: [],
  spells: [],
  recipes: [],
  movement: { baseStepMs: 1000, diagonalCost: 1.5, maxPathTiles: 100 },
  chat: { maxLength: 255 },
  sounds: NO_SOUNDS,
  islands: [],
  i18n: {},
};

describe("the equipped backpack (docs/17 UI-5: under the figure)", () => {
  it("is the window that answers a use of the backpack slot, while the backpack is worn", () => {
    const w = new WorldState(content);
    const apply = (m: Msg, now = 0): void => w.apply(m, now);
    const wear = (itemId?: number): void =>
      apply({
        case: "inventory",
        value: create(InventorySchema, {
          slots: itemId ? [{ slot: EquipmentSlot.BACKPACK, item: { itemId } }] : [],
        }),
      });
    const open = (containerId: number, now = 0): void =>
      apply(
        {
          case: "containerOpen",
          value: create(ContainerOpenSchema, { containerId, itemId: 48, capacity: 20 }),
        },
        now,
      );
    const close = (containerId: number): void =>
      apply({ case: "containerClose", value: create(ContainerCloseSchema, { containerId }) });
    wear(48);
    w.backpack.used(48, 0);
    open(3, 100);
    expect(w.backpack.id).toBe(3);
    wear(undefined); // dropped on the floor beside the player: a window of its own
    expect(w.backpack.id).toBeUndefined();
    expect(w.containers.map((c) => c.id)).toEqual([3]);
    wear(48); // a backpack worn again, perhaps another one: its window stays its own
    expect(w.backpack.id).toBeUndefined();
    // The use of the slot closed that window (it was the worn one): nothing goes below.
    w.backpack.used(48, 200);
    close(3);
    open(4, 300); // opened from the floor, no use of the slot: a window of its own
    expect(w.backpack.id).toBeUndefined();
    w.backpack.used(48, 400); // the next use opens it below the figure
    open(5, 450);
    expect(w.backpack.id).toBe(5);
    close(5);
    expect(w.backpack.id).toBeUndefined();
  });
});

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

  it("uses a ladder by its ground whatever lies on it, a bare door by its ground", () => {
    const w = new WorldState(content);
    const tile = (items: { itemId: number; count?: number }[]): void =>
      w.apply(
        {
          case: "tileUpdate",
          value: create(TileUpdateSchema, { pos: { x: 5, y: 6, z: 7 }, tile: { items } }),
        },
        0,
      );
    const ground = { loc: { kind: "pos", pos: { x: 5, y: 6, z: 7 } }, itemId: 1, stackIndex: 0 };
    // Coins dropped on the tile: a ladder still climbs (its ground), the rest uses the coins.
    tile([{ itemId: 1 }, { itemId: 8, count: 30 }]);
    expect(tileUse(w, 5, 6, 7, "first")).toMatchObject(ground);
    expect(tileUse(w, 5, 6, 7, "bare")).toMatchObject({ itemId: 8, stackIndex: 1 });
    expect(tileUse(w, 5, 6, 7, "never")).toMatchObject({ itemId: 8, stackIndex: 1 });
    // Bare: a ladder or a door uses its ground, any other tile nothing.
    tile([{ itemId: 1 }]);
    expect(tileUse(w, 5, 6, 7, "first")).toMatchObject(ground);
    expect(tileUse(w, 5, 6, 7, "bare")).toMatchObject(ground);
    expect(tileUse(w, 5, 6, 7, "never")).toBeUndefined();
    // A tile the client does not know: nothing.
    expect(tileUse(w, 9, 9, 7, "first")).toBeUndefined();
    // A ladder as the map has it (its ladder_up on the grass) with a backpack (a corpse
    // would be the same) dropped on it: a right click climbs, a Ctrl+right click opens the
    // backpack (state/portals.ts useMode gives "first" and "bare"). Without the backpack,
    // Ctrl uses the ladder_up: the server climbs on any item of the map there.
    tile([{ itemId: 1 }, { itemId: 218 }, { itemId: 48 }]);
    const ladder = { [portalKey(5, 6, 7)]: "ladder" };
    expect(tileUse(w, 5, 6, 7, useMode(ladder, true, 5, 6, 7, false))).toMatchObject(ground);
    expect(tileUse(w, 5, 6, 7, useMode(ladder, true, 5, 6, 7, true))).toMatchObject({
      itemId: 48,
      stackIndex: 2,
    });
    tile([{ itemId: 1 }, { itemId: 218 }]);
    expect(tileUse(w, 5, 6, 7, useMode(ladder, true, 5, 6, 7, false))).toMatchObject(ground);
    expect(tileUse(w, 5, 6, 7, useMode(ladder, true, 5, 6, 7, true))).toMatchObject({
      itemId: 218,
      stackIndex: 1,
    });
  });

  it("gives a long press no buttons for a portal's own item, only for what lies on it", () => {
    const w = new WorldState(content);
    const tile = (items: { itemId: number }[]): void =>
      w.apply(
        {
          case: "tileUpdate",
          value: create(TileUpdateSchema, { pos: { x: 5, y: 6, z: 7 }, tile: { items } }),
        },
        0,
      );
    // A bare ladder: its ladder_up is the top item (the menu's title), but the menu only
    // climbs and looks: no "use" or "move" of a map item nobody moves.
    tile([{ itemId: 1 }, { itemId: 218 }]);
    expect(topItem(w, 5, 6, 7, false)).toMatchObject({ itemId: 218, stackIndex: 1 });
    expect(menuItem(w, 5, 6, 7)).toBeUndefined();
    const facts = (x: number, y: number, z: number) => {
      const item = menuItem(w, x, y, z);
      return {
        item: item && { container: (w.item(item.itemId)?.slots ?? 0) > 0 },
        door: true,
        climb: true,
        known: true,
      };
    };
    expect(tileActions(facts(5, 6, 7))).toEqual(["climb", "look"]);
    // A backpack dropped on it gets its buttons.
    tile([{ itemId: 1 }, { itemId: 218 }, { itemId: 48 }]);
    expect(menuItem(w, 5, 6, 7)).toMatchObject({ itemId: 48, stackIndex: 2 });
    expect(tileActions(facts(5, 6, 7))).toEqual(["climb", "open", "look", "move"]);
    // Any other top item is the menu's item; a bare tile has none.
    tile([{ itemId: 1 }, { itemId: 20 }]);
    expect(menuItem(w, 5, 6, 7)).toMatchObject({ itemId: 20, stackIndex: 1 });
    tile([{ itemId: 1 }]);
    expect(menuItem(w, 5, 6, 7)).toBeUndefined();
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
    "item.signpost.name": "sign",
    "item.brasal_dock_sign.name": "sign",
    "text.volcan.dock_sign": "Dock of Brasal.",
    "look.item": "You see {items}. It weighs {weight} oz.",
    "look.ground": "You see {items}.",
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

  it("reads a sign: the description key its data/items entry names, not item.<id>.desc", () => {
    expect(look("look.ground", 60, 0, 0)).toBe("You see sign. Dock of Brasal.");
  });

  it("fills a single {item} parameter (gather.got, shop.bought)", () => {
    const got = (itemId: number, count: number): string =>
      formatMessage(
        {
          key: "gather.got",
          at: 0,
          params: [
            {
              $typeName: "game.v1.TextParam",
              name: "item",
              value: { case: "item", value: { $typeName: "game.v1.ItemStack", itemId, count } },
            },
          ],
        },
        content,
        translator({
          "gather.got": "You got {item}.",
          "item.iron_sword.name": "iron sword",
          "item.copper_coin.name": "copper coin",
          "client.log.item_count": "{count} {name}",
        }),
      );
    expect(got(20, 0)).toBe("You got iron sword.");
    expect(got(8, 3)).toBe("You got 3 copper coin.");
  });
});

describe("Shift+drag splits a stack (docs/17 UI-6)", () => {
  it("only a stackable item with more than one unit", () => {
    expect(splittable({ stackable: true }, 5)).toBe(true);
    expect(splittable({ stackable: true }, 1)).toBe(false);
    expect(splittable({ stackable: false }, 5)).toBe(false);
    expect(splittable(undefined, 5)).toBe(false);
  });

  it("asks half first and moves from 1 to the stack less one", () => {
    expect(halfStack(37)).toBe(18);
    expect(halfStack(1)).toBe(1);
    expect(splitCount(12, 37)).toBe(12);
    expect(splitCount(0, 37)).toBe(1);
    expect(splitCount(500, 37)).toBe(36);
    expect(splitCount(Number.NaN, 37)).toBe(1);
    expect(splitCount(4.7, 10)).toBe(4);
  });
});
