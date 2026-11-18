// The mouse on the map and on DOM items (desktop; a finger goes through gestures.ts), as
// pure rules so the canvas and the item cells only wire pointer events to them.
//
// Map, right button:
// - on a creature (not the player): attack it (talk to an NPC). Another player standing in
//   a door does not hide it: the door is used (a house's window, the gate); the battle list
//   still targets that player. The same in both controls modes: fights stay one click;
// - elsewhere, by the controls mode (state/controls.ts, docs/17 UI-6): "menu" opens the
//   tile's menu with the card of its item, "classic" uses the tile (a ladder climbs, else
//   its top item);
// - Ctrl+right (no creature there) uses the top item at once in both modes (even on a
//   ladder: a corpse lying there opens); Shift+right opens the menu in both (also on a
//   creature).
// Map, left button: Shift+left looks; a plain press walks on release or moves the top item
// if dragged; a double click (menu mode) does the tile's default action, like the classic
// right click.
import type { ControlsMode } from "../state/controls.ts";

/** What a mouse button pressed on a map tile asks for. */
export type MapPress =
  | { kind: "attack"; creature: number }
  | { kind: "use"; top: boolean }
  | { kind: "menu" }
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
  controls: ControlsMode = "classic",
): MapPress {
  if (button === 2) {
    if (mods.shiftKey) return { kind: "menu" };
    if (creature !== undefined && !playerInDoor) return { kind: "attack", creature };
    if (mods.ctrlKey) return { kind: "use", top: true };
    return controls === "menu" ? { kind: "menu" } : { kind: "use", top: false };
  }
  if (button !== 0) return { kind: "none" };
  return mods.shiftKey ? { kind: "look" } : { kind: "press" };
}

/**
 * What a right click (contextmenu) on a DOM item does: its menu, or use it at once.
 * Ctrl uses and Shift opens the menu in both modes; a plain right click follows the mode.
 */
export function itemContext(
  mods: { readonly shiftKey: boolean; readonly ctrlKey: boolean },
  controls: ControlsMode,
): "menu" | "use" {
  if (mods.shiftKey) return "menu";
  if (mods.ctrlKey) return "use";
  return controls === "menu" ? "menu" : "use";
}
