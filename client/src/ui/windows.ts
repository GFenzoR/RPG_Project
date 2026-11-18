// Windows of the desktop game screen (docs/17 UI-5), pure and unit-tested: which are open,
// which sit in the dock (the column right of the map, Tibia-like) and which float over the
// map, where, how big, folded or not, and which is on top. Three kinds share these rules:
// - the toolbar's windows (WINDOW_IDS): the toolbar and its keys open and close them;
// - the server's windows (SERVER_WINDOWS: dialog, shop, crafting, market, house, trade);
// - one window per open container ("container-<item>", containerKeys).
// The server opens and closes the last two (syncWindows follows it); the player still
// docks, moves, resizes and folds them. App.tsx only renders what this state says.
// Remembered per device in localStorage (`rpg.windows`, a convenience: if it is lost or
// unreadable, the defaults come back).

/** The windows the toolbar opens. */
export const WINDOW_IDS = [
  "battle",
  "inventory",
  "skills",
  "party",
  "guild",
  "appearance",
  "options",
  "help",
] as const;
export type WindowId = (typeof WINDOW_IDS)[number];

/** The server's windows: they open when the server says so and close through it. */
export const SERVER_WINDOWS = ["dialog", "shop", "crafting", "market", "house", "trade"] as const;
export type ServerWindowId = (typeof SERVER_WINDOWS)[number];

/** A container's window: `container-<item id>`, `container-<item id>-2` for a second one. */
export type ContainerKey = `container-${string}`;

/** Any window of the screen. */
export type WinKey = WindowId | ServerWindowId | ContainerKey;

export interface WindowPlace {
  open: boolean;
  /** In the dock (true) or floating over the map (false). */
  dock: boolean;
  /** Folded to its title bar. */
  collapsed: boolean;
  /**
   * Top left corner of a floating window in CSS px from the top left of the game area;
   * undefined until the player moves it (it then shows at its default place).
   */
  x?: number | undefined;
  y?: number | undefined;
  /**
   * The size the player gave it, CSS px; undefined = its default. A docked window is as
   * wide as the dock: only its height counts there.
   */
  w?: number | undefined;
  h?: number | undefined;
}

export interface WindowsState {
  /** Dock order, top to bottom (every docked window, open or not). */
  order: WinKey[];
  /** Stacking of the floating windows, bottom to top. */
  z: WinKey[];
  /** The toolbar's windows. */
  win: Record<WindowId, WindowPlace>;
  /** The server's windows and the containers' (`open` follows the server, syncWindows). */
  others: Record<string, WindowPlace>;
}

/** localStorage key of the remembered windows. */
export const WINDOWS_STORAGE_KEY = "rpg.windows";

/** Containers remembered at most (the oldest places beyond it are forgotten on load). */
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

/**
 * Where a server or container window shows the first time: containers in the dock (as in
 * Tibia: under the equipment), the server's windows over the map (where they were before
 * they became windows: the dialog at the bottom centre, the market top left...).
 */
export function defaultPlace(id: WinKey): WindowPlace {
  return { open: false, dock: isContainerKey(id), collapsed: false };
}

/**
 * A new player: the battle list and the equipment open in the dock, as in Tibia; skills and
 * party wait closed in the dock; the guild, the appearance, the options and the help float.
 */
export function defaultWindows(): WindowsState {
  const place = (open: boolean, dock: boolean): WindowPlace => ({ open, dock, collapsed: false });
  return {
    order: ["battle", "inventory", "skills", "party"],
    z: [],
    win: {
      battle: place(true, true),
      inventory: place(true, true),
      skills: place(false, true),
      party: place(false, true),
      guild: place(false, false),
      appearance: place(false, false),
      options: place(false, false),
      help: place(false, false),
    },
    others: {},
  };
}

/** The place of any window (a server or container window never seen: its default). */
export function placeOf(s: WindowsState, id: WinKey): WindowPlace {
  return isToolWindow(id) ? s.win[id] : (s.others[id] ?? defaultPlace(id));
}

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;

/** A remembered size: positive, else none. */
const size = (v: unknown): number | undefined => {
  const n = finite(v);
  return n !== undefined && n > 0 ? n : undefined;
};

/**
 * The remembered state (the JSON of saveWindows, version 1 or 2), checked field by field: an
 * unknown window is dropped, a missing one gets its default, and anything unreadable gives
 * the defaults. The server's and the containers' windows come back closed: the server
 * opens them again.
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
  const d = data as { v?: unknown; order?: unknown; z?: unknown; win?: unknown; others?: unknown };
  if (d.v !== 1 && d.v !== 2) return base;
  const read = (p: unknown, def: WindowPlace): WindowPlace | undefined => {
    if (typeof p !== "object" || p === null) return undefined;
    const w = p as Record<string, unknown>;
    return {
      open: typeof w["open"] === "boolean" ? w["open"] : def.open,
      dock: typeof w["dock"] === "boolean" ? w["dock"] : def.dock,
      collapsed: typeof w["collapsed"] === "boolean" ? w["collapsed"] : false,
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
  const others: Record<string, WindowPlace> = {};
  if (d.v === 2 && typeof d.others === "object" && d.others !== null) {
    let containers = 0;
    for (const [id, p] of Object.entries(d.others as Record<string, unknown>)) {
      if (!isServerWindow(id) && !isContainerKey(id)) continue;
      if (isContainerKey(id) && ++containers > MAX_CONTAINER_PLACES) continue;
      const place = read(p, defaultPlace(id));
      if (place) others[id] = { ...place, open: false };
    }
  }
  const s: WindowsState = { order: [], z: [], win, others };
  const ids = (v: unknown): WinKey[] =>
    Array.isArray(v) ? [...new Set(v.filter(isKey))] : ([] as WinKey[]);
  const known = (id: WinKey): boolean => isToolWindow(id) || id in others;
  // Every docked window has a place in the dock order; nothing floating keeps one.
  const order = ids(d.order).filter((id) => known(id) && placeOf(s, id).dock);
  for (const id of WINDOW_IDS) if (win[id].dock && !order.includes(id)) order.push(id);
  for (const id of Object.keys(others) as WinKey[])
    if (placeOf(s, id).dock && !order.includes(id)) order.push(id);
  const z = ids(d.z).filter((id) => known(id) && !placeOf(s, id).dock);
  return { order, z, win, others };
}

/** The JSON stored under WINDOWS_STORAGE_KEY (the server's windows without `open`). */
export function saveWindows(s: WindowsState): string {
  const others = Object.fromEntries(
    Object.entries(s.others).map(([id, p]) => [
      id,
      { dock: p.dock, collapsed: p.collapsed, x: p.x, y: p.y, w: p.w, h: p.h },
    ]),
  );
  return JSON.stringify({ v: 2, order: s.order, z: s.z, win: s.win, others });
}

const withPlace = (s: WindowsState, id: WinKey, p: Partial<WindowPlace>): WindowsState =>
  isToolWindow(id)
    ? { ...s, win: { ...s.win, [id]: { ...s.win[id], ...p } } }
    : { ...s, others: { ...s.others, [id]: { ...placeOf(s, id), ...p } } };

/** Brings a floating window to the top (a docked one has no stacking). */
export function focusWindow(s: WindowsState, id: WinKey): WindowsState {
  if (placeOf(s, id).dock || s.z[s.z.length - 1] === id) return s;
  return { ...s, z: [...s.z.filter((w) => w !== id), id] };
}

/** Opens a window (unfolded, on top); an open one only comes to the top. */
export function openWindow(s: WindowsState, id: WinKey): WindowsState {
  const w = placeOf(s, id);
  const next = w.open && !w.collapsed ? s : withPlace(s, id, { open: true, collapsed: false });
  return focusWindow(next, id);
}

export function closeWindow(s: WindowsState, id: WinKey): WindowsState {
  if (!placeOf(s, id).open) return s;
  return { ...withPlace(s, id, { open: false }), z: s.z.filter((w) => w !== id) };
}

/** The toolbar button and the window's key: open it, or close it if it is open. */
export function toggleWindow(s: WindowsState, id: WindowId): WindowsState {
  return s.win[id].open ? closeWindow(s, id) : openWindow(s, id);
}

export function collapseWindow(s: WindowsState, id: WinKey, collapsed: boolean): WindowsState {
  return placeOf(s, id).collapsed === collapsed ? s : withPlace(s, id, { collapsed });
}

/** Takes a window out of the dock (or moves a floating one) to x, y, on top. */
export function floatWindow(s: WindowsState, id: WinKey, x: number, y: number): WindowsState {
  const moved = withPlace(s, id, { dock: false, x: Math.round(x), y: Math.round(y) });
  return focusWindow(
    { ...moved, order: s.order.filter((w) => w !== id), z: s.z.filter((w) => w !== id) },
    id,
  );
}

/**
 * Puts a window in the dock right before `before` (a docked window), or at the end when
 * `before` is undefined, not docked or the window itself.
 */
export function dockWindow(s: WindowsState, id: WinKey, before: WinKey | undefined): WindowsState {
  const order = s.order.filter((w) => w !== id);
  const at = before === undefined || before === id ? -1 : order.indexOf(before);
  order.splice(at < 0 ? order.length : at, 0, id);
  return {
    ...withPlace(s, id, { dock: true }),
    order,
    z: s.z.filter((w) => w !== id),
  };
}

/** Every window the state knows: the toolbar's, then the server's and the containers'. */
const allKeys = (s: WindowsState): WinKey[] => [
  ...WINDOW_IDS,
  ...(Object.keys(s.others) as WinKey[]),
];

/** The open docked windows, top to bottom. */
export const dockedWindows = (s: WindowsState): WinKey[] =>
  s.order.filter((id) => placeOf(s, id).open && placeOf(s, id).dock);

/** The open floating windows, bottom to top (later ones are drawn over the earlier). */
export function floatingWindows(s: WindowsState): WinKey[] {
  const open = allKeys(s).filter((id) => placeOf(s, id).open && !placeOf(s, id).dock);
  const rank = (id: WinKey): number => {
    const i = s.z.indexOf(id);
    return i < 0 ? -1 : i;
  };
  return open.sort((a, b) => rank(a) - rank(b));
}

/** The window Escape closes: the floating one on top; undefined when none floats. */
export function topWindow(s: WindowsState): WinKey | undefined {
  const f = floatingWindows(s);
  return f[f.length - 1];
}

/**
 * Follows the server: the server and container windows in `open` are open, the others are
 * closed. A window that just opened comes on top (floating) or takes its place in the dock
 * (a container seen for the first time goes at the end). The same state when nothing
 * changes, so it can run on every update.
 */
export function syncWindows(s: WindowsState, open: readonly WinKey[]): WindowsState {
  let next = s;
  const want = new Set<WinKey>(open.filter((id) => !isToolWindow(id)));
  for (const id of Object.keys(s.others) as WinKey[])
    if (s.others[id]?.open && !want.has(id)) next = closeWindow(next, id);
  for (const id of want) {
    if (placeOf(next, id).open && id in next.others) continue;
    next = withPlace(next, id, { open: true });
    const p = placeOf(next, id);
    if (p.dock && !next.order.includes(id)) next = { ...next, order: [...next.order, id] };
    next = focusWindow(next, id);
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

/** Part of a window that always stays on screen, so its title bar can be grabbed. */
export const GRIP = { x: 64, y: 32 } as const;

/**
 * Where a floating window of `size` may sit in an area of `area`: its title bar never
 * leaves the area (at least GRIP of it shows), and it never starts above the top.
 */
export function clampPlace(x: number, y: number, size: Box, area: Box): { x: number; y: number } {
  const minX = Math.min(0, GRIP.x - size.width);
  const maxX = Math.max(0, area.width - GRIP.x);
  const maxY = Math.max(0, area.height - GRIP.y);
  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, 0), maxY)),
  };
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

/** Sets the size of a window (a docked one keeps only the height). */
export function resizeWindow(
  s: WindowsState,
  id: WinKey,
  width: number,
  height: number,
): WindowsState {
  const dock = placeOf(s, id).dock;
  return withPlace(s, id, {
    w: dock ? placeOf(s, id).w : Math.round(width),
    h: Math.round(height),
  });
}

/** Moves a docked window `by` places up (negative) or down the dock. */
export function moveInDock(s: WindowsState, id: WinKey, by: number): WindowsState {
  const shown = dockedWindows(s);
  const i = shown.indexOf(id);
  if (i < 0) return s;
  const to = Math.min(Math.max(i + by, 0), shown.length - 1);
  if (to === i) return s;
  // Before the window that will follow it (by > 0: the one after the target).
  const before = by < 0 ? shown[to] : shown[to + 1];
  return dockWindow(s, id, before);
}

/** How far one arrow press moves or resizes a window, CSS px. */
export const KEY_STEP = 16;

/** Where a window is and where it may go, for windowNudge. */
export interface NudgeContext {
  /** Its box now (CSS px from the top left of the game area). */
  rect: { x: number; y: number; width: number; height: number };
  /** The game area. */
  area: Box;
  /** Where it floats when it leaves the dock from the keyboard (beside the dock). */
  floatAt: { x: number; y: number };
}

/**
 * The keyboard on a window's move handle (docs/17 UI-1, UI-5: everything with the keyboard).
 * Floating: the arrows move it, Shift+arrows resize it (right and down grow); docked: up
 * and down move it in the dock, Shift+up and down change its height. Enter or Space docks a
 * floating window, or floats a docked one beside the dock. Undefined for any other key (it
 * then does what it does elsewhere); Alt is left to the browser (Alt+Left goes back).
 */
export function windowNudge(
  s: WindowsState,
  id: WinKey,
  e: { key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  ctx: NudgeContext,
): WindowsState | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const p = placeOf(s, id);
  if (e.key === "Enter" || e.key === " ") {
    return p.dock ? floatWindow(s, id, ctx.floatAt.x, ctx.floatAt.y) : dockWindow(s, id, undefined);
  }
  const d: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const dir = d[e.key];
  if (!dir) return undefined;
  const step = KEY_STEP;
  const [dx, dy] = dir;
  const { rect, area } = ctx;
  if (e.shiftKey) {
    if (p.dock && dx !== 0) return s; // the dock sets the width
    const size = clampSize(rect.width + dx * step, rect.height + dy * step, area);
    return resizeWindow(s, id, size.width, size.height);
  }
  if (p.dock) return dy === 0 ? s : moveInDock(s, id, dy);
  const at = clampPlace(rect.x + dx * step, rect.y + dy * step, rect, area);
  return floatWindow(s, id, at.x, at.y);
}

/**
 * The window key of each open container (`container-<item>`, `-2`, `-3`... for more of the
 * same item): a container keeps its key while it stays open, so a second backpack does not
 * take the first one's place when that one closes. `open` is the server's order.
 */
export function containerKeys(
  prev: ReadonlyMap<number, ContainerKey>,
  open: readonly { id: number; item: string }[],
): Map<number, ContainerKey> {
  const next = new Map<number, ContainerKey>();
  for (const c of open) {
    const k = prev.get(c.id);
    if (k) next.set(c.id, k);
  }
  const used = new Set(next.values());
  for (const c of open) {
    if (next.has(c.id)) continue;
    const item = c.item.replace(/[^a-z0-9_]/g, "_") || "item";
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
  party: "P",
  guild: "G",
  appearance: "O",
  options: "Escape",
  help: "H",
};

/** Title key of each window. */
export const WINDOW_TITLE: Readonly<Record<WindowId, string>> = {
  battle: "client.battle.title",
  inventory: "client.inventory.title",
  skills: "client.skills.title",
  party: "client.party.title",
  guild: "client.guild.title",
  appearance: "client.appearance.title",
  options: "client.options.button",
  help: "client.help.title",
};

/**
 * What a key press does to the windows, or undefined when it is not a window key: a
 * window key toggles its window; Escape closes the floating window on top (a server's or a
 * container's too: App.tsx asks the server), or opens the options when nothing floats. Keys
 * with Ctrl, Alt or Meta are never window keys.
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
 * The window that holds a tutorial highlight (a `data-tutorial` value), opened so the
 * highlighted element is on screen; undefined when it is not in a window (stats, hotbar,
 * chat are always shown).
 */
export function windowForHighlight(highlight: string | undefined): WindowId | undefined {
  switch (highlight) {
    case "battle":
    case "inventory":
    case "skills":
      return highlight;
    default:
      return undefined;
  }
}
