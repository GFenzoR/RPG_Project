// Interface preferences kept in the browser (docs/17 UI-1, UI-9): "reduced animations",
// on top of the system's prefers-reduced-motion. Applied as data-motion="reduced" on <html>,
// which client.css reads like the media query.

const MOTION_KEY = "rpg.motion";

/** The saved choice; false (full animations, unless the system asks less) when unset. */
export function loadReducedMotion(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(MOTION_KEY) === "reduced";
  } catch {
    return false;
  }
}

export function saveReducedMotion(
  reduced: boolean,
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  try {
    storage?.setItem(MOTION_KEY, reduced ? "reduced" : "full");
  } catch {
    // Private mode or full storage: the choice lasts until the page reloads.
  }
}

/** Marks the page so client.css turns the animations off (or back on). */
export function applyReducedMotion(root: HTMLElement, reduced: boolean): void {
  if (reduced) root.dataset["motion"] = "reduced";
  else delete root.dataset["motion"];
}

/** True when animations should be skipped: the player's choice or the system's. */
export function motionReduced(root: HTMLElement | undefined): boolean {
  if (root?.dataset["motion"] === "reduced") return true;
  try {
    return (
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

// ---- Interface scale, text size and camera shake (docs/17 UI-3, UI-9) ------------------

const SCALE_KEY = "rpg.ui-scale";
const TEXT_KEY = "rpg.text-scale";
const SHAKE_KEY = "rpg.shake";
const BUBBLES_KEY = "rpg.chat-bubbles";

/** The interface scales Options offers (the CSS zoom of the bottom bar and the windows). */
export const UI_SCALES: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
/** The text sizes Options offers (docs/17 UI-3: 90 % to 130 %, the root font size). */
export const TEXT_SCALES: readonly number[] = [0.9, 1, 1.15, 1.3];

/** The offered value closest to `v` (a remembered or typed one), or 1 when it is not a number. */
export function nearestScale(v: number, offered: readonly number[]): number {
  if (!Number.isFinite(v)) return 1;
  let best = 1;
  for (const o of offered) if (Math.abs(o - v) < Math.abs(best - v)) best = o;
  return best;
}

function readNumber(storage: Pick<Storage, "getItem"> | undefined, key: string): number {
  try {
    const raw = storage?.getItem(key);
    return raw == null ? 1 : Number(raw);
  } catch {
    return 1;
  }
}

function write(storage: Pick<Storage, "setItem"> | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Private mode or full storage: the choice lasts until the page reloads.
  }
}

/** The remembered interface scale (1 when unset or unreadable). */
export const loadUiScale = (storage: Pick<Storage, "getItem"> | undefined): number =>
  nearestScale(readNumber(storage, SCALE_KEY), UI_SCALES);

export const saveUiScale = (v: number, storage: Pick<Storage, "setItem"> | undefined): void =>
  write(storage, SCALE_KEY, String(nearestScale(v, UI_SCALES)));

/** The remembered text size (1 when unset or unreadable). */
export const loadTextScale = (storage: Pick<Storage, "getItem"> | undefined): number =>
  nearestScale(readNumber(storage, TEXT_KEY), TEXT_SCALES);

export const saveTextScale = (v: number, storage: Pick<Storage, "setItem"> | undefined): void =>
  write(storage, TEXT_KEY, String(nearestScale(v, TEXT_SCALES)));

/**
 * The camera shake on a heavy hit (docs/17 UI-9: an option of its own, as in other games
 * of the kind): on unless turned off. Reduced motion turns it off whatever this says.
 */
export function loadCameraShake(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(SHAKE_KEY) !== "off";
  } catch {
    return true;
  }
}

export const saveCameraShake = (on: boolean, storage: Pick<Storage, "setItem"> | undefined): void =>
  write(storage, SHAKE_KEY, on ? "on" : "off");

/**
 * docs/17 UI-11: what creatures say on the local channels also shows over their heads.
 * On unless turned off.
 */
export function loadChatBubbles(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(BUBBLES_KEY) !== "off";
  } catch {
    return true;
  }
}

export const saveChatBubbles = (on: boolean, storage: Pick<Storage, "setItem"> | undefined): void =>
  write(storage, BUBBLES_KEY, on ? "on" : "off");

/** Sets the interface scale and the text size on the page (client.css, windows.css). */
export function applyScales(
  root: { style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty"> },
  uiScale: number,
  textScale: number,
): void {
  if (uiScale === 1) root.style.removeProperty("--ui-zoom");
  else root.style.setProperty("--ui-zoom", String(uiScale));
  if (textScale === 1) root.style.removeProperty("--ui-text-scale");
  else root.style.setProperty("--ui-text-scale", String(textScale));
}

// ---- The chat's opacity (docs/17 UI-10) ------------------------------------------------

const CHAT_OPACITY_KEY = "rpg.chat-opacity";

/** The chat background's opacity Options offers, percent: 30 to 100 in steps of 5. */
export const CHAT_OPACITY = { min: 30, max: 100, step: 5, initial: 50 } as const;

/** A chat opacity inside the offered range, on its steps (the initial one when not a number). */
export function clampChatOpacity(v: number): number {
  if (!Number.isFinite(v)) return CHAT_OPACITY.initial;
  const stepped = Math.round(v / CHAT_OPACITY.step) * CHAT_OPACITY.step;
  return Math.min(CHAT_OPACITY.max, Math.max(CHAT_OPACITY.min, stepped));
}

/** The remembered chat opacity, percent (50 when unset or unreadable). */
export function loadChatOpacity(storage: Pick<Storage, "getItem"> | undefined): number {
  try {
    const raw = storage?.getItem(CHAT_OPACITY_KEY);
    return raw == null ? CHAT_OPACITY.initial : clampChatOpacity(Number(raw));
  } catch {
    return CHAT_OPACITY.initial;
  }
}

export const saveChatOpacity = (v: number, storage: Pick<Storage, "setItem"> | undefined): void =>
  write(storage, CHAT_OPACITY_KEY, String(clampChatOpacity(v)));

/** Sets the chat background's opacity on the page (windows.css --chat-opacity). */
export function applyChatOpacity(
  root: { style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty"> },
  percent: number,
): void {
  const v = clampChatOpacity(percent);
  if (v === CHAT_OPACITY.initial) root.style.removeProperty("--chat-opacity");
  else root.style.setProperty("--chat-opacity", String(v / 100));
}
