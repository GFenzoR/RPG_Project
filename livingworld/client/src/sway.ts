// Plants that react (livingworld/README.md): a creature stepping on or next to a plant
// bends it away for a moment (a damped spring), and tall plants sway gently in the wind.
// Shader-free: the result is a skew (bend) or a pixel offset (rustle) the renderer puts on
// the plant's sprite. Deterministic: only the tile and the clock.
import { hash01, tileKey } from "./hash.ts";

/** How long a plant keeps moving after a step, ms. */
export const SWAY_MS = 900;
/** One back-and-forth of the spring, ms. */
export const SWAY_PERIOD_MS = 420;
/** The lean of a fresh bend on the stepped tile, radians of skew. */
export const BEND = 0.28;
/** Neighbours of the stepped tile bend this much of it. */
export const NEIGHBOUR = 0.45;
/** Idle wind sway, radians of skew at most. */
export const IDLE = 0.05;
/** docs/07: plants moving at once from steps (more are ignored until some settle). */
export const MAX_SWAYS = 48;

interface Bend {
  x: number;
  y: number;
  start: number;
  /** -1..1: which way and how hard (sign = the side it leans to). */
  strength: number;
}

export class SwaySim {
  private readonly bends = new Map<number, Bend>();

  get active(): number {
    return this.bends.size;
  }

  /**
   * A creature stepped onto (x, y) moving dx (-1, 0, 1) across: that tile bends fully, its
   * 8 neighbours less, leaning the way it walks (straight up or down: away from it).
   */
  trigger(x: number, y: number, dx: number, now: number): void {
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const centre = ox === 0 && oy === 0;
        // The way it walks; moving up or down, side neighbours lean away from the walker and
        // the column it walks along to a side picked by the tile.
        const lean = dx !== 0 ? dx : ox !== 0 ? ox : hash01(x, y, 3) < 0.5 ? -1 : 1;
        this.set(x + ox, y + oy, (centre ? 1 : NEIGHBOUR) * lean, now);
      }
    }
  }

  private set(x: number, y: number, strength: number, now: number): void {
    const k = tileKey(x, y);
    const b = this.bends.get(k);
    if (b) {
      // A fresh push restarts it, never weaker than what is still moving.
      const left = 1 - (now - b.start) / SWAY_MS;
      if (left > 0 && Math.abs(b.strength) * left > Math.abs(strength)) return;
      b.start = now;
      b.strength = strength;
      return;
    }
    if (this.bends.size >= MAX_SWAYS) return;
    this.bends.set(k, { x, y, start: now, strength });
  }

  /** The bend of tile (x, y) at `now`, radians of skew (0 when still). */
  bendAt(x: number, y: number, now: number): number {
    const b = this.bends.get(tileKey(x, y));
    if (!b) return 0;
    const t = now - b.start;
    if (t < 0 || t >= SWAY_MS) return 0;
    const damp = Math.exp((-3 * t) / SWAY_MS) * (1 - t / SWAY_MS);
    return BEND * b.strength * damp * Math.cos((2 * Math.PI * t) / SWAY_PERIOD_MS);
  }

  /** Forgets the bends that have settled. */
  prune(now: number): void {
    for (const [k, b] of this.bends)
      if (now - b.start >= SWAY_MS || now < b.start) this.bends.delete(k);
  }

  clear(): void {
    this.bends.clear();
  }
}

/** The idle wind sway of a tall plant on tile (x, y) at `now`, radians of skew. */
export function idleSway(x: number, y: number, now: number): number {
  const phase = hash01(x, y, 11) * Math.PI * 2;
  const breeze = 0.6 + 0.4 * Math.sin(now / 5100 + x * 0.21);
  return IDLE * breeze * Math.sin(now / 1300 + phase);
}

/** A rustling tree's shake in whole sprite pixels for a bend (skew) value. */
export function rustleOffset(bend: number): number {
  return Math.round((bend / BEND) * 1.4);
}
