import { Container, Texture } from "pixi.js";
import type { Graphics, Sprite } from "pixi.js";
import { FloatingTextKind } from "@rpg/protocol";
import type { Atlas } from "@rpg/renderer";
import { describe, expect, it } from "vitest";
import { EffectLayer } from "./effect-layer.ts";
import { EFFECT_CONJURE, EFFECT_HIT, EFFECT_MS } from "../state/world.ts";
import type { EffectState, FloatingTextState, WorldState } from "../state/world.ts";

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
