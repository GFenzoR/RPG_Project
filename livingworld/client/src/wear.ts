// Trail wear (livingworld/README.md): how worn a tile is by traffic, 0 (untouched) to 1 (a
// beaten path). The server keeps the wear (livingworld/server); the client only draws what
// applyWear gives it: a darker, flattened patch on the ground. The client never invents it.

/** One tile's wear as the glue passes it on. */
export interface WearTile {
  x: number;
  y: number;
  z: number;
  /** 0..1; 0 removes the tile. */
  level: number;
}

/** docs/07: worn tiles drawn at once (the most worn win). */
export const MAX_WEAR_DRAWN = 128;
/** The patch's alpha at full wear. */
export const WEAR_ALPHA = 0.35;

export class WearMap {
  private readonly tiles = new Map<string, WearTile>();

  get size(): number {
    return this.tiles.size;
  }

  /** Applies a batch of changes: a level above 0 sets the tile, 0 or less forgets it. */
  apply(batch: readonly WearTile[]): void {
    for (const t of batch) {
      const k = `${t.x},${t.y},${t.z}`;
      if (!(t.level > 0)) this.tiles.delete(k);
      else this.tiles.set(k, { x: t.x, y: t.y, z: t.z, level: Math.min(1, t.level) });
    }
  }

  /** The worn tiles of floor z inside the rectangle, most worn first, at most MAX_WEAR_DRAWN. */
  inView(z: number, x0: number, y0: number, x1: number, y1: number): WearTile[] {
    const out: WearTile[] = [];
    for (const t of this.tiles.values())
      if (t.z === z && t.x >= x0 && t.y >= y0 && t.x <= x1 && t.y <= y1) out.push(t);
    if (out.length > MAX_WEAR_DRAWN) {
      out.sort((a, b) => b.level - a.level);
      out.length = MAX_WEAR_DRAWN;
    }
    return out;
  }

  clear(): void {
    this.tiles.clear();
  }
}
