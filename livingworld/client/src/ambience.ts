// Positional ambience (livingworld/README.md "Ambiente", the owner's request of 2026-11-23:
// "the sea where the sea is, wind in the desert, the trees in the forest, a fountain, a
// campfire"). Pure and free of Pixi and of Web Audio: the client's audio glue
// (client/src/audio/ambience.ts) feeds it the map around the player and hands the voices it
// returns to the audio engine, which only mirrors them on looping buffer sources.
//
// Two kinds of layer, both data (data/livingworld/ambience.yaml):
// - **Beds**: the mix of the tiles in a square window around the player. Each tile weighs
//   for each bed by its ground's surface and its items (water → waves, sand → wind, trees →
//   leaves); a bed's level is its share of the known tiles over `full`. Kept incrementally:
//   a step adds the row or column that comes into the window and takes away the one that
//   leaves it, from a ring of what each window tile added (exact integer sums, so the
//   result is the same as counting it all again). A full count every `rescan_ms` picks up
//   tiles that changed under it.
// - **Emitters**: map items that sound by themselves (a fountain, a brazier, a forge),
//   found in the same window. Each one is heard within its radius, quieter with distance and
//   panned by its x against the player's; emitters of one sound make one voice.
//
// The mixer turns those targets into voices: at most `voices` at once (`voices_lite` on a
// phone or with reduced animations), the loudest first; a gain never jumps, it moves by at
// most one full scale per `fade_ms`, so a layer that goes away fades out and one that comes
// back while still fading is the same voice coming up again, never a restart. A new voice
// starts its loop at a random point (seeded, never close to where that sound started last),
// so two loops never line up again at the same second.

import type { Surface } from "./data.ts";
import { isSurface } from "./data.ts";
import { seededRandom } from "./hash.ts";

// ---- data ---------------------------------------------------------------------------------

/** Which floors a bed plays on: up to the sea floor (z <= 7), under it, or both. */
export type Floors = "surface" | "underground" | "any";
/** How an emitter fades with distance d over its radius r: 1 − d/r, or (1 − d/r)². */
export type Falloff = "linear" | "smooth";

export interface BedRule {
  id: string;
  /** Sound id of assets/sounds.yaml (channel ambient). */
  sound: string;
  /** Gain at full level, 0..1. */
  volume: number;
  floors: Floors;
  /** Share of weighted tiles in the window that gives full level (0..1]. */
  full: number;
  /** Level added whatever the tiles (a cave sounds like a cave everywhere). */
  base: number;
  /** Weight of a tile by its ground's surface, 0..1. */
  surfaces: Partial<Record<Surface, number>>;
  /** Weight of a tile with this item (data/items id), 0..1. */
  items: Readonly<Record<string, number>>;
}

export interface EmitterRule {
  /** The data/items id it is on. */
  item: string;
  sound: string;
  volume: number;
  /** Tiles; beyond it the emitter is culled. At most the window's radius. */
  radius: number;
  falloff: Falloff;
}

export interface AmbienceData {
  /** Half side of the square window around the player, tiles. */
  radius: number;
  /** A gain goes from 0 to 1 (or back) over this, ms. */
  fadeMs: number;
  /** Most voices at once, and on a phone or with reduced animations. */
  voices: number;
  voicesLite: number;
  /** The whole window is counted again this often, ms (tiles that changed). */
  rescanMs: number;
  beds: readonly BedRule[];
  /** By data/items id. */
  emitters: Readonly<Record<string, EmitterRule>>;
}

export const AMBIENCE_DEFAULTS = {
  radius: 10,
  fadeMs: 2500,
  voices: 6,
  voicesLite: 3,
  rescanMs: 2000,
} as const;
/** The largest window radius (a 33x33 window: 1089 tiles at a full count). */
export const MAX_RADIUS = 16;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;

function weights(v: unknown, keep: (k: string) => boolean): Record<string, number> {
  const out: Record<string, number> = {};
  if (isObj(v))
    for (const [k, w] of Object.entries(v))
      if (keep(k) && typeof w === "number" && w > 0) out[k] = Math.min(1, w);
  return out;
}

/**
 * The client's view of data/livingworld/ambience.yaml (already parsed YAML), or undefined
 * without one. Lenient like parseLivingWorldData: make validate checks the file against
 * livingworld-ambience.schema.json, so anything malformed is skipped, not thrown.
 */
export function parseAmbience(raw: unknown): AmbienceData | undefined {
  if (!isObj(raw)) return undefined;
  const d = AMBIENCE_DEFAULTS;
  const radius = Math.round(num(raw["radius"], d.radius, 2, MAX_RADIUS));
  const beds: BedRule[] = [];
  if (isObj(raw["beds"]))
    for (const [id, b] of Object.entries(raw["beds"])) {
      if (!isObj(b) || typeof b["sound"] !== "string") continue;
      const floors = b["floors"];
      beds.push({
        id,
        sound: b["sound"],
        volume: num(b["volume"], 1, 0, 1),
        floors: floors === "underground" || floors === "any" ? floors : "surface",
        full: num(b["full"], 0.5, 0.001, 1),
        base: num(b["base"], 0, 0, 1),
        surfaces: weights(b["surfaces"], isSurface),
        items: weights(b["items"], () => true),
      });
    }
  const emitters: Record<string, EmitterRule> = {};
  if (isObj(raw["emitters"]))
    for (const [item, e] of Object.entries(raw["emitters"])) {
      if (!isObj(e) || typeof e["sound"] !== "string") continue;
      emitters[item] = {
        item,
        sound: e["sound"],
        volume: num(e["volume"], 1, 0, 1),
        radius: num(e["radius"], 5, 1, radius),
        falloff: e["falloff"] === "linear" ? "linear" : "smooth",
      };
    }
  const voices = Math.round(num(raw["voices"], d.voices, 1, 8));
  return {
    radius,
    fadeMs: num(raw["fade_ms"], d.fadeMs, 100, 20_000),
    voices,
    voicesLite: Math.min(voices, Math.round(num(raw["voices_lite"], d.voicesLite, 1, 8))),
    rescanMs: num(raw["rescan_ms"], d.rescanMs, 250, 60_000),
    beds,
    emitters,
  };
}

// ---- what each map item counts for --------------------------------------------------------

/** Weights are kept as integers (WEIGHT per full tile) so sums never drift. */
export const WEIGHT = 1000;
/** The deepest floor that is "surface" (docs/03: 7 is the sea level, below it caves). */
export const SURFACE_FLOOR = 7;

interface ItemClass {
  /** Per bed: WEIGHT × the item's weight for it (as a ground: by its surface). */
  beds: Int32Array;
  emitter: EmitterRule | undefined;
}

/** What each item number of the map is for the ambience, worked out once per number. */
export class Classifier {
  private readonly cache = new Map<number, ItemClass>();
  private readonly data: AmbienceData;
  private readonly itemId: (num: number) => string | undefined;
  private readonly surface: (num: number) => Surface | undefined;

  constructor(
    data: AmbienceData,
    itemId: (num: number) => string | undefined,
    surface: (num: number) => Surface | undefined,
  ) {
    this.data = data;
    this.itemId = itemId;
    this.surface = surface;
  }

  of(num: number): ItemClass {
    let c = this.cache.get(num);
    if (c) return c;
    const id = this.itemId(num);
    const s = this.surface(num);
    const beds = new Int32Array(this.data.beds.length);
    this.data.beds.forEach((b, i) => {
      const w = Math.max(
        s === undefined ? 0 : (b.surfaces[s] ?? 0),
        id === undefined ? 0 : (b.items[id] ?? 0),
      );
      beds[i] = Math.round(w * WEIGHT);
    });
    c = { beds, emitter: id === undefined ? undefined : this.data.emitters[id] };
    this.cache.set(num, c);
    return c;
  }
}

// ---- the window around the player -----------------------------------------------------------

/** The map as the module reads it: the item numbers of a known tile, ground first. */
export type TileSource = (x: number, y: number, z: number) => readonly number[] | undefined;

export interface EmitterAt {
  x: number;
  y: number;
  rule: EmitterRule;
}

/**
 * The composition of the (2R+1)² window around a centre tile: per bed the sum of the tile
 * weights and of weight × x (where the bed lies, for its pan), the known tiles and the
 * emitters in it. Each window tile's share is kept in a ring indexed by world position, so
 * a tile that leaves takes away exactly what it brought.
 */
export class Composition {
  readonly sums: Int32Array;
  readonly sumsX: Float64Array;
  known = 0;
  readonly emitters = new Map<number, EmitterAt>();
  cx = 0;
  cy = 0;
  z = 0;
  placed = false;
  private readonly side: number;
  /** Per slot: whether it holds a known tile, its bed weights and its emitter. */
  private readonly slotKnown: Uint8Array;
  private readonly slotBeds: Int32Array;
  private readonly slotEmitter: (EmitterAt | undefined)[];
  private readonly beds: number;
  readonly radius: number;
  private readonly classify: Classifier;
  private readonly source: TileSource;

  constructor(radius: number, beds: number, classify: Classifier, source: TileSource) {
    this.radius = radius;
    this.classify = classify;
    this.source = source;
    this.beds = beds;
    this.side = 2 * radius + 1;
    const slots = this.side * this.side;
    this.sums = new Int32Array(beds);
    this.sumsX = new Float64Array(beds);
    this.slotKnown = new Uint8Array(slots);
    this.slotBeds = new Int32Array(slots * beds);
    this.slotEmitter = new Array<EmitterAt | undefined>(slots).fill(undefined);
  }

  /** Counts the whole window around (x, y, z) again. */
  rebuild(x: number, y: number, z: number): void {
    this.sums.fill(0);
    this.sumsX.fill(0);
    this.known = 0;
    this.emitters.clear();
    this.slotKnown.fill(0);
    this.slotBeds.fill(0);
    this.slotEmitter.fill(undefined);
    this.cx = x;
    this.cy = y;
    this.z = z;
    this.placed = true;
    const r = this.radius;
    for (let ty = y - r; ty <= y + r; ty++)
      for (let tx = x - r; tx <= x + r; tx++) this.add(tx, ty);
  }

  /** Moves the window's centre to (x, y, z): only the rows and columns that change. */
  moveTo(x: number, y: number, z: number): void {
    const dx = x - this.cx;
    const dy = y - this.cy;
    if (!this.placed || z !== this.z || Math.abs(dx) > this.radius || Math.abs(dy) > this.radius) {
      this.rebuild(x, y, z);
      return;
    }
    const r = this.radius;
    // Columns first, over the old rows; then rows, over the new columns.
    for (; this.cx < x; this.cx++)
      for (let ty = this.cy - r; ty <= this.cy + r; ty++) {
        this.remove(this.cx - r, ty);
        this.add(this.cx + r + 1, ty);
      }
    for (; this.cx > x; this.cx--)
      for (let ty = this.cy - r; ty <= this.cy + r; ty++) {
        this.remove(this.cx + r, ty);
        this.add(this.cx - r - 1, ty);
      }
    for (; this.cy < y; this.cy++)
      for (let tx = this.cx - r; tx <= this.cx + r; tx++) {
        this.remove(tx, this.cy - r);
        this.add(tx, this.cy + r + 1);
      }
    for (; this.cy > y; this.cy--)
      for (let tx = this.cx - r; tx <= this.cx + r; tx++) {
        this.remove(tx, this.cy + r);
        this.add(tx, this.cy - r - 1);
      }
  }

  private slot(x: number, y: number): number {
    const s = this.side;
    return (((y % s) + s) % s) * s + (((x % s) + s) % s);
  }

  private add(x: number, y: number): void {
    const stack = this.source(x, y, this.z);
    if (stack === undefined) return;
    const slot = this.slot(x, y);
    const base = slot * this.beds;
    let emitter: EmitterRule | undefined;
    for (const item of stack) {
      const c = this.classify.of(item);
      for (let b = 0; b < this.beds; b++) {
        const w = c.beds[b] ?? 0;
        if (w > (this.slotBeds[base + b] ?? 0)) this.slotBeds[base + b] = w;
      }
      emitter ??= c.emitter;
    }
    this.slotKnown[slot] = 1;
    this.known++;
    for (let b = 0; b < this.beds; b++) {
      const w = this.slotBeds[base + b] ?? 0;
      this.sums[b] = (this.sums[b] ?? 0) + w;
      this.sumsX[b] = (this.sumsX[b] ?? 0) + w * x;
    }
    if (emitter) {
      const at: EmitterAt = { x, y, rule: emitter };
      this.slotEmitter[slot] = at;
      this.emitters.set(slot, at);
    }
  }

  private remove(x: number, y: number): void {
    const slot = this.slot(x, y);
    if (this.slotKnown[slot] === 0) return;
    const base = slot * this.beds;
    for (let b = 0; b < this.beds; b++) {
      const w = this.slotBeds[base + b] ?? 0;
      this.sums[b] = (this.sums[b] ?? 0) - w;
      this.sumsX[b] = (this.sumsX[b] ?? 0) - w * x;
      this.slotBeds[base + b] = 0;
    }
    this.slotKnown[slot] = 0;
    this.known--;
    if (this.slotEmitter[slot]) {
      this.slotEmitter[slot] = undefined;
      this.emitters.delete(slot);
    }
  }
}

// ---- targets ------------------------------------------------------------------------------

/** What a layer wants to sound like now. */
export interface Target {
  sound: string;
  gain: number;
  /** −1 (left) .. 1 (right). */
  pan: number;
}

/** An emitter is fully to one side at this many tiles of x away… */
export const PAN_TILES = 6;
/** …and pans this far at most (never one ear only). */
export const MAX_PAN = 0.8;
/** A bed pans at most this far, towards where its tiles lie. */
export const BED_PAN = 0.5;
/** Below this a layer is silent (no voice is spent on it). */
export const MIN_GAIN = 0.01;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The pan of a sound `dx` tiles to the right of the player (negative: left). */
export function panOf(dx: number): number {
  return clamp(dx / PAN_TILES, -1, 1) * MAX_PAN;
}

/** An emitter's gain `dx`, `dy` tiles from the player, or undefined beyond its radius (culled). */
export function emitterGain(rule: EmitterRule, dx: number, dy: number): number | undefined {
  const d = Math.hypot(dx, dy);
  if (d > rule.radius) return undefined;
  const k = 1 - d / rule.radius;
  return rule.volume * (rule.falloff === "linear" ? k : k * k);
}

function floorFits(f: Floors, z: number): boolean {
  return f === "any" || (f === "surface" ? z <= SURFACE_FLOOR : z > SURFACE_FLOOR);
}

/** Each bed's target from a window's composition (silent ones left out). */
export function bedTargets(comp: Composition, beds: readonly BedRule[]): Target[] {
  const out: Target[] = [];
  beds.forEach((b, i) => {
    if (!floorFits(b.floors, comp.z)) return;
    const sum = comp.sums[i] ?? 0;
    const share = comp.known > 0 ? sum / (WEIGHT * comp.known) : 0;
    const level = Math.min(1, b.base + share / b.full);
    const gain = b.volume * level;
    if (gain < MIN_GAIN) return;
    const centre = sum > 0 ? (comp.sumsX[i] ?? 0) / sum - comp.cx : 0;
    out.push({ sound: b.sound, gain, pan: clamp(centre / comp.radius, -1, 1) * BED_PAN });
  });
  return out;
}

/** The emitters in earshot of the window's centre (culled beyond their radius). */
export function emitterTargets(comp: Composition): Target[] {
  const out: Target[] = [];
  for (const e of comp.emitters.values()) {
    const dx = e.x - comp.cx;
    const gain = emitterGain(e.rule, dx, e.y - comp.cy);
    if (gain === undefined || gain < MIN_GAIN) continue;
    out.push({ sound: e.rule.sound, gain, pan: panOf(dx) });
  }
  return out;
}

/**
 * Targets of one sound become one: the gains add up as power (√Σg², two fountains are
 * louder than one but not twice as loud), never above the loudest layer's volume ceiling of
 * 1, and the pan is the gain-weighted mean. Sorted loudest first (ties by sound id).
 */
export function mergeTargets(targets: readonly Target[]): Target[] {
  const by = new Map<string, { power: number; weight: number; panSum: number }>();
  for (const t of targets) {
    const m = by.get(t.sound) ?? { power: 0, weight: 0, panSum: 0 };
    m.power += t.gain * t.gain;
    m.weight += t.gain;
    m.panSum += t.gain * t.pan;
    by.set(t.sound, m);
  }
  const out: Target[] = [];
  for (const [sound, m] of by)
    out.push({
      sound,
      gain: Math.min(1, Math.sqrt(m.power)),
      pan: m.weight > 0 ? m.panSum / m.weight : 0,
    });
  return out.sort(
    (a, b) => b.gain - a.gain || (a.sound < b.sound ? -1 : a.sound > b.sound ? 1 : 0),
  );
}

// ---- the mixer ------------------------------------------------------------------------------

/** A loop playing (or fading out): what the audio engine mirrors. */
export interface AmbienceVoice {
  readonly id: number;
  readonly sound: string;
  /** Gain now, 0..1 (the engine multiplies it with the sound's volume and the channel). */
  gain: number;
  pan: number;
  /** Where in its loop it starts, as a fraction of the loop's length [0, 1). */
  readonly offset: number;
}

interface MixVoice extends AmbienceVoice {
  target: number;
  targetPan: number;
  /** It makes room for a louder layer: it fades FAST_FADE times faster. */
  fast: boolean;
}

/** The longest step the mixer takes at once, ms (a tab that slept does not jump). */
export const MAX_STEP_MS = 500;
/** A voice that makes room for another fades this many times faster than fade_ms. */
export const FAST_FADE = 4;
/** A pan moves from one side to the other over this, ms. */
export const PAN_MS = 800;
/** A loop's new start is at least this far (fraction of the loop) from its last one. */
export const OFFSET_GAP = 0.25;

export class AmbienceMixer {
  private list: MixVoice[] = [];
  private nextId = 1;
  private last: number | undefined;
  private readonly lastOffset = new Map<string, number>();
  private readonly fadeMs: number;
  private readonly random: () => number;

  constructor(fadeMs: number, random: () => number) {
    this.fadeMs = fadeMs;
    this.random = random;
  }

  voices(): readonly AmbienceVoice[] {
    return this.list;
  }

  /**
   * Moves the voices towards `targets` (merged, loudest first) at `now`, with at most
   * `cap` voices at once, fading ones included.
   */
  update(now: number, targets: readonly Target[], cap: number): readonly AmbienceVoice[] {
    const dt = this.last === undefined ? 0 : Math.min(MAX_STEP_MS, Math.max(0, now - this.last));
    this.last = now;
    const wanted = targets.filter((t) => t.gain >= MIN_GAIN).slice(0, cap);
    const want = new Map(wanted.map((t) => [t.sound, t]));
    for (const v of this.list) {
      const t = want.get(v.sound);
      v.target = t?.gain ?? 0;
      if (t) {
        v.targetPan = t.pan;
        v.fast = false;
      }
    }
    // Layers with no voice yet: a free slot, or room made by the quietest fading voice.
    for (const t of wanted) {
      if (this.list.some((v) => v.sound === t.sound)) continue;
      if (this.list.length < cap) {
        this.list.push({
          id: this.nextId++,
          sound: t.sound,
          gain: 0,
          pan: t.pan,
          offset: this.offsetFor(t.sound),
          target: t.gain,
          targetPan: t.pan,
          fast: false,
        });
        continue;
      }
      let quiet: MixVoice | undefined;
      for (const v of this.list) if (v.target === 0 && (!quiet || v.gain < quiet.gain)) quiet = v;
      if (quiet) quiet.fast = true; // it starts once that one has faded out
    }
    // Every gain moves at most one full scale per fade_ms: nothing is ever cut.
    const step = this.fadeMs > 0 ? dt / this.fadeMs : 1;
    const panStep = (2 * dt) / PAN_MS;
    for (const v of this.list) {
      const s = v.fast ? step * FAST_FADE : step;
      v.gain = v.gain < v.target ? Math.min(v.target, v.gain + s) : Math.max(v.target, v.gain - s);
      v.pan =
        v.pan < v.targetPan
          ? Math.min(v.targetPan, v.pan + panStep)
          : Math.max(v.targetPan, v.pan - panStep);
    }
    this.list = this.list.filter((v) => v.gain > 0 || v.target > 0);
    // Over the cap (it went down: a phone, reduced animations): the quietest fade out fast.
    if (this.list.length > cap) {
      const order = [...this.list].sort((a, b) => a.target - b.target || a.gain - b.gain);
      for (const v of order.slice(0, this.list.length - cap)) {
        v.target = 0;
        v.fast = true;
      }
    }
    return this.list;
  }

  /** A random point of the loop, at least OFFSET_GAP (circularly) from its last start. */
  private offsetFor(sound: string): number {
    const before = this.lastOffset.get(sound);
    let at = this.random();
    if (before !== undefined) {
      const gap = (a: number): number => {
        const d = Math.abs(a - before);
        return Math.min(d, 1 - d);
      };
      for (let i = 0; i < 4 && gap(at) < OFFSET_GAP; i++) at = this.random();
      if (gap(at) < OFFSET_GAP) at = (before + 0.5) % 1;
    }
    this.lastOffset.set(sound, at);
    return at;
  }
}

// ---- the whole ------------------------------------------------------------------------------

export interface AmbienceOptions {
  data: AmbienceData;
  /** The map: item numbers of a known tile, ground first. */
  tile: TileSource;
  /** data/items id of an item number. */
  itemId(num: number): string | undefined;
  /** Ground surface of an item number (data/items `ground.surface`). */
  surface(num: number): Surface | undefined;
  /** Fewer voices (a phone, reduced animations). */
  lite(): boolean;
  /** Seed of the loops' start points (default fixed: the same walk, the same mix). */
  seed?: number;
}

export interface AmbiencePos {
  x: number;
  y: number;
  z: number;
}

export interface Ambience {
  /** The voices for the player at `pos` at `now` (ms). Call it a few times a second. */
  update(now: number, pos: AmbiencePos): readonly AmbienceVoice[];
  /** The current mix (tests, E2E). */
  voices(): readonly AmbienceVoice[];
  /** The window's composition (tests). */
  readonly composition: Composition;
}

export function createAmbience(opts: AmbienceOptions): Ambience {
  const { data } = opts;
  const classify = new Classifier(data, opts.itemId, opts.surface);
  const comp = new Composition(data.radius, data.beds.length, classify, opts.tile);
  const mixer = new AmbienceMixer(data.fadeMs, seededRandom(opts.seed ?? 0x5a17));
  let scannedAt = Number.NEGATIVE_INFINITY;
  return {
    composition: comp,
    voices: () => mixer.voices(),
    update(now, pos) {
      if (now - scannedAt >= data.rescanMs || pos.z !== comp.z || !comp.placed) {
        comp.rebuild(pos.x, pos.y, pos.z);
        scannedAt = now;
      } else comp.moveTo(pos.x, pos.y, pos.z);
      const targets = mergeTargets([...bedTargets(comp, data.beds), ...emitterTargets(comp)]);
      return mixer.update(now, targets, opts.lite() ? data.voicesLite : data.voices);
    },
  };
}
