// The on-screen direction pad switch (T5.6, Options), kept in the browser like the safe mode.
// Unset, the pad shows on touch screens (coarse pointer) and stays hidden on PC.

const PAD_KEY = "rpg.touchPad";

/** The saved pad switch, or the device default when the player never chose. */
export function loadTouchPad(
  storage: Pick<Storage, "getItem"> | undefined,
  coarsePointer: boolean,
): boolean {
  try {
    const v = storage?.getItem(PAD_KEY);
    if (v === "on") return true;
    if (v === "off") return false;
  } catch {
    // Blocked storage: fall back to the device default.
  }
  return coarsePointer;
}

export function saveTouchPad(on: boolean, storage: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(PAD_KEY, on ? "on" : "off");
  } catch {
    // Private mode or full storage: the switch still works for this session.
  }
}

/** True on a touch screen without a mouse (the page's primary pointer is a finger). */
export function coarsePointer(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}
