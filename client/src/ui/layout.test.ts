import { describe, expect, it } from "vitest";
import {
  BREAKPOINTS,
  PANEL_TABS,
  TAB_TITLE,
  hotbarFit,
  hotbarRoom,
  layoutFor,
  sliderEnds,
  slotsWidth,
  tabForHighlight,
} from "./layout.ts";

describe("layoutFor", () => {
  // CSS viewport sizes of real devices and windows.
  const cases: [string, number, number, string, string, string, boolean][] = [
    ["desktop 1280x800", 1280, 800, "desktop", "sidebar", "row", false],
    ["desktop app minimum 960x700", 960, 700, "desktop", "sidebar", "row", false],
    ["full HD", 1920, 1080, "desktop", "sidebar", "row", false],
    ["short wide desktop window", 1280, 480, "desktop", "sidebar", "row", false],
    ["iPad Mini landscape", 1024, 768, "desktop", "sidebar", "row", false],
    ["iPad Mini portrait", 768, 1024, "tablet", "tabs", "column", true],
    ["small desktop window", 900, 650, "tablet", "tabs", "row", false],
    ["Pixel 7 portrait", 412, 915, "phone-portrait", "tabs", "column", true],
    ["iPhone SE portrait", 375, 667, "phone-portrait", "tabs", "column", true],
    ["Pixel 7 landscape", 915, 412, "phone-landscape", "drawer", "row", true],
    ["iPhone SE landscape", 667, 375, "phone-landscape", "drawer", "row", true],
  ];
  for (const [name, w, h, id, panel, flow, compact] of cases) {
    it(name, () => {
      expect(layoutFor(w, h)).toEqual({ id, panel, flow, compactHeader: compact });
    });
  }

  it("compacts the header of any narrow window", () => {
    expect(layoutFor(700, 700).compactHeader).toBe(true);
    expect(layoutFor(720, 700).compactHeader).toBe(false);
  });

  it("takes the breakpoints as data", () => {
    const only = BREAKPOINTS.slice(-1);
    expect(layoutFor(400, 800, only).id).toBe("desktop");
    expect(layoutFor(400, 800, []).id).toBe("desktop");
  });

  it("ends with a catch-all breakpoint", () => {
    const last = BREAKPOINTS.at(-1);
    expect(last).toBeDefined();
    expect(last?.maxWidth).toBeUndefined();
    expect(last?.maxHeight).toBeUndefined();
    expect(last?.portrait).toBeUndefined();
  });
});

describe("panel tabs", () => {
  it("has a title for every tab", () => {
    for (const tab of PANEL_TABS) expect(TAB_TITLE[tab]).toMatch(/^client\.\w+\.title$/);
  });

  it("maps tutorial highlights to their tab", () => {
    expect(tabForHighlight("inventory")).toBe("inventory");
    expect(tabForHighlight("battle")).toBe("battle");
    expect(tabForHighlight("chat")).toBe("chat");
    expect(tabForHighlight("skills")).toBe("skills");
    expect(tabForHighlight("hotbar")).toBeUndefined();
    expect(tabForHighlight("stats")).toBeUndefined();
    expect(tabForHighlight(undefined)).toBeUndefined();
  });
});

describe("hotbarFit", () => {
  const base = { slot: 74, gap: 3, total: 12, fixed: 33, arrows: 100 };

  it("shows every slot on a wide map, without the slider", () => {
    expect(hotbarFit({ ...base, available: 1040 })).toEqual({ visible: 12, slider: false });
  });

  it("counts the arrows only when the slider is needed", () => {
    // 12 slots = 12*74 + 11*3 = 921 px, plus 33 for the edit button = 954.
    expect(hotbarFit({ ...base, available: 954 })).toEqual({ visible: 12, slider: false });
    // One px less: the arrows come in and take room from the slots.
    expect(hotbarFit({ ...base, available: 953 })).toEqual({ visible: 10, slider: true });
  });

  it("fits a phone", () => {
    expect(hotbarFit({ ...base, slot: 56, available: 390 })).toEqual({ visible: 4, slider: true });
  });

  it("always shows at least one slot", () => {
    expect(hotbarFit({ ...base, available: 50 })).toEqual({ visible: 1, slider: true });
  });

  it("handles a bar with a single slot", () => {
    expect(hotbarFit({ ...base, total: 1, available: 50 })).toEqual({
      visible: 1,
      slider: false,
    });
  });

  it("shows four slots right of the pad on a 412 px phone in portrait", () => {
    // Stacked (touch.css): 3.2rem slots, the arrows and the edit button on their own line.
    const room = hotbarRoom(412, 162, 8);
    expect(room).toBe(242);
    const fit = hotbarFit({
      slot: 51.2,
      gap: 3.2,
      total: 12,
      fixed: 0,
      arrows: 0,
      available: room,
    });
    expect(fit).toEqual({ visible: 4, slider: true });
    // The old single line (arrows and edit beside the slots) fitted one slot there.
    expect(hotbarFit({ ...base, slot: 57.6, gap: 3.2, available: room }).visible).toBe(1);
    // A 390 px phone (iPhone 13) still shows four.
    expect(
      hotbarFit({ slot: 51.2, gap: 3.2, total: 12, fixed: 0, arrows: 0, available: 220 }).visible,
    ).toBe(4);
  });

  it("knows the room beside the pad and on a centred bar", () => {
    expect(hotbarRoom(1000, 0, 8)).toBe(984);
    expect(hotbarRoom(1000, 162, 8)).toBe(830);
    expect(hotbarRoom(100, 162, 8)).toBe(0);
  });

  it("measures rows of slots", () => {
    expect(slotsWidth(0, 74, 3)).toBe(0);
    expect(slotsWidth(1, 74, 3)).toBe(74);
    expect(slotsWidth(4, 74, 3)).toBe(305);
  });
});

describe("sliderEnds", () => {
  it("knows where the list can scroll", () => {
    expect(sliderEnds(0, 300, 900)).toEqual({ prev: false, next: true });
    expect(sliderEnds(300, 300, 900)).toEqual({ prev: true, next: true });
    expect(sliderEnds(600, 300, 900)).toEqual({ prev: true, next: false });
    expect(sliderEnds(599.5, 300, 900)).toEqual({ prev: true, next: false });
    expect(sliderEnds(0, 300, 300)).toEqual({ prev: false, next: false });
  });
});
