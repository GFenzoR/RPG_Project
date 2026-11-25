// Ground variety (docs/17 ART-4): groundLook, groundTone and groundDecal in tile-art.ts.
import { describe, expect, it } from "vitest";
import {
  DECAL_DENSITY,
  MACRO_MAX_STEP,
  TILE_PART,
  TONE_DEPTH,
  decalName,
  groundDecal,
  groundTone,
  macroNoise,
  pickGroundLook,
  resolveTileArt,
  saltedHash,
  smoothNoise,
  tileHash,
} from "./tile-art.ts";

/** A field of W x H tiles from (X0, Y0) on floor 7, like a beach of Velmara. */
const X0 = 3100;
const Y0 = 6300;
const W = 120;
const H = 120;
const each = (fn: (x: number, y: number) => void): void => {
  for (let y = Y0; y < Y0 + H; y++) for (let x = X0; x < X0 + W; x++) fn(x, y);
};

describe("saltedHash", () => {
  it("is tileHash with salt 0 and unrelated values on other salts", () => {
    expect(saltedHash(12, 34, 7, 0)).toBe(tileHash(12, 34, 7));
    let same = 0;
    let corr = 0;
    each((x, y) => {
      const a = saltedHash(x, y, 7, 1);
      const b = saltedHash(x, y, 7, 2);
      if (Math.floor(a * 8) === Math.floor(b * 8)) same++;
      corr += (a - 0.5) * (b - 0.5);
    });
    expect(same / (W * H)).toBeLessThan(0.16); // about 1/8 by chance
    expect(Math.abs(corr / (W * H))).toBeLessThan(0.005);
  });

  it("does not repeat along rows, columns or diagonals", () => {
    // A weak hash shows stripes: the same bucket every k tiles. Check a few periods.
    for (const [dx, dy] of [
      [1, 0],
      [0, 1],
      [1, 1],
      [2, 0],
      [4, 0],
      [8, 0],
      [32, 0],
    ] as const) {
      let same = 0;
      each((x, y) => {
        if (Math.floor(tileHash(x, y, 7) * 10) === Math.floor(tileHash(x + dx, y + dy, 7) * 10))
          same++;
      });
      expect(same / (W * H), `period ${dx},${dy}`).toBeLessThan(0.12);
    }
  });
});

describe("macroNoise", () => {
  it("is continuous: neighbours differ by at most MACRO_MAX_STEP", () => {
    each((x, y) => {
      const v = macroNoise(x, y, 7, 5);
      expect(Math.abs(v - macroNoise(x + 1, y, 7, 5))).toBeLessThanOrEqual(MACRO_MAX_STEP + 1e-9);
      expect(Math.abs(v - macroNoise(x, y + 1, 7, 5))).toBeLessThanOrEqual(MACRO_MAX_STEP + 1e-9);
    });
    expect(MACRO_MAX_STEP).toBeLessThan(0.25);
  });

  it("spreads over areas: low and high values both show up, and it works below 0", () => {
    let low = 0;
    let high = 0;
    each((x, y) => {
      const v = macroNoise(x, y, 7, 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      if (v < 0.25) low++;
      if (v > 0.75) high++;
    });
    expect(low).toBeGreaterThan(W * H * 0.05);
    expect(high).toBeGreaterThan(W * H * 0.05);
    const n = smoothNoise(-3, -7, 7, 4, 1);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(Math.abs(n - smoothNoise(-4, -7, 7, 4, 1))).toBeLessThanOrEqual(1.5 / 4 + 1e-9);
  });
});

describe("pickGroundLook", () => {
  it("is deterministic and in range", () => {
    each((x, y) => {
      const k = pickGroundLook(x, y, 7, 10, 0.3);
      expect(k).toBe(pickGroundLook(x, y, 7, 10, 0.3));
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(10);
    });
    expect(pickGroundLook(5, 5, 7, 1)).toBe(0);
    expect(pickGroundLook(5, 5, 7, 0)).toBe(0);
  });

  it("never puts the same alternate look on two tiles side by side", () => {
    for (const count of [3, 4, 9, 12])
      each((x, y) => {
        const k = pickGroundLook(x, y, 7, count, 0.25);
        if (k === 0) return;
        expect(pickGroundLook(x + 1, y, 7, count, 0.25), `${count} at ${x},${y}`).not.toBe(k);
        expect(pickGroundLook(x, y + 1, 7, count, 0.25), `${count} at ${x},${y}`).not.toBe(k);
      });
  });

  it("rarely repeats an alternate look on a diagonal", () => {
    let pairs = 0;
    let same = 0;
    each((x, y) => {
      const k = pickGroundLook(x, y, 7, 12, 0.2);
      if (k === 0) return;
      for (const dx of [-1, 1]) {
        const n = pickGroundLook(x + dx, y + 1, 7, 12, 0.2);
        if (n === 0) continue;
        pairs++;
        if (n === k) same++;
      }
    });
    expect(pairs).toBeGreaterThan(1000);
    expect(same / pairs).toBeLessThan(0.05);
  });

  it("keeps the main look on about `weight` of the tiles and shows every look", () => {
    const counts = new Array<number>(12).fill(0);
    each((x, y) => {
      const k = pickGroundLook(x, y, 7, 12, 0.3);
      counts[k] = (counts[k] ?? 0) + 1;
    });
    const main = (counts[0] ?? 0) / (W * H);
    expect(main).toBeGreaterThan(0.22);
    expect(main).toBeLessThan(0.38);
    for (const c of counts.slice(1)) expect(c).toBeGreaterThan((W * H * 0.7) / 11 / 3);
  });

  it("makes areas lean to some looks (macro variation, not per-tile noise)", () => {
    // In each 12x12 block, a share of the alternate looks dominates; over the field all show.
    let lean = 0;
    let blocks = 0;
    for (let by = Y0; by < Y0 + H; by += 12)
      for (let bx = X0; bx < X0 + W; bx += 12) {
        const counts = new Array<number>(12).fill(0);
        let alt = 0;
        for (let y = by; y < by + 12; y++)
          for (let x = bx; x < bx + 12; x++) {
            const k = pickGroundLook(x, y, 7, 12, 0.2);
            if (k === 0) continue;
            counts[k] = (counts[k] ?? 0) + 1;
            alt++;
          }
        blocks++;
        // Uniform picking would give each of the 11 looks about 9 %: half of them ~45 %.
        const top = counts
          .slice(1)
          .sort((a, b) => b - a)
          .slice(0, 5)
          .reduce((a, b) => a + b, 0);
        if (top / alt > 0.65) lean++;
      }
    expect(lean / blocks).toBeGreaterThan(0.6);
  });
});

describe("groundTone", () => {
  const channels = (t: number): number[] => [(t >> 16) & 255, (t >> 8) & 255, t & 255];

  it("only darkens, by at most TONE_DEPTH plus the warmth, and drifts smoothly", () => {
    let minG = 255;
    let maxG = 0;
    each((x, y) => {
      const [r, g, b] = channels(groundTone(x, y, 7));
      for (const c of [r, g, b]) expect(c).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(Math.floor(255 * (1 - TONE_DEPTH)));
      minG = Math.min(minG, g ?? 0);
      maxG = Math.max(maxG, g ?? 0);
      const [r2, g2, b2] = channels(groundTone(x + 1, y, 7));
      // Never a visible step between two tiles: a few levels of 255 at most.
      expect(Math.abs((g ?? 0) - (g2 ?? 0))).toBeLessThanOrEqual(6);
      expect(Math.abs((r ?? 0) - (r2 ?? 0))).toBeLessThanOrEqual(7);
      expect(Math.abs((b ?? 0) - (b2 ?? 0))).toBeLessThanOrEqual(7);
    });
    // Areas do differ.
    expect(maxG - minG).toBeGreaterThan(15);
  });
});

describe("groundDecal", () => {
  it("lays a few decals, never two touching, deterministically", () => {
    let n = 0;
    each((x, y) => {
      const d = groundDecal(x, y, 7, 6);
      expect(d).toBe(groundDecal(x, y, 7, 6));
      expect(d).toBeLessThan(6);
      if (d < 0) return;
      n++;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ] as const)
        expect(groundDecal(x + dx, y + dy, 7, 6)).toBe(-1);
    });
    expect(n / (W * H)).toBeGreaterThan(DECAL_DENSITY * 0.4);
    expect(n / (W * H)).toBeLessThan(DECAL_DENSITY * 1.2);
    expect(groundDecal(3, 3, 7, 0)).toBe(-1);
  });

  it("resolves a ground's decals from the atlas", () => {
    const atlas = new Set([
      "ground/sand",
      decalName("ground/sand", 1),
      decalName("ground/sand", 2),
    ]);
    const art = resolveTileArt("ground/sand", { decals: 3 }, (n) => (atlas.has(n) ? n : undefined));
    expect(art?.decals).toEqual(["ground/sand/decal_1", "ground/sand/decal_2"]);
    expect(TILE_PART.exec("ground/sand/decal_2")?.[1]).toBe("ground/sand");
    expect(TILE_PART.test("ground/sand/decal_0")).toBe(false);
  });
});
