import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import {
  CROSS,
  LOOKS,
  MARGIN,
  MAX_IN,
  MAX_OUT,
  MAX_STEP,
  MIN_GAP,
  PIECES,
  SIDES,
  SURF_FRAMES,
  SURF_REACH,
  WET,
  borderSprites,
  coverMask,
  fringeSprite,
  groundArt,
  lookSprite,
  pngsUnder,
  profile,
  surfSprite,
} from "./gen-borders.ts";
import type { Piece } from "./gen-borders.ts";
import { decodePng } from "./image.ts";
import type { Image, Rgba } from "./image.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const T = 32;
const sprites = borderSprites(repo);
const ladder = (
  parse(readFileSync(join(repo, "data/borders.yaml"), "utf8")) as {
    ladder: { ground: string; pieces?: string }[];
  }
).ladder;
const fringes = ladder.filter((s) => s.pieces);

/**
 * What a look of a piece covers along each side of the tile (alpha of the sprite, or the
 * mask): none, all, the first n pixels (from the north or west end) or the last n.
 */
function sides(covered: (x: number, y: number) => boolean): Record<string, string> {
  const sig = (line: boolean[]): string => {
    const n = line.filter(Boolean).length;
    if (n === 0) return "none";
    if (n === T) return "all";
    if (line.slice(0, n).every(Boolean)) return `first ${n}`;
    if (line.slice(T - n).every(Boolean)) return `last ${n}`;
    return "broken";
  };
  const along = (f: (t: number) => boolean): boolean[] => Array.from({ length: T }, (_, t) => f(t));
  return {
    n: sig(along((x) => covered(x, 0))),
    e: sig(along((y) => covered(T - 1, y))),
    s: sig(along((x) => covered(x, T - 1))),
    w: sig(along((y) => covered(0, y))),
  };
}

/**
 * The continuity contract (docs/06 "Bordes"): where each piece crosses each side of the tile.
 * Neighbours that meet on a side always agree, so any look meets any look.
 */
const C = `first ${CROSS}`;
const L = `last ${CROSS}`;
const CONTRACT: Record<Piece, Record<string, string>> = {
  n: { n: "all", e: C, s: "none", w: C },
  e: { n: L, e: "all", s: L, w: "none" },
  s: { n: "none", e: L, s: "all", w: L },
  w: { n: C, e: "none", s: C, w: "all" },
  nw: { n: C, e: "none", s: "none", w: C },
  ne: { n: L, e: C, s: "none", w: "none" },
  se: { n: "none", e: L, s: L, w: "none" },
  sw: { n: "none", e: "none", s: C, w: L },
  inner_nw: { n: "all", e: C, s: C, w: "all" },
  inner_ne: { n: "all", e: "all", s: L, w: C },
  inner_se: { n: L, e: "all", s: "all", w: L },
  inner_sw: { n: C, e: L, s: "all", w: "all" },
};

const png = (name: string): Image => decodePng(sprites.get(name) as Buffer);
const alpha = (img: Image) => (x: number, y: number) => (img.data[(y * T + x) * 4 + 3] ?? 0) > 0;

/** Mean L* (CIELAB) of the opaque pixels of an image. */
function meanL(img: Image): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  let sum = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] === 0) continue;
    const y =
      0.2126 * lin(img.data[i] ?? 0) +
      0.7152 * lin(img.data[i + 1] ?? 0) +
      0.0722 * lin(img.data[i + 2] ?? 0);
    sum += y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
    n++;
  }
  return sum / n;
}

describe("gen-borders", () => {
  it("committed border sprites are what the generator produces, and nothing else", () => {
    // Every fringe: 12 pieces in LOOKS looks; the surf: 12 pieces x LOOKS looks x its frames.
    expect(sprites.size).toBe(fringes.length * 12 * LOOKS + 12 * LOOKS * SURF_FRAMES);
    for (const [sprite, bytes] of sprites)
      expect([
        sprite,
        readFileSync(join(repo, "assets/sprites", `${sprite}.png`)).equals(bytes),
      ]).toEqual([sprite, true]);
    const base = join(repo, "assets/sprites");
    expect(pngsUnder(join(base, "borders"), base).filter((p) => !sprites.has(p))).toEqual([]);
  });

  it("bends every edge, pinned at CROSS on the sides of the tile, without steps", () => {
    const shapes = new Set<string>();
    for (const side of SIDES)
      for (let look = 0; look < LOOKS; look++) {
        const p = profile(side, look);
        expect(p).toHaveLength(T);
        expect([p[0], p[T - 1]]).toEqual([CROSS, CROSS]);
        for (let t = 1; t < T; t++)
          expect(Math.abs((p[t] as number) - (p[t - 1] as number))).toBeLessThanOrEqual(MAX_STEP);
        expect(Math.min(...p)).toBeGreaterThanOrEqual(CROSS - MAX_OUT);
        expect(Math.max(...p)).toBeLessThanOrEqual(CROSS + MAX_IN);
        // Never straight (docs/17 ART-4): at least 3 px between its deepest and shallowest.
        expect(Math.max(...p) - Math.min(...p)).toBeGreaterThanOrEqual(3);
        shapes.add(p.join());
      }
    // Every look of every side is its own.
    expect(shapes.size).toBe(SIDES.length * LOOKS);
    // A path one tile wide is never pinched shut by the fringes on both sides of it.
    for (let look = 0; look < LOOKS; look++)
      for (const [a, b] of [
        ["n", "s"],
        ["w", "e"],
      ] as const)
        for (let t = 0; t < T; t++)
          expect(
            (profile(a, look)[t] as number) + (profile(b, look)[t] as number),
          ).toBeLessThanOrEqual(T - MIN_GAP);
  });

  it("meets every neighbour at the same points whatever the look (the contract)", () => {
    for (const piece of PIECES) {
      const looks = new Set<string>();
      for (let look = 0; look < LOOKS; look++) {
        const mask = coverMask(piece, look);
        expect([piece, look, sides((x, y) => mask[y * T + x] === 1)]).toEqual([
          piece,
          look,
          CONTRACT[piece],
        ]);
        looks.add(mask.join(""));
      }
      expect(looks.size, piece).toBe(LOOKS); // four different shapes
    }
  });

  it("keeps every fringe's marks off the sides, so its sprites keep the contract", () => {
    for (const step of fringes)
      for (const piece of PIECES)
        for (let look = 0; look < LOOKS; look++) {
          const name = lookSprite(`borders/${step.ground}/${piece}`, look);
          const img = png(name);
          expect([name, sides(alpha(img))]).toEqual([name, CONTRACT[piece]]);
          // Marks (tufts, pebbles, grains) only past MARGIN from the sides.
          const mask = coverMask(piece, look);
          for (let y = 0; y < T; y++)
            for (let x = 0; x < T; x++) {
              if (x >= MARGIN && y >= MARGIN && x < T - MARGIN && y < T - MARGIN) continue;
              expect(alpha(img)(x, y)).toBe(mask[y * T + x] === 1);
            }
        }
  });

  it("draws each style's marks by the edge: tufts on grass, pebbles on sand, none on plain", () => {
    const outside = (ground: string, piece: Piece): number => {
      let n = 0;
      for (let look = 0; look < LOOKS; look++) {
        const img = png(lookSprite(`borders/${ground}/${piece}`, look));
        const mask = coverMask(piece, look);
        for (let i = 0; i < T * T; i++) if ((img.data[i * 4 + 3] ?? 0) > 0 && !mask[i]) n++;
      }
      return n;
    };
    expect(outside("grass", "n")).toBeGreaterThan(8); // blades over the dirt
    expect(outside("sand", "n")).toBeGreaterThan(0); // pebbles
    expect(outside("dirt", "s")).toBeGreaterThan(0); // clods
    // A plain fringe draws only its ground.
    const flat = groundArt(() => [100, 90, 80, 255]);
    const img = fringeSprite("n", 0, flat, "plain");
    const mask = coverMask("n", 0);
    for (let i = 0; i < T * T; i++) expect((img.data[i * 4 + 3] ?? 0) > 0).toBe(mask[i] === 1);
  });

  it("keeps the fringes in the value band of the grounds (docs/17 ART-6, L* 20-50)", () => {
    for (const step of fringes)
      for (const piece of PIECES)
        for (let look = 0; look < LOOKS; look++) {
          const name = lookSprite(`borders/${step.ground}/${piece}`, look);
          const l = meanL(png(name));
          expect(l, name).toBeGreaterThanOrEqual(20);
          expect(l, name).toBeLessThanOrEqual(50);
        }
  });

  it("cuts a fringe from its ground's own art (spritegen), not a grey fallback", () => {
    const ash = decodePng(readFileSync(join(repo, "assets/sprites/ground/ash.png")));
    const piece = png("borders/ash/n");
    // A pixel deep in the piece (far from its rim) is the ash pixel at the same spot.
    const i = (2 * T + 16) * 4;
    expect([...piece.data.subarray(i, i + 4)]).toEqual([...ash.data.subarray(i, i + 3), 255]);
  });

  it("rolls the surf in over its frames, all of it on the water side (docs/17 ART-7)", () => {
    for (const piece of PIECES)
      for (let look = 0; look < LOOKS; look++) {
        const mask = coverMask(piece, look);
        const frames = Array.from({ length: SURF_FRAMES }, (_, f) => surfSprite(piece, look, f));
        const key = (img: Image): string => Buffer.from(img.data).toString("hex");
        expect(new Set(frames.map(key)).size).toBe(SURF_FRAMES);
        for (const img of frames) {
          const opaque = alpha(img);
          for (let y = 0; y < T; y++)
            for (let x = 0; x < T; x++) if (mask[y * T + x]) expect(opaque(x, y)).toBe(false);
        }
        // The wet edge of the land lies right outside the edge, in every frame.
        const wet = new Set(WET.map((c: Rgba) => c.join()));
        const still = frames[0] as Image;
        let wetPixels = 0;
        for (let i = 0; i < T * T; i++)
          if (wet.has([...still.data.subarray(i * 4, i * 4 + 4)].join())) wetPixels++;
        if (piece.length === 1 || piece.startsWith("inner"))
          expect(wetPixels).toBeGreaterThan(T / 2);
      }
    // The files: frame_1..frame_<n-1> of every look of every surf piece, none for fringes.
    expect(sprites.has(`borders/surf/n/frame_${SURF_FRAMES - 1}`)).toBe(true);
    expect(sprites.has(`borders/surf/inner_se/var_${LOOKS - 1}/frame_1`)).toBe(true);
    expect(sprites.has("borders/sand/n/frame_1")).toBe(false);
    expect(SURF_REACH).toBeLessThan(CROSS);
  });
});
