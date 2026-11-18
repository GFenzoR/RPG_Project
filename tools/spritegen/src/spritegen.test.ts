import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import {
  canvas,
  castShadow,
  get,
  opaque,
  outline,
  polygon,
  px,
  rect,
  rng,
  seedOf,
  SHADOW,
  tileNoise,
} from "./draw.ts";
import {
  checkPaths,
  EFFECT_FRAME,
  OUTFIT_FRAME,
  previewSheet,
  RECIPES,
  recipePaths,
  render,
  spriteFile,
  UI_ICON,
  UI_ICON_BOX,
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
      // One expect per image, not per pixel: with the wall pieces, looks and frames of the
      // world art there are hundreds of recipes, and a per-pixel expect timed out on CI.
      let opaque = 0;
      let partial = -1;
      for (let i = 3; i < img.data.length; i += 4) {
        const a = img.data[i] ?? 0;
        if (a === 255) opaque++;
        else if (a !== 0 && partial < 0) partial = a;
      }
      expect(partial, `${p}: alpha that is neither 0 nor 255`).toBe(-1);
      expect(opaque, p).toBeGreaterThan(20);
    }
  }, 30_000);

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

  it("grounds stay in the value band of docs/17 ART-6 (mean L* 20-50), but lava, which glows", () => {
    const linear = (c: number): number => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    for (const p of paths) {
      if (RECIPES[p]?.kind !== "ground" || /^ground\/lava(\/|$)/.test(p)) continue;
      const img = render(p);
      let sum = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const y =
          0.2126 * linear(img.data[i] ?? 0) +
          0.7152 * linear(img.data[i + 1] ?? 0) +
          0.0722 * linear(img.data[i + 2] ?? 0);
        sum += y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
      }
      const mean = sum / (img.data.length / 4);
      expect(mean, p).toBeGreaterThanOrEqual(20);
      expect(mean, p).toBeLessThanOrEqual(50);
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

  it("every recipe path is used by data/ or is an outfit or effect frame or a ui icon", () => {
    expect(checkPaths(root)).toEqual([]);
    expect(OUTFIT_FRAME.test("outfits/citizen/s_0")).toBe(true);
    expect(OUTFIT_FRAME.test("outfits/citizen/south_0")).toBe(false);
    expect(OUTFIT_FRAME.test("outfits/citizen/up_0")).toBe(false);
    expect(EFFECT_FRAME.test("effects/hit/0")).toBe(true);
    expect(EFFECT_FRAME.test("effects/gather_miss/12")).toBe(true);
    expect(EFFECT_FRAME.test("effects/hit")).toBe(false);
    expect(EFFECT_FRAME.test("effects/hit/first")).toBe(false);
    expect(UI_ICON.test("ui/marks/aggressor")).toBe(true);
    expect(UI_ICON.test("ui/aggressor")).toBe(false);
    expect(UI_ICON.test("items/ui/marks/aggressor")).toBe(false);
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

/** Same colour (alpha ignored: everything is opaque). */
const same = (a: readonly number[] | undefined, b: readonly number[]): boolean =>
  a !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

describe("cast shadow", () => {
  it("falls to the bottom-right from part-way down, only behind the figure", () => {
    const img = canvas(16, 16);
    rect(img, 4, 2, 4, 10, PALETTE.stone.base); // a pillar, rows 2..11
    castShadow(img, { dx: 3, dy: 1, from: 0.5 });
    // The pillar keeps its colour; the shadow starts half-way down it (row 7).
    expect(same(get(img, 5, 5), PALETTE.stone.base)).toBe(true);
    expect(same(get(img, 8, 9), SHADOW)).toBe(true);
    expect(same(get(img, 10, 12), SHADOW)).toBe(true); // reaches dx right and dy down
    expect(opaque(img, 8, 3)).toBe(false); // the top of the pillar casts none
    expect(opaque(img, 11, 9)).toBe(false); // no further than dx
    expect(opaque(img, 3, 9)).toBe(false); // nothing to the left
  });

  it("always touches what casts it: a thin part leaves no loose piece of shadow", () => {
    const img = canvas(16, 16);
    rect(img, 4, 0, 2, 12, PALETTE.stone.base); // body
    rect(img, 7, 4, 1, 3, PALETTE.stone.base); // a 1 px strap, 1 px off the body
    castShadow(img, { dx: 3, dy: 1, from: 0 });
    for (let y = 5; y <= 7; y++)
      for (let x = 8; x <= 10; x++) expect(opaque(img, x, y), `${x},${y}`).toBe(true);
  });

  it("is on every creature and on nothing else", () => {
    for (const p of recipePaths()) {
      const img = render(p);
      let shadow = 0;
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) if (same(get(img, x, y), SHADOW)) shadow++;
      if (RECIPES[p]?.kind === "creature") expect(shadow, p).toBeGreaterThan(10);
      else expect(shadow, p).toBeLessThan(10);
    }
  });
});

describe("ui icons", () => {
  const icons = recipePaths("ui/");

  it("draw only inside UI_ICON_BOX, which is all the client shows", () => {
    expect(icons.length).toBeGreaterThan(0);
    for (const p of icons) {
      const img = render(p);
      expect([img.width, img.height], p).toEqual([32, 32]);
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          const inBox =
            x >= UI_ICON_BOX.x &&
            x < UI_ICON_BOX.x + UI_ICON_BOX.w &&
            y >= UI_ICON_BOX.y &&
            y < UI_ICON_BOX.y + UI_ICON_BOX.h;
          if (!inBox) expect(opaque(img, x, y), `${p} ${x},${y}`).toBe(false);
        }
    }
  });

  it("give each PvP mark its own silhouette, so they read without colour", () => {
    const marks = ["aggressor", "murderer", "outlaw"].map((id) => `ui/marks/${id}`);
    for (const m of marks) expect(icons, m).toContain(m);
    const masks = marks.map((m) => {
      const img = render(m);
      let bits = "";
      for (let i = 3; i < img.data.length; i += 4) bits += img.data[i] ? "1" : "0";
      return bits;
    });
    expect(new Set(masks).size).toBe(marks.length);
  });
});
