// What a recipe is: a function that draws one sprite path (assets/sprites/<path>.png).
import type { Image } from "@rpg/spritepack";
import type { Rng } from "./draw.ts";

/**
 * - ground: fully opaque, tiles seamlessly in a grid (the test checks it).
 * - wall: fully opaque block texture, also seamless (walls sit side by side).
 * - object: map decoration on a transparent background; may be taller/wider than a tile
 *   (the renderer anchors it at the bottom-right corner of its tile, extending up-left).
 * - item: 32x32 inventory/ground icon, centred, transparent background.
 * - creature: monster, NPC or outfit frame, 32x32 (or larger), standing on its tile. It
 *   gets the cast shadow of the Dungeon Crawl monsters (castShadow, see `shadow`), unless
 *   it stands on the renderer's contact ellipse like the animated monsters (`shadow: false`).
 * - effect: one frame of a tile effect (effects/<name>/<frame>), transparent, drawn over
 *   the creatures of its tile; the client plays the frames in order (recipes/effects.ts).
 * - ui: a client interface icon (ui/<group>/<id>, such as the PvP marks): 32x32 with the
 *   drawing inside UI_ICON_BOX, which is all the client shows of it.
 */
export type RecipeKind = "ground" | "wall" | "object" | "item" | "creature" | "effect" | "ui";

/** castShadow() options of a creature (draw.ts). */
export interface ShadowOptions {
  /** Reach toward the bottom-right, px (default SHADOW_DX, SHADOW_DY: 3, 1). */
  dx?: number;
  dy?: number;
  /** Where it starts, a fraction of the figure's height from its top (SHADOW_FROM: 0.4). */
  from?: number;
}

export interface Recipe {
  kind: RecipeKind;
  /** Pixels, a multiple of 32 (default 32). */
  width?: number;
  /** Pixels, a multiple of 32 (default 32). */
  height?: number;
  /**
   * Creatures only: the cast shadow's options (default ones when absent), or false for none:
   * a sprite whose assets/sprites.yaml entry says `shadow: ellipse` gets the renderer's
   * contact shadow instead, and a painted one would make two.
   */
  shadow?: ShadowOptions | false;
  /**
   * Draws into img (already sized, transparent). rand and seed come from the sprite path,
   * so a recipe is reproducible and independent of the others.
   */
  draw(img: Image, rand: Rng, seed: number): void;
}

export type RecipeBook = Record<string, Recipe>;

/**
 * The part of a 32x32 `ui` sprite the client shows (x, y, width, height). The client keeps
 * the same numbers (client/src/render/marks.ts MARK_BOX); a test checks both.
 */
export const UI_ICON_BOX = { x: 10, y: 10, w: 12, h: 12 } as const;
