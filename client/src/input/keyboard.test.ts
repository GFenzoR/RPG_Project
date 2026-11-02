import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { MovementKeys } from "./keyboard.ts";

describe("MovementKeys", () => {
  it("maps arrows and WASD, the last held key wins", () => {
    const k = new MovementKeys();
    expect(k.down("KeyQ")).toBe(false);
    k.down("ArrowUp");
    k.down("KeyD");
    expect(k.take()).toBe(Direction.EAST);
    expect(k.take()).toBe(Direction.EAST);
    k.up("KeyD");
    expect(k.take()).toBe(Direction.NORTH);
    k.up("ArrowUp");
    expect(k.take()).toBeUndefined();
  });

  it("keeps a quick tap until it can be used", () => {
    const k = new MovementKeys();
    k.down("KeyS");
    k.up("KeyS");
    expect(k.take()).toBe(Direction.SOUTH);
    expect(k.take()).toBeUndefined();
  });
});
