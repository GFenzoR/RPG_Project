import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { STICK_DEADZONE, stickState } from "./joystick.ts";

const R = 50;

describe("stickState", () => {
  it("holds each of the eight directions past the dead zone", () => {
    const at = (deg: number): Direction | undefined => {
      const a = (deg * Math.PI) / 180;
      return stickState(Math.cos(a) * 40, Math.sin(a) * 40, R).dir;
    };
    expect(at(0)).toBe(Direction.EAST);
    expect(at(45)).toBe(Direction.SOUTH_EAST);
    expect(at(90)).toBe(Direction.SOUTH);
    expect(at(135)).toBe(Direction.SOUTH_WEST);
    expect(at(180)).toBe(Direction.WEST);
    expect(at(225)).toBe(Direction.NORTH_WEST);
    expect(at(270)).toBe(Direction.NORTH);
    expect(at(315)).toBe(Direction.NORTH_EAST);
  });

  it("holds nothing inside the dead zone", () => {
    const edge = R * STICK_DEADZONE;
    expect(stickState(edge - 1, 0, R).dir).toBeUndefined();
    expect(stickState(0, -(edge - 1), R).dir).toBeUndefined();
    expect(stickState(edge + 1, 0, R).dir).toBe(Direction.EAST);
    expect(stickState(0, 0, R)).toEqual({ dir: undefined, x: 0, y: 0 });
  });

  it("keeps the knob inside the radius and under the finger before that", () => {
    expect(stickState(30, 0, R)).toMatchObject({ x: 30, y: 0 });
    const far = stickState(300, 400, R);
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(R);
    expect(far.x / far.y).toBeCloseTo(300 / 400);
    expect(far.dir).toBe(Direction.SOUTH_EAST);
  });

  it("does not flicker on the border between two directions", () => {
    // 22.5 degrees is the border between east and south-east.
    const at = (deg: number, prev?: Direction): Direction | undefined => {
      const a = (deg * Math.PI) / 180;
      return stickState(Math.cos(a) * 40, Math.sin(a) * 40, R, prev).dir;
    };
    expect(at(24)).toBe(Direction.SOUTH_EAST);
    expect(at(24, Direction.EAST)).toBe(Direction.EAST); // still east: inside the hysteresis
    expect(at(21, Direction.SOUTH_EAST)).toBe(Direction.SOUTH_EAST);
    expect(at(35, Direction.EAST)).toBe(Direction.SOUTH_EAST); // well past it
    expect(at(200, Direction.EAST)).toBe(Direction.WEST);
  });

  it("is safe with a stick that has no size yet", () => {
    expect(stickState(10, 10, 0).dir).toBeUndefined();
  });
});
