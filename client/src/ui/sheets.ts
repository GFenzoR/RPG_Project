// The sheets of a phone or a small tablet (docs/17 "UI movil", lote 21 "ventanas"), pure and
// unit-tested. On the desktop every window floats; here one sheet is on screen at a time, a
// stack remembers the ones under it, and Escape, the Android back gesture and a swipe down
// on the header all close the top one. The pairs that must be seen together (a shop and
// the pockets it buys from, a trade, the stash, a forge, a loot container) are one split
// sheet: upright the two share the height, on its side they are tabs.
import type { Layout } from "./layout.ts";

/** What can be a sheet: the tool panel (its tabs) and each of the server's windows. */
export const SHEET_KINDS = [
  "panel",
  "dialog",
  "station",
  "market",
  "house",
  "trade",
  "stash",
  "book",
  "containers",
] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];

/** Which sheets are open right now (the UI state; the panel's is the player's own). */
export type SheetsOpen = Readonly<Record<SheetKind, boolean>>;

/** Nothing open. */
export const NO_SHEETS: SheetsOpen = {
  panel: false,
  dialog: false,
  station: false,
  market: false,
  house: false,
  trade: false,
  stash: false,
  book: false,
  containers: false,
};

/**
 * The stack after the open set changed: sheets that closed leave wherever they were,
 * the ones that opened go on top (in SHEET_KINDS order when several open at once), the
 * rest keep their order. The same input gives the same stack.
 */
export function syncStack(stack: readonly SheetKind[], open: SheetsOpen): SheetKind[] {
  const kept = stack.filter((k) => open[k]);
  const added = SHEET_KINDS.filter((k) => open[k] && !kept.includes(k));
  return [...kept, ...added];
}

/** The sheet in front (the one Escape, back and a swipe close), if any. */
export function topSheet(stack: readonly SheetKind[]): SheetKind | undefined {
  return stack[stack.length - 1];
}

/** Brings a sheet to the front (a tap on a section button while another sheet is up). */
export function raise(stack: readonly SheetKind[], kind: SheetKind): SheetKind[] {
  return [...stack.filter((k) => k !== kind), kind];
}

/**
 * The sheets that need the pockets beside them: items go from one to the other. The shop
 * is the dialog's (it only exists with one). A book, the market board and a house are read
 * or answered alone.
 */
const PAIRED: ReadonlySet<SheetKind> = new Set([
  "dialog",
  "station",
  "trade",
  "stash",
  "containers",
]);

/** True when the sheet is shown with the inventory next to it. */
export function isPaired(kind: SheetKind): boolean {
  return PAIRED.has(kind);
}

/** How a pair shares the screen: stacked in two, as tabs, or not a pair at all. */
export type PairMode = "split" | "tabs" | "single";

/**
 * Upright (a column) there is height for two halves; on its side the screen is too low for
 * two lists, so the pair is two tabs. A dialog is paired only when it has a shop
 * (`hasShop`): a plain talk needs no pockets.
 */
export function pairMode(kind: SheetKind, layout: Pick<Layout, "flow">, hasShop = true): PairMode {
  if (!isPaired(kind)) return "single";
  if (kind === "dialog" && !hasShop) return "single";
  return layout.flow === "column" ? "split" : "tabs";
}

/** What one frame of the sheets shows: the front sheet and, in a pair, the pockets. */
export interface SheetView {
  front: SheetKind | undefined;
  /** The inventory shown with the front sheet (a split pair or its tab). */
  withInventory: boolean;
  /** On its side, the pair is two tabs (the front sheet's own and the pockets). */
  tabs: boolean;
}

/** The view of a stack in a layout. */
export function sheetView(
  stack: readonly SheetKind[],
  layout: Pick<Layout, "flow">,
  hasShop = true,
): SheetView {
  const front = topSheet(stack);
  if (!front) return { front, withInventory: false, tabs: false };
  const mode = pairMode(front, layout, hasShop);
  return { front, withInventory: mode !== "single", tabs: mode === "tabs" };
}

/** The stack after the front sheet closes: the next one down comes back. */
export function closeTop(stack: readonly SheetKind[]): SheetKind[] {
  return stack.slice(0, -1);
}

/**
 * The History API entries a stack holds above the page's own: one per sheet, so the Android
 * back gesture (a `popstate`) closes the top one and never leaves the game.
 */
export function historyDepth(stack: readonly SheetKind[]): number {
  return stack.length;
}

/**
 * A swipe down on a sheet's header closes it when the finger travelled far enough and
 * mostly downward (so a sideways scroll of the tabs is not a close). Distances in px.
 */
export const SWIPE_CLOSE_PX = 72;
export function isCloseSwipe(dx: number, dy: number): boolean {
  return dy >= SWIPE_CLOSE_PX && dy > Math.abs(dx) * 1.5;
}
