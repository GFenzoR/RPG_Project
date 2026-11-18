// Dragging and resizing a window, without a DOM: a fake element, pointer and class list,
// and Preact's own rule for the `style` prop (preact/src/diff/props.js: only the properties
// whose value changed since the last render are written) applied to what GameWindow renders.
import { describe, expect, it } from "vitest";
import type { VNode } from "preact";
import { GameWindow } from "./GameWindow.tsx";
import {
  DRAG_START_PX,
  dragWindow,
  placeStyle,
  resizeDrag,
  settleStyle,
  watchedRef,
} from "./window-dom.ts";
import type {
  DragElement,
  DragEnv,
  InlineStyle,
  PageBox,
  PointerAt,
  PointerTarget,
} from "./window-dom.ts";
import {
  defaultWindows,
  moveWindow,
  openWindow,
  placeOf,
  placeWindow,
  resizeWindow,
} from "./windows.ts";
import type { WindowPlace, WindowsState } from "./windows.ts";

const STYLE_PROPS = ["left", "top", "right", "bottom", "width", "height", "maxHeight"] as const;
type StyleProp = (typeof STYLE_PROPS)[number];

/** The style GameWindow renders for the inventory at `place`. */
function rendered(place: WindowPlace, zoom = 1): Partial<Record<StyleProp, string>> {
  const tree = GameWindow({
    t: (key) => key,
    id: "inventory",
    icon: "inventory",
    title: "Inventario",
    place,
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
