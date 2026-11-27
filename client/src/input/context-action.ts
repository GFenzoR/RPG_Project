// The context action button of the touch cluster (lote 21, docs/15 "Botones de acción"):
// one button that does what makes sense on the tile the player faces (talk, attack, climb,
// open, loot, read, break, push, use), found by pure rules over what the client knows of
// the tiles around. The Game then sends the same intention a click would (UseItem,
// SetTarget, NpcTalk, PushObject): the server validates it like any other.
import { defaultAction } from "./actions.ts";
import type { TileFacts } from "./actions.ts";

/** What the button does (its icon and i18n label: client.touch.context.<kind>). */
export type ContextKind =
  "talk" | "attack" | "climb" | "open" | "loot" | "read" | "break" | "push" | "use";

/** One tile the button may act on. */
export interface ContextTile {
  facts: TileFacts;
  /** The living-world object on it (livingworld/README.md), if any. */
  living?: "breakable" | "pushable" | undefined;
  /** Its top item is the remains of a creature: "open" reads as "loot". */
  corpse?: boolean | undefined;
  /** Straight ahead of the player (not a diagonal, not the own tile): a push can go there. */
  ahead?: boolean | undefined;
}

export interface ContextChoice {
  kind: ContextKind;
  /** Which of the given tiles it acts on. */
  index: number;
}

/** What the button would do on one tile, or undefined when there is nothing to do there. */
export function tileContext(t: ContextTile): ContextKind | undefined {
  const c = t.facts.creature;
  // Never a player, like the Attack button (input/targeting.ts): a thumb cannot start a PvP
  // fight by accident. A player is attacked by tapping it; what lies under one is still used.
  if (c && !c.self && !c.player) return c.npc ? "talk" : "attack";
  if (t.living === "pushable") return t.ahead ? "push" : undefined;
  if (t.living === "breakable") return "break";
  const kind = defaultAction(t.facts);
  switch (kind) {
    case "climb":
    case "read":
    case "use":
      return kind;
    case "open":
      return t.corpse ? "loot" : "open";
    default:
      // Picking up, eating or equipping what lies on the ground is the item's own menu
      // (a tap or a long press on it), never a blind press of the button.
      return undefined;
  }
}

/**
 * The action of the button: the first of the tiles, in the order given, with something to
 * do. The caller lists the tile faced first, then the own tile (a ladder or a corpse under
 * the feet), then the other tiles around.
 */
export function contextAction(tiles: readonly ContextTile[]): ContextChoice | undefined {
  for (let index = 0; index < tiles.length; index++) {
    const t = tiles[index];
    const kind = t && tileContext(t);
    if (kind) return { kind, index };
  }
  return undefined;
}
