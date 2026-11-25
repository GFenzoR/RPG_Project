// Footprints (livingworld/README.md): each foot a creature plants on sand, snow, mud, wet
// sand or ash (gait.ts: the footfalls of its walk cycle) leaves an oriented mark that
// fades. A footprint "wears" one ms per ms; on a windy surface (sand) the wind adds wear in
// gusts, deterministic from the mark's position and the clock. At most MAX_FOOTPRINTS
// exist: a new one replaces the most worn (docs/07).
import type { Surface, SurfaceRules } from "./data.ts";
import type { PrintKind } from "./gait.ts";
import { hash01 } from "./hash.ts";

/** docs/07: footprints alive at once. */
export const MAX_FOOTPRINTS = 64;
/** The last part of a footprint's life it fades over (a fraction of its life). */
export const FADE_FROM = 0.5;

export { PRINT_KINDS, stepRotation } from "./gait.ts";
export type { PrintKind } from "./gait.ts";

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
  /** Its size (Gait.scale) and its opacity while fresh (Gait.depth). */
  scale: number;
  depth: number;
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

export class FootprintSim {
  readonly prints: Footprint[] = [];

  get count(): number {
    return this.prints.length;
  }

  /** Footprints that wore away, kept to be written over (docs/07: none made per step). */
  private readonly free: Footprint[] = [];

  /** A footprint at (x, y); if the cap is reached, it takes the place of the most worn. */
  add(
    x: number,
    y: number,
    rot: number,
    kind: PrintKind,
    surface: Surface,
    rules: SurfaceRules,
    scale = 1,
    depth = 1,
  ): void {
    if (rules.footprintMs <= 0) return;
    let p: Footprint | undefined;
    if (this.prints.length < MAX_FOOTPRINTS) {
      p = this.free.pop() ?? {
        x: 0,
        y: 0,
        rot: 0,
        kind,
        surface,
        tint: 0,
        wear: 0,
        life: 1,
        wind: 0,
        scale: 1,
        depth: 1,
      };
      this.prints.push(p);
    } else {
      let worstT = -1;
      for (const q of this.prints) {
        const t = q.wear / q.life;
        if (t > worstT) {
          worstT = t;
          p = q;
        }
      }
    }
    if (!p) return;
    p.x = x;
    p.y = y;
    p.rot = rot;
    p.kind = kind;
    p.surface = surface;
    p.tint = rules.tint;
    p.wear = 0;
    p.life = rules.footprintMs;
    p.wind = rules.wind;
    p.scale = scale;
    p.depth = depth;
  }

  /** Wears every footprint `ms` at clock `now`; the gone ones are dropped. */
  step(ms: number, now: number): void {
    let w = 0;
    for (const p of this.prints) {
      p.wear += ms * (1 + (p.wind > 0 ? p.wind * gust(p.x, p.y, now) : 0));
      if (p.wear < p.life) this.prints[w++] = p;
      else this.free.push(p);
    }
    this.prints.length = w;
  }

  /** How visible footprint p is: its depth while fresh, fading to 0 over its last part. */
  static alpha(p: Footprint): number {
    const t = p.wear / p.life;
    if (t <= FADE_FROM) return p.depth;
    return p.depth * Math.max(0, 1 - (t - FADE_FROM) / (1 - FADE_FROM));
  }

  clear(): void {
    for (const p of this.prints) this.free.push(p);
    this.prints.length = 0;
  }
}
