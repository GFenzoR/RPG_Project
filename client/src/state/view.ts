// The server's window (pure, unit-tested): how many tiles around the player the server
// keeps this client up to date with (Welcome.view_width/view_height, docs/05).

/** A view in tiles: the server's window, or the part of it a canvas shows. */
export interface ViewTiles {
  readonly width: number;
  readonly height: number;
}

/**
 * The classic view: the window of a server from before the wide view (a Welcome without
 * view_width), and what the fitted view never gives up for a legible tile
 * (render/viewport.ts pixelScale).
 */
export const CLASSIC_VIEW: ViewTiles = { width: 15, height: 11 };

/** The largest window the client accepts from a server (a junk Welcome falls back). */
export const MAX_VIEW: ViewTiles = { width: 63, height: 63 };

/** The server's window from Welcome (0 or junk: a server from before the wide view). */
export function serverView(width: number, height: number): ViewTiles {
  const ok = (n: number, max: number): boolean => Number.isInteger(n) && n > 0 && n <= max;
  return ok(width, MAX_VIEW.width) && ok(height, MAX_VIEW.height)
    ? { width, height }
    : CLASSIC_VIEW;
}
