// Every recipe, by sprite path. A path may live in only one book. The sprite engine's specs
// (engine/specs/) come in as one recipe per frame. The looks' previews are data (they read
// data/): RECIPES has the repo's, recipesAt(root) those of another root.
import { resolve } from "node:path";
import { engineRecipes } from "../engine/book.ts";
import { lookPreviews, REPO_ROOT } from "../engine/specs/humanoid/previews.ts";
import { ENGINE_SPECS } from "../engine/specs/index.ts";
import type { RecipeBook } from "../recipe.ts";
import { CREATURES } from "./creatures.ts";
import { EFFECTS, MISSILES } from "./effects.ts";
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

/** The recipes in code: the same whatever data/ says. */
const CODED: RecipeBook = merge(
  TERRAIN,
  GROUND,
  WALLS,
  TREES,
  PROPS,
  PORTALS,
  ITEMS,
  CREATURES,
  EFFECTS,
  MISSILES,
  UI,
  engineRecipes(ENGINE_SPECS),
);

export const RECIPES: RecipeBook = merge(CODED, lookPreviews());

const AT = new Map<string, RecipeBook>([[resolve(REPO_ROOT), RECIPES]]);

/** Every recipe with the previews of data/ under `root` (the CLI's --root). */
export function recipesAt(root: string): RecipeBook {
  const key = resolve(root);
  let book = AT.get(key);
  if (!book) {
    book = merge(CODED, lookPreviews(key));
    AT.set(key, book);
  }
  return book;
}
