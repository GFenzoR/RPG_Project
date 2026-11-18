import { Graphics, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { FEET_LINE, newPose } from "@rpg/renderer";
import type { AnimMeta } from "@rpg/renderer";
import { CreatureBody, FLASH_TINT } from "./creature-body.ts";
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
