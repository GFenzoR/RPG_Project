// What the right mouse button does on items (docs/17 UI-6), chosen in Options → Controls
// and kept per device in localStorage "rpg.controls" (a convenience: lost, it goes back
// to the default):
// - "menu" (the default): a right click on an item opens its menu with its card; a double
//   click or Ctrl+right click uses it at once;
// - "classic": a right click uses it, as in the classic controls of the genre; Shift+right
//   click opens the menu.
// On creatures the right click attacks (talks to an NPC) in both: fights stay one click.

export type ControlsMode = "menu" | "classic";

export const CONTROLS_KEY = "rpg.controls";

export function loadControls(storage: Pick<Storage, "getItem"> | undefined): ControlsMode {
  try {
    return storage?.getItem(CONTROLS_KEY) === "classic" ? "classic" : "menu";
  } catch {
    return "menu";
  }
}

export function saveControls(
  mode: ControlsMode,
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  try {
    storage?.setItem(CONTROLS_KEY, mode);
  } catch {
    // Private mode or full storage: the choice lasts until the page reloads.
  }
}
