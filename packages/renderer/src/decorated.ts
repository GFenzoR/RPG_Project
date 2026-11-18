// Render-only items on the map (docs/17 A11): things every renderer draws on a tile that the
// maps do not hold, such as the timber frame of a house door (houses.yaml `doors` are gaps in
// a wall that the server knows by their tile). A DecoratedSource wraps any TileSource and
// puts those items at the bottom of their tiles' stacks, so MapView treats them like map
// items (a frame joins the walls round it). The game's own state never sees them: clicks,
// looks and walking read the world, not this.
import { CHUNK_TILES } from "./camera.ts";
import type { ChunkData, TileSource } from "./map-view.ts";

/** data/items ID of the timber frame drawn on every house door (houses.yaml `doors`). */
export const HOUSE_DOOR_FRAME = "house_door_frame";

/** A render-only item: its global tile and its item ID. */
export interface ExtraItem {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly id: string;
}

/** The extra items of one chunk, in local coordinates. */
type ChunkExtras = readonly { readonly x: number; readonly y: number; readonly id: string }[];

/** Groups extra items by chunk: "z/cx/cy" → their local tiles. */
export function extrasByChunk(items: Iterable<ExtraItem>): Map<string, ChunkExtras> {
  const out = new Map<string, { x: number; y: number; id: string }[]>();
  for (const e of items) {
    if (e.x < 0 || e.y < 0) continue;
    const key = `${e.z}/${Math.floor(e.x / CHUNK_TILES)}/${Math.floor(e.y / CHUNK_TILES)}`;
    let list = out.get(key);
    if (!list) {
      list = [];
      out.set(key, list);
    }
    list.push({ x: e.x % CHUNK_TILES, y: e.y % CHUNK_TILES, id: e.id });
  }
  return out;
}

/** `data` with `extras` at the bottom of their tiles' stacks (a new object; data untouched). */
export function withExtras(data: ChunkData, extras: ChunkExtras): ChunkData {
  const items = data.items.map((s) => ({ x: s.x, y: s.y, stack: [...s.stack] }));
  for (const e of extras) {
    const at = items.find((s) => s.x === e.x && s.y === e.y);
    if (at) at.stack.unshift(e.id);
    else items.push({ x: e.x, y: e.y, stack: [e.id] });
  }
  return { ground: data.ground, items };
}

/**
 * A TileSource with render-only items. `extras` says which ones a chunk gets (the same array
 * while they do not change). The decorated chunk is kept per source chunk object, so MapView
 * rebuilds a chunk only when the map or its extras change.
 */
export class DecoratedSource implements TileSource {
  private readonly cache = new WeakMap<ChunkData, { extras: ChunkExtras; data: ChunkData }>();

  private readonly base: TileSource;
  private readonly extras: (z: number, cx: number, cy: number) => ChunkExtras | undefined;

  constructor(
    base: TileSource,
    extras: (z: number, cx: number, cy: number) => ChunkExtras | undefined,
  ) {
    this.base = base;
    this.extras = extras;
  }

  chunk(z: number, cx: number, cy: number): ChunkData | undefined {
    const data = this.base.chunk(z, cx, cy);
    if (!data) return undefined;
    const extras = this.extras(z, cx, cy);
    if (!extras || extras.length === 0) return data;
    const hit = this.cache.get(data);
    if (hit?.extras === extras) return hit.data;
    const out = withExtras(data, extras);
    this.cache.set(data, { extras, data: out });
    return out;
  }
}
