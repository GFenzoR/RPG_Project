import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EFFECT_IDS,
  MAX_EFFECT_FRAMES,
  effectFolder,
  effectFrame,
  effectFrames,
} from "./effects.ts";
import {
  EFFECT_BLOCK,
  EFFECT_BUFF,
  EFFECT_CONJURE,
  EFFECT_ELEMENT,
  EFFECT_GATHER,
  EFFECT_GATHER_MISS,
  EFFECT_HEAL,
  EFFECT_HIT,
  EFFECT_MS,
  ELEMENTS,
} from "../state/world.ts";

describe("effect folders", () => {
  it("names a folder for every effect id the server sends", () => {
    expect(effectFolder(EFFECT_HIT)).toBe("effects/hit");
    expect(effectFolder(EFFECT_BLOCK)).toBe("effects/block");
    expect(effectFolder(EFFECT_HEAL)).toBe("effects/heal");
    expect(effectFolder(EFFECT_CONJURE)).toBe("effects/conjure");
    expect(effectFolder(EFFECT_GATHER)).toBe("effects/gather");
    expect(effectFolder(EFFECT_GATHER_MISS)).toBe("effects/gather_miss");
    expect(effectFolder(EFFECT_BUFF)).toBe("effects/buff");
    // 10 + element index, in the server's order (physical … death).
    expect(effectFolder(EFFECT_ELEMENT)).toBe("effects/physical");
    expect(effectFolder(EFFECT_ELEMENT + 1)).toBe("effects/fire");
    expect(effectFolder(EFFECT_ELEMENT + 4)).toBe("effects/earth");
    expect(effectFolder(EFFECT_ELEMENT + ELEMENTS.length - 1)).toBe("effects/death");
    expect(EFFECT_IDS).toHaveLength(7 + ELEMENTS.length);
  });

  it("knows no other id", () => {
    expect(effectFolder(0)).toBeUndefined();
    expect(effectFolder(8)).toBeUndefined();
    expect(effectFolder(EFFECT_ELEMENT + ELEMENTS.length)).toBeUndefined();
  });

  it("has the art of every folder committed (tools/spritegen, make spritegen)", () => {
    for (const id of EFFECT_IDS) {
      const folder = effectFolder(id) ?? "";
      for (const f of [0, 1]) {
        const png = new URL(`../../../assets/sprites/${folder}/${f}.png`, import.meta.url);
        expect(existsSync(png), `${folder}/${f}`).toBe(true);
      }
    }
  });
});

describe("effect frames", () => {
  const atlas = (sprites: string[]) => (s: string) => sprites.includes(s);

  it("lists the strip up to the first missing frame", () => {
    const has = atlas(["effects/hit/0", "effects/hit/1", "effects/hit/2", "effects/hit/4"]);
    expect(effectFrames(EFFECT_HIT, has)).toEqual([
      "effects/hit/0",
      "effects/hit/1",
      "effects/hit/2",
    ]);
  });

  it("is empty without art or for an unknown id: the procedural shape", () => {
    expect(effectFrames(EFFECT_HIT, atlas([]))).toEqual([]);
    expect(effectFrames(EFFECT_HIT, atlas(["effects/hit/1"]))).toEqual([]);
    expect(effectFrames(99, () => true)).toEqual([]);
  });

  it("stops at MAX_EFFECT_FRAMES", () => {
    expect(effectFrames(EFFECT_HEAL, () => true)).toHaveLength(MAX_EFFECT_FRAMES);
  });
});

describe("frame at a time", () => {
  it("spreads the frames evenly over the effect time", () => {
    expect(effectFrame(0, 6, 600)).toBe(0);
    expect(effectFrame(99, 6, 600)).toBe(0);
    expect(effectFrame(100, 6, 600)).toBe(1);
    expect(effectFrame(250, 6, 600)).toBe(2);
    expect(effectFrame(599, 6, 600)).toBe(5);
  });

  it("holds the first frame before the start and the last from the end on", () => {
    expect(effectFrame(-50, 6, 600)).toBe(0);
    expect(effectFrame(600, 6, 600)).toBe(5);
    expect(effectFrame(10_000, 6, 600)).toBe(5);
  });

  it("uses EFFECT_MS by default and survives odd input", () => {
    expect(effectFrame(EFFECT_MS - 1, 4)).toBe(3);
    expect(effectFrame(EFFECT_MS / 2, 4)).toBe(2);
    expect(effectFrame(300, 1)).toBe(0);
    expect(effectFrame(300, 0)).toBe(0);
    expect(effectFrame(Number.NaN, 6)).toBe(0);
    expect(effectFrame(300, 6, 0)).toBe(0);
  });
});
