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
