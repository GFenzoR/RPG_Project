import { describe, expect, it } from "vitest";
import { PointerOwner, isPalm } from "./pointers.ts";

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
