// The remains a death leaves are named after whose they are (docs/02 "Muerte", docs/05
// "Restos"), in every place that names an item, in both languages, with the texts of i18n/.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ContainerOpenSchema, TileUpdateSchema, create } from "@rpg/protocol";
import type { TextParam } from "@rpg/protocol";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { NO_SOUNDS } from "../audio/cues.ts";
import type { ClientContent, ItemDef } from "../content-types.ts";
import { translator } from "../i18n/i18n.ts";
import type { Translate } from "../i18n/i18n.ts";
import { cardTitle } from "../ui/ItemCard.tsx";
import { itemName } from "../ui/Inventory.tsx";
import {
  FLOOR_ITEM_SCALE,
  corpseArt,
  corpseSprite,
  mapItemArt,
  mapItemId,
  mapItemKey,
  mapItemTexture,
  parseMapItemKey,
  plainItemKey,
} from "./corpse-art.ts";
import { itemCard } from "./item-card.ts";
import { instanceName } from "./item-name.ts";
import { topItem } from "./items.ts";
import { formatMessage } from "./messages.ts";
import { modsOf } from "./mods.ts";
import { WorldState } from "./world.ts";

/** The real texts of i18n/<lang>/ that naming an item uses. */
function texts(lang: "es" | "en"): Translate {
  const all: Record<string, string> = {};
  for (const file of ["client", "items", "monsters"]) {
    const url = new URL(`../../../i18n/${lang}/${file}.yaml`, import.meta.url);
    Object.assign(all, parse(readFileSync(fileURLToPath(url), "utf8")) as Record<string, string>);
  }
  return translator(all, lang);
}
const es = texts("es");
const en = texts("en");

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

const GRASS = 1;
const FUR = 91;
const BODY = 98;
const SWORD = 20;
const content: ClientContent = {
  items: {
    [GRASS]: def("grass", { ground: true, walkable: true }),
    [FUR]: def("remains_fur", { sprite: "decor/remains_fur", slots: 10, fixed: true }),
    [BODY]: def("remains_humanoid", { sprite: "decor/remains_humanoid", slots: 10, fixed: true }),
    [SWORD]: def("iron_sword"),
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

const wolfRemains = { attribute: "", value: 0, refine: 0, remainsOf: "wolf", bodyOf: "" };
const anaBody = { attribute: "", value: 0, refine: 0, remainsOf: "", bodyOf: "Ana" };

const itemParam = (itemId: number, mods?: typeof wolfRemains): TextParam => ({
  $typeName: "game.v1.TextParam",
  name: "item",
  value: {
    case: "item",
    value: {
      $typeName: "game.v1.ItemStack",
      itemId,
      count: 0,
      ...(mods ? { mods: { $typeName: "game.v1.ItemMods", ...mods } } : {}),
    },
  },
});
const num = (name: string, value: bigint): TextParam => ({
  $typeName: "game.v1.TextParam",
  name,
  value: { case: "number", value },
});

describe("the name of remains", () => {
  it("says whose remains they are, naturally in each language", () => {
    expect(instanceName(es, content.items[FUR], FUR, wolfRemains)).toBe("restos de lobo");
    expect(instanceName(en, content.items[FUR], FUR, wolfRemains)).toBe("wolf remains");
    const spider = { ...wolfRemains, remainsOf: "moss_spider" };
    expect(instanceName(es, content.items[FUR], FUR, spider)).toBe("restos de araña de musgo");
    expect(instanceName(en, content.items[FUR], FUR, spider)).toBe("moss spider remains");
    expect(instanceName(es, content.items[BODY], BODY, anaBody)).toBe("cuerpo de Ana");
    expect(instanceName(en, content.items[BODY], BODY, anaBody)).toBe("body of Ana");
  });

  it("falls back to the family's name when the client has no name for the monster", () => {
    const unknown = { ...wolfRemains, remainsOf: "not_in_this_bundle" };
    expect(instanceName(es, content.items[FUR], FUR, unknown)).toBe("restos de bestia");
    expect(instanceName(en, content.items[FUR], FUR, unknown)).toBe(en("item.remains_fur.name"));
  });

  it("leaves every other item as it was: its own name, a refined one with its level", () => {
    expect(instanceName(es, content.items[FUR], FUR)).toBe("restos de bestia");
    expect(instanceName(en, content.items[SWORD], SWORD, { refine: 3 })).toBe(
      `+3 ${en("item.iron_sword.name")}`,
    );
    expect(instanceName(en, undefined, 777)).toBe("777");
  });

  it("names them in a look (Shift+click) and in a log line", () => {
    const look = (t: Translate): string =>
      formatMessage(
        {
          key: "look.container",
          at: 0,
          params: [itemParam(FUR, wolfRemains), num("slots", 10n), num("weight", 0n)],
        },
        content,
        t,
      );
    expect(look(es)).toContain("restos de lobo");
    expect(look(es)).not.toContain("restos de bestia");
    expect(look(en)).toContain("wolf remains");
    const body = formatMessage(
      { key: "look.container", at: 0, params: [itemParam(BODY, anaBody), num("slots", 10n)] },
      content,
      es,
    );
    expect(body).toContain("cuerpo de Ana");
  });

  it("names them in the card's title, the menu's title and the hover hint", () => {
    const card = itemCard(content.items[FUR], FUR, 1, {}, wolfRemains);
    expect(cardTitle(es, card)).toBe("restos de lobo");
    expect(cardTitle(en, card)).toBe("wolf remains");
    // The menu and the hint use the item of the tile, with its mods.
    const w = new WorldState(content);
    w.apply(
      {
        case: "tileUpdate",
        value: create(TileUpdateSchema, {
          pos: { x: 5, y: 5, z: 7 },
          tile: { items: [{ itemId: GRASS }, { itemId: FUR, mods: wolfRemains }] },
        }),
      },
      0,
    );
    const top = topItem(w, 5, 5, 7, false);
    expect(top?.mods?.remainsOf).toBe("wolf");
    expect(
      es("client.action.open", { name: instanceName(es, content.items[FUR], FUR, top?.mods) }),
    ).toContain("restos de lobo");
  });

  it("titles the window of the opened remains after them", () => {
    const w = new WorldState(content);
    w.apply(
      {
        case: "containerOpen",
        value: create(ContainerOpenSchema, {
          containerId: 3,
          itemId: FUR,
          capacity: 10,
          mods: wolfRemains,
        }),
      },
      0,
    );
    const c = w.containers.find((o) => o.id === 3);
    expect(c && itemName(content, es, c.itemId, c.mods)).toBe("restos de lobo");
    expect(c && itemName(content, en, c.itemId, c.mods)).toBe("wolf remains");
  });
});

describe("the corpse on the map", () => {
  it("keeps the mods of remains (a plain item keeps none)", () => {
    expect(modsOf({ mods: { ...wolfRemains } })?.remainsOf).toBe("wolf");
    expect(modsOf({ mods: { ...anaBody } })?.bodyOf).toBe("Ana");
    expect(modsOf({ mods: { attribute: "", value: 0, refine: 0 } })).toBeUndefined();
  });

  it("is drawn with its monster's own corpse: the tile's key names it", () => {
    expect(mapItemKey(FUR, wolfRemains)).toBe(`${FUR}@wolf`);
    expect(mapItemKey(FUR, undefined)).toBe(String(FUR));
    expect(mapItemKey(BODY, anaBody)).toBe(String(BODY));
    expect(parseMapItemKey(`${FUR}@wolf`)).toEqual({ itemId: FUR, remainsOf: "wolf" });
    expect(parseMapItemKey("48")).toEqual({ itemId: 48 });
    expect(corpseSprite("wolf")).toBe("corpses/wolf");
    expect(corpseArt("tex").anchorX).toBe(0.5);

    const w = new WorldState(content);
    w.apply(
      {
        case: "tileUpdate",
        value: create(TileUpdateSchema, {
          pos: { x: 5, y: 5, z: 7 },
          tile: {
            items: [{ itemId: GRASS }, { itemId: SWORD }, { itemId: FUR, mods: wolfRemains }],
          },
        }),
      },
      0,
    );
    const chunk = w.chunk(7, 0, 0);
    expect(chunk?.items.find((s) => s.x === 5 && s.y === 5)?.stack).toEqual([
      String(SWORD),
      `${FUR}@wolf`,
    ]);
  });

  it("reads the item of a tile key without the monster", () => {
    expect(mapItemId(`${FUR}@wolf`)).toBe(FUR);
    expect(mapItemId("48")).toBe(48);
    expect(plainItemKey(`${FUR}@wolf`)).toBe(String(FUR));
    expect(plainItemKey("48")).toBe("48");
  });

  it("takes the monster's corpse from the atlas, and the family's remains without one", () => {
    // An atlas with the wolf's corpse and the family's sprite, but no corpse for the boar
    // (a client older than the monster, or art still to be made).
    const has = new Set(["corpses/wolf", "decor/remains_fur", "decor/remains_humanoid"]);
    const atlas = {
      texture: (sprite: string) => (has.has(sprite) ? `tex:${sprite}` : undefined),
      tileArt: (sprite: string) =>
        has.has(sprite) ? { ...corpseArt(`art:${sprite}`), anchorX: 1 as const } : undefined,
    };
    const items = content.items;
    expect(mapItemTexture(`${FUR}@wolf`, items, atlas)).toBe("tex:corpses/wolf");
    expect(mapItemTexture(`${FUR}@bristleback_boar`, items, atlas)).toBe("tex:decor/remains_fur");
    expect(mapItemTexture(String(FUR), items, atlas)).toBe("tex:decor/remains_fur");
    // A player's body is its item's sprite: no monster in its key.
    expect(mapItemTexture(mapItemKey(BODY, anaBody), items, atlas)).toBe(
      "tex:decor/remains_humanoid",
    );
    // No sprite at all: the canvas draws its missing texture.
    expect(mapItemTexture(String(SWORD), items, atlas)).toBeUndefined();
    expect(
      mapItemTexture("999@wolf", items, { ...atlas, texture: () => undefined }),
    ).toBeUndefined();

    // The corpse is centred on its tile; the family's remains keep their own tile art.
    expect(mapItemArt(`${FUR}@wolf`, items, atlas)).toEqual(corpseArt("tex:corpses/wolf"));
    expect(mapItemArt(`${FUR}@bristleback_boar`, items, atlas)).toMatchObject({
      base: "art:decor/remains_fur",
      anchorX: 1,
    });
    expect(mapItemArt(String(SWORD), items, atlas)).toBeUndefined();
  });

  it("draws a carried thing smaller on the floor, furniture and remains at their size", () => {
    const atlas = {
      texture: (sprite: string) => `tex:${sprite}`,
      tileArt: (sprite: string) =>
        sprite.startsWith("decor/")
          ? { ...corpseArt(`art:${sprite}`), anchorX: 1 as const }
          : undefined,
    };
    const items = {
      1: { sprite: "weapons/iron_sword", kind: "weapon" },
      2: { sprite: "decor/table", kind: "decoration" },
      3: { sprite: "decor/pelt", kind: "material" },
    };
    expect(mapItemArt("1", items, atlas)).toMatchObject({
      base: "tex:weapons/iron_sword",
      anchorX: 1,
      scale: FLOOR_ITEM_SCALE,
    });
    expect(mapItemArt("2", items, atlas)?.scale).toBeUndefined();
    expect(mapItemArt("3", items, atlas)).toMatchObject({
      base: "art:decor/pelt",
      scale: FLOOR_ITEM_SCALE,
    });
    expect(FLOOR_ITEM_SCALE).toBeGreaterThan(0.5);
    expect(FLOOR_ITEM_SCALE).toBeLessThan(0.8);
  });
});
