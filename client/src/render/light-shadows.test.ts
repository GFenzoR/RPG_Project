import { describe, expect, it } from "vitest";
import { Sprite, Texture } from "pixi.js";
import type { AlphaFilter } from "pixi.js";
import { DEFAULT_LIGHT_SHADOWS } from "@rpg/living-world";
import { CONTACT_GONE, CastShadows, contactOf, poseOf } from "./cast-shadows.ts";
import { LightField, LitObjectShadows, castTransform } from "./light-shadows.ts";
import type { LightMap } from "./light-shadows.ts";
import type { ObjectShadowHint } from "./object-shadows.ts";

const T = 32;
const tex = (w: number, h: number): Texture =>
  ({ width: w, height: h, source: {}, destroy() {} }) as unknown as Texture;
const fakeFade = (): AlphaFilter => ({ alpha: 1, destroy() {} }) as unknown as AlphaFilter;

interface Item {
  x: number;
  y: number;
  key: string;
  sprite: Sprite;
}

class FakeMap implements LightMap {
  version = 1;
  items: Item[] = [];
  lights: [number, number, number][] = [];
  indoor = new Set<string>();
  add(key: string, x: number, y: number): Sprite {
    const sprite = new Sprite({ texture: tex(32, 48), anchor: { x: 1, y: 1 } });
    sprite.position.set((x + 1) * T, (y + 1) * T);
    this.items.push({ x, y, key, sprite });
    this.version++;
    return sprite;
  }
  forEachItemSprite(fn: (x: number, y: number, key: string, sprite: Sprite) => void): void {
    for (const i of this.items) fn(i.x, i.y, i.key, i.sprite);
  }
  forEachLight(fn: (x: number, y: number, radius: number) => void): void {
    for (const [x, y, r] of this.lights) fn(x, y, r);
  }
  indoorAt(x: number, y: number): boolean {
    return this.indoor.has(`${x},${y}`);
  }
}

const hints: Record<string, ObjectShadowHint> = {
  barrel: { cast: "silhouette", length: 1, foot: 0 },
  wall: { cast: "block", length: 1, foot: 0 },
};
const hintOf = (key: string): ObjectShadowHint | undefined => hints[key];

/** A room x 10..14, y 10..14 with a hearth inside, a torch on its wall and a lamp in the street. */
function town(): FakeMap {
  const map = new FakeMap();
  for (let y = 10; y <= 14; y++) for (let x = 10; x <= 14; x++) map.indoor.add(`${x},${y}`);
  map.lights.push([12, 12, 3]); // hearth, under the roof
  map.lights.push([30, 12, 3]); // lamp post, in the street
  return map;
}

describe("LightField (docs/17 'Sombras de las luces')", () => {
  it("casts indoors by day, away from the room's own light", () => {
    const field = new LightField(DEFAULT_LIGHT_SHADOWS);
    field.sync(town());
    expect(field.count).toBe(2);
    // East of the hearth, at noon (open 0): the shadow falls east, at full strength.
    const k = field.at(13.5, 12, true, 0);
    expect(k).toBe(1);
    const pose = poseOf(field.pose.skewX, field.pose.scaleY, 1);
    expect(pose.x).toBeGreaterThan(0);
    expect(Math.abs(pose.y)).toBeLessThan(1e-9);
  });

  it("casts nothing in the street by day, and by the lamp at night", () => {
    const field = new LightField(DEFAULT_LIGHT_SHADOWS);
    field.sync(town());
    expect(field.at(31, 12, false, 0)).toBe(0);
    expect(field.at(31, 12, false, 1)).toBe(1);
    // Dusk: the lamps half lit, the shadow half as strong.
    expect(field.at(31, 12, false, 0.5)).toBeCloseTo(0.5, 9);
    // Far from every light: none, night or not.
    expect(field.at(60, 60, false, 1)).toBe(0);
  });

  it("keeps the hearth's shadows inside and the lamp's outside; a wall torch lights both", () => {
    const map = town();
    const field = new LightField(DEFAULT_LIGHT_SHADOWS);
    field.sync(map);
    // Just outside the room, 3 tiles from the hearth, at night: the hearth does not reach out.
    expect(field.at(15, 12, false, 1)).toBe(0);
    // A torch on the east wall (x 15: not a floor tile, next to one).
    map.lights.push([15, 12, 3]);
    map.version++;
    field.sync(map);
    expect(field.count).toBe(3);
    expect(field.at(17, 12, false, 1)).toBe(1);
    expect(field.at(14, 13, true, 0)).toBeGreaterThan(0);
  });

  it("reads the lights again only when the map changed", () => {
    const map = town();
    const field = new LightField(DEFAULT_LIGHT_SHADOWS);
    field.sync(map);
    map.lights.push([40, 40, 3]);
    field.sync(map);
    expect(field.count).toBe(2);
    map.version++;
    field.sync(map);
    expect(field.count).toBe(3);
  });

  it("lays a shadow to the south with a transform that points south", () => {
    const out = { skewX: 0, scaleY: 0 };
    castTransform({ x: 0, y: -1, strength: 1 }, out);
    const pose = poseOf(out.skewX, out.scaleY, 1);
    expect(pose.x).toBeCloseTo(0, 9);
    expect(pose.y).toBeCloseTo(-1, 9);
    castTransform({ x: 0.5, y: 0.5, strength: 1 }, out);
    const ne = poseOf(out.skewX, out.scaleY, 1);
    expect(ne.x).toBeCloseTo(0.5, 9);
    expect(ne.y).toBeCloseTo(0.5, 9);
  });

  it("breathes only without reduced motion", () => {
    const field = new LightField(DEFAULT_LIGHT_SHADOWS);
    expect(field.alpha(1234, true)).toBe(DEFAULT_LIGHT_SHADOWS.alpha);
    const seen = new Set<number>();
    for (let t = 0; t < 1000; t += 50) seen.add(field.alpha(t, false));
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe("the contact ellipse (owner, 2026-11-26)", () => {
  it("is gone whenever a shadow is cast: the sun's, the moon's or a lamp's", () => {
    expect(contactOf(0.42, 0, 0.4)).toBe(0);
    expect(contactOf(0, 0.34, 0.4)).toBe(0);
    expect(contactOf(0.16, 0.34, 0.4)).toBe(0);
    expect(contactOf(CONTACT_GONE, 0, 0.4)).toBe(0);
  });

  it("stays, much fainter than before, where nothing casts one", () => {
    expect(contactOf(0, 0, 0.4)).toBeCloseTo(0.4, 9);
    expect(contactOf(0, 0, 0.4)).toBeLessThan(0.5);
    // Without the lights' data (an old build): the ellipse as it was.
    expect(contactOf(0, 0, 1)).toBe(1);
  });

  it("crossfades with a shadow that is fading in or out, never above the unlit share", () => {
    let prev = contactOf(0, 0, 0.4);
    for (let a = 0.005; a <= CONTACT_GONE; a += 0.005) {
      const now = contactOf(0, a, 0.4);
      expect(now).toBeLessThanOrEqual(prev);
      expect(prev - now).toBeLessThan(0.05);
      prev = now;
    }
  });
});

describe("CastShadows.aim: each caster its own direction and strength", () => {
  it("places the parts that follow with the aimed transform and strength, from the pool", () => {
    const layer = new CastShadows(fakeFade);
    expect(layer.begin(poseOf(0, 0, 0.34))).toBe(true);
    layer.aim(0.5, 0.8, 0.6);
    layer.part(tex(32, 48), 100, 200, 1, 1);
    layer.aim(-1, 1.2, 1);
    layer.part(tex(32, 48), 300, 200, 1, 1);
    layer.end();
    const [a, b] = layer.root.children as Sprite[];
    expect(a?.skew.x).toBeCloseTo(0.5, 9);
    expect(a?.scale.y).toBeCloseTo(0.8, 9);
    expect(a?.alpha).toBeCloseTo(0.6, 9);
    expect(b?.skew.x).toBeCloseTo(-1, 9);
    expect(b?.alpha).toBe(1);
    expect(layer.made).toBe(2);
    // The next frames reuse the two sprites, and a sun frame resets the strength.
    for (let i = 0; i < 5; i++) {
      layer.begin(poseOf(0.2, 0.9, 0.4));
      layer.part(tex(32, 48), 100, 200, 1, 1);
      layer.part(tex(32, 48), 300, 200, 1, 1);
      layer.end();
    }
    expect(layer.made).toBe(2);
    expect(a?.alpha).toBe(1);
  });
});

describe("LitObjectShadows", () => {
  const setup = (): { map: FakeMap; field: LightField; lit: LitObjectShadows } => {
    const map = town();
    const field = new LightField(DEFAULT_LIGHT_SHADOWS);
    field.sync(map);
    return { map, field, lit: new LitObjectShadows(hintOf) };
  };

  it("gives the objects near a light a shadow away from it; walls and far objects none", () => {
    const { map, field, lit } = setup();
    map.add("barrel", 14, 12); // in the room, east of the hearth
    map.add("wall", 15, 12);
    map.add("barrel", 60, 60); // far from everything
    map.add("barrel", 32, 12); // by the lamp, in the street
    field.sync(map);
    lit.update(map, field, 0);
    // By day: only the barrel in the room.
    expect(lit.count).toBe(1);
    const s = lit.root.children[0] as Sprite;
    expect(poseOf(s.skew.x, s.scale.y, 1).x).toBeGreaterThan(0);
    expect(s.position.y).toBe(13 * T);
    // At night the one by the lamp too.
    lit.update(map, field, 1);
    expect(lit.count).toBe(2);
  });

  it("is placed again only when the map or the night changed, and reuses its sprites", () => {
    const { map, field, lit } = setup();
    map.add("barrel", 14, 12);
    map.add("barrel", 32, 12);
    field.sync(map);
    for (let i = 0; i < 10; i++) lit.update(map, field, 1);
    expect(lit.placed).toBe(1);
    expect(lit.made).toBe(2);
    lit.update(map, field, 1.001);
    expect(lit.placed).toBe(1);
    lit.update(map, field, 0);
    expect(lit.placed).toBe(2);
    expect(lit.count).toBe(1);
    lit.update(map, field, 1);
    expect(lit.made).toBe(2);
    expect(lit.count).toBe(2);
    // No lights' shadows at all (the layer is off): hidden.
    lit.update(map, undefined, 1);
    expect(lit.count).toBe(0);
    expect(lit.root.visible).toBe(false);
  });
});
