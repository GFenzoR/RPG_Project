// The paper doll drawn outside the game (docs/02 "Apariencia"): the live figure of the
// creation screen and of the Apariencia window, turning and walking in place. No PixiJS
// (the creation screen has no game canvas): the frames of the sprite atlas (/atlas/, the
// same the game draws) go onto a 2D canvas, each layer tinted like the game's multiply
// (render/creature-body.ts), in the game's order (packages/renderer look.ts lookLayers).
// The data part is pure and tested; drawing takes any 2D context.
import type { AnimAction, AnimDir, AnimMeta } from "@rpg/renderer";
import { lookLayers } from "@rpg/renderer/look";
import type { LayerDraw, Look, LookTables, Worn } from "@rpg/renderer/look";
import { fetchJSONWithRetry } from "@rpg/renderer/retry";

/** A frame of the atlas: where it is in its page, and where it sits in the whole frame. */
export interface PreviewFrame {
  page: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Its place inside the whole frame (trimmed frames), and the whole frame's size. */
  ox: number;
  oy: number;
  sw: number;
  sh: number;
}

/** What the preview needs of the atlas: the humanoid layers' frames and their clips. */
export interface PreviewAtlas {
  frames: ReadonlyMap<string, PreviewFrame>;
  anims: Readonly<Record<string, AnimMeta>>;
}

/** The atlas page JSON (tools/spritepack AtlasPageJson), as much as the preview reads. */
interface PageJson {
  frames?: Record<
    string,
    {
      frame: { x: number; y: number; w: number; h: number };
      spriteSourceSize?: { x: number; y: number };
      sourceSize?: { w: number; h: number };
    }
  >;
  meta?: { image?: string };
}

/** Only the paper doll's layers (the body's own and the worn pieces). */
const LAYER_PREFIXES = ["humans/", "worn/"];

/** The frames of one atlas page (pageUrl: the page JSON's URL) that the doll uses. */
export function pageFrames(pageUrl: string, data: PageJson, into: Map<string, PreviewFrame>): void {
  const page = new URL(data.meta?.image ?? "", pageUrl).href;
  for (const [name, f] of Object.entries(data.frames ?? {})) {
    if (!LAYER_PREFIXES.some((p) => name.startsWith(p)) || into.has(name)) continue;
    into.set(name, {
      page,
      x: f.frame.x,
      y: f.frame.y,
      w: f.frame.w,
      h: f.frame.h,
      ox: f.spriteSourceSize?.x ?? 0,
      oy: f.spriteSourceSize?.y ?? 0,
      sw: f.sourceSize?.w ?? f.frame.w,
      sh: f.sourceSize?.h ?? f.frame.h,
    });
  }
}

let loading: Promise<PreviewAtlas> | undefined;

/**
 * The atlas at `base` (/atlas/ of the site's root by default), fetched once per page with
 * the game's retries; a failure lets a later call try again.
 */
export function loadPreviewAtlas(base?: string): Promise<PreviewAtlas> {
  loading ??= (async () => {
    const root = base ?? new URL("/atlas/", document.baseURI).href;
    const index = (await fetchJSONWithRetry(new URL("atlas.json", root).href)) as {
      pages?: string[];
      anims?: Record<string, AnimMeta>;
    };
    const frames = new Map<string, PreviewFrame>();
    for (const p of index.pages ?? []) {
      const url = new URL(p, root).href;
      pageFrames(url, (await fetchJSONWithRetry(url)) as PageJson, frames);
    }
    return { frames, anims: index.anims ?? {} };
  })().catch((err: unknown) => {
    loading = undefined;
    throw err;
  });
  return loading;
}

/** Facings in the order the turn buttons go through them: right turns clockwise. */
export const TURN_ORDER: readonly AnimDir[] = ["s", "w", "n", "e"];

/** The facing after turning `steps` (negative: the other way). */
export function turn(dir: AnimDir, steps: number): AnimDir {
  const i = TURN_ORDER.indexOf(dir);
  const n = TURN_ORDER.length;
  return TURN_ORDER[(((i + steps) % n) + n) % n] ?? "s";
}

/** How many frames the body's clip has (1 when the atlas does not know it). */
export function clipFrames(atlas: PreviewAtlas, look: Look, action: AnimAction): number {
  return atlas.anims[`humans/body_${look.body}`]?.actions[action]?.frames ?? 1;
}

/** One layer to draw: its frame of the atlas and its tint. */
export interface PreviewDraw {
  frame: PreviewFrame;
  tint: number;
}

/**
 * The layers of the figure for one frame, back to front, with their atlas frames: those
 * the atlas lacks are left out (an atlas without the doll draws nothing).
 */
export function previewDraws(
  atlas: PreviewAtlas,
  look: Look,
  worn: Worn,
  dir: AnimDir,
  action: AnimAction,
  frame: number,
  tables: LookTables,
): PreviewDraw[] {
  const out: PreviewDraw[] = [];
  for (const l of lookLayers(look, worn, dir, action, frame, tables) as LayerDraw[]) {
    const f = atlas.frames.get(l.frame);
    if (f) out.push({ frame: f, tint: l.tint });
  }
  return out;
}

/**
 * The part of the 64x64 frame the preview shows: every layer's standing and walking frames
 * draw inside x 13..50, y 15..61 (measured on assets/sprites humans/ and worn/), so a 48x48
 * window around them shows the figure a third bigger than the whole frame would.
 */
export const PREVIEW_VIEW = { x: 8, y: 14, w: 48, h: 48 } as const;

/** "#rrggbb" of 0xrrggbb. */
const css = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;

/** The 2D drawing calls the preview makes (a CanvasRenderingContext2D has them). */
export interface Ctx2D {
  globalCompositeOperation: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  imageSmoothingEnabled: boolean;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void;
}

/**
 * Draws the layers onto `ctx` at `scale` (whole pixels: no smoothing), the `view` of the
 * frame only, each one first on `scratch` (a canvas of at least one frame's size) where it
 * is tinted: multiplied by its tint, then cut back to its own shape (the multiply fills
 * the transparent pixels too).
 */
export function drawDoll(
  ctx: Ctx2D,
  scratch: { ctx: Ctx2D; canvas: CanvasImageSource },
  draws: readonly PreviewDraw[],
  images: (page: string) => CanvasImageSource | undefined,
  scale: number,
  width: number,
  height: number,
  view: { x: number; y: number; w: number; h: number } = PREVIEW_VIEW,
): void {
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, width, height);
  const s = scratch.ctx;
  for (const { frame: f, tint } of draws) {
    const img = images(f.page);
    if (!img) continue;
    s.globalCompositeOperation = "source-over";
    s.clearRect(0, 0, f.sw, f.sh);
    s.drawImage(img, f.x, f.y, f.w, f.h, f.ox, f.oy, f.w, f.h);
    if (tint !== 0xffffff) {
      s.globalCompositeOperation = "multiply";
      s.fillStyle = css(tint);
      s.fillRect(0, 0, f.sw, f.sh);
      s.globalCompositeOperation = "destination-in";
      s.drawImage(img, f.x, f.y, f.w, f.h, f.ox, f.oy, f.w, f.h);
    }
    ctx.drawImage(
      scratch.canvas,
      view.x,
      view.y,
      view.w,
      view.h,
      0,
      0,
      view.w * scale,
      view.h * scale,
    );
  }
  s.globalCompositeOperation = "source-over";
}
