// Player outfit frames (T0.5): which atlas sprite a player is drawn with. Pure, no Pixi.
//
// An outfit of data/outfits.yaml is a sprite folder with one file per facing and frame:
// "<sprite>/<dir>_<frame>" (outfits/citizen/s_0), dir in n|e|s|w, frame 0 = standing and
// 1..frames-1 = the walking steps.
import type { Direction } from "@rpg/protocol";
import type { OutfitDef } from "../content-types.ts";
import { delta } from "../state/geometry.ts";
import type { Walk } from "../state/world.ts";

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

/**
 * How far through its step a creature is, 0..1, or undefined when it is not walking: also
 * before the step starts (a step drawn after the one before, or waiting on the playout).
 */
export function stepProgress(walk: Walk | undefined, now: number): number | undefined {
  if (!walk || walk.duration <= 0 || now < walk.start || now >= walk.start + walk.duration)
    return undefined;
  return (now - walk.start) / walk.duration;
}

/**
 * How many sprite pixels a creature drawn with a single picture (a monster, an NPC) is
 * lifted while walking: one in the middle half of each step, a small hop per tile, so it
 * does not glide like a chess piece. 0 when standing.
 */
export function walkBob(progress: number | undefined): number {
  return progress !== undefined && progress >= 0.25 && progress < 0.75 ? 1 : 0;
}

/**
 * The frame to draw: 0 when standing; while walking, the walking frames split the step in
 * equal parts (with 3 frames: 1 for the first half, 2 for the second), so steps in a row
 * alternate 1, 2, 1, 2.
 */
export function outfitFrame(progress: number | undefined, frames: number): number {
  const walking = Math.floor(frames) - 1;
  if (progress === undefined || walking < 1) return 0;
  return 1 + Math.min(walking - 1, Math.floor(Math.max(0, progress) * walking));
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
