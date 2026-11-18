// Walls with height (docs/17 ART-3): each wall material has 16 pieces of 32x64,
// <sprite>/wall_<mask>, one per set of wall neighbours (N=1, E=2, S=4, W=8), that the renderer
// puts on each wall tile (packages/renderer tile-art.ts). A piece is the wall's top, lifted
// 32 px (one tile: it covers the tile behind the wall), over its south face, 32 px tall.
// - Built walls (stone, wood) are thin (BAND): an east-west wall stands along the south edge
//   of its tile, so its face fills its own tile and its top only the last 10 rows of the
//   tile behind it (what stands there stays mostly in sight); a north-south run is a narrow
//   strip of tops down the middle of its tiles, with ground on both sides. Where a wall goes
//   on south, its face stops and the next piece's top shows: corners and T-joins read as in
//   a real 3/4 view.
// - Rock (cave walls, ore veins) is a block (BLOCK): the whole width of the tile and its
//   southern 20 rows, a rough top and a cliff face that only shows where no rock is south.
// Light comes from the top-left (ART-5): the top is the lightest surface with a lit rim on
// its north and west edges, the face is darker, shadows lean to blue-violet. The sprite
// itself (walls/<material>) is the east-west piece, for icons and the editor's palette.
import type { Image, Rgba } from "@rpg/spritepack";
import { hash2, opaque, outline, px, tileNoise } from "../draw.ts";
import type { Rng } from "../draw.ts";
import { hex, mix } from "../palette.ts";
import type { Recipe, RecipeBook } from "../recipe.ts";

export const WALL_N = 1;
export const WALL_E = 2;
export const WALL_S = 4;
export const WALL_W = 8;
/** The east-west piece: the sprite a wall item shows outside the map (icons, palette). */
export const ICON_MASK = WALL_E | WALL_W;
/** Height of a wall's face, px: one tile. */
export const FACE = 32;
/**
 * Where a wall stands on its tile, px [from, to): x, the columns of a north-south arm; y, the
 * rows of an east-west arm (always up to the south edge, so the face fills the tile).
 */
export interface Footprint {
  x: readonly [number, number];
  y: readonly [number, number];
}
export const BAND: Footprint = { x: [11, 21], y: [22, 32] };
export const BLOCK: Footprint = { x: [0, 32], y: [12, 32] };

/** Where a pixel of the top is, relative to the edges of the wall's shape (px, capped). */
export interface TopEdges {
  /** Distance to the edge in each direction: 1 = the edge pixel itself. */
  n: number;
  e: number;
  s: number;
  w: number;
}

/** Where a pixel of the face is. */
export interface FaceSpot {
  /** Column in the tile (0..31) and row from the top of the face (0..FACE-1). */
  x: number;
  r: number;
  /** Columns to the face's left and right ends (1 = the end column itself), capped. */
  left: number;
  right: number;
}

export interface WallStyle {
  band: Footprint;
  /** Colour of the top at ground pixel (x, y) of the tile. */
  top(x: number, y: number, edges: TopEdges, seed: number): Rgba;
  /** Colour of the face. */
  face(spot: FaceSpot, seed: number): Rgba;
}

const CAP = 4;

/** Which part of a thin wall's band ground pixel (x, y) is in: an east-west arm, a
 * north-south arm, or the centre. */
function armOf(x: number, y: number): "h" | "v" | "c" {
  const inX = x >= BAND.x[0] && x < BAND.x[1];
  const inY = y >= BAND.y[0] && y < BAND.y[1];
  return inX && inY ? "c" : inY ? "h" : "v";
}

/** Whether ground pixel (x, y), which may be just outside the tile, is under the wall. */
export function inShape(mask: number, band: Footprint, x: number, y: number): boolean {
  const inX = x >= band.x[0] && x < band.x[1];
  const inY = y >= band.y[0] && y < band.y[1];
  if (x < 0) return (mask & WALL_W) !== 0 && inY;
  if (x > 31) return (mask & WALL_E) !== 0 && inY;
  if (y < 0) return (mask & WALL_N) !== 0 && inX;
  if (y > 31) return (mask & WALL_S) !== 0 && inX;
  if (inX && inY) return true;
  if (inX) return (mask & (y < band.y[0] ? WALL_N : WALL_S)) !== 0;
  if (inY) return (mask & (x < band.x[0] ? WALL_W : WALL_E)) !== 0;
  return false;
}

/** The ground row of the south edge of the wall in column x, or -1 (no face there). */
export function southEdge(mask: number, band: Footprint, x: number): number {
  for (let y = 31; y >= 0; y--) {
    if (!inShape(mask, band, x, y)) continue;
    return inShape(mask, band, x, y + 1) ? -1 : y;
  }
  return -1;
}

/** Whether column x (may be -1 or 32, the neighbour's) has a face. */
function hasFace(mask: number, band: Footprint, x: number): boolean {
  if (x < 0) return (mask & WALL_W) !== 0;
  if (x > 31) return (mask & WALL_E) !== 0;
  return southEdge(mask, band, x) >= 0;
}

/** Draws piece `mask` of a style into a 32x64 image. */
export function drawPiece(img: Image, style: WallStyle, mask: number, seed: number): void {
  const { band } = style;
  const dist = (x: number, y: number, dx: number, dy: number): number => {
    let d = 1;
    while (d < CAP && inShape(mask, band, x + dx * d, y + dy * d)) d++;
    return d;
  };
  // The face first, then the top over it (they never overlap, but the top wins anyway).
  for (let x = 0; x < 32; x++) {
    const edge = southEdge(mask, band, x);
    if (edge < 0) continue;
    let left = 1;
    while (left < CAP && hasFace(mask, band, x - left)) left++;
    let right = 1;
    while (right < CAP && hasFace(mask, band, x + right)) right++;
    for (let r = 0; r < FACE; r++)
      px(img, x, edge + 1 + r, style.face({ x, r, left, right }, seed));
  }
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      if (!inShape(mask, band, x, y)) continue;
      const edges = {
        n: dist(x, y, 0, -1),
        e: dist(x, y, 1, 0),
        s: dist(x, y, 0, 1),
        w: dist(x, y, -1, 0),
      };
      px(img, x, y, style.top(x, y, edges, seed));
    }
  // A dark outline where the wall meets the open air, never at a seam with a neighbour.
  outline(img, { amount: 0.42, edges: false });
  // The foot of a block's face is on the image's bottom border: give it its contact line.
  for (let x = 0; x < 32; x++)
    if (opaque(img, x, 63) && southEdge(mask, band, x) === 31) px(img, x, 63, CONTACT);
}

const CONTACT = hex("#1c1a1f");

/** Rgba from a level in [0, 1] over a ramp of colours, darkest first. */
function ramp(colors: readonly Rgba[], level: number): Rgba {
  const i = Math.max(0, Math.min(colors.length - 1, Math.floor(level * colors.length)));
  return colors[i] as Rgba;
}

// ---- cut stone (towns, temples) -----------------------------------------------------------

const STONE_TOP = ["#4f4c4c", "#615d59", "#726d66", "#837d73"].map(hex);
const STONE_RIM = hex("#9a9284");
const STONE_LIP = hex("#948c7f");
const STONE_FACE = ["#4d4a4f", "#5b5856", "#68645e", "#757068"].map(hex);
const STONE_LIT = hex("#88827a");
const STONE_MORTAR = hex("#302d33");
const STONE_UNDER = hex("#2a2830");

/** Rows of ashlar blocks on the face: joints (x, per 32 px) of each 8 px course. */
const COURSES: readonly (readonly number[])[] = [
  [0, 13, 22],
  [6, 17, 28],
  [2, 11, 24],
  [8, 19, 29],
];

function courseBlock(x: number, k: number): { id: number; from: number; to: number } {
  const joints = COURSES[k % COURSES.length] ?? [0];
  let from = (joints[joints.length - 1] ?? 0) - 32;
  let to = joints[0] ?? 0;
  let id = joints.length - 1;
  for (let i = 0; i < joints.length; i++) {
    const j = joints[i] ?? 0;
    if (x >= j) {
      from = j;
      to = joints[i + 1] ?? (joints[0] ?? 0) + 32;
      id = i;
    }
  }
  return { id: k * 8 + id, from, to };
}

export const STONE: WallStyle = {
  band: BAND,
  top(x, y, e, seed) {
    if (e.s === 1) return STONE_LIP; // the lit edge above the face
    let level = 0.55 + (tileNoise(x, y, 4, 4, seed) - 0.5) * 0.35;
    if (e.n <= 2 || e.w <= 2) level += 0.3;
    if (e.e <= 2 || e.s <= 2) level -= 0.25;
    // Coping slabs: a joint every 8 px along an arm of the wall.
    const arm = armOf(x, y);
    if ((arm === "h" && x % 8 === 4) || (arm === "v" && y % 8 === 4)) level -= 0.3;
    if (level > 0.95 && (e.n === 2 || e.w === 2)) return STONE_RIM;
    return ramp(STONE_TOP, level);
  },
  face({ x, r, left, right }, seed) {
    if (r === 0) return STONE_UNDER; // shadow under the coping
    const k = Math.floor((r - 1) / 8);
    const yy = (r - 1) % 8;
    if (yy === 7) return STONE_MORTAR;
    const b = courseBlock(x, k);
    if (x === b.from && left > 1) return STONE_MORTAR;
    const tone = (hash2(b.id, 3, seed) - 0.5) * 0.3;
    let level = 0.5 + tone + (tileNoise(x, r, 4, 4, seed + 1, 32) - 0.5) * 0.18;
    if (yy === 0 || x === b.from + 1) level += 0.3;
    if (yy === 6 || x === b.to - 1) level -= 0.22;
    // Darker near the ground and at the ends; the left end catches the light.
    if (r >= FACE - 3) level -= 0.25;
    if (right === 1) level -= 0.25;
    if (left === 1) level += 0.2;
    // Chips and pits.
    if (hash2(x, r, seed + 5) < 0.025) level -= 0.35;
    if (level > 0.9 && hash2(x, r, seed + 6) < 0.5) return STONE_LIT;
    return ramp(STONE_FACE, level);
  },
};

// ---- log wall (huts, docks) -----------------------------------------------------------------

const WOOD_TOP = ["#3f2c1d", "#563d28", "#6b4d32", "#7f5c3c"].map(hex);
const WOOD_LOG = ["#33241a", "#4a3324", "#614330", "#7a563b", "#93694a"].map(hex);
const WOOD_END = ["#5b4126", "#8a6a45", "#a8875c"].map(hex);
const WOOD_GAP = hex("#1f1712");
/** Light of a round log across its 8 rows (top lit, bottom in shadow). */
const LOG_ROWS = [0.55, 0.85, 0.75, 0.62, 0.5, 0.38, 0.22, 0.05];

export const WOOD: WallStyle = {
  band: BAND,
  top(x, y, e, seed) {
    // A beam laid along the run, its planks across it.
    const alongX = armOf(x, y) !== "v";
    const grain = tileNoise(alongX ? x : x * 4, alongX ? y * 4 : y, 8, 2, seed) - 0.5;
    let level = 0.55 + grain * 0.4;
    if (e.n <= 1 || e.w <= 1) level += 0.35;
    if (e.s === 1) level += 0.25;
    if (e.e <= 2) level -= 0.25;
    if ((alongX ? x : y) % 11 === 5) level -= 0.35;
    return ramp(WOOD_TOP, level);
  },
  face({ x, r, left, right }, seed) {
    if (r === 0) return WOOD_GAP;
    const yy = (r - 1) % 8;
    const k = Math.floor((r - 1) / 8);
    // Log ends at the ends of the wall: rings of end grain.
    const end = Math.min(left, right);
    if (end <= 2 && yy > 0 && yy < 7) {
      const ring = Math.abs(yy - 3.5) + (end === 1 ? 1 : 0);
      return ring > 2.6
        ? WOOD_GAP
        : ring > 1.6
          ? (WOOD_END[0] as Rgba)
          : ring > 0.8
            ? (WOOD_END[1] as Rgba)
            : (WOOD_END[2] as Rgba);
    }
    const grain = tileNoise(x, k * 8 + yy * 4, 8, 1, seed) - 0.5;
    let level = (LOG_ROWS[yy] ?? 0.5) + grain * 0.3 + (hash2(k, 1, seed) - 0.5) * 0.12;
    if (r >= FACE - 2) level -= 0.2;
    if (hash2(x, r, seed + 3) < 0.02) level -= 0.3; // knots
    return ramp(WOOD_LOG, level);
  },
};

// ---- rock (caves and mines) -----------------------------------------------------------------

const ROCK_TOP = ["#24212a", "#35303a", "#443e45", "#544c50", "#665c5c"].map(hex);
const ROCK_RIM = hex("#7a6f69");
const ROCK_FACE = ["#1f1c24", "#2b2730", "#38323a", "#463f44", "#564d4f"].map(hex);
const ROCK_CRACK = hex("#141218");

/**
 * The nearest point of a jittered lattice that repeats every 32 px (cells of cw x ch, one
 * point each): its id, the offset from it, and how close the second nearest one is (a small
 * gap = a crevice between two stones).
 */
export function stones(
  x: number,
  y: number,
  cw: number,
  ch: number,
  seed: number,
): { id: number; dx: number; dy: number; gap: number } {
  const cols = 32 / cw;
  const rows = 32 / ch;
  let best = Infinity;
  let second = Infinity;
  let out = { id: 0, dx: 0, dy: 0 };
  const gx0 = Math.floor(x / cw);
  const gy0 = Math.floor(y / ch);
  for (let gy = gy0 - 1; gy <= gy0 + 1; gy++)
    for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
      const col = ((gx % cols) + cols) % cols;
      const row = ((gy % rows) + rows) % rows;
      const px0 = gx * cw + 0.15 * cw + hash2(col, row, seed) * 0.7 * cw;
      const py0 = gy * ch + 0.15 * ch + hash2(col, row, seed + 1) * 0.7 * ch;
      const dx = (x + 0.5 - px0) / cw;
      const dy = (y + 0.5 - py0) / ch;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) {
        second = best;
        best = d;
        out = { id: row * cols + col, dx, dy };
      } else if (d < second) second = d;
    }
  return { ...out, gap: second - best };
}

export const ROCK: WallStyle = {
  band: BLOCK,
  top(x, y, e, seed) {
    if (e.s === 1) return ROCK_RIM; // the lit lip over the cliff
    // Rubble: stones of about 8 px, each lit on its top-left, dark crevices between them.
    const st = stones(x, y, 8, 8, seed);
    if (st.gap < 0.12) return ROCK_CRACK;
    let level = 0.45 + (hash2(st.id, 2, seed) - 0.5) * 0.3 - (st.dx + st.dy) * 0.55;
    if (st.gap < 0.24) level -= 0.25;
    if (e.n <= 2 || e.w <= 2) level += 0.2;
    if (e.e <= 2) level -= 0.2;
    return ramp(ROCK_TOP, level);
  },
  face({ x, r, left, right }, seed) {
    if (r === 0) return ROCK_CRACK; // shadow under the lip
    // Fractured facets, taller than wide; each faces the light or away from it, darker
    // toward the foot of the cliff.
    const st = stones(x, r, 8, 16, seed + 7);
    if (st.gap < 0.1) return ROCK_CRACK;
    const facing = hash2(st.id, 3, seed) - 0.5;
    let level = 0.62 - (r / FACE) * 0.35 + facing * 0.45 - st.dx * 0.35 - st.dy * 0.2;
    if (st.gap < 0.2) level -= 0.2;
    if (r <= 2) level += 0.12;
    if (left === 1) level += 0.12;
    if (right <= 2) level -= 0.2;
    return ramp(ROCK_FACE, level);
  },
};

/**
 * A style with ore in the rock: some of its stones are nuggets (lit on their top-left like
 * the rest), and an ember vein also glows in its crevices.
 */
function veinOf(base: WallStyle, ore: readonly Rgba[], glow: boolean): WallStyle {
  const nugget = (st: { id: number; dx: number; dy: number }, seed: number): Rgba | undefined => {
    if (hash2(st.id, 51, seed) > 0.32) return undefined;
    const d = Math.hypot(st.dx, st.dy);
    if (d > 0.42) return undefined;
    const lit = -(st.dx + st.dy);
    return ore[lit > 0.2 ? 2 : lit > -0.15 ? 1 : 0] as Rgba;
  };
  return {
    band: base.band,
    top(x, y, e, seed) {
      const c = base.top(x, y, e, seed);
      if (e.s === 1) return c;
      const st = stones(x, y, 8, 8, seed);
      if (st.gap < 0.12) return glow && hash2(x, y, seed + 52) < 0.6 ? (ore[0] as Rgba) : c;
      return nugget(st, seed) ?? c;
    },
    face(spot, seed) {
      const c = base.face(spot, seed);
      if (spot.r === 0) return c;
      const st = stones(spot.x, spot.r, 8, 16, seed + 7);
      if (st.gap < 0.1) return glow ? (ore[spot.r % 5 === 0 ? 1 : 0] as Rgba) : c;
      // Smaller nuggets on the face: the facets are bigger than the stones on top.
      return nugget({ id: st.id, dx: st.dx * 1.6, dy: st.dy * 1.2 }, seed + 3) ?? c;
    },
  };
}

const IRON_ORE = ["#7a4a2a", "#a8693a", "#d9b48a"].map(hex);
const EMBER_ORE = ["#8a2e12", "#d5631e", "#ffc35a"].map(hex);
export const IRON_VEIN = veinOf(ROCK, IRON_ORE, false);
export const EMBER_VEIN = veinOf(ROCK, EMBER_ORE, true);

// ---- doors in a wall --------------------------------------------------------------------------

const DOOR_FRAME = ["#3a3534", "#55504c", "#6f6a63"].map(hex);
const DOOR_WOOD = ["#3b2717", "#553923", "#6d4a2e", "#83603d"].map(hex);
const DOOR_IRON = ["#2a2b30", "#4a4c53", "#7b7e86"].map(hex);
const DOOR_DARK = hex("#0e0c10");

/**
 * A door set in a wall's face: the wall's east-west piece with an arched opening (columns
 * 8..23), closed by planks (or an iron gate), or open on darkness with the leaf swung in.
 */
function doorPiece(style: WallStyle, wall: string, kind: "wood" | "iron", open: boolean): Recipe {
  return {
    kind: "object",
    height: 64,
    draw(img: Image, _rand: Rng, seed: number) {
      // The wall's own texture round the door, so it meets its neighbours seamlessly.
      drawPiece(img, style, ICON_MASK, seedOfWall(wall));
      const top = southEdge(ICON_MASK, style.band, 16) + 1; // first face row
      const bottom = top + FACE - 1;
      const x0 = 8;
      const x1 = 23;
      const archTop = top + 6;
      const inArch = (x: number, y: number): boolean => {
        if (x < x0 || x > x1 || y > bottom || y < archTop) return false;
        const cx = (x0 + x1) / 2;
        const rx = (x1 - x0 + 1) / 2;
        if (y >= archTop + rx * 0.6) return true;
        const dy = (archTop + rx * 0.6 - y) / (rx * 0.6);
        const dx = (x + 0.5 - cx - 0.5) / rx;
        return dx * dx + dy * dy <= 1;
      };
      for (let y = archTop - 2; y <= bottom; y++)
        for (let x = x0 - 2; x <= x1 + 2; x++) {
          const inner = inArch(x, y);
          const near = !inner && [-2, -1, 1, 2].some((d) => inArch(x + d, y) || inArch(x, y + d));
          if (near) {
            // The stone frame round the opening, lit on its left.
            const lit = x < (x0 + x1) / 2;
            px(img, x, y, DOOR_FRAME[lit ? 2 : y > bottom - 2 ? 0 : 1] as Rgba);
            continue;
          }
          if (!inner) continue;
          if (open) {
            // Darkness, with the leaf swung against the left side.
            const leaf = x <= x0 + 2;
            px(img, x, y, leaf ? (DOOR_WOOD[x === x0 ? 3 : 1] as Rgba) : DOOR_DARK);
            continue;
          }
          if (kind === "wood") {
            const plank = Math.floor((x - x0) / 4);
            const xx = (x - x0) % 4;
            let level =
              0.5 +
              (hash2(plank, 1, seed) - 0.5) * 0.3 +
              (tileNoise(x * 3, y, 2, 8, seed) - 0.5) * 0.3;
            if (xx === 0) level = 0.05;
            else if (xx === 1) level += 0.3;
            const band = y === archTop + 8 || y === bottom - 6;
            if (band) px(img, x, y, DOOR_IRON[x % 5 === 2 ? 2 : 1] as Rgba);
            else px(img, x, y, ramp(DOOR_WOOD, level));
            continue;
          }
          // An iron gate: bars over darkness, with a glowing rune in the middle.
          const bar = (x - x0) % 3 === 1 || y === archTop + 9 || y === bottom - 5;
          if (bar) px(img, x, y, DOOR_IRON[(x - x0) % 3 === 1 && y % 4 === 0 ? 2 : 1] as Rgba);
          else px(img, x, y, DOOR_DARK);
        }
      if (!open && kind === "wood") {
        px(img, x1 - 4, top + 19, DOOR_IRON[2] as Rgba); // the ring
        px(img, x1 - 4, top + 20, DOOR_IRON[0] as Rgba);
      }
      if (!open && kind === "iron") {
        const cy = top + 17;
        for (const [dx, dy] of [
          [0, -2],
          [-1, -1],
          [1, -1],
          [0, 0],
          [-1, 1],
          [1, 1],
          [0, 2],
        ] as const)
          px(
            img,
            15 + dx + (dy === 0 ? 1 : 0),
            cy + dy,
            mix(EMBER_ORE[2] as Rgba, EMBER_ORE[1] as Rgba, Math.abs(dx) * 0.5),
          );
      }
    },
  };
}

/**
 * The 16 pieces of a wall and its icon sprite (the east-west piece). `material` gives the
 * texture seed: a vein shares the rock's, so it meets the rock round it seamlessly.
 */
function wallSet(sprite: string, style: WallStyle, material = sprite): RecipeBook {
  const book: RecipeBook = {};
  const piece = (mask: number): Recipe => ({
    kind: "object",
    height: 64,
    // Every piece of a material shares the seed: the textures meet at the seams.
    draw: (img) => drawPiece(img, style, mask, seedOfWall(material)),
  });
  book[sprite] = piece(ICON_MASK);
  for (let m = 0; m < 16; m++) book[`${sprite}/wall_${m}`] = piece(m);
  return book;
}

/** One seed per material (the recipe's own seed differs per piece path). */
function seedOfWall(sprite: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sprite.length; i++) {
    h ^= sprite.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const WALLS: RecipeBook = {
  ...wallSet("walls/stone_wall", STONE),
  ...wallSet("walls/wooden_wall", WOOD),
  ...wallSet("walls/rock_wall", ROCK),
  ...wallSet("decor/iron_vein", IRON_VEIN, "walls/rock_wall"),
  ...wallSet("decor/ember_vein", EMBER_VEIN, "walls/rock_wall"),
  "doors/pruebas_gate": doorPiece(STONE, "walls/stone_wall", "wood", false),
  "doors/pruebas_gate_open": doorPiece(STONE, "walls/stone_wall", "wood", true),
  "doors/forge_gate": doorPiece(ROCK, "walls/rock_wall", "iron", false),
  "doors/forge_gate_open": doorPiece(ROCK, "walls/rock_wall", "iron", true),
};
