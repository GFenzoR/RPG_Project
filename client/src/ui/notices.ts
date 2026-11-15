// Server notices over the map (T5.6), pure and unit-tested. The system log (ul.log) sits
// at the bottom of the side panel, out of view at 1280x800 and inside a tab on phones, so
// the newest messages also show for a few seconds over the map. Every message still goes
// to the log; this only picks which ones float.
import type { LogMessage } from "../state/world.ts";

/** How long a notice stays over the map, ms. */
export const NOTICE_MS = 6000;
/** Most notices shown at once (the newest). */
export const MAX_NOTICES = 3;

/**
 * Message keys (prefixes) that answer something the player just did and stay readable in
 * the log next to the map on desktop: looking at things and loot lines. Everything else
 * (PvP refusals, the logout block, market, house, trade, party and guild notices, failed
 * crafts...) is important and floats. With the log out of view (tabs or drawer), every
 * message floats.
 */
export const ROUTINE_PREFIXES: readonly string[] = ["look.", "combat.loot"];

export const isImportant = (key: string): boolean =>
  !ROUTINE_PREFIXES.some((p) => key.startsWith(p));

/**
 * The notices to show at `now` (ms, the clock of LogMessage.at), oldest first.
 * `dismissedUpTo`: the `at` of the newest notice the player closed; it and older ones stay
 * closed. `all`: float routine messages too (the log is not on screen).
 */
export function activeNotices(
  log: readonly LogMessage[],
  now: number,
  opts: { all: boolean; dismissedUpTo?: number | undefined },
): LogMessage[] {
  const shown = log.filter(
    (m) =>
      now - m.at < NOTICE_MS &&
      m.at <= now &&
      (opts.dismissedUpTo === undefined || m.at > opts.dismissedUpTo) &&
      (opts.all || isImportant(m.key)),
  );
  return shown.slice(-MAX_NOTICES);
}

/** When the next shown notice expires (ms on the same clock), or undefined if none. */
export function nextExpiry(notices: readonly LogMessage[]): number | undefined {
  if (notices.length === 0) return undefined;
  return Math.min(...notices.map((m) => m.at + NOTICE_MS));
}
