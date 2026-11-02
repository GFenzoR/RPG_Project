import { describe, expect, it } from "vitest";
import { generate } from "./generate.ts";
import type { MapOp } from "./ops/types.ts";

const area = { x: 2048, y: 2048, w: 128, h: 128 };

function grid(ops: MapOp[]): Map<string, string> {
  const g = new Map<string, string>();
  for (const op of ops) {
    if (op.op !== "paint_ground") continue;
    if (op.rect)
      for (let y = op.rect.y; y < op.rect.y + op.rect.h; y++)
        for (let x = op.rect.x; x < op.rect.x + op.rect.w; x++) g.set(`${x},${y}`, op.item);
    for (const c of op.cells ?? []) g.set(`${c.x},${c.y}`, op.item);
  }
  return g;
}

describe("generate island", () => {
  it("is deterministic and depends on the seed", () => {
    const a = generate({ recipe: "island", area, floor: 7, seed: 42, size: 112 });
    expect(
      JSON.stringify(generate({ recipe: "island", area, floor: 7, seed: 42, size: 112 })),
    ).toBe(JSON.stringify(a));
    expect(
      JSON.stringify(generate({ recipe: "island", area, floor: 7, seed: 43, size: 112 })),
    ).not.toBe(JSON.stringify(a));
    expect(a.at(-1)).toEqual({ op: "autoborder", floor: 7, rect: area });
  });

  for (const seed of [1, 7, 42, 99]) {
    it(`seed ${seed}: land at the centre, water at the border, no grass touching water`, () => {
      const g = grid(generate({ recipe: "island", area, floor: 7, seed, size: 112 }));
      expect(g.get("2112,2112")).toBe("grass");
      for (let i = 0; i < 128; i++) {
        expect(g.get(`${2048 + i},2048`)).toBe("water_shallow");
        expect(g.get(`2048,${2048 + i}`)).toBe("water_shallow");
      }
      let land = 0;
      for (const [k, v] of g) {
        if (v === "water_shallow") continue;
        land++;
        if (v !== "grass") continue;
        const [x, y] = k.split(",").map(Number) as [number, number];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            expect(g.get(`${x + dx},${y + dy}`)).not.toBe("water_shallow");
      }
      // Roughly half of the size x size circle is land.
      expect(land / (Math.PI * 56 * 56)).toBeGreaterThan(0.35);
    });
  }

  it("rejects bad options", () => {
    expect(() => generate({ recipe: "island", area, floor: 7, seed: 1, size: 200 })).toThrow(
      RangeError,
    );
    expect(() => generate({ recipe: "island", area, floor: 7, seed: 1.5, size: 64 })).toThrow(
      RangeError,
    );
    expect(() =>
      generate({ recipe: "volcano" as "island", area, floor: 7, seed: 1, size: 64 }),
    ).toThrow(RangeError);
  });
});
