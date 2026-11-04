// Crafting window (T3.4): what each recipe of a station needs and what the player lacks,
// from the StationOpen the server sent (what it carries) and the skills. Pure: the server
// checks everything again when Craft arrives.
import type { RecipeDef } from "../content-types.ts";
import type { SkillState } from "./world.ts";

/** An open station: where it is, which item it is, and what the player carries for it. */
export interface StationState {
  pos: { x: number; y: number; z: number };
  itemId: number;
  /** Units carried (in containers) of each input of the station's recipes, by item id. */
  owned: Map<number, number>;
  /** tool.use of every tool carried. */
  tools: Set<string>;
}

export interface RecipeView {
  recipe: RecipeDef;
  /** Skill level of the recipe's craft. */
  level: number;
  /** Success chance 0..1 at that level (0 below the recipe's level). */
  chance: number;
  /** Inputs the player is short of: item id and how many units are missing. */
  missing: { itemId: number; count: number }[];
  hasLevel: boolean;
  hasTool: boolean;
  /** Everything the client can see is there (the server may still refuse: room, time). */
  ready: boolean;
}

/** The recipe's success chance at skill level (same formula as the server). */
export function successChance(r: RecipeDef, level: number): number {
  if (level < r.level) return 0;
  const c = r.baseSuccess + r.successPerLevel * (level - r.level);
  return Math.max(0, Math.min(c, r.maxSuccess));
}

/** The recipes of station's item, in file order, with what each lacks. */
export function stationRecipes(
  recipes: readonly RecipeDef[],
  station: StationState,
  skills: readonly SkillState[],
): RecipeView[] {
  return recipes
    .filter((r) => r.station === station.itemId)
    .map((recipe) => {
      const level = skills.find((s) => s.id === recipe.craft)?.level ?? 0;
      const missing = recipe.inputs.flatMap((i) => {
        const short = i.count - (station.owned.get(i.itemId) ?? 0);
        return short > 0 ? [{ itemId: i.itemId, count: short }] : [];
      });
      const hasLevel = level >= recipe.level;
      const hasTool = recipe.tool === "" || station.tools.has(recipe.tool);
      return {
        recipe,
        level,
        chance: successChance(recipe, level),
        missing,
        hasLevel,
        hasTool,
        ready: hasLevel && hasTool && missing.length === 0,
      };
    });
}

/** Whether pos is close enough to use the station (Chebyshev 1, same floor). */
export function nearStation(
  station: StationState,
  pos: { x: number; y: number; z: number },
): boolean {
  return (
    pos.z === station.pos.z &&
    Math.max(Math.abs(pos.x - station.pos.x), Math.abs(pos.y - station.pos.y)) <= 1
  );
}
