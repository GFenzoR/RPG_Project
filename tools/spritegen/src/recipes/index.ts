// Every recipe, by sprite path. A path may live in only one book.
import type { RecipeBook } from "../recipe.ts";
import { CREATURES } from "./creatures.ts";
import { EFFECTS } from "./effects.ts";
import { ITEMS } from "./items.ts";
import { PORTALS } from "./portals.ts";
import { TERRAIN } from "./terrain.ts";
import { UI } from "./ui.ts";

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

export const RECIPES: RecipeBook = merge(TERRAIN, PORTALS, ITEMS, CREATURES, EFFECTS, UI);
