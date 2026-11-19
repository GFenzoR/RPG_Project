import { describe, expect, it } from "vitest";
import {
  KEY_STEP,
  MAX_CONTAINER_PLACES,
  MIN_SIZE,
  SNAP_PX,
  WINDOW_IDS,
  WINDOW_KEYS,
  WINDOWS_VERSION,
  clampPlace,
  clampSize,
  closeWindow,
  collapseWindow,
  containerKeys,
  containersTop,
  defaultWindows,
  focusWindow,
  isClosable,
  keptHeight,
  loadWindows,
  moveWindow,
  openWindow,
  openWindows,
  pageOrder,
  placeOf,
  placeWindow,
  resetWindows,
  resizeWindow,
  saveWindows,
  serverWindows,
  shownKey,
  snapPlace,
  syncWindows,
  toggleWindow,
  topWindow,
  windowForHighlight,
  windowKey,
  windowNudge,
} from "./windows.ts";
import type { NudgeContext, Rect, WinKey } from "./windows.ts";

describe("default windows", () => {
  it("opens the battle list, the equipment and the chat, all floating", () => {
    const s = defaultWindows();
    expect(openWindows(s)).toEqual(["battle", "inventory", "chat"]);
    expect(s.win.guild).toEqual({ open: false, collapsed: false });
    expect(s.win.battle.x).toBeUndefined(); // at its default place (windows.css)
    for (const id of WINDOW_IDS) expect(s.win[id]).toBeDefined();
    // Nothing raised yet: Escape opens the options (as with the old dock).
    expect(topWindow(s)).toBeUndefined();
  });
});

describe("opening, closing and stacking", () => {
  it("toggles a window and remembers where it was", () => {
    let s = moveWindow(toggleWindow(defaultWindows(), "skills"), "skills", 40, 300);
    expect(openWindows(s)).toEqual(["battle", "inventory", "chat", "skills"]);
    s = toggleWindow(s, "skills");
    expect(openWindows(s)).toEqual(["battle", "inventory", "chat"]);
    s = toggleWindow(s, "skills");
    expect(s.win.skills).toMatchObject({ open: true, x: 40, y: 300 });
  });

  it("puts the last opened window on top, and Escape closes that one", () => {
    let s = openWindow(defaultWindows(), "guild");
    s = openWindow(s, "options");
    expect(openWindows(s)).toEqual(["battle", "inventory", "chat", "guild", "options"]);
    expect(topWindow(s)).toBe("options");
    s = focusWindow(s, "guild");
    expect(openWindows(s).slice(-2)).toEqual(["options", "guild"]);
    s = closeWindow(s, "guild");
    expect(topWindow(s)).toBe("options");
    expect(s.z).not.toContain("guild");
    // A window touched comes on top too (the battle list, raised by a click).
    s = focusWindow(s, "battle");
    expect(openWindows(s).at(-1)).toBe("battle");
    expect(topWindow(s)).toBe("battle");
  });

  it("raising a window changes only its stacking: in the page they keep one order", () => {
    let s = syncWindows(openWindow(defaultWindows(), "skills"), [
      "dialog",
      "container-bag-2",
      "container-bag",
    ]);
    const page = pageOrder(openWindows(s));
    expect(page).toEqual([
      "battle",
      "inventory",
      "skills",
      "chat",
      "dialog",
      "container-bag",
      "container-bag-2",
    ]);
    // Touched, the battle list and a container come on top; their nodes stay where they
    // were (moved, a node replays its opening animation and loses its focus and scroll).
    for (const id of ["battle", "container-bag", "chat"] as const) {
      s = focusWindow(s, id);
      expect(openWindows(s).at(-1)).toBe(id);
      expect(pageOrder(openWindows(s))).toEqual(page);
    }
  });

  it("never closes the chat: it only folds, and Escape skips it", () => {
    let s = focusWindow(defaultWindows(), "chat");
    expect(isClosable("chat")).toBe(false);
    expect(closeWindow(s, "chat")).toBe(s);
    expect(topWindow(s)).toBeUndefined();
    s = collapseWindow(s, "chat", true);
    expect(s.win.chat).toMatchObject({ open: true, collapsed: true });
    expect(openWindow(s, "chat").win.chat.collapsed).toBe(false);
  });

  it("unfolds a folded window when it is opened again", () => {
    let s = collapseWindow(defaultWindows(), "inventory", true);
    expect(s.win.inventory.collapsed).toBe(true);
    s = openWindow(s, "inventory");
    expect(s.win.inventory).toMatchObject({ open: true, collapsed: false });
  });

  it("returns the same state when nothing changes", () => {
    let s = defaultWindows();
    expect(closeWindow(s, "guild")).toBe(s);
    expect(collapseWindow(s, "battle", false)).toBe(s);
    s = focusWindow(s, "battle");
    expect(focusWindow(s, "battle")).toBe(s);
    s = placeWindow(s, "battle", 10, 20);
    expect(placeWindow(s, "battle", 10.2, 19.8)).toBe(s);
  });

  it("placing keeps the stacking; moving brings the window on top", () => {
    let s = openWindow(openWindow(defaultWindows(), "guild"), "help");
    s = placeWindow(s, "guild", 5, 6);
    expect(topWindow(s)).toBe("help");
    s = moveWindow(s, "guild", 100.4, 40.6);
    expect(s.win.guild).toMatchObject({ x: 100, y: 41 });
    expect(topWindow(s)).toBe("guild");
  });
});

describe("the magnet (docs/17 UI-5: free windows that snap)", () => {
  const area = { width: 1280, height: 712 };
  const at = (x: number, y: number, width = 256, height = 200): Rect => ({ x, y, width, height });

  it("snaps to the screen's edges and the bar's top within SNAP_PX", () => {
    expect(snapPlace(at(7, 9), area, [])).toEqual({ x: 0, y: 0 });
    expect(snapPlace(at(1280 - 256 - 6, 712 - 200 - SNAP_PX), area, [])).toEqual({
      x: 1024,
      y: 512,
    });
    // Farther than SNAP_PX: it stays where it was dropped.
    expect(snapPlace(at(SNAP_PX + 1, 300), area, [])).toEqual({ x: SNAP_PX + 1, y: 300 });
  });

  it("snaps beside another window, edge to edge, on either side", () => {
    const battle = at(0, 0, 256, 300);
    // Dropped just right of the battle list, overlapping it a little: its left edge goes
    // to the battle's right edge.
    expect(snapPlace(at(250, 40), area, [battle])).toEqual({ x: 256, y: 40 });
    // Just under it: its top to the battle's bottom, and its left aligned with it.
    expect(snapPlace(at(6, 306), area, [battle])).toEqual({ x: 0, y: 300 });
    // Left of a window on the right: its right edge to that one's left edge.
    const inv = at(1024, 0, 256, 260);
    expect(snapPlace(at(1024 - 256 + 8, 120), area, [inv])).toEqual({ x: 768, y: 120 });
  });

  it("aligns with another window's edges when side by side or one over the other", () => {
    const skills = at(300, 100, 256, 300);
    // Beside it (touching), 7 px lower: the tops align.
    expect(snapPlace(at(556, 107), area, [skills])).toEqual({ x: 556, y: 100 });
    // Under it, 5 px to the right: the left edges align; and the right edges too when
    // that one is nearer (a window of the same width).
    expect(snapPlace(at(305, 400), area, [skills])).toEqual({ x: 300, y: 400 });
    // A far window never pulls: 400 px under it, its left edge is ignored.
    expect(snapPlace(at(305, 700 - 200), area, [at(300, 0, 256, 100)])).toEqual({
      x: 305,
      y: 500,
    });
  });

  it("takes the nearest edge, and keeps the whole window inside the area", () => {
    const a = at(400, 0, 200, 100);
    const b = at(612, 0, 200, 100);
    // Between the two: 3 px from a's right edge, 5 from b's left one.
    expect(snapPlace(at(603, 30, 4, 50), area, [a, b])).toEqual({ x: 600, y: 30 });
    // Dragged off the screen: back inside, never under the bar.
    expect(snapPlace(at(-300, 900), area, [])).toEqual({ x: 0, y: 512 });
    expect(snapPlace(at(5000, -40), area, [])).toEqual({ x: 1024, y: 0 });
  });

  it("keeps all of a window on screen; a larger one sits at the top left", () => {
    const size = { width: 300, height: 400 };
    expect(clampPlace(50, 60, size, area)).toEqual({ x: 50, y: 60 });
    expect(clampPlace(-1000, -20, size, area)).toEqual({ x: 0, y: 0 });
    expect(clampPlace(5000, 5000, size, area)).toEqual({ x: 980, y: 312 });
    expect(clampPlace(40, 40, { width: 2000, height: 900 }, area)).toEqual({ x: 0, y: 0 });
  });
});

describe("remembered per device", () => {
  it("survives a save and a load", () => {
    let s = openWindow(defaultWindows(), "guild");
    s = moveWindow(s, "guild", 320, 48);
    s = collapseWindow(s, "battle", true);
    s = resizeWindow(s, "chat", 420, 200);
    expect(loadWindows(saveWindows(s))).toEqual(s);
    expect(JSON.parse(saveWindows(s))).toMatchObject({ v: WINDOWS_VERSION });
  });

  it("falls back to the defaults on anything unreadable", () => {
    const d = defaultWindows();
    expect(loadWindows(null)).toEqual(d);
    expect(loadWindows("{")).toEqual(d);
    expect(loadWindows("[]")).toEqual(d);
    expect(loadWindows(JSON.stringify({ v: 9, win: {} }))).toEqual(d);
    expect(loadWindows(JSON.stringify({ v: 2, win: {} }))).toEqual(d);
  });

  it("drops unknown windows and junk, and keeps the chat open", () => {
    const raw = JSON.stringify({
      v: 3,
      z: ["guild", "battle", "nope", "guild", "skills"],
      win: {
        nope: { open: true },
        guild: { open: true, x: "a", y: 12.7 },
        battle: { open: "yes" },
        chat: { open: false, collapsed: true },
      },
    });
    const s = loadWindows(raw);
    expect(s.z).toEqual(["guild", "battle"]); // skills is closed: no stacking
    expect(s.win.guild).toEqual({
      open: true,
      collapsed: false,
      x: undefined,
      y: 13,
      w: undefined,
      h: undefined,
    });
    expect(s.win.battle.open).toBe(true); // the default
    expect(s.win.chat).toMatchObject({ open: true, collapsed: true });
    expect("nope" in s.win).toBe(false);
  });

  it("moves the docked windows of before (versions 1 and 2) out to their default places", () => {
    const v1 = JSON.stringify({
      v: 1,
      order: ["battle", "inventory", "skills", "party"],
      z: ["guild"],
      win: {
        battle: { open: true, dock: true, collapsed: false, h: 300 },
        inventory: { open: true, dock: true, collapsed: true },
        guild: { open: true, dock: false, collapsed: false, x: 40, y: 50, w: 400 },
      },
    });
    const s = loadWindows(v1);
    expect(s.win.battle).toEqual({ open: true, collapsed: false });
    expect(s.win.inventory).toEqual({ open: true, collapsed: true });
    expect(s.win.guild).toMatchObject({ open: true, x: 40, y: 50, w: 400 });
    expect(s.z).toEqual(["guild"]);
    expect("order" in s).toBe(false);
    const v2 = JSON.stringify({
      v: 2,
      order: ["battle", "container-backpack"],
      z: [],
      win: {},
      others: {
        "container-backpack": { dock: true, collapsed: false, h: 120 },
        "container-bag": { dock: false, collapsed: false, x: 24, y: 300, w: 240 },
      },
    });
    const t = loadWindows(v2);
    expect(placeOf(t, "container-backpack")).toEqual({ open: false, collapsed: false });
    expect(placeOf(t, "container-bag")).toMatchObject({ open: false, x: 24, y: 300, w: 240 });
    // Saved again, it is a version 3 without any dock.
    expect(saveWindows(t)).not.toContain("dock");
  });
});

describe("keys", () => {
  it("toggles the window of each key, never with a modifier or a movement key", () => {
    const s = defaultWindows();
    expect(windowKey(s, { code: "KeyK" })?.win.skills.open).toBe(true);
    expect(windowKey(s, { code: "KeyI" })?.win.inventory.open).toBe(false);
    expect(windowKey(s, { code: "KeyK", ctrlKey: true })).toBeUndefined();
    for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "Digit1", "F1", "Enter"])
      expect(windowKey(s, { code })).toBeUndefined();
    expect(Object.keys(WINDOW_KEYS)).not.toContain("KeyW");
  });

  it("Escape closes the window on top, else opens the options", () => {
    let s = openWindow(defaultWindows(), "guild");
    s = windowKey(s, { code: "Escape" }) ?? s;
    expect(s.win.guild.open).toBe(false);
    // The battle list and the equipment of the start were never raised: they stay.
    s = windowKey(s, { code: "Escape" }) ?? s;
    expect(topWindow(s)).toBe("options");
    expect(s.win.inventory.open).toBe(true);
  });

  it("opens the window a tutorial step highlights", () => {
    expect(windowForHighlight("inventory")).toBe("inventory");
    expect(windowForHighlight("skills")).toBe("skills");
    expect(windowForHighlight("chat")).toBe("chat");
    expect(windowForHighlight("hotbar")).toBeUndefined();
    expect(windowForHighlight(undefined)).toBeUndefined();
  });
});

describe("the server's windows and the containers (docs/17 UI-5)", () => {
  it("follow the server: open what it opens, on top, and close the rest", () => {
    let s = syncWindows(defaultWindows(), ["dialog", "container-backpack"]);
    // Opened together, the dialog comes over the container.
    expect(openWindows(s)).toEqual(["battle", "inventory", "chat", "container-backpack", "dialog"]);
    s = syncWindows(s, ["dialog", "shop", "container-backpack"]);
    expect(topWindow(s)).toBe("shop");
    expect(syncWindows(s, ["dialog", "shop", "container-backpack"])).toBe(s);
    s = syncWindows(s, ["container-backpack"]);
    expect(openWindows(s)).toEqual(["battle", "inventory", "chat", "container-backpack"]);
    expect(placeOf(s, "dialog")).toMatchObject({ open: false });
    // Toolbar windows are never the server's to close.
    expect(syncWindows(s, ["inventory", "container-backpack"]).win.inventory.open).toBe(true);
  });

  it("keep where the player put them, also closed and after a reload", () => {
    let s = syncWindows(defaultWindows(), ["market", "container-bag"]);
    s = moveWindow(s, "container-bag", 300, 120);
    s = resizeWindow(s, "container-bag", 260.4, 180);
    s = syncWindows(s, []);
    const back = syncWindows(loadWindows(saveWindows(s)), ["market", "container-bag"]);
    expect(placeOf(back, "container-bag")).toMatchObject({
      open: true,
      x: 300,
      y: 120,
      w: 260,
      h: 180,
    });
    // Saved closed: the server opens them again.
    const loaded = loadWindows(saveWindows(back));
    expect(placeOf(loaded, "market").open).toBe(false);
    expect(loaded.z).toEqual([]);
  });

  it("Escape closes a server window on top like any other", () => {
    let s = openWindow(defaultWindows(), "guild");
    s = syncWindows(s, ["market"]);
    s = windowKey(s, { code: "Escape" }) ?? s;
    expect(placeOf(s, "market").open).toBe(false);
    expect(topWindow(s)).toBe("guild");
  });

  it("forget unknown keys and old containers past the limit", () => {
    const others: Record<string, unknown> = { chat: {}, "container-x y": {} };
    others["market"] = {};
    for (let i = 0; i < MAX_CONTAINER_PLACES + 5; i++) others[`container-bag${i}`] = {};
    const s = loadWindows(JSON.stringify({ v: 3, win: {}, others }));
    // The last ones saved are the ones that changed last: the first five go.
    const kept = Array.from({ length: MAX_CONTAINER_PLACES }, (_, i) => `container-bag${i + 5}`);
    expect(Object.keys(s.others)).toEqual(["market", ...kept]);
    expect("chat" in s.others).toBe(false);
  });

  it("saves the containers whose windows changed last, up to the limit", () => {
    let s = defaultWindows();
    const bag = (i: number): WinKey => `container-bag${i}` as WinKey;
    for (let i = 0; i < MAX_CONTAINER_PLACES + 6; i++) s = syncWindows(s, ["market", bag(i)]);
    s = moveWindow(s, bag(0), 40, 50); // the first one seen, moved now
    const saved = JSON.parse(saveWindows(s)) as { others: Record<string, unknown> };
    const containers = Object.keys(saved.others).filter((id) => id.startsWith("container-"));
    expect(containers).toHaveLength(MAX_CONTAINER_PLACES);
    expect(containers.at(-1)).toBe(bag(0));
    for (let i = 1; i <= 6; i++) expect(containers).not.toContain(bag(i));
    expect(containers).toContain(bag(7));
    expect("market" in saved.others).toBe(true);
    const loaded = loadWindows(JSON.stringify(saved));
    expect(placeOf(loaded, bag(0))).toMatchObject({ x: 40, y: 50 });
  });

  it("reset keeps the open ones open, at their default places", () => {
    let s = syncWindows(defaultWindows(), ["dialog", "container-bag"]);
    s = moveWindow(s, "container-bag", 10, 10);
    s = moveWindow(s, "chat", 500, 10);
    s = resetWindows(s);
    expect(placeOf(s, "container-bag")).toEqual({ open: true, collapsed: false });
    expect(s.win.chat).toEqual({ open: true, collapsed: false });
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

  it("opens the remains of every family in one place, not one per kind of remains", () => {
    // A wolf's and a crab's remains (and a player's) are fixed containers: one place.
    let keys = containerKeys(new Map(), [
      { id: 3, item: "remains_fur", fixed: true },
      { id: 5, item: "backpack" },
    ]);
    expect([...keys]).toEqual([
      [3, "container-remains"],
      [5, "container-backpack"],
    ]);
    // The wolf's closes; the crab's opens where the wolf's was.
    keys = containerKeys(keys, [
      { id: 5, item: "backpack" },
      { id: 8, item: "remains_chitin", fixed: true },
    ]);
    expect(keys.get(8)).toBe("container-remains");
    // Two open at once: the second beside it, as two backpacks.
    keys = containerKeys(keys, [
      { id: 8, item: "remains_chitin", fixed: true },
      { id: 9, item: "creature_remains", fixed: true },
    ]);
    expect(keys.get(9)).toBe("container-remains-2");
  });
});

describe("size and keyboard (docs/17 UI-1, UI-5)", () => {
  const area = { width: 1000, height: 700 };
  const ctx = (
    x: number,
    y: number,
    width = 200,
    height = 150,
    others: Rect[] = [],
  ): NudgeContext => ({
    rect: { x, y, width, height },
    area,
    others,
  });

  it("never makes a window smaller than its minimum or larger than the area", () => {
    expect(clampSize(10, 10, area)).toEqual({ width: MIN_SIZE.width, height: MIN_SIZE.height });
    expect(clampSize(5000, 300.6, area)).toEqual({ width: 1000, height: 301 });
  });

  it("moves a window with the arrows and resizes it with Shift", () => {
    let s = moveWindow(defaultWindows(), "inventory", 100, 100);
    s = windowNudge(s, "inventory", { key: "ArrowRight" }, ctx(100, 100)) ?? s;
    expect(s.win.inventory).toMatchObject({ x: 100 + KEY_STEP, y: 100 });
    s = windowNudge(s, "inventory", { key: "ArrowUp" }, ctx(0, 0)) ?? s;
    expect(s.win.inventory.y).toBe(0); // never above the top
    s = windowNudge(s, "inventory", { key: "ArrowDown", shiftKey: true }, ctx(0, 0)) ?? s;
    expect(s.win.inventory).toMatchObject({ w: 200, h: 150 + KEY_STEP });
    // Down to the bar's top at most: the room under the window.
    s = windowNudge(s, "inventory", { key: "ArrowDown", shiftKey: true }, ctx(0, 600)) ?? s;
    expect(s.win.inventory.h).toBe(100);
    // Its top left corner stays: a window never moved (the chat, hanging from the bar) is
    // pinned where it is, so it grows down and right, not up.
    s =
      windowNudge(defaultWindows(), "chat", { key: "ArrowUp", shiftKey: true }, ctx(140, 500)) ?? s;
    expect(s.win.chat).toMatchObject({ x: 140, y: 500, w: 200, h: 150 - KEY_STEP });
    expect(windowNudge(s, "inventory", { key: "KeyW" }, ctx(0, 0))).toBeUndefined();
    // Enter and Space no longer dock anything: the button does what buttons do.
    expect(windowNudge(s, "inventory", { key: "Enter" }, ctx(0, 0))).toBeUndefined();
    // Alt+Left is the browser's (back): never taken.
    expect(windowNudge(s, "inventory", { key: "ArrowLeft", altKey: true }, ctx(0, 0))).toBe(
      undefined,
    );
  });

  it("the arrows feel the magnet too: near an edge the window snaps to it", () => {
    let s = defaultWindows();
    // 20 px from the left edge, one step left (16) leaves it 4 px away: it snaps to 0.
    s = windowNudge(s, "battle", { key: "ArrowLeft" }, ctx(20, 300)) ?? s;
    expect(s.win.battle).toMatchObject({ x: 0, y: 300 });
    // Next to another window: one step down aligns its top with that one's.
    const other = { x: 200, y: 108, width: 200, height: 150 };
    s = windowNudge(s, "battle", { key: "ArrowDown" }, ctx(0, 90, 200, 150, [other])) ?? s;
    expect(s.win.battle).toMatchObject({ x: 0, y: 108 });
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

describe("keeping a placed window inside after the area changed (keptHeight)", () => {
  const never = (): number => {
    throw new Error("measured although it showed enough");
  };

  it("leaves where it is a window that still shows MIN_SIZE.height, its body scrolling", () => {
    // A battle list grown past the bar, squashed to 150 by its max-height: it stays.
    expect(keptHeight(150, never)).toBe(150);
    expect(keptHeight(MIN_SIZE.height, never)).toBe(MIN_SIZE.height);
  });

  it("takes the whole height of one squashed under MIN_SIZE.height", () => {
    // Its top below the new area: the max-height left it a 4 px box (the review's chat
    // against the bar). Measured so, clampPlace left it at area - 4, its title bar over
    // the bar; with its own 300 px it moves up until it shows whole.
    expect(keptHeight(4, () => 300)).toBe(300);
    const area = { width: 1000, height: 500 };
    expect(clampPlace(20, 640, { width: 384, height: keptHeight(4, () => 300) }, area)).toEqual({
      x: 20,
      y: 200,
    });
    // Unfolded against the bar: its max-height still that of its title bar.
    expect(keptHeight(28, () => 260)).toBe(260);
  });

  it("keeps a short window short: a folded one is its title bar", () => {
    // A folded chat snapped to the bar (28 px, not squashed) does not move up.
    expect(keptHeight(28, () => 28)).toBe(28);
    const area = { width: 1000, height: 500 };
    expect(clampPlace(20, 472, { width: 384, height: keptHeight(28, () => 28) }, area)).toEqual({
      x: 20,
      y: 472,
    });
  });
});

describe("the windows shown (shownKey)", () => {
  it("changes when a window opens, closes, folds or unfolds, not when one is raised", () => {
    const s = defaultWindows();
    const key = shownKey(s);
    expect(key).toBe("battle chat inventory");
    expect(shownKey(focusWindow(s, "battle"))).toBe(key);
    expect(shownKey(moveWindow(s, "battle", 10, 10))).toBe(key);
    expect(shownKey(openWindow(s, "skills"))).not.toBe(key);
    expect(shownKey(closeWindow(s, "battle"))).not.toBe(key);
    const folded = collapseWindow(s, "chat", true);
    expect(shownKey(folded)).toBe("battle chat:folded inventory");
    expect(shownKey(collapseWindow(folded, "chat", false))).toBe(key);
    // A container the server opens counts too.
    expect(shownKey(syncWindows(s, ["container-bag"]))).toBe("battle chat container-bag inventory");
  });
});

describe("the containers' default column (containersTop)", () => {
  const open = { open: true, collapsed: false };

  it("starts right under the equipment at its default place, however tall it is", () => {
    // The equipment of feat/equipment-d2 (the figure and the backpack under it) is about
    // 500 px tall: the old 15rem (240 px) opened every container over its backpack.
    expect(containersTop(open, 497.6)).toBe(498);
    expect(containersTop({ ...open, collapsed: true }, 27)).toBe(27);
  });

  it("starts at the top while the equipment is closed, moved or not measured yet", () => {
    expect(containersTop({ ...open, open: false }, 498)).toBe(0);
    expect(containersTop({ ...open, x: 300, y: 24 }, 498)).toBe(0);
    expect(containersTop(open, undefined)).toBe(0);
  });
});
