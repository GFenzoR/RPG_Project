import { describe, expect, it } from "vitest";
import { itemContext, mapPress } from "./mouse.ts";

const plain = { shiftKey: false, ctrlKey: false };
const ctrl = { shiftKey: false, ctrlKey: true };
const shift = { shiftKey: true, ctrlKey: false };

describe("mapPress (classic controls)", () => {
  it("uses the tile on a right click, its top item even on a ladder with Ctrl", () => {
    expect(mapPress(2, plain, undefined)).toEqual({ kind: "use", top: false });
    expect(mapPress(2, ctrl, undefined)).toEqual({ kind: "use", top: true });
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

  it("docs/17 UI-6: Shift+right opens the menu, also on a creature", () => {
    expect(mapPress(2, shift, undefined)).toEqual({ kind: "menu" });
    expect(mapPress(2, { shiftKey: true, ctrlKey: true }, 7)).toEqual({ kind: "menu" });
  });

  it("looks on Shift+left, walks or drags on a plain left press, ignores other buttons", () => {
    expect(mapPress(0, shift, 7)).toEqual({ kind: "look" });
    expect(mapPress(0, plain, undefined)).toEqual({ kind: "press" });
    expect(mapPress(0, ctrl, undefined)).toEqual({ kind: "press" });
    expect(mapPress(1, ctrl, undefined)).toEqual({ kind: "none" });
  });
});

describe("mapPress (menu controls, docs/17 UI-6)", () => {
  it("a right click on a tile opens its menu; Ctrl+right still uses at once", () => {
    expect(mapPress(2, plain, undefined, false, "menu")).toEqual({ kind: "menu" });
    expect(mapPress(2, ctrl, undefined, false, "menu")).toEqual({ kind: "use", top: true });
    // A player in a door: the door's menu.
    expect(mapPress(2, plain, 7, true, "menu")).toEqual({ kind: "menu" });
  });

  it("creatures are still attacked (or talked to) with one right click", () => {
    expect(mapPress(2, plain, 7, false, "menu")).toEqual({ kind: "attack", creature: 7 });
    expect(mapPress(2, shift, 7, false, "menu")).toEqual({ kind: "menu" });
  });

  it("the left button does not change", () => {
    expect(mapPress(0, plain, undefined, false, "menu")).toEqual({ kind: "press" });
    expect(mapPress(0, shift, 7, false, "menu")).toEqual({ kind: "look" });
  });
});

describe("itemContext", () => {
  it("follows the mode; Shift opens the menu and Ctrl uses in both", () => {
    expect(itemContext(plain, "menu")).toBe("menu");
    expect(itemContext(plain, "classic")).toBe("use");
    expect(itemContext(ctrl, "menu")).toBe("use");
    expect(itemContext(shift, "classic")).toBe("menu");
    expect(itemContext({ shiftKey: true, ctrlKey: true }, "classic")).toBe("menu");
  });
});
