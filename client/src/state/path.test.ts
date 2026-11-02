import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { findPath } from "./path.ts";

/** '#' blocks, anything else is passable; outside the grid is unknown (blocked). */
function grid(rows: string[]): (x: number, y: number) => boolean {
  return (x, y) => {
    const ch = rows[y]?.[x];
    return ch !== undefined && ch !== "#";
  };
}

const opts = { diagonalCost: 1.5, maxSteps: 100 };
const at = (x: number, y: number): { x: number; y: number; z: number } => ({ x, y, z: 7 });

describe("findPath", () => {
  it("walks straight and diagonally", () => {
    const g = grid(["....", "....", "...."]);
    expect(findPath(at(0, 0), at(3, 0), g, opts)).toEqual([
      Direction.EAST,
      Direction.EAST,
      Direction.EAST,
    ]);
    expect(findPath(at(0, 0), at(2, 2), g, opts)).toEqual([
      Direction.SOUTH_EAST,
      Direction.SOUTH_EAST,
    ]);
  });

  it("goes around walls without cutting corners", () => {
    const g = grid(["..#", ".##", "..."]);
    const path = findPath(at(0, 0), at(2, 2), g, opts);
    expect(path).toEqual([Direction.SOUTH, Direction.SOUTH, Direction.EAST, Direction.EAST]);
  });

  it("gives up on blocked or unknown destinations and on other floors", () => {
    const g = grid(["..#"]);
    expect(findPath(at(0, 0), at(2, 0), g, opts)).toBeUndefined();
    expect(findPath(at(0, 0), at(9, 9), g, opts)).toBeUndefined();
    expect(findPath(at(0, 0), { x: 1, y: 0, z: 8 }, g, opts)).toBeUndefined();
    expect(findPath(at(0, 0), at(0, 0), g, opts)).toEqual([]);
  });

  it("respects the step limit", () => {
    const g = grid(["......"]);
    expect(findPath(at(0, 0), at(5, 0), g, { ...opts, maxSteps: 3 })).toBeUndefined();
  });
});
