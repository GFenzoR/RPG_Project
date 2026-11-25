// "Your character stayed in the world" (docs/02 "Bloqueo de logout en combate"): a game
// closed in a fight (the tab, a reload, the desktop app) or a connection the server cut in
// one leaves the character link-dead in the world until the fight is over. The next
// character list says so, once. The tab cannot hear back from the server once it is
// closed, so the page writes a note to localStorage on its way out (pagehide) and the next
// start reads it. Per browser only, and only a hint: the server decides. The notes are
// kept per character (an account plays up to two at once, each in its tab) and one is
// shown only to a session that owns its character: never on the login screen, where
// anybody at a shared browser would read the name.
import { DisconnectReason } from "@rpg/protocol";
import type { Translate } from "../i18n/i18n.ts";

/** The localStorage key of the notes (a JSON list of StayedNote). */
export const STAYED_KEY = "rpg.stayedInFight";

/** How long a note is worth showing, ms: past it the fight is long over. */
export const STAYED_SHOW_MS = 10 * 60_000;

/**
 * While a note is this recent, ms, the character may still be in the world and a login
 * takes it over: balance.yaml travel.link_dead_max_ms (2 min) caps a link-dead stay in a
 * fight with monsters. An older note only says what happened.
 */
export const STAYED_LIVE_MS = 2 * 60_000;

/** What the page remembers when it closes in a fight. */
export interface StayedNote {
  /** The character's name. */
  name: string;
  /** When the page closed (Date.now()). */
  at: number;
}

type NoteStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isNote = (v: unknown): v is StayedNote =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as StayedNote).name === "string" &&
  typeof (v as StayedNote).at === "number";

/** The notes kept in storage (a single note, as first written, counts as a list of one). */
function readNotes(storage: NoteStorage | undefined): StayedNote[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(STAYED_KEY) ?? "[]");
    return (Array.isArray(v) ? v : [v]).filter(isNote).map(({ name, at }) => ({ name, at }));
  } catch {
    return [];
  }
}

function writeNotes(storage: NoteStorage | undefined, notes: StayedNote[]): void {
  try {
    if (notes.length === 0) storage?.removeItem(STAYED_KEY);
    else storage?.setItem(STAYED_KEY, JSON.stringify(notes));
  } catch {
    // a full or blocked storage: the note is only a hint
  }
}

/**
 * Writes the note of a character (pagehide in a fight), over an older one of it; the
 * notes of other characters stay. A blocked storage loses it, nothing more.
 */
export function rememberStayed(storage: NoteStorage | undefined, note: StayedNote): void {
  writeNotes(storage, [...readNotes(storage).filter((n) => n.name !== note.name), note]);
}

/**
 * Reads once (they are removed) the notes of the characters `names`, the session's own,
 * that are still recent at `now` (Date.now()). Notes of other characters stay for their
 * account; the ones too old go.
 */
export function takeStayed(
  storage: NoteStorage | undefined,
  now: number,
  names: readonly string[],
): StayedNote[] {
  const recent = readNotes(storage).filter((n) => now - n.at >= 0 && now - n.at <= STAYED_SHOW_MS);
  writeNotes(
    storage,
    recent.filter((n) => !names.includes(n.name)),
  );
  return recent.filter((n) => names.includes(n.name));
}

/**
 * The text of a note at `now`: while the character may still be in the world it says a
 * login takes it over; later, only that it stayed until its fight ended.
 */
export function stayedText(t: Translate, note: StayedNote, now: number): string {
  return t(
    now - note.at <= STAYED_LIVE_MS
      ? "client.characters.stayed_in_fight"
      : "client.characters.stayed_in_fight_earlier",
    { name: note.name },
  );
}

/**
 * Whether a game that ended with `reason` while in a fight left the character in the world
 * link-dead: a lost connection, a slow or flooding client, a password change and "sign out
 * everywhere" do (the server's disconnect and Leave); a logout, a takeover, a staff kick or
 * ban, a failed save and a shutdown take it out at once. A socket closed with no reason
 * counts as a lost connection, though a server that crashed looks the same from here
 * (docs/14): the text is a hint, the server decides.
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

/**
 * The notice of the character list after a game ended: `ended` (why), and that the
 * character stayed in the world when it ended in a fight in a way that keeps it there.
 */
export function endNotice(
  t: Translate,
  ended: string,
  reason: DisconnectReason | undefined,
  inFight: boolean,
  name: string,
): string {
  return inFight && staysAfter(reason)
    ? `${ended} ${t("client.characters.stayed_in_fight", { name })}`
    : ended;
}

/**
 * Leaves the note when the page goes away (pagehide: the tab closed, a reload, the app
 * quit) while `inFight()`. Returns how to stop watching.
 */
export function watchLeaving(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  inFight: () => boolean,
  storage: NoteStorage | undefined,
  name: string,
  now: () => number = Date.now,
): () => void {
  const leaving = (): void => {
    if (inFight()) rememberStayed(storage, { name, at: now() });
  };
  target.addEventListener("pagehide", leaving);
  return () => target.removeEventListener("pagehide", leaving);
}
