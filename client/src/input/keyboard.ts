// Keyboard movement: arrows and WASD. Kept apart from the game so touch controls can feed
// the same `held()` later without touching the movement code.
import { Direction } from "@rpg/protocol";

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

/** Tracks the movement keys held down; the most recent one wins. */
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
   * The direction to walk now: a tap since the last call, else the last key still held.
   * Call it only when a step can start, so a tap during a step walks right after it.
   */
  take(): Direction | undefined {
    const d = this.tapped ?? this.held_[this.held_.length - 1];
    this.tapped = undefined;
    return d;
  }
}

/** True when the event target is a text field, so typing never moves the character. */
export function typingInField(e: KeyboardEvent): boolean {
  const el = e.target;
  return (
    el instanceof HTMLElement &&
    (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
  );
}
