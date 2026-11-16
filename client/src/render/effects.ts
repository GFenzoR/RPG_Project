// Tile effects (Effect.effect_id, docs/05 "Combate" and "Magia"): which atlas frames play
// for each id and which frame shows at a given moment. Pure, so it is unit-tested; the
// Pixi side (pooling, positions, the procedural fallback) is render/effect-layer.ts.
//
// The frames are original art from tools/spritegen (recipes/effects.ts): the strip of an
// effect is <folder>/0, <folder>/1, ... in the atlas. They play once, evenly spread over
// EFFECT_MS, the time the world keeps an effect.
import {
  EFFECT_BLOCK,
  EFFECT_BUFF,
  EFFECT_CONJURE,
  EFFECT_ELEMENT,
  EFFECT_GATHER,
  EFFECT_GATHER_MISS,
  EFFECT_HEAL,
  EFFECT_HIT,
  EFFECT_MS,
  ELEMENTS,
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
