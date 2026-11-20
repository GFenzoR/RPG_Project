// Ground transitions (data/borders.yaml, docs/06-content-data.md "Bordes"). The grounds that
// take part are on a ladder, bottom to top. A ground with a fringe (its own texture cut with
// an irregular edge, drawn by tools/spritepack gen-borders) has its pieces stacked on every
// lower ground of the ladder it touches (or only on those of its `over` list), at the bottom
// of the stack; lower fringes first, so the higher ground is drawn on top. Grounds off the
// ladder (wooden floors, docks) keep a straight edge. Where fringes reach a water ground of
// `shore`, each gets its surf pieces, of its own shape, under all the fringes of the tile.
// Piece names say where the higher ground is, seen from the covered tile:
//   n/s/e/w      on that side
//   ne/nw/se/sw  only on that diagonal (neither adjacent side): a small outer corner
//   inner_*      on both adjacent sides (a concave corner)
// A fringe's piece items are named `<pieces>_<piece>` (border_grass_n, ...), all twelve.
// Browser-safe: only types and plain functions.

export const BORDER_SIDES = ["n", "e", "s", "w"] as const;
export const BORDER_CORNERS = ["nw", "ne", "se", "sw"] as const;
export type BorderSide = (typeof BORDER_SIDES)[number];
export type BorderCorner = (typeof BORDER_CORNERS)[number];
export type BorderPieceName = BorderSide | BorderCorner | `inner_${BorderCorner}`;
/** Every piece a fringe (and the surf) has. */
export const BORDER_PIECES: readonly BorderPieceName[] = [
  ...BORDER_SIDES,
  ...BORDER_CORNERS,
  ...BORDER_CORNERS.map((c) => `inner_${c}` as const),
];

/**
 * How gen-borders draws the edge of a fringe (docs/17 ART-4): `plain` a darker rim; `tufts`
 * blades of grass standing over the lower ground; `pebbles` and `clods` small stones or
 * lumps strewn by the edge; `joint` a dark joint along a cut stone; `wet` a wet, darker
 * rim; `crust` the dark rim of a crust; `drift` loose grains blown past the edge.
 */
export const EDGE_STYLES = [
  "plain",
  "tufts",
  "pebbles",
  "clods",
  "joint",
  "wet",
  "crust",
  "drift",
] as const;
export type EdgeStyle = (typeof EDGE_STYLES)[number];

/** One rung of the ladder. */
export interface LadderStep {
  ground: string;
  /** Prefix of its fringe's twelve piece items; absent: it is only ever covered. */
  pieces?: string;
  /** How its edge is drawn (default plain). */
  edge?: EdgeStyle;
  /** Only over these lower grounds (default: every lower ground of the ladder). */
  over?: string[];
  notes?: string;
}

/** Surf where fringes meet water, under them (docs/17 ART-7: the foam rolls in over 4 frames). */
export interface BorderShore {
  /** Water grounds: fringes on them get the surf, and they never get it from each other. */
  water: string[];
  /** Prefix of the twelve surf piece items. */
  pieces: string;
  notes?: string;
}

/** data/borders.yaml. */
export interface BorderSet {
  /** Bottom to top. */
  ladder: LadderStep[];
  shore?: BorderShore;
}

export const NO_BORDERS: BorderSet = { ladder: [] };

/** The item of piece `piece` of a fringe or of the surf. */
export const pieceItem = (prefix: string, piece: BorderPieceName): string => `${prefix}_${piece}`;

/** Offsets of each neighbour (y grows south). */
const OFFSET: Record<BorderSide | BorderCorner, [number, number]> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
  nw: [-1, -1],
  ne: [1, -1],
  se: [1, 1],
  sw: [-1, 1],
};

const SIDES_OF: Record<BorderCorner, [BorderSide, BorderSide]> = {
  nw: ["n", "w"],
  ne: ["n", "e"],
  se: ["s", "e"],
  sw: ["s", "w"],
};

interface Fringe {
  ground: string;
  rank: number;
  prefix: string;
  over?: Set<string>;
}

interface BorderIndex {
  rank: Map<string, number>;
  /** Fringes bottom to top. */
  fringes: Fringe[];
  fringeOf: Map<string, Fringe>;
  water: Set<string>;
  shore?: string;
}

const indexes = new WeakMap<BorderSet, BorderIndex>();

function indexOf(set: BorderSet): BorderIndex {
  let ix = indexes.get(set);
  if (ix) return ix;
  const rank = new Map<string, number>();
  const fringes: Fringe[] = [];
  set.ladder.forEach((step, i) => {
    if (!rank.has(step.ground)) rank.set(step.ground, i);
  });
  set.ladder.forEach((step, i) => {
    if (!step.pieces || rank.get(step.ground) !== i) return;
    fringes.push({
      ground: step.ground,
      rank: i,
      prefix: step.pieces,
      ...(step.over ? { over: new Set(step.over) } : {}),
    });
  });
  ix = {
    rank,
    fringes,
    fringeOf: new Map(fringes.map((f) => [f.ground, f])),
    water: new Set(set.shore?.water ?? []),
    ...(set.shore ? { shore: set.shore.pieces } : {}),
  };
  indexes.set(set, ix);
  return ix;
}

/** Whether ground `upper`'s fringe is drawn over a tile of ground `lower`. */
export function covers(set: BorderSet, upper: string, lower: string): boolean {
  const ix = indexOf(set);
  const f = ix.fringeOf.get(upper);
  const r = ix.rank.get(lower);
  return f !== undefined && r !== undefined && f.rank > r && (!f.over || f.over.has(lower));
}

/** Every item used as a border piece (fringes and surf). */
export function borderItems(set: BorderSet): Set<string> {
  const out = new Set<string>();
  const ix = indexOf(set);
  for (const f of ix.fringes) for (const p of BORDER_PIECES) out.add(pieceItem(f.prefix, p));
  if (ix.shore) for (const p of BORDER_PIECES) out.add(pieceItem(ix.shore, p));
  return out;
}

/** Whether the set draws anything at all (a ground with a fringe). */
export const hasBorders = (set: BorderSet): boolean => indexOf(set).fringes.length > 0;

/**
 * The pieces for one higher ground (or for the surf): `is(d)` says whether the neighbour in
 * direction d is that ground. Inner corners where both sides are; then the sides left over;
 * then the diagonals with neither side.
 */
function piecesFor(prefix: string, is: (d: BorderSide | BorderCorner) => boolean, out: string[]) {
  const sides = new Set(BORDER_SIDES.filter(is));
  const covered = new Set<BorderSide>();
  for (const c of BORDER_CORNERS) {
    const [a, b] = SIDES_OF[c];
    if (sides.has(a) && sides.has(b)) {
      out.push(pieceItem(prefix, `inner_${c}`));
      covered.add(a);
      covered.add(b);
    }
  }
  for (const s of BORDER_SIDES) if (sides.has(s) && !covered.has(s)) out.push(pieceItem(prefix, s));
  for (const c of BORDER_CORNERS) {
    const [a, b] = SIDES_OF[c];
    if (!sides.has(a) && !sides.has(b) && is(c)) out.push(pieceItem(prefix, c));
  }
}

/**
 * Border pieces for the tile at (x, y), bottom to top. `groundAt` returns the ground of any
 * tile (null when there is none).
 */
export function borderPieces(
  x: number,
  y: number,
  groundAt: (x: number, y: number) => string | null,
  set: BorderSet,
): string[] {
  const here = groundAt(x, y);
  if (here === null) return [];
  const ix = indexOf(set);
  const rank = ix.rank.get(here);
  if (rank === undefined) return [];
  const near = {} as Record<BorderSide | BorderCorner, string | null>;
  for (const d of [...BORDER_SIDES, ...BORDER_CORNERS]) {
    const [dx, dy] = OFFSET[d];
    near[d] = groundAt(x + dx, y + dy);
  }
  const fringes: string[] = [];
  const surf: string[] = [];
  const shore = ix.shore !== undefined && ix.water.has(here) ? ix.shore : undefined;
  for (const f of ix.fringes) {
    if (f.rank <= rank || (f.over && !f.over.has(here))) continue;
    const is = (d: BorderSide | BorderCorner): boolean => near[d] === f.ground;
    piecesFor(f.prefix, is, fringes);
    // Each fringe has its own surf, of its very shape: all of it lies outside the fringe's
    // edge, and the fringes (over every surf of the tile) hide whatever falls on the land of
    // another. So the foam follows the real shore, the outline of all the fringes together:
    // sand on the north and grass on the west give the surf of a north side and of a west
    // side, not of a concave corner that neither fringe draws.
    if (shore !== undefined && !ix.water.has(f.ground)) piecesFor(shore, is, surf);
  }
  return surf.length > 0 ? [...surf, ...fringes] : fringes;
}
