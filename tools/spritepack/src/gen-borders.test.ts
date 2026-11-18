import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SURF_FRAMES, borderSprite, borderSprites, covered, wave } from "./gen-borders.ts";
import { decodePng } from "./image.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

describe("gen-borders", () => {
  it("committed border sprites are what the generator produces", () => {
    const sprites = borderSprites(repo);
    // 7 rules x 12 pieces, and 3 more surf frames of each shore piece (sand_water).
    expect(sprites.size).toBe(84 + 12 * (SURF_FRAMES - 1));
    for (const [sprite, png] of sprites)
      expect([
        sprite,
        readFileSync(join(repo, "assets/sprites", `${sprite}.png`)).equals(png),
      ]).toEqual([sprite, true]);
  });

  it("shapes pieces by where the bordering ground is", () => {
    expect(covered("n", 16, 0)).toBe(true);
    expect(covered("n", 16, 31)).toBe(false);
    expect(covered("se", 31, 31)).toBe(true);
    expect(covered("se", 0, 0)).toBe(false);
    expect(covered("inner_nw", 0, 16)).toBe(true);
    expect(covered("inner_nw", 16, 0)).toBe(true);
    expect(covered("inner_nw", 31, 31)).toBe(false);
  });

  it("carries the edge on into the next tile, never straight and never jumping", () => {
    for (let t = 0; t < 32; t++) expect(Math.abs(wave(t + 1) - wave(t))).toBeLessThanOrEqual(1);
    expect(wave(32)).toBe(wave(0));
    const depths = new Set(Array.from({ length: 32 }, (_, t) => wave(t)));
    expect(depths.size).toBeGreaterThanOrEqual(3); // never straight (docs/17 ART-4)
  });

  it("rolls the surf in over its frames on the water side only (docs/17 ART-7)", () => {
    const sand = (): [number, number, number, number] => [180, 150, 100, 255];
    const frames = Array.from({ length: SURF_FRAMES }, (_, f) => borderSprite("n", sand, true, f));
    const key = (f: number): string => Buffer.from(frames[f]?.data ?? []).toString("hex");
    // Every frame is different, and the ground side never moves.
    expect(new Set(frames.map((_, f) => key(f))).size).toBe(SURF_FRAMES);
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        if (!covered("n", x, y)) continue;
        const i = (y * 32 + x) * 4;
        for (const img of frames)
          expect([...img.data.subarray(i, i + 4)]).toEqual([
            ...(frames[0]?.data.subarray(i, i + 4) ?? []),
          ]);
      }
    // Without water there is no surf: a frame is the still piece.
    expect(borderSprite("n", sand, false, 2).data).toEqual(borderSprite("n", sand).data);
    // The files: frame_1..frame_<n-1> next to every shore piece, none for other borders.
    const sprites = borderSprites(repo);
    expect(sprites.has(`borders/sand_water_n/frame_${SURF_FRAMES - 1}`)).toBe(true);
    expect(sprites.has("borders/grass_sand_n/frame_1")).toBe(false);
  });

  it("cuts pieces of a ground with own art (spritegen) from its PNG, not a grey fallback", () => {
    // ash (T5.5) has no entry in assets/sprites.yaml: its art is assets/sprites/ground/ash.png.
    const ash = decodePng(readFileSync(join(repo, "assets/sprites/ground/ash.png")));
    const piece = decodePng(borderSprites(repo).get("borders/ash_sand_n") as Buffer);
    // An inner pixel of the piece (not on its darker rim) is the ash pixel at the same spot.
    const i = (2 * 32 + 16) * 4;
    expect([...piece.data.subarray(i, i + 4)]).toEqual([...ash.data.subarray(i, i + 3), 255]);
  });
});
