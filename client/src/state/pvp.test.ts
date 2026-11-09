import { describe, expect, it } from "vitest";
import { Skull } from "@rpg/protocol";
import { loadSafeMode, saveSafeMode, skullColor, skullId } from "./pvp.ts";

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

describe("safe mode", () => {
  it("is on by default and remembers the choice", () => {
    const s = memory();
    expect(loadSafeMode(s)).toBe(true);
    expect(loadSafeMode(undefined)).toBe(true);
    saveSafeMode(false, s);
    expect(loadSafeMode(s)).toBe(false);
    saveSafeMode(true, s);
    expect(loadSafeMode(s)).toBe(true);
  });

  it("survives a storage that throws", () => {
    const bad = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadSafeMode(bad)).toBe(true);
    expect(() => saveSafeMode(false, bad)).not.toThrow();
  });
});

describe("skulls", () => {
  it("have an id and a colour only when set", () => {
    expect(skullId(Skull.UNSPECIFIED)).toBeUndefined();
    expect(skullColor(Skull.UNSPECIFIED)).toBe(0);
    const ids = [Skull.AGGRESSOR, Skull.MURDERER, Skull.OUTLAW].map(skullId);
    expect(ids).toEqual(["aggressor", "murderer", "outlaw"]);
    const colors = new Set([Skull.AGGRESSOR, Skull.MURDERER, Skull.OUTLAW].map(skullColor));
    expect(colors.size).toBe(3);
  });
});
