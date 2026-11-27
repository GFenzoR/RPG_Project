import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOUCH_PREFS,
  TOUCH_BUTTON_PX,
  loadAppMode,
  loadEffects,
  loadTouchPrefs,
  lowEndDevice,
  saveAppMode,
  saveTouchPrefs,
} from "./touch-controls.ts";
import type { TouchPrefs } from "./touch-controls.ts";

function store(init: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

describe("touch controls prefs", () => {
  it("starts with the defaults and survives junk", () => {
    expect(loadTouchPrefs(undefined)).toEqual(DEFAULT_TOUCH_PREFS);
    expect(loadTouchPrefs(store({ "rpg.touch": "{nope" }))).toEqual(DEFAULT_TOUCH_PREFS);
    expect(loadTouchPrefs(store({ "rpg.touch": "[1]" }))).toEqual(DEFAULT_TOUCH_PREFS);
    const junk = JSON.stringify({ pad: "wheel", size: 3, mirrored: 1 });
    expect(loadTouchPrefs(store({ "rpg.touch": junk }))).toEqual(DEFAULT_TOUCH_PREFS);
  });

  it("round-trips a choice", () => {
    const s = store();
    const prefs: TouchPrefs = {
      pad: "stick",
      mirrored: true,
      size: "large",
      pinned: true,
      actions: false,
      haptics: false,
    };
    saveTouchPrefs(prefs, s);
    expect(loadTouchPrefs(s)).toEqual(prefs);
  });

  it("no size takes a button under 44 px", () => {
    for (const px of Object.values(TOUCH_BUTTON_PX)) expect(px).toBeGreaterThanOrEqual(44);
  });
});

describe("effects preset", () => {
  it("only judges touch devices", () => {
    expect(lowEndDevice({ coarse: false, memoryGb: 2, cores: 2 })).toBe(false);
    expect(lowEndDevice({ coarse: true, memoryGb: 4, cores: 8 })).toBe(true);
    expect(lowEndDevice({ coarse: true, memoryGb: 8, cores: 4 })).toBe(true);
    expect(lowEndDevice({ coarse: true, memoryGb: 8, cores: 8 })).toBe(false);
    expect(lowEndDevice({ coarse: true })).toBe(false); // nothing known (Safari): full
    expect(lowEndDevice({ coarse: true, cores: 6 })).toBe(false);
  });

  it("the saved choice wins over the capability check", () => {
    const low = { coarse: true, memoryGb: 2 };
    expect(loadEffects(undefined, low)).toBe("reduced");
    expect(loadEffects({ getItem: () => "full" }, low)).toBe("full");
    expect(loadEffects({ getItem: () => "reduced" }, { coarse: false })).toBe("reduced");
    expect(loadEffects({ getItem: () => "junk" }, { coarse: false })).toBe("full");
  });
});

describe("app mode memory", () => {
  it("defaults to nothing remembered and reads what was saved", () => {
    const none = { installDismissed: false, fullscreenWanted: false };
    expect(loadAppMode(undefined)).toEqual(none);
    expect(loadAppMode({ getItem: () => "x{" })).toEqual(none);
    const s = store();
    saveAppMode({ installDismissed: true, fullscreenWanted: true }, s);
    expect(loadAppMode(s)).toEqual({ installDismissed: true, fullscreenWanted: true });
  });
});
