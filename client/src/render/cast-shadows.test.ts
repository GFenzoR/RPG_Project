import { Texture } from "pixi.js";
import type { AlphaFilter } from "pixi.js";
import { describe, expect, it } from "vitest";
import { CAST_SHADOW_TINT, FEET_LINE, newPose } from "@rpg/renderer";
import type { AnimMeta } from "@rpg/renderer";
import { CastShadows, feetAnchor, leanOnGround, poseOf } from "./cast-shadows.ts";
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
const clips = (foot = 0): ClipSet<Texture> => {
  const walk = DIRS.map(() => [tex(), tex()]);
  const meta: AnimMeta = {
    w: 64,
    h: 64,
    anchor: "bc",
    foot,
    top: 46,
    shadow: "ellipse",
    actions: { walk: { frames: 2, ms: 0, perTile: 1, dirs: DIRS } },
  };
  return { meta, frames: { walk }, still: walk[2]?.[0], eight: false };
};
/** A fade filter that needs no WebGL. */
const fakeFade = (): AlphaFilter => ({ alpha: 1, destroy() {} }) as unknown as AlphaFilter;

describe("CastShadows", () => {
  it("lays each part on the ground from its feet with the sun's skew and squash", () => {
    const layer = new CastShadows(fakeFade);
    expect(layer.begin(poseOf(0.8, 0.5, 0.3))).toBe(true);
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

  it("turns a sprite with empty rows under its feet around the feet, not the texture's edge", () => {
    const layer = new CastShadows(fakeFade);
    layer.begin(poseOf(1.1, 0.9, 0.3));
    const t = tex(); // 64 tall
    layer.part(t, 100, 200, 1, 1, 8);
    layer.part(t, 50, 60, 1, 1); // the pooled sprite after it: on the bottom edge
    layer.end();
    const [s, plain] = layer.root.children as unknown as { anchor: { y: number } }[];
    // The feet row (8 px above the bottom) is the pivot: it stays on (100, 200) at any sun.
    expect(s?.anchor.y).toBeCloseTo(1 - 8 / 64);
    expect(layer.root.children[0]?.position).toMatchObject({ x: 100, y: 200 });
    expect(plain?.anchor.y).toBe(1);
    // A pooled sprite takes the foot of whoever uses it this frame.
    layer.begin(poseOf(1.1, 0.9, 0.3));
    layer.part(t, 100, 200, 1, 1);
    layer.end();
    expect(s?.anchor.y).toBe(1);
    expect(feetAnchor(10, 0)).toBe(1);
    expect(feetAnchor(80, 64)).toBe(0);
  });

  it("leans the shadow with a body drawn leaning (Pose.skewX)", () => {
    const [kb, by, ks, S] = [0.25, 0.9, -0.7, 0.6];
    const out = { skewX: 0, scaleY: 0 };
    leanOnGround(kb, by, ks, S, out);
    // The body's y axis, then laid on the ground.
    const bx = Math.sin(kb) * by;
    const bY = Math.cos(kb) * by;
    expect(Math.sin(out.skewX) * out.scaleY).toBeCloseTo(bx + Math.sin(ks) * S * bY);
    expect(Math.cos(out.skewX) * out.scaleY).toBeCloseTo(Math.cos(ks) * S * bY);
    leanOnGround(0, 0.9, ks, S, out);
    expect(out).toEqual({ skewX: ks, scaleY: 0.9 * S });

    const layer = new CastShadows(fakeFade);
    layer.begin(poseOf(ks, S, 0.3));
    layer.part(tex(), 0, 0, 1, by, 0, kb);
    leanOnGround(kb, by, ks, S, out);
    expect(layer.root.children[0]?.skew.x).toBeCloseTo(out.skewX);
    expect(layer.root.children[0]?.skew.x).not.toBeCloseTo(ks);
  });

  it("reuses its sprites frame after frame and hides what a frame did not use", () => {
    const layer = new CastShadows(fakeFade);
    for (let f = 0; f < 10; f++) {
      layer.begin(poseOf(0, 0.2, 0.3));
      const n = f % 2 === 0 ? 3 : 1;
      for (let i = 0; i < n; i++) layer.part(Texture.WHITE, i, 0, 1, 1);
      layer.end();
    }
    expect(layer.made).toBe(3);
    expect(layer.root.children.filter((c) => c.visible)).toHaveLength(1);
  });

  // Only the pool: the frame time and the filter pass are not measured here (docs/14).
  it("makes one sprite per drawn layer of a crowd, once", () => {
    const layer = new CastShadows(fakeFade);
    // 60 paper dolls of 9 layers in view, 120 frames: the pool never grows after the first.
    for (let f = 0; f < 120; f++) {
      layer.begin(poseOf(0.3, 0.4, 0.4));
      for (let i = 0; i < 60 * 9; i++) layer.part(Texture.WHITE, i, f, 1, 1);
      layer.end();
    }
    expect(layer.made).toBe(540);
    expect(layer.count).toBe(540);
  });

  // docs/07: placing a crowd's shadows is ~0.035 ms of JS a frame (Node, 2026-11-24). A
  // wide ceiling, so only a real regression (work per sprite, allocation) trips it. The
  // browser's side (batches, the filter pass) is not measured here (docs/14).
  it("places a crowd's shadows well inside the frame budget", () => {
    const layer = new CastShadows(fakeFade);
    const t = tex();
    const frame = (f: number): void => {
      layer.begin(poseOf(0.3 + f * 1e-4, 0.4, 0.4));
      for (let i = 0; i < 60 * 9; i++)
        layer.part(t, i + f, f, i % 2 === 0 ? 1 : -1, 1, 8, (i % 3) * 0.1);
      layer.end();
    };
    for (let f = 0; f < 50; f++) frame(f); // the pool, and the JIT
    const frames = 500;
    const start = performance.now();
    for (let f = 0; f < frames; f++) frame(f);
    expect((performance.now() - start) / frames).toBeLessThan(2);
  });

  it("hides with no light to cast (alpha 0, or none)", () => {
    const layer = new CastShadows(fakeFade);
    layer.begin(poseOf(0, 0.2, 0.3));
    layer.part(Texture.WHITE, 0, 0, 1, 1);
    layer.end();
    expect(layer.begin(poseOf(0, 0.2, 0))).toBe(false);
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
      expect(p.slice(1)).toEqual([320 + T / 2 + 2, 640 + T - FEET_LINE, -1, 1, 0, 0]);
  });

  it("stands the shadow on the feet line of a sprite with empty rows under its feet", () => {
    for (const foot of [0, 8]) {
      const body = new CreatureBody(clips(foot), T);
      const pose = newPose();
      pose.skewX = 0.2;
      body.draw(pose, 2);
      const { sink, parts } = record();
      body.castShadow(sink, 320, 640);
      // The feet stay on the feet line whatever the clip's foot; the sink gets the foot
      // to pivot there, and the body's lean.
      expect(parts[0]?.slice(1)).toEqual([320 + T / 2, 640 + T - FEET_LINE, 1, 1, foot, 0.2]);
    }
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
