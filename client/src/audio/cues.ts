// Which sound event a server message is (T3.7). Pure: the names here are the keys of
// `events:` in assets/sounds.yaml, so what each one sounds like is data. A cue lists names
// from the most specific to the most general ("effect.gather.mining", "effect.gather"):
// the engine plays the first one sounds.yaml maps.
import { MessageKind } from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";
import type { IslandRect, LoopRules, SoundManifest } from "../content-types.ts";
import type { Pos } from "../state/geometry.ts";
import {
  EFFECT_BLOCK,
  EFFECT_BUFF,
  EFFECT_CONJURE,
  EFFECT_ELEMENT,
  EFFECT_GATHER,
  EFFECT_GATHER_MISS,
  EFFECT_HEAL,
  EFFECT_HIT,
  ELEMENTS,
  PROJECTILE_ELEMENT,
} from "../state/world.ts";

export interface Cue {
  events: string[];
  /** The tile it happens on (positional), or undefined for the player's own sounds. */
  pos?: Pos | undefined;
}

/** What the client knows around a message that picks a more specific sound. */
export interface CueContext {
  selfId: number;
  /** tool.use of the last tool used on a tile ("mining"...), for gather sounds. */
  toolUse: string | undefined;
  /** Craft skill of the open station ("smithing", "cooking"), for craft sounds. */
  craft: string | undefined;
}

const EFFECT_NAMES: Record<number, string> = {
  [EFFECT_HIT]: "hit",
  [EFFECT_BLOCK]: "block",
  [EFFECT_HEAL]: "heal",
  [EFFECT_CONJURE]: "conjure",
  [EFFECT_GATHER]: "gather",
  [EFFECT_GATHER_MISS]: "gather_miss",
  [EFFECT_BUFF]: "buff",
};

const pos = (p: { x: number; y: number; z: number } | undefined): Pos | undefined =>
  p ? { x: p.x, y: p.y, z: p.z } : undefined;

/** Event names of an Effect id (docs/05 "Combate", "Magia"). */
export function effectEvents(effectId: number, toolUse: string | undefined): string[] {
  const el = ELEMENTS[effectId - EFFECT_ELEMENT];
  if (el !== undefined && effectId >= EFFECT_ELEMENT) return [`effect.element.${el}`];
  const name = EFFECT_NAMES[effectId];
  if (!name) return [];
  if (effectId === EFFECT_GATHER && toolUse) return [`effect.gather.${toolUse}`, "effect.gather"];
  return [`effect.${name}`];
}

/** The cues of one server message (most messages have none). */
export function cuesOf(msg: ServerMessage["message"], ctx: CueContext): Cue[] {
  switch (msg.case) {
    case "effect": {
      const events = effectEvents(msg.value.effectId, ctx.toolUse);
      return events.length > 0 ? [{ events, pos: pos(msg.value.pos) }] : [];
    }
    case "projectile": {
      const el = ELEMENTS[msg.value.projectileId - PROJECTILE_ELEMENT];
      return el ? [{ events: [`projectile.${el}`], pos: pos(msg.value.from) }] : [];
    }
    case "dialogOpen":
      return [{ events: ["ui.dialog_open"] }];
    case "creatureMove":
      return msg.value.id === ctx.selfId ? [{ events: ["step.self"] }] : [];
    case "chatMessage": {
      const m = msg.value;
      if (m.kind !== MessageKind.SYSTEM || m.body.case !== "localized") return [];
      const key = `message.${m.body.value.key}`;
      const events = [key];
      if (key.startsWith("message.craft.") && ctx.craft) events.unshift(`${key}.${ctx.craft}`);
      if (key.startsWith("message.gather.") && ctx.toolUse) events.unshift(`${key}.${ctx.toolUse}`);
      return [{ events }];
    }
    default:
      return [];
  }
}

/** The island a tile is on (world/world.yaml rectangles), if any. */
export function islandAt(p: Pos, islands: readonly IslandRect[]): string | undefined {
  return islands.find((i) => p.x >= i.x && p.x < i.x + i.w && p.y >= i.y && p.y < i.y + i.h)?.id;
}

/** The loop of a set of rules for where the player stands (undefined = none). */
export function loopFor(
  p: Pos,
  islands: readonly IslandRect[],
  rules: LoopRules,
): string | undefined {
  if (p.z > 7) return rules.underground;
  const island = islandAt(p, islands);
  return island === undefined ? undefined : rules.islands[island];
}

/** A manifest with no sounds (tests, a build without assets/sounds.yaml). */
export const NO_SOUNDS: SoundManifest = {
  sounds: {},
  events: {},
  music: { fadeMs: 0, islands: {}, underground: undefined },
  ambient: { fadeMs: 0, islands: {}, underground: undefined },
};
