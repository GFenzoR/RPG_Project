import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import { canvas, outline, polygon, px, rng, seedOf, tileNoise } from "./draw.ts";
import {
  checkPaths,
  EFFECT_FRAME,
  OUTFIT_FRAME,
  previewSheet,
  RECIPES,
  recipePaths,
  render,
  spriteFile,
} from "./index.ts";
import { EFFECT_FRAMES } from "./recipes/effects.ts";
import { PALETTE } from "./palette.ts";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function lum(img: Image, x: number, y: number): number {
  const i = (y * img.width + x) * 4;
  return 0.3 * (img.data[i] ?? 0) + 0.59 * (img.data[i + 1] ?? 0) + 0.11 * (img.data[i + 2] ?? 0);
}

describe("draw helpers", () => {
  it("rng and seedOf are reproducible", () => {
    const a = rng(seedOf("decor/anvil"));
    const b = rng(seedOf("decor/anvil"));
    for (let i = 0; i < 50; i++) expect(a()).toBe(b());
    expect(seedOf("a")).not.toBe(seedOf("b"));
  });

  it("tileNoise wraps at its period", () => {
    for (let y = 0; y < 32; y += 3)
      for (let x = 0; x < 32; x += 5)
        expect(tileNoise(x + 32, y - 32, 4, 2, 9)).toBeCloseTo(tileNoise(x, y, 4, 2, 9), 12);
  });

  it("polygon fills by pixel centres and outline darkens only the rim", () => {
    const img = canvas(8, 8);
    polygon(
      img,
      [
        [1, 1],
        [7, 1],
        [7, 7],
        [1, 7],
      ],
      PALETTE.stone.base,
    );
    outline(img);
    expect(img.data[(0 * 8 + 0) * 4 + 3]).toBe(0);
    expect(lum(img, 1, 1)).toBeLessThan(lum(img, 3, 3));
    expect(lum(img, 3, 3)).toBe(lum(img, 4, 4));
    px(img, 0, 0, PALETTE.gold.light);
    expect(img.data[3]).toBe(255);
  });
});

describe("recipes", () => {
  const paths = recipePaths();

  it("render the same bytes every time", () => {
    for (const p of paths) expect(encodePng(render(p)).equals(encodePng(render(p))), p).toBe(true);
  });

  it("have sizes in multiples of 32, only fully opaque or transparent pixels, and draw something", () => {
    for (const p of paths) {
      const img = render(p);
      expect(img.width % 32, p).toBe(0);
      expect(img.height % 32, p).toBe(0);
      let opaque = 0;
      for (let i = 3; i < img.data.length; i += 4) {
        expect([0, 255], p).toContain(img.data[i]);
        if (img.data[i] === 255) opaque++;
      }
      expect(opaque, p).toBeGreaterThan(20);
    }
  });

  it("ground and walls are opaque and tile seamlessly", () => {
    for (const p of paths) {
      const kind = RECIPES[p]?.kind;
      if (kind !== "ground" && kind !== "wall") continue;
      const img = render(p);
      expect(img.width, p).toBe(32);
      expect(img.height, p).toBe(32);
      for (let i = 3; i < img.data.length; i += 4) expect(img.data[i], p).toBe(255);
      // The jump across the wrap (last column -> first) must look like a jump that already
      // happens inside the tile (plank edges are fine, a visible tile border is not).
      const colStep = (j: number, k: number): number =>
        Math.abs(lum(img, j, k) - lum(img, (j + 1) % 32, k));
      const rowStep = (j: number, k: number): number =>
        Math.abs(lum(img, k, j) - lum(img, k, (j + 1) % 32));
      for (const [name, at] of [
        ["horizontal", colStep],
        ["vertical", rowStep],
      ] as const) {
        const boundary = (j: number): number => {
          let s = 0;
          for (let k = 0; k < 32; k++) s += at(j, k);
          return s / 32;
        };
        let worstInside = 0;
        for (let j = 0; j < 31; j++) worstInside = Math.max(worstInside, boundary(j));
        expect(boundary(31), `${p} ${name} seam`).toBeLessThanOrEqual(worstInside * 1.1 + 2);
      }
    }
  });

  it("the committed PNGs equal the generator output (run make spritegen)", () => {
    for (const p of paths) {
      const file = spriteFile(root, p);
      expect(existsSync(file), `${p}: missing, run make spritegen`).toBe(true);
      expect(
        readFileSync(file).equals(encodePng(render(p))),
        `${p}: stale, run make spritegen`,
      ).toBe(true);
    }
  });

  it("every recipe path is used by data/ or is an outfit frame", () => {
    expect(checkPaths(root)).toEqual([]);
    expect(OUTFIT_FRAME.test("outfits/citizen/s_0")).toBe(true);
    expect(OUTFIT_FRAME.test("outfits/citizen/south_0")).toBe(false);
    expect(OUTFIT_FRAME.test("outfits/citizen/up_0")).toBe(false);
    expect(EFFECT_FRAME.test("effects/hit/0")).toBe(true);
    expect(EFFECT_FRAME.test("effects/gather_miss/12")).toBe(true);
    expect(EFFECT_FRAME.test("effects/hit")).toBe(false);
    expect(EFFECT_FRAME.test("effects/hit/first")).toBe(false);
  });
});

describe("effect strips", () => {
  const strips = new Map<string, string[]>();
  for (const p of recipePaths("effects/")) {
    const name = EFFECT_FRAME.exec(p)?.[1] ?? p;
    strips.set(name, [...(strips.get(name) ?? []), p]);
  }

  it("are effect recipes of EFFECT_FRAMES frames, numbered from 0", () => {
    expect(strips.size).toBeGreaterThan(0);
    for (const [name, paths] of strips) {
      expect(paths, name).toEqual(
        Array.from({ length: EFFECT_FRAMES }, (_, f) => `effects/${name}/${f}`),
      );
      for (const p of paths) expect(RECIPES[p]?.kind, p).toBe("effect");
    }
  });

  it("animate: no two consecutive frames are the same picture", () => {
    for (const paths of strips.values()) {
      for (let f = 1; f < paths.length; f++) {
        const a = encodePng(render(paths[f - 1] ?? ""));
        const b = encodePng(render(paths[f] ?? ""));
        expect(a.equals(b), paths[f]).toBe(false);
      }
    }
  });

  it("preview a strip per row", () => {
    const hit = strips.get("hit") ?? [];
    const heal = strips.get("heal") ?? [];
    const one = previewSheet(root, hit);
    expect(previewSheet(root, [...hit, ...heal]).height).toBe(one.height * 2);
    // Without strips the cells still pack row after row.
    const items = recipePaths()
      .filter((p) => RECIPES[p]?.kind === "item")
      .slice(0, 2);
    expect(items).toHaveLength(2);
    expect(previewSheet(root, items).height).toBe(one.height);
  });
});
