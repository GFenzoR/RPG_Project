// Positions and directions shared by the state, input and render code.
import { Direction } from "@rpg/protocol";

export interface Pos {
  x: number;
  y: number;
  z: number;
}

export const samePos = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

const DELTAS: Record<number, readonly [number, number]> = {
  [Direction.NORTH]: [0, -1],
  [Direction.NORTH_EAST]: [1, -1],
  [Direction.EAST]: [1, 0],
  [Direction.SOUTH_EAST]: [1, 1],
  [Direction.SOUTH]: [0, 1],
  [Direction.SOUTH_WEST]: [-1, 1],
  [Direction.WEST]: [-1, 0],
  [Direction.NORTH_WEST]: [-1, -1],
};

/** Tile delta of a step; [0, 0] for UNSPECIFIED. */
export const delta = (d: Direction): readonly [number, number] => DELTAS[d] ?? [0, 0];

export const step = (p: Pos, d: Direction): Pos => {
  const [dx, dy] = delta(d);
  return { x: p.x + dx, y: p.y + dy, z: p.z };
};

export const isDiagonal = (d: Direction): boolean => {
  const [dx, dy] = delta(d);
  return dx !== 0 && dy !== 0;
};

/** Direction of a one-tile step from a to b, or UNSPECIFIED. */
export function directionTo(a: Pos, b: Pos): Direction {
  const dx = Math.sign(b.x - a.x);
  const dy = Math.sign(b.y - a.y);
  for (const [d, [x, y]] of Object.entries(DELTAS)) if (x === dx && y === dy) return Number(d);
  return Direction.UNSPECIFIED;
}
