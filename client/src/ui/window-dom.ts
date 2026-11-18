// The desktop windows' DOM side (docs/17 UI-5): the inline lengths that place a window
// (GameWindow draws them from ui/windows.ts), dragging a title bar and the resize grip (the
// window follows the pointer, then its state takes over), and watching the windows' area
// while it is in the page. Apart from GameView.tsx so the tests drive them without a DOM:
// all they touch is a few properties of an element, a listener target and a class list.
import { clampSize, snapPlace } from "./windows.ts";
import type { Box, Rect, WindowPlace } from "./windows.ts";

/** The inline lengths a window's place sets (GameWindow's `style`). */
export type PlaceStyle = Partial<Record<"left" | "top" | "maxHeight" | "width" | "height", string>>;

/** A length in the window's own px: the state keeps screen px, the window has the zoom. */
const ownPx = (v: number, zoom: number): string => `${Math.round((v / zoom) * 100) / 100}px`;

const scale = (zoom: number): number => (zoom > 0 ? zoom : 1);

/**
 * The inline lengths of a window at `place` with the interface scale `zoom`: left, top and
 * a max-height that never reaches under the bar once the player placed it (without x and
 * y it sits at its default place, windows.css); the size the player gave it.
 */
export function placeStyle(place: WindowPlace, zoom: number): PlaceStyle {
  const k = scale(zoom);
  const out: PlaceStyle = {};
  if (place.x !== undefined && place.y !== undefined) {
    out.left = ownPx(place.x, k);
    out.top = ownPx(place.y, k);
    // As tall as the room under its top at most (100 % is the windows' area).
    out.maxHeight = `calc(100% - ${out.top})`;
  }
  if (place.w !== undefined) out.width = ownPx(place.w, k);
  if (place.h !== undefined && !place.collapsed) out.height = ownPx(place.h, k);
  return out;
}

/** The part of an element's inline style that a drag writes. */
export type InlineStyle = Pick<
  CSSStyleDeclaration,
  "left" | "top" | "right" | "bottom" | "width" | "height" | "maxHeight"
>;

const PLACE_PROPS = ["left", "top", "maxHeight", "width", "height"] as const;

/**
 * At the end of a drag or a resize the element gets the lengths of its new place, those
 * GameWindow renders next. Clearing them for that render to set would not do: Preact
 * writes only the style properties whose value changed since its last render, so one the
 * drag overwrote and the state kept (the x of a window slid down a side, every length of a
 * resized one but its size) stayed empty and the window jumped to the area's top left.
 * Right and bottom, which GameWindow never sets, go back to the stylesheet.
 */
export function settleStyle(style: InlineStyle, place: WindowPlace, zoom: number): void {
  const next = placeStyle(place, zoom);
  for (const prop of PLACE_PROPS) style[prop] = next[prop] ?? "";
  style.right = "";
  style.bottom = "";
}

/** Where the pointer is, CSS px from the page's top left. */
export interface PointerAt {
  clientX: number;
  clientY: number;
}

type PointerType = "pointermove" | "pointerup" | "pointercancel";

/** Where a drag listens for the pointer's moves and its release (the page's window). */
export interface PointerTarget {
  addEventListener(type: PointerType, f: (e: PointerAt) => void): void;
  removeEventListener(type: PointerType, f: (e: PointerAt) => void): void;
}

export interface DragEnv {
  pointer: PointerTarget;
  /** The body's classes (`dragging-window`, `resizing-window`: the cursor everywhere). */
  body: Pick<DOMTokenList, "add" | "remove">;
  /** The interface scale now (the windows' CSS zoom). */
  zoom(): number;
}

/** A box on the page, as getBoundingClientRect gives it. */
export interface PageBox extends Box {
  left: number;
  top: number;
}

/** What a drag uses of a window's element. */
export interface DragElement {
  getBoundingClientRect(): PageBox;
  style: InlineStyle;
  dataset: DOMStringMap;
}

/** Pointer travel (CSS px) before a press on a title bar becomes a drag. */
export const DRAG_START_PX = 5;

/** Listens for the pointer's moves until it is released (or the browser takes it). */
function follow(env: DragEnv, onMove: (e: PointerAt) => void, onUp: () => void): void {
  const up = (): void => {
    env.pointer.removeEventListener("pointermove", onMove);
    env.pointer.removeEventListener("pointerup", up);
    env.pointer.removeEventListener("pointercancel", up);
    onUp();
  };
  env.pointer.addEventListener("pointermove", onMove);
  env.pointer.addEventListener("pointerup", up);
  env.pointer.addEventListener("pointercancel", up);
}

/**
 * The title bar was pressed at `press`: the window `el` (at `place`, in the windows' area
 * `area`) follows the pointer, the magnet (snapPlace) taking the area's edges and the
 * `others` windows'. On release it keeps its new place (settleStyle) and `done` gets it,
 * in screen px from the area's top left. A press that never travels DRAG_START_PX is a
 * click: nothing changes.
 */
export function dragWindow(
  env: DragEnv,
  el: DragElement,
  press: PointerAt,
  area: PageBox,
  others: readonly Rect[],
  place: WindowPlace,
  done: (x: number, y: number) => void,
): void {
  const r = el.getBoundingClientRect();
  const off = { x: press.clientX - r.left, y: press.clientY - r.top };
  let at = { x: r.left - area.left, y: r.top - area.top };
  let moved = false;
  follow(
    env,
    (ev) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - press.clientX, ev.clientY - press.clientY) < DRAG_START_PX)
          return;
        moved = true;
        env.body.add("dragging-window");
        el.dataset["dragging"] = "";
        // Its default place may hang from the right or the bottom (windows.css): from now
        // on only left and top place it.
        el.style.right = "auto";
        el.style.bottom = "auto";
      }
      at = snapPlace(
        {
          x: ev.clientX - area.left - off.x,
          y: ev.clientY - area.top - off.y,
          width: r.width,
          height: r.height,
        },
        area,
        others,
      );
      const k = scale(env.zoom());
      el.style.left = `${at.x / k}px`;
      el.style.top = `${at.y / k}px`;
    },
    () => {
      if (!moved) return;
      env.body.remove("dragging-window");
      delete el.dataset["dragging"];
      const x = Math.round(at.x);
      const y = Math.round(at.y);
      settleStyle(el.style, { ...place, x, y }, env.zoom());
      done(x, y);
    },
  );
}

/**
 * The resize grip was pressed at `press`: the window's bottom right corner follows the
 * pointer, between MIN_SIZE and the room left in the area (never under the bar), its top
 * left corner pinned where it is (a default place that hangs from the bottom, the chat's
 * or the dialog's, would grow upwards). On release it keeps its new place and size and
 * `done` gets them, screen px.
 */
export function resizeDrag(
  env: DragEnv,
  el: DragElement,
  press: PointerAt,
  area: PageBox,
  place: WindowPlace,
  done: (x: number, y: number, width: number, height: number) => void,
): void {
  const r = el.getBoundingClientRect();
  const room = { width: area.left + area.width - r.left, height: area.top + area.height - r.top };
  const at = { x: Math.round(r.left - area.left), y: Math.round(r.top - area.top) };
  let size = { width: r.width, height: r.height };
  let moved = false;
  follow(
    env,
    (ev) => {
      size = clampSize(
        r.width + ev.clientX - press.clientX,
        r.height + ev.clientY - press.clientY,
        room,
      );
      const k = scale(env.zoom());
      if (!moved) {
        env.body.add("resizing-window");
        el.style.left = `${at.x / k}px`;
        el.style.top = `${at.y / k}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
        el.style.maxHeight = "none";
      }
      el.style.width = `${size.width / k}px`;
      el.style.height = `${size.height / k}px`;
      moved = true;
    },
    () => {
      if (!moved) return;
      env.body.remove("resizing-window");
      const { width, height } = size;
      settleStyle(el.style, { ...place, x: at.x, y: at.y, w: width, h: height }, env.zoom());
      done(at.x, at.y, width, height);
    },
  );
}

/**
 * A ref to an element that comes and goes (the windows' area is only in the desktop
 * layout: a window narrower than 960 px has none, and each switch back mounts a new one),
 * watched while it is in the page.
 */
export interface WatchedRef<T> {
  /** The element now; null while it is not in the page. */
  readonly current: T | null;
  /** The ref callback, always the same: Preact calls it with the element, then with null. */
  readonly set: (el: T | null) => void;
}

/** `watch` starts on each element the ref gets and returns how to stop. */
export function watchedRef<T>(watch: (el: T) => () => void): WatchedRef<T> {
  let current: T | null = null;
  let stop: (() => void) | undefined;
  return {
    get current() {
      return current;
    },
    set: (el) => {
      if (el === current) return;
      stop?.();
      stop = undefined;
      current = el;
      if (el !== null) stop = watch(el);
    },
  };
}
