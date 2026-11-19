// Draws the ground transitions of data/borders.yaml (docs/06 "Bordes", docs/17 ART-4) into
// assets/sprites/borders/: for every ground of the ladder with a fringe, its twelve pieces
// (borders/<ground>/<piece>), each in LOOKS looks (the sprite and <piece>/var_<n>), cut from
// the ground's own art (tools/spritegen) with an irregular edge drawn in its style; and the
// surf (borders/surf/<piece>) that goes under the fringes on water, in the same looks, with
// its foam rolling in over SURF_FRAMES frames (<piece>/frame_<n>, <piece>/var_<n>/frame_<m>).
//
// Shapes are shared by every ground: look k of piece p covers the same pixels whatever the
// ground, so the surf under a fringe follows its edge. Every look of every piece crosses each
// side of the tile at a fixed point, CROSS px from the corner on the higher ground's side, and
// nothing but the ground itself touches a side of the tile (decorations stay MARGIN px in):
// any look meets any look of its neighbours without a step. Inside, each look's edge bends
// with its own bumps (1-6 px), so a long edge never repeats. The renderer picks the look per
// tile (tileHash, docs/17 ART-4), the same number for every piece of a tile.
// Deterministic: same input, same bytes. Re-run it (`make borders`) when data/borders.yaml or
// a ground's art changes.
//   node --experimental-strip-types tools/spritepack/src/gen-borders.ts [--root DIR]
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { createImage, decodePng, encodePng } from "./image.ts";
import type { Image, Rgba } from "./image.ts";
import { parseManifest } from "./manifest.ts";
import type { SpriteEntry } from "./manifest.ts";

const T = 32;
/** Where every edge crosses a side of the tile: this many px from the higher ground's corner. */
export const CROSS = 10;
/** How far a look's edge reaches past CROSS into the lower ground, and how far it pulls back. */
export const MAX_IN = 6;
export const MAX_OUT = 4;
/** Opposite sides of a tile always leave this many px of it between their edges. */
export const MIN_GAP = 10;
/** Biggest step of an edge from one pixel to the next along a side. */
export const MAX_STEP = 2;
/** Looks of every piece: the sprite and var_1..var_<LOOKS - 1>. */
export const LOOKS = 4;
/** Decorations (tufts, pebbles, grains) stay this many px away from the sides of the tile. */
export const MARGIN = 2;

export const SIDES = ["n", "e", "s", "w"] as const;
export const CORNERS = ["nw", "ne", "se", "sw"] as const;
export type Side = (typeof SIDES)[number];
export type Corner = (typeof CORNERS)[number];
export type Piece = Side | Corner | `inner_${Corner}`;
/** The twelve pieces, in the order of BORDER_PIECES (@rpg/map-format ops). */
export const PIECES: readonly Piece[] = [
  ...SIDES,
  ...CORNERS,
  ...CORNERS.map((c) => `inner_${c}` as const),
];

/** How a fringe's edge is drawn (EDGE_STYLES of @rpg/map-format ops, data/borders.yaml). */
export type EdgeStyle =
  "plain" | "tufts" | "pebbles" | "clods" | "joint" | "wet" | "crust" | "drift";

function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small seeded generator, the same numbers on every machine. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hash of a pixel to [0, 1). */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const profiles = new Map<string, readonly number[]>();

/** Pinned at CROSS on both ends, no step over MAX_STEP, within its range: clamp until stable. */
function settle(p: number[]): void {
  for (let pass = 0; pass < 32; pass++) {
    const before = p.join();
    p[0] = CROSS;
    p[T - 1] = CROSS;
    for (let t = 0; t < T; t++)
      p[t] = Math.max(CROSS - MAX_OUT, Math.min(CROSS + MAX_IN, p[t] as number));
    for (let t = 1; t < T - 1; t++) {
      const prev = p[t - 1] as number;
      p[t] = Math.max(prev - MAX_STEP, Math.min(prev + MAX_STEP, p[t] as number));
    }
    for (let t = T - 2; t > 0; t--) {
      const next = p[t + 1] as number;
      p[t] = Math.max(next - MAX_STEP, Math.min(next + MAX_STEP, p[t] as number));
    }
    if (p.join() === before) return;
  }
}

/** One side's edge before it meets the opposite side's: a swell, bumps and a ragged pixel or two. */
function rawProfile(side: Side, look: number): number[] {
  const rand = random(seedOf(`border-edge/${side}/${look}`));
  const f = new Array<number>(T).fill(0);
  const swell = -1 + rand() * 3.5;
  for (let t = 0; t < T; t++) f[t] = swell * Math.sin((Math.PI * t) / (T - 1));
  const bumps = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < bumps; i++) {
    const back = rand() < 0.3;
    const amp = back ? -(1 + rand() * 2) : 1.5 + rand() * 4.5;
    const w = Math.max(3, Math.abs(amp)) + rand() * 4;
    // Anywhere along the side: near an end, settle() ramps it down to CROSS.
    const c = 1 + rand() * (T - 3);
    for (let t = 0; t < T; t++)
      if (Math.abs(t - c) < w)
        f[t] = (f[t] as number) + amp * 0.5 * (1 + Math.cos((Math.PI * (t - c)) / w));
  }
  const p = f.map((v) => CROSS + Math.round(v));
  // Ragged pixels: about one in five moves a pixel in or out.
  for (let t = 2; t < T - 2; t++) {
    const h = rand();
    if (h < 0.1) p[t] = (p[t] as number) + 1;
    else if (h < 0.2) p[t] = (p[t] as number) - 1;
  }
  settle(p);
  return p;
}

/**
 * How deep the edge of a side piece reaches into the tile (px from the side the higher ground
 * is on), at each of the 32 pixels along that side, in look `look`. CROSS at both ends;
 * inside, a gentle swell, two or three bumps (most reach further in, some pull back) and
 * ragged pixels, within CROSS - MAX_OUT..CROSS + MAX_IN, never more than MAX_STEP from one
 * pixel to the next. Opposite sides of a look leave MIN_GAP px between them: a path one tile
 * wide with the higher ground on both sides is never pinched shut.
 */
export function profile(side: Side, look: number): readonly number[] {
  const key = `${side}/${look}`;
  const known = profiles.get(key);
  if (known) return known;
  for (const [a, b] of [
    ["n", "s"],
    ["w", "e"],
  ] as const) {
    const pa = rawProfile(a, look);
    const pb = rawProfile(b, look);
    for (let pass = 0; pass < 32; pass++) {
      let over = false;
      for (let t = 0; t < T; t++) {
        const excess = (pa[t] as number) + (pb[t] as number) - (T - MIN_GAP);
        if (excess <= 0) continue;
        over = true;
        const cut = Math.ceil(excess / 2);
        pa[t] = (pa[t] as number) - cut;
        pb[t] = (pb[t] as number) - (excess - cut);
      }
      settle(pa);
      settle(pb);
      if (!over) break;
    }
    profiles.set(`${a}/${look}`, pa);
    profiles.set(`${b}/${look}`, pb);
  }
  return profiles.get(key) as readonly number[];
}

/** Distance of (x, y) from the sides of a corner: u from its west or east side, v from its north or south. */
function fromCorner(corner: Corner, x: number, y: number): [number, number] {
  return [corner.includes("e") ? T - 1 - x : x, corner.includes("s") ? T - 1 - y : y];
}

/** Whether pixel (x, y) is under the higher ground in look `look` of `piece`. */
export function covered(piece: Piece, look: number, x: number, y: number): boolean {
  const side = (s: Side): boolean => {
    const p = profile(s, look);
    if (s === "n") return y < (p[x] as number);
    if (s === "s") return T - 1 - y < (p[x] as number);
    if (s === "w") return x < (p[y] as number);
    return T - 1 - x < (p[y] as number);
  };
  if (piece.length === 1) return side(piece as Side);
  if (piece.startsWith("inner_")) {
    const c = piece.slice(6) as Corner;
    if (side(c[0] as Side) || side(c[1] as Side)) return true;
    // The concave corner: everything but a quarter disc around the far corner of the tile,
    // of radius T - CROSS, so its arc leaves the two far sides at CROSS (where the strips
    // of the neighbours cross them) and a staircase of tiles reads as a wavy diagonal. Its
    // radius bends inside like an outer corner's.
    const rand = random(seedOf(`border-inner/${c}/${look}`));
    const bulge = rand() * 6;
    const [u, v] = fromCorner(c, x, y);
    const fu = T - (u + 0.5);
    const fv = T - (v + 0.5);
    const s2 = Math.sin(2 * Math.atan2(fv, fu)) ** 2;
    return Math.hypot(fu, fv) > T - CROSS - s2 * bulge;
  }
  // An outer corner: a quarter disc around the corner whose radius bends inside, CROSS on
  // both sides of the tile (sin² of 2θ is 0 there).
  const rand = random(seedOf(`border-corner/${piece}/${look}`));
  const a1 = rand() * 6;
  const a2 = -2 + rand() * 4;
  const [u, v] = fromCorner(piece as Corner, x, y);
  const theta = Math.atan2(v + 0.5, u + 0.5);
  const s2 = Math.sin(2 * theta) ** 2;
  const r = Math.max(CROSS - 3, CROSS + 0.25 + s2 * (a1 + a2 * Math.cos(2 * theta)));
  return Math.hypot(u + 0.5, v + 0.5) < r;
}

/** The pixels a look of a piece covers, row-major. */
export function coverMask(piece: Piece, look: number): Uint8Array {
  const m = new Uint8Array(T * T);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) m[y * T + x] = covered(piece, look, x, y) ? 1 : 0;
  return m;
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * 4-neighbour steps inside the tile to the nearest pixel of the other kind, up to `cap`:
 * for a covered pixel, how far in from the edge it is (1 = the rim); for an uncovered one,
 * how far out (1 = right outside the edge). `cap` + 1 when further.
 */
function edgeDistance(mask: Uint8Array, cap: number): Uint8Array {
  const d = new Uint8Array(T * T).fill(cap + 1);
  const frontier: number[] = [];
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const i = y * T + x;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= T || ny >= T) continue;
        if (mask[ny * T + nx] !== mask[i]) {
          d[i] = 1;
          frontier.push(i);
          break;
        }
      }
    }
  for (let step = 2; step <= cap; step++) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % T;
      const y = (i - x) / T;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= T || ny >= T) continue;
        const j = ny * T + nx;
        if (mask[j] === mask[i] && (d[j] as number) > step) {
          d[j] = step;
          next.push(j);
        }
      }
    }
    frontier.splice(0, frontier.length, ...next);
  }
  return d;
}

/** The colour of a ground at pixel (x, y) of a tile. */
export type Fill = (x: number, y: number) => Rgba;

/** A ground's art for its fringe: its pixels, and its tones from darkest to lightest. */
export interface GroundArt {
  fill: Fill;
  tones: readonly Rgba[];
}

const lum = (c: Rgba): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** A ground's art from its fill: the distinct colours of its tile, darkest first. */
export function groundArt(fill: Fill): GroundArt {
  const seen = new Map<string, Rgba>();
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const c = fill(x, y);
      seen.set(`${c[0]},${c[1]},${c[2]}`, [c[0], c[1], c[2], 255]);
    }
  const tones = [...seen.values()].sort((a, b) => lum(a) - lum(b) || a[0] - b[0] || a[2] - b[2]);
  return { fill, tones };
}

const shade = (c: Rgba, k: number): Rgba => [
  Math.round(c[0] * k),
  Math.round(c[1] * k),
  Math.round(c[2] * k),
  255,
];

/** Grey stones by an edge (the pebbles of the sand's looks, tools/spritegen ground.ts). */
export const PEBBLE: readonly Rgba[] = [
  [59, 58, 56, 255],
  [91, 88, 83, 255],
  [119, 115, 106, 255],
];

/**
 * How each style shades the rim (the pixels right at the edge) and the next row in: a factor,
 * the ground's darkest tone (a joint) or its second lightest (the lit lip of a crust).
 */
const RIM: Record<EdgeStyle, readonly [number | "darkest" | "lip", number]> = {
  plain: [0.8, 1],
  tufts: [0.82, 1],
  pebbles: [0.85, 1],
  clods: [0.8, 1],
  joint: ["darkest", 0.92],
  wet: [0.75, 0.88],
  crust: ["lip", 0.85],
  drift: [0.9, 1],
};

/**
 * One look of one piece of a ground's fringe: the ground where the look covers the tile, its
 * rim darker as the style says, and the style's marks by the edge (never within MARGIN of a
 * side): tufts of blades standing over the lower ground, pebbles, clods, chips of stone or
 * loose grains.
 */
export function fringeSprite(
  piece: Piece,
  look: number,
  ground: GroundArt,
  style: EdgeStyle,
  seed = 0,
): Image {
  const img = createImage(T, T);
  const mask = coverMask(piece, look);
  const dist = edgeDistance(mask, 3);
  const { tones } = ground;
  const darkest = tones[0] as Rgba;
  const lightest = tones[tones.length - 1] as Rgba;
  const light = tones[Math.max(0, tones.length - 2)] as Rgba;
  const mid = tones[Math.floor(tones.length / 2)] as Rgba;
  const set = (x: number, y: number, c: Rgba): void => {
    if (x < MARGIN || y < MARGIN || x >= T - MARGIN || y >= T - MARGIN) return;
    img.data.set(c, (y * T + x) * 4);
  };
  const [rim1, rim2] = RIM[style];
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const i = y * T + x;
      if (!mask[i]) continue;
      const c = ground.fill(x, y);
      const d = dist[i];
      const out =
        d === 1
          ? rim1 === "darkest"
            ? darkest
            : rim1 === "lip"
              ? light
              : shade(c, rim1)
          : d === 2 && rim2 !== 1
            ? shade(c, rim2)
            : c;
      img.data.set([out[0], out[1], out[2], 255], i * 4);
    }
  const s = seedOf(`border-marks/${style}/${piece}/${look}`) ^ seed;
  const placed: [number, number][] = [];
  const free = (x: number, y: number, gap: number): boolean =>
    placed.every(([px, py]) => Math.max(Math.abs(px - x), Math.abs(py - y)) > gap);
  const outside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < T && y < T && !mask[y * T + x];
  for (let y = MARGIN; y < T - MARGIN; y++)
    for (let x = MARGIN; x < T - MARGIN; x++) {
      const i = y * T + x;
      if (mask[i]) continue;
      const d = dist[i];
      const h = hash2(x, y, s);
      const h2 = hash2(x, y, s + 1);
      if (style === "tufts" && d === 1 && h < 0.34 && free(x, y, 2)) {
        // One to three blades: lit tips, the body a step darker, a dark foot on the ground.
        const blades = h2 < 0.4 ? 1 : h2 < 0.8 ? 2 : 3;
        for (let b = 0; b < blades; b++) {
          const bx = x + ([0, -1, 1][b] as number);
          const tall = 2 + (hash2(bx, y, s + 2) < 0.35 ? 1 : 0) - (b > 0 ? 1 : 0);
          for (let k = 0; k < tall; k++) set(bx, y - k, k === tall - 1 ? lightest : light);
          if (outside(bx, y + 1)) set(bx, y + 1, darkest);
        }
        placed.push([x, y]);
      } else if (
        style === "pebbles" &&
        ((d === 1 && h < 0.11) || (d === 2 && h < 0.05)) &&
        free(x, y, 3)
      ) {
        const wide = h2 < 0.45;
        set(x, y, PEBBLE[2] as Rgba);
        if (wide) set(x + 1, y, PEBBLE[1] as Rgba);
        for (const dx of wide ? [0, 1] : [0])
          if (outside(x + dx, y + 1)) set(x + dx, y + 1, PEBBLE[0] as Rgba);
        placed.push([x, y]);
      } else if (style === "clods" && d === 1 && h < 0.15 && free(x, y, 3)) {
        set(x, y, lightest);
        set(x + 1, y, light);
        if (outside(x, y + 1)) set(x, y + 1, darkest);
        placed.push([x, y]);
      } else if (style === "joint" && d === 1 && h < 0.06 && free(x, y, 4)) {
        set(x, y, mid);
        if (outside(x, y + 1)) set(x, y + 1, darkest);
        placed.push([x, y]);
      } else if (style === "drift" && ((d === 1 && h < 0.26) || (d === 2 && h < 0.09))) {
        set(x, y, tones[1 + Math.floor(h2 * (tones.length - 1))] as Rgba);
      }
    }
  return img;
}

/** Foam along a shore: the bright line by the edge, and the fainter surf further out. */
export const FOAM: readonly Rgba[] = [
  [168, 198, 210, 255],
  [92, 132, 156, 255],
];
/** The wet edge of the land, right where the water starts: two dark wet-sand tones. */
export const WET: readonly Rgba[] = [
  [79, 68, 51, 255],
  [89, 77, 58, 255],
];

/**
 * The surf, frame by frame: how far out of the bright line (px) its broken line runs, or 0 for
 * the wash, when the wave has reached the shore and the faint foam lies solid by the bright
 * line. Frame 0 is the still look (the editor, mapcli render, icons); then the wash, and a
 * new wave that comes in from 3 px out.
 */
export const SURF: readonly number[] = [1, 0, 3, 2];
export const SURF_FRAMES = SURF.length;
/** How far out of the edge the surf reaches, px. */
export const SURF_REACH = 5;
/** The broken line: dashes of 5 px with gaps of 3, along any edge, seamless tile to tile. */
const dash = (x: number, y: number): boolean => (x + y) % 8 < 5;

/**
 * One frame of one look of a surf piece. Everything is on the water side of the look's edge:
 * the wet edge of the land (1 px, in patches of two tones), the bright line of foam, and the
 * broken line out at SURF[frame] past it. The surf goes under the fringes of its tile (the
 * autoborder puts it first), so where two fringes overlap, the foam of one never shows on the
 * land of the other.
 */
export function surfSprite(piece: Piece, look: number, frame = 0): Image {
  const img = createImage(T, T);
  const mask = coverMask(piece, look);
  const dist = edgeDistance(mask, SURF_REACH);
  const surf = SURF[frame % SURF_FRAMES] as number;
  const s = seedOf(`border-wet/${piece}/${look}`);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const i = y * T + x;
      if (mask[i]) continue;
      const d = dist[i];
      let c: Rgba | undefined;
      if (d === 1) c = WET[hash2(x >> 1, y >> 1, s) < 0.5 ? 0 : 1];
      else if (d === 2) c = FOAM[0];
      else if ((surf === 0 && d === 3) || (surf > 0 && d === surf + 2 && dash(x, y))) c = FOAM[1];
      if (c) img.data.set(c, i * 4);
    }
  return img;
}

/** data/borders.yaml as gen-borders reads it. */
interface Ladder {
  ladder?: { ground: string; pieces?: string; edge?: EdgeStyle }[];
  shore?: { water: string[]; pieces: string };
}

/** The sprite of look `look` of a piece (look 0 is the piece's own sprite). */
export const lookSprite = (sprite: string, look: number): string =>
  look === 0 ? sprite : `${sprite}/var_${look}`;

/** Every border sprite of data/borders.yaml: sprite path → PNG bytes. */
export function borderSprites(root: string): Map<string, Buffer> {
  const set = parse(readFileSync(join(root, "data/borders.yaml"), "utf8")) as Ladder;
  const items = new Map<string, string>();
  for (const f of readdirSync(join(root, "data/items"))
    .filter((n) => n.endsWith(".yaml"))
    .sort()) {
    const list = parse(readFileSync(join(root, "data/items", f), "utf8")) as {
      id: string;
      sprite?: string;
    }[];
    for (const i of list ?? []) if (i.sprite) items.set(i.id, i.sprite);
  }
  const { manifest } = parseManifest(readFileSync(join(root, "assets/sprites.yaml"), "utf8"));
  const spriteOf = (item: string): string => {
    const sprite = items.get(item);
    if (!sprite) throw new Error(`border piece "${item}" is not in data/items`);
    return sprite;
  };
  const out = new Map<string, Buffer>();
  for (const step of set.ladder ?? []) {
    if (!step.pieces) continue;
    const groundSprite = items.get(step.ground);
    const entry = groundSprite ? manifest.sprites.get(groundSprite) : undefined;
    const art = groundArt(groundFill(root, entry, groundSprite));
    for (const piece of PIECES) {
      const sprite = spriteOf(`${step.pieces}_${piece}`);
      for (let look = 0; look < LOOKS; look++)
        out.set(
          lookSprite(sprite, look),
          encodePng(fringeSprite(piece, look, art, step.edge ?? "plain", seedOf(step.ground))),
        );
    }
  }
  if (set.shore)
    for (const piece of PIECES) {
      const sprite = spriteOf(`${set.shore.pieces}_${piece}`);
      for (let look = 0; look < LOOKS; look++)
        for (let f = 0; f < SURF_FRAMES; f++) {
          const name =
            f === 0 ? lookSprite(sprite, look) : `${lookSprite(sprite, look)}/frame_${f}`;
          out.set(name, encodePng(surfSprite(piece, look, f)));
        }
    }
  return out;
}

/**
 * The pixels of a ground: its own art (assets/sprites/<sprite>.png, e.g. drawn by
 * tools/spritegen), else the top-left tile of its pack image, else its placeholder colour.
 * Run tools/spritegen before this when a ground's recipe changes.
 */
function groundFill(root: string, entry: SpriteEntry | undefined, sprite?: string): Fill {
  const own = sprite ? join(root, "assets/sprites", `${sprite}.png`) : undefined;
  if (entry?.kind === "source" || (own && existsSync(own))) {
    const file = entry?.kind === "source" ? join(root, "assets", entry.source) : (own as string);
    const src = decodePng(readFileSync(file));
    const ox = entry?.kind === "source" ? (entry.rect?.x ?? 0) : 0;
    const oy = entry?.kind === "source" ? (entry.rect?.y ?? 0) : 0;
    return (x, y) => {
      const i = ((oy + y) * src.width + ox + x) * 4;
      return [src.data[i] ?? 0, src.data[i + 1] ?? 0, src.data[i + 2] ?? 0, 255];
    };
  }
  const color: Rgba =
    entry?.kind === "placeholder" && entry.color ? entry.color : [128, 128, 128, 255];
  return () => color;
}

/** Every PNG under a folder, as sprite paths relative to `base`. */
export function pngsUnder(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...pngsUnder(p, base));
    else if (e.name.endsWith(".png")) out.push(relative(base, p).replace(/\\/g, "/").slice(0, -4));
  }
  return out.sort();
}

function main(): void {
  const { values } = parseArgs({ options: { root: { type: "string", default: "." } } });
  const root = resolve(values.root);
  const sprites = borderSprites(root);
  const base = join(root, "assets/sprites");
  let removed = 0;
  for (const old of pngsUnder(join(base, "borders"), base))
    if (!sprites.has(old)) {
      rmSync(join(base, `${old}.png`));
      removed++;
    }
  for (const [sprite, png] of sprites) {
    const file = join(base, `${sprite}.png`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, png);
  }
  // Folders the old pieces left empty.
  const prune = (dir: string): boolean => {
    let empty = true;
    for (const e of readdirSync(dir, { withFileTypes: true }))
      if (!e.isDirectory() || !prune(join(dir, e.name))) empty = false;
    if (empty && dir !== join(base, "borders")) rmSync(dir, { recursive: true });
    return empty;
  };
  prune(join(base, "borders"));
  console.log(`wrote ${sprites.size} border sprites, removed ${removed} old ones`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ""))) main();
