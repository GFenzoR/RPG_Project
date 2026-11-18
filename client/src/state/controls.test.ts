import { describe, expect, it } from "vitest";
import { CONTROLS_KEY, loadControls, saveControls } from "./controls.ts";

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as Storage;
}

describe("controls mode (docs/17 UI-6)", () => {
  it("is the menu for a new player and remembers the classic choice", () => {
    const s = memory();
    expect(loadControls(s)).toBe("menu");
    saveControls("classic", s);
    expect(s.getItem(CONTROLS_KEY)).toBe("classic");
    expect(loadControls(s)).toBe("classic");
    saveControls("menu", s);
    expect(loadControls(s)).toBe("menu");
  });

  it("falls back to the menu without storage or when it throws", () => {
    expect(loadControls(undefined)).toBe("menu");
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadControls(broken)).toBe("menu");
    expect(() => saveControls("classic", broken)).not.toThrow();
  });
});
