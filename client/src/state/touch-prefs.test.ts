import { describe, expect, it } from "vitest";
import { loadTouchPad, saveTouchPad } from "./touch-prefs.ts";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
}

describe("touch pad switch", () => {
  it("unset follows the device: shown on touch screens, hidden on PC", () => {
    expect(loadTouchPad(memory(), true)).toBe(true);
    expect(loadTouchPad(memory(), false)).toBe(false);
    expect(loadTouchPad(undefined, true)).toBe(true);
  });

  it("the player's choice wins over the device and survives a reload", () => {
    const s = memory();
    saveTouchPad(false, s);
    expect(loadTouchPad(s, true)).toBe(false);
    saveTouchPad(true, s);
    expect(loadTouchPad(s, false)).toBe(true);
  });

  it("blocked storage falls back to the device default and never throws", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(loadTouchPad(blocked, true)).toBe(true);
    expect(() => saveTouchPad(true, blocked)).not.toThrow();
  });
});
