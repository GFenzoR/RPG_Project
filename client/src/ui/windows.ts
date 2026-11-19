// Windows of the desktop game screen (docs/17 UI-4, UI-5), pure and unit-tested: which are
// open, where they float over the full-screen map, how big, folded or not, and which is on
// top. Nothing docks any more: the only fixed piece is the bottom bar (ui/HudBar.tsx), and
// every window is dropped anywhere above it, with a magnet (snapPlace) that aligns it to the
// screen's edges, the bar's top and the other windows. Three kinds share these rules:
// - the toolbar's windows (WINDOW_IDS): the toolbar and its keys open and close them, and
//   the chat, which is always open (FIXED_WINDOWS: no ×, Escape skips it);
// - the server's windows (SERVER_WINDOWS: dialog, shop, crafting, market, house, trade);
// - one window per open container ("container-<item>", or "container-remains" for any
//   remains on the ground, containerKeys).
// The server opens and closes the last two (syncWindows follows it); the player still
// moves, resizes and folds them. GameView.tsx only renders what this state says.
// Remembered per device in localStorage (`rpg.windows`, a convenience: if it is lost or
// unreadable, the defaults come back).

/** The windows the toolbar opens, and the chat (always open, no toolbar button). */
export const WINDOW_IDS = [
  "battle",
  "inventory",
  "skills",
  "quests",
  "party",
  "guild",
  "appearance",
  "options",
  "help",
  "chat",
] as const;
export type WindowId = (typeof WINDOW_IDS)[number];

/** The server's windows: they open when the server says so and close through it. */
export const SERVER_WINDOWS = ["dialog", "shop", "crafting", "market", "house", "trade"] as const;
export type ServerWindowId = (typeof SERVER_WINDOWS)[number];

/** A container's window: `container-<item id>`, `container-<item id>-2` for a second one. */
export type ContainerKey = `container-${string}`;

/** Any window of the screen. */
export type WinKey = WindowId | ServerWindowId | ContainerKey;

/** Windows that never close: the chat (RO-like, it only folds). */
export const FIXED_WINDOWS: readonly WinKey[] = ["chat"];

export const isClosable = (id: WinKey): boolean => !FIXED_WINDOWS.includes(id);

export interface WindowPlace {
  open: boolean;
  /** Folded to its title bar. */
  collapsed: boolean;
  /**
   * Top left corner in CSS px from the top left of the windows' area (the screen above
   * the bar); undefined until the player moves it: it then shows at its default place
   * (windows.css).
   */
  x?: number | undefined;
  y?: number | undefined;
  /** The size the player gave it, CSS px; undefined = its default. */
  w?: number | undefined;
  h?: number | undefined;
}

export interface WindowsState {
  /** Stacking, bottom to top: the windows opened or touched (raised) this far. */
  z: WinKey[];
  /** The toolbar's windows and the chat. */
  win: Record<WindowId, WindowPlace>;
  /** The server's windows and the containers' (`open` follows the server, syncWindows). */
  others: Record<string, WindowPlace>;
}

/** localStorage key of the remembered windows. */
export const WINDOWS_STORAGE_KEY = "rpg.windows";

/** Version of the stored JSON (1 and 2 had a dock: their docked windows float now). */
export const WINDOWS_VERSION = 3;

/**
 * Containers remembered at most: the ones whose window changed last (`others` keeps them in
 * that order); the ones beyond it are not saved, nor loaded.
 */
export const MAX_CONTAINER_PLACES = 24;

export const isToolWindow = (v: unknown): v is WindowId =>
  typeof v === "string" && (WINDOW_IDS as readonly string[]).includes(v);

export const isServerWindow = (v: unknown): v is ServerWindowId =>
  typeof v === "string" && (SERVER_WINDOWS as readonly string[]).includes(v);

const CONTAINER_KEY = /^container-[a-z0-9_]+(?:-[2-9]|-[1-9][0-9])?$/;

export const isContainerKey = (v: unknown): v is ContainerKey =>
  typeof v === "string" && CONTAINER_KEY.test(v);

const isKey = (v: unknown): v is WinKey =>
  isToolWindow(v) || isServerWindow(v) || isContainerKey(v);

/** A server or container window seen for the first time: closed, at its default place. */
export function unseenPlace(): WindowPlace {
  return { open: false, collapsed: false };
}

/**
 * A new player: the battle list (top left), the equipment (top right) and the chat
 * (bottom left, over the bar) open at their default places (windows.css); the rest wait
 * closed.
 */
export function defaultWindows(): WindowsState {
  const place = (open: boolean): WindowPlace => ({ open, collapsed: false });
  return {
    z: [],
    win: {
      battle: place(true),
      inventory: place(true),
      skills: place(false),
      quests: place(false),
      party: place(false),
      guild: place(false),
      appearance: place(false),
      options: place(false),
      help: place(false),
      chat: place(true),
    },
    others: {},
  };
}

/** The place of any window (a server or container window never seen: its default). */
export function placeOf(s: WindowsState, id: WinKey): WindowPlace {
  return isToolWindow(id) ? s.win[id] : (s.others[id] ?? unseenPlace());
}

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;

/** A remembered size: positive, else none. */
const size = (v: unknown): number | undefined => {
  const n = finite(v);
  return n !== undefined && n > 0 ? n : undefined;
};

/**
 * The remembered state (the JSON of saveWindows, version 1 to 3), checked field by field:
 * an unknown window is dropped, a missing one gets its default, and anything unreadable
 * gives the defaults. Versions 1 and 2 had a dock: a window that was docked floats now, at
 * its default place and size (its x, y and size were the dock's). The server's and the
 * containers' windows come back closed: the server opens them again. The chat is always
 * open.
 */
export function loadWindows(raw: string | null | undefined): WindowsState {
  const base = defaultWindows();
  if (!raw) return base;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof data !== "object" || data === null) return base;
  const d = data as { v?: unknown; z?: unknown; win?: unknown; others?: unknown };
  if (d.v !== 1 && d.v !== 2 && d.v !== WINDOWS_VERSION) return base;
  const read = (p: unknown, def: WindowPlace): WindowPlace | undefined => {
    if (typeof p !== "object" || p === null) return undefined;
    const w = p as Record<string, unknown>;
    const open = typeof w["open"] === "boolean" ? w["open"] : def.open;
    const collapsed = typeof w["collapsed"] === "boolean" ? w["collapsed"] : false;
    // Docked (versions 1 and 2): out of the dock, at its default place.
    if (w["dock"] === true) return { open, collapsed };
    return {
      open,
      collapsed,
      x: finite(w["x"]),
      y: finite(w["y"]),
      w: size(w["w"]),
      h: size(w["h"]),
    };
  };
  const win = { ...base.win };
  if (typeof d.win === "object" && d.win !== null)
    for (const [id, p] of Object.entries(d.win as Record<string, unknown>)) {
      if (!isToolWindow(id)) continue;
      const place = read(p, base.win[id]);
      if (place) win[id] = place;
    }
  win.chat = { ...win.chat, open: true };
  const others: Record<string, WindowPlace> = {};
  if (d.v !== 1 && typeof d.others === "object" && d.others !== null) {
    const places: [string, WindowPlace][] = [];
    for (const [id, p] of Object.entries(d.others as Record<string, unknown>)) {
      if (!isServerWindow(id) && !isContainerKey(id)) continue;
      const place = read(p, unseenPlace());
      if (place) places.push([id, { ...place, open: false }]);
    }
    for (const [id, place] of lastContainers(places)) others[id] = place;
  }
  const s: WindowsState = { z: [], win, others };
  // Only open windows stack (the server's come back closed: they leave the stack).
  const z = Array.isArray(d.z)
    ? [...new Set(d.z.filter(isKey))].filter(
        (id) => (isToolWindow(id) || id in others) && placeOf(s, id).open,
      )
    : [];
  return { z, win, others };
}

/**
 * The server's windows and the last MAX_CONTAINER_PLACES containers of `entries` (the ones
 * that changed last), in their order.
 */
function lastContainers<T>(entries: readonly [string, T][]): [string, T][] {
  let drop = entries.filter(([id]) => isContainerKey(id)).length - MAX_CONTAINER_PLACES;
  return entries.filter(([id]) => !(isContainerKey(id) && drop-- > 0));
}

/** The JSON stored under WINDOWS_STORAGE_KEY (the server's windows without `open`). */
export function saveWindows(s: WindowsState): string {
  const others = Object.fromEntries(
    lastContainers(Object.entries(s.others)).map(([id, p]) => [
      id,
      { collapsed: p.collapsed, x: p.x, y: p.y, w: p.w, h: p.h },
    ]),
  );
  return JSON.stringify({ v: WINDOWS_VERSION, z: s.z, win: s.win, others });
}

const withPlace = (s: WindowsState, id: WinKey, p: Partial<WindowPlace>): WindowsState => {
  if (isToolWindow(id)) return { ...s, win: { ...s.win, [id]: { ...s.win[id], ...p } } };
  const place = { ...placeOf(s, id), ...p };
  if (!isContainerKey(id)) return { ...s, others: { ...s.others, [id]: place } };
  // A container that changes goes last: the ones that changed longest ago are forgotten
  // first (MAX_CONTAINER_PLACES).
  const others = Object.fromEntries(Object.entries(s.others).filter(([k]) => k !== id));
  others[id] = place;
  return { ...s, others };
};

/** Brings a window to the top. */
export function focusWindow(s: WindowsState, id: WinKey): WindowsState {
  if (s.z[s.z.length - 1] === id) return s;
  return { ...s, z: [...s.z.filter((w) => w !== id), id] };
}

/** Opens a window (unfolded, on top); an open one only comes to the top. */
export function openWindow(s: WindowsState, id: WinKey): WindowsState {
  const w = placeOf(s, id);
  const next = w.open && !w.collapsed ? s : withPlace(s, id, { open: true, collapsed: false });
  return focusWindow(next, id);
}

/** Closes a window (the chat never closes). */
export function closeWindow(s: WindowsState, id: WinKey): WindowsState {
  if (!placeOf(s, id).open || !isClosable(id)) return s;
  return { ...withPlace(s, id, { open: false }), z: s.z.filter((w) => w !== id) };
}

/** The toolbar button and the window's key: open it, or close it if it is open. */
export function toggleWindow(s: WindowsState, id: WindowId): WindowsState {
  return s.win[id].open ? closeWindow(s, id) : openWindow(s, id);
}

export function collapseWindow(s: WindowsState, id: WinKey, collapsed: boolean): WindowsState {
  return placeOf(s, id).collapsed === collapsed ? s : withPlace(s, id, { collapsed });
}

/** Puts a window at x, y (its stacking stays: a resize of the screen moves it in). */
export function placeWindow(s: WindowsState, id: WinKey, x: number, y: number): WindowsState {
  const p = placeOf(s, id);
  const nx = Math.round(x);
  const ny = Math.round(y);
  return p.x === nx && p.y === ny ? s : withPlace(s, id, { x: nx, y: ny });
}

/** The player moved a window to x, y: it goes there, on top. */
export function moveWindow(s: WindowsState, id: WinKey, x: number, y: number): WindowsState {
  return focusWindow(placeWindow(s, id, x, y), id);
}

/** Every window the state knows: the toolbar's, then the server's and the containers'. */
export const knownWindows = (s: WindowsState): WinKey[] => [
  ...WINDOW_IDS,
  ...(Object.keys(s.others) as WinKey[]),
];

/**
 * The open windows, bottom to top (later ones are drawn over the earlier): first those
 * never raised, in the order the state knows them, then the stack.
 */
export function openWindows(s: WindowsState): WinKey[] {
  const open = knownWindows(s).filter((id) => placeOf(s, id).open);
  const rank = (id: WinKey): number => s.z.indexOf(id);
  return open.sort((a, b) => rank(a) - rank(b));
}

/**
 * The windows in the order they go in the page: always the same (the toolbar's, the
 * server's, then the containers by key), whatever their stacking, which is only their
 * z-index (openWindows). A window brought to the front keeps its node where it is: moved,
 * the node replayed its opening animation, lost the focus inside it and its scroll.
 */
export function pageOrder(ids: readonly WinKey[]): WinKey[] {
  const fixed: readonly string[] = [...WINDOW_IDS, ...SERVER_WINDOWS];
  const rank = (id: WinKey): number => {
    const i = fixed.indexOf(id);
    return i < 0 ? fixed.length : i;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The window Escape closes: the one on top of the stack (the last opened or touched) that
 * can close; undefined when there is none (Escape then opens the options). The windows a
 * new player starts with (battle, equipment) sit under the stack until they are touched,
 * so Escape still opens the options on a fresh screen, as with the old dock.
 */
export function topWindow(s: WindowsState): WinKey | undefined {
  for (let i = s.z.length - 1; i >= 0; i--) {
    const id = s.z[i];
    if (id !== undefined && placeOf(s, id).open && isClosable(id)) return id;
  }
  return undefined;
}

/**
 * Follows the server: the server and container windows in `open` are open, the others are
 * closed. A window that just opened comes on top (a server's window over a container that
 * opened with it). The same state when nothing changes, so it can run on every update.
 */
export function syncWindows(s: WindowsState, open: readonly WinKey[]): WindowsState {
  let next = s;
  const want = new Set<WinKey>(open.filter((id) => !isToolWindow(id)));
  for (const id of Object.keys(s.others) as WinKey[])
    if (s.others[id]?.open && !want.has(id)) next = closeWindow(next, id);
  // Containers first: a dialog or a station that opens with them comes above them.
  const order = [...want].sort((a, b) => Number(!isContainerKey(a)) - Number(!isContainerKey(b)));
  for (const id of order) {
    if (placeOf(next, id).open && id in next.others) continue;
    next = focusWindow(withPlace(next, id, { open: true }), id);
  }
  return next;
}

/** What the server has open for the player (GameUi: dialog, shop, station...). */
export interface ServerOpen {
  dialog: boolean;
  shop: boolean;
  station: boolean;
  market: boolean;
  house: boolean;
  trade: boolean;
}

/**
 * The server's windows to show, as they always showed: the shop only with its dialog; the
 * station and the market wait while a dialog is open; the house waits for the dialog and
 * the market. Then one window per open container.
 */
export function serverWindows(o: ServerOpen, containers: readonly ContainerKey[]): WinKey[] {
  const out: WinKey[] = [];
  if (o.dialog) out.push("dialog");
  if (o.dialog && o.shop) out.push("shop");
  if (!o.dialog && o.station) out.push("crafting");
  if (!o.dialog && o.market) out.push("market");
  if (!o.dialog && !o.market && o.house) out.push("house");
  if (o.trade) out.push("trade");
  return [...out, ...containers];
}

/**
 * "Reset windows" (Options): the defaults, with the options open (its button is there),
 * and the server's windows that are open now still open, at their default places.
 */
export function resetWindows(s: WindowsState): WindowsState {
  const open = (Object.keys(s.others) as WinKey[]).filter((id) => s.others[id]?.open);
  return openWindow(syncWindows(defaultWindows(), open), "options");
}

export interface Box {
  width: number;
  height: number;
}

/** A window's box in CSS px from the top left of the windows' area. */
export interface Rect extends Box {
  x: number;
  y: number;
}

/**
 * Where a window of `size` may sit in an area of `area` (the screen above the bar): all of
 * it inside, never off the screen nor under the bar. One larger than the area sits at its
 * top left (its max-height in windows.css keeps it above the bar).
 */
export function clampPlace(x: number, y: number, size: Box, area: Box): { x: number; y: number } {
  const maxX = Math.max(0, area.width - size.width);
  const maxY = Math.max(0, area.height - size.height);
  return {
    x: Math.round(Math.min(Math.max(x, 0), maxX)),
    y: Math.round(Math.min(Math.max(y, 0), maxY)),
  };
}

/** How near (CSS px) an edge has to come to another for the magnet to take it. */
export const SNAP_PX = 10;

/**
 * The magnet (the owner's choice, docs/17 UI-5): a window dropped near an edge snaps to
 * it, on each axis to the nearest edge within `within` px:
 * - the screen's edges, and the bar's top (the area's bottom);
 * - another window's edges, both ways: beside it (its left to the other's right, and so
 *   on) or aligned with it (left with left, top with top...), only when the two are side
 *   by side or one over the other (near on the other axis), so a far window never pulls.
 * Then it is kept inside the area (clampPlace).
 */
export function snapPlace(
  r: Rect,
  area: Box,
  others: readonly Rect[],
  within: number = SNAP_PX,
): { x: number; y: number } {
  const xs: number[] = [0, area.width - r.width];
  const ys: number[] = [0, area.height - r.height];
  for (const o of others) {
    const nearY = r.y < o.y + o.height + within && r.y + r.height > o.y - within;
    const nearX = r.x < o.x + o.width + within && r.x + r.width > o.x - within;
    if (nearY) xs.push(o.x + o.width, o.x - r.width, o.x, o.x + o.width - r.width);
    if (nearX) ys.push(o.y + o.height, o.y - r.height, o.y, o.y + o.height - r.height);
  }
  // The nearest edge on the axis (the first one listed on a tie: the screen's), if near.
  const pick = (v: number, targets: readonly number[]): number => {
    let best = v;
    let gap = Number.POSITIVE_INFINITY;
    for (const t of targets) {
      const d = Math.abs(t - v);
      if (d < gap) {
        gap = d;
        best = t;
      }
    }
    return gap <= within ? best : v;
  };
  return clampPlace(pick(r.x, xs), pick(r.y, ys), r, area);
}

/** The smallest a window gets (docs/17 UI-5: "un tamaño mínimo"), CSS px. */
export const MIN_SIZE = { width: 160, height: 72 } as const;

/** A size the player asks for, between MIN_SIZE and the area (never larger than it). */
export function clampSize(width: number, height: number, area: Box): Box {
  const maxW = Math.max(MIN_SIZE.width, area.width);
  const maxH = Math.max(MIN_SIZE.height, area.height);
  return {
    width: Math.round(Math.min(Math.max(width, MIN_SIZE.width), maxW)),
    height: Math.round(Math.min(Math.max(height, MIN_SIZE.height), maxH)),
  };
}

/** Sets the size of a window. */
export function resizeWindow(
  s: WindowsState,
  id: WinKey,
  width: number,
  height: number,
): WindowsState {
  return withPlace(s, id, { w: Math.round(width), h: Math.round(height) });
}

/**
 * How tall a window the player placed counts for clampPlace when the area changes or the
 * windows shown do (GameView): what it shows now (`now`, short of its own height when the
 * area's bottom came up under it: its max-height keeps it above the bar) while that is
 * MIN_SIZE.height at least, so it stays where the player left it, its body scrolling;
 * less, its own height (`natural`, measured only then: its content's or the size the player
 * gave it, a folded one's title bar), so it moves up until it shows whole, or as tall as
 * the area. Measured squashed, a window whose top the area left behind counted a few px
 * and stayed there, its title bar over the bar and no room for its body.
 */
export function keptHeight(now: number, natural: () => number): number {
  return now >= MIN_SIZE.height ? now : Math.max(now, natural());
}

/**
 * What the windows shown are, as a key that changes when one opens, closes, folds or
 * unfolds (not when one is only raised): GameView then brings back inside one that a
 * larger screen left outside, before it is painted.
 */
export function shownKey(s: WindowsState): string {
  return knownWindows(s)
    .filter((id) => placeOf(s, id).open)
    .map((id) => (placeOf(s, id).collapsed ? `${id}:folded` : id))
    .sort()
    .join(" ");
}

/**
 * Where the containers' default column starts (windows.css --containers-top), in the
 * windows' own px: right under the equipment while it is open at its default place (top
 * right) and measured (`height`, its own px); else the top of the area, which it leaves
 * free. The equipment's height changes with its backpack, its fold and the text scale.
 */
export function containersTop(equipment: WindowPlace, height: number | undefined): number {
  const placed = equipment.x !== undefined && equipment.y !== undefined;
  return equipment.open && !placed && height !== undefined && height > 0 ? Math.round(height) : 0;
}

// ---- A factory place that sees the open windows (docs/17 UI-5) -------------------------
// windows.css gives each window its usual place. When a window opens there and that place
// covers another open window (or, the trade, the tiles north of the player, where the
// partner stands), defaultPlace looks through a short list of other places for it, nearest
// first, and takes the first that covers nothing; else the one that covers least, if it
// covers less than the usual place. GameView measures the boxes and keeps the answer while
// the window stays open (it is not the player's: nothing is saved).

/** An open window and its box (CSS px from the top left of the windows' area). */
export interface OpenBox {
  id: WinKey;
  rect: Rect;
}

/** Where defaultPlace puts a window: its box; `short` when it was shortened to fit. */
export interface AutoPlace extends Rect {
  /** Shorter than at its usual place: `height` is its most and its body scrolls. */
  short?: boolean | undefined;
}

/** Tiles north of the player that the trade never covers: the partner stands there. */
export const TRADE_CLEAR_TILES = 3;
/** The shortest a window gets when it gives way to another (its title bar and three lines
 * or so; its body scrolls), CSS px. */
export const GIVE_WAY_MIN_PX = 120;
/** Room a window leaves between it and the window it gives way to, CSS px. */
export const PLACE_GAP = 4;

/** Over the middle of the bar (windows.css): the NPC's and the stations' windows. */
const BOTTOM_WINDOWS: readonly WinKey[] = ["dialog", "crafting", "market", "house"];

/** How much of `a` covers `b`, px² (edges that touch, or slivers under 1 px, do not count). */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w >= 1 && h >= 1 ? w * h : 0;
}

/** The player's tile and the TRADE_CLEAR_TILES north of it (`tile`: the player's tile). */
export function northOfPlayer(tile: Rect): Rect {
  return {
    x: tile.x,
    y: tile.y - TRADE_CLEAR_TILES * tile.height,
    width: tile.width,
    height: (TRADE_CLEAR_TILES + 1) * tile.height,
  };
}

/**
 * `usual` shortened to give way to the windows that reach into it from one side: from
 * above (its bottom stays: the windows over the bar) or from below (its top stays); none
 * when nothing does or it would end shorter than GIVE_WAY_MIN_PX.
 */
function givingWay(usual: Rect, others: readonly OpenBox[], from: "above" | "below"): AutoPlace[] {
  let top = usual.y;
  let bottom = usual.y + usual.height;
  let gives = false;
  for (const o of others) {
    if (overlapArea(usual, o.rect) === 0) continue;
    if (from === "above" && o.rect.y < usual.y) {
      top = Math.max(top, o.rect.y + o.rect.height + PLACE_GAP);
      gives = true;
    }
    if (from === "below" && o.rect.y > usual.y) {
      bottom = Math.min(bottom, o.rect.y - PLACE_GAP);
      gives = true;
    }
  }
  const y = Math.ceil(top);
  const height = Math.floor(bottom) - y;
  if (!gives || height < GIVE_WAY_MIN_PX) return [];
  return [{ x: usual.x, y, width: usual.width, height, short: true }];
}

/** The other places of a window, the preferred first (an empty list: only the usual). */
function alternatives(
  id: WinKey,
  usual: Rect,
  others: readonly OpenBox[],
  area: Box,
  zone: Rect | undefined,
): AutoPlace[] {
  const at = (x: number, y: number): AutoPlace => ({
    ...clampPlace(x, y, usual, area),
    width: usual.width,
    height: usual.height,
  });
  const box = (w: WinKey): Rect | undefined => others.find((o) => o.id === w)?.rect;
  if (id === "trade") {
    // Along its row (the top of the screen), the nearest first: against the area's edges,
    // beside the column over the player, or beside another window, PLACE_GAP away; then
    // the same places flush against them (edges that touch cover nothing). At 1280x800
    // the room between the battle list and the player's column is the trade's width
    // exactly: with the gap, each side covered 4 px of a window.
    const beside = (gap: number): number[] => {
      const xs: number[] = [];
      if (zone) xs.push(zone.x - gap - usual.width, zone.x + zone.width + gap);
      for (const o of others) xs.push(o.rect.x - gap - usual.width, o.rect.x + o.rect.width + gap);
      return xs;
    };
    const nearest = (xs: readonly number[]): AutoPlace[] =>
      xs
        .map((x) => at(x, usual.y))
        .sort((a, b) => Math.abs(a.x - usual.x) - Math.abs(b.x - usual.x));
    return [...nearest([0, area.width - usual.width, ...beside(PLACE_GAP)]), ...nearest(beside(0))];
  }
  // Over the bar: shorter, under what comes down to it (at 960x700 the equipment's
  // column reaches the dialog of the shop and dialog pair).
  if (BOTTOM_WINDOWS.includes(id)) return givingWay(usual, others, "above");
  if (id === "skills") {
    // Under the battle list only while it fits above the chat; else beside the battle
    // list or the party, or left of the equipment's column; last, under the battle list
    // still, shortened to end above the chat.
    const out: AutoPlace[] = [];
    for (const w of ["battle", "party"] as const) {
      const r = box(w);
      if (r) out.push(at(r.x + r.width, r.y));
    }
    for (const w of ["appearance", "guild", "quests", "inventory"] as const) {
      const r = box(w);
      if (r) out.push(at(r.x - usual.width, r.y));
    }
    return [...out, ...givingWay(usual, others, "below")];
  }
  return [];
}

/** Whether a window has other places than its usual one (GameView measures only these). */
export const movesAside = (id: WinKey): boolean =>
  id === "trade" || id === "skills" || BOTTOM_WINDOWS.includes(id);

/**
 * Where a window that opens at its factory place goes, seeing the open windows: `usual` is
 * its box at the place windows.css gives it, `open` the other open windows' boxes, `area`
 * the windows' area and `player` the player's tile (all CSS px of that area). Undefined:
 * the usual place is fine, or no other place covers less. Never over the tiles north of the
 * player for the trade (a usual place there moves even onto another window).
 */
export function defaultPlace(
  id: WinKey,
  usual: Rect,
  open: readonly OpenBox[],
  area: Box,
  player?: Rect | undefined,
): AutoPlace | undefined {
  const others = open.filter((o) => o.id !== id);
  const zone = id === "trade" && player ? northOfPlayer(player) : undefined;
  const cost = (r: Rect): number =>
    zone && overlapArea(r, zone) > 0
      ? Number.POSITIVE_INFINITY
      : others.reduce((n, o) => n + overlapArea(r, o.rect), 0);
  let least = cost(usual);
  if (least === 0) return undefined;
  let best: AutoPlace | undefined;
  for (const c of alternatives(id, usual, others, area, zone)) {
    const k = cost(c);
    if (k >= least) continue;
    best = c;
    least = k;
    if (k === 0) break;
  }
  return best;
}

/** What moves the usual place of each window while it stays open (placeContext). */
export type PlaceContext = Readonly<Partial<Record<WinKey, string>>>;

/**
 * What moves a window's usual place while it stays open, so GameView looks at it again
 * when this changes (toLookAt): the dialog sits beside the shop while the shop's window is
 * open (windows.css, the pair: narrower and further right), and it takes another height
 * with another NPC's dialog (`dialogId`). Read from the windows' state, not from the
 * server's: the shop is measured once its window is in the page.
 */
export function placeContext(s: WindowsState, dialogId: number | undefined): PlaceContext {
  return { dialog: `${dialogId ?? ""}|${placeOf(s, "shop").open ? "shop" : ""}` };
}

/** What GameView saw the last time it looked at the windows' places (toLookAt). */
export interface LastLook {
  open: ReadonlySet<WinKey>;
  context: PlaceContext;
}

/**
 * The windows to measure for a place that sees the others (defaultPlace) now that the
 * windows are `s`: the unplaced ones with other places (movesAside) that opened since the
 * last look `last`, all the open ones after the area changed size (`fresh`), and those
 * whose usual place moved while they stayed open (their `context` changed: the dialog
 * the shop came beside, another NPC's dialog). Each is measured at its usual place: the
 * place an earlier look gave it is forgotten.
 */
export function toLookAt(
  s: WindowsState,
  last: LastLook,
  context: PlaceContext,
  fresh: boolean,
): Set<WinKey> {
  return new Set(
    knownWindows(s).filter((id) => {
      const p = placeOf(s, id);
      if (!p.open || p.x !== undefined || !movesAside(id)) return false;
      return fresh || !last.open.has(id) || last.context[id] !== context[id];
    }),
  );
}

/**
 * Whether the tutorial's hint gives way (GameView hides it): the help, the guild, the
 * appearance or the quest log is open at its factory place, which covers the hint's (the
 * guild, the appearance and the quest log always; the help on screens under ~1600 px), and
 * the windows go over it.
 */
export function tutorialCovered(s: WindowsState): boolean {
  return (["help", "guild", "appearance", "quests"] as const).some((id) => {
    const p = s.win[id];
    return p.open && (p.x === undefined || p.y === undefined);
  });
}

/** How far one arrow press moves or resizes a window, CSS px. */
export const KEY_STEP = 16;

/** Where a window is and what is around it, for windowNudge. */
export interface NudgeContext {
  /** Its box now (CSS px from the top left of the windows' area). */
  rect: Rect;
  /** The windows' area (the screen above the bar). */
  area: Box;
  /** The other open windows (the magnet aligns with them too). */
  others?: readonly Rect[] | undefined;
}

/**
 * The keyboard on a window's move handle (docs/17 UI-1, UI-5: everything with the keyboard):
 * the arrows move it KEY_STEP px (with the magnet, inside the area), Shift+arrows resize it
 * (right and down grow; the top left corner stays). Undefined for any other key (it then does what it does
 * elsewhere); Alt is left to the browser (Alt+Left goes back).
 */
export function windowNudge(
  s: WindowsState,
  id: WinKey,
  e: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  ctx: NudgeContext,
): WindowsState | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const d: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const dir = d[e.key];
  if (!dir) return undefined;
  const [dx, dy] = dir;
  const { rect, area } = ctx;
  if (e.shiftKey) {
    const room = { width: area.width - rect.x, height: area.height - rect.y };
    const size = clampSize(rect.width + dx * KEY_STEP, rect.height + dy * KEY_STEP, room);
    // Pinned where it is: one at a default place that hangs from the bottom (the chat, the
    // dialog) would otherwise grow upwards.
    return resizeWindow(placeWindow(s, id, rect.x, rect.y), id, size.width, size.height);
  }
  const at = snapPlace(
    { ...rect, x: rect.x + dx * KEY_STEP, y: rect.y + dy * KEY_STEP },
    area,
    ctx.others ?? [],
  );
  return moveWindow(s, id, at.x, at.y);
}

/**
 * The name in the window key of every container that stays on the ground (`fixed`: the
 * remains of a monster of any family, or of a player): they all open in one place, the one
 * the player left the last of them in, instead of one per kind of remains.
 */
export const REMAINS_PLACE = "remains";

/**
 * The window key of each open container (`container-<item>`, `-2`, `-3`... for more of the
 * same item; `container-remains` for the remains, REMAINS_PLACE): a container keeps its key
 * while it stays open, so a second backpack does not take the first one's place when that
 * one closes. `open` is the server's order; `fixed` is the item's `pickupable: false`.
 */
export function containerKeys(
  prev: ReadonlyMap<number, ContainerKey>,
  open: readonly { id: number; item: string; fixed?: boolean }[],
): Map<number, ContainerKey> {
  const next = new Map<number, ContainerKey>();
  for (const c of open) {
    const k = prev.get(c.id);
    if (k) next.set(c.id, k);
  }
  const used = new Set(next.values());
  for (const c of open) {
    if (next.has(c.id)) continue;
    const item = c.fixed ? REMAINS_PLACE : c.item.replace(/[^a-z0-9_]/g, "_") || "item";
    let k: ContainerKey = `container-${item}`;
    for (let n = 2; used.has(k) && n < 100; n++) k = `container-${item}-${n}`;
    next.set(c.id, k);
    used.add(k);
  }
  return next;
}

/** Keys that open and close windows (KeyboardEvent.code); none clashes with WASD. */
export const WINDOW_KEYS: Readonly<Record<string, WindowId>> = {
  KeyB: "battle",
  KeyI: "inventory",
  KeyK: "skills",
  KeyL: "quests",
  KeyP: "party",
  KeyG: "guild",
  KeyO: "appearance",
  KeyH: "help",
};

/** The key shown in the tooltip and aria-keyshortcuts of each toolbar button. */
export const WINDOW_KEY_LABEL: Readonly<Record<WindowId, string>> = {
  battle: "B",
  inventory: "I",
  skills: "K",
  quests: "L",
  party: "P",
  guild: "G",
  appearance: "O",
  options: "Escape",
  help: "H",
  chat: "",
};

/** Title key of each window. */
export const WINDOW_TITLE: Readonly<Record<WindowId, string>> = {
  battle: "client.battle.title",
  inventory: "client.inventory.title",
  skills: "client.skills.title",
  quests: "client.quests.title",
  party: "client.party.title",
  guild: "client.guild.title",
  appearance: "client.appearance.title",
  options: "client.options.button",
  help: "client.help.title",
  chat: "client.chat.title",
};

/**
 * What a key press does to the windows, or undefined when it is not a window key: a
 * window key toggles its window; Escape closes the window on top (a server's or a
 * container's too: GameView asks the server), or opens the options when there is none.
 * Keys with Ctrl, Alt or Meta are never window keys.
 */
export function windowKey(
  s: WindowsState,
  e: { code: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean },
): WindowsState | undefined {
  if (e.ctrlKey || e.altKey || e.metaKey) return undefined;
  if (e.code === "Escape") {
    const top = topWindow(s);
    return top ? closeWindow(s, top) : openWindow(s, "options");
  }
  const id = WINDOW_KEYS[e.code];
  return id ? toggleWindow(s, id) : undefined;
}

/**
 * The window that holds a tutorial highlight (a `data-tutorial` value), opened (and
 * unfolded) so the highlighted element is on screen; undefined when it is not in a window
 * (the stats and the hotbar are in the bar, always shown).
 */
export function windowForHighlight(highlight: string | undefined): WindowId | undefined {
  switch (highlight) {
    case "battle":
    case "inventory":
    case "skills":
    case "chat":
      return highlight;
    default:
      return undefined;
  }
}
