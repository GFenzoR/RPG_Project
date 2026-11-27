import { describe, expect, it } from "vitest";
import {
  NO_SHEETS,
  closeTop,
  historyDepth,
  isCloseSwipe,
  isPaired,
  pairMode,
  raise,
  sheetView,
  syncStack,
  topSheet,
} from "./sheets.ts";
import type { SheetKind, SheetsOpen } from "./sheets.ts";

const open = (...kinds: SheetKind[]): SheetsOpen => {
  const o: Record<string, boolean> = { ...NO_SHEETS };
  for (const k of kinds) o[k] = true;
  return o as unknown as SheetsOpen;
};
const column = { flow: "column" } as const;
const row = { flow: "row" } as const;

describe("sheet stack", () => {
  it("puts a newly opened sheet on top and drops closed ones", () => {
    let s = syncStack([], open("panel"));
    expect(s).toEqual(["panel"]);
    s = syncStack(s, open("panel", "dialog"));
    expect(topSheet(s)).toBe("dialog");
    s = syncStack(s, open("dialog"));
    expect(s).toEqual(["dialog"]);
    expect(syncStack(s, NO_SHEETS)).toEqual([]);
  });
  it("keeps the order of the ones that stay", () => {
    const s = syncStack(["trade", "panel"], open("panel", "trade", "book"));
    expect(s).toEqual(["trade", "panel", "book"]);
  });
  it("raise brings a sheet to the front without duplicating it", () => {
    expect(raise(["panel", "dialog"], "panel")).toEqual(["dialog", "panel"]);
    expect(raise([], "stash")).toEqual(["stash"]);
  });
  it("closeTop shows the one below and never fails on an empty stack", () => {
    expect(closeTop(["panel", "book"])).toEqual(["panel"]);
    expect(closeTop([])).toEqual([]);
    expect(topSheet([])).toBeUndefined();
  });
  it("holds one history entry per sheet", () => {
    expect(historyDepth(["panel", "trade"])).toBe(2);
    expect(historyDepth([])).toBe(0);
  });
});

describe("pair rules", () => {
  it("pairs trade, stash, station, containers and a shop with the pockets", () => {
    for (const k of ["trade", "stash", "station", "containers", "dialog"] as const)
      expect(isPaired(k)).toBe(true);
    for (const k of ["market", "house", "book", "panel"] as const) expect(isPaired(k)).toBe(false);
  });
  it("splits upright and tabs on its side", () => {
    expect(pairMode("trade", column)).toBe("split");
    expect(pairMode("trade", row)).toBe("tabs");
    expect(pairMode("market", column)).toBe("single");
  });
  it("a talk without a shop is alone", () => {
    expect(pairMode("dialog", column, false)).toBe("single");
    expect(pairMode("dialog", column, true)).toBe("split");
  });
  it("sheetView reports the front sheet, the pockets and the tabs", () => {
    expect(sheetView([], column)).toEqual({
      front: undefined,
      withInventory: false,
      tabs: false,
    });
    expect(sheetView(["panel", "stash"], row)).toEqual({
      front: "stash",
      withInventory: true,
      tabs: true,
    });
    expect(sheetView(["stash", "book"], column).withInventory).toBe(false);
  });
});

describe("swipe to close", () => {
  it("needs a long, mostly vertical, downward drag", () => {
    expect(isCloseSwipe(0, 100)).toBe(true);
    expect(isCloseSwipe(10, 80)).toBe(true);
    expect(isCloseSwipe(0, 40)).toBe(false);
    expect(isCloseSwipe(100, 100)).toBe(false);
    expect(isCloseSwipe(0, -120)).toBe(false);
  });
});
