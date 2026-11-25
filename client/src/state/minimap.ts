// The minimap's state and geometry (docs/02 "Minimapa", docs/05 "Minimapa"). Pure logic
// over plain data: no DOM, no canvas, no clock (callers pass now); ui/Minimap.tsx draws
// with it.
//
// What the character explored comes from the server (MinimapIndex at login, MinimapSectors
// answers and deltas); the client also explores its own view as it walks, with the same
// rule as the server (the 31x21 window on its own floor), so the fog opens with the step
// and not a second later. A tile is coloured by what a MinimapSectors answer said or else
// by the map the client was sent: the colour item of every tile it receives is remembered
// here (noteTile), because WorldState forgets the map far from the player and on every
// floor change, and what was explored must stay coloured. Only explored tiles are drawn:
// an unexplored one is black whatever is known of it.
import type { ItemDef } from "../content-types.ts";

/** Side of a sector in tiles (the server's explore.SectorSize, a chunk of world/). */
export const SECTOR = 32;
/** Bytes of a sector's bitset. */
export const SECTOR_BYTES = (SECTOR * SECTOR) / 8;
/** Sectors one MinimapRequest may ask for (the server's MaxMinimapRequestSectors). */
export const MAX_REQUEST_SECTORS = 16;

/** The protocol's sector id within a floor: sx << 16 | sy. */
export const sectorId = (sx: number, sy: number): number => ((sx << 16) | sy) >>> 0;

/** A request with no answer after this long is sent again (docs/05 "Minimapa"). */
export const REQUEST_RETRY_MS = 2000;

// A sector's key in the client's maps: floor, column and row in one number (sx and sy
// are under 2048 on a 65536-tile map), so the per-tile reads build no strings.
const keyOf = (z: number, sx: number, sy: number): number => z * 4194304 + sx * 2048 + sy;

/** One sector of a MinimapSectors message, as the client reads it. */
export interface SectorData {
  z: number;
  sector: number;
  explored: Uint8Array;
  palette: readonly number[];
  tiles: Uint8Array;
}

/** The estimate of the tracked objective (ObjectiveHint), in tiles. */
export interface ObjectiveHintView {
  questId: string;
  stepId: string;
  x: number;
  y: number;
  z: number;
  radius: number;
}

export class MinimapState {
  private readonly explored = new Map<number, Uint8Array>();
  /** The colour item of each tile of a sector (0: none known), row by row. */
  private readonly colours = new Map<number, Uint16Array>();
  /** The tiles of a sector whose colour item came in an answer (a bitset like explored). */
  private readonly given = new Map<number, Uint8Array>();
  /** Sectors the server has something of, per floor (MinimapIndex and later sectors). */
  private readonly indexed = new Map<number, Set<number>>();
  /** Sectors answered (MinimapSectors.answer) since the last index: never asked again. */
  private readonly asked = new Set<number>();
  /**
   * Sectors asked for and not answered yet, with when (ms) the request went. The server
   * drops a request silently (another floor by the time it arrives, over the budget), so
   * one unanswered for REQUEST_RETRY_MS is asked again.
   */
  private readonly inFlight = new Map<number, number>();
  /** Grows with every change: the minimap draws again when it moves. */
  version = 0;
  /** The tracked objective's estimate; undefined: none. */
  hint: ObjectiveHintView | undefined;
  /** The quest the server says is tracked (ObjectiveHint.quest_id; "": none). */
  tracked = "";

  /**
   * A new login's MinimapIndex: replaces what was known of what the character explored.
   * The remembered colour items stay: they are the map (not the character's), and the
   * login's first FullMapView comes before the index.
   */
  applyIndex(floors: readonly { z: number; sectors: readonly number[] }[]): void {
    this.explored.clear();
    this.indexed.clear();
    this.asked.clear();
    this.inFlight.clear();
    for (const f of floors) this.indexed.set(f.z, new Set(f.sectors));
    this.version++;
  }

  /**
   * A MinimapSectors message: an answer to a MinimapRequest (answer: with palette and
   * tiles) or a delta (explored only). Bits are ORed: what the client explored itself is
   * never lost. Only an answer settles a sector: one that came in a delta alone (the
   * minimap was folded, or the delta overtook the request) still has what the character
   * explored in earlier logins to ask for.
   */
  applySectors(sectors: readonly SectorData[], answer: boolean): void {
    for (const s of sectors) {
      const sx = s.sector >>> 16;
      const sy = s.sector & 0xffff;
      const k = keyOf(s.z, sx, sy);
      if (answer) {
        this.asked.add(k);
        this.inFlight.delete(k);
      }
      if (s.explored.length === SECTOR_BYTES) {
        this.orInto(k, s.explored);
        let set = this.indexed.get(s.z);
        if (!set) this.indexed.set(s.z, (set = new Set()));
        set.add(sectorId(sx, sy));
      }
      if (s.tiles.length === SECTOR * SECTOR && s.palette.length > 0) {
        // The server's item wins over what the client noted (it knows the map's flags).
        const items = this.coloursOf(k);
        let given = this.given.get(k);
        if (!given) this.given.set(k, (given = new Uint8Array(SECTOR_BYTES)));
        for (let i = 0; i < SECTOR * SECTOR; i++) {
          const pi = s.tiles[i] ?? 0;
          const item = pi === 0 ? 0 : (s.palette[pi - 1] ?? 0);
          if (item === 0) continue;
          items[i] = item;
          given[i >> 3] = (given[i >> 3] ?? 0) | (1 << (i & 7));
        }
      }
    }
    this.version++;
  }

  private coloursOf(k: number): Uint16Array {
    let c = this.colours.get(k);
    if (!c) this.colours.set(k, (c = new Uint16Array(SECTOR * SECTOR)));
    return c;
  }

  /**
   * Remembers the colour item of tile x, y on floor z as the client was just sent it
   * (colourItem of its stack; WorldState calls this for every tile it receives). The
   * minimap keeps it after WorldState forgets the tile. An item an answer gave stays: the
   * server knows the map's flags the client lacks (a blocking tile whose items are not in
   * data/ shows its top item).
   */
  noteTile(x: number, y: number, z: number, item: number): void {
    if (item === 0 || x < 0 || y < 0) return;
    const k = keyOf(z, Math.floor(x / SECTOR), Math.floor(y / SECTOR));
    const i = (y % SECTOR) * SECTOR + (x % SECTOR);
    const given = this.given.get(k);
    if (given && ((given[i >> 3] ?? 0) & (1 << (i & 7))) !== 0) return;
    const items = this.coloursOf(k);
    if (items[i] === item) return;
    items[i] = item;
    this.version++;
  }

  private orInto(k: number, bits: Uint8Array): boolean {
    let cur = this.explored.get(k);
    if (!cur) this.explored.set(k, (cur = new Uint8Array(SECTOR_BYTES)));
    let changed = false;
    for (let i = 0; i < SECTOR_BYTES; i++) {
      const v = (cur[i] ?? 0) | (bits[i] ?? 0);
      if (v !== cur[i]) {
        cur[i] = v;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Explores the view window (width x height tiles) around x, y on floor z, as the server
   * does when the player lands on a tile. Returns whether anything new was explored.
   */
  revealView(x: number, y: number, z: number, width: number, height: number): boolean {
    const x0 = Math.max(x - Math.floor(width / 2), 0);
    const y0 = Math.max(y - Math.floor(height / 2), 0);
    const x1 = Math.min(x + Math.floor(width / 2), 0xffff);
    const y1 = Math.min(y + Math.floor(height / 2), 0xffff);
    let changed = false;
    for (let ty = y0; ty <= y1; ty++) {
      const sy = Math.floor(ty / SECTOR);
      const row = (ty % SECTOR) * SECTOR;
      // One sector lookup per row and sector the window crosses, not one per tile.
      for (let tx = x0; tx <= x1;) {
        const sx = Math.floor(tx / SECTOR);
        const end = Math.min(x1, sx * SECTOR + SECTOR - 1);
        const k = keyOf(z, sx, sy);
        let cur = this.explored.get(k);
        if (!cur) this.explored.set(k, (cur = new Uint8Array(SECTOR_BYTES)));
        for (; tx <= end; tx++) {
          const i = row + (tx % SECTOR);
          const b = 1 << (i & 7);
          if (((cur[i >> 3] ?? 0) & b) === 0) {
            cur[i >> 3] = (cur[i >> 3] ?? 0) | b;
            changed = true;
          }
        }
      }
    }
    if (changed) this.version++;
    return changed;
  }

  /** Whether tile x, y on floor z is explored. */
  isExplored(x: number, y: number, z: number): boolean {
    if (x < 0 || y < 0) return false;
    const s = this.explored.get(keyOf(z, Math.floor(x / SECTOR), Math.floor(y / SECTOR)));
    if (!s) return false;
    const i = (y % SECTOR) * SECTOR + (x % SECTOR);
    return ((s[i >> 3] ?? 0) & (1 << (i & 7))) !== 0;
  }

  /**
   * The item tile x, y on floor z is coloured by (0: none known): what an answer gave, else
   * what the client was sent of it (noteTile), whether or not it still holds that map.
   */
  item(x: number, y: number, z: number): number {
    if (x < 0 || y < 0) return 0;
    const c = this.colours.get(keyOf(z, Math.floor(x / SECTOR), Math.floor(y / SECTOR)));
    return c ? (c[(y % SECTOR) * SECTOR + (x % SECTOR)] ?? 0) : 0;
  }

  /**
   * The sectors of floor z within tiles x0..x1, y0..y1 the server has something of and the
   * client has neither had answered nor asked for in the last REQUEST_RETRY_MS (now: ms,
   * performance.now()), at most MAX_REQUEST_SECTORS, nearest to the centre first. They are
   * marked in flight at now: the caller sends them in one MinimapRequest.
   */
  wanted(z: number, x0: number, y0: number, x1: number, y1: number, now: number): number[] {
    const set = this.indexed.get(z);
    if (!set || set.size === 0) return [];
    const cx = (x0 + x1) / 2 / SECTOR;
    const cy = (y0 + y1) / 2 / SECTOR;
    const found: { id: number; k: number; d: number }[] = [];
    const sx0 = Math.max(Math.floor(x0 / SECTOR), 0);
    const sy0 = Math.max(Math.floor(y0 / SECTOR), 0);
    for (let sy = sy0; sy <= Math.floor(y1 / SECTOR); sy++)
      for (let sx = sx0; sx <= Math.floor(x1 / SECTOR); sx++) {
        const id = sectorId(sx, sy);
        const k = keyOf(z, sx, sy);
        if (!set.has(id) || this.asked.has(k)) continue;
        const sent = this.inFlight.get(k);
        if (sent !== undefined && now - sent < REQUEST_RETRY_MS) continue;
        found.push({ id, k, d: Math.hypot(sx + 0.5 - cx, sy + 0.5 - cy) });
      }
    found.sort((a, b) => a.d - b.d || a.id - b.id);
    const out = found.slice(0, MAX_REQUEST_SECTORS);
    for (const f of out) this.inFlight.set(f.k, now);
    return out.map((f) => f.id);
  }

  /**
   * Milliseconds (from now) until the next unanswered request may be sent again, or
   * undefined when none is waiting: the minimap looks again then even if nothing else
   * changed. One already past its wait is asked again by the next wanted() that sees it,
   * not here (it may be out of view).
   */
  retryIn(now: number): number | undefined {
    let next: number | undefined;
    for (const sent of this.inFlight.values()) {
      const due = sent + REQUEST_RETRY_MS - now;
      if (due > 0) next = next === undefined ? due : Math.min(next, due);
    }
    return next;
  }
}

// ---- colours ---------------------------------------------------------------------------

/**
 * The item a tile is coloured by, from its stack (ground first): the topmost item that
 * blocks (a wall, a tree), else the ground; 0 for an empty stack. Like the server's
 * minimapItem.
 */
export function colourItem(
  stack: readonly number[] | undefined,
  item: (id: number) => ItemDef | undefined,
): number {
  if (!stack || stack.length === 0) return 0;
  for (let i = stack.length - 1; i >= 0; i--) {
    const id = stack[i] ?? 0;
    if (item(id)?.blocks === true) return id;
  }
  return stack[0] ?? 0;
}

/** "#rrggbb" to [r, g, b]; a malformed value is a dull grey. */
export function parseHex(hex: string | undefined): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return [96, 96, 96];
  const v = parseInt(m[1] ?? "0", 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// ---- geometry --------------------------------------------------------------------------

/** What the minimap shows: the tile at its centre and how many pixels a tile takes. */
export interface MinimapView {
  /** Centre tile (fractional allowed: the middle of a tile is x + 0.5). */
  cx: number;
  cy: number;
  /** Pixels per tile (the zoom). */
  scale: number;
  /** Size of the canvas in pixels. */
  width: number;
  height: number;
}

/** The zoom steps, pixels per tile. */
export const MINIMAP_SCALES = [1, 2, 3, 4] as const;

/** Pixel of the centre of tile x, y. */
export function tileToPixel(v: MinimapView, x: number, y: number): { px: number; py: number } {
  return {
    px: (x + 0.5 - v.cx) * v.scale + v.width / 2,
    py: (y + 0.5 - v.cy) * v.scale + v.height / 2,
  };
}

/** Tile under pixel px, py. */
export function pixelToTile(v: MinimapView, px: number, py: number): { x: number; y: number } {
  return {
    x: Math.floor(v.cx + (px - v.width / 2) / v.scale),
    y: Math.floor(v.cy + (py - v.height / 2) / v.scale),
  };
}

/** The tiles the view covers (inclusive). */
export function viewTiles(v: MinimapView): { x0: number; y0: number; x1: number; y1: number } {
  const a = pixelToTile(v, 0, 0);
  const b = pixelToTile(v, v.width - 1, v.height - 1);
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

/** A pixel buffer (ImageData's shape), RGBA. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Colour of unexplored ground: black, as the owner asked (2026-11-23). */
export const FOG: readonly [number, number, number] = [0, 0, 0];

/**
 * Paints the terrain of the view into out: each explored tile in the colour of its item,
 * every other pixel black. tileItem gives a tile's colour item (0: nothing known, drawn as
 * dark grey when explored) and colour that item's [r, g, b].
 */
export function paintTerrain(
  out: Pixels,
  v: MinimapView,
  z: number,
  explored: (x: number, y: number, z: number) => boolean,
  tileItem: (x: number, y: number, z: number) => number,
  colour: (item: number) => readonly [number, number, number],
): void {
  const { x0, y0, x1, y1 } = viewTiles(v);
  const d = out.data;
  d.fill(0);
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      if (!explored(tx, ty, z)) continue;
      const item = tileItem(tx, ty, z);
      const [r, g, b] = item === 0 ? ([24, 24, 28] as const) : colour(item);
      const { px, py } = tileToPixel(v, tx, ty);
      const left = Math.round(px - v.scale / 2);
      const top = Math.round(py - v.scale / 2);
      for (let yy = Math.max(top, 0); yy < Math.min(top + v.scale, out.height); yy++)
        for (let xx = Math.max(left, 0); xx < Math.min(left + v.scale, out.width); xx++) {
          const o = (yy * out.width + xx) * 4;
          d[o] = r;
          d[o + 1] = g;
          d[o + 2] = b;
        }
    }
}

/** A point on the minimap's edge and the direction to something off it (radians, 0 = east). */
export interface EdgeArrow {
  px: number;
  py: number;
  angle: number;
}

/**
 * The arrow on the minimap's edge pointing toward tile x, y, or undefined when the tile is
 * inside the view (inset by margin pixels): the point where the line from the centre to it
 * crosses the inset edge.
 */
export function edgeArrow(v: MinimapView, x: number, y: number, margin = 8): EdgeArrow | undefined {
  const { px, py } = tileToPixel(v, x, y);
  const cx = v.width / 2;
  const cy = v.height / 2;
  const hw = v.width / 2 - margin;
  const hh = v.height / 2 - margin;
  const dx = px - cx;
  const dy = py - cy;
  if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) return undefined;
  const t = Math.min(
    dx === 0 ? Infinity : hw / Math.abs(dx),
    dy === 0 ? Infinity : hh / Math.abs(dy),
  );
  return { px: cx + dx * t, py: cy + dy * t, angle: Math.atan2(dy, dx) };
}

/** How the minimap shows the tracked objective's estimate. */
export type HintMarker =
  | { kind: "area"; px: number; py: number; r: number; floor: FloorHint }
  | { kind: "arrow"; px: number; py: number; angle: number; distance: number; floor: FloorHint };

/** The estimate is up (a lower floor number) or down from the player, or on its floor. */
export type FloorHint = "up" | "down" | undefined;

/**
 * Rounds a distance in tiles for the label of the edge arrow: it is an estimate (the
 * circle's centre is not the target), so to 5 tiles under 50, else to 10.
 */
export function roughDistance(tiles: number): number {
  const step = tiles < 50 ? 5 : 10;
  return Math.max(step, Math.round(tiles / step) * step);
}

/**
 * The marker of hint for a player at self on floor z: the circle when its centre is on the
 * minimap, else the edge arrow toward it with the rough distance. A hint on another floor
 * says which way (up: a smaller floor number).
 */
export function hintMarker(
  v: MinimapView,
  hint: ObjectiveHintView,
  self: { x: number; y: number; z: number },
): HintMarker {
  const floor: FloorHint = hint.z < self.z ? "up" : hint.z > self.z ? "down" : undefined;
  const arrow = edgeArrow(v, hint.x, hint.y);
  if (!arrow) {
    const { px, py } = tileToPixel(v, hint.x, hint.y);
    return { kind: "area", px, py, r: Math.max(hint.radius * v.scale, 4), floor };
  }
  const distance = roughDistance(Math.hypot(hint.x - self.x, hint.y - self.y));
  return { kind: "arrow", ...arrow, distance, floor };
}

/** The cardinal points on the frame: i18n key and the side they sit on. */
export const CARDINALS = [
  { key: "client.minimap.north", side: "top" },
  { key: "client.minimap.east", side: "right" },
  { key: "client.minimap.south", side: "bottom" },
  { key: "client.minimap.west", side: "left" },
] as const;

/** Pans view by a drag of dx, dy pixels (the map follows the pointer). */
export function panBy(
  pan: { x: number; y: number },
  dx: number,
  dy: number,
  scale: number,
): { x: number; y: number } {
  return { x: pan.x - dx / scale, y: pan.y - dy / scale };
}
