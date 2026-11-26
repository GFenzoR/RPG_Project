// Where each creature is drawn this frame (docs/17 ART-2), for what a tile cannot tell:
// clicks. A humanoid of 64x64 rises over the tile above its own, and a click on its head
// must pick it. The boxes of the drawn creatures are tried first, from the last drawn (the
// one in front) to the first, and only then the tile under the pointer. A tile with
// something of its own to use (a door, an item, a ladder) keeps its click: no head
// rising into it from the tile below takes it (what the cursor's hint says, MOV-7).
// A creature behind another one is just covered by it, as far as the drawings overlap:
// until 2026-11-26 it was drawn again over the one in front, pale and see-through, and
// two characters standing one behind the other both changed colour (the owner: "eso no
// debería pasar"). Nothing is drawn over a creature for another creature's sake.
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
   * `skip` (the own player: clicking one's own head picks what is behind it) and, when
   * `keeps` says the tile under the point has something of its own to use (a door, an
   * item, a ladder), every head rising into it from the tile below: a player standing
   * south of a door never takes the click meant for the door.
   */
  pick(
    px: number,
    py: number,
    skip?: number,
    keeps?: (tx: number, ty: number) => boolean,
  ): DrawnBox | undefined {
    let best: DrawnBox | undefined;
    let kept: boolean | undefined; // keeps of the tile under the point, asked once
    for (let i = 0; i < this.count; i++) {
      const b = this.list[i] as DrawnBox;
      if (b.id === skip || px < b.x || px >= b.x + 1 || py < b.top || py >= b.bottom) continue;
      if (keeps && py < b.bottom - 1) {
        kept ??= keeps(Math.floor(px), Math.floor(py));
        if (kept) continue;
      }
      if (!best || b.order > best.order) best = b;
    }
    return best;
  }
}
