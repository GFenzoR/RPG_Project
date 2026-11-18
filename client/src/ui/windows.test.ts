import { describe, expect, it } from "vitest";
import {
  KEY_STEP,
  MAX_CONTAINER_PLACES,
  MIN_SIZE,
  WINDOW_IDS,
  WINDOW_KEYS,
  clampPlace,
  clampSize,
  containerKeys,
  closeWindow,
  collapseWindow,
  defaultWindows,
  dockWindow,
  dockedWindows,
  floatWindow,
  floatingWindows,
  focusWindow,
  loadWindows,
  moveInDock,
  openWindow,
  placeOf,
  resetWindows,
  resizeWindow,
  saveWindows,
  serverWindows,
  syncWindows,
  toggleWindow,
  topWindow,
  windowForHighlight,
  windowKey,
  windowNudge,
} from "./windows.ts";
import type { NudgeContext, WinKey } from "./windows.ts";

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

describe("the server's windows and the containers (docs/17 UI-5)", () => {
  it("follow the server: open what it opens, on top or in the dock, and close the rest", () => {
    let s = syncWindows(defaultWindows(), ["dialog", "container-backpack"]);
    expect(floatingWindows(s)).toEqual(["dialog"]);
    // A container opens in the dock, under what is there.
    expect(dockedWindows(s)).toEqual(["battle", "inventory", "container-backpack"]);
    s = syncWindows(s, ["dialog", "shop", "container-backpack"]);
    expect(topWindow(s)).toBe("shop");
    expect(syncWindows(s, ["dialog", "shop", "container-backpack"])).toBe(s);
    s = syncWindows(s, ["container-backpack"]);
    expect(floatingWindows(s)).toEqual([]);
    expect(placeOf(s, "dialog")).toMatchObject({ open: false, dock: false });
    // Toolbar windows are never the server's to close.
    expect(syncWindows(s, ["inventory", "container-backpack"]).win.inventory.open).toBe(true);
  });

  it("keep where the player put them, also closed and after a reload", () => {
    let s = syncWindows(defaultWindows(), ["market", "container-bag"]);
    s = floatWindow(s, "container-bag", 300, 120);
    s = dockWindow(s, "market", "battle");
    s = resizeWindow(s, "container-bag", 260.4, 180);
    s = syncWindows(s, []);
    const back = syncWindows(loadWindows(saveWindows(s)), ["market", "container-bag"]);
    expect(placeOf(back, "container-bag")).toMatchObject({
      open: true,
      dock: false,
      x: 300,
      y: 120,
      w: 260,
      h: 180,
    });
    expect(dockedWindows(back)).toEqual(["market", "battle", "inventory"]);
    // Saved closed: the server opens them again.
    const loaded = loadWindows(saveWindows(back));
    expect(placeOf(loaded, "market").open).toBe(false);
  });

  it("Escape closes a floating server window on top like any other", () => {
    let s = openWindow(defaultWindows(), "guild");
    s = syncWindows(s, ["market"]);
    s = windowKey(s, { code: "Escape" }) ?? s;
    expect(placeOf(s, "market").open).toBe(false);
    expect(topWindow(s)).toBe("guild");
  });

  it("forget unknown keys and old containers past the limit", () => {
    const others: Record<string, unknown> = { chat: { dock: true }, "container-x y": {} };
    others["market"] = { dock: true };
    for (let i = 0; i < MAX_CONTAINER_PLACES + 5; i++) others[`container-bag${i}`] = { dock: true };
    const s = loadWindows(JSON.stringify({ v: 2, win: {}, others }));
    // The last ones saved are the ones that changed last: the first five go.
    const kept = Array.from({ length: MAX_CONTAINER_PLACES }, (_, i) => `container-bag${i + 5}`);
    expect(Object.keys(s.others)).toEqual(["market", ...kept]);
    expect("chat" in s.others).toBe(false);
  });

  it("saves the containers whose windows changed last, up to the limit", () => {
    let s = defaultWindows();
    const bag = (i: number): WinKey => `container-bag${i}` as WinKey;
    for (let i = 0; i < MAX_CONTAINER_PLACES + 6; i++) s = syncWindows(s, ["market", bag(i)]);
    s = floatWindow(s, bag(0), 40, 50); // the first one seen, moved now
    const saved = JSON.parse(saveWindows(s)) as { others: Record<string, unknown> };
    const containers = Object.keys(saved.others).filter((id) => id.startsWith("container-"));
    expect(containers).toHaveLength(MAX_CONTAINER_PLACES);
    expect(containers.at(-1)).toBe(bag(0));
    for (let i = 1; i <= 6; i++) expect(containers).not.toContain(bag(i));
    expect(containers).toContain(bag(7));
    expect("market" in saved.others).toBe(true);
    const loaded = loadWindows(JSON.stringify(saved));
    expect(placeOf(loaded, bag(0))).toMatchObject({ dock: false, x: 40, y: 50 });
  });

  it("reset keeps the open ones open, at their default places", () => {
    let s = syncWindows(defaultWindows(), ["dialog", "container-bag"]);
    s = floatWindow(s, "container-bag", 10, 10);
    s = resetWindows(s);
    expect(placeOf(s, "container-bag")).toMatchObject({ open: true, dock: true });
    expect(placeOf(s, "dialog").open).toBe(true);
    expect(topWindow(s)).toBe("options");
  });

  it("give each open container a key that stays while it is open", () => {
    let keys = containerKeys(new Map(), [
      { id: 7, item: "backpack" },
      { id: 9, item: "backpack" },
      { id: 4, item: "bag" },
    ]);
    expect([...keys]).toEqual([
      [7, "container-backpack"],
      [9, "container-backpack-2"],
      [4, "container-bag"],
    ]);
    // The first backpack closes: the second keeps its key (and its place).
    keys = containerKeys(keys, [
      { id: 9, item: "backpack" },
      { id: 4, item: "bag" },
    ]);
    expect(keys.get(9)).toBe("container-backpack-2");
    keys = containerKeys(keys, [
      { id: 9, item: "backpack" },
      { id: 12, item: "backpack" },
    ]);
    expect(keys.get(12)).toBe("container-backpack");
  });
});

describe("size and keyboard (docs/17 UI-1, UI-5)", () => {
  const area = { width: 1000, height: 700 };
  const ctx = (x: number, y: number, width = 200, height = 150): NudgeContext => ({
    rect: { x, y, width, height },
    area,
    floatAt: { x: 500, y: 40 },
  });

  it("never makes a window smaller than its minimum or larger than the area", () => {
    expect(clampSize(10, 10, area)).toEqual({ width: MIN_SIZE.width, height: MIN_SIZE.height });
    expect(clampSize(5000, 300.6, area)).toEqual({ width: 1000, height: 301 });
  });

  it("a docked window keeps the dock's width: only its height changes", () => {
    const s = resizeWindow(defaultWindows(), "inventory", 400, 220);
    expect(s.win.inventory).toMatchObject({ w: undefined, h: 220 });
  });

  it("moves a floating window with the arrows and resizes it with Shift", () => {
    let s = floatWindow(defaultWindows(), "inventory", 100, 100);
    s = windowNudge(s, "inventory", { key: "ArrowRight" }, ctx(100, 100)) ?? s;
    expect(s.win.inventory).toMatchObject({ x: 100 + KEY_STEP, y: 100 });
    s = windowNudge(s, "inventory", { key: "ArrowUp" }, ctx(0, 0)) ?? s;
    expect(s.win.inventory.y).toBe(0); // never above the top
    s = windowNudge(s, "inventory", { key: "ArrowDown", shiftKey: true }, ctx(0, 0)) ?? s;
    expect(s.win.inventory).toMatchObject({ w: 200, h: 150 + KEY_STEP });
    expect(windowNudge(s, "inventory", { key: "KeyW" }, ctx(0, 0))).toBeUndefined();
    // Alt+Left is the browser's (back): never taken.
    expect(windowNudge(s, "inventory", { key: "ArrowLeft", altKey: true }, ctx(0, 0))).toBe(
      undefined,
    );
  });

  it("moves a docked window up and down the dock, and Enter floats or docks it", () => {
    let s = openWindow(defaultWindows(), "skills");
    s = windowNudge(s, "skills", { key: "ArrowUp" }, ctx(0, 0)) ?? s;
    expect(dockedWindows(s)).toEqual(["battle", "skills", "inventory"]);
    s = moveInDock(s, "battle", 2);
    expect(dockedWindows(s)).toEqual(["skills", "inventory", "battle"]);
    expect(moveInDock(s, "battle", 1)).toBe(s);
    s = windowNudge(s, "inventory", { key: "Enter" }, ctx(0, 0)) ?? s;
    expect(s.win.inventory).toMatchObject({ dock: false, x: 500, y: 40 });
    s = windowNudge(s, "inventory", { key: " " }, ctx(500, 40)) ?? s;
    expect(dockedWindows(s)).toEqual(["skills", "battle", "inventory"]);
  });
});

describe("which server windows show", () => {
  const none = {
    dialog: false,
    shop: false,
    station: false,
    market: false,
    house: false,
    trade: false,
  };
  it("keeps the old precedence: the shop with its dialog, the rest wait for the dialog", () => {
    expect(serverWindows({ ...none, shop: true }, [])).toEqual([]);
    expect(serverWindows({ ...none, dialog: true, shop: true, station: true }, [])).toEqual([
      "dialog",
      "shop",
    ]);
    expect(serverWindows({ ...none, market: true, house: true, trade: true }, [])).toEqual([
      "market",
      "trade",
    ]);
    expect(serverWindows({ ...none, station: true, house: true }, ["container-bag"])).toEqual([
      "crafting",
      "house",
      "container-bag",
    ]);
  });
});
