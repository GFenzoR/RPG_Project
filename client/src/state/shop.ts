// The NPC shop window's rules (docs/17 UI-8), pure and with tests: what each tab lists,
// the category filters, the search, the pages of the grid (never a scroll bar) and how many
// units the bar may ask for. The server checks money, room and stock on every purchase.
import type { ItemDef } from "../content-types.ts";
import { SHOP_CATEGORIES, shopCategory } from "./item-card.ts";
import type { ShopCategory } from "./item-card.ts";
import { fold } from "./dialog.ts";
import type { ShopLine } from "./world.ts";

/** Most units one purchase or sale may move (the server's limit too). */
export const MAX_COUNT = 100;

export type ShopMode = "buy" | "sell";
export type ShopFilter = "all" | ShopCategory;

/**
 * The lines of a tab: what the NPC sells (buy) or buys (sell). Selling shows first what the
 * player carries; what it does not carry stays, greyed (ui/Dialog.tsx), in the NPC's order.
 */
export function shopLines(lines: readonly ShopLine[], mode: ShopMode): ShopLine[] {
  if (mode === "buy") return lines.filter((l) => l.buyPrice > 0);
  const sell = lines.filter((l) => l.sellPrice > 0);
  return [...sell.filter((l) => l.owned > 0), ...sell.filter((l) => l.owned <= 0)];
}

/** The filters worth showing for these lines: "all" and each category they have. */
export function shopFilters(
  lines: readonly ShopLine[],
  items: Readonly<Record<number, ItemDef>>,
): ShopFilter[] {
  const have = new Set(lines.map((l) => shopCategory(items[l.itemId])));
  return ["all", ...SHOP_CATEGORIES.filter((c) => have.has(c))];
}

/** The lines of a filter whose name has `query` (case and accents ignored). */
export function filterShop(
  lines: readonly ShopLine[],
  items: Readonly<Record<number, ItemDef>>,
  filter: ShopFilter,
  query: string,
  nameOf: (itemId: number) => string,
): ShopLine[] {
  const q = fold(query.trim());
  return lines.filter(
    (l) =>
      (filter === "all" || shopCategory(items[l.itemId]) === filter) &&
      (q === "" || fold(nameOf(l.itemId)).includes(q)),
  );
}

/** One page of the grid (`page` from 0, kept within the pages there are). */
export function shopPage<T>(
  list: readonly T[],
  page: number,
  perPage: number,
): { items: T[]; page: number; pages: number } {
  const per = Math.max(1, perPage);
  const pages = Math.max(1, Math.ceil(list.length / per));
  const p = Math.min(Math.max(0, Math.floor(page)), pages - 1);
  return { items: list.slice(p * per, (p + 1) * per), page: p, pages };
}

/**
 * The most units the bar may ask for: buying, what the money pays (at most MAX_COUNT; 0
 * when it pays none); selling, what the player carries (at most MAX_COUNT).
 */
export function shopMax(mode: ShopMode, line: ShopLine, money: number): number {
  if (mode === "sell") return Math.max(0, Math.min(line.owned, MAX_COUNT));
  if (line.buyPrice <= 0) return 0;
  return Math.max(0, Math.min(MAX_COUNT, Math.floor(money / line.buyPrice)));
}

/**
 * The units a count field asks for: its whole number, from 1 to `max` (at least 1). The
 * field shows this number too: it showed 250 and bought 100 (the playtest's m8).
 */
export function shopCount(text: string, max: number): number {
  const n = Math.floor(Number(text));
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), Math.max(max, 1)) : 1;
}

/**
 * Columns and rows of the shop's grid on a vw x vh window (CSS px; cells of 72x84): six
 * columns by up to four rows on a desktop (24 items at 1280x720), fewer rows on a short
 * window; on a phone as many columns as its width takes, three rows. What does not fit
 * goes to the next page.
 */
export function shopGrid(
  vw: number,
  vh: number,
  phone: boolean,
): { columns: number; rows: number } {
  if (phone) return { columns: Math.max(3, Math.min(6, Math.floor((vw - 48) / 78))), rows: 3 };
  return { columns: 6, rows: Math.max(2, Math.min(4, Math.floor((vh - 380) / 84))) };
}
