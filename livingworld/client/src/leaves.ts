// Leaves falling near trees (livingworld/README.md): now and then from a tree in view, and
// when someone brushes past it. A leaf flutters down LEAF_FALL_PX swaying, lies on the ground
// a moment and fades. Capped (docs/07); positions from a seeded generator.

/** docs/07: leaves alive at once. */
export const MAX_LEAVES = 24;
export const LEAF_FALL_MS = 1800;
export const LEAF_REST_MS = 1600;
export const LEAF_FALL_PX = 30;
/** Idle leaves per tree in view per second. */
export const LEAF_RATE = 0.03;

export interface Leaf {
  /** Where it started (sprite pixels) and its sway phase. */
  x0: number;
  y0: number;
  phase: number;
  age: number;
  /** Leaf colour variant 0..2. */
  variant: number;
}

export class LeafSim {
  readonly leaves: Leaf[] = [];

  constructor(private readonly random: () => number) {}

  /** A leaf from the crown of a tree whose trunk foot is at (x, y); false when full. */
  drop(x: number, y: number): boolean {
    if (this.leaves.length >= MAX_LEAVES) return false;
    const r = this.random;
    this.leaves.push({
      x0: x + (r() * 2 - 1) * 14,
      y0: y - 30 - r() * 20,
      phase: r() * Math.PI * 2,
      age: 0,
      variant: Math.floor(r() * 3),
    });
    return true;
  }

  /** Idle leaves from `trees` trees in view over `ms`: a chance of LEAF_RATE each a second. */
  chance(trees: number, ms: number): number {
    return (trees * LEAF_RATE * ms) / 1000;
  }

  step(ms: number): void {
    let w = 0;
    for (const l of this.leaves) {
      l.age += ms;
      if (l.age < LEAF_FALL_MS + LEAF_REST_MS) this.leaves[w++] = l;
    }
    this.leaves.length = w;
  }

  /** Where leaf l is drawn now, its rotation and alpha. */
  static pose(l: Leaf): { x: number; y: number; rot: number; alpha: number } {
    const fall = Math.min(1, l.age / LEAF_FALL_MS);
    const sway =
      fall < 1 ? Math.sin(l.age / 260 + l.phase) * 5 : Math.sin(LEAF_FALL_MS / 260 + l.phase) * 5;
    const rest = l.age - LEAF_FALL_MS;
    return {
      x: l.x0 + sway,
      y: l.y0 + fall * LEAF_FALL_PX,
      rot: fall < 1 ? Math.sin(l.age / 200 + l.phase) * 0.8 : 0,
      alpha: rest <= 0 ? 1 : Math.max(0, 1 - rest / LEAF_REST_MS),
    };
  }

  clear(): void {
    this.leaves.length = 0;
  }
}
