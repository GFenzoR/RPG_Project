// The desktop windows' DOM side (docs/17 UI-5): the inline lengths that place a window
// (GameWindow draws them from ui/windows.ts), dragging a title bar and a resize corner (the
// window follows the pointer, then its state takes over), and watching the windows' area
// while it is in the page. Apart from GameView.tsx so the tests drive them without a DOM:
// all they touch is a few properties of an element, a listener target and a class list.
import {
  clampPlace,
  cornerCursor,
  defaultPlace,
  keptHeight,
  placeOf,
  resizeFrom,
  snapPlace,
} from "./windows.ts";
import type { AutoPlace, Box, Corner, Rect, WinKey, WindowPlace, WindowsState } from "./windows.ts";

/** The inline lengths a window's place sets (GameWindow's `style`). */
export type PlaceStyle = Partial<
  Record<"left" | "top" | "right" | "bottom" | "maxHeight" | "width" | "height", string>
>;

/** A length in the window's own px: the state keeps screen px, the window has the zoom. */
const ownPx = (v: number, zoom: number): string => `${Math.round((v / zoom) * 100) / 100}px`;

const scale = (zoom: number): number => (zoom > 0 ? zoom : 1);

/**
 * The inline lengths of a window at `place` with the interface scale `zoom`: left, top and
 * a max-height that never reaches under the bar once the player placed it (without x and
 * y it sits at its default place, windows.css, or where defaultPlace moved it, `auto`:
 * then only left and top place it, and a shortened one is no taller than its box); the
 * size the player gave it.
 */
export function placeStyle(place: WindowPlace, zoom: number, auto?: AutoPlace): PlaceStyle {
  const k = scale(zoom);
  const out: PlaceStyle = {};
  if (place.x !== undefined && place.y !== undefined) {
    out.left = ownPx(place.x, k);
    out.top = ownPx(place.y, k);
    // As tall as the room under its top at most (100 % is the windows' area).
    out.maxHeight = `calc(100% - ${out.top})`;
  } else if (auto) {
    out.left = ownPx(auto.x, k);
    out.top = ownPx(auto.y, k);
    // Its usual place may hang from the right or the bottom (windows.css).
    out.right = "auto";
    out.bottom = "auto";
    out.maxHeight = auto.short ? ownPx(auto.height, k) : `calc(100% - ${out.top})`;
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
  /**
   * The body's classes (`dragging-window`, `resizing-window` and `resizing-nesw`: the
   * cursor everywhere).
   */
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
 * A corner of the window was pressed at `press` (docs/17 UI-5: the four corners resize,
 * the edges do not): that corner follows the pointer and the opposite one stays
 * (resizeFrom: a top or left corner moves the window's top or left), with the magnet on
 * the area's edges, the bar's top and the `others` windows', never under the bar and never
 * under MIN_SIZE. The body gets `resizing-window` (and `resizing-nesw` for the top right
 * and bottom left corners: the cursor everywhere while it lasts) and the window
 * `data-resizing` with the corner (windows.css keeps that one lit). On release the window
 * keeps its new place and size (settleStyle) and `done` gets them, screen px from the
 * area's top left.
 */
export function resizeDrag(
  env: DragEnv,
  el: DragElement,
  corner: Corner,
  press: PointerAt,
  area: PageBox,
  others: readonly Rect[],
  place: WindowPlace,
  done: (x: number, y: number, width: number, height: number) => void,
): void {
  const r = el.getBoundingClientRect();
  const start: Rect = {
    x: r.left - area.left,
    y: r.top - area.top,
    width: r.width,
    height: r.height,
  };
  let box: Rect = start;
  let moved = false;
  const diagonal = cornerCursor(corner) === "nesw-resize" ? "resizing-nesw" : undefined;
  follow(
    env,
    (ev) => {
      box = resizeFrom(
        corner,
        start,
        ev.clientX - press.clientX,
        ev.clientY - press.clientY,
        area,
        others,
      );
      const k = scale(env.zoom());
      if (!moved) {
        env.body.add("resizing-window");
        if (diagonal) env.body.add(diagonal);
        el.dataset["resizing"] = corner;
        el.style.right = "auto";
        el.style.bottom = "auto";
        el.style.maxHeight = "none";
      }
      el.style.left = `${box.x / k}px`;
      el.style.top = `${box.y / k}px`;
      el.style.width = `${box.width / k}px`;
      el.style.height = `${box.height / k}px`;
      moved = true;
    },
    () => {
      if (!moved) return;
      env.body.remove("resizing-window");
      if (diagonal) env.body.remove(diagonal);
      delete el.dataset["resizing"];
      const { x, y, width, height } = box;
      settleStyle(el.style, { ...place, x, y, w: width, h: height }, env.zoom());
      done(x, y, width, height);
    },
  );
}

/**
 * The scale of a computed `transform` (getComputedStyle: `none`, `matrix(…)` or
 * `matrix3d(…)`): a window that opens grows from 0.96 (client.css gwin-in), and its box on
 * screen with it, so it is measured divided by this.
 */
export function transformScale(transform: string): number {
  const m = /^matrix(?:3d)?\(([^)]*)\)$/.exec(transform.trim());
  if (!m) return 1;
  const [a, b] = (m[1] ?? "").split(",").map(Number);
  const k = Math.hypot(a ?? Number.NaN, b ?? 0);
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/** The inline lengths a place from defaultPlace (`auto`) writes on an unplaced window. */
const AUTO_PROPS = ["left", "top", "right", "bottom", "maxHeight"] as const;
type AutoProp = (typeof AUTO_PROPS)[number];

/** What bringing the windows back inside reads of a window's element. */
export interface AreaWindow {
  getBoundingClientRect(): PageBox;
  style: Pick<InlineStyle, "maxHeight">;
  dataset: DOMStringMap;
  hasAttribute(name: string): boolean;
}

/**
 * A window's height without the max-height that keeps it above the bar: its own (the size
 * the player gave it, or its content's). The max-height is lifted for this one measure
 * and put back as it was, before anything is painted.
 */
export function naturalHeight(el: Pick<AreaWindow, "getBoundingClientRect" | "style">): number {
  const kept = el.style.maxHeight;
  el.style.maxHeight = "none";
  const height = el.getBoundingClientRect().height;
  el.style.maxHeight = kept;
  return height;
}

/**
 * The windows the player placed that are (partly) out of the area now (`area`, on the
 * page), and where they go back inside, their stacking unchanged. GameView asks after the
 * area changed size (a smaller window, a larger interface scale) and whenever the windows
 * shown change (shownKey), so a window that opens or unfolds where a larger screen or the
 * bar left it comes back too. Each counts as tall as keptHeight says (its own height when
 * squashed under MIN_SIZE.height) and without the opening animation's scale (`scaleOf`,
 * transformScale); one fading out is left alone.
 */
export function outsiders<T extends AreaWindow>(
  area: PageBox,
  windows: Iterable<T>,
  s: WindowsState,
  scaleOf: (el: T) => number,
): [WinKey, number, number][] {
  const moves: [WinKey, number, number][] = [];
  for (const el of windows) {
    if (!el.hasAttribute("data-placed") || el.hasAttribute("data-closing")) continue;
    const id = el.dataset["window"] as WinKey | undefined;
    if (!id) continue;
    const p = placeOf(s, id);
    if (p.x === undefined || p.y === undefined) continue;
    const k = scale(scaleOf(el));
    const r = el.getBoundingClientRect();
    const height = keptHeight(r.height / k, () => naturalHeight(el) / k);
    const at = clampPlace(p.x, p.y, { width: r.width / k, height }, area);
    if (at.x !== p.x || at.y !== p.y) moves.push([id, at.x, at.y]);
  }
  return moves;
}

/**
 * A box on screen without the scale of a window's opening animation (`k`, transformScale:
 * gwin-in grows it from its centre), in px of the area at `area`.
 */
export function unscaledIn(r: PageBox, k: number, area: PageBox): Rect {
  const s = scale(k);
  const width = r.width / s;
  const height = r.height / s;
  // To the hundredth of a px: 0.96 does not divide back exactly.
  const round = (v: number): number => Math.round(v * 100) / 100;
  return {
    x: round(r.left + r.width / 2 - width / 2 - area.left),
    y: round(r.top + r.height / 2 - height / 2 - area.top),
    width: round(width),
    height: round(height),
  };
}

/** What placing the windows reads of a window's element: also the lengths of `auto`. */
export interface LayerWindow extends Omit<AreaWindow, "style"> {
  style: Pick<InlineStyle, AutoProp>;
}

/**
 * An unplaced window's box at its usual place (windows.css), as if no earlier look had
 * moved it: the inline lengths of `auto` (placeStyle) are lifted for this one measure and
 * put back as they were, before anything is painted. The dialog the shop came beside
 * still had the left of its place alone, which beat the pair's rule: measured as it was,
 * it was looked at where it no longer belonged.
 */
export function usualBox(el: Pick<LayerWindow, "getBoundingClientRect" | "style">): PageBox {
  const kept = AUTO_PROPS.map((prop) => el.style[prop]);
  for (const prop of AUTO_PROPS) el.style[prop] = "";
  const box = el.getBoundingClientRect();
  AUTO_PROPS.forEach((prop, i) => (el.style[prop] = kept[i] ?? ""));
  return box;
}

/**
 * The windows to look at (`opened`, unplaced: toLookAt of ui/windows.ts) that sit better
 * elsewhere than their usual place seeing the other open windows (defaultPlace): their
 * place, px of the area. Each is measured at its usual place (usualBox), the others where
 * they are; the ones decided first count at their new place for the next. `player` is the
 * player's tile on the page (the trade keeps clear of the tiles north of it); a window
 * fading out is not counted.
 */
export function placeOpened<T extends LayerWindow>(
  area: PageBox,
  windows: Iterable<T>,
  opened: ReadonlySet<WinKey>,
  player: PageBox | undefined,
  scaleOf: (el: T) => number,
): Map<WinKey, AutoPlace> {
  const boxes: { id: WinKey; el: T; rect: Rect }[] = [];
  for (const el of windows) {
    const id = el.dataset["window"] as WinKey | undefined;
    if (!id || el.hasAttribute("data-closing")) continue;
    const looked = opened.has(id) && !el.hasAttribute("data-placed");
    const box = looked ? usualBox(el) : el.getBoundingClientRect();
    boxes.push({ id, el, rect: unscaledIn(box, scaleOf(el), area) });
  }
  const tile = player && {
    x: player.left - area.left,
    y: player.top - area.top,
    width: player.width,
    height: player.height,
  };
  const out = new Map<WinKey, AutoPlace>();
  for (const b of boxes) {
    if (!opened.has(b.id) || b.el.hasAttribute("data-placed")) continue;
    const at = defaultPlace(b.id, b.rect, boxes, area, tile);
    if (!at) continue;
    out.set(b.id, at);
    b.rect = at;
  }
  return out;
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
