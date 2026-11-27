import { describe, expect, it } from "vitest";
import { nearestTarget, nextTarget } from "./targeting.ts";

const m = (id: number): { id: number; monster: boolean } => ({ id, monster: true });
const p = (id: number): { id: number; monster: boolean } => ({ id, monster: false });

describe("targeting buttons", () => {
  it("attack nearest takes the closest monster, never a player", () => {
    expect(nearestTarget([p(9), m(3), m(4)])).toBe(3);
    expect(nearestTarget([p(9)])).toBeUndefined();
    expect(nearestTarget([])).toBeUndefined();
  });

  it("next target walks the list round and round", () => {
    const list = [m(1), p(9), m(2), m(3)];
    expect(nextTarget(list, undefined)).toBe(1);
    expect(nextTarget(list, 1)).toBe(2);
    expect(nextTarget(list, 2)).toBe(3);
    expect(nextTarget(list, 3)).toBe(1);
  });

  it("starts from the nearest when the target is gone or is a player", () => {
    expect(nextTarget([m(1), m(2)], 77)).toBe(1);
    expect(nextTarget([p(9), m(2)], 9)).toBe(2);
  });

  it("has nothing to change to with one monster already targeted, or none", () => {
    expect(nextTarget([m(1)], 1)).toBeUndefined();
    expect(nextTarget([p(9)], undefined)).toBeUndefined();
  });
});
