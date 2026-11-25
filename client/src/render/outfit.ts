// Player outfit frames (T0.5): which atlas sprite a player is drawn with. Pure, no Pixi.
//
// An outfit of data/outfits.yaml is a sprite folder with one file per facing and frame:
// "<sprite>/<dir>_<frame>" (outfits/citizen/s_0), dir in n|e|s|w, frame 0 = standing and
// 1..frames-1 = the walking steps. An outfit animated in atlas.json (docs/17 ANI-6) has its
// own clips instead, and those names are aliases of its frames (tools/spritepack): either
// way render/clips.ts builds what the canvas plays. Which facing a creature is drawn in
// (four ways, or eight for the engine humanoids) is packages/renderer anim.ts turnTo.
import type { OutfitDef } from "../content-types.ts";

export type OutfitDir = "n" | "e" | "s" | "w";
export const OUTFIT_DIRS: readonly OutfitDir[] = ["n", "e", "s", "w"];

/** The outfit every player wears until Outfit.look_id picks one. */
export const DEFAULT_OUTFIT = "citizen";

/** Atlas key of one frame ("outfits/citizen/s_0"). */
export const outfitKey = (sprite: string, dir: OutfitDir, frame: number): string =>
  `${sprite}/${dir}_${frame}`;

/** Every atlas key an outfit needs, in dir then frame order. */
export const outfitKeys = (o: OutfitDef): string[] =>
  OUTFIT_DIRS.flatMap((dir) =>
    Array.from({ length: Math.max(1, Math.floor(o.frames)) }, (_, f) =>
      outfitKey(o.sprite, dir, f),
    ),
  );
