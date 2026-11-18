// Player outfit frames (T0.5): which atlas sprite a player is drawn with. Pure, no Pixi.
//
// An outfit of data/outfits.yaml is a sprite folder with one file per facing and frame:
// "<sprite>/<dir>_<frame>" (outfits/citizen/s_0), dir in n|e|s|w, frame 0 = standing and
// 1..frames-1 = the walking steps. An outfit animated in atlas.json (docs/17 ANI-6) has its
// own clips instead, and those names are aliases of its frames (tools/spritepack): either
// way render/clips.ts builds what the canvas plays.
import type { Direction } from "@rpg/protocol";
import type { OutfitDef } from "../content-types.ts";
import { delta } from "../state/geometry.ts";

export type OutfitDir = "n" | "e" | "s" | "w";
export const OUTFIT_DIRS: readonly OutfitDir[] = ["n", "e", "s", "w"];

/** The outfit every player wears until Outfit.look_id picks one. */
export const DEFAULT_OUTFIT = "citizen";

/**
 * The facing an outfit has for a creature direction: diagonals use their horizontal half
 * (north-east looks east), as in classic top-down MMORPGs; an unknown direction looks south.
 */
export function outfitDir(d: Direction): OutfitDir {
  const [dx, dy] = delta(d);
  if (dx > 0) return "e";
  if (dx < 0) return "w";
  return dy < 0 ? "n" : "s";
}

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
