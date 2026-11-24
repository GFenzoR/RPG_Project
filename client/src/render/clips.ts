// The frames a creature is drawn with (docs/17 ANI-4): for an animated sprite (atlas.json
// `anims`), its textures by action, facing and frame; for a T0.5 outfit drawn by
// spritegen, its <dir>_<n> frames read as idle (0) and walk (1..); for anything else, its
// one texture, which packages/renderer anim.ts moves procedurally. Built once per sprite
// and cached by the canvas: drawing a frame only indexes arrays. Pure apart from the
// texture lookup (tests pass strings).
import { ANIM_DIRS, DIAGONAL_DIRS, OWN_FACINGS, STRAIGHT_DIRS } from "@rpg/renderer";
import type { AnimAction, AnimMeta } from "@rpg/renderer";

export interface ClipSet<T> {
  /** Clip lengths and drawing hints, with only the actions that have every texture. */
  meta: AnimMeta | undefined;
  /**
   * Textures by action, then facing (ANIM_DIRS order: the four straight ones, and the
   * diagonals when `eight`), then frame.
   */
  frames: Partial<Record<AnimAction, T[][]>>;
  /**
   * Drawn in eight facings (docs/17 ANI-1): every action with frames in more than one
   * facing has them in all eight (the engine humanoids). Otherwise only the four straight
   * ones are here, and the creature turns with turnTo's four-facing rule.
   */
  eight: boolean;
  /** The texture of a sprite without clips (or the base frame of one with them). */
  still: T | undefined;
}

const ACTIONS: readonly AnimAction[] = ["idle", "walk", "attack", "shoot", "cast", "death"];

/** Index of a facing in ANIM_DIRS (the second level of ClipSet.frames). */
export { dirIndex } from "@rpg/renderer";

/**
 * Whether an atlas animation is drawn in eight facings: some action has the diagonals, and
 * every action drawn in more than one facing has all eight (death, facing south only, does
 * not count).
 */
export function hasEightFacings(meta: AnimMeta): boolean {
  const many = Object.values(meta.actions).filter((a) => a && a.dirs.length > 1);
  return (
    many.length > 0 &&
    many.every((a) => a !== undefined && ANIM_DIRS.every((d) => a.dirs.includes(d)))
  );
}

/**
 * The clips of a sprite path: its frames when atlas.json describes an animation with
 * them, else its single texture (with the hints `anims` gives it). Undefined when the atlas
 * has neither.
 */
export function spriteClips<T>(
  path: string,
  anims: Record<string, AnimMeta> | undefined,
  lookup: (key: string) => T | undefined,
): ClipSet<T> | undefined {
  const meta = anims?.[path];
  const still = lookup(path);
  if (!meta)
    return still === undefined ? undefined : { meta: undefined, frames: {}, still, eight: false };
  let eight = hasEightFacings(meta);
  const frames: Partial<Record<AnimAction, T[][]>> = {};
  const actions: AnimMeta["actions"] = {};
  const dirs = eight ? ANIM_DIRS : STRAIGHT_DIRS;
  for (const action of ACTIONS) {
    const a = meta.actions[action];
    if (!a || a.frames < 1 || a.dirs.length === 0) continue;
    const byDir: T[][] = [];
    for (const dir of dirs) {
      // Idle and the attacks only face their own ways: another facing gets no frames here,
      // and clipTexture draws its standing frame (OWN_FACINGS, packages/renderer anim.ts).
      if (OWN_FACINGS.has(action) && !a.dirs.includes(dir)) {
        byDir.push([]);
        continue;
      }
      const d = a.dirs.includes(dir) ? dir : a.dirs.includes("s") ? "s" : (a.dirs[0] ?? "s");
      const list: T[] = [];
      for (let n = 0; n < a.frames; n++) {
        const tex = lookup(`${path}/${action}_${d}_${n}`);
        if (tex !== undefined) list.push(tex);
      }
      if (list.length === a.frames) byDir.push(list);
    }
    if (byDir.length === dirs.length) {
      frames[action] = byDir;
      actions[action] = a;
    } else if (DIAGONAL_DIRS.some((d) => a.dirs.includes(d))) eight = false;
  }
  // A missing diagonal frame drops the action; without it the rest still has eight facings
  // only if no other action relied on them (a clip is never half eight, half four).
  if (!eight) for (const list of Object.values(frames)) list.length = Math.min(list.length, 4);
  const first = frames.idle?.[2]?.[0] ?? frames.walk?.[2]?.[0];
  if (still === undefined && first === undefined) return undefined;
  return { meta: { ...meta, actions }, frames, still: still ?? first, eight };
}

/**
 * A T0.5 outfit drawn as <sprite>/<dir>_<n> frames (n = 0 standing, 1.. walking): idle is
 * frame 0 and the walk plays every other frame within each tile, as before (with 3 frames:
 * 1 for the first half of a step, 2 for the second). Undefined if a frame is missing.
 */
export function legacyOutfitClips<T>(
  sprite: string,
  count: number,
  lookup: (key: string) => T | undefined,
  size: { w: number; h: number },
): ClipSet<T> | undefined {
  const n = Math.max(1, Math.floor(count));
  const idle: T[][] = [];
  const walk: T[][] = [];
  for (const dir of STRAIGHT_DIRS) {
    const list: T[] = [];
    for (let f = 0; f < n; f++) {
      const tex = lookup(`${sprite}/${dir}_${f}`);
      if (tex === undefined) return undefined;
      list.push(tex);
    }
    idle.push(list.slice(0, 1));
    walk.push(n > 1 ? list.slice(1) : list.slice(0, 1));
  }
  const walking = Math.max(1, n - 1);
  const meta: AnimMeta = {
    w: size.w,
    h: size.h,
    anchor: "br",
    foot: 0,
    top: size.h,
    shadow: "baked",
    actions: {
      idle: { frames: 1, ms: 1000, dirs: [...STRAIGHT_DIRS] },
      walk: { frames: walking, ms: 0, perTile: walking, dirs: [...STRAIGHT_DIRS] },
    },
  };
  return { meta, frames: { idle, walk }, still: idle[2]?.[0], eight: false };
}

/**
 * The texture for a pose: its clip frame, else the idle or walk pose of that facing, else
 * the still texture (an action the sprite has no clip for keeps its stance).
 */
export function clipTexture<T>(
  c: ClipSet<T>,
  action: AnimAction,
  dir: number,
  frame: number,
): T | undefined {
  return (
    c.frames[action]?.[dir]?.[frame] ??
    c.frames.idle?.[dir]?.[0] ??
    c.frames.walk?.[dir]?.[0] ??
    c.still
  );
}

/**
 * How far a creature's drawing rises above its tile (sprite pixels): names and health bars
 * go that much higher, over the head (ART-2). `size` is the sprite's when there is no meta.
 */
export function headLift(
  meta: AnimMeta | undefined,
  size: { w: number; h: number } | undefined,
  tile: number,
  feetLine: number,
): number {
  if (!meta) return Math.max(0, (size?.h ?? tile) - tile);
  const top = meta.anchor === "bc" ? feetLine + meta.top : meta.foot + meta.top;
  return Math.max(0, top - tile);
}
