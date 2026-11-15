import { describe, expect, it } from "vitest";
import type { LogMessage } from "../state/world.ts";
import { MAX_NOTICES, NOTICE_MS, activeNotices, isImportant, nextExpiry } from "./notices.ts";

const msg = (key: string, at: number): LogMessage => ({ key, params: [], at });

describe("isImportant", () => {
  it("floats refusals and notices, not look or loot lines", () => {
    expect(isImportant("pvp.logout_locked")).toBe(true);
    expect(isImportant("pvp.safe_mode")).toBe(true);
    expect(isImportant("market.not_enough_money")).toBe(true);
    expect(isImportant("house.no_access")).toBe(true);
    expect(isImportant("trade.cancel.too_far")).toBe(true);
    expect(isImportant("combat.cannot_attack")).toBe(true);
    expect(isImportant("look.item")).toBe(false);
    expect(isImportant("combat.loot")).toBe(false);
    expect(isImportant("combat.loot_none")).toBe(false);
  });
});

describe("activeNotices", () => {
  const log = [msg("look.item", 1000), msg("pvp.zone", 2000), msg("market.sold", 3000)];

  it("shows the important recent messages on desktop", () => {
    expect(activeNotices(log, 3500, { all: false }).map((m) => m.key)).toEqual([
      "pvp.zone",
      "market.sold",
    ]);
  });

  it("shows every message when the log is out of view", () => {
    expect(activeNotices(log, 3500, { all: true })).toHaveLength(3);
  });

  it("drops a notice once it is old", () => {
    expect(activeNotices(log, 2000 + NOTICE_MS, { all: true }).map((m) => m.key)).toEqual([
      "market.sold",
    ]);
    expect(activeNotices(log, 3000 + NOTICE_MS, { all: true })).toEqual([]);
  });

  it("keeps dismissed notices closed", () => {
    expect(activeNotices(log, 3500, { all: true, dismissedUpTo: 2000 }).map((m) => m.key)).toEqual([
      "market.sold",
    ]);
  });

  it("shows only the newest few", () => {
    const many = Array.from({ length: 5 }, (_, i) => msg(`party.n${i}`, 100 + i));
    const shown = activeNotices(many, 200, { all: false });
    expect(shown).toHaveLength(MAX_NOTICES);
    expect(shown[shown.length - 1]?.key).toBe("party.n4");
  });

  it("ignores messages from the future", () => {
    expect(activeNotices([msg("pvp.zone", 5000)], 4000, { all: true })).toEqual([]);
  });
});

describe("nextExpiry", () => {
  it("is the first notice to go", () => {
    expect(nextExpiry([])).toBeUndefined();
    expect(nextExpiry([msg("a", 300), msg("b", 100)])).toBe(100 + NOTICE_MS);
  });
});
