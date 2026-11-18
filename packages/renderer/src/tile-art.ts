// Map tile art (docs/17 ART-3, ART-4, ART-7): which texture a ground or item draws on a tile
// beyond its one sprite. Pure (no PixiJS), so the client, the map editor (MapView) and the
// mapcli render pick the same pixels for the same tile:
// - variants: a ground has alternate looks (<sprite>/var_<n>), picked by a hash of the tile;
// - frames: an animated sprite (<sprite>/frame_<n>) plays in step with the world, with a
//   phase per tile, or as a rare glint per tile;
// - walls: a wall sprite has 16 pieces (<sprite>/wall_<mask>), one per set of wall
//   neighbours (north, east, south, west), and the renderer puts the right one on each tile;
// - anchor: centred on the tile (trees) instead of the bottom-right corner;
// - shadow: <sprite>/shadow, drawn on the shadow layer under the items.
// tools/spritepack writes what each sprite has into atlas.json `tiles` (TileMeta).

/** atlas.json `tiles[sprite]` (tools/spritepack): the extra art a map sprite has. */
export interface TileMeta {
  /** Alternate looks <sprite>/var_1..var_<variants>; the sprite itself is look 0. */
  variants?: number;
  /** Share of the tiles that show look 0 (default MAIN_WEIGHT). */
  weight?: number;
  /** Frames of an animated sprite, the sprite itself included: <sprite>/frame_1.. */
  frames?: number;
  /** Ms per frame. */
  ms?: number;
  /** world: every tile in step; tile: a phase per tile; random: a rare glint per tile. */
  sync?: TileSync;
  /** bc: centred on its tile, standing on its bottom edge. Absent: bottom-right (br). */
  anchor?: "bc";
  /** Has the 16 pieces <sprite>/wall_<mask> (ART-3). */
  wall?: true;
  /** Counts as a wall for its neighbours' pieces without being one (a door in a wall). */
  joins?: true;
  /** Has <sprite>/shadow, drawn on the shadow layer. */
  shadow?: true;
  /** Gives light in dark places (caves, ART-7): its radius in tiles. */
  light?: number;
}

export type TileSync = "world" | "tile" | "random";

/** The textures (or images) of a sprite's tile art, resolved from its TileMeta. */
export interface TileArt<T> {
  base: T;
  /** Every look, the base first. */
  variants?: readonly T[];
  /** Share of look 0. */
  weight: number;
  /** Every frame, the base first. */
  frames?: readonly T[];
  ms: number;
  sync: TileSync;
  /** 1: bottom-right corner on the tile's; 0.5: centred on the tile. */
  anchorX: 1 | 0.5;
  /** The 16 pieces by mask (WALL_N | WALL_E | WALL_S | WALL_W). */
  wall?: readonly T[];
  /** Neighbours treat it as a wall (walls and joins). */
  joinsWalls: boolean;
  shadow?: T;
  /** Light radius in tiles, 0 for none. */
  light: number;
}

/** Share of the tiles that keep a ground's main look (ART-4: about 70 %). */
export const MAIN_WEIGHT = 0.7;
/** Default ms per frame of an animation without one. */
export const DEFAULT_FRAME_MS = 250;
/** A `random` glint plays once every GLINT_MIN_MS..GLINT_MIN_MS + GLINT_SPREAD_MS per tile. */
export const GLINT_MIN_MS = 3000;
export const GLINT_SPREAD_MS = 2000;

/** Wall neighbour bits of a piece mask. */
export const WALL_N = 1;
export const WALL_E = 2;
export const WALL_S = 4;
export const WALL_W = 8;
export const WALL_PIECES = 16;

export const variantName = (sprite: string, n: number): string => `${sprite}/var_${n}`;
export const tileFrameName = (sprite: string, n: number): string => `${sprite}/frame_${n}`;
export const wallName = (sprite: string, mask: number): string => `${sprite}/wall_${mask}`;
export const shadowName = (sprite: string): string => `${sprite}/shadow`;

/** A tile-art part's name: <base>/var_<n>, frame_<n>, wall_<mask> or shadow. */
export const TILE_PART =
  /^(.+)\/(?:var_[1-9][0-9]*|frame_[1-9][0-9]*|wall_(?:[0-9]|1[0-5])|shadow)$/;

/**
 * Deterministic hash of a tile to [0, 1): the same tile always gets the same look and
 * phase, neighbours look unrelated.
 */
export function tileHash(x: number, y: number, z: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x1b873593);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Which of `count` looks a tile shows: look 0 for a share `weight` of the hashes, the others
 * evenly over the rest.
 */
export function pickVariant(hash: number, count: number, weight = MAIN_WEIGHT): number {
  if (count <= 1 || hash < weight) return 0;
  const rest = (hash - weight) / (1 - weight);
  return 1 + Math.min(count - 2, Math.floor(rest * (count - 1)));
}

/**
 * The phase (ms) of an animated tile: 0 for `world` (every tile in step), spread over a
 * whole cycle for `tile`, and over a glint period for `random`.
 */
export function framePhase(sync: TileSync, hash: number, frames: number, ms: number): number {
  if (sync === "world") return 0;
  if (sync === "tile") return Math.floor(hash * frames * ms);
  return Math.floor(hash * glintPeriod(hash));
}

/** How often a `random` tile glints, ms. */
export const glintPeriod = (hash: number): number =>
  GLINT_MIN_MS + Math.floor(((hash * 7919) % 1) * GLINT_SPREAD_MS);

/**
 * The frame an animated tile shows at `now` (ms): world and tile sprites loop; a random one
 * shows its frames once per glint period and its base frame the rest of the time.
 */
export function frameAt(
  now: number,
  sync: TileSync,
  frames: number,
  ms: number,
  phase: number,
  hash: number,
): number {
  if (frames <= 1 || ms <= 0) return 0;
  const t = now + phase;
  if (sync !== "random") return Math.floor(t / ms) % frames;
  const period = glintPeriod(hash);
  const into = ((t % period) + period) % period;
  const n = Math.floor(into / ms);
  return n < frames ? n : 0;
}

/** The piece mask of a wall from which of its four neighbours are walls (or join them). */
export function wallMask(n: boolean, e: boolean, s: boolean, w: boolean): number {
  return (n ? WALL_N : 0) | (e ? WALL_E : 0) | (s ? WALL_S : 0) | (w ? WALL_W : 0);
}

/**
 * The tile art a sprite has, from its atlas.json `tiles` entry: the parts the lookup finds,
 * in order, stopping at the first gap. Undefined when the sprite has no extra art (draw its
 * texture as always) or the lookup has not even the base.
 */
export function resolveTileArt<T>(
  sprite: string,
  meta: TileMeta | undefined,
  lookup: (name: string) => T | undefined,
): TileArt<T> | undefined {
  if (!meta) return undefined;
  const base = lookup(sprite);
  if (base === undefined) return undefined;
  const list = (count: number, name: (n: number) => string): T[] => {
    const out: T[] = [base];
    for (let n = 1; n < count; n++) {
      const t = lookup(name(n));
      if (t === undefined) break;
      out.push(t);
    }
    return out;
  };
  const art: TileArt<T> = {
    base,
    weight: meta.weight ?? MAIN_WEIGHT,
    ms: meta.ms ?? DEFAULT_FRAME_MS,
    sync: meta.sync ?? "world",
    anchorX: meta.anchor === "bc" ? 0.5 : 1,
    joinsWalls: meta.wall === true || meta.joins === true,
    light: meta.light ?? 0,
  };
  if (meta.variants) {
    const v = list(meta.variants + 1, (n) => variantName(sprite, n));
    if (v.length > 1) art.variants = v;
  }
  if (meta.frames) {
    const f = list(meta.frames, (n) => tileFrameName(sprite, n));
    if (f.length > 1) art.frames = f;
  }
  if (meta.wall) {
    const pieces: T[] = [];
    for (let m = 0; m < WALL_PIECES; m++) {
      const t = lookup(wallName(sprite, m));
      if (t === undefined) break;
      pieces.push(t);
    }
    if (pieces.length === WALL_PIECES) art.wall = pieces;
  }
  if (meta.shadow) {
    const s = lookup(shadowName(sprite));
    if (s !== undefined) art.shadow = s;
  }
  return art;
}

/**
 * Which tiles of a chunk hold an item that is or joins a wall: index ly * size + lx → 1.
 * Cached per chunk object by the caller.
 */
export function wallTiles(
  items: readonly { readonly x: number; readonly y: number; readonly stack: readonly string[] }[],
  size: number,
  joins: (itemId: string) => boolean,
): Uint8Array {
  const out = new Uint8Array(size * size);
  for (const s of items) if (s.stack.some(joins)) out[s.y * size + s.x] = 1;
  return out;
}
