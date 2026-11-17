// The mouse on the map (desktop; a finger goes through gestures.ts), as a pure rule so the
// canvas only wires pointer events to it:
// - right: attack the creature on the tile (talk to an NPC), or use the tile (a ladder
//   climbs, else its top item); Ctrl+right uses the top item even on a ladder (a corpse
//   lying there opens). Another player standing in a door does not hide it: the door is
//   used (a house's window, the gate); the battle list still targets that player;
// - Shift+left looks; a plain left press walks on release or moves the top item if dragged.

/** What a mouse button pressed on a map tile asks for. */
export type MapPress =
  | { kind: "attack"; creature: number }
  | { kind: "use"; top: boolean }
  | { kind: "look" }
  | { kind: "press" }
  | { kind: "none" };

/**
 * What pressing `button` (PointerEvent.button: 0 left, 2 right) with the modifiers of `mods`
 * does on a tile; `creature` is the id of the creature on it, unless none or the player;
 * `playerInDoor`: that creature is another player and the tile is a door (a map door or
 * the door of a house).
 */
export function mapPress(
  button: number,
  mods: { readonly shiftKey: boolean; readonly ctrlKey: boolean },
  creature: number | undefined,
  playerInDoor = false,
): MapPress {
  if (button === 2)
    return creature !== undefined && !playerInDoor
      ? { kind: "attack", creature }
      : { kind: "use", top: mods.ctrlKey };
  if (button !== 0) return { kind: "none" };
  return mods.shiftKey ? { kind: "look" } : { kind: "press" };
}
