import { Container, Texture } from "pixi.js";
import type { Graphics, Sprite, Text } from "pixi.js";
import { FloatingTextKind } from "@rpg/protocol";
import type { Atlas } from "@rpg/renderer";
import { describe, expect, it } from "vitest";
import { EffectLayer, floatingLabel } from "./effect-layer.ts";
import { ORB_FRAME_MS } from "./effects.ts";
import {
  EFFECT_CONJURE,
  EFFECT_HIT,
  EFFECT_MS,
  PROJECTILE_ELEMENT,
  PROJECTILE_MS,
} from "../state/world.ts";
import type {
  EffectState,
  FloatingTextState,
  ProjectileState,
  WorldState,
} from "../state/world.ts";

// An atlas with the hit strip (3 frames) only: conjure has no art and falls back to its shape.
const frames = [0, 1, 2].map(() => new Texture());
const sprites: Record<string, { page: number; origin: string }> = {
  "effects/hit/0": { page: 0, origin: "file" },
  "effects/hit/1": { page: 0, origin: "file" },
  "effects/hit/2": { page: 0, origin: "file" },
  "effects/heal/0": { page: 0, origin: "placeholder" },
};
const atlas = {
  tileSize: 32,
  index: { version: 1, tileSize: 32, pages: [], sprites },
  has: (s: string) => s in sprites,
  texture: (s: string) => (s.startsWith("effects/hit/") ? frames[Number(s.slice(12))] : undefined),
} as unknown as Atlas;

function setup() {
  const world = { effects: [], projectiles: [], floatingTexts: [] } as unknown as WorldState & {
    effects: EffectState[];
    floatingTexts: FloatingTextState[];
  };
  const effects = new Container();
  const texts = new Container();
  const layer = new EffectLayer({ world, atlas, effects, texts });
  const [spriteGroup, shapeGroup] = effects.children as [Container, Container, Container];
  const shown = (c: Container) => c.children.filter((o) => o.visible);
  return { world, layer, texts, spriteGroup, shapeGroup, shown };
}

const cam = { x: 0, y: 0, zoom: 2 };
const at = (x: number, y: number) => ({ x, y, z: 7 });

describe("floatingLabel", () => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    params ? `${key}${JSON.stringify(params)}` : key;
  const f = (kind: FloatingTextKind, amount: number, bonus?: number) => ({
    pos: { x: 0, y: 0, z: 7 },
    kind,
    amount,
    ...(bonus === undefined ? {} : { bonus }),
    start: 0,
  });

  it("marks the party bonus part of an experience number", () => {
    expect(floatingLabel(f(FloatingTextKind.EXPERIENCE, 126, 6), t)).toBe(
      'client.party.xp_bonus{"amount":126,"bonus":6}',
    );
  });

  it("writes the plain amount without a bonus, on other kinds or without texts", () => {
    expect(floatingLabel(f(FloatingTextKind.EXPERIENCE, 120, 0), t)).toBe("120");
    expect(floatingLabel(f(FloatingTextKind.EXPERIENCE, 120), t)).toBe("120");
    expect(floatingLabel(f(FloatingTextKind.DAMAGE, 12, 4), t)).toBe("12");
    expect(floatingLabel(f(FloatingTextKind.EXPERIENCE, 126, 6), undefined)).toBe("126");
  });
});

describe("EffectLayer", () => {
  it("plays the atlas frames of an effect over its time, anchored on its tile", () => {
    const { world, layer, spriteGroup, shapeGroup, shown } = setup();
    world.effects.push({ pos: at(3, 2), effectId: EFFECT_HIT, start: 1000 });
    layer.draw(1000, 7, cam, 2);
    const s = spriteGroup.children[0] as Sprite;
    expect(shown(spriteGroup)).toHaveLength(1);
    expect(shown(shapeGroup)).toHaveLength(0);
    expect(s.texture).toBe(frames[0]);
    // Bottom-right corner of tile (3, 2) at 64 screen pixels per tile.
    expect([s.x, s.y]).toEqual([4 * 64, 3 * 64]);
    expect(s.scale.x).toBe(2);
    layer.draw(1000 + EFFECT_MS / 2, 7, cam, 2);
    expect(s.texture).toBe(frames[1]);
    layer.draw(1000 + EFFECT_MS - 1, 7, cam, 2);
    expect(s.texture).toBe(frames[2]);
  });

  it("draws the procedural shape for an effect without art (or with a placeholder)", () => {
    const { world, layer, spriteGroup, shapeGroup, shown } = setup();
    world.effects.push({ pos: at(1, 1), effectId: EFFECT_CONJURE, start: 0 });
    world.effects.push({ pos: at(1, 1), effectId: 3, start: 0 }); // heal: placeholder only
    layer.draw(0, 7, cam, 2);
    expect(shown(spriteGroup)).toHaveLength(0);
    const shapes = shown(shapeGroup) as Graphics[];
    expect(shapes).toHaveLength(2);
    expect(shapes[0]?.context).not.toBe(shapes[1]?.context);
    expect([shapes[0]?.x, shapes[0]?.y]).toEqual([64, 64]);
  });

  it("reuses its display objects and hides what the world dropped or is on another floor", () => {
    const { world, layer, spriteGroup, texts, shown } = setup();
    for (let i = 0; i < 3; i++)
      world.effects.push({ pos: at(i, 0), effectId: EFFECT_HIT, start: 0 });
    world.floatingTexts.push({
      pos: at(0, 0),
      kind: FloatingTextKind.DAMAGE,
      amount: 12,
      start: 0,
    });
    layer.draw(0, 7, cam, 1);
    expect(spriteGroup.children).toHaveLength(3);
    expect(shown(texts)).toHaveLength(1);
    const first = spriteGroup.children[0];
    const text = texts.children[0];

    world.effects.splice(0, 2);
    world.effects.push({ pos: at(5, 5), effectId: EFFECT_HIT, start: 10 });
    world.floatingTexts.length = 0;
    layer.draw(20, 7, cam, 1);
    expect(spriteGroup.children).toHaveLength(3); // no new sprite
    expect(spriteGroup.children[0]).toBe(first);
    expect(shown(spriteGroup)).toHaveLength(2);
    expect(shown(texts)).toHaveLength(0);

    // A new number takes the spare Text back.
    world.floatingTexts.push({ pos: at(1, 1), kind: FloatingTextKind.HEAL, amount: 5, start: 30 });
    world.effects[0] = { pos: at(0, 0), effectId: EFFECT_HIT, start: 30 };
    world.effects[0].pos.z = 8;
    layer.draw(30, 7, cam, 1);
    expect(texts.children).toHaveLength(1);
    expect(texts.children[0]).toBe(text);
    expect(shown(texts)).toHaveLength(1);
    expect(shown(spriteGroup)).toHaveLength(1); // the effect on floor 8 is not drawn
    layer.destroy();
  });
});

describe("EffectLayer projectiles", () => {
  // The arrow, the fire orb (3 frames and its trail) and an ice orb that is only a
  // placeholder: ice and energy fly as the procedural dot.
  const tex = new Map<string, Texture>();
  const missileSprites: Record<string, { page: number; origin: string }> = {};
  for (const s of [
    "missiles/arrow/e",
    "missiles/arrow/se",
    "missiles/fire/0",
    "missiles/fire/1",
    "missiles/fire/2",
    "missiles/fire/trail",
    "missiles/ice/0",
  ]) {
    missileSprites[s] = { page: 0, origin: s.startsWith("missiles/ice") ? "placeholder" : "file" };
    tex.set(s, new Texture());
  }
  const missileAtlas = {
    tileSize: 32,
    index: { version: 1, tileSize: 32, pages: [], sprites: missileSprites },
    has: (s: string) => s in missileSprites,
    texture: (s: string) => tex.get(s),
  } as unknown as Atlas;

  function shots() {
    const world = { effects: [], projectiles: [], floatingTexts: [] } as unknown as WorldState & {
      projectiles: ProjectileState[];
    };
    const effects = new Container();
    const layer = new EffectLayer({ world, atlas: missileAtlas, effects, texts: new Container() });
    const [, , dots, missiles] = effects.children as [Container, Container, Container, Container];
    const shown = (c: Container) => c.children.filter((o) => o.visible);
    return { world, layer, dots, missiles, shown };
  }
  const shot = (id: number, from: [number, number], to: [number, number], start = 0) => ({
    from: at(...from),
    to: at(...to),
    projectileId: id,
    start,
  });
  const ARROW = PROJECTILE_ELEMENT;
  const FIRE = PROJECTILE_ELEMENT + 1;
  const ICE = PROJECTILE_ELEMENT + 2;

  it("flies an arrow turned toward its target, pixel-perfect, along its path", () => {
    const { world, layer, missiles, shown } = shots();
    world.projectiles.push(shot(ARROW, [2, 2], [6, 2])); // east
    world.projectiles.push(shot(ARROW, [2, 2], [2, 0])); // north
    world.projectiles.push(shot(ARROW, [2, 2], [0, 4])); // south-west
    layer.draw(PROJECTILE_MS / 2, 7, cam, 2);
    const [east, north, southWest] = shown(missiles) as Sprite[];
    expect(shown(missiles)).toHaveLength(3);
    expect(east?.texture).toBe(tex.get("missiles/arrow/e"));
    expect([east?.rotation, east?.scale.x, east?.scale.y]).toEqual([0, 2, 2]);
    // Half way from the centre of (2, 2) to the centre of (6, 2), 64 px per tile.
    expect([east?.x, east?.y]).toEqual([4.5 * 64, 2.5 * 64]);
    expect(north?.texture).toBe(tex.get("missiles/arrow/e"));
    expect(north?.rotation).toBeCloseTo(-Math.PI / 2);
    expect(southWest?.texture).toBe(tex.get("missiles/arrow/se"));
    expect([southWest?.rotation, southWest?.scale.x, southWest?.scale.y]).toEqual([0, -2, 2]);
    expect([southWest?.x, southWest?.y]).toEqual([1.5 * 64, 3.5 * 64]);
  });

  it("flies an orb with its loop and motes behind it, none behind the shooter", () => {
    const { world, layer, missiles, dots, shown } = shots();
    world.projectiles.push(shot(FIRE, [0, 0], [4, 0]));
    // At the start no mote fits between the shooter and the orb.
    layer.draw(0, 7, cam, 1);
    expect(shown(missiles)).toHaveLength(1);
    expect((shown(missiles)[0] as Sprite).texture).toBe(tex.get("missiles/fire/0"));
    // A quarter of the way (one tile): the motes 0.3, 0.6 and 0.9 tiles back, then the orb.
    layer.draw(PROJECTILE_MS / 4, 7, cam, 1);
    const drawn = shown(missiles) as Sprite[];
    expect(drawn.map((s) => s.texture)).toEqual([
      tex.get("missiles/fire/trail"),
      tex.get("missiles/fire/trail"),
      tex.get("missiles/fire/trail"),
      tex.get("missiles/fire/0"),
    ]);
    // cam.zoom 2: 64 screen px per tile.
    expect(drawn.map((s) => s.x)).toEqual([
      Math.round((1.5 - 0.3) * 64),
      Math.round((1.5 - 0.6) * 64),
      Math.round((1.5 - 0.9) * 64),
      1.5 * 64,
    ]);
    expect(drawn[0]?.alpha).toBeGreaterThan(drawn[2]?.alpha ?? 1);
    expect(drawn[3]?.alpha).toBe(1);
    // The loop goes on with the flight.
    layer.draw(ORB_FRAME_MS * 2 + 1, 7, cam, 1);
    expect((shown(missiles).at(-1) as Sprite).texture).toBe(tex.get("missiles/fire/2"));
    expect(shown(dots)).toHaveLength(0);
  });

  it("falls back to the dot without real art, and reuses every display object", () => {
    const { world, layer, missiles, dots, shown } = shots();
    world.projectiles.push(shot(ICE, [0, 0], [3, 3]));
    world.projectiles.push(shot(PROJECTILE_ELEMENT + 3, [0, 0], [3, 3])); // energy: no art
    world.projectiles.push(shot(ARROW, [0, 0], [3, 3]));
    layer.draw(100, 7, cam, 1);
    expect(shown(dots)).toHaveLength(2);
    expect(shown(missiles)).toHaveLength(1);
    const arrow = missiles.children[0];
    world.projectiles.splice(0, 2);
    layer.draw(120, 7, cam, 1);
    expect(shown(dots)).toHaveLength(0);
    expect(missiles.children).toHaveLength(1);
    expect(missiles.children[0]).toBe(arrow);
    layer.destroy();
  });

  it("draws the floating numbers at the names' scale, nearest-neighbour", () => {
    const { world, layer, texts } = setup();
    world.floatingTexts.push({ pos: at(0, 0), kind: FloatingTextKind.DAMAGE, amount: 7, start: 0 });
    layer.draw(0, 7, cam, 4, 3);
    const text = texts.children[0] as Text;
    expect([text.scale.x, text.scale.y]).toEqual([3, 3]);
    expect(text.textureStyle?.scaleMode).toBe("nearest");
    layer.draw(10, 7, cam, 1);
    expect([text.scale.x, text.scale.y]).toEqual([1, 1]);
    layer.destroy();
  });
});
