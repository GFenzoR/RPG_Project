// Windows of the desktop game screen (docs/17 UI-5), pure and unit-tested: which are open,
// which sit in the dock (the column right of the map, Tibia-like) and which float over the
// map, where, folded or not, and which is on top. The toolbar and its keys open and close
// them; App.tsx only renders what this state says. Remembered per device in localStorage
// (`rpg.windows`, a convenience: if it is lost or unreadable, the defaults come back).

/** The windows the toolbar opens (the NPC, shop, market and trade windows are the server's). */
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
}

export interface WindowsState {
  /** Dock order, top to bottom (every docked window, open or not). */
  order: WindowId[];
  /** Stacking of the floating windows, bottom to top. */
  z: WindowId[];
  win: Record<WindowId, WindowPlace>;
}

/** localStorage key of the remembered windows. */
export const WINDOWS_STORAGE_KEY = "rpg.windows";

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
  };
}

const isId = (v: unknown): v is WindowId =>
  typeof v === "string" && (WINDOW_IDS as readonly string[]).includes(v);

const finite = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined;

/**
 * The remembered state (the JSON of saveWindows), checked field by field: an unknown window
 * is dropped, a missing one gets its default, and anything unreadable gives the defaults.
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
  const d = data as { v?: unknown; order?: unknown; z?: unknown; win?: unknown };
  if (d.v !== 1) return base;
  const win = { ...base.win };
  if (typeof d.win === "object" && d.win !== null)
    for (const [id, p] of Object.entries(d.win as Record<string, unknown>)) {
      if (!isId(id) || typeof p !== "object" || p === null) continue;
      const w = p as Record<string, unknown>;
      const def = base.win[id];
      win[id] = {
        open: typeof w["open"] === "boolean" ? w["open"] : def.open,
        dock: typeof w["dock"] === "boolean" ? w["dock"] : def.dock,
        collapsed: typeof w["collapsed"] === "boolean" ? w["collapsed"] : false,
        x: finite(w["x"]),
        y: finite(w["y"]),
      };
    }
  const ids = (v: unknown): WindowId[] =>
    Array.isArray(v) ? [...new Set(v.filter(isId))] : ([] as WindowId[]);
  // Every docked window has a place in the dock order; nothing floating keeps one.
  const order = ids(d.order).filter((id) => win[id].dock);
  for (const id of WINDOW_IDS) if (win[id].dock && !order.includes(id)) order.push(id);
  const z = ids(d.z).filter((id) => !win[id].dock);
  return { order, z, win };
}

/** The JSON stored under WINDOWS_STORAGE_KEY. */
export function saveWindows(s: WindowsState): string {
  return JSON.stringify({ v: 1, order: s.order, z: s.z, win: s.win });
}

const withWin = (s: WindowsState, id: WindowId, p: Partial<WindowPlace>): WindowsState => ({
  ...s,
  win: { ...s.win, [id]: { ...s.win[id], ...p } },
});

/** Brings a floating window to the top (a docked one has no stacking). */
export function focusWindow(s: WindowsState, id: WindowId): WindowsState {
  if (s.win[id].dock || s.z[s.z.length - 1] === id) return s;
  return { ...s, z: [...s.z.filter((w) => w !== id), id] };
}

/** Opens a window (unfolded, on top); an open one only comes to the top. */
export function openWindow(s: WindowsState, id: WindowId): WindowsState {
  const w = s.win[id];
  const next = w.open && !w.collapsed ? s : withWin(s, id, { open: true, collapsed: false });
  return focusWindow(next, id);
}

export function closeWindow(s: WindowsState, id: WindowId): WindowsState {
  if (!s.win[id].open) return s;
  return { ...withWin(s, id, { open: false }), z: s.z.filter((w) => w !== id) };
}

/** The toolbar button and the window's key: open it, or close it if it is open. */
export function toggleWindow(s: WindowsState, id: WindowId): WindowsState {
  return s.win[id].open ? closeWindow(s, id) : openWindow(s, id);
}

export function collapseWindow(s: WindowsState, id: WindowId, collapsed: boolean): WindowsState {
  return s.win[id].collapsed === collapsed ? s : withWin(s, id, { collapsed });
}

/** Takes a window out of the dock (or moves a floating one) to x, y, on top. */
export function floatWindow(s: WindowsState, id: WindowId, x: number, y: number): WindowsState {
  const moved = withWin(s, id, { dock: false, x: Math.round(x), y: Math.round(y) });
  return focusWindow(
    { ...moved, order: s.order.filter((w) => w !== id), z: s.z.filter((w) => w !== id) },
    id,
  );
}

/**
 * Puts a window in the dock right before `before` (a docked window), or at the end when
 * `before` is undefined, not docked or the window itself.
 */
export function dockWindow(
  s: WindowsState,
  id: WindowId,
  before: WindowId | undefined,
): WindowsState {
  const order = s.order.filter((w) => w !== id);
  const at = before === undefined || before === id ? -1 : order.indexOf(before);
  order.splice(at < 0 ? order.length : at, 0, id);
  return {
    ...withWin(s, id, { dock: true }),
    order,
    z: s.z.filter((w) => w !== id),
  };
}

/** The open docked windows, top to bottom. */
export const dockedWindows = (s: WindowsState): WindowId[] =>
  s.order.filter((id) => s.win[id].open && s.win[id].dock);

/** The open floating windows, bottom to top (later ones are drawn over the earlier). */
export function floatingWindows(s: WindowsState): WindowId[] {
  const open = WINDOW_IDS.filter((id) => s.win[id].open && !s.win[id].dock);
  const rank = (id: WindowId): number => {
    const i = s.z.indexOf(id);
    return i < 0 ? -1 : i;
  };
  return open.sort((a, b) => rank(a) - rank(b));
}

/** The window Escape closes: the floating one on top; undefined when none floats. */
export function topWindow(s: WindowsState): WindowId | undefined {
  const f = floatingWindows(s);
  return f[f.length - 1];
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
 * window key toggles its window; Escape closes the floating window on top, or opens the
 * options when nothing floats. Keys with Ctrl, Alt or Meta are never window keys.
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
