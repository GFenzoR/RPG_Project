// Item hotkeys 1-6 (docs/02 "Teclas rapidas de items"): the pure rules of the bar.
import { describe, expect, it } from "vitest";
import type { ItemDef } from "../content-types.ts";
import {
  ITEM_HOTKEY_COUNT,
  assignKey,
  cleanKeys,
  emptyItemKeys,
  hotkeyUsable,
  itemHotkeySlot,
  itemKeyLabel,
  loadItemKeys,
  saveItemKeys,
  slotView,
  swapKeys,
  trackedTypes,
} from "./item-hotkeys.ts";

const base: ItemDef = {
  id: "",
  sprite: "",
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
};
const items: Record<number, ItemDef> = {
  10: { ...base, id: "bread", stackable: true, consumable: { healHp: 0, healMp: 0, foodMs: 1 } },
  11: { ...base, id: "potion", stackable: true, consumable: { healHp: 40, healMp: 0, foodMs: 0 } },
  12: { ...base, id: "arc_rune", rune: { spell: "arc_bolt", charges: 4, magicLevel: 1 } },
  20: {
    ...base,
    id: "sword",
    weapon: { type: "sword", attack: 10, defense: 5, hands: 1, range: 0, element: "", ammo: "" },
  },
  21: { ...base, id: "rod", useWith: true },
  22: { ...base, id: "bag", slots: 8 },
  23: { ...base, id: "fixed_meal", fixed: true, consumable: { healHp: 0, healMp: 0, foodMs: 1 } },
};

class Mem {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
}

describe("item hotkey keys", () => {
  it("maps Digit1-6 and Numpad1-6 to slots 0-5 and nothing else", () => {
    expect(["Digit1", "Digit6", "Numpad3"].map(itemHotkeySlot)).toEqual([0, 5, 2]);
    for (const code of ["Digit7", "Digit0", "KeyA", "F1", "Numpad9", ""])
      expect(itemHotkeySlot(code)).toBeUndefined();
    expect(ITEM_HOTKEY_COUNT).toBe(6);
    expect(itemKeyLabel(0)).toBe("1");
    expect(itemKeyLabel(5)).toBe("6");
  });
});

describe("which items may be assigned", () => {
  it("accepts food, potions and runes; never equipment, tools, containers or fixtures", () => {
    expect([10, 11, 12].map((id) => hotkeyUsable(items[id]))).toEqual([true, true, true]);
    expect([20, 21, 22, 23].map((id) => hotkeyUsable(items[id]))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(hotkeyUsable(undefined)).toBe(false);
  });
});

describe("assigning", () => {
  it("puts a type in a slot and a type only once", () => {
    let keys = emptyItemKeys();
    keys = assignKey(keys, 0, 10);
    keys = assignKey(keys, 3, 11);
    expect(keys).toEqual([10, 0, 0, 11, 0, 0]);
    keys = assignKey(keys, 5, 10); // moves: its old slot empties
    expect(keys).toEqual([0, 0, 0, 11, 0, 10]);
    expect(assignKey(keys, 5, 10)).toEqual(keys);
    expect(assignKey(keys, 3, 0)).toEqual([0, 0, 0, 0, 0, 10]); // clear
    expect(assignKey(keys, 9, 12)).toEqual(keys); // no such slot
  });

  it("swaps two slots", () => {
    expect(swapKeys([10, 0, 11, 0, 0, 0], 0, 2)).toEqual([11, 0, 10, 0, 0, 0]);
    expect(swapKeys([10, 0, 0, 0, 0, 0], 0, 4)).toEqual([0, 0, 0, 0, 10, 0]);
    expect(swapKeys([10, 0, 0, 0, 0, 0], 0, 9)).toEqual([10, 0, 0, 0, 0, 0]);
  });

  it("tells the server the distinct types", () => {
    expect(trackedTypes([10, 0, 11, 10, 0, 12])).toEqual([10, 11, 12]);
    expect(trackedTypes(emptyItemKeys())).toEqual([]);
  });
});

describe("what a slot shows of the totals", () => {
  it("shows the count, greys out at 0 and shows nothing before the first ItemCounts", () => {
    const counts = new Map([
      [10, 7],
      [11, 0],
    ]);
    expect(slotView(10, counts)).toEqual({ count: 7, empty: false });
    expect(slotView(11, counts)).toEqual({ count: 0, empty: true });
    expect(slotView(12, counts)).toEqual({ count: undefined, empty: false });
    expect(slotView(0, counts)).toEqual({ count: undefined, empty: false });
  });
});

describe("the saved bar of a character", () => {
  it("round-trips per character name", () => {
    const store = new Mem();
    saveItemKeys("Ana", [10, 0, 12, 0, 0, 11], store);
    saveItemKeys("Bruno", [11, 0, 0, 0, 0, 0], store);
    expect(loadItemKeys("Ana", items, store)).toEqual([10, 0, 12, 0, 0, 11]);
    expect(loadItemKeys("Bruno", items, store)).toEqual([11, 0, 0, 0, 0, 0]);
    expect(loadItemKeys("Cleo", items, store)).toEqual(emptyItemKeys());
  });

  it("drops what is not usable any more, junk and repeats; an empty bar leaves no entry", () => {
    expect(cleanKeys([10, 20, "x", 10, 99, 1.5, 11, 12], items)).toEqual([10, 0, 0, 0, 0, 0]);
    expect(cleanKeys([10, 11, 12, 11, 0, 12], items)).toEqual([10, 11, 12, 0, 0, 0]);
    expect(cleanKeys("nope", items)).toEqual(emptyItemKeys());
    const store = new Mem();
    saveItemKeys("Ana", [10, 0, 0, 0, 0, 0], store);
    saveItemKeys("Ana", emptyItemKeys(), store);
    expect(JSON.parse(store.getItem("rpg.itemkeys") ?? "null")).toEqual({});
  });

  it("survives blocked or broken storage", () => {
    expect(loadItemKeys("Ana", items, undefined)).toEqual(emptyItemKeys());
    expect(
      loadItemKeys("Ana", items, {
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toEqual(emptyItemKeys());
    expect(() =>
      saveItemKeys("Ana", [10, 0, 0, 0, 0, 0], {
        getItem: () => null,
        setItem: () => {
          throw new Error("full");
        },
      }),
    ).not.toThrow();
    const junk = new Mem();
    junk.setItem("rpg.itemkeys", "[1,2");
    expect(loadItemKeys("Ana", items, junk)).toEqual(emptyItemKeys());
  });
});
