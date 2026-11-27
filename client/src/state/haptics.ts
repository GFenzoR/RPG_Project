// Haptics (lote 21, docs/15 "Vibración"): a light navigator.vibrate on a hit taken, a
// level up or a refusal. Off where the browser has no vibration (iOS Safari, desktops) and
// with the option off; nothing here knows of the DOM: the Game passes the vibrate function.

export type HapticKind = "hit" | "heavyHit" | "levelUp" | "error";

/** The vibration of each event, ms (a number, or on/off/on… times). All short on purpose. */
export function hapticPattern(kind: HapticKind): number | number[] {
  switch (kind) {
    case "hit":
      return 12;
    case "heavyHit":
      return 28;
    case "levelUp":
      return [18, 60, 18, 60, 40];
    case "error":
      return [10, 40, 10];
  }
}

/** The least time between two vibrations of hits, ms: a pack of wolves must not buzz without end. */
export const HAPTIC_HIT_GAP_MS = 250;
/**
 * The least time between two vibrations of a refusal, ms: the pad held against a wall is
 * refused at every step and must not buzz without pause.
 */
export const HAPTIC_ERROR_GAP_MS = 1000;

export type Vibrate = (pattern: number | number[]) => boolean;

export class Haptics {
  private last = Number.NEGATIVE_INFINITY;
  private lastError = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly vibrate: Vibrate | undefined,
    private readonly enabled: () => boolean,
  ) {}

  /** True where the device can vibrate at all (the option shows only then). */
  get supported(): boolean {
    return this.vibrate !== undefined;
  }

  /** Vibrates for `kind` at time `now` (ms); reports whether it did. */
  pulse(kind: HapticKind, now: number): boolean {
    if (!this.vibrate || !this.enabled()) return false;
    const hit = kind === "hit" || kind === "heavyHit";
    if (hit && now - this.last < HAPTIC_HIT_GAP_MS) return false;
    if (hit) this.last = now;
    if (kind === "error") {
      if (now - this.lastError < HAPTIC_ERROR_GAP_MS) return false;
      this.lastError = now;
    }
    try {
      return this.vibrate(hapticPattern(kind));
    } catch {
      return false; // blocked by a permissions policy: never an error of the game
    }
  }
}

/**
 * navigator.vibrate bound, or undefined where it does not exist or the device is not held
 * in the hand: desktop Chrome has navigator.vibrate and nothing that vibrates, so without
 * a coarse pointer (`handheld`) there is no vibration and no option for it.
 */
export function browserVibrate(
  nav: { vibrate?: (pattern: number | number[]) => boolean } | undefined,
  handheld: boolean,
): Vibrate | undefined {
  if (!handheld || !nav || typeof nav.vibrate !== "function") return undefined;
  return (pattern) => nav.vibrate?.(pattern) ?? false;
}
