// Tile map view over any TileSource: draws the chunks in view for one floor and keeps
// them cached. Shared by the game client and the map editor, so it knows nothing about
// either: no input handling, no game entities, no editing.
//
// Draw order (Tibia-like): the ground of every visible tile first, then the cast shadows of
// trees and buildings (translucent), then the item stacks tile by tile in global row-major
// order (across chunk borders), bottom to top. Items bigger than a tile are anchored at the
// bottom-right corner of their tile (or centred on it, tile art anchor bc) and extend up,
// over the tiles before them: a wall piece (32x64, docs/17 ART-3) puts its top over the
// tile behind it and hides what stands there.
//
// Tile art (tile-art.ts, optional `art`): a ground shows one of its looks by a hash of the
// tile; a wall shows the piece for its wall neighbours (also across chunk borders: a chunk
// is rebuilt when a neighbour its border walls depend on changes); animated grounds and
// items step their frames in render() from a flat list, with nothing allocated per frame.
import { Container, Sprite } from "pixi.js";
import type { Texture } from "pixi.js";
import { CHUNK_TILES, tilePixels, visibleChunks } from "./camera.ts";
import type { Camera, ViewSize } from "./camera.ts";
import { frameAt, framePhase, pickVariant, tileHash, wallMask, wallTiles } from "./tile-art.ts";
import type { TileArt, TileSync } from "./tile-art.ts";

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

/** Tile art of an item ID (tile-art.ts), or undefined to draw its texture as is. */
export type ArtLookup = (itemId: string) => TileArt<Texture> | undefined;

export interface MapViewOptions {
  source: TileSource;
  texture: TextureLookup;
  /** Ground looks, animations, wall pieces, anchors and shadows (docs/17 ART-3/4/7). */
  art?: ArtLookup | undefined;
  /** Sprite pixels per tile (the atlas tileSize). */
  tileSize: number;
  floor: number;
}

/** A sprite that plays frames (an animated ground or item). */
interface Animated {
  sprite: Sprite;
  frames: readonly Texture[];
  ms: number;
  sync: TileSync;
  phase: number;
  hash: number;
  /** Frame shown now (-1: none yet). */
  shown: number;
}

interface CachedChunk {
  data: ChunkData;
  ground: Container;
  shadows: Container | undefined;
  items: Sprite[];
  animated: Animated[];
  /** Light sources (tile art light): x, y (global tile) and radius in tiles, flat. */
  lights: number[];
  /** Neighbour chunks the wall pieces on this chunk's border were picked from. */
  deps: { cx: number; cy: number; data: ChunkData | undefined }[];
}

/** Items can be stacked this high on one tile before the draw order is ambiguous. */
export const MAX_STACK_ORDER = 256;
/** Cast shadows (ART-5): sprites tinted toward blue-violet, the layer at this alpha. */
export const CAST_SHADOW_TINT = 0x161428;
export const CAST_SHADOW_ALPHA = 0.32;

/**
 * Draw order of an item: global row-major by tile (y, then x), then by height in the stack.
 * The item layer sorts every item of every visible chunk by it, so a tall sprite near a
 * chunk border is still drawn over the tiles above it and under the tiles below it.
 */
export function itemZIndex(x: number, y: number, stackIndex: number): number {
  return (y * 65536 + x) * MAX_STACK_ORDER + Math.min(stackIndex, MAX_STACK_ORDER - 1);
}

/**
 * Draw order of an entity (creature) standing on tile (x, y): over every item of its own
 * tile and of the tiles before it, under the items of the tiles after it. Effects and
 * floating texts go in `overlay`, above everything.
 */
export function entityZIndex(x: number, y: number): number {
  return itemZIndex(x, y, MAX_STACK_ORDER - 1) + 0.5;
}

const NO_DEPS: CachedChunk["deps"] = [];

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
  private readonly shadowLayer = new Container({
    label: "shadows",
    isRenderGroup: true,
    alpha: CAST_SHADOW_ALPHA,
  });
  private readonly itemLayer = new Container({
    label: "items",
    isRenderGroup: true,
    sortableChildren: false,
  });
  private readonly cache = new Map<string, CachedChunk>();
  private readonly entities = new Set<Container>();
  private entitiesMoved = false;
  private source: TileSource;
  private readonly texture: TextureLookup;
  private readonly art: ArtLookup | undefined;
  private floorZ: number;
  /** Every animated sprite of the cached chunks; rebuilt when chunks come or go. */
  private animated: Animated[] = [];
  private animatedStale = false;
  /** Which tiles of a chunk object hold a wall (or an item that joins walls). */
  private readonly walls = new WeakMap<ChunkData, Uint8Array>();
  private readonly joins = new Map<string, boolean>();

  constructor(opts: MapViewOptions) {
    this.source = opts.source;
    this.texture = opts.texture;
    this.art = opts.art;
    this.tileSize = opts.tileSize;
    this.floorZ = opts.floor;
    this.world.addChild(this.groundLayer, this.shadowLayer, this.itemLayer, this.overlay);
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

  /**
   * Positions the map for `cam`, (re)builds the chunks in view and steps the animated tiles
   * to `now` (ms, any clock; 0 shows their first frame). Call once per frame.
   */
  render(cam: Camera, view: ViewSize, now = 0): void {
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
        if (cached && (cached.data !== data || this.depsChanged(cached))) this.drop(key);
        if (!data) continue;
        wanted.add(key);
        if (!this.cache.has(key)) {
          this.build(key, cx, cy, data);
          added = true;
        }
      }
    }
    for (const key of [...this.cache.keys()]) if (!wanted.has(key)) this.drop(key);
    if (added || this.entitiesMoved) this.itemLayer.sortChildren();
    this.entitiesMoved = false;
    this.animate(now);
  }

  /**
   * Adds or moves an entity (a creature) on tile (x, y). It is drawn in the item layer,
   * interleaved with the item stacks by tile (see entityZIndex); its position is the
   * caller's, in world units (one unit = one sprite pixel).
   */
  placeEntity(obj: Container, x: number, y: number): void {
    const z = entityZIndex(x, y);
    if (!this.entities.has(obj)) {
      this.entities.add(obj);
      this.itemLayer.addChild(obj);
      this.entitiesMoved = true;
    }
    if (obj.zIndex !== z) {
      obj.zIndex = z;
      this.entitiesMoved = true;
    }
  }

  /** Removes an entity added with placeEntity (the caller destroys it). */
  removeEntity(obj: Container): void {
    if (!this.entities.delete(obj)) return;
    this.itemLayer.removeChild(obj);
  }

  /**
   * Whether tile (x, y) of the current floor holds a wall or an item that joins walls
   * (a door). Its piece covers the tile behind it (y - 1): the caller can show what stands
   * there (ART-3, the own player's silhouette). False for tiles the source does not have.
   */
  wallAt(x: number, y: number): boolean {
    if (x < 0 || y < 0) return false;
    const data = this.source.chunk(
      this.floorZ,
      Math.floor(x / CHUNK_TILES),
      Math.floor(y / CHUNK_TILES),
    );
    return data
      ? this.wallsOf(data)[(y % CHUNK_TILES) * CHUNK_TILES + (x % CHUNK_TILES)] === 1
      : false;
  }

  /** Number of chunks currently built (for tests and the debug overlay). */
  get chunkCount(): number {
    return this.cache.size;
  }

  /**
   * Calls fn for every item that gives light (tile art light, ART-7) in the built chunks: its
   * tile and its radius in tiles. Allocates nothing.
   */
  forEachLight(fn: (x: number, y: number, radius: number) => void): void {
    for (const c of this.cache.values()) {
      const l = c.lights;
      for (let i = 0; i + 2 < l.length; i += 3)
        fn(l[i] as number, l[i + 1] as number, l[i + 2] as number);
    }
  }

  /** Number of animated sprites in the built chunks (for tests and the debug overlay). */
  get animatedCount(): number {
    if (this.animatedStale) this.collectAnimated();
    return this.animated.length;
  }

  destroy(): void {
    this.clear();
    for (const e of this.entities) this.itemLayer.removeChild(e);
    this.entities.clear();
    this.root.destroy({ children: true });
  }

  /** Steps every animated sprite to `now`; only a changed frame touches its sprite. */
  private animate(now: number): void {
    if (this.animatedStale) this.collectAnimated();
    const list = this.animated;
    for (let i = 0; i < list.length; i++) {
      const a = list[i] as Animated;
      const f = frameAt(now, a.sync, a.frames.length, a.ms, a.phase, a.hash);
      if (f === a.shown) continue;
      a.shown = f;
      a.sprite.texture = a.frames[f] as Texture;
    }
  }

  private collectAnimated(): void {
    const out: Animated[] = [];
    for (const c of this.cache.values()) for (const a of c.animated) out.push(a);
    this.animated = out;
    this.animatedStale = false;
  }

  private joinsWalls(id: string): boolean {
    let j = this.joins.get(id);
    if (j === undefined) {
      j = this.art?.(id)?.joinsWalls === true;
      this.joins.set(id, j);
    }
    return j;
  }

  private wallsOf(data: ChunkData): Uint8Array {
    let w = this.walls.get(data);
    if (!w) {
      w = this.art ? wallTiles(data.items, CHUNK_TILES, (id) => this.joinsWalls(id)) : EMPTY_WALLS;
      this.walls.set(data, w);
    }
    return w;
  }

  private depsChanged(c: CachedChunk): boolean {
    for (const d of c.deps) if (this.source.chunk(this.floorZ, d.cx, d.cy) !== d.data) return true;
    return false;
  }

  private build(key: string, cx: number, cy: number, data: ChunkData): void {
    const T = this.tileSize;
    const z = this.floorZ;
    const ox = cx * CHUNK_TILES * T;
    const oy = cy * CHUNK_TILES * T;
    const gx = cx * CHUNK_TILES;
    const gy = cy * CHUNK_TILES;
    const animated: Animated[] = [];
    const ground = new Container({ label: `ground ${key}`, x: ox, y: oy });
    for (let ly = 0; ly < CHUNK_TILES; ly++) {
      for (let lx = 0; lx < CHUNK_TILES; lx++) {
        const id = data.ground[ly * CHUNK_TILES + lx];
        if (id === null || id === undefined) continue;
        const art = this.art?.(id);
        const hash = art ? tileHash(gx + lx, gy + ly, z) : 0;
        let tex = art?.base ?? this.texture(id);
        if (art?.variants)
          tex = art.variants[pickVariant(hash, art.variants.length, art.weight)] ?? tex;
        const sprite = new Sprite({ texture: tex, x: lx * T, y: ly * T, width: T, height: T });
        if (art?.frames) animated.push(animatedOf(sprite, art, hash));
        ground.addChild(sprite);
      }
    }
    const walls = this.wallsOf(data);
    const deps = new Map<string, CachedChunk["deps"][number]>();
    /** Whether global tile (x, y) holds a wall, reading the neighbour chunk if it must. */
    const wallAt = (x: number, y: number): boolean => {
      const lx = x - gx;
      const ly = y - gy;
      if (lx >= 0 && ly >= 0 && lx < CHUNK_TILES && ly < CHUNK_TILES)
        return walls[ly * CHUNK_TILES + lx] === 1;
      if (x < 0 || y < 0) return false;
      const ncx = Math.floor(x / CHUNK_TILES);
      const ncy = Math.floor(y / CHUNK_TILES);
      const k = `${ncx},${ncy}`;
      let dep = deps.get(k);
      if (!dep) {
        dep = { cx: ncx, cy: ncy, data: this.source.chunk(z, ncx, ncy) };
        deps.set(k, dep);
      }
      return dep.data
        ? this.wallsOf(dep.data)[
            (y - ncy * CHUNK_TILES) * CHUNK_TILES + (x - ncx * CHUNK_TILES)
          ] === 1
        : false;
    };
    const items: Sprite[] = [];
    const lights: number[] = [];
    let shadows: Container | undefined;
    for (const s of data.items) {
      const x = gx + s.x;
      const y = gy + s.y;
      for (const [i, id] of s.stack.entries()) {
        const art = this.art?.(id);
        let tex = art?.base ?? this.texture(id);
        if (art?.wall) {
          const mask = wallMask(
            wallAt(x, y - 1),
            wallAt(x + 1, y),
            wallAt(x, y + 1),
            wallAt(x - 1, y),
          );
          tex = art.wall[mask] ?? tex;
        }
        const ax = art?.anchorX ?? 1;
        const sprite = new Sprite({ texture: tex, anchor: { x: ax, y: 1 } });
        sprite.position.set(ox + (s.x + ax) * T, oy + (s.y + 1) * T);
        sprite.zIndex = itemZIndex(x, y, i);
        items.push(sprite);
        if (art?.frames) animated.push(animatedOf(sprite, art, tileHash(x, y, z + i)));
        if (art && art.light > 0) lights.push(x, y, art.light);
        if (art?.shadow) {
          shadows ??= new Container({ label: `shadows ${key}` });
          const sh = new Sprite({
            texture: art.shadow,
            anchor: { x: ax, y: 1 },
            tint: CAST_SHADOW_TINT,
          });
          sh.position.copyFrom(sprite.position);
          shadows.addChild(sh);
        }
      }
    }
    this.groundLayer.addChild(ground);
    if (shadows) this.shadowLayer.addChild(shadows);
    if (items.length > 0) this.itemLayer.addChild(...items);
    this.cache.set(key, {
      data,
      ground,
      shadows,
      items,
      animated,
      lights,
      deps: deps.size > 0 ? [...deps.values()] : NO_DEPS,
    });
    if (animated.length > 0) this.animatedStale = true;
  }

  private drop(key: string): void {
    const c = this.cache.get(key);
    if (!c) return;
    c.ground.destroy({ children: true });
    c.shadows?.destroy({ children: true });
    for (const sprite of c.items) sprite.destroy();
    if (c.animated.length > 0) this.animatedStale = true;
    this.cache.delete(key);
  }

  private clear(): void {
    for (const key of [...this.cache.keys()]) this.drop(key);
  }
}

const EMPTY_WALLS = new Uint8Array(CHUNK_TILES * CHUNK_TILES);

function animatedOf(sprite: Sprite, art: TileArt<Texture>, hash: number): Animated {
  const frames = art.frames ?? [];
  return {
    sprite,
    frames,
    ms: art.ms,
    sync: art.sync,
    phase: framePhase(art.sync, hash, frames.length, art.ms),
    hash,
    shown: -1,
  };
}
