// Map tile art (docs/17 ART-3, ART-4, ART-7): which texture a ground or item draws on a tile
// beyond its one sprite. Pure (no PixiJS), so the client, the map editor (MapView) and the
// mapcli render pick the same pixels for the same tile:
// - variants: a ground has alternate looks (<sprite>/var_<n>), picked per tile by groundLook
//   (a hash of the tile, a slow noise that makes whole areas lean to some looks, and never
//   the same alternate look on two tiles side by side); so does a border piece (docs/17 ART-4), its looks evenly, and an animated look has its
//   own frames (<sprite>/var_<n>/frame_<m>: the surf of each shape of shore);
// - decals: a ground's sparse details (<sprite>/decal_<n>: a shell, a twig, a flower), laid
//   flat on a few of its tiles by groundDecal: ground art, never items (docs/17 ART-4);
// - tone: every ground and flat piece is tinted by groundTone, a slow noise of the position,
//   so wide areas shift subtly in shade instead of repeating one tile;
// - frames: an animated sprite (<sprite>/frame_<n>) plays in step with the world, with a
//   phase per tile, or as a rare glint per tile;
// - walls: a wall sprite has 16 pieces (<sprite>/wall_<mask>), one per set of wall
//   neighbours (north, east, south, west), and the renderer puts the right one on each tile;
// - anchor: centred on the tile (trees) instead of the bottom-right corner;
// - shadow: <sprite>/shadow, drawn on the shadow layer under the items;
// - particles: ambient motes the client spawns around it (docs/17 ART-7, A13);
// - steps: what a step on a ground kicks up, a puff of dust or a ripple (MOV-7);
// - flat: a decal lying on its tile's ground (every border piece, ART-4), drawn with the
//   grounds: under the cast shadows, the items and the creatures of every tile;
// - elevation (data/items, not the atlas): what stands on a table or a crate is drawn
//   higher (ART-8), stackElevation below.
// tools/spritepack writes what each sprite has into atlas.json `tiles` (TileMeta).

/** atlas.json `tiles[sprite]` (tools/spritepack): the extra art a map sprite has. */
export interface TileMeta {
  /**
   * Alternate looks <sprite>/var_1..var_<variants>; the sprite itself is look 0. With frames,
   * each look n has its own <sprite>/var_<n>/frame_<m>.
   */
  variants?: number;
  /**
   * A ground's sparse details <sprite>/decal_1..decal_<decals>: transparent, drawn flat over
   * a few of its tiles (groundDecal).
   */
  decals?: number;
  /** Share of the tiles that show look 0 (default: MAIN_WEIGHT on a ground, even on an item). */
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
  /** Ambient particles the client spawns around it (ART-7, A13). */
  particles?: ParticleKind;
  /** A ground: what each step on it kicks up (MOV-7). */
  steps?: StepKind;
  /**
   * Lies flat on its tile's ground, inside the tile (spritepack sets it on every sprite under
   * borders/): drawn with the grounds, under the cast shadows, the items and the creatures.
   */
  flat?: true;
}

export type TileSync = "world" | "tile" | "random";

/**
 * Ambient particles (ART-7, client only): embers rise from lava and fires, pollen drifts
 * around trees, spray leaps where water meets another ground (a ground with `spray` emits
 * only on its edges), dust floats in caves.
 */
export const PARTICLE_KINDS = ["embers", "pollen", "spray", "dust"] as const;
export type ParticleKind = (typeof PARTICLE_KINDS)[number];

/**
 * What a step on a ground kicks up (docs/17 MOV-7, client only): a puff of dust on sand,
 * dirt or ash, a ripple where the ground is wet.
 */
export const STEP_KINDS = ["dust", "ripple"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** The textures (or images) of a sprite's tile art, resolved from its TileMeta. */
export interface TileArt<T> {
  base: T;
  /** Every look, the base first. */
  variants?: readonly T[];
  /** Share of look 0, when the atlas sets one (lookOf has the defaults). */
  weight?: number;
  /** A ground's decals (TileMeta decals), when it has them. */
  decals?: readonly T[];
  /** Every frame, the base first. */
  frames?: readonly T[];
  /** The frames of each animated look (index 0 is `frames`), the look itself first. */
  variantFrames?: readonly (readonly T[])[];
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
  /** Ambient particles around it (ART-7), if any. */
  particles?: ParticleKind;
  /** A decal on its tile's ground (TileMeta flat): drawn with the grounds. */
  flat?: true;
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
/** Frame m of look n of an animated item with looks (n = 0: the sprite's own frames). */
export const variantFrameName = (sprite: string, n: number, m: number): string =>
  n === 0 ? tileFrameName(sprite, m) : tileFrameName(variantName(sprite, n), m);
export const tileFrameName = (sprite: string, n: number): string => `${sprite}/frame_${n}`;
export const decalName = (sprite: string, n: number): string => `${sprite}/decal_${n}`;
export const wallName = (sprite: string, mask: number): string => `${sprite}/wall_${mask}`;
export const shadowName = (sprite: string): string => `${sprite}/shadow`;

/** A tile-art part's name: <base>/var_<n>, decal_<n>, frame_<n>, wall_<mask> or shadow. */
export const TILE_PART =
  /^(.+)\/(?:var_[1-9][0-9]*|decal_[1-9][0-9]*|frame_[1-9][0-9]*|wall_(?:[0-9]|1[0-5])|shadow)$/;

/**
 * Deterministic hash of a tile to [0, 1): the same tile always gets the same look and
 * phase, neighbours look unrelated.
 */
export function tileHash(x: number, y: number, z: number): number {
  return saltedHash(x, y, z, 0);
}

/**
 * tileHash on its own channel: each salt gives values unrelated to the others' (salt 0 is
 * tileHash), so the look, the decal and the noise of a tile do not follow one another.
 */
export function saltedHash(x: number, y: number, z: number, salt: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^
    Math.imul(y | 0, 0x165667b1) ^
    Math.imul(z | 0, 0x1b873593) ^
    Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---- ground variety (docs/17 ART-4) ------------------------------------------------------
// One tile repeated over a field reads as a grid. Three layers break it, all pure functions
// of the position, so the client, the editor and mapcli draw the same:
// - groundLook: which of its looks a tile shows. A slow noise (macroNoise) makes whole areas
//   lean to a run of neighbouring looks (a rippled stretch of beach, a coarse one) and to
//   more or fewer of them; two tiles side by side never show the same alternate look (the
//   looks of one parity go on the tiles of one colour of a checkerboard), diagonal ones
//   rarely do.
// - groundTone: a tint from another slow noise, so an area is a shade warmer or darker.
// - groundDecal: a sparse detail (a shell, a flower) on a few tiles, never two touching.

const SALT_BUSY = 101;
const SALT_WINDOW = 202;
const SALT_PICK = 303;
const SALT_TONE = 404;
const SALT_WARM = 505;
const SALT_DECAL = 606;
const SALT_DECAL_AREA = 707;
const SALT_DECAL_PICK = 808;

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * Smooth value noise of the position in [0, 1): random values on a lattice every `scale`
 * tiles, blended with a smoothstep. Two neighbouring tiles differ by at most 1.5 / scale.
 */
export function smoothNoise(x: number, y: number, z: number, scale: number, salt: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const sx = smooth(fx - ix);
  const sy = smooth(fy - iy);
  const a = saltedHash(ix, iy, z, salt);
  const b = saltedHash(ix + 1, iy, z, salt);
  const c = saltedHash(ix, iy + 1, z, salt);
  const d = saltedHash(ix + 1, iy + 1, z, salt);
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

/** Lattice spacings of the two octaves of macroNoise, tiles. */
export const MACRO_SCALE = 14;
export const MACRO_DETAIL_SCALE = 6;
const MACRO_STRETCH = 1.8;
/** The most macroNoise changes from a tile to its neighbour. */
export const MACRO_MAX_STEP = MACRO_STRETCH * 1.5 * (0.8 / MACRO_SCALE + 0.2 / MACRO_DETAIL_SCALE);

/**
 * Low-frequency noise of the position in [0, 1], spread out so it reaches both ends: areas
 * of a dozen tiles with a finer wobble on their edges. Neighbours differ by at most
 * MACRO_MAX_STEP.
 */
export function macroNoise(x: number, y: number, z: number, salt: number): number {
  const v =
    smoothNoise(x, y, z, MACRO_SCALE, salt) * 0.8 +
    smoothNoise(x, y, z, MACRO_DETAIL_SCALE, salt + 1) * 0.2;
  return Math.min(1, Math.max(0, (v - 0.5) * MACRO_STRETCH + 0.5));
}

/** Share of a ground's alternate looks one area draws from (the others show elsewhere). */
export const LOOK_WINDOW = 0.5;
/** How far the share of the main look swings between calm and busy areas (x0.5..x1.5). */
export const BUSY_SWING = 0.5;

/**
 * Whether tile (x, y) shows its main look, look 0: on a share `weight` of the tiles on
 * average, more in calm areas and fewer in busy ones.
 */
function showsMain(x: number, y: number, z: number, weight: number): boolean {
  const busy = macroNoise(x, y, z, SALT_BUSY);
  const w = Math.min(0.95, weight * (1 + BUSY_SWING * (1 - 2 * busy)));
  return tileHash(x, y, z) < w;
}

/**
 * The alternate looks (1..count-1) tile (x, y) may show: the ones of its area's window (a
 * run of neighbouring looks chosen by macroNoise) whose parity is the tile's colour on a
 * checkerboard; every look of that parity when the window has none.
 */
function candidates(x: number, y: number, z: number, count: number): number[] {
  const m = count - 1;
  const parity = (x + y) & 1;
  const size = Math.min(m, Math.max(2, Math.round(m * LOOK_WINDOW)));
  const start = Math.min(m - 1, Math.floor(macroNoise(x, y, z, SALT_WINDOW) * m));
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    const look = ((start + i) % m) + 1;
    if (((look - 1) & 1) === parity) out.push(look);
  }
  if (out.length > 0) return out;
  for (let look = 1; look <= m; look++) if (((look - 1) & 1) === parity) out.push(look);
  return out;
}

/**
 * Rows of alternate looks chain in bands of this many rows: the first row of a band takes
 * its first pick, each row below steps aside from the looks its upper diagonal neighbours
 * really show (the same function, one row up), so only the band's first row may repeat a
 * diagonal.
 */
export const LOOK_BAND = 8;

/** The alternate look of a tile that does not show its main one (see pickGroundLook). */
function alternateLook(
  x: number,
  y: number,
  z: number,
  count: number,
  weight: number,
  memo: Map<string, number>,
): number {
  const key = `${x},${y}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const c = candidates(x, y, z, count);
  const first = Math.floor(saltedHash(x, y, z, SALT_PICK) * c.length);
  let look = c[first] ?? 1;
  if ((y & (LOOK_BAND - 1)) !== 0 && c.length > 1) {
    const avoid: number[] = [];
    for (const dx of [-1, 1])
      if (!showsMain(x + dx, y - 1, z, weight))
        avoid.push(alternateLook(x + dx, y - 1, z, count, weight, memo));
    for (let i = 0; i < c.length; i++) {
      const k = c[(first + i) % c.length] as number;
      if (!avoid.includes(k)) {
        look = k;
        break;
      }
    }
  }
  memo.set(key, look);
  return look;
}

/**
 * Which of a ground's `count` looks tile (x, y, z) shows (docs/17 ART-4): look 0 on about a
 * share `weight` of the tiles, otherwise one of its area's alternate looks. Two tiles side
 * by side never share an alternate look (count >= 3), and a tile steps aside from the looks
 * of its upper diagonal neighbours when it has another (LOOK_BAND), so diagonals rarely
 * repeat either.
 */
export function pickGroundLook(
  x: number,
  y: number,
  z: number,
  count: number,
  weight = MAIN_WEIGHT,
): number {
  if (count <= 1 || showsMain(x, y, z, weight)) return 0;
  if (count === 2) return 1;
  return alternateLook(x, y, z, count, weight, new Map());
}

/** pickGroundLook for a ground's tile art (MAIN_WEIGHT unless the atlas sets its weight). */
export function groundLook(art: TileArt<unknown>, x: number, y: number, z: number): number {
  return pickGroundLook(x, y, z, art.variants?.length ?? 0, art.weight ?? MAIN_WEIGHT);
}

/** How much darker the darkest areas of groundTone are (the lightest keep their colour). */
export const TONE_DEPTH = 0.1;
/** How far an area leans warm (less blue) or cool (less red). */
export const TONE_WARMTH = 0.035;

/**
 * The tint (0xRRGGBB, no channel above 255) of the ground, its decal and the flat pieces of
 * tile (x, y, z): one slow noise of the position for all of them, so a fringe matches the
 * ground it comes from and the shade drifts over areas, never by a step between tiles.
 */
export function groundTone(x: number, y: number, z: number): number {
  const dark = 1 - TONE_DEPTH * macroNoise(x, y, z, SALT_TONE);
  const warm = macroNoise(x, y, z, SALT_WARM);
  const r = dark * (1 - TONE_WARMTH * (1 - warm));
  const b = dark * (1 - TONE_WARMTH * warm);
  const ch = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (ch(r) << 16) | (ch(dark) << 8) | ch(b);
}

/** Share of a ground's tiles with a decal, on average (more in some areas, fewer in others). */
export const DECAL_DENSITY = 0.05;

function decalSeed(x: number, y: number, z: number): boolean {
  const area = 0.3 + 1.4 * macroNoise(x, y, z, SALT_DECAL_AREA);
  return saltedHash(x, y, z, SALT_DECAL) < DECAL_DENSITY * area;
}

/**
 * Which of a ground's `count` decals tile (x, y, z) shows, or -1 for none: a few tiles by a
 * hash, more in some areas than in others, never two touching (a tile gives way to its left
 * and upper neighbours). The caller draws it only inside a field of its ground (the four
 * neighbours of the same ground), so no border covers half of it.
 */
export function groundDecal(x: number, y: number, z: number, count: number): number {
  if (count <= 0 || !decalSeed(x, y, z)) return -1;
  for (const [dx, dy] of [
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ] as const)
    if (decalSeed(x + dx, y + dy, z)) return -1;
  return Math.min(count - 1, Math.floor(saltedHash(x, y, z, SALT_DECAL_PICK) * count));
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
 * Which look a tile shows: a ground keeps its main look on a share `weight` of the tiles
 * (MAIN_WEIGHT unless the atlas says), an item's looks (border pieces) come up evenly, so a
 * long edge never repeats one shape (docs/17 ART-4). Every item of a tile gets the same look
 * number: a fringe and the surf over it keep the same shape.
 */
export function lookOf(art: TileArt<unknown>, hash: number, ground: boolean): number {
  const count = art.variants?.length ?? 0;
  if (count <= 1) return 0;
  return pickVariant(hash, count, art.weight ?? (ground ? MAIN_WEIGHT : 1 / count));
}

/** The frames look `look` plays: its own when it has them, else the sprite's. */
export function framesOfLook<T>(art: TileArt<T>, look: number): readonly T[] | undefined {
  return art.variantFrames?.[look] ?? art.frames;
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
    ms: meta.ms ?? DEFAULT_FRAME_MS,
    sync: meta.sync ?? "world",
    anchorX: meta.anchor === "bc" ? 0.5 : 1,
    joinsWalls: meta.wall === true || meta.joins === true,
    light: meta.light ?? 0,
  };
  if (meta.weight !== undefined) art.weight = meta.weight;
  if (meta.particles) art.particles = meta.particles;
  if (meta.flat) art.flat = true;
  if (meta.variants) {
    const v = list(meta.variants + 1, (n) => variantName(sprite, n));
    if (v.length > 1) art.variants = v;
  }
  if (meta.decals) {
    const d: T[] = [];
    for (let n = 1; n <= meta.decals; n++) {
      const t = lookup(decalName(sprite, n));
      if (t === undefined) break;
      d.push(t);
    }
    if (d.length > 0) art.decals = d;
  }
  if (meta.frames) {
    const f = list(meta.frames, (n) => tileFrameName(sprite, n));
    if (f.length > 1) art.frames = f;
    // Each look of an animated sprite plays its own frames (a look without them all stays
    // still: the base frames are of another shape).
    const looks = art.variants;
    if (art.frames && looks) {
      const all: T[][] = [[...art.frames]];
      for (let v = 1; v < looks.length; v++) {
        const own: T[] = [looks[v] as T];
        for (let m = 1; m < meta.frames; m++) {
          const t = lookup(variantFrameName(sprite, v, m));
          if (t === undefined) break;
          own.push(t);
        }
        all.push(own.length === art.frames.length ? own : [looks[v] as T]);
      }
      art.variantFrames = all;
    }
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

/** ART-8: what is stacked on raising items never rises more than this, sprite pixels. */
export const MAX_ELEVATION = 24;

/**
 * ART-8: how high item `index` of a stack is drawn (sprite pixels up): the elevation of the
 * items under it, summed and capped at MAX_ELEVATION. With index = stack.length, the height
 * a creature standing on the tile is drawn at.
 */
export function stackElevation(
  stack: readonly string[],
  index: number,
  elevationOf: (itemId: string) => number,
): number {
  let h = 0;
  const n = Math.min(index, stack.length);
  for (let i = 0; i < n && h < MAX_ELEVATION; i++) h += Math.max(0, elevationOf(stack[i] ?? ""));
  return Math.min(h, MAX_ELEVATION);
}

// ---- under a roof (docs/17 ART-5) ----------------------------------------------------------
// The map has no roofs: a building is a ring of walls with its floor open to the viewer. The
// sun's shadows do not fall in there, so the renderer needs to know which tiles are indoors:
// the ones walls (and what joins them: doors, gates) close off from the open ground. A
// doorway is a gap in a wall, and most buildings have one with no door in it (a temple, a
// shop): a gap of up to DOORWAY_TILES between two walls closes the room too.

/** A tile for indoorTiles: open ground, a wall (or what joins walls), or nothing known. */
export const CELL_OPEN = 0;
export const CELL_WALL = 1;
export const CELL_UNKNOWN = 2;
/** How far beyond a chunk's edge indoorTiles looks for the way out, tiles. */
export const INDOOR_REACH = 16;
/** The widest gap in a wall that is a doorway and not open ground, tiles. */
export const DOORWAY_TILES = 3;
/** Walled ground bigger than this is a courtyard under the sky, not a room, tiles. */
export const MAX_INDOOR_AREA = 400;

/**
 * Which tiles of a `size` x `size` chunk are indoors: index ly * size + lx -> 1, or null
 * when none is. `cell(x, y)` reads a tile in the chunk's local coordinates, from -reach to
 * size + reach - 1 (the neighbours' tiles). A tile is outdoors when open ground connects it
 * (by its four sides) to the edge of that window or to a tile nothing is known of; indoors
 * when walls close it in. A doorway closes it too, and is indoors itself: open tiles in a
 * straight gap of up to DOORWAY_TILES between two walls, unless both walls go on to the
 * same side (that is an alley between two buildings, not a gap in one wall). So a house, a
 * temple with its open doorway or a walled cellar is indoors; walled ground of more than
 * MAX_INDOOR_AREA tiles (a courtyard, a town inside its ramparts) is not; a room half known
 * (the edge of what the client has) counts as outdoors until its last wall is seen.
 */
export function indoorTiles(
  size: number,
  reach: number,
  cell: (x: number, y: number) => number,
): Uint8Array | null {
  const n = size + 2 * reach;
  const grid = new Uint8Array(n * n);
  let walls = false;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const c = cell(x - reach, y - reach);
      grid[y * n + x] = c;
      if (c === CELL_WALL) walls = true;
    }
  if (!walls) return null;
  const OUT = 3;
  const DOOR = 4;
  const isOpen = (c: number | undefined): boolean => c === CELL_OPEN || c === DOOR;
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= n || y >= n ? CELL_UNKNOWN : (grid[y * n + x] as number);
  // The doorways: runs of open tiles between two walls, along either axis.
  for (let axis = 0; axis < 2; axis++) {
    const dx = axis === 0 ? 1 : 0;
    const dy = 1 - dx;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        // The first open tile after a wall.
        if (!isOpen(at(x, y)) || at(x - dx, y - dy) !== CELL_WALL) continue;
        let len = 1;
        while (len <= DOORWAY_TILES && isOpen(at(x + len * dx, y + len * dy))) len++;
        const bx = x + len * dx;
        const by = y + len * dy;
        if (len > DOORWAY_TILES || at(bx, by) !== CELL_WALL) continue;
        const ax = x - dx;
        const ay = y - dy;
        // Both walls going on to the same side: a corridor between two walls.
        if (
          (at(ax + dy, ay + dx) === CELL_WALL && at(bx + dy, by + dx) === CELL_WALL) ||
          (at(ax - dy, ay - dx) === CELL_WALL && at(bx - dy, by - dx) === CELL_WALL)
        )
          continue;
        for (let k = 0; k < len; k++) grid[(y + k * dy) * n + x + k * dx] = DOOR;
      }
  }
  // Flood the outdoors: OUT marks an open tile the open ground reaches.
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;
  const seed = (i: number): void => {
    if (grid[i] !== CELL_OPEN) return;
    grid[i] = OUT;
    queue[tail++] = i;
  };
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (grid[i] === CELL_UNKNOWN) {
        if (x > 0) seed(i - 1);
        if (x < n - 1) seed(i + 1);
        if (y > 0) seed(i - n);
        if (y < n - 1) seed(i + n);
      } else if (x === 0 || y === 0 || x === n - 1 || y === n - 1) seed(i);
    }
  const spread = (i: number, into: (j: number) => void): void => {
    const x = i % n;
    if (x > 0) into(i - 1);
    if (x < n - 1) into(i + 1);
    if (i >= n) into(i - n);
    if (i < n * (n - 1)) into(i + n);
  };
  while (head < tail) spread(queue[head++] as number, seed);
  // What is left is walled in, room by room: IN marks the rooms, OUT the courtyards. A
  // doorway on the window's edge or by an unknown tile belongs to no room.
  const IN = 5;
  const SEEN = 6;
  const join = (i: number): void => {
    if (!isOpen(grid[i])) return;
    grid[i] = SEEN;
    queue[tail++] = i;
  };
  for (let i = 0; i < grid.length; i++) {
    if (!isOpen(grid[i])) continue;
    const first = (tail = head = 0);
    join(i);
    while (head < tail) spread(queue[head++] as number, join);
    const room = tail - first <= MAX_INDOOR_AREA ? IN : OUT;
    for (let k = first; k < tail; k++) grid[queue[k] as number] = room;
  }
  let out: Uint8Array | null = null;
  for (let ly = 0; ly < size; ly++)
    for (let lx = 0; lx < size; lx++) {
      if (grid[(ly + reach) * n + lx + reach] !== IN) continue;
      out ??= new Uint8Array(size * size);
      out[ly * size + lx] = 1;
    }
  return out;
}
