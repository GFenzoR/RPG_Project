// What a device remembers of its touch controls, its effects preset and its app mode
// (lote 21, docs/15). All of it is about this device (how big its screen is, which hand
// holds it, what it can draw, whether the app is installed on it), so none of it travels
// with the account: state/saved-options.ts declares these keys as kept on the device.
import { coarsePointer } from "./touch-prefs.ts";

// ---- touch controls (docs/15 "Controles táctiles") ------------------------------------

/** How the on-screen movement control looks: the eight-button pad or the analog stick. */
export type PadStyle = "dpad" | "stick";
export const PAD_STYLES: readonly PadStyle[] = ["dpad", "stick"];

/** The size of the on-screen controls (pad, stick and action buttons). */
export type TouchSize = "small" | "normal" | "large";
export const TOUCH_SIZES: readonly TouchSize[] = ["small", "normal", "large"];

/** The size of an action button at each setting, CSS px (touch.css `--touch-btn`): never under 44. */
export const TOUCH_BUTTON_PX: Readonly<Record<TouchSize, number>> = {
  small: 44,
  normal: 52,
  large: 62,
};

export interface TouchPrefs {
  pad: PadStyle;
  /** Left-handed: the action buttons go to the left and the pad to the right. */
  mirrored: boolean;
  size: TouchSize;
  /** Keep the on-screen controls at full size while a mouse or a keyboard is used. */
  pinned: boolean;
  /** The action buttons (attack, interact, look, quick slots) over the map. */
  actions: boolean;
  /** Vibration on a hit taken, a level up or an error. */
  haptics: boolean;
}

/**
 * The defaults. The pad stays the default movement control: on a world of tiles its eight
 * targets say exactly which step a thumb asks for, and it already slides like a stick; the
 * stick is one tap away in Options for whoever prefers it (docs/15).
 */
export const DEFAULT_TOUCH_PREFS: TouchPrefs = {
  pad: "dpad",
  mirrored: false,
  size: "normal",
  pinned: false,
  actions: true,
  haptics: true,
};

const TOUCH_KEY = "rpg.touch";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(storage: Pick<Storage, "getItem"> | undefined, key: string): unknown {
  try {
    return JSON.parse(storage?.getItem(key) ?? "null") as unknown;
  } catch {
    return undefined; // blocked storage or junk: the defaults
  }
}

/** The saved touch controls; anything missing or unreadable takes its default. */
export function loadTouchPrefs(storage: Pick<Storage, "getItem"> | undefined): TouchPrefs {
  const d = DEFAULT_TOUCH_PREFS;
  const raw = readJson(storage, TOUCH_KEY);
  if (!isRecord(raw)) return { ...d };
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  return {
    pad: PAD_STYLES.find((p) => p === raw["pad"]) ?? d.pad,
    mirrored: bool(raw["mirrored"], d.mirrored),
    size: TOUCH_SIZES.find((s) => s === raw["size"]) ?? d.size,
    pinned: bool(raw["pinned"], d.pinned),
    actions: bool(raw["actions"], d.actions),
    haptics: bool(raw["haptics"], d.haptics),
  };
}

export function saveTouchPrefs(
  prefs: TouchPrefs,
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  try {
    storage?.setItem(TOUCH_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or full storage: the choice still holds for this session.
  }
}

// ---- effects preset (docs/07 "Teléfonos de gama media") -------------------------------

/** How much the map moves by itself: everything, or no ambient particles, wind nor critters. */
export type EffectsPreset = "full" | "reduced";

const EFFECTS_KEY = "rpg.effects";

/** What a quick look at the device says about it (all optional: browsers hide some). */
export interface DeviceHints {
  /** navigator.deviceMemory, GiB (Chromium only). */
  memoryGb?: number | undefined;
  /** navigator.hardwareConcurrency. */
  cores?: number | undefined;
  /** A touch device (coarse primary pointer). */
  coarse: boolean;
}

/**
 * True for a device that should start with the reduced effects: a touch device with little
 * memory (4 GiB or less) or few cores (4 or fewer). A desktop is never judged: its player
 * chooses.
 */
export function lowEndDevice(h: DeviceHints): boolean {
  if (!h.coarse) return false;
  if (h.memoryGb !== undefined && h.memoryGb <= 4) return true;
  return h.cores !== undefined && h.cores <= 4;
}

/** The saved preset, or the one the capability check picks for this device. */
export function loadEffects(
  storage: Pick<Storage, "getItem"> | undefined,
  hints: DeviceHints,
): EffectsPreset {
  try {
    const v = storage?.getItem(EFFECTS_KEY);
    if (v === "full" || v === "reduced") return v;
  } catch {
    // Blocked storage: the device default.
  }
  return lowEndDevice(hints) ? "reduced" : "full";
}

export function saveEffects(
  preset: EffectsPreset,
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  try {
    storage?.setItem(EFFECTS_KEY, preset);
  } catch {
    // The choice still holds for this session.
  }
}

/** Marks the page: render/game-canvas.ts reads `data-effects` each frame, like `data-motion`. */
export function applyEffects(root: HTMLElement, preset: EffectsPreset): void {
  if (preset === "reduced") root.dataset["effects"] = "reduced";
  else delete root.dataset["effects"];
}

/** The hints of this device, read from the browser. */
export function deviceHints(): DeviceHints {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const memory = (nav as { deviceMemory?: unknown } | undefined)?.deviceMemory;
  return {
    memoryGb: typeof memory === "number" ? memory : undefined,
    cores: nav?.hardwareConcurrency,
    coarse: coarsePointer(),
  };
}

// ---- full screen and install (state/install.ts) ---------------------------------------

const APP_MODE_KEY = "rpg.appMode";

export interface AppModeSaved {
  installDismissed: boolean;
  fullscreenWanted: boolean;
}

/** What the page remembers of the install offer and the fullscreen wish. */
export function loadAppMode(storage: Pick<Storage, "getItem"> | undefined): AppModeSaved {
  const raw = readJson(storage, APP_MODE_KEY);
  const r = isRecord(raw) ? raw : {};
  return {
    installDismissed: r["installDismissed"] === true,
    fullscreenWanted: r["fullscreenWanted"] === true,
  };
}

export function saveAppMode(
  memory: AppModeSaved,
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  try {
    storage?.setItem(APP_MODE_KEY, JSON.stringify(memory));
  } catch {
    // Not remembered: the offer shows again next time.
  }
}
