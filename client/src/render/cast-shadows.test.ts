import { Texture } from "pixi.js";
import type { AlphaFilter } from "pixi.js";
import { describe, expect, it } from "vitest";
import { CAST_SHADOW_TINT, FEET_LINE, newPose } from "@rpg/renderer";
import type { AnimMeta } from "@rpg/renderer";
import { CastShadows } from "./cast-shadows.ts";
import type { ShadowSink } from "./cast-shadows.ts";
import { CreatureBody, SpritePool } from "./creature-body.ts";
import type { BodyLayer } from "./creature-body.ts";
import type { ClipSet } from "./clips.ts";

const T = 32;
const DIRS: ("n" | "e" | "s" | "w")[] = ["n", "e", "s", "w"];
const tex = (): Texture => {
  const t = new Texture();
  t.frame.width = 64;
  t.frame.height = 64;
  return t;
};
const clips = (): ClipSet<Texture> => {
  const walk = DIRS.map(() => [tex(), tex()]);
  const meta: AnimMeta = {
    w: 64,
    h: 64,
    anchor: "bc",
    foot: 0,
    top: 46,
    shadow: "ellipse",
    actions: { walk: { frames: 2, ms: 0, perTile: 1, dirs: DIRS } },
  };
  return { meta, frames: { walk }, still: walk[2]?.[0] };
};
/** A fade filter that needs no WebGL. */
const fakeFade = (): AlphaFilter => ({ alpha: 1, destroy() {} }) as unknown as AlphaFilter;

describe("CastShadows", () => {
  it("lays each part on the ground from its feet with the sun's skew and squash", () => {
    const layer = new CastShadows(fakeFade);
    expect(layer.begin({ skewX: 0.8, scaleY: 0.5, alpha: 0.3 })).toBe(true);
    const t = tex();
    layer.part(t, 100, 200, -1, 1);
    layer.end();
    expect(layer.root.visible).toBe(true);
    expect(layer.count).toBe(1);
    const s = layer.root.children[0];
    expect(s?.position).toMatchObject({ x: 100, y: 200 });
    expect(s?.scale.x).toBe(-1); // mirrored like the body
    expect(s?.scale.y).toBeCloseTo(0.5);
    expect(s?.skew.x).toBeCloseTo(0.8);
    expect((s as { tint?: number }).tint).toBe(CAST_SHADOW_TINT);
    expect((layer.root.filters as AlphaFilter[])[0]?.alpha).toBeCloseTo(0.3);
  });

  it("reuses its sprites frame after frame and hides what a frame did not use", () => {
    const layer = new CastShadows(fakeFade);
    for (let f = 0; f < 10; f++) {
      layer.begin({ skewX: 0, scaleY: 0.2, alpha: 0.3 });
      const n = f % 2 === 0 ? 3 : 1;
      for (let i = 0; i < n; i++) layer.part(Texture.WHITE, i, 0, 1, 1);
      layer.end();
    }
    expect(layer.made).toBe(3);
    expect(layer.root.children.filter((c) => c.visible)).toHaveLength(1);
  });

  it("hides with no light to cast (alpha 0, or none)", () => {
    const layer = new CastShadows(fakeFade);
    layer.begin({ skewX: 0, scaleY: 0.2, alpha: 0.3 });
    layer.part(Texture.WHITE, 0, 0, 1, 1);
    layer.end();
    expect(layer.begin({ skewX: 0, scaleY: 0.2, alpha: 0 })).toBe(false);
    expect(layer.root.visible).toBe(false);
    expect(layer.begin(undefined)).toBe(false);
    expect(layer.root.visible).toBe(false);
  });
});

describe("CreatureBody.castShadow", () => {
  const record = (): { sink: ShadowSink; parts: unknown[][] } => {
    const parts: unknown[][] = [];
    return { parts, sink: { part: (...a) => void parts.push(a) } };
  };

  it("hands every layer of a paper doll, in its current frame, at the feet", () => {
    const layers: BodyLayer[] = [
      { slot: "body", clips: clips(), tint: 0xffffff },
      { slot: "torso", clips: clips(), tint: 0x884422 },
      { slot: "weapon", clips: clips(), tint: 0xffffff },
    ];
    const body = new CreatureBody(clips(), T, 0xffffff, layers, new SpritePool(), fakeFade);
    const pose = newPose();
    pose.action = "walk";
    pose.frame = 1;
    pose.x = 2;
    pose.y = -5; // a hop: the shadow stays down
    pose.scaleX = -1;
    body.draw(pose, 1);
    const { sink, parts } = record();
    body.castShadow(sink, 320, 640);
    expect(parts).toHaveLength(3);
    const textures = parts.map((p) => p[0]);
    expect(textures).toContain(layers[1]?.clips.frames.walk?.[1]?.[1]);
    for (const p of parts)
      expect(p.slice(1)).toEqual([320 + T / 2 + 2, 640 + T - FEET_LINE, -1, 1]);
  });

  it("hands a one-sprite body's sprite, and nothing while it fades away", () => {
    const body = new CreatureBody(clips(), T);
    const pose = newPose();
    body.draw(pose, 2);
    const { sink, parts } = record();
    body.castShadow(sink, 0, 0);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.[0]).toBe(body.sprite.texture);
    pose.alpha = 0.3;
    body.draw(pose, 2);
    body.castShadow(sink, 0, 0);
    expect(parts).toHaveLength(1);
  });
});
