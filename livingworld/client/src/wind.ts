// The wind (livingworld/README.md "Viento"): trees, bushes and every other plant of the map
// move with it. Pure and free of Pixi: numbers only, so the client, the tests and the sway
// preview of tools/spritegen share the same motion.
//
//   field   gusts are a smooth noise of the world position that travels along the wind
//           direction at the wind speed: neighbouring trees move one after another, never
//           each on its own dice
//   plant   a slow main sway (a lean downwind plus a swing at the plant's own period) and a
//           fast, tiny flutter of the canopy; both scaled by its kind (data/livingworld/wind.yaml)
//   sprite  the base stays planted: a row moves by the square of its height over the pivot
//           (where the trunk ends), in whole screen pixels, so the art never blurs
//
// Deterministic: only the tile, the clock and the data.
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
/** The flutter is always under a pixel. */
export const MAX_FLUTTER = 0.95;
/** A sprite is cut into at most this many moving strips (wind-mesh.ts). */
export const MAX_STRIPS = 16;
/** A moving strip is at least this tall, sprite px. */
export const STRIP_PX = 2;
/** One flutter of the leaves, ms (each plant a little off it). */
export const FLUTTER_MS = 430;
/** Share of the main sway that is a steady lean downwind; the rest swings. */
const LEAN = 0.45;
const SWING = 0.55;
const TAU = Math.PI * 2;

/** How a kind of plant takes the wind (data/livingworld/wind.yaml `kinds.<kind>`). */
export interface WindKindRule {
  /** 0 limp .. 1 rigid: a stiff plant only moves in a strong gust, and swings faster. */
  stiffness: number;
  /** How far its top moves in a full gust, sprite px. */
  amplitude: number;
  /** The fast shimmer of its canopy rows, sprite px (under 1). */
  flutter: number;
  /** One swing of the main sway, ms. */
  periodMs: number;
  /** Where it starts to move when its sprite does not say, share of the sprite's height. */
  pivot: number;
}

/** The wind over the map (data/livingworld/wind.yaml `field`). */
export interface WindField {
  /** The way the gusts travel, a unit vector in tiles (x east, y south). */
  dirX: number;
  dirY: number;
  /** How fast they travel, tiles per second. */
  speed: number;
  /** The length of a gust along the wind, tiles. */
  gustTiles: number;
  /** Share of the strength that blows between gusts, 0..1. */
  calm: number;
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
  flutter?: number | undefined;
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
  flutter: 0.4,
  periodMs: 2400,
  pivot: 0.2,
};

function parseKind(raw: unknown): WindKindRule {
  const r = isObj(raw) ? raw : {};
  return {
    stiffness: num(r["stiffness"], FALLBACK_KIND.stiffness, 0, 1),
    amplitude: num(r["amplitude"], FALLBACK_KIND.amplitude, 0, MAX_AMPLITUDE),
    flutter: num(r["flutter"], FALLBACK_KIND.flutter, 0, MAX_FLUTTER),
    periodMs: num(r["period_ms"], FALLBACK_KIND.periodMs, 300, 20000),
    pivot: num(r["pivot"], FALLBACK_KIND.pivot, 0, 0.95),
  };
}

/**
 * data/livingworld/wind.yaml as the client uses it, or undefined without the file (no wind:
 * nothing sways). Lenient like the rest of the living world's data: make validate checks the
 * file against its schema.
 */
export function parseWind(raw: unknown): WindData | undefined {
  if (!isObj(raw)) return undefined;
  const f = isObj(raw["field"]) ? raw["field"] : {};
  const deg = num(f["direction"], 20, -3600, 3600);
  const exposure: Record<string, number> = {};
  if (isObj(f["exposure"]))
    for (const [surface, v] of Object.entries(f["exposure"])) exposure[surface] = num(v, 1, 0, 2);
  const kinds = {} as Record<WindKind, WindKindRule>;
  const k = isObj(raw["kinds"]) ? raw["kinds"] : {};
  for (const kind of WIND_KINDS) kinds[kind] = parseKind(k[kind]);
  return {
    field: {
      dirX: Math.cos((deg * Math.PI) / 180),
      dirY: Math.sin((deg * Math.PI) / 180),
      speed: num(f["speed"], 2.5, 0, 20),
      gustTiles: num(f["gust_tiles"], 9, 2, 64),
      calm: num(f["calm"], 0.25, 0, 1),
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
    flutter: opt("flutter", 0, MAX_FLUTTER),
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
    if (layer.flutter !== undefined) out.flutter = layer.flutter;
  }
  return out;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Smooth value noise in [0, 1) over the plane. */
function noise2(u: number, v: number, salt: number): number {
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const fu = smooth(u - iu);
  const fv = smooth(v - iv);
  const a = hash01(iu, iv, salt);
  const b = hash01(iu + 1, iv, salt);
  const c = hash01(iu, iv + 1, salt);
  const d = hash01(iu + 1, iv + 1, salt);
  return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
}

/**
 * The gust over world position (x, y), in tiles, at `ms`: 0 (a lull) .. 1 (a full gust).
 * A pattern frozen in the air that travels with the wind: what blows here now blows
 * `speed` tiles downwind a second later.
 */
export function gustAt(f: WindField, x: number, y: number, ms: number): number {
  const travelled = (f.speed * ms) / 1000;
  const along = (x * f.dirX + y * f.dirY - travelled) / f.gustTiles;
  // A gust front is wider than it is long.
  const across = (y * f.dirX - x * f.dirY) / (f.gustTiles * 1.8);
  const n = 0.65 * noise2(along, across, 71) + 0.35 * noise2(along * 2.3, across * 2.3, 72);
  // More contrast than plain noise: real lulls and real gusts.
  return smooth(Math.min(1, Math.max(0, (n - 0.22) / 0.56)));
}

/** How hard the wind blows on a plant: the gust over the calm floor, by its exposure. */
export function strengthAt(f: WindField, gust: number, exposure: number): number {
  return exposure * (f.calm + (1 - f.calm) * gust);
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
 * The main sway of the plant on tile (x, y) at `ms`: how far its top is from rest, sprite
 * px, positive to the east. A lean downwind that comes and goes with the gusts, plus a swing
 * at the plant's own period and phase (its tile's hash), never past its amplitude.
 */
export function swayAt(
  f: WindField,
  w: PlantWind,
  x: number,
  y: number,
  ms: number,
  exposure: number,
): number {
  return swayOf(f, w, x, y, ms, strengthAt(f, gustAt(f, x, y, ms), exposure));
}

/** swayAt for a wind strength already worked out (strengthAt). */
export function swayOf(
  f: WindField,
  w: PlantWind,
  x: number,
  y: number,
  ms: number,
  strength: number,
): number {
  if (strength <= 0 || w.amplitude <= 0) return 0;
  // A stiff plant ignores a breeze and gives only to a gust.
  const response = Math.pow(Math.min(1.5, strength), 1 + 2 * w.stiffness);
  const period = w.periodMs * (1 - 0.35 * w.stiffness) * (0.88 + 0.24 * hash01(x, y, 31));
  const phase = hash01(x, y, 32) * TAU;
  // Two swings that never line up: it does not tick like a metronome.
  const swing =
    0.72 * Math.sin((TAU * ms) / period + phase) +
    0.28 * Math.sin((TAU * ms) / (period * 0.381) + phase * 1.7);
  const own = 0.85 + 0.3 * hash01(x, y, 33);
  const v = w.amplitude * own * response * (LEAN * f.dirX + SWING * swing);
  return Math.max(-w.amplitude, Math.min(w.amplitude, v));
}

/** The flutter's size at a wind strength, sprite px (under 1): none in still air. */
export function flutterOf(w: PlantWind, strength: number): number {
  if (strength <= 0 || w.flutter <= 0) return 0;
  return Math.min(MAX_FLUTTER, w.flutter * Math.min(1, 0.35 + strength));
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
  /** Which strips flutter (the moving ones), by their weight. */
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
 * zoom), written into `out`: the main sway and the bend of a passing creature (both px at
 * the top) by the strip's weight, plus the flutter, a wave running up the canopy. Returns
 * whether any strip changed, so a caller uploads only then.
 */
export function stripOffsets(
  out: Int16Array,
  layout: StripLayout,
  topPx: number,
  flutterPx: number,
  flutterPhase: number,
  steps: number,
): boolean {
  let changed = false;
  for (let i = 0; i < layout.count; i++) {
    const w = layout.weights[i] as number;
    let v = 0;
    if (w > 0) {
      v = topPx * w;
      // The flutter fades in over the lower canopy: the rows next to the trunk stay.
      if (flutterPx > 0) v += flutterPx * Math.min(1, w * 3) * Math.sin(flutterPhase + i * 2.1);
    }
    const q = Math.round(v * steps);
    if (out[i] !== q) {
      out[i] = q;
      changed = true;
    }
  }
  return changed;
}

/** The phase of a plant's flutter at `ms` (each plant a little faster or slower). */
export function flutterPhase(x: number, y: number, ms: number): number {
  return (TAU * ms) / (FLUTTER_MS * (0.8 + 0.4 * hash01(x, y, 34))) + hash01(x, y, 35) * TAU;
}
