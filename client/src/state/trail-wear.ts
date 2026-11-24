// The trail wear the server sent (livingworld/README.md "Desgaste de senderos", docs/05
// "Mundo vivo"): each worn tile's level, 1 trampled to 3 bare dirt. It arrives with the map
// (MapArea.wear of a FullMapView or MapSlice: everything worn inside that area, so what the
// client had there is forgotten first) and as TrailWear deltas (a level that changed, 0 when
// the grass recovered). render/living.ts hands it to the living world, which draws it.
import type { TrailWear } from "@rpg/protocol";

/** One worn tile. */
export interface WornTile {
  x: number;
  y: number;
  z: number;
  level: number;
}

const key = (x: number, y: number, z: number): number => (z * 65536 + y) * 65536 + x;

export class TrailWearState {
  private readonly tiles = new Map<number, WornTile>();
  /** Grows with every change: the canvas passes the wear on only when it moved. */
  version = 0;

  get size(): number {
    return this.tiles.size;
  }

  /** The level of a tile (0: not worn). */
  level(x: number, y: number, z: number): number {
    return this.tiles.get(key(x, y, z))?.level ?? 0;
  }

  /** Every worn tile (a new list: call it when version changed). */
  list(): WornTile[] {
    return [...this.tiles.values()];
  }

  /** A TrailWear message: tiles[i] is x << 16 | y, levels[i] its level. */
  apply(m: TrailWear): void {
    for (let i = 0; i < m.tiles.length; i++) {
      const xy = m.tiles[i] ?? 0;
      this.set(xy >>> 16, xy & 0xffff, m.z, m.levels[i] ?? 0);
    }
  }

  /** The wear of an area of the map: what was worn inside the rectangle is replaced. */
  applyArea(x: number, y: number, width: number, height: number, wear: readonly TrailWear[]): void {
    for (const [k, t] of this.tiles)
      if (t.x >= x && t.y >= y && t.x < x + width && t.y < y + height) {
        this.tiles.delete(k);
        this.version++;
      }
    for (const m of wear) this.apply(m);
  }

  /** Forgets the tiles outside the rectangle (the chunks the client dropped). */
  keepInside(x0: number, y0: number, x1: number, y1: number): void {
    for (const [k, t] of this.tiles)
      if (t.x < x0 || t.y < y0 || t.x > x1 || t.y > y1) {
        this.tiles.delete(k);
        this.version++;
      }
  }

  clear(): void {
    if (this.tiles.size > 0) this.version++;
    this.tiles.clear();
  }

  private set(x: number, y: number, z: number, level: number): void {
    const k = key(x, y, z);
    if (level <= 0) {
      if (this.tiles.delete(k)) this.version++;
      return;
    }
    if (this.tiles.get(k)?.level === level) return;
    this.tiles.set(k, { x, y, z, level: Math.min(level, 3) });
    this.version++;
  }
}
