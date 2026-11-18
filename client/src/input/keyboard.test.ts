import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { MovementKeys, isTextField, takesText } from "./keyboard.ts";

describe("MovementKeys", () => {
  it("maps arrows and WASD, the last held key wins", () => {
    const k = new MovementKeys();
    expect(k.down("KeyQ")).toBe(false);
    k.down("ArrowUp");
    k.down("KeyS");
    expect(k.take()).toBe(Direction.SOUTH);
    expect(k.take()).toBe(Direction.SOUTH);
    k.up("KeyS");
    expect(k.take()).toBe(Direction.NORTH);
    k.up("ArrowUp");
    expect(k.take()).toBeUndefined();
  });

  it("walks the diagonal of two perpendicular keys held together", () => {
    const k = new MovementKeys();
    k.down("ArrowUp");
    k.down("KeyD");
    expect(k.take()).toBe(Direction.NORTH_EAST);
    // Up, right and down: the newest (down) with the newest perpendicular one (right).
    k.down("ArrowDown");
    expect(k.take()).toBe(Direction.SOUTH_EAST);
    k.up("KeyD");
    expect(k.take()).toBe(Direction.SOUTH); // up and down cancel no diagonal
    k.down("ArrowLeft");
    expect(k.take()).toBe(Direction.SOUTH_WEST);
    k.clear();
    // A tap of up while right is held: one step north-east.
    k.down("ArrowRight");
    k.down("ArrowUp");
    k.up("ArrowUp");
    expect(k.take()).toBe(Direction.NORTH_EAST);
    expect(k.take()).toBe(Direction.EAST);
  });

  it("keeps a quick tap until it can be used", () => {
    const k = new MovementKeys();
    k.down("KeyS");
    k.up("KeyS");
    expect(k.take()).toBe(Direction.SOUTH);
    expect(k.take()).toBeUndefined();
  });
});

describe("isTextField", () => {
  it("is false for anything that is not an element (no DOM, the window, null)", () => {
    expect(isTextField(null)).toBe(false);
    expect(isTextField({} as EventTarget)).toBe(false);
  });
});

describe("takesText (playtest M3)", () => {
  it("is true for what takes typed text: text inputs, text areas, editable elements", () => {
    expect(takesText({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(takesText({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(takesText({ tagName: "INPUT", type: "password" })).toBe(true);
    expect(takesText({ tagName: "INPUT" })).toBe(true); // no type: a text input
    expect(takesText({ tagName: "TEXTAREA" })).toBe(true);
    expect(takesText({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("is false for a checkbox, a radio, a button, a slider and a select: the arrows walk", () => {
    for (const type of ["checkbox", "radio", "button", "submit", "range", "CHECKBOX"])
      expect(takesText({ tagName: "INPUT", type }), type).toBe(false);
    expect(takesText({ tagName: "SELECT", type: "select-one" })).toBe(false);
    expect(takesText({ tagName: "BUTTON", type: "button" })).toBe(false);
    expect(takesText({ tagName: "DIV", isContentEditable: false })).toBe(false);
  });
});
