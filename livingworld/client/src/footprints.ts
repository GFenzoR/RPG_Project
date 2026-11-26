// Footprints (livingworld/README.md "Huellas: qué las borra"): each foot a creature plants
// on sand, snow, mud, wet sand or ash (gait.ts: the footfalls of its walk cycle) leaves an
// oriented mark. A mark has no lifetime of its own: it stays until something that happens
// there erases it.
//
//   wind    the shared wind field (wind.ts) blowing over the mark, by how exposed its place
//           is: a gust on an open beach wears it away in seconds, and since a gust front
//           travels, the marks go one after another from the windward side; in a sheltered
//           spot the wind never reaches the strength that moves the grains
//   waves   on wet sand by the water, the next wave that runs that far up the shore wipes
//           it (waveReach: every wave has its own reach, from its number)
//   tread   another creature's foot landing on it scuffs it
//   rain    a hook for the weather to come (FootprintSim.rain, erased share per second)
//   cap     at most MAX_FOOTPRINTS exist: past SOFT_FOOTPRINTS the oldest fade out
//
// All of it is a function of the mark's place, the clock and data/livingworld
// (surfaces.yaml `prints`, wind.yaml): no randomness and no server state, so two clients
// with the same clock see the same beach.
import type { Surface } from "./data.ts";
import type { PrintKind } from "./gait.ts";
import { hash01 } from "./hash.ts";
import { gustAt, strengthAt } from "./wind.ts";
import type { WindField } from "./wind.ts";

/** docs/07: footprints alive at once. */
export const MAX_FOOTPRINTS = 64;
/** Past this many the oldest fade out, so the pool never has to pop one. */
export const SOFT_FOOTPRINTS = 56;

export { PRINT_KINDS, stepRotation } from "./gait.ts";
export type { PrintKind } from "./gait.ts";

/** What erases the footprints of a surface (data/livingworld/surfaces.yaml `prints`). */
export interface PrintRules {
  /** Share of a mark a wind of strength 1 over the still air's erases per second. */
  wind: number;
  /** The waves of the water next to it wipe its marks (wet sand). */
  waves: boolean;
  /** Share of a mark another creature's foot erases when it lands on it. */
  tread: number;
}

/** The shore's waves (surfaces.yaml `prints.waves`). */
export interface WaveRules {
  /** A wave every this long, ms. */
  periodMs: number;
  /** The furthest a wave runs up the shore, tiles from the water's edge. */
  reachTiles: number;
  /** A wave reaches a tile further along the shore this much later, ms per tile. */
  lagMs: number;
  /** A wave wipes a mark over this long, ms. */
  washMs: number;
}

/** What erases footprints everywhere (surfaces.yaml `prints`). */
export interface PrintField {
  /** The wind's strength (wind.ts strengthAt) under which no mark is touched. */
  still: number;
  /** A mark over the cap fades over this long, ms. */
  fadeMs: number;
  /** A foot landing this near a mark (sprite px) scuffs it. */
  treadPx: number;
  waves: WaveRules;
}

export const DEFAULT_PRINT_FIELD: PrintField = {
  still: 0.45,
  fadeMs: 700,
  treadPx: 5,
  waves: { periodMs: 7680, reachTiles: 2.5, lagMs: 400, washMs: 500 },
};

export interface Footprint {
  /** Sprite pixels, world space: the mark's centre. */
  x: number;
  y: number;
  /** Rotation, radians (0 = walking north, up the screen). */
  rot: number;
  kind: PrintKind;
  surface: Surface;
  tint: number;
  /** Which foot left it: -1 left, 1 right, 0 on the centre line. */
  side: number;
  /** The creature that left it (its own feet do not scuff it). */
  by: number;
  /** How much of it is erased, 0 (fresh) to 1 (gone). */
  wear: number;
  /** Share a wind of strength 1 over the still air's erases per second. */
  wind: number;
  /** How hard the wind blows where it lies (wind.ts exposureOf); 0: sheltered. */
  exposure: number;
  /** Share another creature's foot erases. */
  tread: number;
  /** When the wave that wipes it arrives, ms on the clock; Infinity: none does. */
  waveAt: number;
  /** Over the cap: it fades out. */
  retiring: boolean;
  /** The order it was made in (the oldest go first over the cap). */
  seq: number;
  /** Its size (Gait.scale) and its opacity while fresh (Gait.depth). */
  scale: number;
  depth: number;
}

/** What a new footprint is made of. */
export interface PrintSpec {
  x: number;
  y: number;
  rot: number;
  kind: PrintKind;
  surface: Surface;
  tint: number;
  rules: PrintRules;
  side?: number;
  by?: number;
  /** How hard the wind blows there (wind.ts exposureOf); absent: 1. */
  exposure?: number;
  /** Tiles from the mark to the water's edge (shoreDistance); absent: no wave reaches it. */
  shore?: number | undefined;
  scale?: number;
  depth?: number;
}

/** Waves looked ahead for the one that reaches a mark (past them it stays until capped). */
const WAVES_AHEAD = 24;

/**
 * How far up the shore wave number `n` runs, tiles from the water's edge: every wave its
 * own, from 0.75 of a tile to `reachTiles`, most of them short.
 */
export function waveReach(w: WaveRules, n: number): number {
  const h = hash01(n, 17, 4099);
  return 0.75 + (w.reachTiles - 0.75) * h * h;
}

/** When wave `n` reaches the shore at (x, y) tiles: the waves run along the coast. */
export function waveTime(w: WaveRules, n: number, x: number, y: number): number {
  return n * w.periodMs + (x + y) * w.lagMs;
}

/**
 * When the next wave wipes a mark at (x, y) tiles, `shore` tiles from the water's edge,
 * made at `now`: the first wave after `now` that runs that far. Infinity when none of
 * the next WAVES_AHEAD does (a mark too far up the beach).
 */
export function nextWash(w: WaveRules, x: number, y: number, shore: number, now: number): number {
  if (w.periodMs <= 0 || shore > w.reachTiles) return Number.POSITIVE_INFINITY;
  const first = Math.floor((now - (x + y) * w.lagMs) / w.periodMs) + 1;
  for (let n = first; n < first + WAVES_AHEAD; n++)
    if (waveReach(w, n) >= shore) return waveTime(w, n, x, y);
  return Number.POSITIVE_INFINITY;
}

/**
 * Tiles from the middle of tile (x, y) to the edge of the nearest water tile within
 * `reach` tiles (0.5: the water is the next tile), or undefined when there is none.
 * `water(x, y)` says whether a tile is water.
 */
export function shoreDistance(
  x: number,
  y: number,
  reach: number,
  water: (x: number, y: number) => boolean,
): number | undefined {
  const r = Math.ceil(reach);
  let best: number | undefined;
  for (let oy = -r; oy <= r; oy++)
    for (let ox = -r; ox <= r; ox++) {
      if ((ox === 0 && oy === 0) || !water(x + ox, y + oy)) continue;
      const d = Math.hypot(ox, oy) - 0.5;
      if (best === undefined || d < best) best = d;
    }
  return best !== undefined && best <= reach ? best : undefined;
}

/**
 * Share of a mark the wind erases per second: nothing up to the still air's strength,
 * then the square of what blows over it (a gust does most of the work).
 */
export function windErosion(rate: number, strength: number, still: number): number {
  const over = strength - still;
  return over > 0 ? rate * over * over : 0;
}

export class FootprintSim {
  readonly prints: Footprint[] = [];
  /** Rain, a hook for the weather to come: share of every mark it erases per second. */
  rain = 0;

  readonly field: PrintField;
  private readonly windField: WindField | undefined;
  private readonly tile: number;
  private seq = 0;
  /** Footprints that are gone, kept to be written over (docs/07: none made per step). */
  private readonly free: Footprint[] = [];

  /** `tile`: sprite pixels per tile (the wind and the waves are measured in tiles). */
  constructor(field: PrintField = DEFAULT_PRINT_FIELD, wind?: WindField, tile = 32) {
    this.field = field;
    this.windField = wind;
    this.tile = tile;
  }

  get count(): number {
    return this.prints.length;
  }

  /** A footprint at `now`. Over the soft cap the oldest starts to fade. */
  add(s: PrintSpec, now = 0): void {
    let p: Footprint | undefined;
    if (this.prints.length < MAX_FOOTPRINTS) {
      p = this.free.pop() ?? {
        x: 0,
        y: 0,
        rot: 0,
        kind: s.kind,
        surface: s.surface,
        tint: 0,
        side: 0,
        by: 0,
        wear: 0,
        wind: 0,
        exposure: 0,
        tread: 0,
        waveAt: 0,
        retiring: false,
        seq: 0,
        scale: 1,
        depth: 1,
      };
      this.prints.push(p);
    } else {
      // A burst that outran the fade: write over the most erased one.
      let worst = -1;
      for (const q of this.prints)
        if (q.wear > worst) {
          worst = q.wear;
          p = q;
        }
    }
    if (!p) return;
    p.x = s.x;
    p.y = s.y;
    p.rot = s.rot;
    p.kind = s.kind;
    p.surface = s.surface;
    p.tint = s.tint;
    p.side = s.side ?? 0;
    p.by = s.by ?? 0;
    p.wear = 0;
    p.wind = s.rules.wind;
    p.exposure = s.exposure ?? 1;
    p.tread = s.rules.tread;
    p.waveAt =
      s.rules.waves && s.shore !== undefined
        ? nextWash(this.field.waves, s.x / this.tile, s.y / this.tile, s.shore, now)
        : Number.POSITIVE_INFINITY;
    p.retiring = false;
    p.seq = this.seq++;
    p.scale = s.scale ?? 1;
    p.depth = s.depth ?? 1;
    this.retire();
  }

  /** Over the soft cap: the oldest marks not fading yet start to. */
  private retire(): void {
    let over = -SOFT_FOOTPRINTS;
    for (const q of this.prints) if (!q.retiring) over++;
    for (; over > 0; over--) {
      let oldest: Footprint | undefined;
      for (const q of this.prints) if (!q.retiring && (!oldest || q.seq < oldest.seq)) oldest = q;
      if (!oldest) return;
      oldest.retiring = true;
    }
  }

  /**
   * A foot of creature `by` landed at (x, y): the marks of other creatures under it are
   * scuffed. Returns how many.
   */
  tread(x: number, y: number, by: number): number {
    const r = this.field.treadPx;
    let n = 0;
    for (const p of this.prints) {
      if (p.by === by || p.tread <= 0) continue;
      if (Math.abs(p.x - x) > r || Math.abs(p.y - y) > r) continue;
      p.wear += p.tread;
      n++;
    }
    return n;
  }

  /**
   * `ms` pass, up to clock `now`: the wind (times `windScale`: the night's calmer wind, 0
   * where none blows), the waves, the rain and the cap erase; the gone ones are dropped.
   */
  step(ms: number, now: number, windScale = 1): void {
    const f = this.field;
    const wf = windScale > 0 ? this.windField : undefined;
    const s = ms / 1000;
    let w = 0;
    for (const p of this.prints) {
      if (wf && p.wind > 0 && p.exposure > 0) {
        const strength = strengthAt(
          wf,
          gustAt(wf, p.x / this.tile, p.y / this.tile, now),
          p.exposure * windScale,
        );
        p.wear += windErosion(p.wind, strength, f.still) * s;
      }
      if (this.rain > 0) p.wear += this.rain * s;
      if (now >= p.waveAt) p.wear += ms / Math.max(1, f.waves.washMs);
      if (p.retiring) p.wear += ms / Math.max(1, f.fadeMs);
      if (p.wear < 1) this.prints[w++] = p;
      else this.free.push(p);
    }
    this.prints.length = w;
  }

  /** How visible footprint p is: its depth while fresh, less as it is erased. */
  static alpha(p: Footprint): number {
    return p.depth * Math.max(0, 1 - p.wear);
  }

  clear(): void {
    for (const p of this.prints) this.free.push(p);
    this.prints.length = 0;
  }
}
