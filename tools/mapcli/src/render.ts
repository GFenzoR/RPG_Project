// `mapcli render` / MCP `map_render`: a PNG of one floor of an area, drawn with the sprite
// atlas (tools/spritepack, built in memory) and the same draw order as packages/renderer:
// every ground first, then the stacks tile by tile in row-major order, bottom to top;
// sprites bigger than a tile are anchored at the bottom-right of their tile. Meant for
// reviewing edits with the Read tool, so it adds what the game would not show: coordinate
// rulers, a grid, and overlays for zones, spawns, NPCs, portals, signs and the temple.
import { buildAtlas, createImage, drawText, encodePng, GLYPH_H, textWidth } from "@rpg/spritepack";
import type { Image, Rgba } from "@rpg/spritepack";
import { CHUNK_SIZE, chunkKey, rectContains } from "@rpg/map-format";
import type { ContentIndex, Rect, World } from "@rpg/map-format";

/** Largest area side, in tiles. */
export const MAX_RENDER_SIZE = 256;
export const TILE_SIZES = [4, 8, 16, 32] as const;

export interface RenderOptions {
  floor: number;
  area: Rect;
  /** Pixels per tile (4, 8, 16 or 32). Default: 32 up to 64 tiles, 16 up to 128, else 8. */
  tile?: number;
  /** Zones, spawns, NPCs, portals, signs, temple. Default true. */
  overlays?: boolean;
  /** Tile grid (only drawn at 16 px per tile or more). Default true. */
  grid?: boolean;
}

export interface RenderResult {
  png: Buffer;
  width: number;
  height: number;
  tile: number;
  /** What each overlay colour means, for whoever reads the image. */
  legend: string[];
  /** Item IDs with no sprite in the atlas (drawn as magenta squares). */
  missing: string[];
}

interface Frame {
  page: Image;
  x: number;
  y: number;
  w: number;
  h: number;
}

const ZONE_COLORS: Record<string, Rgba> = {
  protection: [80, 220, 255, 255],
  no_logout: [255, 160, 40, 255],
  pvp: [255, 40, 40, 255],
  no_pvp: [60, 230, 90, 255],
  community_plot: [190, 90, 255, 255],
};
const SPAWN: Rgba = [235, 30, 30, 255];
const NPC: Rgba = [255, 230, 0, 255];
const PORTAL: Rgba = [255, 0, 220, 255];
const TEXT: Rgba = [255, 255, 255, 255];
const MISSING: Rgba = [255, 0, 255, 255];
const BG: Rgba = [16, 16, 20, 255];
const RULER: Rgba = [230, 230, 230, 255];

export function defaultTile(area: Rect): number {
  const side = Math.max(area.w, area.h);
  return side <= 64 ? 32 : side <= 128 ? 16 : 8;
}

function blend(img: Image, x: number, y: number, c: Rgba, alpha = c[3] / 255): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || alpha <= 0) return;
  const i = (y * img.width + x) * 4;
  const d = img.data;
  const a = Math.min(1, alpha);
  d[i] = Math.round((c[0] * a + (d[i] as number) * (1 - a)) | 0);
  d[i + 1] = Math.round((c[1] * a + (d[i + 1] as number) * (1 - a)) | 0);
  d[i + 2] = Math.round((c[2] * a + (d[i + 2] as number) * (1 - a)) | 0);
  d[i + 3] = 255;
}

function rect(img: Image, x: number, y: number, w: number, h: number, c: Rgba, a?: number): void {
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) blend(img, px, py, c, a);
}

function outline(img: Image, x: number, y: number, w: number, h: number, t: number, c: Rgba): void {
  rect(img, x, y, w, t, c);
  rect(img, x, y + h - t, w, t, c);
  rect(img, x, y + t, t, h - 2 * t, c);
  rect(img, x + w - t, y + t, t, h - 2 * t, c);
}

/** Draws a sprite scaled by tile/32 with its bottom-right corner at (right, bottom). */
function drawSprite(img: Image, f: Frame, right: number, bottom: number, scale: number): void {
  const w = Math.max(1, Math.round(f.w * scale));
  const h = Math.max(1, Math.round(f.h * scale));
  for (let dy = 0; dy < h; dy++) {
    const sy = f.y + Math.min(f.h - 1, Math.floor(dy / scale));
    for (let dx = 0; dx < w; dx++) {
      const sx = f.x + Math.min(f.w - 1, Math.floor(dx / scale));
      const si = (sy * f.page.width + sx) * 4;
      const a = (f.page.data[si + 3] as number) / 255;
      if (a === 0) continue;
      const c: Rgba = [
        f.page.data[si] as number,
        f.page.data[si + 1] as number,
        f.page.data[si + 2] as number,
        255,
      ];
      blend(img, right - w + dx, bottom - h + dy, c, a);
    }
  }
}

/** Sprite frames by sprite path, from an atlas built in memory (no files written). */
export function loadFrames(root: string): Map<string, Frame> {
  const frames = new Map<string, Frame>();
  const atlas = buildAtlas(root).atlas;
  if (!atlas) return frames;
  for (const page of atlas.pages)
    for (const [name, fr] of Object.entries(page.json.frames))
      frames.set(name, { page: page.image, ...fr.frame });
  return frames;
}

export function renderArea(
  world: World,
  content: ContentIndex,
  frames: Map<string, Frame>,
  opts: RenderOptions,
): RenderResult {
  const { area, floor } = opts;
  if (area.w > MAX_RENDER_SIZE || area.h > MAX_RENDER_SIZE)
    throw new RangeError(`render area is at most ${MAX_RENDER_SIZE}x${MAX_RENDER_SIZE} tiles`);
  const T = opts.tile ?? defaultTile(area);
  if (!(TILE_SIZES as readonly number[]).includes(T))
    throw new RangeError(`tile must be one of ${TILE_SIZES.join(", ")}`);
  const scale = T / 32;
  const labelEvery = [1, 2, 4, 8, 16, 32, 64].find((n) => n * T >= 48) ?? 64;
  const left = textWidth("00000", 1) + 6;
  const top = GLYPH_H + 6;
  const img = createImage(left + area.w * T, top + area.h * T);
  rect(img, 0, 0, img.width, img.height, BG);
  const px = (x: number): number => left + (x - area.x) * T;
  const py = (y: number): number => top + (y - area.y) * T;

  const missing = new Set<string>();
  const frameOf = (id: string): Frame | undefined => {
    const sprite = content.items.get(id)?.sprite;
    const f = sprite ? frames.get(sprite) : undefined;
    if (!f) missing.add(id);
    return f;
  };
  const tileAt = (x: number, y: number) => {
    for (const isl of world.islands.values()) {
      if (!rectContains(isl.meta.rect, x, y)) continue;
      const c = isl.chunks.get(
        chunkKey(floor, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)),
      );
      if (!c) return undefined;
      const lx = x % CHUNK_SIZE;
      const ly = y % CHUNK_SIZE;
      return {
        ground: c.ground[ly * CHUNK_SIZE + lx] ?? null,
        stack: c.items.find((s) => s.x === lx && s.y === ly)?.stack ?? [],
      };
    }
    return undefined;
  };
  const x1 = area.x + area.w;
  const y1 = area.y + area.h;
  // Grounds, then stacks.
  for (let y = area.y; y < y1; y++)
    for (let x = area.x; x < x1; x++) {
      const g = tileAt(x, y)?.ground;
      if (!g) continue;
      const f = frameOf(g);
      if (f) drawSprite(img, f, px(x) + T, py(y) + T, scale);
      else rect(img, px(x), py(y), T, T, MISSING);
    }
  for (let y = area.y; y < y1; y++)
    for (let x = area.x; x < x1; x++)
      for (const id of tileAt(x, y)?.stack ?? []) {
        const f = frameOf(id);
        if (f) drawSprite(img, f, px(x) + T, py(y) + T, scale);
        else outline(img, px(x) + 2, py(y) + 2, T - 4, T - 4, Math.max(1, T >> 3), MISSING);
      }

  if (opts.grid !== false && T >= 16)
    for (let y = area.y; y < y1; y++)
      for (let x = area.x; x < x1; x++) {
        rect(img, px(x), py(y), T, 1, [0, 0, 0, 255], 0.12);
        rect(img, px(x), py(y) + 1, 1, T - 1, [0, 0, 0, 255], 0.12);
      }
  // Rulers: absolute coordinates every `labelEvery` tiles, with a stronger line.
  for (let x = area.x; x < x1; x++) {
    if (x % labelEvery !== 0 && x !== area.x) continue;
    drawText(img, String(x), px(x) + 1, 2, 1, RULER);
    rect(img, px(x), top, 1, area.h * T, [0, 0, 0, 255], 0.35);
  }
  for (let y = area.y; y < y1; y++) {
    if (y % labelEvery !== 0 && y !== area.y) continue;
    drawText(img, String(y), 2, py(y) + 1, 1, RULER);
    rect(img, left, py(y), area.w * T, 1, [0, 0, 0, 255], 0.35);
  }

  const legend: string[] = [];
  if (opts.overlays !== false) {
    const inArea = (x: number, y: number): boolean => rectContains(area, x, y);
    const th = Math.max(1, T >> 4);
    for (const isl of world.islands.values()) {
      for (const z of isl.zones) {
        if (!z.floors.includes(floor)) continue;
        const c = ZONE_COLORS[z.type] ?? RULER;
        for (const r of z.rects) {
          const rx0 = Math.max(r.x, area.x);
          const ry0 = Math.max(r.y, area.y);
          const rx1 = Math.min(r.x + r.w, x1);
          const ry1 = Math.min(r.y + r.h, y1);
          if (rx0 >= rx1 || ry0 >= ry1) continue;
          rect(img, px(rx0), py(ry0), (rx1 - rx0) * T, (ry1 - ry0) * T, c, 0.18);
          outline(img, px(r.x), py(r.y), r.w * T, r.h * T, th * 2, c);
        }
      }
      for (const s of isl.spawns) {
        if (s.center.z !== floor) continue;
        const cx = px(s.center.x) + T / 2;
        const cy = py(s.center.y) + T / 2;
        const rad = (s.radius + 0.5) * T;
        const steps = Math.ceil(rad * 8);
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          rect(
            img,
            Math.round(cx + Math.cos(a) * rad),
            Math.round(cy + Math.sin(a) * rad),
            th * 2,
            th * 2,
            SPAWN,
          );
        }
        if (inArea(s.center.x, s.center.y))
          rect(img, cx - T / 4, cy - T / 4, T / 2, T / 2, SPAWN, 0.8);
      }
      for (const n of isl.npcs) {
        if (n.pos.z !== floor || !inArea(n.pos.x, n.pos.y)) continue;
        const cx = px(n.pos.x) + T / 2;
        const cy = py(n.pos.y) + T / 2;
        const r = T / 2 - 1;
        for (let dy = -r; dy <= r; dy++) {
          const w = r - Math.abs(dy);
          rect(img, Math.round(cx - w), Math.round(cy + dy), Math.max(1, 2 * w), 1, NPC, 0.9);
        }
      }
      for (const p of isl.portals) {
        if (p.from.z !== floor || !inArea(p.from.x, p.from.y)) continue;
        outline(img, px(p.from.x) + 1, py(p.from.y) + 1, T - 2, T - 2, th * 2, PORTAL);
        const down = p.to.z > p.from.z;
        const cx = px(p.from.x) + T / 2;
        // A small triangle: pointing down for portals that descend, up otherwise.
        for (let i = 0; i < T / 4; i++)
          rect(
            img,
            Math.round(cx - i),
            py(p.from.y) + (down ? (3 * T) / 4 - i : T / 4 + i),
            Math.max(1, 2 * i),
            1,
            PORTAL,
          );
      }
      for (const t of isl.texts) {
        if (t.pos.z !== floor || !inArea(t.pos.x, t.pos.y)) continue;
        outline(img, px(t.pos.x) + T / 4, py(t.pos.y) + T / 4, T / 2, T / 2, th, TEXT);
      }
      const tp = isl.meta.temple;
      if (tp.z === floor && inArea(tp.x, tp.y)) {
        const cx = px(tp.x);
        const cy = py(tp.y);
        rect(img, cx + T / 2 - th * 2, cy + 2, th * 4, T - 4, TEXT);
        rect(img, cx + 2, cy + T / 2 - th * 2, T - 4, th * 4, TEXT);
      }
    }
    legend.push(
      "red ring + square: spawn (radius, centre)",
      "yellow diamond: NPC",
      "magenta square: portal (triangle down = goes down, up = goes up)",
      "white cross: temple",
      "white small square: sign/book",
      "tinted rectangles: zones (cyan protection, orange no_logout, red pvp, green no_pvp, purple community_plot)",
    );
  }
  legend.push(`rulers: absolute x (top) and y (left) every ${labelEvery} tiles; ${T} px per tile`);
  if (missing.size > 0) legend.push("magenta: item with no sprite");
  return {
    png: encodePng(img),
    width: img.width,
    height: img.height,
    tile: T,
    legend,
    missing: [...missing].sort(),
  };
}
