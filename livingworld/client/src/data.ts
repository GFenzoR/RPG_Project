// The living world's content (data/livingworld/*.yaml, livingworld/README.md) as the client
// uses it: what each ground surface does under a step, and which map items are plants that
// react. Pure and free of Pixi: the client's Vite plugin (client/vite/content.ts, a glue
// file) parses the YAML at build time with parseLivingWorldData (and ambience.yaml with
// parseAmbience, ambience.ts).
import type { AmbienceData } from "./ambience.ts";
import { isWindKind, parseSpriteWind, parseWind, parseWindSprites, resolveWind } from "./wind.ts";
import type { PlantWind, SpriteWind, WindData, WindKind } from "./wind.ts";

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
  /** How long a footprint lasts in still air, ms; 0: the surface keeps none. */
  footprintMs: number;
  /** How much faster the wind wears footprints away in a gust (0: no wind). */
  wind: number;
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
}

export const EMPTY_DATA: LivingWorldData = { surfaces: {}, plants: {} };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const DEFAULT_TINT = 0x5a4a36;

function parseTint(v: unknown): number {
  if (typeof v !== "string" || !/^#[0-9a-f]{6}$/i.test(v)) return DEFAULT_TINT;
  return Number.parseInt(v.slice(1), 16);
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
  } = { surfaces: {}, plants: {} };
  const sh = parseShadows(shadows);
  if (sh) out.shadows = sh;
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
    const fp = raw["footprints"];
    const wind = raw["wind"];
    const critters = Array.isArray(raw["critters"])
      ? raw["critters"].filter((c): c is CritterKind =>
          (CRITTER_KINDS as readonly unknown[]).includes(c),
        )
      : [];
    out.surfaces[name] = {
      footprintMs: typeof fp === "number" && fp > 0 ? fp : 0,
      wind: typeof wind === "number" && wind > 0 ? wind : 0,
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
