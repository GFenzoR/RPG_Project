// Every recipe, by sprite path. A path may live in only one book. The sprite engine's specs
// (engine/specs/) come in as one recipe per frame.
import { engineRecipes } from "../engine/book.ts";
import { ENGINE_SPECS } from "../engine/specs/index.ts";
import type { RecipeBook } from "../recipe.ts";
import { CREATURES } from "./creatures.ts";
import { EFFECTS } from "./effects.ts";
import { GROUND } from "./ground.ts";
import { ITEMS } from "./items.ts";
import { PORTALS } from "./portals.ts";
import { PROPS } from "./props.ts";
import { TERRAIN } from "./terrain.ts";
import { TREES } from "./trees.ts";
import { UI } from "./ui.ts";
import { WALLS } from "./walls.ts";

function merge(...books: RecipeBook[]): RecipeBook {
  const out: RecipeBook = {};
  for (const book of books) {
    for (const [path, recipe] of Object.entries(book)) {
      if (path in out) throw new Error(`spritegen: recipe ${path} is defined twice`);
      out[path] = recipe;
    }
  }
  return out;
}

export const RECIPES: RecipeBook = merge(
  TERRAIN,
  GROUND,
  WALLS,
  TREES,
  PROPS,
  PORTALS,
  ITEMS,
  CREATURES,
  EFFECTS,
  UI,
  engineRecipes(ENGINE_SPECS),
);
