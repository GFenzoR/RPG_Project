import { describe, expect, it } from "vitest";
import type { RecipeDef } from "../content-types.ts";
import { nearStation, stationRecipes, successChance } from "./recipes.ts";
import type { StationState } from "./recipes.ts";

const recipe = (over: Partial<RecipeDef>): RecipeDef => ({
  id: "ingot",
  craft: "smithing",
  station: 94,
  tool: "",
  level: 1,
  timeMs: 3000,
  inputs: [{ itemId: 83, count: 2 }],
  output: { itemId: 99, count: 1 },
  baseSuccess: 0.6,
  successPerLevel: 0.05,
  maxSuccess: 0.9,
  ...over,
});

const station = (owned: [number, number][], tools: string[] = []): StationState => ({
  pos: { x: 10, y: 10, z: 7 },
  itemId: 94,
  owned: new Map(owned),
  tools: new Set(tools),
});

describe("successChance", () => {
  it("grows with the level up to the cap, and is 0 below the recipe level", () => {
    const r = recipe({ level: 3 });
    expect(successChance(r, 2)).toBe(0);
    expect(successChance(r, 3)).toBeCloseTo(0.6);
    expect(successChance(r, 5)).toBeCloseTo(0.7);
    expect(successChance(r, 50)).toBeCloseTo(0.9);
  });
});

describe("stationRecipes", () => {
  const recipes = [
    recipe({}),
    recipe({ id: "blade", tool: "smithing", level: 5, inputs: [{ itemId: 99, count: 3 }] }),
    recipe({ id: "fish", station: 96 }),
  ];
  it("lists only the station's recipes, with what is missing", () => {
    const v = stationRecipes(recipes, station([[83, 1]]), [
      { id: "smithing", level: 1, percent: 0 },
    ]);
    expect(v.map((r) => r.recipe.id)).toEqual(["ingot", "blade"]);
    expect(v[0]?.missing).toEqual([{ itemId: 83, count: 1 }]);
    expect(v[0]?.ready).toBe(false);
    expect(v[1]).toMatchObject({ hasLevel: false, hasTool: false, chance: 0 });
  });
  it("is ready with the inputs, level and tool", () => {
    const v = stationRecipes(
      recipes,
      station(
        [
          [83, 2],
          [99, 3],
        ],
        ["smithing"],
      ),
      [{ id: "smithing", level: 6, percent: 10 }],
    );
    expect(v.every((r) => r.ready)).toBe(true);
    expect(v[1]?.chance).toBeCloseTo(0.65);
  });
});

describe("nearStation", () => {
  it("is one tile in any direction on the same floor", () => {
    const s = station([]);
    expect(nearStation(s, { x: 11, y: 9, z: 7 })).toBe(true);
    expect(nearStation(s, { x: 12, y: 10, z: 7 })).toBe(false);
    expect(nearStation(s, { x: 10, y: 11, z: 8 })).toBe(false);
  });
});
