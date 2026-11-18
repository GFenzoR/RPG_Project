import { describe, expect, it } from "vitest";
import {
  WINDOW_IDS,
  WINDOW_KEYS,
  clampPlace,
  closeWindow,
  collapseWindow,
  defaultWindows,
  dockWindow,
  dockedWindows,
  floatWindow,
  floatingWindows,
  focusWindow,
  loadWindows,
  openWindow,
  saveWindows,
  toggleWindow,
  topWindow,
  windowForHighlight,
  windowKey,
} from "./windows.ts";

describe("default windows", () => {
  it("opens the battle list and the equipment in the dock, as in Tibia", () => {
    const s = defaultWindows();
    expect(dockedWindows(s)).toEqual(["battle", "inventory"]);
    expect(floatingWindows(s)).toEqual([]);
    expect(s.win.guild).toMatchObject({ open: false, dock: false });
    for (const id of WINDOW_IDS) expect(s.win[id]).toBeDefined();
  });
});

describe("opening, closing and stacking", () => {
  it("toggles a window and remembers where it was", () => {
    let s = toggleWindow(defaultWindows(), "skills");
    expect(dockedWindows(s)).toEqual(["battle", "inventory", "skills"]);
    s = toggleWindow(s, "skills");
    expect(dockedWindows(s)).toEqual(["battle", "inventory"]);
    expect(s.order).toContain("skills"); // keeps its place in the dock
  });

  it("puts the last opened floating window on top, and Escape closes that one", () => {
    let s = openWindow(defaultWindows(), "guild");
    s = openWindow(s, "options");
    expect(floatingWindows(s)).toEqual(["guild", "options"]);
    expect(topWindow(s)).toBe("options");
    s = focusWindow(s, "guild");
    expect(floatingWindows(s)).toEqual(["options", "guild"]);
    s = closeWindow(s, "guild");
    expect(topWindow(s)).toBe("options");
    expect(s.z).not.toContain("guild");
  });

  it("unfolds a folded window when it is opened again", () => {
    let s = collapseWindow(defaultWindows(), "inventory", true);
    expect(s.win.inventory.collapsed).toBe(true);
    s = openWindow(s, "inventory");
    expect(s.win.inventory).toMatchObject({ open: true, collapsed: false });
  });

  it("returns the same state when nothing changes", () => {
    const s = defaultWindows();
    expect(closeWindow(s, "guild")).toBe(s);
    expect(collapseWindow(s, "battle", false)).toBe(s);
    expect(focusWindow(s, "battle")).toBe(s); // docked: no stacking
  });
});

describe("dock and float", () => {
  it("takes a window out of the dock and back in before another", () => {
    let s = floatWindow(defaultWindows(), "inventory", 100.4, 40.6);
    expect(s.win.inventory).toMatchObject({ open: true, dock: false, x: 100, y: 41 });
    expect(dockedWindows(s)).toEqual(["battle"]);
    expect(topWindow(s)).toBe("inventory");
    s = dockWindow(s, "inventory", "battle");
    expect(dockedWindows(s)).toEqual(["inventory", "battle"]);
    expect(s.z).toEqual([]);
    s = dockWindow(s, "inventory", undefined);
    expect(dockedWindows(s)).toEqual(["battle", "inventory"]);
  });

  it("docks a floating window at the end when the window before is not docked", () => {
    let s = openWindow(defaultWindows(), "guild");
    s = dockWindow(s, "guild", "options");
    expect(dockedWindows(s)).toEqual(["battle", "inventory", "guild"]);
  });

  it("keeps the title bar of a floating window reachable", () => {
    const area = { width: 1000, height: 700 };
    const size = { width: 300, height: 400 };
    expect(clampPlace(50, 60, size, area)).toEqual({ x: 50, y: 60 });
    expect(clampPlace(-1000, -20, size, area)).toEqual({ x: -236, y: 0 });
    expect(clampPlace(5000, 5000, size, area)).toEqual({ x: 936, y: 668 });
  });
});

describe("remembered per device", () => {
  it("survives a save and a load", () => {
    let s = openWindow(defaultWindows(), "guild");
    s = floatWindow(s, "guild", 320, 48);
    s = collapseWindow(s, "battle", true);
    s = dockWindow(s, "party", "battle");
    expect(loadWindows(saveWindows(s))).toEqual(s);
  });

  it("falls back to the defaults on anything unreadable", () => {
    const d = defaultWindows();
    expect(loadWindows(null)).toEqual(d);
    expect(loadWindows("{")).toEqual(d);
    expect(loadWindows("[]")).toEqual(d);
    expect(loadWindows(JSON.stringify({ v: 2, win: {} }))).toEqual(d);
  });

  it("drops unknown windows and fixes a broken dock order", () => {
    const raw = JSON.stringify({
      v: 1,
      order: ["chat", "inventory", "inventory", 3],
      z: ["guild", "battle"],
      win: {
        chat: { open: true },
        guild: { open: true, dock: false, x: "a", y: 12.7 },
        battle: { open: "yes" },
      },
    });
    const s = loadWindows(raw);
    expect(s.order).toEqual(["inventory", "battle", "skills", "party"]);
    expect(s.z).toEqual(["guild"]); // battle is docked: no stacking
    expect(s.win.guild).toEqual({ open: true, dock: false, collapsed: false, x: undefined, y: 13 });
    expect(s.win.battle.open).toBe(true); // the default
    expect("chat" in s.win).toBe(false);
  });
});

describe("keys", () => {
  it("toggles the window of each key, never with a modifier or a movement key", () => {
    const s = defaultWindows();
    expect(windowKey(s, { code: "KeyK" })?.win.skills.open).toBe(true);
    expect(windowKey(s, { code: "KeyI" })?.win.inventory.open).toBe(false);
    expect(windowKey(s, { code: "KeyK", ctrlKey: true })).toBeUndefined();
    for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "Digit1", "F1"])
      expect(windowKey(s, { code })).toBeUndefined();
    expect(Object.keys(WINDOW_KEYS)).not.toContain("KeyW");
  });

  it("Escape closes the floating window on top, else opens the options", () => {
    let s = openWindow(defaultWindows(), "guild");
    s = windowKey(s, { code: "Escape" }) ?? s;
    expect(s.win.guild.open).toBe(false);
    s = windowKey(s, { code: "Escape" }) ?? s;
    expect(topWindow(s)).toBe("options");
  });

  it("opens the window a tutorial step highlights", () => {
    expect(windowForHighlight("inventory")).toBe("inventory");
    expect(windowForHighlight("skills")).toBe("skills");
    expect(windowForHighlight("hotbar")).toBeUndefined();
    expect(windowForHighlight(undefined)).toBeUndefined();
  });
});
