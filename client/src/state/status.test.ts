import { describe, expect, it } from "vitest";
import { UI_STATUS_BOX } from "../../../tools/spritegen/src/recipe.ts";
import { STATUS_ART } from "../../../tools/spritegen/src/recipes/ui.ts";
import {
  FLASH_MS,
  STATUS_BOX,
  STATUS_KIND,
  STATUS_ORDER,
  nextTrayChange,
  statusIconStyle,
  trayEntries,
} from "./status.ts";
import type { ConditionView } from "./world.ts";

const c = (id: string, until: number | undefined, ticks = 0): ConditionView => ({
  id,
  until,
  ticks,
});

describe('the status tray (docs/17 "Bandeja de estados")', () => {
  it("knows every condition and status that has an icon, each with its kind", () => {
    expect([...STATUS_ORDER].sort()).toEqual(Object.keys(STATUS_ART).sort());
    expect(Object.keys(STATUS_KIND).sort()).toEqual([...STATUS_ORDER].sort());
    expect(STATUS_BOX).toEqual(UI_STATUS_BOX);
    expect(STATUS_KIND["poison"]).toBe("harm");
    expect(STATUS_KIND["in_combat"]).toBe("harm");
    expect(STATUS_KIND["protection_zone"]).toBe("buff");
    expect(STATUS_KIND["well_fed"]).toBe("buff");
  });

  it("puts what hurts first, then the fight's locks and the place, then what helps", () => {
    const list = [
      c("well_fed", 60_000),
      c("protection_zone", undefined),
      c("frenzy", 9000), // newer than the client: last, as a buff
      c("hasted", 20_000),
      c("in_combat", 12_000),
      c("poison", 9000, 3),
      c("mystery", 3000),
    ];
    const entries = trayEntries(list, 0, false);
    expect(entries.map((e) => e.id)).toEqual([
      "poison",
      "in_combat",
      "protection_zone",
      "hasted",
      "well_fed",
      "frenzy",
      "mystery",
    ]);
    expect(entries.find((e) => e.id === "frenzy")?.kind).toBe("buff");
    expect(entries[0]).toEqual({
      id: "poison",
      kind: "harm",
      leftMs: 9000,
      seconds: 9,
      ticks: 3,
      flash: false,
    });
  });

  it("writes whole seconds rounded up and drops what ran out; no end never runs out", () => {
    const list = [c("hasted", 10_000), c("slowed", 4000), c("protection_zone", undefined)];
    expect(trayEntries(list, 0, false).map((e) => [e.id, e.seconds])).toEqual([
      ["slowed", 4],
      ["protection_zone", undefined],
      ["hasted", 10],
    ]);
    expect(trayEntries(list, 3001, false).map((e) => [e.id, e.seconds])).toEqual([
      ["slowed", 1],
      ["protection_zone", undefined],
      ["hasted", 7],
    ]);
    // At its end (the server's new list may come a moment later): gone.
    expect(trayEntries(list, 4000, false).map((e) => e.id)).toEqual(["protection_zone", "hasted"]);
    expect(trayEntries(list, 1e9, false).map((e) => e.id)).toEqual(["protection_zone"]);
  });

  it("flashes in the last five seconds, never with reduced motion or with no end", () => {
    const list = [c("hasted", 20_000), c("protection_zone", undefined)];
    const flash = (now: number, reduced = false): boolean[] =>
      trayEntries(list, now, reduced).map((e) => e.flash);
    expect(FLASH_MS).toBe(5000);
    expect(flash(14_999)).toEqual([false, false]);
    expect(flash(15_000)).toEqual([false, true]);
    expect(flash(19_999)).toEqual([false, true]);
    expect(flash(17_000, true)).toEqual([false, false]);
  });

  it("asks to be drawn again when a written second turns, and not without an end", () => {
    expect(nextTrayChange([], 0)).toBeUndefined();
    expect(nextTrayChange([c("protection_zone", undefined)], 0)).toBeUndefined();
    expect(nextTrayChange([c("hasted", 2500)], 0)).toBe(500);
    expect(nextTrayChange([c("hasted", 3000)], 0)).toBe(1000);
    expect(nextTrayChange([c("hasted", 3000), c("poison", 1200, 2)], 100)).toBe(100);
    // The flash starts on a whole second of the time left: the next second covers it.
    expect(nextTrayChange([c("hasted", 5400)], 0)).toBe(400);
    expect(nextTrayChange([c("hasted", 1000)], 2000)).toBeUndefined();
  });

  it("cuts the box of a 32x32 sprite out of its atlas page, nothing for another size", () => {
    expect(statusIconStyle({ url: "/atlas/p0.png", x: 64, y: 96, width: 32, height: 32 })).toEqual({
      "--status-icon": "url(/atlas/p0.png)",
      "--status-pos": "-72px -104px",
    });
    expect(statusIconStyle({ url: "/a.png", x: 0, y: 0, width: 64, height: 64 })).toBeUndefined();
    expect(statusIconStyle(undefined)).toBeUndefined();
  });
});
