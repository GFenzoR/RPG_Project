// Keyboard movement: arrows and WASD. Kept apart from the game so touch controls can feed
// the same `held()` later without touching the movement code.
import { Direction } from "@rpg/protocol";
import { combine } from "../state/motion.ts";

const KEYS: Record<string, Direction> = {
  ArrowUp: Direction.NORTH,
  ArrowDown: Direction.SOUTH,
  ArrowLeft: Direction.WEST,
  ArrowRight: Direction.EAST,
  KeyW: Direction.NORTH,
  KeyS: Direction.SOUTH,
  KeyA: Direction.WEST,
  KeyD: Direction.EAST,
};

/** Direction of a KeyboardEvent.code, or undefined if it is not a movement key. */
export const keyDirection = (code: string): Direction | undefined => KEYS[code];

/**
 * Tracks the movement keys held down: the most recent one wins, and with a perpendicular
 * one also held they walk the diagonal between them (up + right = north-east).
 */
export class MovementKeys {
  private readonly held_: Direction[] = [];
  /** Presses since the last take(): a quick tap still walks one step. */
  private tapped: Direction | undefined;

  down(code: string): boolean {
    const d = keyDirection(code);
    if (d === undefined) return false;
    if (!this.held_.includes(d)) this.held_.push(d);
    this.tapped = d;
    return true;
  }

  up(code: string): void {
    const d = keyDirection(code);
    const i = d === undefined ? -1 : this.held_.indexOf(d);
    if (i >= 0) this.held_.splice(i, 1);
  }

  clear(): void {
    this.held_.length = 0;
    this.tapped = undefined;
  }

  /**
   * The direction to walk now: a tap since the last call, else the last key still held;
   * combined with the newest perpendicular key held, their diagonal. Call it only when a
   * step can start, so a tap during a step walks right after it.
   */
  take(): Direction | undefined {
    const d = this.tapped ?? this.held_[this.held_.length - 1];
    this.tapped = undefined;
    if (d === undefined) return undefined;
    for (let i = this.held_.length - 1; i >= 0; i--) {
      const other = this.held_[i];
      const diagonal = other === undefined ? undefined : combine(d, other);
      if (diagonal !== undefined) return diagonal;
    }
    return d;
  }
}

/** True when the event target is a text field, so typing never moves the character. */
export function typingInField(e: KeyboardEvent): boolean {
  return isTextField(e.target);
}

/**
 * Input types that take no typed text: a checkbox, a radio, a button, a slider... With the
 * focus on one (after clicking it), the arrows and WASD still walk.
 */
const NO_TEXT_INPUTS = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "range",
  "color",
  "file",
]);

/**
 * True for an element that takes typed text: a text input, a text area or editable text.
 * A select is not one: after picking with the mouse it keeps the focus, and the arrows
 * changed the option (the fight stance, the language) instead of walking. With the
 * keyboard it still opens with Alt+Down, Space or Enter.
 */
export function takesText(el: {
  readonly tagName: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
}): boolean {
  if (el.isContentEditable === true) return true;
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && !NO_TEXT_INPUTS.has((el.type ?? "text").toLowerCase());
}

/** True for an element that takes typed text (takesText), so typing never walks. */
export function isTextField(el: EventTarget | null): boolean {
  return typeof HTMLElement !== "undefined" && el instanceof HTMLElement && takesText(el);
}
