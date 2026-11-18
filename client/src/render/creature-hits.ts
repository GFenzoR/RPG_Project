// Where each creature is drawn this frame (docs/17 ART-2), for two things a tile cannot tell:
// - clicks: a humanoid of 64x64 rises over the tile above its own, and a click on its head
//   must pick it. The boxes of the drawn creatures are tried first, from the last drawn (the
//   one in front) to the first, and only then the tile under the pointer;
// - hidden creatures: a tall figure in front can cover most of a creature on the tile behind
//   it (a wolf right north of a player). That one is drawn again over the map, see-through
//   (a silhouette, like the own player behind a wall, ART-3), so it can still be seen.
// A box is the creature's tile column (one tile wide) from the bottom of its tile up to the
// top of its drawing, at its drawn (interpolated, raised) position, in tiles. Pure, and a
// frame reuses the same box objects.

export interface DrawnBox {
  id: number;
  /** Left and bottom edge of the box, tiles (the top-left of its drawn tile, + 1 for y). */
  x: number;
  bottom: number;
  /** Top edge, tiles (above the tile when the drawing rises over it). */
  top: number;
  /** Draw order (MapView entityZIndex): a larger one is drawn over a smaller one. */
  order: number;
}

/** A creature counts as hidden when a creature drawn after it covers this share of its box. */
export const HIDDEN_SHARE = 0.25;

/** The boxes of one frame: reset, then add one per drawn creature. */
export class DrawnBoxes {
  private readonly list: DrawnBox[] = [];
  count = 0;

  reset(): void {
    this.count = 0;
  }

  /**
   * A creature drawn with its tile's top-left at (x, y) tiles, its drawing rising `rise`
   * tiles above that tile, `order` its draw order.
   */
  add(id: number, x: number, y: number, rise: number, order: number): void {
    let b = this.list[this.count];
    if (!b) {
      b = { id: 0, x: 0, bottom: 0, top: 0, order: 0 };
      this.list.push(b);
    }
    b.id = id;
    b.x = x;
    b.bottom = y + 1;
    b.top = y - Math.max(0, rise);
    b.order = order;
    this.count++;
  }

  at(i: number): DrawnBox | undefined {
    return i < this.count ? this.list[i] : undefined;
  }

  /**
   * The creature drawn on top at world point (px, py) (tiles, fractional), leaving out
   * `skip` (the own player: clicking one's own head picks what is behind it).
   */
  pick(px: number, py: number, skip?: number): DrawnBox | undefined {
    let best: DrawnBox | undefined;
    for (let i = 0; i < this.count; i++) {
      const b = this.list[i] as DrawnBox;
      if (b.id === skip || px < b.x || px >= b.x + 1 || py < b.top || py >= b.bottom) continue;
      if (!best || b.order > best.order) best = b;
    }
    return best;
  }

  /**
   * Calls fn for every creature that a creature drawn after it covers by HIDDEN_SHARE of its
   * box or more.
   */
  forEachHidden(fn: (box: DrawnBox) => void): void {
    for (let i = 0; i < this.count; i++) {
      const a = this.list[i] as DrawnBox;
      for (let j = 0; j < this.count; j++) {
        const b = this.list[j] as DrawnBox;
        if (b.order <= a.order || coveredShare(a, b) < HIDDEN_SHARE) continue;
        fn(a);
        break;
      }
    }
  }
}

/** The share (0..1) of box a that box b covers. */
export function coveredShare(a: DrawnBox, b: DrawnBox): number {
  const w = Math.min(a.x, b.x) + 1 - Math.max(a.x, b.x);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.bottom - a.top);
}
