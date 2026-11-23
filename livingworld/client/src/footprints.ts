// Footprints (livingworld/README.md): a creature stepping off sand, snow, mud, wet sand or
// ash leaves an oriented mark that fades. A footprint "wears" one ms per ms; on a windy
// surface (sand) the wind adds wear in gusts, deterministic from the mark's position and the
// clock. At most MAX_FOOTPRINTS exist: a new one replaces the most worn (docs/07).
import type { Surface, SurfaceRules } from "./data.ts";
import { hash01 } from "./hash.ts";

/** docs/07: footprints alive at once. */
export const MAX_FOOTPRINTS = 64;
/** The last part of a footprint's life it fades over (a fraction of its life). */
export const FADE_FROM = 0.5;

/** Whose feet: a humanoid's, a small beast's paws, a big beast's paws. */
export type PrintKind = "feet" | "paw" | "big_paw";
export const PRINT_KINDS: readonly PrintKind[] = ["feet", "paw", "big_paw"];

export interface Footprint {
  /** Sprite pixels, world space: the mark's centre. */
  x: number;
  y: number;
  /** Rotation, radians (0 = walking north, up the screen). */
  rot: number;
  kind: PrintKind;
  surface: Surface;
  tint: number;
  /** Wear so far and wear at which it is gone, ms. */
  wear: number;
  life: number;
  /** Extra wear per ms in a full gust (SurfaceRules.wind). */
  wind: number;
}

/**
 * How strong the wind blows at (x, y) sprite pixels at `now` ms: 0 (calm) to 1 (a gust).
 * Gusts roll across the map: a slow wave with a per-area phase, sharpened so most of the
 * time is calm.
 */
export function gust(x: number, y: number, now: number): number {
  const phase = hash01(Math.floor(x / 96), Math.floor(y / 96), 7) * Math.PI * 2;
  const wave = 0.5 + 0.5 * Math.sin(now / 2300 + phase + x / 97 - y / 131);
  return wave * wave * wave;
}

/** The rotation of a step from (dx, dy) (tile deltas, -1..1): 0 north, clockwise. */
export function stepRotation(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  return Math.atan2(dx, -dy);
}

export class FootprintSim {
  readonly prints: Footprint[] = [];

  get count(): number {
    return this.prints.length;
  }

  /** A footprint at (x, y); if the cap is reached, it takes the place of the most worn. */
  add(
    x: number,
    y: number,
    rot: number,
    kind: PrintKind,
    surface: Surface,
    rules: SurfaceRules,
  ): void {
    if (rules.footprintMs <= 0) return;
    const p: Footprint = {
      x,
      y,
      rot,
      kind,
      surface,
      tint: rules.tint,
      wear: 0,
      life: rules.footprintMs,
      wind: rules.wind,
    };
    if (this.prints.length < MAX_FOOTPRINTS) {
      this.prints.push(p);
      return;
    }
    let worst = 0;
    let worstT = -1;
    for (let i = 0; i < this.prints.length; i++) {
      const q = this.prints[i] as Footprint;
      const t = q.wear / q.life;
      if (t > worstT) {
        worstT = t;
        worst = i;
      }
    }
    this.prints[worst] = p;
  }

  /** Wears every footprint `ms` at clock `now`; the gone ones are dropped. */
  step(ms: number, now: number): void {
    let w = 0;
    for (const p of this.prints) {
      p.wear += ms * (1 + (p.wind > 0 ? p.wind * gust(p.x, p.y, now) : 0));
      if (p.wear < p.life) this.prints[w++] = p;
    }
    this.prints.length = w;
  }

  /** How visible footprint p is: 1 while fresh, fading to 0 over its last part. */
  static alpha(p: Footprint): number {
    const t = p.wear / p.life;
    if (t <= FADE_FROM) return 1;
    return Math.max(0, 1 - (t - FADE_FROM) / (1 - FADE_FROM));
  }

  clear(): void {
    this.prints.length = 0;
  }
}
