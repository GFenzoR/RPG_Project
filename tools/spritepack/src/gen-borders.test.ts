import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { borderSprites, covered } from "./gen-borders.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

describe("gen-borders", () => {
  it("committed border sprites are what the generator produces", () => {
    const sprites = borderSprites(repo);
    expect(sprites.size).toBe(24);
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
});
