import { LivingObjectEventSchema, LivingObjectKind, create } from "@rpg/protocol";
import { Container, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import type { ItemDef } from "../content-types.ts";
import { livingEvent, mountLivingObjects } from "./living.ts";

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
