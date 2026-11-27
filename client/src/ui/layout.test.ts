import { describe, expect, it } from "vitest";
import {
  BREAKPOINTS,
  DESKTOP_MIN_WIDTH,
  MOBILE_HUD,
  PANEL_TABS,
  TAB_TITLE,
  hotbarFit,
  hotbarRoom,
  consoleColumns,
  isMobile,
  mobileHotbarFit,
  layoutFor,
  sliderEnds,
  slotsWidth,
  tabForHighlight,
} from "./layout.ts";

describe("layoutFor", () => {
  // CSS viewport sizes of real devices and windows.
  const cases: [string, number, number, string, string, string][] = [
    ["desktop 1280x800", 1280, 800, "desktop", "sidebar", "row"],
    ["desktop app minimum 960x700", 960, 700, "desktop", "sidebar", "row"],
    ["full HD", 1920, 1080, "desktop", "sidebar", "row"],
    ["short wide desktop window", 1280, 480, "desktop", "sidebar", "row"],
    // Tablets: on their side from 1024 px they take the desktop's floating windows...
    ["iPad Mini landscape", 1024, 768, "desktop", "sidebar", "row"],
    ["iPad Air landscape", 1180, 820, "desktop", "sidebar", "row"],
    // ...and upright, or small on their side, the mobile HUD.
    ["iPad Mini portrait", 768, 1024, "tablet", "sheet", "column"],
    ["iPad Air portrait", 820, 1180, "tablet", "sheet", "column"],
    ["small tablet landscape", 900, 650, "tablet", "drawer", "row"],
    ["just under the desktop", 959, 700, "tablet", "drawer", "row"],
    ["Pixel 7 portrait", 412, 915, "phone-portrait", "sheet", "column"],
    ["iPhone 13 portrait", 390, 844, "phone-portrait", "sheet", "column"],
    ["iPhone SE portrait", 375, 667, "phone-portrait", "sheet", "column"],
    ["Pixel 7 landscape", 915, 412, "phone-landscape", "drawer", "row"],
    ["iPhone 13 landscape", 844, 390, "phone-landscape", "drawer", "row"],
    ["iPhone SE landscape", 667, 375, "phone-landscape", "drawer", "row"],
  ];
  for (const [name, w, h, id, panel, flow] of cases) {
    it(name, () => {
      expect(layoutFor(w, h)).toEqual({ id, panel, flow });
      expect(isMobile(layoutFor(w, h))).toBe(id !== "desktop");
    });
  }

  it("never gives windows to a screen narrower than the desktop app's minimum", () => {
    expect(DESKTOP_MIN_WIDTH).toBe(960);
    for (let w = 320; w < DESKTOP_MIN_WIDTH; w += 40)
      for (const h of [360, 600, 900, 1200]) expect(isMobile(layoutFor(w, h))).toBe(true);
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

describe("the mobile HUD (docs/17 UI movil)", () => {
  it("keeps every button a 44 px touch target", () => {
    expect(MOBILE_HUD.slot).toBeGreaterThanOrEqual(44);
    expect(MOBILE_HUD.arrow).toBeGreaterThanOrEqual(44);
    expect(MOBILE_HUD.edit).toBeGreaterThanOrEqual(44);
    expect(MOBILE_HUD.tool).toBeGreaterThanOrEqual(44);
  });

  it("upright, the slots take a line of their own: 6 or 7 on a phone, all on a tablet", () => {
    expect(mobileHotbarFit(320, "column")).toEqual({ visible: 6, slider: true });
    expect(mobileHotbarFit(360, "column")).toEqual({ visible: 6, slider: true });
    expect(mobileHotbarFit(375, "column")).toEqual({ visible: 7, slider: true });
    expect(mobileHotbarFit(390, "column")).toEqual({ visible: 7, slider: true });
    expect(mobileHotbarFit(412, "column")).toEqual({ visible: 7, slider: true });
    expect(mobileHotbarFit(768, "column")).toEqual({ visible: 12, slider: false });
  });

  it("on its side, the slots share the bar with the orbs and the buttons, and page", () => {
    expect(mobileHotbarFit(568, "row")).toEqual({ visible: 3, slider: true });
    expect(mobileHotbarFit(667, "row")).toEqual({ visible: 5, slider: true });
    expect(mobileHotbarFit(844, "row")).toEqual({ visible: 8, slider: true });
    expect(mobileHotbarFit(915, "row")).toEqual({ visible: 12, slider: false });
    // A notch on each side (47 px) costs slots, never the bar.
    expect(mobileHotbarFit(844 - 94, "row")).toEqual({ visible: 7, slider: true });
  });

  it("a screen on its side always shows more than half the slots a phone holds upright", () => {
    for (const w of [667, 740, 844, 915])
      expect(mobileHotbarFit(w, "row").visible).toBeGreaterThanOrEqual(4);
  });

  it("puts the section buttons beside the pad, or in rows without it", () => {
    // 9 buttons: the 8 sections and the menu. Beside the 146 px pad of a 390 px phone, 4.
    expect(consoleColumns(390, 146, 11)).toBe(4);
    expect(consoleColumns(360, 146, 11)).toBe(4);
    expect(consoleColumns(320, 146, 11)).toBe(3);
    expect(consoleColumns(390, 0, 11)).toBe(7);
    expect(consoleColumns(768, 146, 11)).toBe(11);
    expect(consoleColumns(100, 146, 11)).toBe(1);
  });
});
