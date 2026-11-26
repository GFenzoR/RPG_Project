// Glue to the living world (livingworld/README.md): the one place in the game client that
// mounts @rpg/living-world. It turns the client's map and content into what the module asks
// for (a surface lookup, the map's plant sprites, atlas textures) and the canvas's creatures
// into steps and into the walk cycle drawn each frame (their footfalls: footprints, dust,
// ripples and the own step's sound). Every effect itself lives in livingworld/client.
import {
  createLivingObjects,
  createLivingWorld,
  footstepEvents,
  gaitOf,
  groundSurfaces,
  newWalkSample,
} from "@rpg/living-world";
import type {
  BodyKind,
  Footfall,
  Gait,
  LivingEvent,
  LivingEventKind,
  LivingObjects,
  LivingPos,
  LivingWorld,
  StepVoice,
  SurfaceLookup,
} from "@rpg/living-world";
import { LivingObjectKind } from "@rpg/protocol";
import type { LivingObjectEvent } from "@rpg/protocol";
import type { Atlas, MapView } from "@rpg/renderer";
import type { Container, Texture } from "pixi.js";
import type { ClientContent, ItemDef } from "../content-types.ts";
import { mapItemId } from "../state/corpse-art.ts";
import type { Pos } from "../state/geometry.ts";

export type {
  Footfall,
  Gait,
  LivingObjects,
  LivingWorld,
  StepVoice,
  WalkSample,
} from "@rpg/living-world";
export { newWalkSample };

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
  sheltered: () => boolean = () => false,
  onFootfall?: (fall: Footfall, events: readonly string[], voice: StepVoice | undefined) => void,
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
      plants: plantSource(view, content.items),
      reduced,
      // The day and night (render/sky.ts): fireflies and a calmer wind at night.
      night,
      // Underground: no wind (the canvas knows the dark floors).
      sheltered,
      onFootfall,
    },
  );
}

/**
 * The map's item sprites as the living world reads them: by the item's id of data/items
 * (oak_tree), which is how data/livingworld names its plants. MapView hands each sprite
 * with its tile key: the item's number, or "<number>@<monster>" for the remains of a
 * monster (state/corpse-art.ts). An item the content does not know has no id ("").
 */
export function plantSource<S>(
  view: {
    readonly version: number;
    forEachItemSprite(fn: (x: number, y: number, key: string, sprite: S) => void): void;
  },
  items: Readonly<Record<number, { id: string } | undefined>>,
): {
  version(): number;
  forEach(fn: (x: number, y: number, itemId: string, sprite: S) => void): void;
} {
  return {
    version: () => view.version,
    forEach: (fn) =>
      view.forEachItemSprite((x, y, key, sprite) =>
        fn(x, y, items[mapItemId(key)]?.id ?? "", sprite),
      ),
  };
}

/**
 * The kind of body a creature has, for its gait (data/livingworld/gaits.yaml `defaults`):
 * a person (a player, or a creature with a look) is a humanoid; a flier flies; the rest
 * are beasts, big ones when the drawing rises more than BIG_BEAST_PX over its tile.
 */
export function bodyKindOf(humanoid: boolean, flying: boolean, lift: number): BodyKind {
  if (flying) return "flying";
  if (humanoid) return "humanoid";
  return lift > BIG_BEAST_PX ? "big_beast" : "beast";
}

/** A beast whose drawing rises more than this (sprite px, CreatureBody.lift) is big. */
export const BIG_BEAST_PX = 40;

/**
 * How a creature walks (livingworld gait.ts): its own gait by content id (a monster's or
 * an NPC's), else its body kind's. Undefined: its feet leave no footfalls (a flier, or a
 * build without data/livingworld/gaits.yaml).
 */
export function creatureGait(
  content: ClientContent,
  contentId: string | undefined,
  body: BodyKind,
): Gait | undefined {
  return gaitOf(content.livingWorld?.gaits, contentId, body);
}

/**
 * Whether the own step's sound comes from the canvas, at each footfall of the walk drawn
 * (GameCanvasOptions.footstep), and not from the server's CreatureMove (audio/cues.ts).
 */
export function footfallSounds(content: ClientContent): boolean {
  return content.livingWorld?.gaits !== undefined;
}

/**
 * Which footfalls kick up the ground's motes (docs/17 MOV-7, render/particles.ts): every
 * one of a body on two feet, every other one of a body on more (a spider would raise a
 * cloud).
 */
export function kicksUp(fall: Footfall): boolean {
  return !fall.sliding && (fall.gait.contacts.length <= 2 || fall.contact % 2 === 0);
}

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
