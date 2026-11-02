// Prefabs (world/prefabs/<id>.yaml): small reusable pieces of map (a dock, a hut) that the
// `stamp` op copies onto a floor. Browser-safe model; reading and writing them from disk is
// in ../prefabs.ts.
//
// `rows` is a picture of the prefab, one string per row, one character per tile. Each
// character is looked up in `legend`:
//   - `ground`: paints that ground.
//   - `items`: replaces the tile's stack with these items (`[]` clears it). Without
//     `items`, the stack is left alone.
// A space is never in the legend: it leaves the tile untouched.

export interface PrefabLegendEntry {
  char: string;
  ground?: string;
  items?: string[];
}

export interface Prefab {
  id: string;
  legend: PrefabLegendEntry[];
  rows: string[];
  notes?: string;
}

/** Size of a prefab in tiles (the widest row). */
export function prefabSize(p: Prefab): { w: number; h: number } {
  return { w: Math.max(0, ...p.rows.map((r) => [...r].length)), h: p.rows.length };
}
