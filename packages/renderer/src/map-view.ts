// Tile map view over any TileSource: draws the chunks in view for one floor and keeps
// them cached. Shared by the game client and the map editor, so it knows nothing about
// either: no input handling, no game entities, no editing.
//
// Draw order (Tibia-like): the ground of every visible tile first, then the item stacks
// tile by tile in global row-major order (across chunk borders), bottom to top. Items
// bigger than a tile are anchored at the bottom-right corner of their tile and extend up
// and to the left, over the tiles before them.
import { Container, Sprite } from "pixi.js";
import type { Texture } from "pixi.js";
import { CHUNK_TILES, tilePixels, visibleChunks } from "./camera.ts";
import type { Camera, ViewSize } from "./camera.ts";

/** One 32x32 chunk: row-major ground IDs and sparse item stacks (local coordinates). */
export interface ChunkData {
  readonly ground: readonly (string | null)[];
  readonly items: readonly {
    readonly x: number;
    readonly y: number;
    readonly stack: readonly string[];
  }[];
}

/**
 * Where tiles come from. A chunk is redrawn when the source returns a different object
 * for it (immutable updates), or when the caller invalidates it.
 */
export interface TileSource {
  chunk(z: number, cx: number, cy: number): ChunkData | undefined;
}

/** Texture for an item ID (ground or stack item). */
export type TextureLookup = (itemId: string) => Texture;

export interface MapViewOptions {
  source: TileSource;
  texture: TextureLookup;
  /** Sprite pixels per tile (the atlas tileSize). */
  tileSize: number;
  floor: number;
}

interface CachedChunk {
  data: ChunkData;
  ground: Container;
  items: Sprite[];
}

/** Items can be stacked this high on one tile before the draw order is ambiguous. */
export const MAX_STACK_ORDER = 256;

/**
 * Draw order of an item: global row-major by tile (y, then x), then by height in the stack.
 * The item layer sorts every item of every visible chunk by it, so a tall sprite near a
 * chunk border is still drawn over the tiles above it and under the tiles below it.
 */
export function itemZIndex(x: number, y: number, stackIndex: number): number {
  return (y * 65536 + x) * MAX_STACK_ORDER + Math.min(stackIndex, MAX_STACK_ORDER - 1);
}

export class MapView {
  /** Add this to the stage. */
  readonly root = new Container({ label: "map-view" });
  /**
   * World-space container drawn above the map, for the caller's overlays (grid, cursor,
   * creatures). One unit = one sprite pixel; tile (x, y) starts at (x * tileSize, y * tileSize).
   */
  readonly overlay = new Container({ label: "overlay" });
  readonly tileSize: number;

  private readonly world = new Container({ label: "world" });
  private readonly groundLayer = new Container({ label: "ground", isRenderGroup: true });
  private readonly itemLayer = new Container({
    label: "items",
    isRenderGroup: true,
    sortableChildren: false,
  });
  private readonly cache = new Map<string, CachedChunk>();
  private source: TileSource;
  private readonly texture: TextureLookup;
  private floorZ: number;

  constructor(opts: MapViewOptions) {
    this.source = opts.source;
    this.texture = opts.texture;
    this.tileSize = opts.tileSize;
    this.floorZ = opts.floor;
    this.world.addChild(this.groundLayer, this.itemLayer, this.overlay);
    this.root.addChild(this.world);
  }

  get floor(): number {
    return this.floorZ;
  }

  setFloor(z: number): void {
    if (z === this.floorZ) return;
    this.floorZ = z;
    this.clear();
  }

  setSource(source: TileSource): void {
    this.source = source;
  }

  /** Forgets cached chunks (all, or the given chunk coordinates) so they are redrawn. */
  invalidate(chunks?: Iterable<{ z: number; cx: number; cy: number }>): void {
    if (!chunks) return this.clear();
    for (const c of chunks) if (c.z === this.floorZ) this.drop(`${c.cx},${c.cy}`);
  }

  /** Positions the map for `cam` and (re)builds the chunks in view. Call once per frame. */
  render(cam: Camera, view: ViewSize): void {
    const scale = tilePixels(cam, this.tileSize) / this.tileSize;
    this.world.scale.set(scale);
    this.world.position.set(
      Math.round(-cam.x * this.tileSize * scale),
      Math.round(-cam.y * this.tileSize * scale),
    );
    const r = visibleChunks(cam, view, this.tileSize);
    const wanted = new Set<string>();
    let added = false;
    for (let cy = r.cy0; cy <= r.cy1; cy++) {
      for (let cx = r.cx0; cx <= r.cx1; cx++) {
        if (cx < 0 || cy < 0) continue;
        const key = `${cx},${cy}`;
        const data = this.source.chunk(this.floorZ, cx, cy);
        const cached = this.cache.get(key);
        if (cached && cached.data !== data) this.drop(key);
        if (!data) continue;
        wanted.add(key);
        if (!this.cache.has(key)) {
          this.build(key, cx, cy, data);
          added = true;
        }
      }
    }
    for (const key of [...this.cache.keys()]) if (!wanted.has(key)) this.drop(key);
    if (added) this.itemLayer.sortChildren();
  }

  /** Number of chunks currently built (for tests and the debug overlay). */
  get chunkCount(): number {
    return this.cache.size;
  }

  destroy(): void {
    this.clear();
    this.root.destroy({ children: true });
  }

  private build(key: string, cx: number, cy: number, data: ChunkData): void {
    const T = this.tileSize;
    const ox = cx * CHUNK_TILES * T;
    const oy = cy * CHUNK_TILES * T;
    const ground = new Container({ label: `ground ${key}`, x: ox, y: oy });
    for (let ly = 0; ly < CHUNK_TILES; ly++) {
      for (let lx = 0; lx < CHUNK_TILES; lx++) {
        const id = data.ground[ly * CHUNK_TILES + lx];
        if (id === null || id === undefined) continue;
        ground.addChild(
          new Sprite({ texture: this.texture(id), x: lx * T, y: ly * T, width: T, height: T }),
        );
      }
    }
    const items: Sprite[] = [];
    const gx = cx * CHUNK_TILES;
    const gy = cy * CHUNK_TILES;
    for (const s of data.items) {
      for (const [i, id] of s.stack.entries()) {
        const sprite = new Sprite({ texture: this.texture(id), anchor: 1 });
        sprite.position.set(ox + (s.x + 1) * T, oy + (s.y + 1) * T);
        sprite.zIndex = itemZIndex(gx + s.x, gy + s.y, i);
        items.push(sprite);
      }
    }
    this.groundLayer.addChild(ground);
    if (items.length > 0) this.itemLayer.addChild(...items);
    this.cache.set(key, { data, ground, items });
  }

  private drop(key: string): void {
    const c = this.cache.get(key);
    if (!c) return;
    c.ground.destroy({ children: true });
    for (const sprite of c.items) sprite.destroy();
    this.cache.delete(key);
  }

  private clear(): void {
    for (const key of [...this.cache.keys()]) this.drop(key);
  }
}
