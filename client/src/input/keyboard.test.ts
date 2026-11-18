import { Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import {
  MovementKeys,
  TURN_TAP_MS,
  TurnTap,
  isTextField,
  takesText,
  turnKeyDirection,
} from "./keyboard.ts";

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

describe("TurnTap (MOV-2)", () => {
  const E = Direction.EAST;
  const S = Direction.SOUTH;

  it("standing still, a short tap toward another way only turns", () => {
    const t = new TurnTap();
    expect(t.decide(E, true, S, 1000)).toBe("turn");
    // Held: it waits, then walks once held TURN_TAP_MS (it faces east by then).
    expect(t.decide(E, true, E, 1016)).toBe("wait");
    expect(t.decide(E, true, E, 1000 + TURN_TAP_MS - 1)).toBe("wait");
    expect(t.decide(E, true, E, 1000 + TURN_TAP_MS)).toBe("walk");
    // A tap let go before that: it turned and does not walk.
    const u = new TurnTap();
    expect(u.decide(E, true, S, 0)).toBe("turn");
    expect(u.decide(undefined, true, E, 30)).toBeUndefined();
    // Tapped again (now facing that way): one step.
    expect(u.decide(E, true, E, 200)).toBe("walk");
  });

  it("walks at once facing that way already, or while walking", () => {
    const t = new TurnTap();
    expect(t.decide(S, true, S, 0)).toBe("walk");
    expect(t.decide(E, false, S, 10)).toBe("walk"); // during a step: MOV-2's buffer
    expect(t.decide(undefined, true, S, 20)).toBeUndefined();
  });

  it("starts over for another way, and forgets with clear()", () => {
    const t = new TurnTap();
    expect(t.decide(E, true, S, 0)).toBe("turn");
    // A second key makes the diagonal: a new way, turned to at once.
    expect(t.decide(Direction.NORTH_EAST, true, E, 40)).toBe("turn");
    expect(t.decide(Direction.NORTH_EAST, true, Direction.NORTH_EAST, 100)).toBe("wait");
    t.clear();
    expect(t.decide(Direction.NORTH_EAST, true, Direction.NORTH_EAST, 110)).toBe("walk");
  });

  it("turns with Ctrl and the arrows only, never with WASD", () => {
    expect(turnKeyDirection("ArrowLeft")).toBe(Direction.WEST);
    expect(turnKeyDirection("KeyA")).toBeUndefined();
    expect(turnKeyDirection("Enter")).toBeUndefined();
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
