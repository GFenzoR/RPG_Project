import { describe, expect, it } from "vitest";
import { entityZIndex } from "@rpg/renderer";
import { DrawnBoxes, HIDDEN_SHARE, coveredShare } from "./creature-hits.ts";

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

describe("DrawnBoxes.forEachHidden (07-combat: the wolf behind the tall player)", () => {
  const hidden = (b: DrawnBoxes): number[] => {
    const out: number[] = [];
    b.forEachHidden((box) => out.push(box.id));
    return out;
  };

  it("finds the creature a tall one in front covers", () => {
    expect(hidden(scene())).toEqual([1]);
  });

  it("leaves alone creatures side by side, diagonal or in front", () => {
    const b = new DrawnBoxes();
    b.add(1, 10, 9, 0, entityZIndex(10, 9));
    b.add(2, 11, 10, 0.6, entityZIndex(11, 10)); // diagonal: no column in common
    b.add(3, 12, 9, 0.2, entityZIndex(12, 9)); // same row, a little taller
    b.add(4, 12, 8, 0, entityZIndex(12, 8)); // behind 3, which covers only 0.2 of it
    expect(hidden(b)).toEqual([]);
  });

  it("says whether a box not in the list (a body falling dead) is covered", () => {
    const b = new DrawnBoxes();
    b.add(2, 10, 10, 0.6, entityZIndex(10, 10)); // the mage, in front
    // A wolf that died on the tile north of it: no longer a creature to click.
    const wolf = { id: 0, x: 10, bottom: 10, top: 9, order: entityZIndex(10, 9) };
    expect(b.covered(wolf)).toBe(true);
    // South of the mage it is in front, and one tile east nothing covers it.
    expect(b.covered({ ...wolf, bottom: 12, top: 11, order: entityZIndex(10, 11) })).toBe(false);
    expect(b.covered({ ...wolf, x: 11, order: entityZIndex(11, 9) })).toBe(false);
  });

  it("measures the covered share of the box behind", () => {
    const [wolf, player] = [scene().at(0), scene().at(1)];
    if (!wolf || !player) throw new Error("no boxes");
    expect(coveredShare(wolf, player)).toBeCloseTo(0.6);
    // The overlap is the same both ways; the draw order says which one is in front.
    expect(coveredShare(player, wolf)).toBeCloseTo(0.6 / 1.6);
    expect(HIDDEN_SHARE).toBeLessThan(0.6);
    const half = { ...player, x: player.x + 0.8 };
    expect(coveredShare(wolf, half)).toBeCloseTo(0.2 * 0.6);
  });
});
