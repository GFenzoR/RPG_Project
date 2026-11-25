import { describe, expect, it } from "vitest";
import { Direction } from "@rpg/protocol";
import { delta } from "./geometry.ts";
import { findPath } from "./path.ts";
import { climbable, movesOnStep, pathPassable, portalKey, usedBare, useMode } from "./portals.ts";
import type { Portals } from "./portals.ts";

const portals: Portals = {
  [portalKey(5, 2, 7)]: "stairs",
  [portalKey(8, 2, 7)]: "hole",
  [portalKey(12, 1, 7)]: "teleport",
  [portalKey(2, 5, 8)]: "ladder",
  [portalKey(10, 5, 8)]: "rope_spot",
  [portalKey(12, 6, 7)]: "boat",
};

describe("portals", () => {
  it("knows which tiles move the player on a step", () => {
    expect(movesOnStep(portals, 5, 2, 7)).toBe(true);
    expect(movesOnStep(portals, 8, 2, 7)).toBe(true);
    expect(movesOnStep(portals, 12, 1, 7)).toBe(true);
    expect(movesOnStep(portals, 5, 2, 8)).toBe(false); // another floor
    expect(movesOnStep(portals, 2, 5, 8)).toBe(false); // a ladder is used
    expect(movesOnStep(portals, 10, 5, 8)).toBe(false); // a rope spot needs a rope
    expect(movesOnStep(portals, 12, 6, 7)).toBe(false); // a boat portal moves nobody
    expect(movesOnStep(undefined, 5, 2, 7)).toBe(false);
  });

  it("uses the ground of a bare ladder or rope spot", () => {
    expect(usedBare(portals, 2, 5, 8)).toBe(true);
    expect(usedBare(portals, 10, 5, 8)).toBe(true);
    expect(usedBare(portals, 5, 2, 7)).toBe(false);
    expect(usedBare(undefined, 2, 5, 8)).toBe(false);
  });

  it("climbs a ladder whatever lies on it, nothing else", () => {
    expect(climbable(portals, 2, 5, 8)).toBe(true);
    expect(climbable(portals, 10, 5, 8)).toBe(false); // a rope spot needs a rope
    expect(climbable(portals, 5, 2, 7)).toBe(false);
    expect(climbable(undefined, 2, 5, 8)).toBe(false);
  });

  it("climbs a ladder on a right click, uses its top item on a Ctrl+right click", () => {
    // usedBare is what Game.usesGround says for a portal (a house door says it too).
    const bare = (x: number, y: number, z: number): boolean => usedBare(portals, x, y, z);
    expect(useMode(portals, bare(2, 5, 8), 2, 5, 8, false)).toBe("first"); // climbs
    // Ctrl+right click (or the touch menu's "Use"/"Open"): the corpse on top; a bare
    // ladder still climbs by its ground ("bare").
    expect(useMode(portals, bare(2, 5, 8), 2, 5, 8, true)).toBe("bare");
    expect(useMode(portals, bare(10, 5, 8), 10, 5, 8, false)).toBe("bare"); // a rope spot
    expect(useMode(portals, bare(10, 5, 8), 10, 5, 8, true)).toBe("bare");
    expect(useMode(portals, true, 3, 3, 7, false)).toBe("bare"); // a house door
    expect(useMode(portals, bare(5, 2, 7), 5, 2, 7, false)).toBe("never"); // stairs
    expect(useMode(undefined, false, 2, 5, 8, false)).toBe("never");
  });

  it("walks round stairs on the way, onto them only as the goal", () => {
    // A row from 3,2 to 7,2 with the stairs at 5,2: the path goes round them.
    const free = (x: number, y: number): boolean => x >= 0 && x <= 9 && y >= 0 && y <= 4;
    const from = { x: 3, y: 2, z: 7 };
    const to = { x: 7, y: 2, z: 7 };
    const steps = findPath(from, to, pathPassable(portals, to, free), {
      diagonalCost: 1.414,
      maxSteps: 100,
    });
    expect(steps).toBeDefined();
    let x = from.x;
    let y = from.y;
    for (const d of steps ?? []) {
      const [dx, dy] = delta(d);
      x += dx;
      y += dy;
      expect(`${x},${y}`).not.toBe("5,2");
    }
    expect(`${x},${y}`).toBe("7,2");

    const stairs = { x: 5, y: 2, z: 7 };
    expect(
      findPath(from, stairs, pathPassable(portals, stairs, free), {
        diagonalCost: 1.414,
        maxSteps: 100,
      }),
    ).toEqual([Direction.EAST, Direction.EAST]);
  });
});
