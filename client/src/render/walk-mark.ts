// The mark of a click-to-walk (docs/17 MOV-7): a ring on the tile clicked, MARK_MS long,
// that closes in on it and fades; gold with a way there, red without. Pure geometry: the
// canvas draws it.
import { MARK_MS } from "../state/steering.ts";

/** The ring's colours: a way there (--ui-gold-300) or none (--ui-danger). */
export const MARK_COLORS = { reachable: 0xe2c47a, blocked: 0xe5574a } as const;

/** Height over width of the ring: it lies on the ground. */
export const MARK_SQUASH = 0.7;

/** The ring `elapsed` ms after the click: its radius (tiles) and alpha; undefined when over. */
export function markRing(elapsed: number): { radius: number; alpha: number } | undefined {
  if (elapsed < 0 || elapsed >= MARK_MS) return undefined;
  const t = elapsed / MARK_MS;
  return { radius: 0.5 - 0.25 * t, alpha: 1 - t * t };
}
