import { describe, expect, it } from "vitest";
import {
  InputMode,
  controlsShow,
  initialMethod,
  isKeyboardPlay,
  pointerMethod,
} from "./input-mode.ts";

describe("the input method is decided per event", () => {
  it("fingers and pens are touch, anything else a mouse", () => {
    expect(pointerMethod("touch")).toBe("touch");
    expect(pointerMethod("pen")).toBe("touch");
    expect(pointerMethod("mouse")).toBe("mouse");
    expect(pointerMethod("")).toBe("mouse");
  });

  it("a key counts as a keyboard only outside text fields and virtual keyboards", () => {
    expect(isKeyboardPlay({ key: "ArrowUp", editable: false })).toBe(true);
    expect(isKeyboardPlay({ key: "w", editable: false })).toBe(true);
    expect(isKeyboardPlay({ key: "F1", editable: false })).toBe(true);
    expect(isKeyboardPlay({ key: "a", editable: true })).toBe(false); // typing in the chat
    expect(isKeyboardPlay({ key: "Unidentified", editable: false })).toBe(false);
    expect(isKeyboardPlay({ key: "Process", editable: false, composing: true })).toBe(false);
    expect(isKeyboardPlay({ key: "GoBack", editable: false })).toBe(false);
  });

  it("follows the last method whatever the device started as", () => {
    const phone = new InputMode(initialMethod(true));
    expect(phone.method).toBe("touch");
    expect(phone.key({ key: "ArrowLeft", editable: false })).toBe(true);
    expect(phone.method).toBe("keyboard");
    expect(phone.key({ key: "ArrowLeft", editable: false })).toBe(false); // no change
    expect(phone.pointer("mouse")).toBe(true);
    expect(phone.method).toBe("mouse");
    expect(phone.pointer("touch")).toBe(true); // back on the next touch
    expect(phone.method).toBe("touch");
    // The reverse: a touch-screen laptop on the desktop layout.
    const laptop = new InputMode(initialMethod(false));
    expect(laptop.method).toBe("mouse");
    expect(laptop.pointer("touch")).toBe(true);
    expect(laptop.method).toBe("touch");
    expect(laptop.key({ key: "x", editable: true })).toBe(false);
    expect(laptop.method).toBe("touch");
  });

  it("the on-screen controls step back with a mouse or keyboard unless pinned", () => {
    expect(controlsShow("touch", false)).toBe("full");
    expect(controlsShow("mouse", false)).toBe("faded");
    expect(controlsShow("keyboard", false)).toBe("faded");
    expect(controlsShow("mouse", true)).toBe("full");
    expect(controlsShow("keyboard", true)).toBe("full");
  });
});
