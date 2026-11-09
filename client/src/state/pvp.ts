// PvP on the client (T5.2): the safe mode switch, kept in the browser, and the look of a
// skull. The server decides every attack; the switch only says what the player wants.
import { Skull } from "@rpg/protocol";

const SAFE_KEY = "rpg.safeMode";

/** The saved safe mode: on unless the player turned it off. */
export function loadSafeMode(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(SAFE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveSafeMode(on: boolean, storage: Pick<Storage, "setItem"> | undefined): void {
  try {
    storage?.setItem(SAFE_KEY, on ? "on" : "off");
  } catch {
    // Private mode or full storage: the switch still works for this session.
  }
}

/** The i18n id of a skull (client.skull.<id>), undefined without one. */
export function skullId(s: Skull): string | undefined {
  switch (s) {
    case Skull.AGGRESSOR:
      return "aggressor";
    case Skull.MURDERER:
      return "murderer";
    case Skull.OUTLAW:
      return "outlaw";
    default:
      return undefined;
  }
}

/** The fill colour of a skull's placeholder icon (amber, crimson, violet); 0 for none. */
export function skullColor(s: Skull): number {
  switch (s) {
    case Skull.AGGRESSOR:
      return 0xf2b233;
    case Skull.MURDERER:
      return 0xd23a3a;
    case Skull.OUTLAW:
      return 0x8e4fd6;
    default:
      return 0;
  }
}
