import { describe, expect, it } from "vitest";
import { AUDIO_STORAGE_KEY, defaultPrefs, loadPrefs, savePrefs, withVolume } from "./prefs.ts";

const memory = (): Storage => {
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
};

describe("audio prefs", () => {
  it("round-trips through storage", () => {
    const s = memory();
    const p = withVolume(defaultPrefs(), "music", 0.2);
    p.muted.ambient = true;
    savePrefs(p, s);
    expect(loadPrefs(s)).toEqual(p);
  });

  it("falls back to the defaults for missing, broken or out-of-range values", () => {
    const s = memory();
    expect(loadPrefs(s)).toEqual(defaultPrefs());
    s.setItem(AUDIO_STORAGE_KEY, "{nope");
    expect(loadPrefs(s)).toEqual(defaultPrefs());
    s.setItem(
      AUDIO_STORAGE_KEY,
      JSON.stringify({ volume: { sfx: 7, ui: "loud" }, muted: { ui: 1 } }),
    );
    const p = loadPrefs(s);
    expect(p.volume.sfx).toBe(1);
    expect(p.volume.ui).toBe(defaultPrefs().volume.ui);
    expect(p.muted.ui).toBe(false);
    expect(loadPrefs(undefined)).toEqual(defaultPrefs());
  });

  it("survives storage that throws", () => {
    const broken = {
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(() => savePrefs(defaultPrefs(), broken)).not.toThrow();
  });
});
