import { Container, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { FEET_LINE } from "@rpg/renderer";
import type { AnimMeta } from "@rpg/renderer";
import { CONTACT_FLAT, CreatureBody, contactWidth } from "./creature-body.ts";
import type { ClipSet } from "./clips.ts";
import {
  HALO_ALPHA,
  HALO_MARGIN,
  HALO_SWING,
  TargetHalo,
  haloAlpha,
  haloShape,
} from "./target-halo.ts";

const DIRS: ("n" | "e" | "s" | "w")[] = ["n", "e", "s", "w"];
const T = 32;
const tex = (w: number, h: number): Texture => {
  const t = new Texture();
  t.frame.width = w;
  t.frame.height = h;
  return t;
};
const clips = (stance?: AnimMeta["stance"]): ClipSet<Texture> => {
  const walk = DIRS.map(() => [tex(64, 64)]);
  const meta: AnimMeta = {
    w: 64,
    h: 64,
    anchor: "bc",
    foot: 2,
    top: 46,
    shadow: "ellipse",
    ...(stance ? { stance } : {}),
    actions: { walk: { frames: 1, ms: 0, perTile: 1, dirs: DIRS } },
  };
  return { meta, frames: { walk }, still: walk[2]?.[0], eight: false };
};

describe("target halo", () => {
  it("is a flat ellipse wider than the contact one, on the feet line", () => {
    const body = new CreatureBody(clips(), T);
    const st = body.stand();
    expect(st.y).toBe(T - FEET_LINE); // foot 2 over the 4 px line: baseY - foot
    const s = haloShape(st);
    expect(s.x).toBe(st.x);
    expect(s.y).toBe(st.y);
    expect(s.w).toBe(Math.round(contactWidth(st.width) + HALO_MARGIN));
    expect(s.h).toBe(Math.round(s.w * CONTACT_FLAT));
    expect(s.h).toBeLessThan(s.w / 2);
  });

  it("grows with the base of the creature, within the contact limits", () => {
    const small = haloShape({ x: 16, y: 28, width: 4 });
    const big = haloShape({ x: 16, y: 28, width: 40 });
    const huge = haloShape({ x: 16, y: 28, width: 400 });
    expect(big.w).toBeGreaterThan(small.w);
    expect(huge.w).toBe(contactWidth(400) + HALO_MARGIN);
  });

  it("pulses softly and stays still with reduced motion", () => {
    const seen = new Set<number>();
    for (let t = 0; t < 1800; t += 150) {
      const a = haloAlpha(t, false);
      expect(a).toBeGreaterThanOrEqual(HALO_ALPHA - HALO_SWING - 1e-9);
      expect(a).toBeLessThanOrEqual(HALO_ALPHA + HALO_SWING + 1e-9);
      seen.add(Math.round(a * 100));
    }
    expect(seen.size).toBeGreaterThan(3);
    expect(haloAlpha(0, true)).toBe(haloAlpha(777, true));
  });

  it("is hidden until it is the target, follows the feet and redraws only on a new size", () => {
    const h = new TargetHalo();
    expect(h.graphic.visible).toBe(false);
    h.update({ x: 16, y: 28, width: 12 }, 0, true);
    expect(h.graphic.visible).toBe(true);
    const first = h.graphic.context;
    expect(h.graphic.position).toMatchObject({ x: 16, y: 28 });
    h.update({ x: 20, y: 30, width: 12 }, 50, true); // walking: only moves
    expect(h.graphic.position).toMatchObject({ x: 20, y: 30 });
    expect(h.graphic.context.instructions).toBe(first.instructions);
    h.update(undefined, 60, true);
    expect(h.graphic.visible).toBe(false);
  });

  it("sits under the figure in the creature's container (the sprite covers it)", () => {
    const body = new Container();
    const halo = new TargetHalo();
    const figure = new CreatureBody(clips(), T);
    body.addChild(halo.graphic);
    body.addChild(figure.root);
    expect(body.getChildIndex(halo.graphic)).toBeLessThan(body.getChildIndex(figure.root));
  });

  it("takes the feet from the atlas stance of the facing drawn", () => {
    // south: feet 6 rows up, from x 20 to 30 of 64: centre 25, 7 px left of the frame's middle
    const stance: AnimMeta["stance"] = { s: [6, 20, 30] } as AnimMeta["stance"];
    const body = new CreatureBody(clips(stance), T);
    const st = body.stand();
    expect(st.width).toBe(10);
    expect(st.x).toBe(T / 2 - 7);
    expect(st.y).toBe(T - FEET_LINE + 2 - 6);
  });
});
