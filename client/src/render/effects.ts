// Tile effects (Effect.effect_id, docs/05 "Combate" and "Magia") and projectiles in flight
// (Projectile.projectile_id): which atlas art plays for each id, which frame shows at a
// given moment and which way an arrow points. Pure, so it is unit-tested; the Pixi side
// (pooling, positions, the procedural fallback) is render/effect-layer.ts.
//
// The frames are original art from tools/spritegen (recipes/effects.ts): the strip of an
// effect is <folder>/0, <folder>/1, ... in the atlas. They play once, evenly spread over
// EFFECT_MS, the time the world keeps an effect.
import {
  EFFECT_BLOCK,
  EFFECT_BUFF,
  EFFECT_REFINE,
  EFFECT_SHATTER,
  EFFECT_CONJURE,
  EFFECT_ELEMENT,
  EFFECT_GATHER,
  EFFECT_GATHER_MISS,
  EFFECT_HEAL,
  EFFECT_HIT,
  EFFECT_MS,
  ELEMENTS,
  PROJECTILE_ELEMENT,
} from "../state/world.ts";

/** Atlas folder of each effect id. The elements follow ELEMENTS: 10 physical … 16 death. */
const FOLDERS: ReadonlyMap<number, string> = new Map<number, string>([
  [EFFECT_HIT, "effects/hit"],
  [EFFECT_BLOCK, "effects/block"],
  [EFFECT_HEAL, "effects/heal"],
  [EFFECT_CONJURE, "effects/conjure"],
  [EFFECT_GATHER, "effects/gather"],
  [EFFECT_GATHER_MISS, "effects/gather_miss"],
  [EFFECT_BUFF, "effects/buff"],
  [EFFECT_REFINE, "effects/refine"],
  [EFFECT_SHATTER, "effects/shatter"],
  ...ELEMENTS.map((e, i): [number, string] => [EFFECT_ELEMENT + i, `effects/${e}`]),
]);

/** The atlas folder of an effect id's frames, or undefined for an id the client does not know. */
export const effectFolder = (id: number): string | undefined => FOLDERS.get(id);

/** Every effect id with a folder (tests, tooling). */
export const EFFECT_IDS: readonly number[] = [...FOLDERS.keys()];

/** The longest strip the client looks for. */
export const MAX_EFFECT_FRAMES = 16;

/**
 * The frame sprites of an effect id that the atlas has as real art: <folder>/0, /1, ... up
 * to the first one missing. Empty = no art (an unknown id, or an atlas without the strip):
 * the caller draws the procedural shape instead.
 */
export function effectFrames(id: number, hasArt: (sprite: string) => boolean): string[] {
  const folder = effectFolder(id);
  const out: string[] = [];
  if (folder === undefined) return out;
  for (let f = 0; f < MAX_EFFECT_FRAMES; f++) {
    const sprite = `${folder}/${f}`;
    if (!hasArt(sprite)) break;
    out.push(sprite);
  }
  return out;
}

/**
 * Index of the frame to show `elapsed` ms into an effect of `frames` frames that plays
 * once over `duration` ms: equal slices; the first frame before the start (clock skew) and
 * the last one from the end on.
 */
export function effectFrame(elapsed: number, frames: number, duration = EFFECT_MS): number {
  if (frames <= 1 || !(elapsed > 0) || !(duration > 0)) return 0;
  return Math.min(frames - 1, Math.floor((elapsed / duration) * frames));
}

// ---- missiles ------------------------------------------------------------------------------
//
// A Projectile flies PROJECTILE_MS from tile to tile. Its art (tools/spritegen,
// recipes/effects.ts "missiles") is 32x32 with the drawing round the sprite's centre:
// - physical (id PROJECTILE_ELEMENT): the arrow, drawn flying east (ARROW_STRAIGHT) and
//   south-east (ARROW_DIAGONAL) and turned or mirrored in whole quarter turns toward the
//   target, in 45 degree steps (arrowPose): every pixel lands on a pixel;
// - the other elements: an orb, missiles/<element>/0, /1, ... looped every ORB_FRAME_MS,
//   and missiles/<element>/trail, the motes it leaves behind.
// Every arrow, bolt, knife or bottle is the arrow until the protocol says which one it is
// (docs/14, "Pendientes conocidos").

export const ARROW_STRAIGHT = "missiles/arrow/e";
export const ARROW_DIAGONAL = "missiles/arrow/se";
/** ms each frame of an orb shows (3 frames: one loop and a bit over a 250 ms flight). */
export const ORB_FRAME_MS = 80;
/** The longest orb loop the client looks for. */
export const MAX_ORB_FRAMES = 8;

/** The art of a projectile id: names in the atlas, resolved once per id. */
export type MissileArt =
  | { kind: "arrow"; straight: string; diagonal: string }
  | { kind: "orb"; frames: string[]; trail: string | undefined };

/**
 * The art of projectile id `id` that the atlas has as real art, or undefined (an unknown
 * id, or no art): the caller draws today's procedural dot. An orb needs at least its frame
 * 0; its trail is optional. The arrow needs both of its drawings.
 */
export function missileArt(
  id: number,
  hasArt: (sprite: string) => boolean,
): MissileArt | undefined {
  const element = ELEMENTS[id - PROJECTILE_ELEMENT];
  if (element === undefined) return undefined;
  if (element === "physical")
    return hasArt(ARROW_STRAIGHT) && hasArt(ARROW_DIAGONAL)
      ? { kind: "arrow", straight: ARROW_STRAIGHT, diagonal: ARROW_DIAGONAL }
      : undefined;
  const frames: string[] = [];
  for (let f = 0; f < MAX_ORB_FRAMES; f++) {
    const sprite = `missiles/${element}/${f}`;
    if (!hasArt(sprite)) break;
    frames.push(sprite);
  }
  if (frames.length === 0) return undefined;
  const trail = `missiles/${element}/trail`;
  return { kind: "orb", frames, trail: hasArt(trail) ? trail : undefined };
}

/** The frame of an orb loop of `frames` frames, `elapsed` ms into its flight. */
export function orbFrame(elapsed: number, frames: number, ms = ORB_FRAME_MS): number {
  if (frames <= 1 || !(elapsed > 0) || !(ms > 0)) return 0;
  return Math.floor(elapsed / ms) % frames;
}

/**
 * The 45 degree step of the direction (dx, dy) on screen (y grows south), clockwise from
 * east: 0 east, 1 south-east, 2 south ... 7 north-east. No direction (0, 0) is east.
 */
export function octant(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const step = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return ((step % 8) + 8) % 8;
}

/**
 * How to draw the arrow toward one octant: which drawing, then a mirror (scaleX, scaleY:
 * 1 or -1) and a turn (radians, a multiple of a quarter turn, clockwise on screen) in
 * Pixi's order (the scale first). Chosen so the lit side of the shaft stays up or left.
 */
export interface ArrowPose {
  diagonal: boolean;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

const QUARTER = Math.PI / 2;
/** The pose per octant (made once: a frame allocates nothing). */
export const ARROW_POSES: readonly ArrowPose[] = Object.freeze(
  [
    { diagonal: false, rotation: 0, scaleX: 1, scaleY: 1 }, // east
    { diagonal: true, rotation: 0, scaleX: 1, scaleY: 1 }, // south-east
    { diagonal: false, rotation: QUARTER, scaleX: 1, scaleY: -1 }, // south
    { diagonal: true, rotation: 0, scaleX: -1, scaleY: 1 }, // south-west
    { diagonal: false, rotation: 0, scaleX: -1, scaleY: 1 }, // west
    { diagonal: true, rotation: QUARTER, scaleX: -1, scaleY: 1 }, // north-west
    { diagonal: false, rotation: -QUARTER, scaleX: 1, scaleY: 1 }, // north
    { diagonal: true, rotation: -QUARTER, scaleX: 1, scaleY: 1 }, // north-east
  ].map((p) => Object.freeze(p)),
);

/** The pose of an arrow flying from a tile toward another `dx`, `dy` tiles away. */
export const arrowPose = (dx: number, dy: number): ArrowPose =>
  ARROW_POSES[octant(dx, dy)] ?? (ARROW_POSES[0] as ArrowPose);
