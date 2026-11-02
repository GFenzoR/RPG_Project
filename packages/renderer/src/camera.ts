// Camera math for a top-down tile map. Pure functions over plain data, no PixiJS, so the
// client and the editor share them and they are unit-tested in Node.
//
// World space is measured in tiles: (x, y) is the top-left corner of tile (x, y).
// Screen space is CSS pixels relative to the view's top-left corner.

export const CHUNK_TILES = 32;

export interface Camera {
  /** World tile coordinate shown at the screen's top-left corner (may be fractional). */
  x: number;
  y: number;
  /** Screen pixels per sprite pixel (1 = a tile is tileSize pixels wide). */
  zoom: number;
}

export interface ViewSize {
  width: number;
  height: number;
}

export interface ChunkRange {
  cx0: number;
  cy0: number;
  /** Inclusive. */
  cx1: number;
  cy1: number;
}

export const MIN_ZOOM = 0.125;
export const MAX_ZOOM = 4;

export const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Screen pixels per tile. */
export const tilePixels = (cam: Camera, tileSize: number): number => tileSize * cam.zoom;

/** World position (fractional tiles) under a screen point. */
export function screenToWorld(
  cam: Camera,
  sx: number,
  sy: number,
  tileSize: number,
): { x: number; y: number } {
  const p = tilePixels(cam, tileSize);
  return { x: cam.x + sx / p, y: cam.y + sy / p };
}

/** Integer tile under a screen point. */
export function screenToTile(
  cam: Camera,
  sx: number,
  sy: number,
  tileSize: number,
): { x: number; y: number } {
  const w = screenToWorld(cam, sx, sy, tileSize);
  return { x: Math.floor(w.x), y: Math.floor(w.y) };
}

/** Screen position of a tile's top-left corner. */
export function tileToScreen(
  cam: Camera,
  x: number,
  y: number,
  tileSize: number,
): { x: number; y: number } {
  const p = tilePixels(cam, tileSize);
  return { x: (x - cam.x) * p, y: (y - cam.y) * p };
}

/** Zooms by `factor`, keeping the world point under (sx, sy) fixed on screen. */
export function zoomAt(
  cam: Camera,
  factor: number,
  sx: number,
  sy: number,
  tileSize: number,
): Camera {
  const zoom = clampZoom(cam.zoom * factor);
  const anchor = screenToWorld(cam, sx, sy, tileSize);
  const p = tileSize * zoom;
  return { x: anchor.x - sx / p, y: anchor.y - sy / p, zoom };
}

/** Moves the camera by a screen-space drag delta. */
export function pan(cam: Camera, dx: number, dy: number, tileSize: number): Camera {
  const p = tilePixels(cam, tileSize);
  return { x: cam.x - dx / p, y: cam.y - dy / p, zoom: cam.zoom };
}

/** Camera that shows tile (x, y) in the middle of the view. */
export function centerOn(
  cam: Camera,
  x: number,
  y: number,
  view: ViewSize,
  tileSize: number,
): Camera {
  const p = tilePixels(cam, tileSize);
  return { x: x + 0.5 - view.width / 2 / p, y: y + 0.5 - view.height / 2 / p, zoom: cam.zoom };
}

/**
 * Chunks that intersect the view, plus `margin` tiles around it (sprites bigger than a
 * tile are drawn up and to the left of their tile, so the margin keeps them visible).
 */
export function visibleChunks(
  cam: Camera,
  view: ViewSize,
  tileSize: number,
  margin = 2,
): ChunkRange {
  const p = tilePixels(cam, tileSize);
  const x0 = cam.x - margin;
  const y0 = cam.y - margin;
  const x1 = cam.x + view.width / p + margin;
  const y1 = cam.y + view.height / p + margin;
  return {
    cx0: Math.floor(x0 / CHUNK_TILES),
    cy0: Math.floor(y0 / CHUNK_TILES),
    cx1: Math.floor(x1 / CHUNK_TILES),
    cy1: Math.floor(y1 / CHUNK_TILES),
  };
}
