import { Container, Graphics, Texture } from "pixi.js";
import type { AlphaFilter, Sprite } from "pixi.js";
import { describe, expect, it } from "vitest";
import { FEET_LINE, SHADOW_W, newPose } from "@rpg/renderer";
import type { AnimMeta } from "@rpg/renderer";
import {
  CONTACT_MARGIN,
  CONTACT_MAX_W,
  CONTACT_MIN_W,
  CreatureBody,
  FLASH_TINT,
  SHIMMER_TINT,
  SpritePool,
  contactWidth,
  footings,
  layerOrder,
} from "./creature-body.ts";
import { CONTACT_GONE, contactShare } from "./cast-shadows.ts";
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
  return { meta, frames: { walk }, still: walk[2]?.[0], eight: false };
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
    const body = new CreatureBody({ meta: undefined, frames: {}, still, eight: false }, T);
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
    // The shadow, then the layers in one container.
    expect(doll.root.children[0]).toBeInstanceOf(Graphics);
    const layers = doll.root.children[1] as Container;
    expect(layers).toBeInstanceOf(Container);
    const sprites = layers.children;
    expect(sprites).toHaveLength(2);
    // Facing east the weapon (right hand, near) goes over the body.
    expect(sprites[0]?.tint).toBe(0xecc4a2);
    expect(sprites[1]?.tint).toBe(0xa8aeb6);
    expect((sprites[1] as Sprite).texture).toBe(weapon.frames.walk?.[1]?.[1]);
    for (const s of sprites) expect(s.position.x).toBe(T / 2 + 2);
    // Facing north too (held in front of the body, away from the camera: the body's own
    // occlusion is in the weapon's frames): re-stacked once, the shadow still first.
    doll.draw(pose, 0);
    expect(doll.root.children[0]).toBeInstanceOf(Graphics);
    expect(layers.children[1]?.tint).toBe(0xa8aeb6);
    // A flash tints every layer.
    pose.flash = true;
    doll.draw(pose, 3);
    for (const s of layers.children) expect(s.tint).toBe(FLASH_TINT);
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
    expect(layerOrder(layers, "n")).toEqual([1, 0, 2]);
    expect(layerOrder(layers, "e")).toEqual([1, 2, 0]);
    expect(layerOrder(layers, "w")).toEqual([1, 0, 2]);
  });

  it("fades as one figure: the layers stay opaque and their container fades them", () => {
    const c = layer();
    // Pixi's AlphaFilter compiles a WebGL program: a stand-in with its alpha.
    let made = 0;
    let destroyed = 0;
    const filter = {
      alpha: 1,
      destroy: () => destroyed++,
    } as unknown as AlphaFilter;
    const doll = new CreatureBody(
      c,
      T,
      0xffffff,
      [
        { slot: "body", clips: c, tint: 1 },
        { slot: "torso", clips: c, tint: 2 },
      ],
      new SpritePool(),
      () => (made++, filter),
    );
    const layers = doll.root.children[1] as Container;
    const pose = newPose();
    pose.alpha = 0.5; // appearing, falling or shimmering away
    doll.draw(pose, 2);
    // Each layer at 0.5 would show the skin through the tunic.
    for (const s of layers.children) expect(s.alpha).toBe(1);
    expect(layers.alpha).toBe(1);
    expect(layers.filters?.[0]).toBe(filter);
    expect(filter.alpha).toBe(0.5);
    expect(doll.alpha).toBe(0.5);
    // The own player see-through while invisible (T3.2) goes through the same fade.
    doll.opacity = 0.4;
    pose.alpha = 1;
    doll.draw(pose, 2);
    expect(layers.filters).toHaveLength(1);
    expect(filter.alpha).toBeCloseTo(0.4);
    expect(doll.alpha).toBeCloseTo(0.4);
    // Opaque again: no filter (one less render pass), the layers as they were.
    doll.opacity = 1;
    doll.draw(pose, 2);
    expect(layers.filters ?? []).toHaveLength(0);
    for (const s of layers.children) expect(s.alpha).toBe(1);
    // One filter for the body's whole life, freed when it leaves.
    pose.alpha = 0.3;
    doll.draw(pose, 2);
    expect(made).toBe(1);
    doll.release();
    expect(destroyed).toBe(1);
  });

  it("fades a one-sprite body on its sprite, with the opacity the caller sets", () => {
    const body = new CreatureBody(hero(), T);
    const pose = newPose();
    pose.alpha = 0.5;
    body.opacity = 0.4;
    body.draw(pose, 2);
    expect(body.sprite.alpha).toBeCloseTo(0.2);
    expect(body.alpha).toBeCloseTo(0.2);
  });
});

describe("CreatureBody facings (docs/17 ANI-1)", () => {
  const ALL = ["n", "e", "s", "w", "ne", "se", "sw", "nw"] as const;
  const clipsOf = (eight: boolean): ClipSet<Texture> => {
    const dirs = eight ? ALL : DIRS;
    const meta: AnimMeta = {
      w: 64,
      h: 64,
      anchor: "bc",
      foot: 2,
      top: 40,
      shadow: "none",
      actions: { walk: { frames: 1, ms: 0, perTile: 8, dirs: [...dirs] } },
    };
    const walk = dirs.map(() => [tex(64, 64)]);
    return { meta, frames: { walk }, still: walk[2]?.[0], eight };
  };

  it("draws eight ways only when every layer has the diagonals", () => {
    const pool = new SpritePool();
    const all = new CreatureBody(
      clipsOf(true),
      T,
      0xffffff,
      [
        { slot: "body", clips: clipsOf(true), tint: 1 },
        { slot: "torso", clips: clipsOf(true), tint: 2 },
      ],
      pool,
    );
    expect(all.eight).toBe(true);
    // One layer drawn four ways (a piece without diagonals): the whole figure turns four.
    const mixed = new CreatureBody(
      clipsOf(true),
      T,
      0xffffff,
      [
        { slot: "body", clips: clipsOf(true), tint: 1 },
        { slot: "weapon", clips: clipsOf(false), tint: 2 },
      ],
      pool,
    );
    expect(mixed.eight).toBe(false);
    expect(new CreatureBody(clipsOf(false), T).eight).toBe(false);
  });

  it("stacks the layers of a diagonal facing by its own order", () => {
    const c = clipsOf(true);
    const layers = [
      { slot: "weapon" as const, clips: c, tint: 1 },
      { slot: "body" as const, clips: c, tint: 2 },
      { slot: "shield" as const, clips: c, tint: 3 },
    ];
    // South-east: the right hand (the weapon) is the near one; south-west, the left.
    expect(layerOrder(layers, "se")).toEqual([1, 2, 0]);
    expect(layerOrder(layers, "sw")).toEqual([1, 0, 2]);
  });
});

// Owner, 2026-11-25: "the round shadow under the character ruins the new one" and "it is
// far from the character, it seems to float".
describe("CreatureBody: the contact ellipse and the feet", () => {
  /** A figure whose standing pose ends `foot` rows over the frame's bottom, feet x0..x1. */
  const standing = (
    w: number,
    h: number,
    walkFoot: number,
    stance: AnimMeta["stance"],
  ): ClipSet<Texture> => {
    const walk = DIRS.map(() => [tex(w, h)]);
    const meta: AnimMeta = {
      w,
      h,
      anchor: "bc",
      foot: walkFoot,
      top: h - walkFoot,
      shadow: "ellipse",
      actions: { walk: { frames: 1, ms: 0, perTile: 1, dirs: DIRS } },
    };
    if (stance) meta.stance = stance;
    return { meta, frames: { walk }, still: walk[2]?.[0], eight: false };
  };
  const ellipse = (body: CreatureBody): Graphics => body.root.children[0] as Graphics;

  it("never draws the ellipse while the creature casts a shadow, and all of it without one", () => {
    const body = new CreatureBody(hero(), T, 0xffffff);
    const pose = newPose();
    pose.action = "walk";
    body.draw(pose, 2);
    expect(body.contactShown).toBe(true); // a body outside the map: no sun, the ellipse
    body.contact = 0;
    body.draw(pose, 2);
    expect(ellipse(body).visible).toBe(false);
    expect(body.contactShown).toBe(false);
    // The sun rising: a crossfade, never a pop.
    body.contact = 0.5;
    body.draw(pose, 2);
    expect(ellipse(body).visible).toBe(true);
    expect(ellipse(body).alpha).toBeCloseTo(0.5);
    body.contact = 1;
    body.draw(pose, 2);
    expect(ellipse(body).alpha).toBe(1);
  });

  it("keeps the ellipse under a body too faint to cast (invisible, fading away)", () => {
    const body = new CreatureBody(hero(), T, 0xffffff);
    const pose = newPose();
    pose.action = "walk";
    body.contact = 0; // in the sun
    body.opacity = 0.4; // the own player, invisible
    body.draw(pose, 2);
    const parts: number[] = [];
    body.castShadow({ part: () => void parts.push(1) }, 0, 0);
    expect(parts).toHaveLength(0);
    expect(body.contactShown).toBe(true);
    expect(ellipse(body).alpha).toBeCloseTo(0.4);
    body.opacity = 1;
    body.draw(pose, 2);
    body.castShadow({ part: () => void parts.push(1) }, 0, 0);
    expect(parts).toHaveLength(1);
    expect(body.contactShown).toBe(false);
  });

  it("goes by the layer's opacity: none with a shadow to stand on, a crossfade under it", () => {
    expect(contactShare(0)).toBe(1);
    expect(contactShare(Number.NaN)).toBe(1);
    expect(contactShare(CONTACT_GONE)).toBe(0);
    expect(contactShare(0.4)).toBe(0);
    expect(contactShare(CONTACT_GONE / 2)).toBeCloseTo(0.5);
  });

  it("puts the ellipse on the line the feet stand on, for every size of creature", () => {
    // foot: the walk's lowest reach; the stance: where the body stands (3 to 5 px higher
    // for a person, whose foot steps down toward the viewer).
    const sizes: [
      name: string,
      w: number,
      h: number,
      walk: number,
      st: [number, number, number],
    ][] = [
      ["rat", 32, 32, 3, [5, 9, 23]],
      ["person", 64, 64, 2, [6, 24, 40]],
      ["warden", 96, 96, 4, [8, 22, 74]],
    ];
    for (const [name, w, h, walkFoot, st] of sizes) {
      const body = new CreatureBody(standing(w, h, walkFoot, { s: st }), T, 0xffffff);
      const pose = newPose();
      pose.action = "walk";
      body.draw(pose, 2);
      const sh = ellipse(body);
      // The sprite's bottom edge is at baseY; its standing pose ends st[0] rows over it.
      expect(sh.position.y, name).toBe(body.sprite.position.y - st[0]);
      expect(sh.position.y, name).toBe(body.groundY(2));
      // Under the middle of the feet, and as wide as they stand (within its limits).
      expect(sh.position.x, name).toBe(body.sprite.position.x + (st[1] + st[2]) / 2 - w / 2);
      const width = sh.scale.x * SHADOW_W;
      expect(width, name).toBeCloseTo(contactWidth(st[2] - st[1]));
      expect(width, name).toBeGreaterThanOrEqual(CONTACT_MIN_W);
      expect(width, name).toBeLessThanOrEqual(CONTACT_MAX_W);
    }
  });

  it("follows the facing drawn and its mirror: feet off the middle stay over the ellipse", () => {
    const clips = standing(64, 64, 2, { s: [6, 24, 40], e: [4, 30, 44], w: [4, 20, 34] });
    const body = new CreatureBody(clips, T, 0xffffff);
    const pose = newPose();
    pose.action = "walk";
    body.draw(pose, 1); // east
    expect(ellipse(body).position).toMatchObject({ x: T / 2 + 5, y: body.sprite.position.y - 4 });
    pose.scaleX = -1; // the same drawing mirrored
    body.draw(pose, 1);
    expect(ellipse(body).position.x).toBe(T / 2 - 5);
    pose.scaleX = 1;
    body.draw(pose, 0); // north: no stance of its own, the south's
    expect(ellipse(body).position).toMatchObject({ x: T / 2, y: body.sprite.position.y - 6 });
  });

  it("starts the cast shadow on the same line: the soles touch it in all 8 facings", () => {
    const dirs8: AnimMeta["stance"] = {
      n: [7, 24, 40],
      e: [5, 28, 42],
      s: [6, 24, 40],
      w: [5, 22, 36],
      ne: [6, 26, 42],
      se: [5, 26, 42],
      sw: [5, 22, 38],
      nw: [6, 22, 38],
    };
    const body = new CreatureBody(standing(64, 64, 2, dirs8), T, 0xffffff);
    const pose = newPose();
    pose.action = "walk";
    const order = ["n", "e", "s", "w", "ne", "se", "sw", "nw"] as const;
    order.forEach((d, i) => {
      body.draw(pose, i);
      const parts: { y: number; foot: number }[] = [];
      body.castShadow(
        { part: (_t, _x, y, _sx, _sy, foot = 0) => void parts.push({ y, foot }) },
        100,
        200,
      );
      const st = dirs8[d] as [number, number, number];
      expect(parts, d).toHaveLength(1);
      // The shadow turns round the row the pose stands on: no gap under the soles.
      expect(parts[0]?.foot, d).toBe(st[0]);
      expect(parts[0]?.y, d).toBe(200 + body.sprite.position.y - st[0]);
      expect(parts[0]?.y, d).toBe(200 + body.groundY(i));
    });
  });

  it("falls back on the walk's foot with an atlas that has no stances", () => {
    const body = new CreatureBody(standing(64, 64, 2, undefined), T, 0xffffff);
    const pose = newPose();
    pose.action = "walk";
    body.draw(pose, 2);
    expect(ellipse(body).position).toMatchObject({ x: T / 2, y: T - FEET_LINE });
    expect(ellipse(body).scale.x).toBeCloseTo(1);
    expect(footings([undefined], 3)[2]).toEqual({
      foot: 3,
      cx: 0,
      width: SHADOW_W - CONTACT_MARGIN,
    });
  });
});
