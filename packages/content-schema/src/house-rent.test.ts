// Content audit M6: the weekly rent of a player house grows with its size and its town.
// rent = house tiles (the sum of its rects, doors included) × the copper per tile of its
// island, so a bigger house or one in a later town costs more (docs/02-game-design.md,
// "Casas"). It reads the real world/ files: a house added or resized with another rent
// fails here. Dev-only islands (world.yaml `dev_only`) keep their own test rents.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** Copper per house tile and rent period (7 days), by island. */
const RATE_PER_TILE: Record<string, number> = { puerto: 60, bosque: 90, volcan: 120 };

interface Rect {
  w: number;
  h: number;
}

interface House {
  id: string;
  rent: number;
  rects: Rect[];
}

interface IslandEntry {
  id: string;
  dev_only?: boolean;
}

const world = parse(readFileSync(join(REPO, "world/world.yaml"), "utf8")) as {
  islands: IslandEntry[];
};
const production = world.islands.filter((i) => i.dev_only !== true).map((i) => i.id);

function housesOf(island: string): House[] {
  const file = join(REPO, "world/islands", island, "houses.yaml");
  if (!existsSync(file)) return [];
  return (parse(readFileSync(file, "utf8")) as House[] | null) ?? [];
}

/** The validator forbids overlapping rects, so the sum is the house's tile count. */
const tiles = (h: House): number => h.rects.reduce((n, r) => n + r.w * r.h, 0);

describe("house rents (content audit M6)", () => {
  it("covers the production houses", () => {
    expect(production.flatMap(housesOf).length).toBeGreaterThan(0);
  });

  it.each(production)("%s: each house costs its tiles times the island's rate", (island) => {
    const houses = housesOf(island);
    if (houses.length === 0) return;
    const rate = RATE_PER_TILE[island];
    expect(rate, `island ${island} has houses but no rent per tile`).toBeDefined();
    for (const h of houses) {
      expect(h.rent, `${h.id}: ${tiles(h)} tiles × ${rate}`).toBe(tiles(h) * (rate ?? 0));
    }
  });

  it("names only production islands in the rate table", () => {
    for (const island of Object.keys(RATE_PER_TILE)) expect(production).toContain(island);
  });
});
