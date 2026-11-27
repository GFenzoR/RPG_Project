// Item hotkeys (docs/02 "Teclas rapidas de items"): the bottom bar's six slots hold item TYPES
// (food, potions, runes), used with the keys 1-6 or a tap. A slot is the numeric id of the
// item (0 = empty), not a stack: the server finds the unit wherever the character carries it
// (UseItemType) and tells how many it carries in all (ItemCounts). The assignment is
// remembered per character (rpg.itemkeys, a saved account option: state/saved-options.ts).
import type { ItemDef } from "../content-types.ts";

/** Slots of the bar: the keys 1-6. */
export const ITEM_HOTKEY_COUNT = 6;

/** The slot (0..5) a key code uses: Digit1-6 or Numpad1-6; undefined for any other. */
export function itemHotkeySlot(code: string): number | undefined {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n <= ITEM_HOTKEY_COUNT ? n - 1 : undefined;
}

/** The label of a slot's key ("1".."6"). */
export const itemKeyLabel = (slot: number): string => String(slot + 1);

/**
 * Whether an item type may sit on a slot: what a use eats, drinks or casts (food, potions,
 * runes). Equipment, containers, tools (they need a tile: "use with"), books and map fixtures
 * never; the server checks the same on every use.
 */
export function hotkeyUsable(def: ItemDef | undefined): boolean {
  if (!def || def.fixed || def.slots > 0 || def.useWith) return false;
  return def.consumable !== undefined || def.rune !== undefined;
}

/** Six empty slots. */
export const emptyItemKeys = (): number[] => Array.from({ length: ITEM_HOTKEY_COUNT }, () => 0);

/**
 * `keys` with `itemId` in `slot` (0 clears it). A type sits in one slot only: assigning it
 * where it already is does nothing, and assigning it to another slot empties its old one.
 */
export function assignKey(keys: readonly number[], slot: number, itemId: number): number[] {
  if (slot < 0 || slot >= ITEM_HOTKEY_COUNT) return [...keys];
  return keys.map((k, i) => (i === slot ? itemId : itemId > 0 && k === itemId ? 0 : k));
}

/** `keys` with slots `a` and `b` swapped (a drag from one slot onto another). */
export function swapKeys(keys: readonly number[], a: number, b: number): number[] {
  const out = [...keys];
  if (a < 0 || b < 0 || a >= out.length || b >= out.length) return out;
  [out[a], out[b]] = [out[b] ?? 0, out[a] ?? 0];
  return out;
}

/** The distinct item types of the bar (what SetItemHotkeys tells the server). */
export function trackedTypes(keys: readonly number[]): number[] {
  return [...new Set(keys.filter((k) => k > 0))];
}

/**
 * What a slot shows of the totals the server sent: `count` units (undefined before the first
 * ItemCounts), `empty` when none is carried (greyed out, the assignment stays).
 */
export function slotView(
  itemId: number,
  counts: ReadonlyMap<number, number>,
): { count: number | undefined; empty: boolean } {
  if (itemId <= 0) return { count: undefined, empty: false };
  const count = counts.get(itemId);
  return { count, empty: count === 0 };
}

const KEY = "rpg.itemkeys";

type Reader = Pick<Storage, "getItem">;

function all(storage: Reader | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(storage?.getItem(KEY) ?? "{}");
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A saved bar: six slots, only ids of usable items (the rest become empty). */
export function cleanKeys(raw: unknown, items: Readonly<Record<number, ItemDef>>): number[] {
  const out = emptyItemKeys();
  if (!Array.isArray(raw)) return out;
  for (let i = 0; i < ITEM_HOTKEY_COUNT; i++) {
    const v: unknown = raw[i];
    if (typeof v === "number" && Number.isInteger(v) && hotkeyUsable(items[v])) out[i] = v;
  }
  return out.map((k, i) => (out.indexOf(k) === i ? k : 0)); // a type only once
}

/** The saved bar of a character (by name), or six empty slots. */
export function loadItemKeys(
  name: string,
  items: Readonly<Record<number, ItemDef>>,
  storage: Reader | undefined,
): number[] {
  return cleanKeys(all(storage)[name], items);
}

/** Saves the bar of a character. An empty bar removes its entry. */
export function saveItemKeys(
  name: string,
  keys: readonly number[],
  storage: (Reader & Pick<Storage, "setItem">) | undefined,
): void {
  try {
    const doc = all(storage);
    if (keys.some((k) => k > 0)) doc[name] = keys.slice(0, ITEM_HOTKEY_COUNT);
    else Reflect.deleteProperty(doc, name);
    storage?.setItem(KEY, JSON.stringify(doc));
  } catch {
    // Private mode or full storage: the bar just is not remembered.
  }
}
