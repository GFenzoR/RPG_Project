// Tile map view over any TileSource: draws the chunks in view for one floor and keeps
// them cached. Shared by the game client and the map editor, so it knows nothing about
// either: no input handling, no game entities, no editing.
//
// Draw order (Tibia-like): the ground of every visible tile first, with the flat border
// pieces on it (tile art `flat`: they lie inside their tile, so a creature whose sprite
// reaches over the next tile is never cut by that tile's fringe), then the cast shadows of
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
//
// Elevation (ART-8, optional `elevation`): an item stacked on a table or a crate is drawn
// higher by the elevation of the items under it (tile-art.ts stackElevation, capped); the
// caller lifts a creature standing there by elevationAt. Cast shadows stay on the ground.
//
// Particles (ART-7, A13): the tiles whose tile art has `particles` are listed per chunk, so
// the caller can spawn its ambient motes there (forEachEmitter) without scanning the map.
import { Container, Sprite } from "pixi.js";
import type { Texture } from "pixi.js";
import { CHUNK_TILES, tilePixels, visibleChunks } from "./camera.ts";
import type { Camera, ViewSize } from "./camera.ts";
import {
  MAX_ELEVATION,
  PARTICLE_KINDS,
  frameAt,
  framePhase,
  framesOfLook,
  groundDecal,
  groundLook,
  groundTone,
  lookOf,
  stackElevation,
  tileHash,
  wallMask,
  wallTiles,
} from "./tile-art.ts";
import type { ParticleKind, TileArt, TileSync } from "./tile-art.ts";

/**
 * One 32x32 chunk: row-major ground IDs and sparse item stacks (local coordinates). An ID
 * is the source's own key, opaque here: MapView only hands it back to the lookups below and
 * to forEachItemSprite, and sprites are told apart by it. The game client's is the item's
 * number, or "<number>@<monster>" for the remains of a monster, drawn as that monster's
 * corpse (client/src/state/corpse-art.ts); a caller that wants the item parses it there.
 */
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

/** ART-8: how many sprite pixels an item raises what is stacked on it (data/items elevation). */
export type ElevationLookup = (itemId: string) => number;

export interface MapViewOptions {
  source: TileSource;
  texture: TextureLookup;
  /** Ground looks, animations, wall pieces, anchors and shadows (docs/17 ART-3/4/7). */
  art?: ArtLookup | undefined;
  /** Elevation of an item (ART-8); absent: nothing raises anything. */
  elevation?: ElevationLookup | undefined;
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
  /** Global tile x, y and item id of each of `items` (same order): forEachItemSprite. */
  itemTiles: number[];
  itemIds: string[];
  animated: Animated[];
  /** Light sources (tile art light): x, y (global tile) and radius in tiles, flat. */
  lights: number[];
  /** Particle emitters (tile art particles): x, y (global tile), PARTICLE_KINDS index, flat. */
  emitters: number[];
  /** Neighbour chunks the wall pieces on this chunk's border were picked from. */
  deps: { cx: number; cy: number; data: ChunkData | undefined }[];
  /** Wall pieces (walls and items that join walls) by global tile, for revealBehind. */
  wallSprites: Map<string, Sprite[]>;
}

/** A rectangle in world units (one unit = one sprite pixel). */
export interface WorldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * ART-3: a wall piece in front of the own player that covers part of it fades to this
 * alpha, so the player is seen through the wall (the wall gives way, not the player).
 */
export const REVEAL_ALPHA = 0.35;
/** Time (ms) a wall takes to fade out or back in (exponential, about 95 % in 3× this). */
export const REVEAL_FADE_MS = 90;
/** How many tiles south of a figure's feet a tall wall piece can still cover it. */
const REVEAL_ROWS = 3;

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
  /**
   * World-space container over the grounds and their flat border pieces, under cast shadows,
   * items and creatures: marks that lie on the ground (the living world's footprints).
   */
  readonly groundOverlay = new Container({ label: "ground overlay" });
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
  private readonly elevation: ElevationLookup | undefined;
  private floorZ: number;
  /** Every animated sprite of the cached chunks; rebuilt when chunks come or go. */
  private animated: Animated[] = [];
  private animatedStale = false;
  /** Chunks built or dropped so far (version). */
  private builds = 0;
  /** Which tiles of a chunk object hold a wall (or an item that joins walls). */
  private readonly walls = new WeakMap<ChunkData, Uint8Array>();
  private readonly joins = new Map<string, boolean>();
  /** Elevation of each tile of a chunk object (ART-8), null when nothing there raises. */
  private readonly heights = new WeakMap<ChunkData, Uint8Array | null>();
  /** Wall pieces faded by revealBehind (or still fading back in), with their target. */
  private readonly revealed = new Map<Sprite, number>();
  private revealNow: number | undefined;

  constructor(opts: MapViewOptions) {
    this.source = opts.source;
    this.texture = opts.texture;
    this.art = opts.art;
    this.elevation = opts.elevation;
    this.tileSize = opts.tileSize;
    this.floorZ = opts.floor;
    this.world.addChild(
      this.groundLayer,
      this.groundOverlay,
      this.shadowLayer,
      this.itemLayer,
      this.overlay,
    );
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

  /**
   * How strong the baked cast shadows of trees and buildings are, 0..1 of
   * CAST_SHADOW_ALPHA: the client's day and night fades them with the sun (cheap: one
   * alpha on their layer). 1 by default; the editor never changes it.
   */
  set castShadowStrength(k: number) {
    this.shadowLayer.alpha = CAST_SHADOW_ALPHA * Math.min(1, Math.max(0, k));
  }

  get castShadowStrength(): number {
    return this.shadowLayer.alpha / CAST_SHADOW_ALPHA;
  }

  /**
   * ART-3: fades the wall pieces drawn in front of a figure standing on tile row `row`
   * (rows south of it, so drawn over it) whose sprite overlaps `rect` (the figure, world
   * units), and fades back in the ones that no longer cover it. `undefined` reveals
   * nothing. Call once per frame after render(); `now` in ms drives a smooth fade.
   */
  revealBehind(rect: WorldRect | undefined, row: number, now: number): void {
    const want = new Set<Sprite>();
    if (rect) {
      const T = this.tileSize;
      const x0 = Math.floor(rect.x / T) - 1;
      const x1 = Math.floor((rect.x + rect.width) / T) + 1;
      for (let y = row + 1; y <= row + REVEAL_ROWS; y++) {
        for (let x = x0; x <= x1; x++) {
          for (const sp of this.wallSpritesAt(x, y)) {
            if (overlaps(spriteRect(sp), rect)) want.add(sp);
          }
        }
      }
    }
    for (const sp of want) this.revealed.set(sp, REVEAL_ALPHA);
    for (const sp of this.revealed.keys()) if (!want.has(sp)) this.revealed.set(sp, 1);
    const dt = this.revealNow === undefined ? Infinity : Math.max(0, now - this.revealNow);
    this.revealNow = now;
    const k = dt === Infinity ? 1 : 1 - Math.exp(-dt / REVEAL_FADE_MS);
    for (const [sp, target] of this.revealed) {
      if (sp.destroyed) {
        this.revealed.delete(sp);
        continue;
      }
      const a = sp.alpha + (target - sp.alpha) * k;
      sp.alpha = Math.abs(target - a) < 0.01 ? target : a;
      if (target === 1 && sp.alpha === 1) this.revealed.delete(sp);
    }
  }

  /** The alpha of each wall piece drawn on global tile (x, y) now (tests, E2E hooks). */
  wallAlphaAt(x: number, y: number): number[] {
    return this.wallSpritesAt(x, y).map((sp) => sp.alpha);
  }

  private wallSpritesAt(x: number, y: number): readonly Sprite[] {
    if (x < 0 || y < 0) return NO_SPRITES;
    const c = this.cache.get(`${Math.floor(x / CHUNK_TILES)},${Math.floor(y / CHUNK_TILES)}`);
    return c?.wallSprites.get(`${x},${y}`) ?? NO_SPRITES;
  }

  /**
   * ART-8: how many sprite pixels a creature standing on tile (x, y) of the current floor is
   * raised (a table, a crate), 0 for tiles the source does not have.
   */
  elevationAt(x: number, y: number): number {
    if (!this.elevation || x < 0 || y < 0) return 0;
    const data = this.source.chunk(
      this.floorZ,
      Math.floor(x / CHUNK_TILES),
      Math.floor(y / CHUNK_TILES),
    );
    if (!data) return 0;
    let h = this.heights.get(data);
    if (h === undefined) {
      h = this.heightsOf(data);
      this.heights.set(data, h);
    }
    return h ? (h[(y % CHUNK_TILES) * CHUNK_TILES + (x % CHUNK_TILES)] ?? 0) : 0;
  }

  /**
   * Calls fn for every tile of the built chunks whose ground or items give off ambient
   * particles (tile art particles, ART-7): its tile and the kind. Allocates nothing.
   */
  forEachEmitter(fn: (x: number, y: number, kind: ParticleKind) => void): void {
    for (const c of this.cache.values()) {
      const e = c.emitters;
      for (let i = 0; i + 2 < e.length; i += 3)
        fn(e[i] as number, e[i + 1] as number, PARTICLE_KINDS[e[i + 2] as number] ?? "dust");
    }
  }

  /** Changes whenever a chunk is built or dropped: the item sprites are other ones. */
  get version(): number {
    return this.builds;
  }

  /**
   * Calls fn for every item sprite of the built chunks (not the flat border pieces): its
   * global tile, item id (the source's key, see ChunkData) and sprite. The caller may skew or
   * nudge a sprite, or hide it and draw its own view in its place (same parent, position and
   * zIndex, sorted after it: the living world's plants in the wind), but must not keep it
   * past the next version change.
   */
  forEachItemSprite(fn: (x: number, y: number, id: string, sprite: Sprite) => void): void {
    for (const c of this.cache.values()) {
      for (let i = 0; i < c.items.length; i++)
        fn(
          c.itemTiles[i * 2] as number,
          c.itemTiles[i * 2 + 1] as number,
          c.itemIds[i] as string,
          c.items[i] as Sprite,
        );
    }
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

  private heightsOf(data: ChunkData): Uint8Array | null {
    const elev = this.elevation;
    if (!elev) return null;
    let out: Uint8Array | null = null;
    for (const s of data.items) {
      const h = stackElevation(s.stack, s.stack.length, elev);
      if (h <= 0) continue;
      out ??= new Uint8Array(CHUNK_TILES * CHUNK_TILES);
      out[s.y * CHUNK_TILES + s.x] = h;
    }
    return out;
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
    const emitters: number[] = [];
    const ground = new Container({ label: `ground ${key}`, x: ox, y: oy });
    const deps = new Map<string, CachedChunk["deps"][number]>();
    /** The chunk holding global tile (x, y): this one, or a neighbour (then a dependency). */
    const chunkAt = (x: number, y: number): ChunkData | undefined => {
      const ncx = Math.floor(x / CHUNK_TILES);
      const ncy = Math.floor(y / CHUNK_TILES);
      if (ncx === cx && ncy === cy) return data;
      if (x < 0 || y < 0) return undefined;
      const k = `${ncx},${ncy}`;
      let dep = deps.get(k);
      if (!dep) {
        dep = { cx: ncx, cy: ncy, data: this.source.chunk(z, ncx, ncy) };
        deps.set(k, dep);
      }
      return dep.data;
    };
    const local = (v: number): number => ((v % CHUNK_TILES) + CHUNK_TILES) % CHUNK_TILES;
    const groundAt = (x: number, y: number): string | null | undefined =>
      chunkAt(x, y)?.ground[local(y) * CHUNK_TILES + local(x)];
    /** A decal goes only where the four neighbours are the same ground (no border on it). */
    const inField = (x: number, y: number, id: string): boolean =>
      groundAt(x, y - 1) === id &&
      groundAt(x + 1, y) === id &&
      groundAt(x, y + 1) === id &&
      groundAt(x - 1, y) === id;
    /** Decals of this chunk: drawn after every ground, before the flat border pieces. */
    const decals: Sprite[] = [];
    for (let ly = 0; ly < CHUNK_TILES; ly++) {
      for (let lx = 0; lx < CHUNK_TILES; lx++) {
        const id = data.ground[ly * CHUNK_TILES + lx];
        if (id === null || id === undefined) continue;
        const art = this.art?.(id);
        const x = gx + lx;
        const y = gy + ly;
        const hash = art ? tileHash(x, y, z) : 0;
        let tex = art?.base ?? this.texture(id);
        // The look and the tone of a ground (docs/17 ART-4): the grid of one tile fades.
        if (art?.variants) tex = art.variants[groundLook(art, x, y, z)] ?? tex;
        const tint = groundTone(x, y, z);
        const sprite = new Sprite({ texture: tex, x: lx * T, y: ly * T, width: T, height: T });
        sprite.tint = tint;
        if (art?.frames) animated.push(animatedOf(sprite, art, hash, 0));
        if (art?.particles && (art.particles !== "spray" || edgeOf(data.ground, lx, ly, id)))
          emitters.push(x, y, PARTICLE_KINDS.indexOf(art.particles));
        ground.addChild(sprite);
        const d = art?.decals ? groundDecal(x, y, z, art.decals.length) : -1;
        if (art?.decals && d >= 0 && inField(x, y, id)) {
          const decal = new Sprite({ texture: art.decals[d] as Texture, x: lx * T, y: ly * T });
          decal.width = T;
          decal.height = T;
          decal.tint = tint;
          decals.push(decal);
        }
      }
    }
    if (decals.length > 0) ground.addChild(...decals);
    /** Whether global tile (x, y) holds a wall, reading the neighbour chunk if it must. */
    const wallAt = (x: number, y: number): boolean => {
      const c = chunkAt(x, y);
      return c ? this.wallsOf(c)[local(y) * CHUNK_TILES + local(x)] === 1 : false;
    };
    const items: Sprite[] = [];
    const itemTiles: number[] = [];
    const itemIds: string[] = [];
    /** Flat border pieces: children of the chunk's ground container, destroyed with it. */
    const flats: Sprite[] = [];
    const lights: number[] = [];
    const wallSprites = new Map<string, Sprite[]>();
    let shadows: Container | undefined;
    const elev = this.elevation;
    for (const s of data.items) {
      const x = gx + s.x;
      const y = gy + s.y;
      let raised = 0;
      let emits = -1;
      for (const [i, id] of s.stack.entries()) {
        const art = this.art?.(id);
        let tex = art?.base ?? this.texture(id);
        // A border piece's look (ART-4): the same number for every piece of the tile.
        const look = art?.variants ? lookOf(art, tileHash(x, y, z), false) : 0;
        if (art?.variants) tex = art.variants[look] ?? tex;
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
        if (art?.flat) {
          // A border piece lies on its tile's ground, inside the tile: drawn with the grounds
          // (after all of them, in stack order), under shadows, items and creatures.
          sprite.position.set((s.x + ax) * T, (s.y + 1) * T - raised);
          // Tinted like the ground it comes from: the tone is the same function of position.
          sprite.tint = groundTone(x, y, z);
          flats.push(sprite);
        } else {
          sprite.position.set(ox + (s.x + ax) * T, oy + (s.y + 1) * T - raised);
          sprite.zIndex = itemZIndex(x, y, i);
          items.push(sprite);
          itemTiles.push(x, y);
          itemIds.push(id);
          if (art?.wall || this.joinsWalls(id)) {
            const k = `${x},${y}`;
            const list = wallSprites.get(k);
            if (list) list.push(sprite);
            else wallSprites.set(k, [sprite]);
          }
        }
        if (elev && raised < MAX_ELEVATION)
          raised = Math.min(MAX_ELEVATION, raised + Math.max(0, elev(id)));
        if (art?.particles && emits < 0) emits = PARTICLE_KINDS.indexOf(art.particles);
        if (art?.frames) animated.push(animatedOf(sprite, art, tileHash(x, y, z + i), look));
        if (art && art.light > 0) lights.push(x, y, art.light);
        if (art?.shadow) {
          shadows ??= new Container({ label: `shadows ${key}` });
          const sh = new Sprite({
            texture: art.shadow,
            anchor: { x: ax, y: 1 },
            tint: CAST_SHADOW_TINT,
          });
          sh.position.set(sprite.x, oy + (s.y + 1) * T);
          shadows.addChild(sh);
        }
      }
      if (emits >= 0) emitters.push(x, y, emits);
    }
    if (flats.length > 0) ground.addChild(...flats);
    this.groundLayer.addChild(ground);
    if (shadows) this.shadowLayer.addChild(shadows);
    if (items.length > 0) this.itemLayer.addChild(...items);
    this.cache.set(key, {
      data,
      ground,
      shadows,
      items,
      itemTiles,
      itemIds,
      animated,
      lights,
      emitters,
      deps: deps.size > 0 ? [...deps.values()] : NO_DEPS,
      wallSprites,
    });
    if (animated.length > 0) this.animatedStale = true;
    this.builds++;
  }

  private drop(key: string): void {
    const c = this.cache.get(key);
    if (!c) return;
    c.ground.destroy({ children: true });
    c.shadows?.destroy({ children: true });
    for (const sprite of c.items) sprite.destroy();
    if (c.animated.length > 0) this.animatedStale = true;
    this.cache.delete(key);
    this.builds++;
  }

  private clear(): void {
    for (const key of [...this.cache.keys()]) this.drop(key);
  }
}

const EMPTY_WALLS = new Uint8Array(CHUNK_TILES * CHUNK_TILES);
const NO_SPRITES: readonly Sprite[] = [];

/** A sprite's rectangle in its parent's units, from its texture, anchor and scale. */
function spriteRect(sp: Sprite): WorldRect {
  const w = sp.texture.width * Math.abs(sp.scale.x);
  const h = sp.texture.height * Math.abs(sp.scale.y);
  return { x: sp.x - sp.anchor.x * w, y: sp.y - sp.anchor.y * h, width: w, height: h };
}

export function overlaps(a: WorldRect, b: WorldRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Whether ground tile (lx, ly) of a chunk borders another ground (inside the chunk). */
function edgeOf(ground: ChunkData["ground"], lx: number, ly: number, id: string): boolean {
  const same = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= CHUNK_TILES || y >= CHUNK_TILES || ground[y * CHUNK_TILES + x] === id;
  return !same(lx, ly - 1) || !same(lx + 1, ly) || !same(lx, ly + 1) || !same(lx - 1, ly);
}

function animatedOf(sprite: Sprite, art: TileArt<Texture>, hash: number, look: number): Animated {
  const frames = framesOfLook(art, look) ?? [];
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
