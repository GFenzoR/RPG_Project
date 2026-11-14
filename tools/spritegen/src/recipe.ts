// What a recipe is: a function that draws one sprite path (assets/sprites/<path>.png).
import type { Image } from "@rpg/spritepack";
import type { Rng } from "./draw.ts";

/**
 * - ground: fully opaque, tiles seamlessly in a grid (the test checks it).
 * - wall: fully opaque block texture, also seamless (walls sit side by side).
 * - object: map decoration on a transparent background; may be taller/wider than a tile
 *   (the renderer anchors it at the bottom-right corner of its tile, extending up-left).
 * - item: 32x32 inventory/ground icon, centred, transparent background.
 * - creature: monster or NPC, 32x32 (or larger), standing on its tile.
 */
export type RecipeKind = "ground" | "wall" | "object" | "item" | "creature";

export interface Recipe {
  kind: RecipeKind;
  /** Pixels, a multiple of 32 (default 32). */
  width?: number;
  /** Pixels, a multiple of 32 (default 32). */
  height?: number;
  /**
   * Draws into img (already sized, transparent). rand and seed come from the sprite path,
   * so a recipe is reproducible and independent of the others.
   */
  draw(img: Image, rand: Rng, seed: number): void;
}

export type RecipeBook = Record<string, Recipe>;
