// The living world's content (data/livingworld/*.yaml, livingworld/README.md) as the client
// uses it: what each ground surface does under a step, and which map items are plants that
// react. Pure and free of Pixi: the client's Vite plugin (client/vite/content.ts, a glue
// file) parses the YAML at build time with parseLivingWorldData (and ambience.yaml with
// parseAmbience, ambience.ts).
import type { AmbienceData } from "./ambience.ts";

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
  /** It also sways gently in the wind when nobody is near. */
  idle: boolean;
  /** Leaves fall from it now and then, and when someone brushes past. */
  leaves: boolean;
  /** On a tile worn into a path (trail wear) it lies flattened (TRAMPLE_SCALE). */
  trample: boolean;
}

export const CRITTER_KINDS = ["bird", "butterfly", "firefly", "fish"] as const;
export type CritterKind = (typeof CRITTER_KINDS)[number];

export interface LivingWorldData {
  surfaces: Partial<Record<Surface, SurfaceRules>>;
  /** By data/items id. */
  plants: Readonly<Record<string, PlantRule>>;
  /** data/livingworld/ambience.yaml (ambience.ts); none: no positional ambience. */
  ambience?: AmbienceData | undefined;
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
 * The client's view of data/livingworld/surfaces.yaml and plants.yaml (already parsed
 * YAML). Lenient: make validate checks the files against their schemas, so anything
 * malformed here is skipped rather than thrown.
 */
export function parseLivingWorldData(surfaces: unknown, plants: unknown): LivingWorldData {
  const out: {
    surfaces: Partial<Record<Surface, SurfaceRules>>;
    plants: Record<string, PlantRule>;
  } = { surfaces: {}, plants: {} };
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
    const reaction = raw["reaction"] === "rustle" ? "rustle" : "bend";
    out.plants[raw["item"]] = {
      reaction,
      idle: raw["idle"] === true,
      leaves: raw["leaves"] === true,
      trample: raw["trample"] === true,
    };
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
