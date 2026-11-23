// Footstep sounds by surface (livingworld/README.md): the own player's step names the sound
// events to try, most specific first: step.self.<sound of the surface>, then step.self. The
// client's audio engine plays the first one assets/sounds.yaml maps, so a surface without a
// sound of its own still sounds like a step.
import type { LivingWorldData, Surface } from "./data.ts";

export const STEP_EVENT = "step.self";

export function footstepEvents(surface: Surface | undefined, data: LivingWorldData): string[] {
  if (!surface) return [STEP_EVENT];
  const sound = data.surfaces[surface]?.sound ?? surface;
  return [`${STEP_EVENT}.${sound}`, STEP_EVENT];
}
