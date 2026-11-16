// Atlas.load with fake requests (no network, no GPU): each request retries on its own and
// the load rejects only when one runs out of attempts.
import { Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { Atlas } from "./atlas.ts";
import type { AtlasIndex, AtlasLoadOptions } from "./atlas.ts";

const BASE = "http://game.test/atlas/";

const INDEX: AtlasIndex = {
  version: 1,
  tileSize: 32,
  pages: ["atlas-0.json"],
  sprites: { "ground/grass": { page: 0, origin: "test" } },
};

const PAGE = {
  frames: {
    "ground/grass": {
      frame: { x: 32, y: 0, w: 32, h: 32 },
      sourceSize: { w: 32, h: 32 },
      spriteSourceSize: { x: 0, y: 0, w: 32, h: 32 },
    },
  },
  meta: { image: "atlas-0.png", size: { w: 64, h: 32 }, scale: 1 },
};

/**
 * Fake requests: `fails[url]` is how many times that URL fails before it answers. Records
 * every request in order.
 */
function fakeServer(fails: Record<string, number>): {
  requests: string[];
  waits: number[];
  opts: AtlasLoadOptions & { json: (url: string) => Promise<unknown> };
} {
  const requests: string[] = [];
  const waits: number[] = [];
  const left = new Map(Object.entries(fails));
  const answer = <T>(url: string, value: () => T): Promise<T> => {
    requests.push(url.slice(BASE.length));
    const n = left.get(url) ?? 0;
    if (n > 0) {
      left.set(url, n - 1);
      return Promise.reject(new TypeError(`Failed to fetch ${url}`));
    }
    return Promise.resolve(value());
  };
  return {
    requests,
    waits,
    opts: {
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      json: (url) =>
        answer(url, () => {
          if (url === `${BASE}atlas.json`) return INDEX;
          if (url === `${BASE}atlas-0.json`) return PAGE;
          throw new Error(`unexpected ${url}`);
        }),
      // Any texture will do: the frames are only cut from it, never drawn on a GPU.
      image: (url) => answer(url, () => new Texture({ source: Texture.WHITE.source })),
    },
  };
}

describe("Atlas.load", () => {
  it("loads the index, each page and its image once when nothing fails", async () => {
    const s = fakeServer({});
    const atlas = await Atlas.load(BASE, s.opts);
    expect(s.requests).toEqual(["atlas.json", "atlas-0.json", "atlas-0.png"]);
    expect(s.waits).toEqual([]);
    expect(atlas.tileSize).toBe(32);
    expect(atlas.has("ground/grass")).toBe(true);
    expect(atlas.icon("ground/grass")).toMatchObject({ url: `${BASE}atlas-0.png`, x: 32, y: 0 });
  });

  it("retries a failed index, page and image on their own", async () => {
    const s = fakeServer({
      [`${BASE}atlas.json`]: 1,
      [`${BASE}atlas-0.json`]: 2,
      [`${BASE}atlas-0.png`]: 1,
    });
    const atlas = await Atlas.load(BASE, s.opts);
    expect(atlas.has("ground/grass")).toBe(true);
    // What already arrived is not asked for again.
    expect(s.requests).toEqual([
      "atlas.json",
      "atlas.json",
      "atlas-0.json",
      "atlas-0.json",
      "atlas-0.json",
      "atlas-0.png",
      "atlas-0.png",
    ]);
    expect(s.waits).toEqual([500, 500, 1000, 500]);
  });

  it("rejects when a request keeps failing, after its last attempt", async () => {
    const s = fakeServer({ [`${BASE}atlas-0.png`]: 99 });
    await expect(Atlas.load(BASE, s.opts)).rejects.toThrow("Failed to fetch");
    expect(s.requests.filter((r) => r === "atlas-0.png")).toHaveLength(4);
    expect(s.waits).toEqual([500, 1000, 2000]);
  });

  it("does not retry an atlas of another version", async () => {
    const s = fakeServer({});
    const json = s.opts.json;
    await expect(
      Atlas.load(BASE, {
        ...s.opts,
        json: (url) =>
          url.endsWith("atlas.json") ? Promise.resolve({ ...INDEX, version: 2 }) : json(url),
      }),
    ).rejects.toThrow("unsupported atlas version 2");
    expect(s.waits).toEqual([]);
  });
});
