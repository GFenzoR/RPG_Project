import { describe, expect, it } from "vitest";
import { loadReducedMotion, saveReducedMotion } from "./ui-prefs.ts";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

describe("reduced animations", () => {
  it("is off until chosen, and remembered", () => {
    const s = memory();
    expect(loadReducedMotion(s)).toBe(false);
    saveReducedMotion(true, s);
    expect(loadReducedMotion(s)).toBe(true);
    saveReducedMotion(false, s);
    expect(loadReducedMotion(s)).toBe(false);
  });

  it("survives a blocked storage", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadReducedMotion(blocked)).toBe(false);
    expect(() => saveReducedMotion(true, blocked)).not.toThrow();
    expect(loadReducedMotion(undefined)).toBe(false);
  });
});
