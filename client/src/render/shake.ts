// Camera shake on a heavy hit to the player (docs/17 UI-9): 2 px for 120 ms, along a fixed
// pattern that dies down (no randomness: the same hit always shakes the same, and the tests
// see it). Pure, no Pixi. The canvas moves its camera by shakeOffset while it lasts; it is
// off with reduced motion and with the option of its own (Options → Interface).

/** A hit that takes at least this share of the maximum health shakes the camera. */
export const HEAVY_HIT_SHARE = 0.1;
/** How long the shake lasts, ms, and how far it goes at first, CSS px. */
export const SHAKE_MS = 120;
export const SHAKE_PX = 2;

/** Steps of the shake (units of SHAKE_PX), one every SHAKE_STEP_MS. */
const PATTERN: readonly (readonly [number, number])[] = [
  [1, -0.5],
  [-1, 0.5],
  [0.5, 1],
  [-0.5, -1],
  [1, 0],
  [-0.5, 0.5],
  [0.5, -0.5],
  [0, 0],
];
const SHAKE_STEP_MS = SHAKE_MS / PATTERN.length;

/**
 * Whether a change of the player's health is a heavy hit: a loss of HEAVY_HIT_SHARE of the
 * maximum or more (a heal, a level up or the first stats of a login never are).
 */
export function heavyHit(before: number | undefined, after: number, max: number): boolean {
  if (before === undefined || !(max > 0) || after >= before) return false;
  return before - after >= HEAVY_HIT_SHARE * max;
}

/**
 * How far the camera is off `ms` after the hit, in whole device pixels (`dpr` per CSS px):
 * the pattern scaled down as it ends; 0, 0 before it and once SHAKE_MS have passed.
 */
export function shakeOffset(ms: number, dpr = 1): { x: number; y: number } {
  if (!(ms >= 0) || ms >= SHAKE_MS) return { x: 0, y: 0 };
  const step = PATTERN[Math.min(PATTERN.length - 1, Math.floor(ms / SHAKE_STEP_MS))] ?? [0, 0];
  const k = SHAKE_PX * dpr * (1 - ms / SHAKE_MS);
  // `+ 0` turns a -0 into 0.
  return { x: Math.round(step[0] * k) + 0, y: Math.round(step[1] * k) + 0 };
}
