import { describe, expect, it } from "vitest";
import { PointerOwner, TAP_CLICK_GUARD_MS, TapGuard, isPalm } from "./pointers.ts";

describe("PointerOwner", () => {
  it("follows the first finger and ignores the others until it lifts", () => {
    const o = new PointerOwner();
    expect(o.claim(1)).toBe(true);
    expect(o.claim(2)).toBe(false); // a second contact on the pad
    expect(o.owns(1)).toBe(true);
    expect(o.owns(2)).toBe(false);
    expect(o.release(2)).toBe(false); // lifting it does not stop the walk
    expect(o.held).toBe(true);
    expect(o.release(1)).toBe(true);
    expect(o.held).toBe(false);
    expect(o.claim(2)).toBe(true);
  });

  it("two controls each keep their own finger", () => {
    const pad = new PointerOwner();
    const button = new PointerOwner();
    expect(pad.claim(1)).toBe(true);
    expect(button.claim(2)).toBe(true);
    expect(button.release(2)).toBe(true);
    expect(pad.owns(1)).toBe(true); // the walking thumb is still down
  });

  it("reset frees it", () => {
    const o = new PointerOwner();
    o.claim(7);
    o.reset();
    expect(o.claim(8)).toBe(true);
  });
});

describe("isPalm", () => {
  it("takes a fingertip and an unmeasured contact, rejects a palm", () => {
    expect(isPalm(1, 1)).toBe(false);
    expect(isPalm(0, 0)).toBe(false);
    expect(isPalm(28, 34)).toBe(false);
    expect(isPalm(40, 95)).toBe(true);
    expect(isPalm(80, 20)).toBe(true);
  });
});

describe("TapGuard", () => {
  it("a mouse click or a keyboard activation acts", () => {
    const g = new TapGuard();
    expect(g.clickCounts(100)).toBe(true);
    expect(g.clickCounts(120)).toBe(true);
  });

  it("the click after a finger already acted is dropped, once", () => {
    const g = new TapGuard();
    g.touchUp(1000);
    expect(g.clickCounts(1010)).toBe(false);
    expect(g.clickCounts(1020)).toBe(true); // a real click right after
  });

  it("a second thumb that gets no click leaves nothing behind", () => {
    const g = new TapGuard();
    g.touchUp(1000); // no click follows a secondary finger
    expect(g.clickCounts(1000 + TAP_CLICK_GUARD_MS)).toBe(true);
  });
});
