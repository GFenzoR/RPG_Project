// Dragging and resizing a window, without a DOM: a fake element, pointer and class list,
// and Preact's own rule for the `style` prop (preact/src/diff/props.js: only the properties
// whose value changed since the last render are written) applied to what GameWindow renders.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { GameWindow } from "./GameWindow.tsx";
import {
  DRAG_START_PX,
  dragWindow,
  naturalHeight,
  outsiders,
  placeOpened,
  placeStyle,
  resizeDrag,
  settleStyle,
  transformScale,
  unscaledIn,
  watchedRef,
} from "./window-dom.ts";
import type {
  AreaWindow,
  DragElement,
  DragEnv,
  InlineStyle,
  PageBox,
  PointerAt,
  PointerTarget,
} from "./window-dom.ts";
import {
  collapseWindow,
  defaultWindows,
  moveWindow,
  openWindow,
  placeOf,
  placeWindow,
  resizeWindow,
} from "./windows.ts";
import { PLACE_GAP } from "./windows.ts";
import type { AutoPlace, WinKey, WindowPlace, WindowsState } from "./windows.ts";

const STYLE_PROPS = ["left", "top", "right", "bottom", "width", "height", "maxHeight"] as const;
type StyleProp = (typeof STYLE_PROPS)[number];

/** The style GameWindow renders for the inventory at `place` (or `auto`, unplaced). */
function rendered(
  place: WindowPlace,
  zoom = 1,
  auto?: AutoPlace,
): Partial<Record<StyleProp, string>> {
  const tree = GameWindow({
    t: (key) => key,
    id: "inventory",
    icon: "inventory",
    title: "Inventario",
    place,
    auto,
    stack: 0,
    zoom,
    onClose: () => {},
    onCollapse: () => {},
    onFocus: () => {},
    onGrab: () => {},
    onResize: () => {},
    onMoveKey: () => false,
    children: "body",
  }) as VNode<{ style: Record<string, unknown> }>;
  const out: Partial<Record<StyleProp, string>> = {};
  for (const prop of STYLE_PROPS) {
    const v = tree.props.style[prop];
    if (typeof v === "string") out[prop] = v;
  }
  return out;
}

/** Preact's diff of the style prop from one render to the next (props.js setProperty). */
function preactRender(
  dom: InlineStyle,
  old: Partial<Record<StyleProp, string>>,
  next: Partial<Record<StyleProp, string>>,
): void {
  for (const prop of STYLE_PROPS) {
    if (prop in old && !(prop in next)) dom[prop] = "";
    if (prop in next && next[prop] !== old[prop]) dom[prop] = next[prop] ?? "";
  }
}

function fakePointer(): PointerTarget & {
  fire(type: "pointermove" | "pointerup" | "pointercancel", x?: number, y?: number): void;
  listening(): number;
} {
  const on = new Map<string, Set<(e: PointerAt) => void>>();
  return {
    addEventListener(type, f) {
      const set = on.get(type) ?? new Set();
      set.add(f);
      on.set(type, set);
    },
    removeEventListener(type, f) {
      on.get(type)?.delete(f);
    },
    fire(type, x = 0, y = 0) {
      for (const f of [...(on.get(type) ?? [])]) f({ clientX: x, clientY: y });
    },
    listening: () => [...on.values()].reduce((n, s) => n + s.size, 0),
  };
}

const AREA: PageBox = { left: 0, top: 0, width: 1000, height: 600 };

/**
 * A screen with the inventory at `place` (its box `box`): the element as the last render
 * left it, and what happens when the state changes (GameView re-renders the window).
 */
function screen(place: WindowPlace, box: PageBox, zoom = 1) {
  const pointer = fakePointer();
  const classes = new Set<string>();
  const env: DragEnv = {
    pointer,
    body: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
    },
    zoom: () => zoom,
  };
  const style: InlineStyle = {
    left: "",
    top: "",
    right: "",
    bottom: "",
    width: "",
    height: "",
    maxHeight: "",
  };
  let state: WindowsState = openWindow(defaultWindows(), "inventory");
  state = { ...state, win: { ...state.win, inventory: { ...place } } };
  let last = rendered(place, zoom);
  preactRender(style, {}, last);
  const el: DragElement = { getBoundingClientRect: () => box, style, dataset: {} };
  /** The state changed (or not): Preact renders the window again if it did. */
  const commit = (f: (s: WindowsState) => WindowsState): void => {
    const next = f(state);
    if (next === state) return; // the same state: Preact does not render
    state = next;
    const now = rendered(placeOf(state, "inventory"), zoom);
    preactRender(style, last, now);
    last = now;
  };
  return { env, pointer, classes, style, el, commit, state: () => state };
}

describe("dragging a window by its title bar", () => {
  it("keeps the side it slid along: the length that did not change is still written", () => {
    // Against the right side (x 800 of an area 1000 wide), dragged down along it: the magnet
    // keeps x at 800, only y changes, so Preact writes only top.
    const s = screen(
      { open: true, collapsed: false, x: 800, y: 50 },
      {
        left: 800,
        top: 50,
        width: 200,
        height: 300,
      },
    );
    dragWindow(
      s.env,
      s.el,
      { clientX: 850, clientY: 60 },
      AREA,
      [],
      placeOf(s.state(), "inventory"),
      (x, y) => s.commit((st) => moveWindow(st, "inventory", x, y)),
    );
    s.pointer.fire("pointermove", 853, 120);
    s.pointer.fire("pointermove", 853, 200);
    expect(s.classes.has("dragging-window")).toBe(true);
    expect(s.el.dataset["dragging"]).toBe("");
    s.pointer.fire("pointerup");
    expect(placeOf(s.state(), "inventory")).toMatchObject({ x: 800, y: 190 });
    // Cleared for the render to set, left stayed empty: the window jumped to the left side.
    expect(s.style.left).toBe("800px");
    expect(s.style.top).toBe("190px");
    expect(s.style.maxHeight).toBe("calc(100% - 190px)");
    expect(s.style.right).toBe("");
    expect(s.style.bottom).toBe("");
    expect(s.classes.size).toBe(0);
    expect(s.el.dataset["dragging"]).toBeUndefined();
    expect(s.pointer.listening()).toBe(0);
  });

  it("dropped back where it was (the state does not change, nothing renders), it stays", () => {
    const s = screen(
      { open: true, collapsed: false, x: 300, y: 120 },
      {
        left: 300,
        top: 120,
        width: 200,
        height: 240,
      },
    );
    // On top already: moving it to its own place is the same state.
    s.commit((st) => ({ ...st, z: ["inventory"] }));
    dragWindow(
      s.env,
      s.el,
      { clientX: 310, clientY: 130 },
      AREA,
      [],
      placeOf(s.state(), "inventory"),
      (x, y) => s.commit((st) => moveWindow(st, "inventory", x, y)),
    );
    s.pointer.fire("pointermove", 400, 300);
    s.pointer.fire("pointermove", 312, 131); // at 302, 121: nothing near enough to snap
    s.pointer.fire("pointermove", 310, 130);
    s.pointer.fire("pointerup");
    expect(placeOf(s.state(), "inventory")).toMatchObject({ x: 300, y: 120 });
    expect(s.style.left).toBe("300px");
    expect(s.style.top).toBe("120px");
    expect(s.style.maxHeight).toBe("calc(100% - 120px)");
  });

  it("leaves its default place (hanging from the right) for one set by left and top", () => {
    const s = screen(
      { open: true, collapsed: false },
      { left: 800, top: 0, width: 200, height: 300 },
    );
    expect(s.style.left).toBe(""); // windows.css places it
    dragWindow(
      s.env,
      s.el,
      { clientX: 900, clientY: 10 },
      AREA,
      [],
      placeOf(s.state(), "inventory"),
      (x, y) => s.commit((st) => moveWindow(st, "inventory", x, y)),
    );
    s.pointer.fire("pointermove", 700, 150);
    expect(s.style.right).toBe("auto");
    s.pointer.fire("pointerup");
    expect(s.style.left).toBe("600px");
    expect(s.style.top).toBe("140px");
    expect(s.style.right).toBe("");
  });

  it("with the interface scale, writes its own px (screen px / zoom)", () => {
    const s = screen(
      { open: true, collapsed: false, x: 800, y: 60 },
      { left: 800, top: 60, width: 200, height: 300 },
      1.25,
    );
    expect(s.style.left).toBe("640px");
    dragWindow(
      s.env,
      s.el,
      { clientX: 850, clientY: 70 },
      AREA,
      [],
      placeOf(s.state(), "inventory"),
      (x, y) => s.commit((st) => moveWindow(st, "inventory", x, y)),
    );
    s.pointer.fire("pointermove", 850, 210);
    s.pointer.fire("pointerup");
    expect(placeOf(s.state(), "inventory")).toMatchObject({ x: 800, y: 200 });
    expect(s.style.left).toBe("640px");
    expect(s.style.top).toBe("160px");
  });

  it("a press that does not travel DRAG_START_PX is a click: nothing moves", () => {
    const s = screen(
      { open: true, collapsed: false, x: 100, y: 100 },
      {
        left: 100,
        top: 100,
        width: 200,
        height: 300,
      },
    );
    let done = 0;
    dragWindow(
      s.env,
      s.el,
      { clientX: 150, clientY: 110 },
      AREA,
      [],
      placeOf(s.state(), "inventory"),
      () => {
        done++;
      },
    );
    s.pointer.fire("pointermove", 150 + DRAG_START_PX - 1, 110);
    s.pointer.fire("pointercancel");
    expect(done).toBe(0);
    expect(s.style.left).toBe("100px");
    expect(s.classes.size).toBe(0);
    expect(s.pointer.listening()).toBe(0);
  });
});

describe("resizing a window by its grip", () => {
  it("keeps its place: left, top and max-height are written though they did not change", () => {
    const s = screen(
      { open: true, collapsed: false, x: 300, y: 120 },
      {
        left: 300,
        top: 120,
        width: 200,
        height: 240,
      },
    );
    resizeDrag(
      s.env,
      s.el,
      { clientX: 498, clientY: 358 },
      AREA,
      placeOf(s.state(), "inventory"),
      (x, y, w, h) =>
        s.commit((st) => resizeWindow(placeWindow(st, "inventory", x, y), "inventory", w, h)),
    );
    s.pointer.fire("pointermove", 548, 408);
    expect(s.style.maxHeight).toBe("none");
    expect(s.classes.has("resizing-window")).toBe(true);
    s.pointer.fire("pointerup");
    expect(placeOf(s.state(), "inventory")).toMatchObject({ x: 300, y: 120, w: 250, h: 290 });
    // Cleared for the render to set, they stayed empty: the window jumped to the top left.
    expect(s.style.left).toBe("300px");
    expect(s.style.top).toBe("120px");
    expect(s.style.maxHeight).toBe("calc(100% - 120px)");
    expect(s.style.width).toBe("250px");
    expect(s.style.height).toBe("290px");
    expect(s.classes.size).toBe(0);
    expect(s.pointer.listening()).toBe(0);
  });

  it("never past the bar: the room left under its top is the most", () => {
    const s = screen(
      { open: true, collapsed: false, x: 300, y: 400 },
      {
        left: 300,
        top: 400,
        width: 200,
        height: 150,
      },
    );
    resizeDrag(
      s.env,
      s.el,
      { clientX: 498, clientY: 548 },
      AREA,
      placeOf(s.state(), "inventory"),
      (x, y, w, h) =>
        s.commit((st) => resizeWindow(placeWindow(st, "inventory", x, y), "inventory", w, h)),
    );
    s.pointer.fire("pointermove", 498, 900);
    s.pointer.fire("pointerup");
    expect(placeOf(s.state(), "inventory")).toMatchObject({ h: 200 });
    expect(s.style.height).toBe("200px");
    expect(s.style.top).toBe("400px");
  });
});

describe("placeStyle and settleStyle", () => {
  it("are what GameWindow renders", () => {
    const place: WindowPlace = { open: true, collapsed: false, x: 33, y: 47, w: 301, h: 199 };
    expect(rendered(place, 1.5)).toEqual(placeStyle(place, 1.5));
    const style: InlineStyle = {
      left: "1px",
      top: "1px",
      right: "auto",
      bottom: "auto",
      width: "1px",
      height: "1px",
      maxHeight: "none",
    };
    settleStyle(style, { ...place, collapsed: true, w: undefined }, 1.5);
    expect(style).toEqual({
      left: "22px",
      top: "31.33px",
      right: "",
      bottom: "",
      width: "",
      height: "",
      maxHeight: "calc(100% - 31.33px)",
    });
  });
});

describe("watchedRef", () => {
  it("watches each element the ref gets, and stops when it goes", () => {
    const log: string[] = [];
    const ref = watchedRef<string>((el) => {
      log.push(`watch ${el}`);
      return () => log.push(`stop ${el}`);
    });
    // A tablet first: no windows' area. Then the desktop, back to the tablet and again
    // the desktop (a new area each time).
    ref.set(null);
    expect(ref.current).toBeNull();
    ref.set("first");
    ref.set("first"); // the same element: nothing to do
    expect(ref.current).toBe("first");
    ref.set(null);
    ref.set("second");
    expect(ref.current).toBe("second");
    expect(log).toEqual(["watch first", "stop first", "watch second"]);
  });
});

/**
 * A window in the windows' area as the browser lays it out: placed at its state's x and y
 * (GameWindow's left and top), its own height `natural` cut by the max-height GameWindow
 * gives it (`calc(100% - top)`, against the area's height now) unless that is lifted, and
 * drawn at `scale` (the opening animation) around its centre. `writes` counts what is
 * written to its max-height.
 */
function areaWindow(
  s: WindowsState,
  id: WinKey,
  size: { width: number; natural: number },
  area: () => PageBox,
  attrs: { closing?: boolean; scale?: number } = {},
): AreaWindow & { writes: string[] } {
  const place = placeOf(s, id);
  const styled = placeStyle(place, 1);
  const writes: string[] = [];
  let maxHeight = styled.maxHeight ?? "";
  const k = attrs.scale ?? 1;
  return {
    writes,
    dataset: { window: id },
    hasAttribute: (name) =>
      (name === "data-placed" && place.x !== undefined && place.y !== undefined) ||
      (name === "data-closing" && attrs.closing === true),
    style: {
      get maxHeight() {
        return maxHeight;
      },
      set maxHeight(v: string) {
        writes.push(v);
        maxHeight = v;
      },
    },
    getBoundingClientRect() {
      const a = area();
      const x = place.x ?? 0;
      const y = place.y ?? 0;
      const cut = /^calc\(100% - ([\d.]+)px\)$/.exec(maxHeight);
      const height =
        maxHeight === "none" || !cut
          ? size.natural
          : Math.min(size.natural, Math.max(0, a.height - Number(cut[1])));
      const w = size.width * k;
      const h = height * k;
      return {
        left: a.left + x + (size.width - w) / 2,
        top: a.top + y + (height - h) / 2,
        width: w,
        height: h,
      };
    },
  };
}

describe("bringing the windows back inside (outsiders)", () => {
  const noScale = (): number => 1;

  it("moves up whole a window whose top the area left behind, not to a 0 px sliver", () => {
    // The chat against the bar of a 900 px area (y 600, 300 tall); the browser window
    // shrinks and the area is 500 tall: its max-height leaves it nothing. Measured so, it
    // went to y 500, its title bar over the bar and no room to type.
    let area: PageBox = { left: 0, top: 0, width: 1280, height: 900 };
    const s = moveWindow(defaultWindows(), "chat", 144, 600);
    const chat = areaWindow(s, "chat", { width: 384, natural: 300 }, () => area);
    expect(outsiders(area, [chat], s, noScale)).toEqual([]);
    area = { ...area, height: 500 };
    expect(outsiders(area, [chat], s, noScale)).toEqual([["chat", 144, 200]]);
    // Its max-height was lifted for the measure and is back as GameWindow wrote it.
    expect(chat.writes).toEqual(["none", "calc(100% - 600px)"]);
    expect(chat.style.maxHeight).toBe("calc(100% - 600px)");
  });

  it("brings an unfolded window against the bar up until it shows whole", () => {
    // Folded against the bar (y 472 of 500, its 28 px title bar), then unfolded: its
    // max-height still leaves 28 px.
    const area: PageBox = { left: 0, top: 0, width: 1000, height: 500 };
    const s = moveWindow(defaultWindows(), "skills", 0, 472);
    const skills = areaWindow(s, "skills", { width: 256, natural: 320 }, () => area);
    expect(outsiders(area, [skills], s, noScale)).toEqual([["skills", 0, 180]]);
    // Folded it stays where it was.
    const folded = collapseWindow(s, "skills", true);
    const bar = areaWindow(folded, "skills", { width: 256, natural: 28 }, () => area);
    expect(outsiders(area, [bar], folded, noScale)).toEqual([]);
  });

  it("leaves a window squashed but usable where the player left it, without measuring", () => {
    // A battle list that grew past the bar: 300 px of its 520 show, its body scrolls.
    const area: PageBox = { left: 0, top: 0, width: 1000, height: 600 };
    const s = moveWindow(defaultWindows(), "battle", 0, 300);
    const battle = areaWindow(s, "battle", { width: 256, natural: 520 }, () => area);
    expect(outsiders(area, [battle], s, noScale)).toEqual([]);
    expect(battle.writes).toEqual([]);
  });

  it("brings in a window opened where a larger screen left it, at its size on screen", () => {
    // The skills left at x 1600 on a 1920 px screen, opened on a 1280 px one; opening, it
    // is drawn at 96 % (gwin-in): measured so, 10 px of it stayed off the right edge.
    const area: PageBox = { left: 0, top: 0, width: 1280, height: 712 };
    const s = moveWindow(defaultWindows(), "skills", 1600, 40);
    const skills = areaWindow(s, "skills", { width: 256, natural: 300 }, () => area, {
      scale: 0.96,
    });
    expect(outsiders(area, [skills], s, () => 0.96)).toEqual([["skills", 1024, 40]]);
  });

  it("leaves alone the windows at their default place and those fading out", () => {
    const area: PageBox = { left: 0, top: 0, width: 600, height: 400 };
    let s = moveWindow(defaultWindows(), "skills", 900, 900);
    s = { ...s, win: { ...s.win, battle: { open: true, collapsed: false } } };
    const closing = areaWindow(s, "skills", { width: 256, natural: 300 }, () => area, {
      closing: true,
    });
    const unplaced = areaWindow(s, "battle", { width: 256, natural: 900 }, () => area);
    expect(outsiders(area, [closing, unplaced], s, noScale)).toEqual([]);
  });
});

describe("naturalHeight and transformScale", () => {
  it("measures a window without its max-height and puts it back", () => {
    const area: PageBox = { left: 0, top: 0, width: 1000, height: 500 };
    const s = moveWindow(defaultWindows(), "chat", 0, 400);
    const chat = areaWindow(s, "chat", { width: 384, natural: 300 }, () => area);
    expect(chat.getBoundingClientRect().height).toBe(100);
    expect(naturalHeight(chat)).toBe(300);
    expect(chat.style.maxHeight).toBe("calc(100% - 400px)");
  });

  it("reads the scale of a computed transform", () => {
    expect(transformScale("none")).toBe(1);
    expect(transformScale("matrix(0.96, 0, 0, 0.96, 0, 0)")).toBeCloseTo(0.96);
    expect(transformScale("matrix3d(0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)")).toBe(
      0.5,
    );
    expect(transformScale("matrix(0, 0, 0, 0, 0, 0)")).toBe(1);
    expect(transformScale("")).toBe(1);
  });
});

describe("a window at the place defaultPlace gave it (auto)", () => {
  const unplaced: WindowPlace = { open: true, collapsed: false };

  it("is placed by its left and top, not by the right or bottom of its usual place", () => {
    const moved: AutoPlace = { x: 252, y: 0, width: 352, height: 300 };
    expect(rendered(unplaced, 1.25, moved)).toEqual({
      left: "201.6px",
      top: "0px",
      right: "auto",
      bottom: "auto",
      maxHeight: "calc(100% - 0px)",
    });
    // Shortened: no taller than its box, its body scrolls.
    const short: AutoPlace = { x: 592, y: 320, width: 352, height: 286, short: true };
    expect(rendered(unplaced, 1, short)).toMatchObject({ top: "320px", maxHeight: "286px" });
    // Once the player moves it, its own place wins.
    const placed = { ...unplaced, x: 10, y: 20 };
    expect(rendered(placed, 1, moved)).toEqual(rendered(placed));
  });

  it("dropped where the player drags it, nothing of the auto place stays on the element", () => {
    const moved: AutoPlace = { x: 252, y: 0, width: 352, height: 300 };
    const dom: InlineStyle = {
      left: "",
      top: "",
      right: "",
      bottom: "",
      width: "",
      height: "",
      maxHeight: "",
    };
    const first = rendered(unplaced, 1, moved);
    preactRender(dom, {}, first);
    // The drag ends: settleStyle, then GameWindow renders the player's place.
    const placed = { ...unplaced, x: 400, y: 50 };
    settleStyle(dom, placed, 1);
    preactRender(dom, first, rendered(placed));
    expect(dom).toMatchObject({ left: "400px", top: "50px", right: "", bottom: "" });
  });
});

describe("placing the windows that just opened (placeOpened)", () => {
  const area: PageBox = { left: 0, top: 0, width: 1280, height: 712 };
  const el = (
    id: WinKey,
    r: { x: number; y: number; width: number; height: number },
    attrs: { placed?: boolean; closing?: boolean; scale?: number } = {},
  ): AreaWindow & { scale: number } => ({
    scale: attrs.scale ?? 1,
    dataset: { window: id },
    hasAttribute: (name) =>
      (name === "data-placed" && attrs.placed === true) ||
      (name === "data-closing" && attrs.closing === true),
    style: { maxHeight: "" },
    getBoundingClientRect() {
      const k = attrs.scale ?? 1;
      return {
        left: area.left + r.x + (r.width * (1 - k)) / 2,
        top: area.top + r.y + (r.height * (1 - k)) / 2,
        width: r.width * k,
        height: r.height * k,
      };
    },
  });
  const scaleOf = (w: { scale: number }): number => w.scale;
  const battle = el("battle", { x: 0, y: 0, width: 256, height: 352 });
  const inventory = el("inventory", { x: 1024, y: 0, width: 256, height: 500 });
  // The player's tile on the page: the map's centre at 2x.
  const player: PageBox = { left: 640, top: 324, width: 64, height: 64 };

  it("moves the trade that opened over the tiles north of the player, measured unscaled", () => {
    // Opening, it is drawn at 96 % around its centre (gwin-in).
    const trade = el("trade", { x: 464, y: 0, width: 352, height: 300 }, { scale: 0.96 });
    const at = placeOpened(area, [battle, inventory, trade], new Set(["trade"]), player, scaleOf);
    expect(at.get("trade")).toEqual({ x: 640 - PLACE_GAP - 352, y: 0, width: 352, height: 300 });
  });

  it("leaves alone a window the player placed, and does not count one fading out", () => {
    const trade = el("trade", { x: 464, y: 0, width: 352, height: 300 }, { placed: true });
    expect(placeOpened(area, [trade], new Set(["trade"]), player, scaleOf).size).toBe(0);
    // The help fading out at the top centre is no obstacle: the trade stays at its place.
    const help = el("help", { x: 440, y: 0, width: 400, height: 200 }, { closing: true });
    const free = el("trade", { x: 464, y: 0, width: 352, height: 300 });
    expect(placeOpened(area, [help, free], new Set(["trade"]), undefined, scaleOf).size).toBe(0);
  });

  it("lets a window decided first count at its new place for the next", () => {
    // The trade moves left of the player's column; the skills, opened with it under the
    // battle list over the chat, then do not go beside the battle list where it went.
    const trade = el("trade", { x: 464, y: 0, width: 352, height: 300 });
    const chat = el("chat", { x: 144, y: 512, width: 384, height: 200 });
    const skills = el("skills", { x: 0, y: 356, width: 256, height: 330 });
    const at = placeOpened(
      area,
      [battle, inventory, chat, trade, skills],
      new Set(["trade", "skills"]),
      player,
      scaleOf,
    );
    const trade2 = at.get("trade");
    const skills2 = at.get("skills");
    if (!trade2 || !skills2) throw new Error("both move");
    expect(trade2.x).toBe(284);
    expect(skills2.x === 256 && skills2.y === 0).toBe(false);
  });

  it("unscales a box around its centre", () => {
    expect(unscaledIn({ left: 10, top: 20, width: 96, height: 48 }, 0.96, area)).toEqual({
      x: 8,
      y: 19,
      width: 100,
      height: 50,
    });
  });
});
