import { LivingObjectEventSchema, LivingObjectKind, create } from "@rpg/protocol";
import { Container, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import type { ItemDef } from "../content-types.ts";
import type { ClientContent } from "../content-types.ts";
import {
  bodyKindOf,
  BIG_BEAST_PX,
  creatureGait,
  footfallSounds,
  kicksUp,
  livingEvent,
  mountLivingObjects,
  plantSource,
} from "./living.ts";
import type { Footfall, Gait } from "./living.ts";

const def = (extra: Partial<ItemDef>): ItemDef => ({
  id: "x",
  sprite: "livingworld/x",
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
  ...extra,
});

describe("footfalls glue", () => {
  const gait = (name: string, contacts: number): Gait => ({
    name,
    print: "feet",
    stance: 2,
    reach: 0.25,
    rise: 0,
    scale: 1,
    depth: 1,
    contacts: Array.from({ length: contacts }, (_, i) => ({ at: i / contacts, side: 0, along: 0 })),
  });
  const content = (gaits: boolean): ClientContent =>
    ({
      livingWorld: {
        surfaces: {},
        plants: {},
        ...(gaits
          ? {
              gaits: {
                viewDepth: 0.5,
                slidePx: 2,
                gaits: { biped: gait("biped", 2), crawl: gait("crawl", 8), none: gait("none", 0) },
                defaults: { humanoid: "biped", beast: "biped", big_beast: "crawl", flying: "none" },
                creatures: { moss_spider: "crawl" },
              },
            }
          : {}),
      },
    }) as unknown as ClientContent;

  it("tells a creature's body: a person, a flier, a beast or a big one", () => {
    expect(bodyKindOf(true, false, 30)).toBe("humanoid");
    expect(bodyKindOf(true, true, 30)).toBe("flying");
    expect(bodyKindOf(false, false, BIG_BEAST_PX)).toBe("beast");
    expect(bodyKindOf(false, false, BIG_BEAST_PX + 1)).toBe("big_beast");
  });

  it("gives each creature its gait from the content, and none to a flier", () => {
    const c = content(true);
    expect(creatureGait(c, undefined, "humanoid")?.name).toBe("biped");
    expect(creatureGait(c, "moss_spider", "beast")?.name).toBe("crawl");
    expect(creatureGait(c, "wolf", "big_beast")?.name).toBe("crawl");
    expect(creatureGait(c, "gloom_bat", "flying")).toBeUndefined();
    expect(creatureGait(content(false), undefined, "humanoid")).toBeUndefined();
  });

  it("moves the own step's sound to the footfalls only when there are gaits", () => {
    expect(footfallSounds(content(true))).toBe(true);
    expect(footfallSounds(content(false))).toBe(false);
    expect(footfallSounds({} as ClientContent)).toBe(false);
  });

  it("kicks the ground up at every footfall of two feet, every other of more, never gliding", () => {
    const fall = (g: Gait, contact: number, sliding = false): Footfall =>
      ({ gait: g, contact, sliding }) as Footfall;
    expect(kicksUp(fall(gait("biped", 2), 0))).toBe(true);
    expect(kicksUp(fall(gait("biped", 2), 1))).toBe(true);
    expect(kicksUp(fall(gait("crawl", 8), 2))).toBe(true);
    expect(kicksUp(fall(gait("crawl", 8), 3))).toBe(false);
    expect(kicksUp(fall(gait("biped", 2), 0, true))).toBe(false);
  });
});

describe("living objects glue", () => {
  it("turns a LivingObjectEvent into the module's event", () => {
    const e = livingEvent(
      create(LivingObjectEventSchema, {
        kind: LivingObjectKind.PUSH,
        pos: { x: 1, y: 2, z: 7 },
        to: { x: 2, y: 2, z: 7 },
        itemId: 9,
        effect: "stone",
        sound: "hit",
      }),
    );
    expect(e).toEqual({
      kind: "push",
      pos: { x: 1, y: 2, z: 7 },
      to: { x: 2, y: 2, z: 7 },
      itemId: 9,
      effect: "stone",
      sound: "hit",
      hpPermille: 0,
    });
    expect(livingEvent(create(LivingObjectEventSchema, {}))).toBeUndefined();
  });

  it("draws a break over the map and crunches debris underfoot", () => {
    const stage = new Container();
    const items = {
      1: def({ ground: true, walkable: true }),
      5: def({ living: "debris", livingEffect: "plant" }),
    };
    const sounds: string[] = [];
    const lw = mountLivingObjects(stage, {
      tileSize: 32,
      items,
      tile: (x) => (x === 3 ? [1, 5] : [1]),
      elevationAt: () => 0,
      texture: () => Texture.WHITE,
      playSound: (id) => sounds.push(id),
      reducedMotion: () => false,
    });
    expect(stage.children).toHaveLength(1);
    const e = livingEvent(
      create(LivingObjectEventSchema, {
        kind: LivingObjectKind.BREAK,
        pos: { x: 2, y: 2, z: 7 },
        sound: "woodcutting",
      }),
    );
    if (!e) throw new Error("no event");
    lw.onObjectEvent(e, 0);
    lw.onTick(1, 7);
    const afterBreak = lw.alive;
    expect(afterBreak).toBeGreaterThan(0);
    expect(sounds).toEqual(["woodcutting"]);
    lw.onStep({ x: 2, y: 2, z: 7 }, { x: 3, y: 2, z: 7 }, 1);
    lw.onTick(2, 7);
    expect(lw.alive).toBeGreaterThan(afterBreak);
  });
});

describe("the map's sprites for the living world", () => {
  it("names each by its item's id of data/items, also the remains of a monster", () => {
    // MapView hands the tile keys of the client (state/corpse-art.ts): the item's number,
    // or "<n>@<monster>" for remains. data/livingworld names its plants by item id: with
    // the number, no plant ever matched its rule (neither bent nor swayed).
    const view = {
      version: 3,
      forEachItemSprite(fn: (x: number, y: number, key: string, sprite: string) => void): void {
        fn(1, 2, "14", "fern");
        fn(3, 4, "91@wolf", "corpse");
      },
    };
    const src = plantSource(view, { 14: { id: "jungle_fern" }, 91: { id: "creature_remains" } });
    expect(src.version()).toBe(3);
    const seen: [number, number, string, string][] = [];
    src.forEach((x, y, id, sprite) => seen.push([x, y, id, sprite]));
    expect(seen).toEqual([
      [1, 2, "jungle_fern", "fern"],
      [3, 4, "creature_remains", "corpse"],
    ]);
  });
});
