// The on-screen direction pad (T5.6): which direction a finger on the pad points at, and the
// direction held, read by the game loop like the movement keys. Holding repeats the step at
// the walking speed (the loop takes a direction only when a step can start); a quick tap
// still walks one step.
import { Direction } from "@rpg/protocol";

/** The pad's cells, row by row (top-left to bottom-right); undefined = the centre. */
export const DPAD_CELLS: readonly (Direction | undefined)[] = [
  Direction.NORTH_WEST,
  Direction.NORTH,
  Direction.NORTH_EAST,
  Direction.WEST,
  undefined,
  Direction.EAST,
  Direction.SOUTH_WEST,
  Direction.SOUTH,
  Direction.SOUTH_EAST,
];

/** i18n id of each direction (client.touch.dpad.<id>). */
export function directionId(d: Direction): string {
  switch (d) {
    case Direction.NORTH:
      return "north";
    case Direction.NORTH_EAST:
      return "north_east";
    case Direction.EAST:
      return "east";
    case Direction.SOUTH_EAST:
      return "south_east";
    case Direction.SOUTH:
      return "south";
    case Direction.SOUTH_WEST:
      return "south_west";
    case Direction.WEST:
      return "west";
    case Direction.NORTH_WEST:
      return "north_west";
    default:
      return "none";
  }
}

const OCTANTS: readonly Direction[] = [
  Direction.EAST,
  Direction.SOUTH_EAST,
  Direction.SOUTH,
  Direction.SOUTH_WEST,
  Direction.WEST,
  Direction.NORTH_WEST,
  Direction.NORTH,
  Direction.NORTH_EAST,
];

/**
 * The direction of a finger at (dx, dy) from the pad's centre (screen axes: y grows down),
 * by eighths of a turn; inside `deadzone` none. Sliding the finger changes direction.
 */
export function dpadDirection(dx: number, dy: number, deadzone: number): Direction | undefined {
  if (Math.hypot(dx, dy) < deadzone) return undefined;
  const turn = Math.atan2(dy, dx) / (2 * Math.PI); // -0.5..0.5, 0 = east, 0.25 = south
  const i = Math.round(turn * 8 + 8) % 8;
  return OCTANTS[i];
}

/** The direction the pad holds: like MovementKeys, a tap is kept until it is taken. */
export class HeldDirection {
  private held: Direction | undefined;
  private tapped: Direction | undefined;

  press(d: Direction): void {
    if (this.held !== d) this.tapped = d;
    this.held = d;
  }

  release(): void {
    this.held = undefined;
  }

  /** One step (keyboard activation of a pad button). */
  tap(d: Direction): void {
    this.tapped = d;
  }

  clear(): void {
    this.held = undefined;
    this.tapped = undefined;
  }

  get current(): Direction | undefined {
    return this.held;
  }

  /** The direction to walk now: a press since the last call, else the one still held. */
  take(): Direction | undefined {
    const d = this.tapped ?? this.held;
    this.tapped = undefined;
    return d;
  }
}
