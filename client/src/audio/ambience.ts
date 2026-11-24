// Glue to the living world's positional ambience (livingworld/README.md "Ambiente"): the one
// place of the game client's audio that mounts it. It hands the module the map the client
// knows (WorldState.tile), what each item number is (its data/items id and ground surface)
// and whether to keep to fewer voices; the module says which loops sound, and the game
// passes them on to AudioEngine.setAmbience. Every rule of the mix lives in
// livingworld/client/src/ambience.ts and data/livingworld/ambience.yaml.
import { createAmbience } from "@rpg/living-world/ambience";
import type { Ambience, AmbiencePos, AmbienceVoice } from "@rpg/living-world/ambience";
import { groundSurfaces } from "@rpg/living-world/data";
import type { ClientContent } from "../content-types.ts";
import { coarsePointer } from "../state/touch-prefs.ts";

export type { Ambience, AmbienceVoice } from "@rpg/living-world/ambience";

/** How often the game moves the ambience on, ms (the engine ramps between the steps). */
export const AMBIENCE_STEP_MS = 250;

/** The part of the world state the ambience reads: the items of a known tile. */
export interface AmbienceTiles {
  tile(x: number, y: number, z: number): readonly number[] | undefined;
}

/**
 * A phone (coarse pointer) or reduced animations (the player's option or the system's
 * reduced motion) keep to the lite voice cap: fewer loops decoded and mixed at once.
 */
export function liteAmbience(): boolean {
  const root = typeof document === "undefined" ? undefined : document.documentElement;
  const reduced =
    root?.dataset["motion"] === "reduced" ||
    (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  return reduced || coarsePointer();
}

/** Mounts the ambience over the client's map, or nothing without its data. */
export function mountAmbience(
  world: AmbienceTiles,
  content: ClientContent,
  lite: () => boolean = liteAmbience,
): Ambience | undefined {
  const data = content.livingWorld?.ambience;
  if (!data) return undefined;
  const surfaces = groundSurfaces(content.items);
  return createAmbience({
    data,
    tile: (x, y, z) => world.tile(x, y, z),
    itemId: (num) => content.items[num]?.id,
    surface: (num) => surfaces.get(num),
    lite,
  });
}

/** The loops for the player at `pos` (none without an ambience). */
export function ambienceAt(
  ambience: Ambience | undefined,
  now: number,
  pos: AmbiencePos,
): readonly AmbienceVoice[] {
  return ambience ? ambience.update(now, pos) : [];
}
