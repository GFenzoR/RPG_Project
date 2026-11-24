// "Your character stayed in the world" (docs/02 "Bloqueo de logout en combate"): a game
// closed in a fight (the tab, a reload, the desktop app) or a connection the server cut in
// one leaves the character link-dead in the world until the fight is over. The next login
// screen or character list says so, once. The tab cannot hear back from the server once it
// is closed, so the page writes a note to localStorage on its way out (pagehide) and the
// next start reads it. Per browser only, and only a hint: the server decides.
import { DisconnectReason } from "@rpg/protocol";

/** The localStorage key of the note. */
export const STAYED_KEY = "rpg.stayedInFight";

/** How long a note is worth showing, ms: past it the fight is long over (link_dead_max_ms is 2 min). */
export const STAYED_SHOW_MS = 10 * 60_000;

/** What the page remembers when it closes in a fight. */
export interface StayedNote {
  /** The character's name. */
  name: string;
  /** When the page closed (Date.now()). */
  at: number;
}

type NoteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Writes the note (pagehide in a fight). A blocked storage loses it, nothing more. */
export function rememberStayed(storage: NoteStorage | undefined, note: StayedNote): void {
  try {
    storage?.setItem(STAYED_KEY, JSON.stringify(note));
  } catch {
    // a full or blocked storage: the note is only a hint
  }
}

/** Reads the note once (it is removed), if it is still recent at `now` (Date.now()). */
export function takeStayed(storage: NoteStorage | undefined, now: number): StayedNote | undefined {
  let raw: string | null;
  try {
    raw = storage?.getItem(STAYED_KEY) ?? null;
    storage?.removeItem(STAYED_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<StayedNote>;
    if (typeof v.name !== "string" || typeof v.at !== "number") return undefined;
    if (now - v.at < 0 || now - v.at > STAYED_SHOW_MS) return undefined;
    return { name: v.name, at: v.at };
  } catch {
    return undefined;
  }
}

/**
 * Whether a game that ended with `reason` while in a fight left the character in the world
 * link-dead: a lost connection, a slow or flooding client, a password change and "sign out
 * everywhere" do (the server's disconnect and Leave); a logout, a takeover, a staff kick or
 * ban, a failed save and a shutdown take it out at once.
 */
export function staysAfter(reason: DisconnectReason | undefined): boolean {
  switch (reason) {
    case undefined:
    case DisconnectReason.UNSPECIFIED:
    case DisconnectReason.SLOW_CLIENT:
    case DisconnectReason.RATE_LIMITED:
    case DisconnectReason.PASSWORD_CHANGED:
    case DisconnectReason.SIGNED_OUT_EVERYWHERE:
      return true;
    default:
      return false;
  }
}
