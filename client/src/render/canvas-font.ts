// The pixel font of the game canvas (docs/17 UI-3): creature names, guild lines and the
// floating numbers are Pixelify Sans (OFL, assets/vendor/font-pixelifysans/), served like
// the UI fonts by vite/fonts.ts and declared in ui/fonts.css.
//
// Its outlines are drawn on a grid of 1/11 em (capitals 7 cells tall, lower case 5): at
// 11 px a cell is a screen pixel, so the strokes are one pixel thick and the rows of a
// letter are whole pixels tall. It is not pixel perfect across: every letter starts 0.66 px
// into its place and the advances are not whole cells (H moves on 586/1000 em, 6.45 px), so
// the columns fall between pixels and the canvas smooths them a little
// (vite/canvas-font.test.ts measures it). The black 3 px stroke of before goes round them.
//
// Pixi measures and rasterises a Text once; one drawn before the font arrived keeps the
// system fallback (and CanvasTextMetrics caches the fallback's ascent per font string). So
// the canvas waits for the font before its first Text, and if it arrives after the wait,
// `onLate` lets the caller clear the metrics and redraw the labels it keeps.

/** The family name of @font-face in ui/fonts.css (and FONTS in vite/fonts.ts). */
export const CANVAS_FONT_FAMILY = "Pixelify Sans";
/** TextStyle.fontFamily of every canvas label: the pixel font, the system sans until it loads. */
export const CANVAS_FONT = `${CANVAS_FONT_FAMILY}, sans-serif`;
/** px: one cell of the font's grid per screen pixel. Names, guild lines and numbers. */
export const CANVAS_FONT_SIZE = 11;
/** The outline around every canvas label, px (black, or a name effect's colour). */
export const CANVAS_TEXT_STROKE = 3;
/** How long the canvas waits for the font before it draws with the fallback, ms. */
export const CANVAS_FONT_WAIT_MS = 2500;

/** The part of FontFaceSet (document.fonts) the canvas uses. */
export interface FontLoader {
  load(font: string): Promise<unknown>;
}

export interface CanvasFontOptions {
  /** ms to wait (default CANVAS_FONT_WAIT_MS). */
  waitMs?: number;
  /** setTimeout, injectable for the tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Called once if the font loads after the wait gave up: re-measure what was drawn. */
  onLate?: () => void;
}

/**
 * Asks the browser for the canvas font. Resolves true when it is ready within the wait,
 * false when there is no FontFaceSet (tests, old engines), the load failed or the wait ran
 * out; in the last case `onLate` runs if it still arrives. Never rejects.
 */
export function loadCanvasFont(
  fonts: FontLoader | undefined,
  opts: CanvasFontOptions = {},
): Promise<boolean> {
  if (!fonts) return Promise.resolve(false);
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    setTimer(() => settle(false), opts.waitMs ?? CANVAS_FONT_WAIT_MS);
    let loading: Promise<unknown>;
    try {
      loading = fonts.load(`${CANVAS_FONT_SIZE}px "${CANVAS_FONT_FAMILY}"`);
    } catch {
      settle(false);
      return;
    }
    loading.then(
      (faces) => {
        // An empty list: no @font-face matched (nothing to wait for, nothing to redraw).
        const ok = !Array.isArray(faces) || faces.length > 0;
        if (settled) {
          if (ok) opts.onLate?.();
          return;
        }
        settle(ok);
      },
      () => settle(false),
    );
  });
}
