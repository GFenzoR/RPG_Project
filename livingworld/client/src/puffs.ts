// Short ground animations at a creature's feet (livingworld/README.md): rings spreading on
// shallow water when something wades through, and a dust cloud when something runs over a
// dusty surface. Each plays PUFF_FRAMES frames over its life. Capped (docs/07).

export type PuffKind = "ripple" | "dust";
export const PUFF_FRAMES = 4;
/** docs/07: ripples and dust clouds alive at once. */
export const MAX_PUFFS = 24;
export const PUFF_MS: Readonly<Record<PuffKind, number>> = { ripple: 700, dust: 420 };
/**
 * A step this short or shorter is a run (ms per tile): it raises dust. A walk at the base
 * speed takes far longer; a haste or a fast mount gets there.
 */
export const RUN_STEP_MS = 232;

export interface Puff {
  kind: PuffKind;
  x: number;
  y: number;
  age: number;
  tint: number;
}

export class PuffSim {
  readonly puffs: Puff[] = [];

  /** A new puff; when full, the oldest gives way. */
  add(kind: PuffKind, x: number, y: number, tint: number): void {
    const p: Puff = { kind, x, y, age: 0, tint };
    if (this.puffs.length < MAX_PUFFS) {
      this.puffs.push(p);
      return;
    }
    let oldest = 0;
    for (let i = 1; i < this.puffs.length; i++)
      if ((this.puffs[i] as Puff).age > (this.puffs[oldest] as Puff).age) oldest = i;
    this.puffs[oldest] = p;
  }

  step(ms: number): void {
    let w = 0;
    for (const p of this.puffs) {
      p.age += ms;
      if (p.age < PUFF_MS[p.kind]) this.puffs[w++] = p;
    }
    this.puffs.length = w;
  }

  /** The frame (0..PUFF_FRAMES-1) and alpha of p now. */
  static frame(p: Puff): { frame: number; alpha: number } {
    const t = p.age / PUFF_MS[p.kind];
    return {
      frame: Math.min(PUFF_FRAMES - 1, Math.floor(t * PUFF_FRAMES)),
      alpha: t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4),
    };
  }

  clear(): void {
    this.puffs.length = 0;
  }
}
