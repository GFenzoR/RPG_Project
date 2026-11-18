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
// Map, left button: Shift+left looks; a plain press walks there (at once on a tile without
// an item to drag, else on release) or moves the top item if dragged; held (docs/17 MOV-3)
// it walks toward the cursor; a double click (menu mode) does the tile's default action,
// like the classic right click.
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

/**
 * How long a plain left press on the map stays a click (docs/17 MOV-3): held longer, it
 * walks toward the cursor, Diablo 2 style, tile by tile.
 */
export const HOLD_WALK_MS = 200;

/** What a plain left press on a map tile may turn into (the Game decides, per tile). */
export interface PressOptions {
  /** Moving it DRAG_START_PX first drags the tile's top item (it has one to move). */
  drag: boolean;
  /**
   * Held HOLD_WALK_MS (or moved that far first, when there is nothing to drag) it walks
   * toward the cursor.
   */
  hold: boolean;
}

/** What the Game says of a plain left press on a tile (GameCanvasOptions.pressTile). */
export interface PressAnswer extends PressOptions {
  /** The walk there already started on the press: its release is no click. */
  walked: boolean;
}

/**
 * What a plain left press on a map tile can do (Game.pressTile), by docs/17 MOV-3 and
 * MOV-4: while a tool or a spell aims or an item waits to be placed (`aiming`), only a click
 * on release (or a drag); on a tile with an item to move (`movable`), a drag moves it and
 * the click walks on release; else the walk there starts on the press. Held, it walks
 * toward the cursor, but never while aiming.
 */
export function pressAnswer(aiming: boolean, movable: boolean): PressAnswer {
  if (aiming) return { walked: false, drag: true, hold: false };
  if (movable) return { walked: false, drag: true, hold: true };
  return { walked: true, drag: false, hold: true };
}

/** What a pointer event did to a left press: it became a drag or a hold. */
export type PressChange = "drag" | "hold" | undefined;

/**
 * A plain left press on the map, by the rules of docs/17 MOV-3: released before
 * HOLD_WALK_MS without moving `dragPx` it is a click; moved that far first, it drags the
 * top item (`drag`) or, with nothing to drag, walks toward the cursor (`hold`); held still
 * HOLD_WALK_MS it walks toward the cursor too, and moving it then only steers. Pure: the
 * canvas feeds it the pointer's moves and the frame time.
 */
export class LeftPress {
  private state: "down" | "drag" | "hold" | "up" = "down";

  constructor(
    private readonly at: number,
    private readonly x: number,
    private readonly y: number,
    private readonly can: PressOptions,
    private readonly dragPx: number,
  ) {}

  /** Walking toward the cursor: moves steer, the release ends it. */
  get holding(): boolean {
    return this.state === "hold";
  }

  /** The pointer moved to (x, y), in the units of `dragPx`. */
  move(x: number, y: number): PressChange {
    if (this.state !== "down") return undefined;
    if (Math.hypot(x - this.x, y - this.y) < this.dragPx) return undefined;
    if (this.can.drag) {
      this.state = "drag";
      return "drag";
    }
    if (this.can.hold) {
      this.state = "hold";
      return "hold";
    }
    return undefined;
  }

  /** A frame at `now`: the press became a hold once it was held still HOLD_WALK_MS. */
  tick(now: number): PressChange {
    if (this.state !== "down" || !this.can.hold || now - this.at < HOLD_WALK_MS) return undefined;
    this.state = "hold";
    return "hold";
  }

  /** The button went up: "click" (none of the above), "hold" (a hold ends) or undefined. */
  up(): "click" | "hold" | undefined {
    const was = this.state;
    this.state = "up";
    if (was === "down") return "click";
    return was === "hold" ? "hold" : undefined;
  }
}
