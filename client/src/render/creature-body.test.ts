import { Graphics, Texture } from "pixi.js";
import type { Sprite } from "pixi.js";
import { describe, expect, it } from "vitest";
import { FEET_LINE, newPose } from "@rpg/renderer";
import type { AnimMeta } from "@rpg/renderer";
import { CreatureBody, FLASH_TINT, SHIMMER_TINT, SpritePool, layerOrder } from "./creature-body.ts";
import type { ClipSet } from "./clips.ts";

const DIRS: ("n" | "e" | "s" | "w")[] = ["n", "e", "s", "w"];
const T = 32;
const tex = (w: number, h: number): Texture => {
  const t = new Texture();
  t.frame.width = w;
  t.frame.height = h;
  return t;
};

const hero = (): ClipSet<Texture> => {
  const walk = DIRS.map(() => [tex(64, 64), tex(64, 64)]);
  const meta: AnimMeta = {
    w: 64,
    h: 64,
    anchor: "bc",
    foot: 2,
    top: 46,
    shadow: "ellipse",
    actions: { walk: { frames: 2, ms: 0, perTile: 1, dirs: DIRS } },
  };
  return { meta, frames: { walk }, still: walk[2]?.[0] };
};

describe("CreatureBody", () => {
  it("stands an LPC figure on its feet with a contact shadow and lifts its name", () => {
    const clips = hero();
    const body = new CreatureBody(clips, T, 0x808080);
    expect(body.root.children[0]).toBeInstanceOf(Graphics); // the shadow, under the sprite
    expect(body.sprite.position).toMatchObject({ x: T / 2, y: T - FEET_LINE + 2 });
    expect(body.lift).toBe(FEET_LINE + 46 - T);
    const pose = newPose();
    pose.action = "walk";
    pose.frame = 1;
    pose.x = 3;
    pose.y = -2;
    pose.scaleX = -1;
    pose.flash = true;
    body.draw(pose, 1);
    expect(body.sprite.texture).toBe(clips.frames.walk?.[1]?.[1]);
    expect(body.sprite.position).toMatchObject({ x: T / 2 + 3, y: T - FEET_LINE });
    expect(body.sprite.scale.x).toBe(-1);
    expect(body.sprite.tint).toBe(FLASH_TINT);
    pose.flash = false;
    body.draw(pose, 1);
    expect(body.sprite.tint).toBe(0x808080);
    // Leaving by a teleport or a logout: pale, then its own tint again (a reused pose).
    pose.shimmer = true;
    body.draw(pose, 1);
    expect(body.sprite.tint).toBe(SHIMMER_TINT);
    pose.shimmer = false;
    body.draw(pose, 1);
    expect(body.sprite.tint).toBe(0x808080);
  });

  it("keeps a single-frame sprite on the tile's bottom-right corner, with no extra shadow", () => {
    const still = tex(64, 64);
    const body = new CreatureBody({ meta: undefined, frames: {}, still }, T);
    expect(body.root.children).toHaveLength(1);
    // Centre-bottom anchor: the right edge stays on the tile's right edge.
    expect(body.sprite.position).toMatchObject({ x: T - 32, y: T });
    expect(body.lift).toBe(32);
    body.draw(newPose(), 0);
    expect(body.sprite.texture).toBe(still);
  });
});

describe("CreatureBody as a paper doll (docs/17 Humanoides del motor)", () => {
  const layer = (): ClipSet<Texture> => {
    const c = hero();
    return { ...c, frames: { walk: DIRS.map(() => [tex(64, 64), tex(64, 64)]) } };
  };

  it("draws one pooled sprite per layer in the same pose, each with its tint and frame", () => {
    const pool = new SpritePool();
    const body = layer();
    const weapon = layer();
    const doll = new CreatureBody(
      body,
      T,
      0xffffff,
      [
        { slot: "body", clips: body, tint: 0xecc4a2 },
        { slot: "weapon", clips: weapon, tint: 0xa8aeb6 },
      ],
      pool,
    );
    expect(pool.made).toBe(2);
    expect(doll.sprite.tint).toBe(0xecc4a2); // the body's sprite
    const pose = newPose();
    pose.action = "walk";
    pose.frame = 1;
    pose.x = 2;
    doll.draw(pose, 1); // east
    const sprites = doll.root.children.filter((c) => !(c instanceof Graphics));
    expect(sprites).toHaveLength(2);
    // Facing east the weapon (right hand, near) goes over the body.
    expect(sprites[0]?.tint).toBe(0xecc4a2);
    expect(sprites[1]?.tint).toBe(0xa8aeb6);
    expect((sprites[1] as Sprite).texture).toBe(weapon.frames.walk?.[1]?.[1]);
    for (const s of sprites) expect(s.position.x).toBe(T / 2 + 2);
    // Facing west it goes under it: re-stacked once, the shadow still first.
    doll.draw(pose, 3);
    const west = doll.root.children;
    expect(west[0]).toBeInstanceOf(Graphics);
    expect(west[1]?.tint).toBe(0xa8aeb6);
    // A flash tints every layer.
    pose.flash = true;
    doll.draw(pose, 3);
    for (const s of doll.root.children.slice(1)) expect(s.tint).toBe(FLASH_TINT);
    // Drawing makes no sprite; leaving gives them back for the next creature.
    expect(pool.made).toBe(2);
    doll.release();
    expect(pool.size).toBe(2);
    const next = new CreatureBody(
      body,
      T,
      0xffffff,
      [{ slot: "body", clips: body, tint: 1 }],
      pool,
    );
    expect(pool.made).toBe(2);
    expect(next.sprite.tint).toBe(1);
  });

  it("orders layers by LAYER_ORDER for each facing (unknown slots last)", () => {
    const c = layer();
    const layers = [
      { slot: "weapon" as const, clips: c, tint: 1 },
      { slot: "body" as const, clips: c, tint: 2 },
      { slot: "shield" as const, clips: c, tint: 3 },
    ];
    expect(layerOrder(layers, "s")).toEqual([1, 2, 0]);
    expect(layerOrder(layers, "n")).toEqual([0, 2, 1]);
    expect(layerOrder(layers, "e")).toEqual([2, 1, 0]);
    expect(layerOrder(layers, "w")).toEqual([0, 1, 2]);
  });
});
