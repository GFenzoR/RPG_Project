// Engine specs as spritegen recipes: one recipe per frame path, so `make spritegen`,
// `ONLY=<prefix>`, the committed-PNG test and `spritegen check` treat them like any recipe.
// A creature's frames are <sprite>/<action>_<dir>_<n> (ANI-4) for every action and facing of
// its rig; an object is one image at its path, or with a loop (ART-7) the sprite as frame 0
// and <sprite>/frame_<n> after it. Renders are cached: a frame is drawn once.
import type { Image } from "@rpg/spritepack";
import type { Recipe, RecipeBook } from "../recipe.ts";
import { canvasOf, renderSpec } from "./render.ts";
import type { FrameRef, LoopRef } from "./render.ts";
import type { SpriteSpec } from "./spec.ts";
import { DIRS, frameName } from "./style.ts";
import type { ActionName } from "./style.ts";

/** The order frames come in (and the contact sheet's rows). */
export const ACTION_ORDER: readonly ActionName[] = [
  "idle",
  "walk",
  "attack",
  "shoot",
  "cast",
  "death",
];

/** One frame of a spec: its path and what to render for it (an action's, a loop's or none). */
export interface FramePath {
  path: string;
  ref?: FrameRef;
  /** The frame of an animated prop's loop (0 is the sprite itself). */
  loop?: number;
}

/** The name of frame n of an animated prop (ART-7): the sprite, then <sprite>/frame_<n>. */
export function loopFrameName(sprite: string, n: number): string {
  return n === 0 ? sprite : `${sprite}/frame_${n}`;
}

/** Every frame path of a spec, with what to render for it. */
export function framePaths(spec: SpriteSpec): FramePath[] {
  const loop = spec.loop;
  if (!spec.actions && loop)
    return Array.from({ length: loop.frames }, (_, n) => ({
      path: loopFrameName(spec.sprite, n),
      loop: n,
    }));
  if (!spec.actions) return [{ path: spec.sprite }];
  const out: { path: string; ref: FrameRef }[] = [];
  for (const action of ACTION_ORDER) {
    const a = spec.actions[action];
    if (!a) continue;
    for (const dir of a.dirs ?? DIRS)
      for (let frame = 0; frame < a.frames; frame++)
        out.push({ path: frameName(spec.sprite, action, dir, frame), ref: { action, dir, frame } });
  }
  return out;
}

const cache = new WeakMap<SpriteSpec, Map<string, Image>>();

/** One frame of a spec, rendered once per spec object. */
export function frameImage(spec: SpriteSpec, path: string, ref?: FrameRef | LoopRef): Image {
  let memo = cache.get(spec);
  if (!memo) {
    memo = new Map();
    cache.set(spec, memo);
  }
  let image = memo.get(path);
  if (!image) {
    image = renderSpec(spec, ref);
    memo.set(path, image);
  }
  return image;
}

/** What to render for a frame path. */
const refOf = ({ ref, loop }: FramePath): FrameRef | LoopRef | undefined =>
  ref ?? (loop !== undefined ? { loop } : undefined);

/** Every frame of a spec, rendered. */
export function engineFrames(spec: SpriteSpec): (FramePath & { image: Image })[] {
  return framePaths(spec).map((f) => ({ ...f, image: frameImage(spec, f.path, refOf(f)) }));
}

/** The recipes of a set of specs, by frame path. */
export function engineRecipes(specs: readonly SpriteSpec[]): RecipeBook {
  const book: RecipeBook = {};
  for (const spec of specs) {
    const { w, h, size } = canvasOf(spec);
    for (const f of framePaths(spec)) {
      const { path } = f;
      const ref = refOf(f);
      const recipe: Recipe = {
        kind: size.kind,
        width: w,
        height: h,
        // Engine creatures stand on the renderer's contact shadow (shadow: ellipse).
        ...(size.kind === "creature" ? { shadow: false as const } : {}),
        draw: (img) => img.data.set(frameImage(spec, path, ref).data),
      };
      book[path] = recipe;
    }
  }
  return book;
}
