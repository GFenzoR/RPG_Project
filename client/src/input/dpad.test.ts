import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { DPAD_CELLS, HeldDirection, directionId, dpadDirection } from "./dpad.ts";

describe("dpadDirection", () => {
  it("maps the eight eighths of a turn (screen y grows down)", () => {
    expect(dpadDirection(10, 0, 2)).toBe(Direction.EAST);
    expect(dpadDirection(10, 10, 2)).toBe(Direction.SOUTH_EAST);
    expect(dpadDirection(0, 10, 2)).toBe(Direction.SOUTH);
    expect(dpadDirection(-10, 10, 2)).toBe(Direction.SOUTH_WEST);
    expect(dpadDirection(-10, 0, 2)).toBe(Direction.WEST);
    expect(dpadDirection(-10, -10, 2)).toBe(Direction.NORTH_WEST);
    expect(dpadDirection(0, -10, 2)).toBe(Direction.NORTH);
    expect(dpadDirection(10, -10, 2)).toBe(Direction.NORTH_EAST);
  });

  it("rounds to the nearest eighth and holds nothing inside the dead zone", () => {
    expect(dpadDirection(10, 3, 2)).toBe(Direction.EAST); // ~17°
    expect(dpadDirection(10, 5, 2)).toBe(Direction.SOUTH_EAST); // ~27°
    expect(dpadDirection(1, 1, 2)).toBeUndefined();
    expect(dpadDirection(0, 0, 0)).toBe(Direction.EAST); // no dead zone: atan2(0, 0) = 0
  });

  it("the pad's cells agree with the angle of their place in the grid", () => {
    DPAD_CELLS.forEach((d, i) => {
      const dx = (i % 3) - 1;
      const dy = Math.floor(i / 3) - 1;
      expect(dx === 0 && dy === 0 ? undefined : dpadDirection(dx, dy, 0.5)).toBe(d);
    });
  });
});

describe("directionId", () => {
  it("names every direction for its i18n key", () => {
    const ids = DPAD_CELLS.filter((d) => d !== undefined).map(directionId);
    expect(new Set(ids).size).toBe(8);
    expect(ids).not.toContain("none");
    expect(directionId(Direction.UNSPECIFIED)).toBe("none");
  });
});

describe("HeldDirection", () => {
  it("holding keeps giving the direction, so the loop keeps stepping", () => {
    const h = new HeldDirection();
    expect(h.take()).toBeUndefined();
    h.press(Direction.NORTH);
    expect(h.current).toBe(Direction.NORTH);
    expect(h.take()).toBe(Direction.NORTH);
    expect(h.take()).toBe(Direction.NORTH);
    h.press(Direction.NORTH); // a move over the same cell changes nothing
    expect(h.take()).toBe(Direction.NORTH);
    h.release();
    expect(h.take()).toBeUndefined();
  });

  it("a quick tap still walks one step after the release", () => {
    const h = new HeldDirection();
    h.press(Direction.EAST);
    h.release();
    expect(h.take()).toBe(Direction.EAST);
    expect(h.take()).toBeUndefined();
  });

  it("tells a new press from a finger still held (TurnTap: a second tap walks)", () => {
    const h = new HeldDirection();
    h.press(Direction.EAST);
    expect(h.take()).toBe(Direction.EAST);
    expect(h.fresh).toBe(true);
    expect(h.take()).toBe(Direction.EAST);
    expect(h.fresh).toBe(false);
    h.release();
    h.press(Direction.EAST); // lifted and tapped again between two frames
    h.release();
    expect(h.take()).toBe(Direction.EAST);
    expect(h.fresh).toBe(true);
  });

  it("sliding to another direction is taken at the next step", () => {
    const h = new HeldDirection();
    h.press(Direction.EAST);
    expect(h.take()).toBe(Direction.EAST);
    h.press(Direction.SOUTH);
    h.press(Direction.WEST);
    h.release();
    expect(h.take()).toBe(Direction.WEST);
    expect(h.take()).toBeUndefined();
  });

  it("tap is one step from the keyboard; clear forgets all", () => {
    const h = new HeldDirection();
    h.tap(Direction.SOUTH);
    expect(h.take()).toBe(Direction.SOUTH);
    expect(h.take()).toBeUndefined();
    h.press(Direction.NORTH);
    h.clear();
    expect(h.take()).toBeUndefined();
  });
});
