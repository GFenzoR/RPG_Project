import { describe, expect, it } from "vitest";
import { HOLD_WALK_MS, LeftPress, itemContext, mapPress } from "./mouse.ts";

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

describe("LeftPress (docs/17 MOV-3)", () => {
  const bare = { drag: false, hold: true };
  const item = { drag: true, hold: true };

  it("is a click when let go soon and still", () => {
    const p = new LeftPress(1000, 50, 50, bare, 6);
    expect(p.move(53, 52)).toBeUndefined();
    expect(p.tick(1000 + HOLD_WALK_MS - 1)).toBeUndefined();
    expect(p.up()).toBe("click");
  });

  it("walks toward the cursor once held still HOLD_WALK_MS; then moves only steer", () => {
    const p = new LeftPress(1000, 50, 50, item, 6);
    expect(p.tick(1000 + HOLD_WALK_MS)).toBe("hold");
    expect(p.holding).toBe(true);
    expect(p.tick(1000 + 2 * HOLD_WALK_MS)).toBeUndefined(); // once
    expect(p.move(200, 50)).toBeUndefined(); // no drag of the item any more
    expect(p.up()).toBe("hold");
    expect(p.holding).toBe(false);
  });

  it("drags the top item when moved first, and walks toward the cursor with nothing to drag", () => {
    const a = new LeftPress(1000, 50, 50, item, 6);
    expect(a.move(57, 50)).toBe("drag");
    expect(a.tick(1000 + HOLD_WALK_MS)).toBeUndefined();
    expect(a.up()).toBeUndefined();
    const b = new LeftPress(1000, 50, 50, bare, 6);
    expect(b.move(50, 57)).toBe("hold");
    expect(b.up()).toBe("hold");
  });

  it("never holds while a click must stay a click (an aimed tool, an item to place)", () => {
    const p = new LeftPress(1000, 50, 50, { drag: true, hold: false }, 6);
    expect(p.tick(5000)).toBeUndefined();
    expect(p.up()).toBe("click");
  });
});
