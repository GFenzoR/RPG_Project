import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { borderSprites, covered } from "./gen-borders.ts";
import { decodePng } from "./image.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

describe("gen-borders", () => {
  it("committed border sprites are what the generator produces", () => {
    const sprites = borderSprites(repo);
    expect(sprites.size).toBe(84); // 7 rules x 12 pieces
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

  it("cuts pieces of a ground with own art (spritegen) from its PNG, not a grey fallback", () => {
    // ash (T5.5) has no entry in assets/sprites.yaml: its art is assets/sprites/ground/ash.png.
    const ash = decodePng(readFileSync(join(repo, "assets/sprites/ground/ash.png")));
    const piece = decodePng(borderSprites(repo).get("borders/ash_sand_n") as Buffer);
    // An inner pixel of the piece (not on its darker rim) is the ash pixel at the same spot.
    const i = (2 * 32 + 16) * 4;
    expect([...piece.data.subarray(i, i + 4)]).toEqual([...ash.data.subarray(i, i + 3), 255]);
  });
});
