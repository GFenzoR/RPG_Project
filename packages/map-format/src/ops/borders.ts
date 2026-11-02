// Autoborder rules (data/borders.yaml, docs/06-content-data.md "Bordes"): when ground
// `from` touches ground `to`, border pieces are stacked on the `to` tile, at the bottom of
// its stack. Piece names say where the `from` ground is:
//   n/s/e/w      `from` on that side
//   ne/nw/se/sw  `from` only on that diagonal (neither adjacent side): a small corner
//   inner_*      `from` on both adjacent sides (optional; without it, both sides are stacked)
// Browser-safe: only types and plain functions.

export const BORDER_SIDES = ["n", "e", "s", "w"] as const;
export const BORDER_CORNERS = ["nw", "ne", "se", "sw"] as const;
export type BorderSide = (typeof BORDER_SIDES)[number];
export type BorderCorner = (typeof BORDER_CORNERS)[number];
export type BorderPieceName = BorderSide | BorderCorner | `inner_${BorderCorner}`;

export interface BorderRule {
  id: string;
  from: string;
  to: string;
  /** Higher priority is drawn on top. Default 0. */
  priority?: number;
  pieces: Record<BorderSide | BorderCorner, string> &
    Partial<Record<`inner_${BorderCorner}`, string>>;
  notes?: string;
}

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

/** Rules in drawing order: lower priority first (bottom), then file order. */
export function orderedRules(rules: readonly BorderRule[]): BorderRule[] {
  return rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.priority ?? 0) - (b.r.priority ?? 0) || a.i - b.i)
    .map((e) => e.r);
}

/** Every item ID used as a border piece. */
export function borderItems(rules: readonly BorderRule[]): Set<string> {
  const out = new Set<string>();
  for (const r of rules) for (const id of Object.values(r.pieces)) if (id) out.add(id);
  return out;
}

/**
 * Border pieces for the tile at (x, y), bottom to top. `groundAt` returns the ground of any
 * tile (null when there is none). `rules` must already be in drawing order.
 */
export function borderPieces(
  x: number,
  y: number,
  groundAt: (x: number, y: number) => string | null,
  rules: readonly BorderRule[],
): string[] {
  const here = groundAt(x, y);
  if (here === null) return [];
  const out: string[] = [];
  for (const rule of rules) {
    if (rule.to !== here || rule.from === here) continue;
    const is = (d: BorderSide | BorderCorner): boolean => {
      const [dx, dy] = OFFSET[d];
      return groundAt(x + dx, y + dy) === rule.from;
    };
    const sides = new Set(BORDER_SIDES.filter(is));
    const covered = new Set<BorderSide>();
    for (const c of BORDER_CORNERS) {
      const inner = rule.pieces[`inner_${c}`];
      const [a, b] = SIDES_OF[c];
      if (inner && sides.has(a) && sides.has(b)) {
        out.push(inner);
        covered.add(a);
        covered.add(b);
      }
    }
    for (const s of BORDER_SIDES) if (sides.has(s) && !covered.has(s)) out.push(rule.pieces[s]);
    for (const c of BORDER_CORNERS) {
      const [a, b] = SIDES_OF[c];
      if (!sides.has(a) && !sides.has(b) && is(c)) out.push(rule.pieces[c]);
    }
  }
  return out;
}
