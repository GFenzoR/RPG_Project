// The virtual analog stick (lote 21, docs/15 "Controles táctiles"): where the knob is drawn
// and which of the eight directions it holds. The world moves by tiles, so the stick is
// read as a direction, never as a speed: past the dead zone it walks, like the pad. Pure:
// ui/TouchStick.tsx feeds it the finger's offset from where the stick was grabbed.
import type { Direction } from "@rpg/protocol";
import { dpadDirection } from "./dpad.ts";

/** Share of the stick's radius around its centre where the finger holds no direction. */
export const STICK_DEADZONE = 0.28;

/**
 * How far past the edge of its eighth of a turn the finger must go before the direction
 * changes, in turns (1/8 is a whole sector): a thumb resting on a border between two
 * directions does not flicker between them.
 */
export const STICK_HYSTERESIS = 0.02;

export interface StickState {
  /** The direction held, or undefined inside the dead zone. */
  dir: Direction | undefined;
  /** Where the knob is drawn, from the centre: the finger, kept inside the radius. */
  x: number;
  y: number;
}

const OCTANT_TURN = 1 / 8;

/** The angle of (dx, dy) in turns, 0..1 (0 = east, 0.25 = south: screen axes). */
function turnOf(dx: number, dy: number): number {
  const t = Math.atan2(dy, dx) / (2 * Math.PI);
  return t < 0 ? t + 1 : t;
}

/** The smallest distance between two angles, in turns (0..0.5). */
function turnGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return d > 0.5 ? 1 - d : d;
}

/** The middle of a direction's sector, in turns: found by asking dpadDirection. */
function sectorTurn(d: Direction): number | undefined {
  for (let i = 0; i < 8; i++) {
    const a = i * OCTANT_TURN * 2 * Math.PI;
    if (dpadDirection(Math.cos(a), Math.sin(a), 0) === d) return i * OCTANT_TURN;
  }
  return undefined;
}

/**
 * The stick with the finger at (dx, dy) from its centre. `prev` is the direction held
 * before: it is kept while the finger stays within its sector plus the hysteresis.
 */
export function stickState(
  dx: number,
  dy: number,
  radius: number,
  prev?: Direction,
  deadzone: number = STICK_DEADZONE,
): StickState {
  const len = Math.hypot(dx, dy);
  const k = len > radius && len > 0 ? radius / len : 1;
  const x = dx * k;
  const y = dy * k;
  if (radius <= 0 || len < radius * deadzone) return { dir: undefined, x, y };
  let dir = dpadDirection(dx, dy, 0);
  if (prev !== undefined && dir !== prev) {
    const centre = sectorTurn(prev);
    const within = OCTANT_TURN / 2 + STICK_HYSTERESIS;
    if (centre !== undefined && turnGap(turnOf(dx, dy), centre) <= within) dir = prev;
  }
  return { dir, x, y };
}
