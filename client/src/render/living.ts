// Glue to the living world (livingworld/README.md): the one place in the game client that
// mounts @rpg/living-world. It turns the client's map and content into what the module asks
// for (a surface lookup, the map's plant sprites, atlas textures) and the canvas's creatures
// into steps. Every effect itself lives in livingworld/client.
import {
  createLivingObjects,
  createLivingWorld,
  footstepEvents,
  groundSurfaces,
} from "@rpg/living-world";
import type {
  CreatureStep,
  LivingEvent,
  LivingEventKind,
  LivingObjects,
  LivingPos,
  LivingWorld,
  SurfaceLookup,
} from "@rpg/living-world";
import { LivingObjectKind } from "@rpg/protocol";
import type { LivingObjectEvent } from "@rpg/protocol";
import type { Atlas, MapView } from "@rpg/renderer";
import type { Container, Texture } from "pixi.js";
import type { ClientContent, ItemDef } from "../content-types.ts";
import type { Pos } from "../state/geometry.ts";

export type { LivingObjects, LivingWorld } from "@rpg/living-world";

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
  night: () => boolean = () => false,
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
      // The day and night (render/sky.ts): fireflies at night.
      night,
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

// Map objects that break, move or open (data/livingworld/objects.yaml).

const KINDS: Partial<Record<LivingObjectKind, LivingEventKind>> = {
  [LivingObjectKind.HIT]: "hit",
  [LivingObjectKind.BREAK]: "break",
  [LivingObjectKind.RESPAWN]: "respawn",
  [LivingObjectKind.PUSH]: "push",
  [LivingObjectKind.GATE_OPEN]: "gate_open",
  [LivingObjectKind.GATE_CLOSE]: "gate_close",
  [LivingObjectKind.FADE]: "fade",
  [LivingObjectKind.RESET]: "reset",
};

const posOf = (p: { x: number; y: number; z: number } | undefined): LivingPos =>
  p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 };

/** The module's event for a LivingObjectEvent, or undefined for an unknown kind. */
export function livingEvent(m: LivingObjectEvent): LivingEvent | undefined {
  const kind = KINDS[m.kind];
  if (!kind) return undefined;
  return {
    kind,
    pos: posOf(m.pos),
    ...(m.to ? { to: posOf(m.to) } : {}),
    itemId: m.itemId,
    effect: m.effect,
    sound: m.sound,
    hpPermille: m.hpPermille,
  };
}

/** What the canvas gives the living objects. */
export interface LivingMount {
  tileSize: number;
  items: Readonly<Record<number, ItemDef>>;
  /** The item ids of a known tile (ground first). */
  tile(x: number, y: number, z: number): readonly number[] | undefined;
  elevationAt(x: number, y: number): number;
  texture(sprite: string): Texture | undefined;
  playSound?(id: string, at: LivingPos): void;
  reducedMotion(): boolean;
}

/** Mounts the living objects' effects on `stage` (the map's overlay, world space). */
export function mountLivingObjects(stage: Container, m: LivingMount): LivingObjects {
  return createLivingObjects(
    stage,
    (x, y, z) => {
      const debris = m.tile(x, y, z)?.find((id) => m.items[id]?.living === "debris");
      const effect = debris === undefined ? undefined : (m.items[debris]?.livingEffect ?? "");
      return {
        elevation: m.elevationAt(x, y),
        ...(effect !== undefined ? { debris: effect } : {}),
      };
    },
    {
      tileSize: m.tileSize,
      texture: (id) => {
        const sprite = m.items[id]?.sprite;
        return sprite ? m.texture(sprite) : undefined;
      },
      ...(m.playSound ? { playSound: m.playSound } : {}),
      reducedMotion: m.reducedMotion,
    },
  );
}
