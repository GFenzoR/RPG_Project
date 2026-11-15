import { describe, expect, it } from "vitest";
import { GestureRecognizer, isTouchPointer } from "./gestures.ts";

const cfg = { slopPx: 10, longPressMs: 500 };

describe("GestureRecognizer", () => {
  it("a quick press and release without travel is a tap where it lifted", () => {
    const g = new GestureRecognizer(cfg);
    expect(g.down(1, 100, 100, 0)).toEqual([]);
    expect(g.active).toBe(true);
    expect(g.deadline()).toBe(500);
    expect(g.move(1, 104, 103, 50)).toEqual([]);
    expect(g.up(1, 104, 103, 120)).toEqual([{ kind: "tap", x: 104, y: 103 }]);
    expect(g.active).toBe(false);
    expect(g.deadline()).toBeUndefined();
  });

  it("holding still fires the long press once, at the press point, and the release is silent", () => {
    const g = new GestureRecognizer(cfg);
    g.down(1, 50, 60, 1000);
    expect(g.tick(1499)).toEqual([]);
    expect(g.tick(1500)).toEqual([{ kind: "longPress", x: 50, y: 60 }]);
    expect(g.tick(1600)).toEqual([]);
    expect(g.deadline()).toBeUndefined();
    expect(g.move(1, 80, 90, 1700)).toEqual([]); // no drag after the menu opened
    expect(g.up(1, 80, 90, 1800)).toEqual([]);
    expect(g.active).toBe(false);
  });

  it("a late timer still gives a long press on release, never a tap", () => {
    const g = new GestureRecognizer(cfg);
    g.down(1, 10, 10, 0);
    expect(g.up(1, 12, 11, 700)).toEqual([{ kind: "longPress", x: 10, y: 10 }]);
  });

  it("small wobble while held still counts the time (move past the deadline fires it)", () => {
    const g = new GestureRecognizer(cfg);
    g.down(1, 10, 10, 0);
    expect(g.move(1, 13, 12, 600)).toEqual([{ kind: "longPress", x: 10, y: 10 }]);
  });

  it("travelling past the slop starts a drag from the press point", () => {
    const g = new GestureRecognizer(cfg);
    g.down(7, 20, 20, 0);
    expect(g.move(7, 28, 20, 30)).toEqual([]);
    expect(g.move(7, 35, 20, 60)).toEqual([
      { kind: "dragStart", x: 35, y: 20, startX: 20, startY: 20 },
    ]);
    expect(g.deadline()).toBeUndefined(); // a drag never becomes a long press
    expect(g.tick(5000)).toEqual([]);
    expect(g.move(7, 60, 40, 90)).toEqual([{ kind: "dragMove", x: 60, y: 40 }]);
    expect(g.up(7, 61, 41, 120)).toEqual([{ kind: "dragEnd", x: 61, y: 41 }]);
  });

  it("a second finger turns the press into a pinch with the distance ratio", () => {
    const g = new GestureRecognizer(cfg);
    g.down(1, 0, 0, 0);
    expect(g.down(2, 100, 0, 10)).toEqual([{ kind: "cancel" }, { kind: "pinchStart" }]);
    expect(g.deadline()).toBeUndefined();
    expect(g.move(2, 200, 0, 20)).toEqual([{ kind: "pinch", scale: 2 }]);
    expect(g.up(1, 0, 0, 30)).toEqual([{ kind: "pinchEnd" }]);
    // The finger left on the screen does nothing until it lifts.
    expect(g.move(2, 300, 0, 40)).toEqual([]);
    expect(g.up(2, 300, 0, 50)).toEqual([]);
    expect(g.active).toBe(false);
    // And the next press starts clean.
    g.down(3, 5, 5, 60);
    expect(g.up(3, 5, 5, 80)).toEqual([{ kind: "tap", x: 5, y: 5 }]);
  });

  it("extra fingers during a drag are ignored", () => {
    const g = new GestureRecognizer(cfg);
    g.down(1, 0, 0, 0);
    g.move(1, 50, 0, 10);
    expect(g.down(2, 300, 300, 20)).toEqual([]);
    expect(g.move(2, 310, 300, 30)).toEqual([]);
    expect(g.up(2, 310, 300, 40)).toEqual([]);
    expect(g.up(1, 60, 0, 50)).toEqual([{ kind: "dragEnd", x: 60, y: 0 }]);
  });

  it("pointercancel abandons the press; unknown pointers are ignored", () => {
    const g = new GestureRecognizer(cfg);
    expect(g.move(9, 1, 1, 0)).toEqual([]);
    expect(g.up(9, 1, 1, 0)).toEqual([]);
    expect(g.cancel(9)).toEqual([]);
    g.down(1, 0, 0, 0);
    expect(g.cancel(1)).toEqual([{ kind: "cancel" }]);
    expect(g.active).toBe(false);
    expect(g.tick(1000)).toEqual([]);
  });

  it("reset forgets everything", () => {
    const g = new GestureRecognizer(cfg);
    g.down(1, 0, 0, 0);
    g.reset();
    expect(g.active).toBe(false);
    expect(g.up(1, 0, 0, 10)).toEqual([]);
  });
});

describe("isTouchPointer", () => {
  it("is true for fingers and pens, false for the mouse", () => {
    expect(isTouchPointer("touch")).toBe(true);
    expect(isTouchPointer("pen")).toBe(true);
    expect(isTouchPointer("mouse")).toBe(false);
    expect(isTouchPointer("")).toBe(false);
  });
});
