// The living world's content (data/livingworld/*.yaml, livingworld/README.md) as the client
// uses it: what each ground surface does under a step, and which map items are plants that
// react. Pure and free of Pixi: the client's Vite plugin (client/vite/content.ts, a glue
// file) parses the YAML at build time with parseLivingWorldData (and ambience.yaml with
// parseAmbience, ambience.ts).
import type { AmbienceData } from "./ambience.ts";
import { isWindKind, parseSpriteWind, parseWind, parseWindSprites, resolveWind } from "./wind.ts";
import type { PlantWind, SpriteWind, WindData, WindKind } from "./wind.ts";

import { DEFAULT_PRINT_FIELD } from "./footprints.ts";
import type { PrintField, PrintRules } from "./footprints.ts";
import { DEFAULT_STEP_RULES } from "./footsteps.ts";
import type { FootSound, StepRules } from "./footsteps.ts";
import { parseGaits } from "./gait.ts";
import type { GaitData } from "./gait.ts";
import { parseShadows } from "./shadows.ts";
import type { ShadowRules } from "./shadows.ts";

export { shadowOf } from "./shadows.ts";
export type { ObjectShadow, ShadowRules } from "./shadows.ts";
import { parseDayNight } from "./sky.ts";
import type { DayNightData } from "./sky.ts";

/** What a ground is made of: data/items `ground.surface` (common.schema.json "surface"). */
export const SURFACES = [
  "sand",
  "wet_sand",
  "snow",
  "mud",
  "grass",
  "tall_grass",
  "dirt",
  "ash",
  "stone",
  "wood",
  "water_shallow",
  "lava",
] as const;
export type Surface = (typeof SURFACES)[number];

export function isSurface(v: unknown): v is Surface {
  return typeof v === "string" && (SURFACES as readonly string[]).includes(v);
}

/** What a step on a surface leaves behind (data/livingworld/surfaces.yaml). */
export interface SurfaceRules {
  /** A foot leaves its print on it, and what erases it (footprints.ts); absent: no prints. */
  prints?: PrintRules | undefined;
  /** A creature running over it raises a dust cloud. */
  dust: boolean;
  /** A step through it spreads rings on the water. */
  ripple: boolean;
  /** Colour of its footprints and dust (0xrrggbb). */
  tint: number;
  /** The footstep sound's event suffix: step.self.<sound> (assets/sounds.yaml events). */
  sound: string;
  /** Ambient critters it can host by day and at night (critters.ts). */
  critters: readonly CritterKind[];
}

/** How a plant reacts to a creature walking on or next to it. */
export type PlantReaction = "bend" | "rustle";

export interface PlantRule {
  /** bend: the sprite leans away and springs back (grass, reeds, bushes); rustle: a tree shakes. */
  reaction: PlantReaction;
  /** Leaves fall from it now and then, and when someone brushes past. */
  leaves: boolean;
  /** On a tile worn into a path (trail wear) it lies flattened (TRAMPLE_SCALE). */
  trample: boolean;
  /** How it sways in the wind (wind.ts); absent: it never does (`wind: none`, or no wind data). */
  wind?: PlantWind | undefined;
}

/** What a passing creature does to a plant of a wind type when plants.yaml does not say. */
export function defaultReaction(kind: WindKind): PlantReaction {
  return kind === "tree" || kind === "palm" || kind === "dead_tree" || kind === "cactus"
    ? "rustle"
    : "bend";
}

/** The wind files and what joins them to the plants (parseLivingWorldData). */
export interface WindSources {
  /** data/livingworld/wind.yaml. */
  wind: unknown;
  /** data/livingworld/wind_sprites.yaml (written by make spritegen). */
  sprites: unknown;
  /** data/items: item id → its sprite path. */
  itemSprites: Readonly<Record<string, string>>;
}

export const CRITTER_KINDS = ["bird", "butterfly", "firefly", "fish"] as const;
export type CritterKind = (typeof CRITTER_KINDS)[number];

export interface LivingWorldData {
  surfaces: Partial<Record<Surface, SurfaceRules>>;
  /** By data/items id. */
  plants: Readonly<Record<string, PlantRule>>;
  /** data/livingworld/ambience.yaml (ambience.ts); none: no positional ambience. */
  ambience?: AmbienceData | undefined;
  /** data/livingworld/daynight.yaml (sky.ts); absent: no day and night (always noon). */
  dayNight?: DayNightData | undefined;
  /** data/livingworld/wind.yaml (wind.ts); absent: no wind, nothing sways. */
  wind?: WindData | undefined;
  /** data/livingworld/gaits.yaml (gait.ts); absent: no footfalls (no prints, no step beat). */
  gaits?: GaitData | undefined;
  /** data/livingworld/shadows.yaml (shadows.ts); absent: no map object casts a shadow. */
  shadows?: ShadowRules | undefined;
  /** What erases footprints everywhere (surfaces.yaml `prints`); absent: the defaults. */
  prints?: PrintField | undefined;
  /** How steps sound (surfaces.yaml `steps`); absent: every take as recorded. */
  steps?: StepRules | undefined;
}

export const EMPTY_DATA: LivingWorldData = { surfaces: {}, plants: {} };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const DEFAULT_TINT = 0x5a4a36;

function parseTint(v: unknown): number {
  if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) return DEFAULT_TINT;
  return Number.parseInt(v.slice(1), 16);
}

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** `prints` of a surface: true or a mapping; anything else (absent, false): no prints. */
function parsePrintRules(raw: unknown): PrintRules | undefined {
  if (raw === true) return { wind: 0, waves: false, tread: 0 };
  if (!isObj(raw)) return undefined;
  return {
    wind: num(raw["wind"], 0, 0, 10),
    waves: raw["waves"] === true,
    tread: num(raw["tread"], 0, 0, 1),
  };
}

/** The top-level `prints` of surfaces.yaml over the defaults. */
export function parsePrintField(raw: unknown): PrintField {
  const d = DEFAULT_PRINT_FIELD;
  if (!isObj(raw)) return d;
  const w = isObj(raw["waves"]) ? raw["waves"] : {};
  return {
    still: num(raw["still"], d.still, 0, 10),
    fadeMs: num(raw["fade_ms"], d.fadeMs, 1, 60000),
    treadPx: num(raw["tread_px"], d.treadPx, 0, 64),
    waves: {
      periodMs: num(w["period_ms"], d.waves.periodMs, 0, 600000),
      reachTiles: num(w["reach_tiles"], d.waves.reachTiles, 0, 8),
      lagMs: num(w["lag_ms"], d.waves.lagMs, 0, 60000),
      washMs: num(w["wash_ms"], d.waves.washMs, 1, 60000),
    },
  };
}

/** The top-level `steps` of surfaces.yaml over the defaults. */
export function parseStepRules(raw: unknown): StepRules {
  const d = DEFAULT_STEP_RULES;
  if (!isObj(raw)) return d;
  const foot = (v: unknown, f: FootSound): FootSound =>
    isObj(v)
      ? { pitch: num(v["pitch"], f.pitch, -0.5, 0.5), gain: num(v["gain"], f.gain, 0, 2) }
      : f;
  return {
    volume: num(raw["volume"], d.volume, 0, 2),
    jitter: num(raw["jitter"], d.jitter, 0, 0.5),
    left: foot(raw["left"], d.left),
    right: foot(raw["right"], d.right),
  };
}

/**
 * The client's view of data/livingworld/surfaces.yaml, plants.yaml, daynight.yaml and
 * gaits.yaml (already parsed YAML). Lenient: make validate checks the files against their schemas, so anything
 * malformed here is skipped rather than thrown.
 *
 * With `windSources`, every plant gets its wind (wind.ts resolveWind): an item of
 * plants.yaml by its `wind` (a type, a mapping, none) or else by its sprite, and an item
 * that plants.yaml does not list but whose sprite has wind metadata becomes a plant of its
 * type's defaults: a new plant sprite sways with no line written here.
 */
export function parseLivingWorldData(
  surfaces: unknown,
  plants: unknown,
  dayNight?: unknown,
  windSources?: WindSources,
  gaits?: unknown,
  shadows?: unknown,
): LivingWorldData {
  const out: {
    surfaces: Partial<Record<Surface, SurfaceRules>>;
    plants: Record<string, PlantRule>;
    dayNight?: DayNightData;
    wind?: WindData;
    gaits?: GaitData;
    shadows?: ShadowRules;
    prints?: PrintField;
    steps?: StepRules;
  } = { surfaces: {}, plants: {} };
  const sh = parseShadows(shadows);
  if (sh) out.shadows = sh;
  if (isObj(surfaces)) {
    if (surfaces["prints"] !== undefined) out.prints = parsePrintField(surfaces["prints"]);
    if (surfaces["steps"] !== undefined) out.steps = parseStepRules(surfaces["steps"]);
  }
  const g = parseGaits(gaits);
  if (g) out.gaits = g;
  if (dayNight !== undefined && dayNight !== null) out.dayNight = parseDayNight(dayNight);
  const wind = windSources ? parseWind(windSources.wind) : undefined;
  if (wind) out.wind = wind;
  const spriteWinds = windSources ? parseWindSprites(windSources.sprites) : {};
  const windOfSprite = (item: string): SpriteWind | undefined => {
    const sprite = windSources?.itemSprites[item];
    return sprite === undefined ? undefined : spriteWinds[sprite];
  };
  const s = isObj(surfaces) && isObj(surfaces["surfaces"]) ? surfaces["surfaces"] : {};
  for (const [name, raw] of Object.entries(s)) {
    if (!isSurface(name) || !isObj(raw)) continue;
    const prints = parsePrintRules(raw["prints"]);
    const critters = Array.isArray(raw["critters"])
      ? raw["critters"].filter((c): c is CritterKind =>
          (CRITTER_KINDS as readonly unknown[]).includes(c),
        )
      : [];
    out.surfaces[name] = {
      ...(prints ? { prints } : {}),
      dust: raw["dust"] === true,
      ripple: raw["ripple"] === true,
      tint: parseTint(raw["tint"]),
      sound: typeof raw["sound"] === "string" ? raw["sound"] : name,
      critters,
    };
  }
  const list = isObj(plants) && Array.isArray(plants["plants"]) ? plants["plants"] : [];
  for (const raw of list) {
    if (!isObj(raw) || typeof raw["item"] !== "string") continue;
    const item = raw["item"];
    const w = raw["wind"];
    const still = w === "none";
    const own = isWindKind(w) ? { kind: w } : parseSpriteWind(w);
    const resolved = wind && !still ? resolveWind(wind, windOfSprite(item), own) : undefined;
    const said = raw["reaction"];
    // A listed item with neither a reaction nor wind (wind: none alone) is no plant at all.
    if (said !== "bend" && said !== "rustle" && !resolved) continue;
    const reaction: PlantReaction =
      said === "bend" || said === "rustle" ? said : defaultReaction(resolved?.kind ?? "bush");
    const rule: PlantRule = {
      reaction,
      leaves: raw["leaves"] === true,
      trample: raw["trample"] === true,
    };
    if (resolved) rule.wind = resolved;
    out.plants[item] = rule;
  }
  // Plants nobody listed: every item whose sprite says how it takes the wind.
  if (wind && windSources) {
    const listed = new Set<string>();
    for (const raw of list)
      if (isObj(raw) && typeof raw["item"] === "string") listed.add(raw["item"]);
    for (const item of Object.keys(windSources.itemSprites)) {
      if (listed.has(item)) continue;
      const resolved = resolveWind(wind, windOfSprite(item), undefined);
      if (!resolved) continue;
      out.plants[item] = {
        reaction: defaultReaction(resolved.kind),
        leaves: false,
        trample: false,
        wind: resolved,
      };
    }
  }
  return out;
}

/**
 * Ground item number → surface, from the client's items (data/items `ground.surface`, as
 * the Vite plugin gives it). The glue turns it into a SurfaceLookup over its map.
 */
export function groundSurfaces(
  items: Readonly<Record<number, { surface?: string | undefined } | undefined>>,
): ReadonlyMap<number, Surface> {
  const out = new Map<number, Surface>();
  for (const [num, item] of Object.entries(items)) {
    const s = item?.surface;
    if (isSurface(s)) out.set(Number(num), s);
  }
  return out;
}
