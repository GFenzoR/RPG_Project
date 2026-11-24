// Trail wear (livingworld/README.md "Desgaste de senderos"): grass worn into a path by
// players' steps. The server keeps the wear (livingworld/server/trail) and sends each
// tile's level, 0 (untouched) to 3 (bare dirt); the client only draws what applyWear
// gives it, never invents it. Each worn tile gets one overlay of
// assets/livingworld/sprites/fx/trail_<level>_<mask> (tools/spritegen recipes/trail.ts):
// <mask> says which of its four neighbours are worn too, so a path joins into one strip
// and its open sides fade out softly over the grass and its borders.

/** One tile's wear as the glue passes it on. */
export interface WearTile {
  x: number;
  y: number;
  z: number;
  /** 0..3 (WEAR_LEVELS); 0 forgets the tile. */
  level: number;
}

/** Levels: 1 trampled, 2 worn, 3 bare dirt. */
export const MAX_WEAR_LEVEL = 3;

/** Worn-neighbour bits of an overlay (the recipe's TRAIL_N, E, S, W). */
export const WEAR_N = 1;
export const WEAR_E = 2;
export const WEAR_S = 4;
export const WEAR_W = 8;

/** docs/07: worn tiles drawn at once (the most worn win); a view has 759 tiles a floor. */
export const MAX_WEAR_DRAWN = 256;

/**
 * How flat a plant that tramples (data/livingworld/plants.yaml `trample`) is drawn on a
 * tile of each level: its height is multiplied by this.
 */
export const TRAMPLE_SCALE: readonly number[] = [1, 0.6, 0.45, 0.3];

/** The atlas name (under livingworld/fx/) of a tile's overlay. */
export function wearSprite(level: number, mask: number): string {
  return `trail_${level}_${mask}`;
}

/** One tile to draw: where, its level and its worn neighbours. */
export interface WearDraw {
  x: number;
  y: number;
  level: number;
  mask: number;
}

const key = (x: number, y: number, z: number): number => (z * 65536 + y) * 65536 + x;

export class WearMap {
  private readonly tiles = new Map<number, WearTile>();
  /** Grows with every change: the view list is rebuilt only when it moved. */
  version = 0;

  get size(): number {
    return this.tiles.size;
  }

  /**
   * Applies a batch: a level above 0 sets the tile, 0 forgets it. With replace, the batch
   * is the whole wear (everything else is forgotten first).
   */
  apply(batch: readonly WearTile[], replace = false): void {
    if (replace && this.tiles.size > 0) {
      this.tiles.clear();
      this.version++;
    }
    for (const t of batch) {
      const k = key(t.x, t.y, t.z);
      const level = Math.min(MAX_WEAR_LEVEL, Math.floor(t.level));
      if (!(level > 0)) {
        if (this.tiles.delete(k)) this.version++;
        continue;
      }
      if (this.tiles.get(k)?.level === level) continue;
      this.tiles.set(k, { x: t.x, y: t.y, z: t.z, level });
      this.version++;
    }
  }

  /** The level of a tile (0 when untouched). */
  level(x: number, y: number, z: number): number {
    return this.tiles.get(key(x, y, z))?.level ?? 0;
  }

  /** Which of the four neighbours of (x, y, z) are worn (WEAR_N | WEAR_E | ...). */
  mask(x: number, y: number, z: number): number {
    return (
      (this.level(x, y - 1, z) > 0 ? WEAR_N : 0) |
      (this.level(x + 1, y, z) > 0 ? WEAR_E : 0) |
      (this.level(x, y + 1, z) > 0 ? WEAR_S : 0) |
      (this.level(x - 1, y, z) > 0 ? WEAR_W : 0)
    );
  }

  /**
   * The worn tiles of floor z inside the rectangle with their masks, most worn first when
   * there are more than MAX_WEAR_DRAWN (then only those).
   */
  inView(z: number, x0: number, y0: number, x1: number, y1: number): WearDraw[] {
    const out: WearDraw[] = [];
    for (const t of this.tiles.values())
      if (t.z === z && t.x >= x0 && t.y >= y0 && t.x <= x1 && t.y <= y1)
        out.push({ x: t.x, y: t.y, level: t.level, mask: this.mask(t.x, t.y, z) });
    if (out.length > MAX_WEAR_DRAWN) {
      out.sort((a, b) => b.level - a.level);
      out.length = MAX_WEAR_DRAWN;
    }
    return out;
  }

  clear(): void {
    if (this.tiles.size > 0) this.version++;
    this.tiles.clear();
  }
}
