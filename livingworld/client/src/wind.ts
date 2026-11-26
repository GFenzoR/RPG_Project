// The wind (livingworld/README.md "Viento"): trees, bushes and every other plant of the map
// stand still, and every so often a gust crosses the map and bends them as it passes. Pure
// and free of Pixi: numbers only, so the client, the tests and the sway preview of
// tools/spritegen share the same motion.
//
//   gusts   gust k starts at a random moment of its slot of the clock, with its own
//           strength and its own direction round the wind's; its front, a line across the
//           wind, travels `travel_tiles` and dies. Between two gusts: a long calm
//   plant   when the front reaches it, it eases into a lean downwind, holds it while the
//           gust blows, swings a couple of times, each swing smaller, and stands still again
//   sprite  the base stays planted: a row moves by the square of its height over the pivot
//           (where the trunk ends), in whole screen pixels, so the art never blurs
//
// Deterministic: only the tile, the clock, the seed and the data (data/livingworld/wind.yaml).
// With the clock every client shares, every client sees the same gust at the same moment.
import { hash01 } from "./hash.ts";

/** The plant types with wind defaults (data/livingworld/wind.yaml `kinds`). */
export const WIND_KINDS = [
  "tree",
  "palm",
  "bush",
  "tall_grass",
  "reed",
  "flower",
  "vine",
  "cactus",
  "dead_tree",
] as const;
export type WindKind = (typeof WIND_KINDS)[number];

export function isWindKind(v: unknown): v is WindKind {
  return typeof v === "string" && (WIND_KINDS as readonly string[]).includes(v);
}

/** The top of no plant ever moves further than this, sprite px (the schema's limit). */
export const MAX_AMPLITUDE = 4;
/** The drift of a plant in the calm is always under a pixel. */
export const MAX_DRIFT = 0.95;
/** A sprite is cut into at most this many moving strips (wind-mesh.ts). */
export const MAX_STRIPS = 16;
/** A moving strip is at least this tall, sprite px. */
export const STRIP_PX = 2;
/** A plant is still again this many of its swings after the gust lets go of it. */
const SETTLE = 1.5;
/** How far down their envelope the swings are when the last of them ends. */
const DAMPING = 4.75;
/** The gust lets go over this many times its rise. */
const FALL = 2;
/** A gust is born and dies over this share of its travel, at each end. */
const EDGE = 0.15;
/** The front is not a ruler's line: it runs up to this many tiles ahead or behind. */
const FRONT_WOBBLE = 3;
/** Gusts older than this many slots are never looked at (make validate keeps under it). */
const MAX_BACK = 4;
const TAU = Math.PI * 2;

/** How a kind of plant takes the wind (data/livingworld/wind.yaml `kinds.<kind>`). */
export interface WindKindRule {
  /** 0 limp .. 1 rigid: a stiff plant only moves in a strong gust, and swings faster. */
  stiffness: number;
  /** How far its top moves in a full gust, sprite px. */
  amplitude: number;
  /** How far its top drifts in the calm between gusts, sprite px (under 1; 0: stock-still). */
  drift: number;
  /** One swing after a gust, ms. */
  periodMs: number;
  /** Where it starts to move when its sprite does not say, share of the sprite's height. */
  pivot: number;
}

/** The wind over the map (data/livingworld/wind.yaml `field`). */
export interface WindField {
  /** The way the wind blows, radians (0 east, a quarter turn south): each gust near it. */
  dir: number;
  /** How fast a gust front travels, tiles per second. */
  speed: number;
  /** One gust per slot of the clock this long, ms: the mean time between two gusts. */
  everyMs: number;
  /** Where in its slot a gust starts, share of the slot (0: like a clock .. under 1). */
  jitter: number;
  /** The strength of a gust, between these two (each gust its own). */
  strengthMin: number;
  strengthMax: number;
  /** How far a gust's direction strays from the wind's, radians either way. */
  spread: number;
  /** How far a gust front travels before it dies, tiles. */
  travelTiles: number;
  /** A plant eases into its lean over this long, ms. */
  riseMs: number;
  /** ... and holds it this long, while the gust blows over it, ms. */
  holdMs: number;
  /** How many swings it takes to stand still after the gust. */
  swings: number;
  /** One slow drift of a plant in the calm, ms (kinds.<kind>.drift). */
  driftMs: number;
  /** Another seed, another sequence of gusts. */
  seed: number;
  /** A front crosses its whole travel in this long, ms (worked out). */
  crossMs: number;
  /** The slowest plant is still again this long after a front reached it, ms (worked out). */
  responseMs: number;
  /** How many slots back a gust may still be moving a plant (worked out). */
  back: number;
  /** Strength by ground surface (coasts and deserts above 1, floors indoors 0). */
  exposure: Readonly<Record<string, number>>;
  /** Strength over a surface that is not listed. */
  open: number;
  /** How much a dense stand of trees calms the wind inside it, 0..1. */
  forest: number;
  /** Strength at night, a factor. */
  night: number;
}

export interface WindData {
  field: WindField;
  kinds: Readonly<Record<WindKind, WindKindRule>>;
}

/** What a sprite says of itself (data/livingworld/wind_sprites.yaml, written by spritegen). */
export interface SpriteWind {
  kind: WindKind;
  /** Where the trunk or stem ends, px over the sprite's bottom edge: below it nothing moves. */
  pivot?: number | undefined;
  /** Its highest drawn row, px over the bottom edge: the full sway is reached there. */
  top?: number | undefined;
  stiffness?: number | undefined;
  amplitude?: number | undefined;
}

/** A plant's wind, resolved: its kind's defaults with what its sprite and its item say. */
export interface PlantWind extends WindKindRule {
  kind: WindKind;
  /** Px over the sprite's bottom edge; undefined: `pivot` (a share) of the sprite's height. */
  pivotPx: number | undefined;
  /** Px over the bottom edge; undefined: the sprite's height. */
  topPx: number | undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** What a kind does when wind.yaml does not describe it: a middling bush. */
const FALLBACK_KIND: WindKindRule = {
  stiffness: 0.4,
  amplitude: 1,
  drift: 0,
  periodMs: 1400,
  pivot: 0.2,
};

function parseKind(raw: unknown): WindKindRule {
  const r = isObj(raw) ? raw : {};
  return {
    stiffness: num(r["stiffness"], FALLBACK_KIND.stiffness, 0, 1),
    amplitude: num(r["amplitude"], FALLBACK_KIND.amplitude, 0, MAX_AMPLITUDE),
    drift: num(r["drift"], FALLBACK_KIND.drift, 0, MAX_DRIFT),
    periodMs: num(r["period_ms"], FALLBACK_KIND.periodMs, 300, 20000),
    pivot: num(r["pivot"], FALLBACK_KIND.pivot, 0, 0.95),
  };
}

/**
 * The longest a plant moves after a gust front reached it, ms: the lean and the swings of
 * the slowest kind (a plant's own period is at most 1.12 of its kind's `period_ms`).
 */
export function gustResponseMs(
  riseMs: number,
  holdMs: number,
  swings: number,
  slowestPeriodMs: number,
): number {
  return riseMs + holdMs + Math.max(FALL * riseMs, SETTLE * swings * slowestPeriodMs * 1.12);
}

/**
 * data/livingworld/wind.yaml as the client uses it, or undefined without the file (no wind:
 * nothing sways). Lenient like the rest of the living world's data: make validate checks the
 * file against its schema.
 */
export function parseWind(raw: unknown): WindData | undefined {
  if (!isObj(raw)) return undefined;
  const f = isObj(raw["field"]) ? raw["field"] : {};
  const g = isObj(raw["gusts"]) ? raw["gusts"] : {};
  const deg = num(f["direction"], 20, -3600, 3600);
  const range: unknown[] = Array.isArray(g["strength"]) ? g["strength"] : [];
  const strengthMin = num(range[0], 0.6, 0, 1.5);
  const exposure: Record<string, number> = {};
  if (isObj(f["exposure"]))
    for (const [surface, v] of Object.entries(f["exposure"])) exposure[surface] = num(v, 1, 0, 2);
  const kinds = {} as Record<WindKind, WindKindRule>;
  const k = isObj(raw["kinds"]) ? raw["kinds"] : {};
  let slowest = 0;
  for (const kind of WIND_KINDS) {
    kinds[kind] = parseKind(k[kind]);
    slowest = Math.max(slowest, kinds[kind].periodMs);
  }
  const speed = num(f["speed"], 8, 0.5, 40);
  const everyMs = num(g["every_s"], 45, 5, 3600) * 1000;
  const jitter = num(g["jitter"], 0.3, 0, 0.95);
  const travelTiles = num(g["travel_tiles"], 64, 8, 512);
  const riseMs = num(g["rise_ms"], 450, 50, 5000);
  const holdMs = num(g["hold_ms"], 1100, 0, 20000);
  const swings = num(g["swings"], 2, 0, 6);
  const crossMs = (travelTiles / speed) * 1000;
  const responseMs = gustResponseMs(riseMs, holdMs, swings, slowest);
  return {
    field: {
      dir: (deg * Math.PI) / 180,
      speed,
      everyMs,
      jitter,
      strengthMin,
      strengthMax: num(range[1], 1, strengthMin, 1.5),
      spread: (num(g["spread"], 25, 0, 180) * Math.PI) / 180,
      travelTiles,
      riseMs,
      holdMs,
      swings,
      driftMs: num(g["drift_ms"], 9000, 1000, 120000),
      seed: Math.round(num(g["seed"], 1, 0, 1e9)),
      crossMs,
      responseMs,
      // Gust k is over by (k + jitter) slots plus its crossing and the last plant's swings.
      back: Math.min(
        MAX_BACK,
        Math.max(0, Math.ceil((crossMs + responseMs) / everyMs + jitter - 1)),
      ),
      exposure,
      open: num(f["open"], 1, 0, 2),
      forest: num(f["forest"], 0.4, 0, 1),
      night: num(f["night"], 1, 0, 2),
    },
    kinds,
  };
}

/** One sprite's entry of wind_sprites.yaml, or of a plant's own `wind` mapping. */
export function parseSpriteWind(raw: unknown): SpriteWind | undefined {
  if (!isObj(raw) || !isWindKind(raw["kind"])) return undefined;
  const opt = (key: string, min: number, max: number): number | undefined =>
    typeof raw[key] === "number" ? num(raw[key], 0, min, max) : undefined;
  return {
    kind: raw["kind"],
    pivot: opt("pivot", 0, 4096),
    top: opt("top", 1, 4096),
    stiffness: opt("stiffness", 0, 1),
    amplitude: opt("amplitude", 0, MAX_AMPLITUDE),
  };
}

/** data/livingworld/wind_sprites.yaml: sprite path → what the sprite says. */
export function parseWindSprites(raw: unknown): Record<string, SpriteWind> {
  const out: Record<string, SpriteWind> = {};
  const sprites = isObj(raw) && isObj(raw["sprites"]) ? raw["sprites"] : {};
  for (const [path, v] of Object.entries(sprites)) {
    const w = parseSpriteWind(v);
    if (w) out[path] = w;
  }
  return out;
}

/**
 * A plant's wind: its kind's defaults (wind.yaml), then what its sprite says (spritegen),
 * then what its item says (plants.yaml). The later one wins, field by field; a later one of
 * another kind starts over from that kind.
 */
export function resolveWind(
  data: WindData,
  sprite: SpriteWind | undefined,
  item: SpriteWind | undefined,
): PlantWind | undefined {
  const last = item ?? sprite;
  if (!last) return undefined;
  const kind = last.kind;
  const out: PlantWind = { ...data.kinds[kind], kind, pivotPx: undefined, topPx: undefined };
  for (const layer of [sprite, item]) {
    if (!layer || layer.kind !== kind) continue;
    if (layer.pivot !== undefined) out.pivotPx = layer.pivot;
    if (layer.top !== undefined) out.topPx = layer.top;
    if (layer.stiffness !== undefined) out.stiffness = layer.stiffness;
    if (layer.amplitude !== undefined) out.amplitude = layer.amplitude;
  }
  return out;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Smooth value noise in [0, 1) along a line. */
function noise1(u: number, salt: number): number {
  const iu = Math.floor(u);
  const a = hash01(iu, salt, 73);
  return a + (hash01(iu + 1, salt, 73) - a) * smooth(u - iu);
}

/** One gust: what its number, the seed and the data make of it. */
interface Gust {
  field: WindField;
  k: number;
  /** When it starts, ms. */
  t0: number;
  strength: number;
  /** The way it travels, a unit vector in tiles (x east, y south). */
  dx: number;
  dy: number;
  /** Which way and how much it leans a sprite, which only bends east or west. */
  lean: number;
  /** Where along its direction it is born, tiles. */
  offset: number;
}

// The last few gusts worked out: a frame asks for the same one or two for every plant.
const memo: (Gust | undefined)[] = [undefined, undefined, undefined, undefined];

function gustOf(f: WindField, k: number): Gust {
  const slot = k & 3;
  const m = memo[slot];
  if (m && m.k === k && m.field === f) return m;
  const s = f.seed;
  const angle = f.dir + f.spread * (2 * hash01(k, s, 43) - 1);
  const dx = Math.cos(angle);
  const g: Gust = {
    field: f,
    k,
    t0: (k + f.jitter * hash01(k, s, 41)) * f.everyMs,
    strength: f.strengthMin + (f.strengthMax - f.strengthMin) * hash01(k, s, 42),
    dx,
    dy: Math.sin(angle),
    // A gust straight north or south still leans the crowns: a sprite has no depth.
    lean: (dx < 0 ? -1 : 1) * Math.max(0.5, Math.abs(dx)),
    offset: hash01(k, s, 44) * f.travelTiles,
  };
  memo[slot] = g;
  return g;
}

// What front() says of a gust at a place (two numbers and no garbage: docs/07).
let frontAt = 0;
let frontStrength = 0;

/**
 * Gust `g` at (x, y), tiles: when its front gets there (frontAt, ms) and how hard it blows
 * there (frontStrength). The front is a line across the gust's direction, a little wavy,
 * patchy along its length; it is born `offset` tiles along, picks up, travels
 * `travelTiles` and dies, so it passes every tile exactly once.
 */
function front(f: WindField, g: Gust, x: number, y: number): void {
  const L = f.travelTiles;
  const across = y * g.dx - x * g.dy;
  const wobble = (2 * noise1(across / 9, g.k * 2 + 1) - 1) * FRONT_WOBBLE;
  let pos = (x * g.dx + y * g.dy + wobble + g.offset) % L;
  if (pos < 0) pos += L;
  frontAt = g.t0 + (pos / f.speed) * 1000;
  const edge = Math.min(pos, L - pos) / (L * EDGE);
  const patch = 0.75 + 0.25 * noise1(across / 14, g.k * 2);
  frontStrength = g.strength * patch * (edge >= 1 ? 1 : smooth(edge));
}

/** Whether gust `g` can be moving anything at `ms`. */
const alive = (f: WindField, g: Gust, ms: number): boolean =>
  ms >= g.t0 && ms <= g.t0 + f.crossMs + f.responseMs;

/**
 * Whether any gust is on the map at `ms`: false for the whole calm between two gusts, when
 * nothing has to be worked out for any plant.
 */
export function gustActive(f: WindField, ms: number): boolean {
  const k0 = Math.floor(ms / f.everyMs);
  for (let k = k0; k >= k0 - f.back; k--) if (alive(f, gustOf(f, k), ms)) return true;
  return false;
}

/**
 * How hard the gust blows over world position (x, y), in tiles, at `ms`: 0 in the calm,
 * up to the gust's strength while its body passes (it picks up over `riseMs`, blows for
 * `holdMs` and lets go). The footprints' wind (footprints.ts).
 */
export function gustAt(f: WindField, x: number, y: number, ms: number): number {
  const body = f.riseMs + f.holdMs + FALL * f.riseMs;
  const k0 = Math.floor(ms / f.everyMs);
  let level = 0;
  for (let k = k0; k >= k0 - f.back; k--) {
    const g = gustOf(f, k);
    if (!alive(f, g, ms)) continue;
    front(f, g, x, y);
    const tau = ms - frontAt;
    if (tau <= 0 || tau >= body) continue;
    const shape =
      tau < f.riseMs
        ? smooth(tau / f.riseMs)
        : tau < f.riseMs + f.holdMs
          ? 1
          : 1 - smooth((tau - f.riseMs - f.holdMs) / (FALL * f.riseMs));
    level = Math.max(level, frontStrength * shape);
  }
  return level;
}

/** A gust front on its way to a place (nextGust). */
export interface GustFront {
  /** When it gets there, ms on the wind's clock. */
  at: number;
  /** How hard it blows there. */
  strength: number;
}

/**
 * The first gust front to reach (x, y) after `ms` blowing at least `min` there, or
 * undefined when none of the next dozen does (tests, the E2E and tools: a frame never asks).
 */
export function nextGust(
  f: WindField,
  x: number,
  y: number,
  ms: number,
  min = 0,
): GustFront | undefined {
  const k0 = Math.floor(ms / f.everyMs);
  let best: GustFront | undefined;
  for (let k = k0 - f.back - 1; k <= k0 + 12; k++) {
    // Gusts start in order, so nothing later can get there before one two slots older.
    if (best && k > k0 + 1 && gustOf(f, k).t0 >= best.at) break;
    front(f, gustOf(f, k), x, y);
    if (frontAt <= ms || frontStrength < min) continue;
    if (!best || frontAt < best.at) best = { at: frontAt, strength: frontStrength };
  }
  return best;
}

/**
 * The exposure of a plant: the mean of the surfaces round it (so a coast blows a few tiles
 * inland and a doorway is not a wall of wind), calmed by the trees standing round it.
 * `surfaces` are the known grounds of the tiles round the plant; `trees` how many of the
 * `around` tiles round it hold a tree.
 */
export function exposureOf(
  f: WindField,
  surfaces: readonly (string | undefined)[],
  trees: number,
  around: number,
): number {
  let sum = 0;
  let n = 0;
  for (const s of surfaces) {
    if (s === undefined) continue;
    sum += f.exposure[s] ?? f.open;
    n++;
  }
  const open = n > 0 ? sum / n : f.open;
  const dense = around > 0 ? Math.min(1, trees / (around * FOREST_FULL)) : 0;
  return open * (1 - f.forest * dense);
}

/** A stand counts as dense forest when this share of the tiles round a plant hold a tree. */
export const FOREST_FULL = 0.35;

/**
 * How far from rest the gust that reached a plant `tau` ms ago holds its top, as a share of
 * its full lean: it eases in, leans while the gust blows, and when the gust lets go it
 * swings at its own `period`, each swing smaller, until it stands still, `swings` swings
 * and a half later. Exactly 0 before the front and after the last swing.
 */
export function gustShape(f: WindField, tau: number, period: number): number {
  if (tau <= 0) return 0;
  if (tau < f.riseMs) return smooth(tau / f.riseMs);
  const u = tau - f.riseMs - f.holdMs;
  if (u <= 0) return 1;
  const settle = SETTLE * f.swings * period;
  // A plant that does not swing lets go with the gust.
  if (settle <= 0) return u < FALL * f.riseMs ? 1 - smooth(u / (FALL * f.riseMs)) : 0;
  if (u >= settle) return 0;
  const x = (u * DAMPING * SETTLE) / settle;
  // Leaves the lean with no jerk ((1 + x) e^-x starts flat) and ends on exactly nothing.
  const tail = u > 0.8 * settle ? 1 - smooth((u - 0.8 * settle) / (0.2 * settle)) : 1;
  return (1 + x) * Math.exp(-x) * Math.cos((TAU * u) / period) * tail;
}

/**
 * What a gust front of `strength` (the gust's, by the plant's exposure) that reached the
 * plant on tile (x, y) `tau` ms ago does to its top: sprite px from rest, towards where
 * the gust blows. The gust's shape (gustShape) by what the plant gives (a stiff one only to
 * a strong gust), with a size and a period of its own (its tile's hash).
 */
export function gustLean(
  f: WindField,
  w: PlantWind,
  x: number,
  y: number,
  tau: number,
  strength: number,
): number {
  if (tau <= 0 || strength <= 0 || w.amplitude <= 0) return 0;
  const period = w.periodMs * (1 - 0.35 * w.stiffness) * (0.88 + 0.24 * hash01(x, y, 31));
  const shape = gustShape(f, tau, period);
  if (shape === 0) return 0;
  const response = Math.pow(Math.min(1.5, strength), 1 + 2 * w.stiffness);
  return w.amplitude * (0.85 + 0.3 * hash01(x, y, 33)) * response * shape;
}

/**
 * Where the top of the plant on tile (x, y) is at `ms`: sprite px from rest, positive to
 * the east. Nothing in the calm (but its kind's `drift`, if any); when a gust front
 * reaches it, what that gust does to it (gustLean) by how hard it blows there
 * (`exposure`: the place, and the night). Never past its amplitude.
 */
export function swayAt(
  f: WindField,
  w: PlantWind,
  x: number,
  y: number,
  ms: number,
  exposure: number,
): number {
  if (exposure <= 0) return 0;
  let v = 0;
  if (w.drift > 0)
    v =
      w.drift *
      Math.min(1, exposure) *
      Math.sin((TAU * ms) / (f.driftMs * (0.8 + 0.4 * hash01(x, y, 36))) + hash01(x, y, 37) * TAU);
  if (w.amplitude <= 0) return v;
  const k0 = Math.floor(ms / f.everyMs);
  for (let k = k0; k >= k0 - f.back; k--) {
    const g = gustOf(f, k);
    if (!alive(f, g, ms)) continue;
    front(f, g, x, y);
    v += g.lean * gustLean(f, w, x, y, ms - frontAt, exposure * frontStrength);
  }
  return Math.max(-w.amplitude, Math.min(w.amplitude, v));
}

/**
 * How much of the top's movement a row at height `h` (px over the sprite's bottom edge)
 * takes: nothing up to the pivot, then the square of the way to the top.
 */
export function rowWeight(h: number, pivot: number, top: number): number {
  if (h <= pivot || top <= pivot) return 0;
  const t = Math.min(1, (h - pivot) / (top - pivot));
  return t * t;
}

/** Steps per sprite pixel at a zoom: movements snap to whole screen pixels. */
export function snapSteps(zoom: number): number {
  return Math.max(1, Math.round(zoom));
}

/** The strips a sprite is cut into: the rigid base (if any) and the moving ones over it. */
export interface StripLayout {
  /** Row edges, px from the sprite's top, ascending: strip i is edges[i] .. edges[i + 1]. */
  edges: Float32Array;
  /** rowWeight of each strip (0 for the base). */
  weights: Float32Array;
  /** How many strips, the base included. */
  count: number;
}

/**
 * Cuts a sprite `height` px tall into horizontal strips: one for everything under the
 * pivot, and up to MAX_STRIPS over it, each at least STRIP_PX tall. A strip moves as a
 * whole by the weight of its upper edge, so the top strip takes the full sway.
 */
export function stripLayout(height: number, pivot: number, top: number): StripLayout {
  const H = Math.max(1, Math.round(height));
  const p = Math.min(H - 1, Math.max(0, Math.round(pivot)));
  const t = Math.min(H, Math.max(p + 1, Math.round(top)));
  const moving = Math.max(1, Math.min(MAX_STRIPS, Math.floor((t - p) / STRIP_PX)));
  const base = p > 0 ? 1 : 0;
  const count = moving + base;
  const edges = new Float32Array(count + 1);
  const weights = new Float32Array(count);
  // From the top: the first strip also carries the empty rows over the drawing.
  for (let i = 0; i < moving; i++) {
    const hTop = t - ((t - p) * i) / moving;
    edges[i] = i === 0 ? 0 : H - Math.round(hTop);
    weights[i] = rowWeight(hTop, p, t);
  }
  edges[moving] = H - p;
  if (base) edges[count] = H;
  return { edges, weights, count };
}

/**
 * The offset of every strip, in steps of 1/`steps` sprite px (whole screen pixels at that
 * zoom), written into `out`: the gust and the bend of a passing creature (both px at the
 * top) by the strip's weight. Returns whether any strip changed, so a caller uploads only
 * then: never while the plant stands still.
 */
export function stripOffsets(
  out: Int16Array,
  layout: StripLayout,
  topPx: number,
  steps: number,
): boolean {
  let changed = false;
  for (let i = 0; i < layout.count; i++) {
    const q = Math.round(topPx * (layout.weights[i] as number) * steps);
    if (out[i] !== q) {
      out[i] = q;
      changed = true;
    }
  }
  return changed;
}
