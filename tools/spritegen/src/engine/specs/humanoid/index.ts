// The engine humanoid's sprites (docs/17 "Humanoides del motor"): one SpriteSpec per layer
// of the paper doll (layers.ts), each the body's rig with the layer's parts. The body is
// drawn as a figure; every other layer is a `layer` spec: only its parts give pixels, and
// the body hides what is behind it, so the client stacks the layers in the order of
// packages/renderer look.ts and gets the figure the model would draw.
import type { ActionSpec, KeySpec, SpriteSpec } from "../../spec.ts";
import { DIRS8, PROJECTION } from "../../style.ts";
import type { ActionName, Dir } from "../../style.ts";
import { chainPitch, layerDefs } from "./layers.ts";
import type { LayerDef } from "./layers.ts";
import {
  ATTACK_KEYS,
  BODY_PARTS,
  bodyParts,
  CAST_KEYS,
  DEATH_KEYS,
  IDLE_KEYS,
  SHOOT_KEYS,
  STRIDE,
  WALK_FRAMES,
  walkKeys,
  walkPerTile,
} from "./skeleton.ts";

export { layerDefs, layerSprite, SHAPES, HAIR_STYLES, BEARDS } from "./layers.ts";
export type { LayerDef, LayerSlot } from "./layers.ts";
export { BUILDS, SEXES, STRIDE, TRUNKS, WALK_FRAMES, walkPerTile } from "./skeleton.ts";
export type { Build, Sex } from "./skeleton.ts";

/**
 * A side view turned this much toward the camera (degrees): the face, both shoulders and
 * what the far hand holds read at 1x, as on the forge echo.
 */
export const HUMANOID_VIEWS: Partial<Record<Dir, number>> = { w: 10, e: -10 };

/** Frames per tile walked, from the stride (skeleton.ts walkKeys): the planted foot holds. */
export const HUMANOID_PER_TILE = walkPerTile(WALK_FRAMES, STRIDE);
/**
 * The frames per tile that would hold the planted foot facing north or south, where the
 * model's depth is foreshortened (rounded): the walk played this until 2026-11-26.
 */
export const HUMANOID_PER_TILE_NS_HOLD =
  Math.round((HUMANOID_PER_TILE / PROJECTION.depth) * 100) / 100;
/**
 * The same facing north or south: one cadence in every direction (owner, 2026-11-26). The
 * map's tile is as tall as it is wide but the model's depth is drawn 0.58 as long, so the
 * foot-holding cadence was 1.73 cycles per tile there, against one walking east: at the
 * same px/s the legs moved 73 % faster and walking north or south read as faster. With one
 * cycle per tile the planted foot slides forward STRIDE × (1 − depth) = 6.8 px per stance
 * facing north or south (2.5 px on a diagonal); seen from the front or the back that reads
 * far less than two speeds do. sprites.yaml carries no per_tile_ns for a humanoid.
 */
export const HUMANOID_PER_TILE_NS = HUMANOID_PER_TILE;

/**
 * The same walking a diagonal (docs/17 ANI-1): a diagonal step slides a tile across and a
 * tile down the screen, as far as a straight step each way, so the cycle plays the frames
 * of both, by distance: hypot(perTile, perTileNS), √2 cycles in a step √2 as long: the
 * cadence of a straight step. packages/renderer anim.ts computes the same from the atlas.
 */
export const HUMANOID_PER_TILE_DIAG = Math.hypot(HUMANOID_PER_TILE, HUMANOID_PER_TILE_NS);

/**
 * The facings an engine humanoid is drawn in (docs/17 ANI-1): all eight, every layer, so
 * the client turns a person to the diagonal it walks or attacks.
 */
export const HUMANOID_DIRS = DIRS8;
/**
 * The facings a humanoid's death is drawn in: the four straight ones (docs/17 "Un cadáver
 * por dirección"). A person facing a diagonal falls east or west (packages/renderer fallDir).
 */
export const HUMANOID_DEATH_DIRS: readonly Dir[] = ["s", "e", "n", "w"];
/**
 * Facing east or west a person falls along the screen's depth, away from the viewer or
 * toward it: lying that way the 3/4 view squeezes it into a lump. It turns as it falls
 * (degrees by the last frame) and ends lying across the tile, its head up and to the east
 * or down and to the west: four bodies that read apart.
 */
const HUMANOID_DEATH_TURN = { e: -45, w: -65 } as const;

/** The ms per frame of the timed actions (ANI-2), as sprites.yaml must repeat them. */
export const HUMANOID_MS = { idle: 500, attack: 90, shoot: 100, cast: 130, death: 150 } as const;

const BODY_KEYS: Record<ActionName, KeySpec[]> = {
  idle: IDLE_KEYS,
  walk: walkKeys(WALK_FRAMES),
  attack: ATTACK_KEYS,
  shoot: SHOOT_KEYS,
  cast: CAST_KEYS,
  death: DEATH_KEYS,
};

/** The rig's actions, with a weapon's grip turned per key (its class's arc). */
function actionsFor(def: LayerDef): Partial<Record<ActionName, ActionSpec>> {
  const keysOf = (action: ActionName): KeySpec[] => {
    const grip = def.grip;
    const name = def.parts[0]?.name;
    if (!grip || !name) return BODY_KEYS[action];
    return BODY_KEYS[action].map((k, i) => ({
      at: k.at,
      pose: {
        ...k.pose,
        [name]: { rot: [0, grip.pitch(action, i, chainPitch(k.pose, grip.hand)), 0] },
      },
    }));
  };
  const dirs = HUMANOID_DIRS;
  return {
    idle: { frames: 2, ms: HUMANOID_MS.idle, keys: keysOf("idle"), dirs },
    walk: { frames: WALK_FRAMES, keys: keysOf("walk"), dirs },
    attack: { frames: 4, ms: HUMANOID_MS.attack, keys: keysOf("attack"), dirs },
    shoot: { frames: 3, ms: HUMANOID_MS.shoot, keys: keysOf("shoot"), dirs },
    cast: { frames: 3, ms: HUMANOID_MS.cast, keys: keysOf("cast"), dirs },
    // It falls the way it faced, one of the four straight ones (HUMANOID_DEATH_DIRS).
    death: {
      frames: 4,
      ms: HUMANOID_MS.death,
      keys: keysOf("death"),
      dirs: HUMANOID_DEATH_DIRS,
      turn: HUMANOID_DEATH_TURN,
    },
  };
}

/** The spec of one layer. */
export function layerSpec(def: LayerDef): SpriteSpec {
  const body = bodyParts(def.build, def.sex);
  return {
    sprite: def.sprite,
    size: "humanoid",
    parts: [...body, ...def.parts],
    actions: actionsFor(def),
    views: HUMANOID_VIEWS,
    perTile: HUMANOID_PER_TILE,
    trim: true,
    ...(def.slot === "body"
      ? {}
      : {
          layer: {
            draw: def.parts.map((p) => p.name),
            occlude: def.occlude ?? BODY_PARTS,
          },
        }),
  };
}

/** Every layer of the paper doll, with its spec. */
export const HUMANOID_LAYERS: readonly (LayerDef & { spec: SpriteSpec })[] = layerDefs().map(
  (def) => ({ ...def, spec: layerSpec(def) }),
);

export const HUMANOID_SPECS: readonly SpriteSpec[] = HUMANOID_LAYERS.map((l) => l.spec);
