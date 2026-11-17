import { describe, expect, it } from "vitest";
import { mapPress } from "./mouse.ts";

const plain = { shiftKey: false, ctrlKey: false };
const ctrl = { shiftKey: false, ctrlKey: true };
const shift = { shiftKey: true, ctrlKey: false };

describe("mapPress", () => {
  it("uses the tile on a right click, its top item even on a ladder with Ctrl", () => {
    expect(mapPress(2, plain, undefined)).toEqual({ kind: "use", top: false });
    expect(mapPress(2, ctrl, undefined)).toEqual({ kind: "use", top: true });
    // Shift does not change a right click.
    expect(mapPress(2, { shiftKey: true, ctrlKey: true }, undefined)).toEqual({
      kind: "use",
      top: true,
    });
  });

  it("attacks (or talks to) the creature on the tile, Ctrl or not", () => {
    expect(mapPress(2, plain, 7)).toEqual({ kind: "attack", creature: 7 });
    expect(mapPress(2, ctrl, 7)).toEqual({ kind: "attack", creature: 7 });
  });

  it("uses a door another player stands in instead of attacking him (playtest m5)", () => {
    expect(mapPress(2, plain, 7, true)).toEqual({ kind: "use", top: false });
    expect(mapPress(2, ctrl, 7, true)).toEqual({ kind: "use", top: true });
    expect(mapPress(2, plain, 7, false)).toEqual({ kind: "attack", creature: 7 });
  });

  it("looks on Shift+left, walks or drags on a plain left press, ignores other buttons", () => {
    expect(mapPress(0, shift, 7)).toEqual({ kind: "look" });
    expect(mapPress(0, plain, undefined)).toEqual({ kind: "press" });
    expect(mapPress(0, ctrl, undefined)).toEqual({ kind: "press" });
    expect(mapPress(1, ctrl, undefined)).toEqual({ kind: "none" });
  });
});
