import { describe, expect, it } from "vitest";
import type { SpellDef } from "../content-types.ts";
import { cooldownLeft, defaultHotkeys, hotkeySlot, loadHotkeys, saveHotkeys } from "./hotkeys.ts";

const spell = (id: string, level: number, vocations = ["arcanist"]): SpellDef => ({
  id,
  words: id,
  group: "attack",
  level,
  magicLevel: 0,
  mana: 1,
  vocations,
});

const spells = [spell("heal", 6), spell("bolt", 1), spell("smash", 1, ["guardian"])];

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}

describe("hotkeys", () => {
  it("maps F1..F12 only", () => {
    expect(hotkeySlot("F1")).toBe(0);
    expect(hotkeySlot("F12")).toBe(11);
    expect(hotkeySlot("F13")).toBeUndefined();
    expect(hotkeySlot("KeyF")).toBeUndefined();
  });

  it("defaults to the vocation's spells by level", () => {
    const keys = defaultHotkeys(spells, "arcanist");
    expect(keys.slice(0, 3)).toEqual(["bolt", "heal", undefined]);
    expect(keys).toHaveLength(12);
  });

  it("saves and loads, dropping unknown spells", () => {
    const st = new MemStorage();
    saveHotkeys("arcanist", ["heal", undefined, "gone"], st);
    expect(loadHotkeys(spells, "arcanist", st).slice(0, 3)).toEqual(["heal", undefined, undefined]);
    expect(loadHotkeys(spells, "guardian", st)[0]).toBe("smash");
    st.setItem("rpg.hotkeys.arcanist", "{bad json");
    expect(loadHotkeys(spells, "arcanist", st)[0]).toBe("bolt");
  });

  it("reports the longest cooldown left", () => {
    expect(
      cooldownLeft(
        [
          { until: 2000, total: 2000 },
          { until: 1500, total: 1000 },
        ],
        1000,
      ),
    ).toBe(0.5);
    expect(cooldownLeft([undefined, { until: 500, total: 1000 }], 1000)).toBe(0);
  });
});
