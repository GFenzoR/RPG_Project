import { describe, expect, it } from "vitest";
import {
  MAX_CONTAINER_PLACES,
  MIN_SIZE,
  SNAP_PX,
  WINDOW_IDS,
  WINDOW_KEYS,
  WINDOW_KEY_LABEL,
  WINDOWS_VERSION,
  clampPlace,
  cornerCursor,
  closeWindow,
  collapseWindow,
  containerKeys,
  containersTop,
  GIVE_WAY_MIN_PX,
  PLACE_GAP,
  defaultPlace,
  defaultWindows,
  movesAside,
  northOfPlayer,
  overlapArea,
  tutorialCovered,
  focusWindow,
  isClosable,
  isServerWindow,
  keptHeight,
  knownWindows,
  loadWindows,
  moveWindow,
  openWindow,
  openWindows,
  pageOrder,
  placeContext,
  placeOf,
  placeWindow,
  resetWindows,
  resizeFrom,
  resizeWindow,
  saveWindows,
  serverWindows,
  shownKey,
  snapPlace,
  syncWindows,
  toLookAt,
  toggleWindow,
  topWindow,
  windowForHighlight,
  windowKey,
} from "./windows.ts";
import type { Rect, WinKey, WindowsState } from "./windows.ts";

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
    // L: the quest log (docs/02 "Diario de misiones").
    expect(windowKey(s, { code: "KeyL" })?.win.quests.open).toBe(true);
    expect(WINDOW_KEY_LABEL.quests).toBe("L");
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

describe("resizing from the corners (docs/17 UI-5, resizeFrom)", () => {
  const area = { width: 1000, height: 700 };
  const start: Rect = { x: 300, y: 200, width: 240, height: 180 };

  it("moves the two edges of the corner and keeps the opposite corner where it was", () => {
    // Bottom right: x and y stay, the size grows.
    expect(resizeFrom("se", start, 40, 30, area)).toEqual({
      x: 300,
      y: 200,
      width: 280,
      height: 210,
    });
    // Top left: the window's x and y follow the pointer, its bottom right stays at 540, 380.
    expect(resizeFrom("nw", start, -40, -30, area)).toEqual({
      x: 260,
      y: 170,
      width: 280,
      height: 210,
    });
    // Top right: y moves, x stays; its bottom left stays at 300, 380.
    expect(resizeFrom("ne", start, 40, -30, area)).toEqual({
      x: 300,
      y: 170,
      width: 280,
      height: 210,
    });
    // Bottom left: x moves, y stays; its top right stays at 540, 200.
    expect(resizeFrom("sw", start, -40, 30, area)).toEqual({
      x: 260,
      y: 200,
      width: 280,
      height: 210,
    });
    // Shrinking from the top left moves the window right and down.
    expect(resizeFrom("nw", start, 50, 60, area)).toEqual({
      x: 350,
      y: 260,
      width: 190,
      height: 120,
    });
  });

  it("never under MIN_SIZE: the moving edge gives way, the opposite corner stays", () => {
    expect(resizeFrom("se", start, -500, -500, area)).toEqual({
      x: 300,
      y: 200,
      ...MIN_SIZE,
    });
    // Dragged past the opposite corner, the top left stops MIN_SIZE short of the bottom
    // right (540, 380).
    expect(resizeFrom("nw", start, 500, 500, area)).toEqual({
      x: 540 - MIN_SIZE.width,
      y: 380 - MIN_SIZE.height,
      ...MIN_SIZE,
    });
    expect(resizeFrom("ne", start, -500, 500, area)).toEqual({
      x: 300,
      y: 380 - MIN_SIZE.height,
      ...MIN_SIZE,
    });
    expect(resizeFrom("sw", start, 500, -500, area)).toEqual({
      x: 540 - MIN_SIZE.width,
      y: 200,
      ...MIN_SIZE,
    });
  });

  it("stays inside the area: never off the screen nor under the bar", () => {
    // The top left past the screen's corner stops at 0, 0; the bottom right stays.
    expect(resizeFrom("nw", start, -900, -900, area)).toEqual({
      x: 0,
      y: 0,
      width: 540,
      height: 380,
    });
    // The bottom right stops at the area's edges (the bar's top).
    expect(resizeFrom("se", start, 2000, 2000, area)).toEqual({
      x: 300,
      y: 200,
      width: 700,
      height: 500,
    });
    expect(resizeFrom("ne", start, 2000, -2000, area)).toEqual({
      x: 300,
      y: 0,
      width: 700,
      height: 380,
    });
    expect(resizeFrom("sw", start, -2000, 2000, area)).toEqual({
      x: 0,
      y: 200,
      width: 540,
      height: 500,
    });
    // A window against the right edge shrunk to its minimum from the left stays inside.
    const edge: Rect = { x: 900, y: 10, width: 100, height: 100 };
    const r = resizeFrom("sw", edge, 0, 0, area);
    expect(r.x + r.width).toBeLessThanOrEqual(area.width);
    expect(r).toMatchObject({ x: area.width - MIN_SIZE.width, width: MIN_SIZE.width });
  });

  it("feels the magnet: the screen's edges, the bar's top and the other windows'", () => {
    // 6 px from the left edge and 8 from the top: both snap to 0.
    expect(resizeFrom("nw", start, -294, -192, area)).toMatchObject({ x: 0, y: 0 });
    // 7 px short of the bar's top: the bottom snaps to it.
    expect(resizeFrom("se", start, 0, 313, area)).toMatchObject({ y: 200, height: 500 });
    // Beside another window: the right edge snaps to its left (both ways: to its right too).
    const other: Rect = { x: 600, y: 150, width: 200, height: 300 };
    expect(resizeFrom("se", start, 52, 0, area, [other])).toMatchObject({ x: 300, width: 300 });
    expect(resizeFrom("ne", start, 255, 0, area, [other])).toMatchObject({ width: 500 });
    // Over it on the other axis too, the top aligns with its top.
    expect(resizeFrom("ne", start, 52, -44, area, [other])).toEqual({
      x: 300,
      y: 150,
      width: 300,
      height: 230,
    });
    // Farther than SNAP_PX nothing pulls; nor does a window far on the other axis.
    expect(resizeFrom("se", start, 60 - SNAP_PX - 1, 0, area, [other]).width).toBe(
      240 + 60 - SNAP_PX - 1,
    );
    const far: Rect = { x: 600, y: 600, width: 200, height: 50 };
    expect(resizeFrom("se", start, 52, 0, area, [far]).width).toBe(292);
  });

  it("only the corners resize; the cursor follows their diagonal", () => {
    expect(cornerCursor("nw")).toBe("nwse-resize");
    expect(cornerCursor("se")).toBe("nwse-resize");
    expect(cornerCursor("ne")).toBe("nesw-resize");
    expect(cornerCursor("sw")).toBe("nesw-resize");
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
  it("shows the account stash next to a dialog or a trade", () => {
    expect(
      serverWindows({ ...none, dialog: true, trade: true, stash: true }, ["container-bag"]),
    ).toEqual(["dialog", "trade", "stash", "container-bag"]);
  });

  it('shows the reading window whatever else is open (docs/02 "Libros y cofres")', () => {
    expect(serverWindows({ ...none, book: true }, [])).toEqual(["book"]);
    expect(serverWindows({ ...none, dialog: true, book: true }, ["container-bag"])).toEqual([
      "dialog",
      "book",
      "container-bag",
    ]);
    // Remembered like the server's windows: it reopens where the player left it.
    expect(isServerWindow("book")).toBe(true);
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

describe("a factory place that sees the open windows (defaultPlace)", () => {
  // The windows' area at 1280x800 (the bar takes 88 px) and at 960x700 (the desktop app).
  const wide = { width: 1280, height: 712 };
  const app = { width: 960, height: 612 };
  const box = (id: WinKey, x: number, y: number, width: number, height: number) => ({
    id,
    rect: { x, y, width, height },
  });
  const battle = box("battle", 0, 0, 256, 352);
  const inventory = box("inventory", 1024, 0, 256, 500);
  const chat = box("chat", 144, 512, 384, 200);
  const covers = (a: Rect, b: Rect) => overlapArea(a, b) > 0;

  it("keeps the usual place when it covers nothing", () => {
    const skills = { x: 0, y: 356, width: 256, height: 150 };
    expect(defaultPlace("skills", skills, [battle, inventory, chat], wide)).toBeUndefined();
    const trade = { x: 464, y: 0, width: 352, height: 300 };
    // The player low enough: the tiles north of it are under the trade's usual place.
    const low = { x: 608, y: 600, width: 64, height: 64 };
    expect(defaultPlace("trade", trade, [battle, inventory], wide, low)).toBeUndefined();
  });

  // The player's tile at 1280x800: the centre of the map at 2x (Game.selfTile, and the
  // preview's), 640 - 32 by 356 - 32.
  const centre = { x: 608, y: 324, width: 64, height: 64 };

  it("never puts the trade over the 3 tiles north of the player: it slides along the top", () => {
    const trade = { x: 464, y: 0, width: 352, height: 300 };
    const zone = northOfPlayer(centre);
    expect(zone).toEqual({ x: 608, y: 132, width: 64, height: 256 });
    expect(covers(trade, zone)).toBe(true);
    const at = defaultPlace("trade", trade, [battle, inventory, chat], wide, centre);
    // Between the battle list (to x 256) and the column (from x 608) there are exactly
    // the trade's 352 px: with the gap it covered 4 px of the battle list; flush against
    // both it covers nothing.
    expect(at).toEqual({ x: 608 - 352, y: 0, width: 352, height: 300 });
    if (!at) throw new Error("no place");
    expect(covers(at, battle.rect)).toBe(false);
    expect(covers(at, zone)).toBe(false);
  });

  it("keeps the gap beside a window when there is room for it", () => {
    // A narrower battle list: the place left of the column, PLACE_GAP away, is clear.
    const narrow = box("battle", 0, 0, 200, 352);
    const trade = { x: 464, y: 0, width: 352, height: 300 };
    const at = defaultPlace("trade", trade, [narrow, inventory], wide, centre);
    expect(at?.x).toBe(608 - PLACE_GAP - 352);
  });

  it("takes the place that covers least when every place covers something, never the column", () => {
    const trade = { x: 464, y: 0, width: 352, height: 300 };
    const party = box("party", 256, 0, 256, 300);
    const guild = box("guild", 720, 0, 304, 120);
    const at = defaultPlace("trade", trade, [battle, party, guild, inventory], wide, centre);
    if (!at) throw new Error("no place");
    expect(covers(at, northOfPlayer(centre))).toBe(false);
    // Right of the column it covers the short guild window, left of it the tall party;
    // flush against the column it leaves the inventory alone.
    expect(at.x).toBe(608 + 64);
    expect(covers(at, guild.rect)).toBe(true);
    expect(covers(at, inventory.rect)).toBe(false);
  });

  it("moves the trade off another window even with the player far away", () => {
    // 1920x1080: the help moved to the top centre, where the trade opens.
    const full = { width: 1920, height: 992 };
    const trade = { x: 784, y: 0, width: 352, height: 300 };
    const help = box("help", 760, 0, 400, 200);
    const right = box("inventory", 1664, 0, 256, 500);
    const at = defaultPlace("trade", trade, [battle, help, right], full);
    // The nearest place clear of all three, against the help's left side.
    expect(at).toEqual({ x: 760 - PLACE_GAP - 352, y: 0, width: 352, height: 300 });
  });

  it("shortens the dialog at 960x700 to the equipment's foot, its bottom where it was", () => {
    // The shop and dialog pair: the dialog reaches the equipment's column by 10 px.
    const dialog = { x: 592, y: 306, width: 352, height: 300 };
    const equipment = box("inventory", 704, 0, 256, 316);
    const shop = box("shop", 8, 166, 576, 440);
    const at = defaultPlace("dialog", dialog, [equipment, shop, battle], app);
    expect(at).toEqual({ x: 592, y: 320, width: 352, height: 286, short: true });
    // A station or the market at the bottom centre give way the same way.
    expect(defaultPlace("crafting", dialog, [equipment], app)?.y).toBe(320);
  });

  it("keeps a window over the bar where it is when giving way would leave it too short", () => {
    const dialog = { x: 592, y: 306, width: 352, height: 300 };
    const tall = box("inventory", 704, 0, 256, 520);
    expect(606 - (520 + PLACE_GAP)).toBeLessThan(GIVE_WAY_MIN_PX);
    expect(defaultPlace("dialog", dialog, [tall], app)).toBeUndefined();
  });

  it("puts the skills under the battle list only while they fit above the chat", () => {
    const skills = { x: 0, y: 356, width: 256, height: 330 };
    expect(covers(skills, chat.rect)).toBe(true);
    // Beside the battle list.
    expect(defaultPlace("skills", skills, [battle, inventory, chat], wide)).toEqual({
      x: 256,
      y: 0,
      width: 256,
      height: 330,
    });
    // The party is there: beside the party.
    const party = box("party", 256, 0, 256, 300);
    expect(defaultPlace("skills", skills, [battle, party, inventory, chat], wide)?.x).toBe(512);
  });

  it("shortens the skills above the chat when every other place is taken", () => {
    const skills = { x: 0, y: 356, width: 256, height: 330 };
    const party = box("party", 256, 0, 256, 400);
    const guild = box("guild", 624, 0, 400, 500);
    const low = box("chat", 144, 560, 384, 152);
    const at = defaultPlace("skills", skills, [battle, party, guild, inventory, low], wide);
    expect(at).toEqual({ x: 0, y: 356, width: 256, height: 560 - PLACE_GAP - 356, short: true });
  });

  it("leaves the windows without other places where windows.css puts them", () => {
    const options = { x: 480, y: 57, width: 320, height: 400 };
    const help = box("help", 440, 57, 400, 500);
    expect(movesAside("options")).toBe(false);
    expect(defaultPlace("options", options, [help], wide)).toBeUndefined();
    expect(movesAside("trade") && movesAside("dialog") && movesAside("skills")).toBe(true);
  });

  it("does not count edges that only touch", () => {
    expect(
      overlapArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }),
    ).toBe(0);
    expect(
      overlapArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 9.5, y: 0, width: 5, height: 5 }),
    ).toBe(0);
    expect(
      overlapArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 8, y: 2, width: 5, height: 5 }),
    ).toBe(10);
  });
});

describe("which windows are looked at for a place that sees the others (toLookAt)", () => {
  const open = (s: WindowsState) => new Set(knownWindows(s).filter((id) => placeOf(s, id).open));
  const look = (s: WindowsState, dialogId?: number) => ({
    open: open(s),
    context: placeContext(s, dialogId),
  });

  it("looks at the dialog again when the shop comes beside it, and when it goes", () => {
    // The NPC's dialog opens alone (a right click on the NPC): looked at.
    const alone = syncWindows(defaultWindows(), ["dialog"]);
    const first = toLookAt(alone, look(defaultWindows()), placeContext(alone, 7), false);
    expect([...first]).toEqual(["dialog"]);
    // Nothing changed since: not again (its place, if it got one, stays).
    expect(toLookAt(alone, look(alone, 7), placeContext(alone, 7), false).size).toBe(0);
    // "I want to trade": the shop's window opens beside it, the dialog's usual place moves
    // (windows.css, the pair): the dialog is looked at again, not only the shop.
    const pair = syncWindows(alone, ["dialog", "shop"]);
    expect(placeContext(pair, 7)).not.toEqual(placeContext(alone, 7));
    expect([...toLookAt(pair, look(alone, 7), placeContext(pair, 7), false)]).toEqual(["dialog"]);
    // The shop closes and the dialog stays: back to its place alone, looked at again.
    expect([...toLookAt(alone, look(pair, 7), placeContext(alone, 7), false)]).toEqual(["dialog"]);
  });

  it("looks at the dialog again with another NPC's dialog in the same window", () => {
    const s = syncWindows(defaultWindows(), ["dialog"]);
    expect([...toLookAt(s, look(s, 7), placeContext(s, 8), false)]).toEqual(["dialog"]);
  });

  it("leaves alone a window the player placed, and those without other places", () => {
    const s = moveWindow(syncWindows(defaultWindows(), ["dialog"]), "dialog", 10, 20);
    expect(toLookAt(s, look(defaultWindows()), placeContext(s, 7), false).size).toBe(0);
    const pair = syncWindows(defaultWindows(), ["dialog", "shop"]);
    // The shop has no other places (movesAside): only the dialog of the pair.
    expect([...toLookAt(pair, look(defaultWindows()), placeContext(pair, 7), false)]).toEqual([
      "dialog",
    ]);
  });

  it("looks at every open one after the area changed size", () => {
    const s = syncWindows(openWindow(defaultWindows(), "skills"), ["trade"]);
    expect(toLookAt(s, look(s), placeContext(s, undefined), false).size).toBe(0);
    expect([...toLookAt(s, look(s), placeContext(s, undefined), true)].sort()).toEqual([
      "skills",
      "trade",
    ]);
  });
});

describe("the tutorial's hint gives way (tutorialCovered)", () => {
  it("while the help, the guild, the appearance or the quest log sits at its factory place", () => {
    const s = defaultWindows();
    expect(tutorialCovered(s)).toBe(false);
    expect(tutorialCovered(openWindow(s, "help"))).toBe(true);
    expect(tutorialCovered(openWindow(s, "guild"))).toBe(true);
    expect(tutorialCovered(openWindow(s, "appearance"))).toBe(true);
    expect(tutorialCovered(openWindow(s, "quests"))).toBe(true);
    // Moved elsewhere, or another window: the hint stays.
    expect(tutorialCovered(moveWindow(openWindow(s, "help"), "help", 300, 400))).toBe(false);
    expect(tutorialCovered(openWindow(s, "options"))).toBe(false);
  });
});
