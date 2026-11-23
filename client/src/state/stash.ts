// Account stash (docs/02 "Baúl de la cuenta", docs/05 StashUpdate): what the window shows,
// built from StashUpdate. Pure: no DOM, no clock. The server owns the stash and checks every
// move; this only shapes the view and names the result of the last one.
import { StashResult } from "@rpg/protocol";
import type { StashUpdate } from "@rpg/protocol";
import type { ItemMods } from "../content-types.ts";
import { modsOf } from "./mods.ts";

/** One cell of the stash (index: StashWithdraw.index). */
export interface StashCell {
  index: number;
  itemId: number;
  count: number;
  mods?: ItemMods | undefined;
}

/** The stash window. */
export interface StashView {
  capacity: number;
  cells: StashCell[];
  /** The chest it was opened at. */
  chest: { x: number; y: number; z: number };
}

/** The i18n key of a result that refused a move (undefined: OK or nothing). */
export function stashResultKey(r: StashResult): string | undefined {
  switch (r) {
    case StashResult.FULL:
      return "client.stash.result.full";
    case StashResult.NO_ROOM:
      return "client.stash.result.no_room";
    case StashResult.TOO_HEAVY:
      return "client.stash.result.too_heavy";
    case StashResult.TOO_FAR:
      return "client.stash.result.too_far";
    case StashResult.CHANGED:
      return "client.stash.result.changed";
    case StashResult.NOT_ALLOWED:
      return "client.stash.result.not_allowed";
    case StashResult.TOO_FAST:
      return "client.stash.result.too_fast";
    case StashResult.UNAVAILABLE:
      return "client.stash.result.unavailable";
    case StashResult.NOT_POSSIBLE:
      return "client.stash.result.not_possible";
    case StashResult.IN_COMBAT:
      return "client.stash.result.in_combat";
    default:
      return undefined;
  }
}

/** What a StashUpdate does: the window (undefined: closed) and the refusal to log, if any. */
export function stashFrom(u: StashUpdate): {
  view: StashView | undefined;
  refused?: string | undefined;
} {
  const refused = stashResultKey(u.result);
  if (!u.open) return { view: undefined, refused };
  const cells = u.items.map((s, index): StashCell => {
    const mods = modsOf(s);
    return mods
      ? { index, itemId: s.itemId, count: s.count, mods }
      : { index, itemId: s.itemId, count: s.count };
  });
  const c = u.chest;
  return {
    view: { capacity: u.capacity, cells, chest: { x: c?.x ?? 0, y: c?.y ?? 0, z: c?.z ?? 0 } },
    refused,
  };
}

/** Whether the stash has no free cell (it may still take units into a stack). */
export const stashFull = (v: StashView): boolean => v.cells.length >= v.capacity;

/**
 * How many units "Take" asks for: the whole cell, except plain units (a stack without
 * mods) heavier than the free capacity, which take as many as fit (at least one: the
 * server answers TOO_HEAVY then). The server checks the weight again; this only avoids
 * a stack that can never come out from the window.
 */
export function stashTakeCount(
  c: StashCell,
  item: { stackable?: boolean; weight?: number } | undefined,
  freeCapacity: number | undefined,
): number {
  const weight = item?.weight ?? 0;
  if (!item?.stackable || c.mods || weight <= 0 || freeCapacity === undefined) return c.count;
  return Math.max(1, Math.min(c.count, Math.floor(freeCapacity / weight)));
}
