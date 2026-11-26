import { describe, expect, it } from "vitest";
import { entityZIndex } from "@rpg/renderer";
import { DrawnBoxes } from "./creature-hits.ts";

/** A wolf (no rise) at (10, 9) and a tall player (rises 0.6 tiles) right south of it. */
function scene(): DrawnBoxes {
  const b = new DrawnBoxes();
  b.add(1, 10, 9, 0, entityZIndex(10, 9));
  b.add(2, 10, 10, 0.6, entityZIndex(10, 10));
  return b;
}

describe("DrawnBoxes.pick (ART-2)", () => {
  it("picks a tall creature by its head, on the tile above its own", () => {
    const b = new DrawnBoxes();
    b.add(7, 4, 5, 0.5, entityZIndex(4, 5));
    expect(b.pick(4.5, 4.7)?.id).toBe(7); // the head, in tile (4, 4)
    expect(b.pick(4.5, 5.9)?.id).toBe(7); // the feet
    expect(b.pick(4.5, 4.4)).toBeUndefined(); // above the head
    expect(b.pick(5.1, 5.5)).toBeUndefined(); // beside it
  });

  it("tries the boxes from the one drawn last; the own player is left out", () => {
    const b = scene();
    // The player's head covers the bottom of the wolf's tile: it is drawn later and wins…
    expect(b.pick(10.5, 9.8)?.id).toBe(2);
    // …unless it is the own player: then the wolf behind it.
    expect(b.pick(10.5, 9.8, 2)?.id).toBe(1);
    expect(b.pick(10.5, 9.2)?.id).toBe(1);
  });

  it("leaves a head out of a tile with something of its own to use", () => {
    // A tall player at (10, 10) south of a door at (10, 9): the door keeps its click.
    const b = new DrawnBoxes();
    b.add(2, 10, 10, 0.6, entityZIndex(10, 10));
    const asked: string[] = [];
    const door = (x: number, y: number): boolean => {
      asked.push(`${x},${y}`);
      return x === 10 && y === 9;
    };
    expect(b.pick(10.5, 9.7, undefined, door)).toBeUndefined(); // the head, over the door
    expect(asked).toEqual(["10,9"]);
    expect(b.pick(10.5, 10.5, undefined, door)?.id).toBe(2); // its own tile: never asked
    expect(asked).toEqual(["10,9"]);
    // Bare ground above: the head picks it, as without the question.
    expect(b.pick(10.5, 9.7, undefined, () => false)?.id).toBe(2);
    // The wolf on the door tile, behind the player's head: the wolf, not the head.
    const s = scene();
    expect(s.pick(10.5, 9.8, undefined, (x, y) => x === 10 && y === 9)?.id).toBe(1);
  });

  it("follows the drawn position of a creature between two tiles", () => {
    const b = new DrawnBoxes();
    b.add(3, 6.5, 2, 0, entityZIndex(7, 2));
    expect(b.pick(7.2, 2.5)?.id).toBe(3);
    expect(b.pick(6.2, 2.5)).toBeUndefined();
  });

  it("reuses its boxes frame after frame", () => {
    const b = scene();
    const first = b.at(0);
    b.reset();
    expect(b.pick(10.5, 9.5)).toBeUndefined();
    b.add(9, 0, 0, 0, 0);
    expect(b.at(0)).toBe(first);
    expect(b.at(0)?.id).toBe(9);
    expect(b.at(1)).toBeUndefined();
  });
});
