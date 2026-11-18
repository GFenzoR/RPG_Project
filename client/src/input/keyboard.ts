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

/** Ctrl+arrow only turns, as in Tibia (docs/17 MOV-2): the direction of an arrow's code. */
export const turnKeyDirection = (code: string): Direction | undefined =>
  code.startsWith("Arrow") ? KEYS[code] : undefined;

/** MOV-2: standing still, a tap toward another way shorter than this only turns, ms. */
export const TURN_TAP_MS = 80;

/** What a direction from the keys or the pad does this frame (TurnTap.decide). */
export type TapAnswer = "walk" | "turn" | "wait";

/**
 * MOV-2 (docs/17): standing still, a key or the pad pressed toward a way the player does
 * not face turns it at once, and it walks only if still held TURN_TAP_MS later: a short
 * tap only turns. Facing that way already, or walking, it walks at once (a tap during a
 * step still walks right after it, MovementKeys.take); so does a second tap that comes
 * before the first one's TURN_TAP_MS are up. Fed every frame a step could start.
 */
export class TurnTap {
  /** The direction turned to and held back from walking, and since when. */
  private dir: Direction | undefined;
  private since = 0;

  /**
   * `dir`: what the keys or the pad give now (take(); undefined: nothing held or tapped).
   * `still`: the player stands still facing `facing`. `fresh`: `dir` comes from a press
   * since the last call, not from a key or finger still held (take()'s `fresh`): a new
   * tap, never held back with the one before it. "turn": send the turn now and do not
   * walk; "wait": turned, not held long enough yet; "walk": walk that way. Undefined
   * without a direction.
   */
  decide(
    dir: Direction | undefined,
    still: boolean,
    facing: Direction,
    now: number,
    fresh = false,
  ): TapAnswer | undefined {
    if (dir === undefined) {
      this.dir = undefined; // let go before TURN_TAP_MS: it only turned
      return undefined;
    }
    // The same way still held: it walks once held TURN_TAP_MS. Pressed again (let go and
    // tapped within a frame), it is the second tap: facing that way now, it walks.
    if (this.dir === dir && !fresh) {
      if (now - this.since < TURN_TAP_MS) return "wait";
      this.dir = undefined;
      return "walk";
    }
    this.dir = undefined;
    if (!still || dir === facing) return "walk";
    this.dir = dir;
    this.since = now;
    return "turn";
  }

  /** Forgets a direction held back (the keys were let go with the window, a step pad). */
  clear(): void {
    this.dir = undefined;
  }
}

/**
 * Tracks the movement keys held down: the most recent one wins, and with a perpendicular
 * one also held they walk the diagonal between them (up + right = north-east).
 */
export class MovementKeys {
  private readonly held_: Direction[] = [];
  /** Presses since the last take(): a quick tap still counts (a step, or MOV-2's turn). */
  private tapped: Direction | undefined;
  /** A key went down since the last take() (not the OS auto-repeat of one held). */
  private pressed = false;
  private fresh_ = false;

  down(code: string): boolean {
    const d = keyDirection(code);
    if (d === undefined) return false;
    if (!this.held_.includes(d)) {
      this.held_.push(d);
      this.pressed = true;
    }
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
    this.pressed = false;
  }

  /**
   * Whether the last take() answered a key pressed since the call before it, rather than
   * one still held down (TurnTap.decide: a second tap is not the first one held).
   */
  get fresh(): boolean {
    return this.fresh_;
  }

  /**
   * The direction to walk now: a tap since the last call, else the last key still held;
   * combined with the newest perpendicular key held, their diagonal. Call it only when a
   * step can start, so a tap during a step walks right after it.
   */
  take(): Direction | undefined {
    const d = this.tapped ?? this.held_[this.held_.length - 1];
    this.tapped = undefined;
    this.fresh_ = this.pressed && d !== undefined;
    this.pressed = false;
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
