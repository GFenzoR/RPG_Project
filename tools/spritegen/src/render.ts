// Drawing one recipe into an image: what `make spritegen` writes as its PNG. On its own so
// a recipe made from another's art (recipes/corpses.ts) draws its source the same way.
import { createImage } from "@rpg/spritepack";
import type { Image } from "@rpg/spritepack";
import { castShadow, rng, seedOf } from "./draw.ts";
import type { Recipe } from "./recipe.ts";

export const TILE = 32;

/** Draws `recipe` into a fresh image of its size (a creature with its cast shadow). */
export function renderRecipe(path: string, recipe: Recipe): Image {
  const img = createImage(recipe.width ?? TILE, recipe.height ?? TILE);
  const seed = seedOf(path);
  recipe.draw(img, rng(seed), seed);
  // A creature of ours casts the shadow the Dungeon Crawl monsters have, so both sit on
  // the map the same way (assets/README.md, "Sombra de las criaturas"), unless it stands
  // on the renderer's contact ellipse like the animated monsters (shadow: false).
  if (recipe.kind === "creature" && recipe.shadow !== false) castShadow(img, recipe.shadow);
  return img;
}
