// Glue to the living world (livingworld/README.md): the one place in the game client that
// mounts @rpg/living-world. It turns the client's map and content into what the module asks
// for (a surface lookup, the map's plant sprites, atlas textures) and the canvas's creatures
// into steps. Every effect itself lives in livingworld/client.
import { createLivingWorld, footstepEvents, groundSurfaces } from "@rpg/living-world";
import type { CreatureStep, LivingWorld, SurfaceLookup } from "@rpg/living-world";
import type { Atlas, MapView } from "@rpg/renderer";
import type { ClientContent } from "../content-types.ts";
import type { Pos } from "../state/geometry.ts";

export type { LivingWorld } from "@rpg/living-world";

/** The part of the world state the living world reads: the ground of a tile. */
export interface TileReader {
  tile(x: number, y: number, z: number): readonly number[] | undefined;
}

/** What ground surface each tile has: data/items `ground.surface` of its ground item. */
export function surfaceLookup(world: TileReader, content: ClientContent): SurfaceLookup {
  const table = groundSurfaces(content.items);
  return (x, y, z) => {
    const ground = world.tile(x, y, z)?.[0];
    return ground === undefined ? undefined : table.get(ground);
  };
}

/**
 * The sound events of the own player's step onto `to`: step.self.<surface sound> first,
 * then step.self (audio/cues.ts plays the first one assets/sounds.yaml maps).
 */
export function stepSoundEvents(world: TileReader, content: ClientContent): (to: Pos) => string[] {
  const at = surfaceLookup(world, content);
  const data = content.livingWorld;
  return (to) =>
    data ? footstepEvents(at(to.x, to.y, to.z), data) : footstepEvents(undefined, EMPTY);
}

const EMPTY = { surfaces: {}, plants: {} };

/** Whether an atlas sprite is real art (a placeholder square would read worse than none). */
const isArt = (atlas: Atlas, name: string): boolean => {
  const origin = atlas.index.sprites[name]?.origin;
  return origin !== undefined && origin !== "auto" && origin !== "placeholder";
};

/** Mounts the living world over `view`'s map, or nothing without its data. */
export function mountLivingWorld(
  view: MapView,
  world: TileReader,
  content: ClientContent,
  atlas: Atlas,
  reduced: () => boolean,
): LivingWorld | undefined {
  const data = content.livingWorld;
  if (!data) return undefined;
  return createLivingWorld(
    { ground: view.groundOverlay, air: view.overlay },
    surfaceLookup(world, content),
    {
      tileSize: atlas.tileSize,
      data,
      texture: (name) => (isArt(atlas, name) ? atlas.texture(name) : undefined),
      plants: {
        version: () => view.version,
        forEach: (fn) => view.forEachItemSprite(fn),
      },
      reduced,
      // No day and night yet: fireflies wait for one (docs/14).
      night: () => false,
    },
  );
}

/**
 * Which marks a creature's feet leave: a humanoid (a look) its feet, a beast paws, big
 * ones for a body whose drawing rises more than BIG_BEAST_PX over its tile; a flier none.
 */
export function printOf(hasLook: boolean, flying: boolean, lift: number): CreatureStep["print"] {
  if (flying) return "none";
  if (hasLook) return "feet";
  return lift > BIG_BEAST_PX ? "big_paw" : "paw";
}

/** A beast whose drawing rises more than this (sprite px, CreatureBody.lift) is big. */
export const BIG_BEAST_PX = 40;
