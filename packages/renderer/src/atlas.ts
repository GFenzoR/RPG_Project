// Loads the atlas built by tools/spritepack (assets/atlas/atlas.json + atlas-N.json/png)
// into PixiJS textures. The renderer only knows sprite paths ("ground/grass"); mapping an
// item ID to its sprite is the caller's job (it comes from data/items).
// Every request (the index, each page's JSON and its image) retries on its own with
// retry.ts's policy: one failed request on a flaky network does not lose the atlas, and
// within one load a request that succeeded is not repeated. Only after the last attempt
// does load reject; the client and the editor then show the error with a "Retry" button,
// a new load: it fetches atlas.json and the page JSON files again, and only the page
// images already loaded come from PixiJS Assets' cache.
import { Assets, Spritesheet, Texture } from "pixi.js";
import type { SpritesheetData } from "pixi.js";
import type { AnimMeta } from "./anim.ts";
import { fetchJSON, withRetry } from "./retry.ts";
import type { Fetcher, RetryOptions } from "./retry.ts";

/** Same shape as AtlasIndex in tools/spritepack (that package is Node-only). */
export interface AtlasIndex {
  version: 1;
  tileSize: number;
  /** Page JSON files, relative to atlas.json. */
  pages: string[];
  sprites: Record<string, { page: number; origin: string }>;
  /** Animated and hinted creature sprites (docs/17 ANI); absent in atlases built before them. */
  anims?: Record<string, AnimMeta>;
}

/** A sprite's rectangle in its page image (pixels). */
export interface AtlasIcon {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Atlas {
  readonly tileSize: number;
  readonly index: AtlasIndex;
  private readonly textures = new Map<string, Texture>();
  /** Image URL of the page each sprite is on (for DOM icons). */
  private readonly pageImage = new Map<string, string>();

  private constructor(index: AtlasIndex) {
    this.index = index;
    this.tileSize = index.tileSize;
  }

  /**
   * Loads atlas.json from `baseUrl` (a directory URL ending in "/") and every page, each
   * request with its retries (`opts`, retry.ts). Rejects with the last error of the first
   * request that runs out of attempts.
   */
  static async load(baseUrl: string, opts: AtlasLoadOptions = {}): Promise<Atlas> {
    const json = opts.json ?? ((url: string) => fetchJSON(url, opts.fetcher));
    const image = opts.image ?? loadPageImage;
    const indexUrl = new URL("atlas.json", baseUrl).href;
    const index = (await withRetry(() => json(indexUrl), opts)) as AtlasIndex;
    if (index.version !== 1) throw new Error(`unsupported atlas version ${String(index.version)}`);
    const atlas = new Atlas(index);
    for (const page of index.pages) {
      const url = new URL(page, baseUrl).href;
      const data = (await withRetry(() => json(url), opts)) as SpritesheetData;
      const imageUrl = new URL(data.meta.image ?? "", url).href;
      const texture = await withRetry(() => image(imageUrl), opts);
      const sheet = new Spritesheet(texture, data);
      await sheet.parse();
      for (const [name, tex] of Object.entries(sheet.textures)) {
        atlas.textures.set(name, tex);
        atlas.pageImage.set(name, imageUrl);
      }
    }
    return atlas;
  }

  /** Texture of a sprite path, or undefined when the atlas does not have it. */
  texture(sprite: string): Texture | undefined {
    return this.textures.get(sprite);
  }

  /**
   * Where a sprite is in its page image, for drawing it outside PixiJS (a DOM icon as a
   * CSS background). Undefined when the atlas does not have it.
   */
  icon(sprite: string): AtlasIcon | undefined {
    const tex = this.textures.get(sprite);
    const url = this.pageImage.get(sprite);
    if (!tex || !url) return undefined;
    const f = tex.frame;
    return { url, x: f.x, y: f.y, width: f.width, height: f.height };
  }

  has(sprite: string): boolean {
    return this.textures.has(sprite);
  }
}

/** How Atlas.load fetches and retries (the defaults are the browser's; tests pass fakes). */
export interface AtlasLoadOptions extends RetryOptions {
  /** Fetches atlas.json and the page JSON files (default: fetchJSON with `fetcher`). */
  json?: ((url: string) => Promise<unknown>) | undefined;
  /** The fetch behind the default `json`. */
  fetcher?: Fetcher | undefined;
  /** Loads a page image as a texture (default: PixiJS Assets, nearest scale mode). */
  image?: ((url: string) => Promise<Texture>) | undefined;
}

/**
 * A page image through PixiJS Assets. A failed load leaves nothing in Assets' cache
 * (its loader drops the rejected promise), so the next attempt fetches it again.
 */
const loadPageImage = (url: string): Promise<Texture> =>
  Assets.load<Texture>({ src: url, data: { scaleMode: "nearest" }, parser: "loadTextures" });

/** Texture for sprites the atlas does not have: plain white, tinted by the caller. */
export const MISSING_TEXTURE = Texture.WHITE;
