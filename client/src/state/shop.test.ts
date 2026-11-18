import { describe, expect, it } from "vitest";
import type { ItemDef } from "../content-types.ts";
import {
  MAX_COUNT,
  filterShop,
  shopCount,
  shopFilters,
  shopGrid,
  shopLines,
  shopMax,
  shopPage,
} from "./shop.ts";
import type { ShopLine } from "./world.ts";

const def = (id: string, kind: string): ItemDef => ({
  id,
  kind,
  sprite: "",
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
});

const items: Record<number, ItemDef> = {
  1: def("rope", "tool"),
  2: def("iron_sword", "weapon"),
  3: def("raw_fish", "consumable"),
  4: def("wolf_pelt", "material"),
  5: def("plank_shield", "shield"),
};
const names: Record<number, string> = {
  1: "soga",
  2: "espada de hierro",
  3: "pescado crudo",
  4: "piel de lobo",
  5: "escudo de tablas",
};
const line = (itemId: number, buyPrice: number, sellPrice: number, owned = 0): ShopLine => ({
  itemId,
  buyPrice,
  sellPrice,
  owned,
});
const lines = [
  line(1, 45, 0),
  line(2, 120, 40),
  line(3, 3, 1, 12),
  line(4, 0, 15),
  line(5, 25, 8, 1),
];

describe("shop window rules (docs/17 UI-8)", () => {
  it("each tab lists what the NPC sells or buys; selling shows what is carried first", () => {
    expect(shopLines(lines, "buy").map((l) => l.itemId)).toEqual([1, 2, 3, 5]);
    expect(shopLines(lines, "sell").map((l) => l.itemId)).toEqual([3, 5, 2, 4]);
  });

  it("offers only the categories present, after All", () => {
    expect(shopFilters(shopLines(lines, "buy"), items)).toEqual([
      "all",
      "weapons",
      "armor",
      "tools",
      "consumables",
    ]);
    expect(shopFilters([line(4, 0, 15)], items)).toEqual(["all", "materials"]);
  });

  it("filters by category and by the translated name, without case or accents", () => {
    const nameOf = (id: number): string => names[id] ?? "";
    const buy = shopLines(lines, "buy");
    expect(filterShop(buy, items, "armor", "", nameOf).map((l) => l.itemId)).toEqual([5]);
    expect(filterShop(buy, items, "all", "ESPADA", nameOf).map((l) => l.itemId)).toEqual([2]);
    expect(filterShop(buy, items, "all", "pescádo", nameOf).map((l) => l.itemId)).toEqual([3]);
    expect(filterShop(buy, items, "tools", "espada", nameOf)).toEqual([]);
  });

  it("pages the grid instead of scrolling, keeping the page within range", () => {
    const list = Array.from({ length: 30 }, (_, i) => i);
    expect(shopPage(list, 0, 24)).toEqual({ items: list.slice(0, 24), page: 0, pages: 2 });
    expect(shopPage(list, 1, 24).items).toEqual(list.slice(24));
    expect(shopPage(list, 5, 24).page).toBe(1);
    expect(shopPage([], 3, 24)).toEqual({ items: [], page: 0, pages: 1 });
  });

  it("caps the count by money, by what is carried and by the server's limit", () => {
    expect(shopMax("buy", line(1, 45, 0), 100)).toBe(2);
    expect(shopMax("buy", line(1, 45, 0), 10)).toBe(0);
    expect(shopMax("buy", line(3, 1, 0), 10_000)).toBe(MAX_COUNT);
    expect(shopMax("sell", line(3, 3, 1, 12), 0)).toBe(12);
    expect(shopMax("sell", line(3, 3, 1, 250), 0)).toBe(MAX_COUNT);
    expect(shopMax("buy", line(4, 0, 15), 100)).toBe(0);
  });

  it("a typed count is a whole number from 1 to the limit (playtest m8)", () => {
    expect(shopCount("250", 100)).toBe(100);
    expect(shopCount("0", 100)).toBe(1);
    expect(shopCount("abc", 100)).toBe(1);
    expect(shopCount("7.9", 100)).toBe(7);
    expect(shopCount("5", 0)).toBe(1);
  });

  it("24 cells at 1280x720 and 1280x800, fewer rows on a short window, a phone's columns", () => {
    expect(shopGrid(1280, 720, false)).toEqual({ columns: 6, rows: 4 });
    expect(shopGrid(1280, 800, false)).toEqual({ columns: 6, rows: 4 });
    expect(shopGrid(960, 640, false)).toEqual({ columns: 6, rows: 3 });
    expect(shopGrid(390, 844, true)).toEqual({ columns: 4, rows: 3 });
    expect(shopGrid(844, 390, true).columns).toBe(6);
  });
});
