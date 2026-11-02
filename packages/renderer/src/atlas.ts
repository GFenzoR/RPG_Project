// Loads the atlas built by tools/spritepack (assets/atlas/atlas.json + atlas-N.json/png)
// into PixiJS textures. The renderer only knows sprite paths ("ground/grass"); mapping an
// item ID to its sprite is the caller's job (it comes from data/items).
import { Assets, Spritesheet, Texture } from "pixi.js";
import type { SpritesheetData } from "pixi.js";

/** Same shape as AtlasIndex in tools/spritepack (that package is Node-only). */
export interface AtlasIndex {
  version: 1;
  tileSize: number;
  /** Page JSON files, relative to atlas.json. */
  pages: string[];
  sprites: Record<string, { page: number; origin: string }>;
}

export class Atlas {
  readonly tileSize: number;
  readonly index: AtlasIndex;
  private readonly textures = new Map<string, Texture>();

  private constructor(index: AtlasIndex) {
    this.index = index;
    this.tileSize = index.tileSize;
  }

  /** Loads atlas.json from `baseUrl` (a directory URL ending in "/") and every page. */
  static async load(baseUrl: string): Promise<Atlas> {
    const index = (await (await fetch(new URL("atlas.json", baseUrl))).json()) as AtlasIndex;
    if (index.version !== 1) throw new Error(`unsupported atlas version ${String(index.version)}`);
    const atlas = new Atlas(index);
    for (const page of index.pages) {
      const url = new URL(page, baseUrl);
      const data = (await (await fetch(url)).json()) as SpritesheetData;
      const image = await Assets.load<Texture>({
        src: new URL(data.meta.image ?? "", url).href,
        data: { scaleMode: "nearest" },
        parser: "loadTextures",
      });
      const sheet = new Spritesheet(image, data);
      await sheet.parse();
      for (const [name, tex] of Object.entries(sheet.textures)) atlas.textures.set(name, tex);
    }
    return atlas;
  }

  /** Texture of a sprite path, or undefined when the atlas does not have it. */
  texture(sprite: string): Texture | undefined {
    return this.textures.get(sprite);
  }

  has(sprite: string): boolean {
    return this.textures.has(sprite);
  }
}

/** Texture for sprites the atlas does not have: plain white, tinted by the caller. */
export const MISSING_TEXTURE = Texture.WHITE;
