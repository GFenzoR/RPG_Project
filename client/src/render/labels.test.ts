import { describe, expect, it } from "vitest";
import { LABEL_FULL_ZOOM, labelText, labelsFull, placeLabels } from "./labels.ts";
import { labelScale } from "./label-style.ts";
import type { LabelBox } from "./labels.ts";

// Zoom 1: a tile is 32 px; names are ~60 px wide and 12 px tall.
const box = (
  id: number,
  tileX: number,
  tileY: number,
  extra: Partial<LabelBox> = {},
): LabelBox => ({
  id,
  x: tileX * 32 + 16,
  y: tileY * 32 - 4,
  width: 60,
  nameHeight: 12,
  guildHeight: 0,
  self: false,
  target: false,
  distance: Math.max(Math.abs(tileX - 7), Math.abs(tileY - 5)),
  ...extra,
});
const self = box(1, 7, 5, { self: true });

describe("placeLabels", () => {
  it("leaves every label alone from zoom 2 up", () => {
    const boxes = [self, box(2, 8, 5, { guildHeight: 10 }), box(3, 9, 5)];
    const out = placeLabels(boxes, LABEL_FULL_ZOOM);
    expect([...out.values()]).toEqual([
      { show: true, guild: false, lift: 0 },
      { show: true, guild: true, lift: 0 },
      { show: true, guild: false, lift: 0 },
    ]);
  });

  it("keeps labels that do not touch", () => {
    const out = placeLabels([self, box(2, 10, 5), box(3, 7, 8)], 1);
    for (const p of out.values()) expect(p).toEqual({ show: true, guild: false, lift: 0 });
  });

  it("drops a guild line before anything else", () => {
    // Directly below the own creature: its guild line would reach into the name above.
    const below = box(2, 7, 6, { guildHeight: 30 });
    const out = placeLabels([self, below], 1);
    expect(out.get(2)).toEqual({ show: true, guild: false, lift: 0 });
  });

  it("lifts a far label above the one it hits", () => {
    const a = box(2, 10, 5);
    const b = box(3, 11, 5); // 32 px right of a: the 60 px names overlap
    const out = placeLabels([self, a, b], 1);
    expect(out.get(2)).toEqual({ show: true, guild: false, lift: 0 });
    expect(out.get(3)).toEqual({ show: true, guild: false, lift: 13 });
  });

  it("hides a far label with no room, but never the own one, the target or a neighbour", () => {
    const crowd = [
      box(2, 11, 5),
      box(3, 12, 5),
      box(4, 12, 5), // far, on the tile of 3: hidden once 2 and 3 took the room
      box(5, 12, 4, { target: true }),
      box(6, 8, 5), // next to the player: stays
    ];
    const out = placeLabels([self, ...crowd], 1);
    expect(out.get(1)?.show).toBe(true);
    expect(out.get(5)?.show).toBe(true);
    expect(out.get(6)?.show).toBe(true);
    expect(out.get(4)?.show).toBe(false);
  });

  it("puts the own label and the target first", () => {
    // The target overlaps a nearer creature: the target keeps its spot.
    const near = box(2, 9, 5);
    const target = box(3, 10, 5, { target: true });
    const out = placeLabels([near, target, self], 1);
    expect(out.get(3)).toEqual({ show: true, guild: false, lift: 0 });
    expect(out.get(2)?.lift).toBeGreaterThan(0);
  });

  it("is stable for the same input", () => {
    const boxes = [self, box(2, 11, 5), box(3, 12, 5), box(4, 13, 5)];
    expect(placeLabels(boxes, 1)).toEqual(placeLabels([...boxes].reverse(), 1));
  });
});

describe("labelText", () => {
  it("keeps names at full zoom", () => {
    expect(labelText("Sir Bartholomew the Long", 2)).toBe("Sir Bartholomew the Long");
  });

  it("shortens long names at small zoom", () => {
    expect(labelText("Sir Bartholomew the Long", 1)).toBe("Sir Barthol…");
    expect(labelText("Short", 1)).toBe("Short");
    expect(labelText("Exactly12chr", 1)).toBe("Exactly12chr");
    expect(labelText("Sir Bart Long", 1)).toBe("Sir Bart Lo…");
    expect(labelText("Big Red Wolf X", 1, 9)).toBe("Big Red…");
  });
});

// Large names (render/label-style.ts): at zoom 2 a tile is 64 px and a name at label scale
// 2 is ~120 px wide and 24 px tall, as big next to its tile as at zoom 1.
const box2 = (
  id: number,
  tileX: number,
  tileY: number,
  extra: Partial<LabelBox> = {},
): LabelBox => ({
  ...box(id, tileX, tileY, extra),
  x: tileX * 64 + 32,
  y: tileY * 64 - 8,
  width: 120,
  nameHeight: 24,
  ...extra,
});
const self2 = box2(1, 7, 5, { self: true });

describe("labels at a bigger label scale", () => {
  it("leave labels alone only when they are at most half as big as at zoom 1", () => {
    expect(labelsFull(2)).toBe(true);
    expect(labelsFull(2, labelScale(2, "normal"))).toBe(true);
    expect(labelsFull(2, labelScale(2, "large"))).toBe(false);
    expect(labelsFull(4, labelScale(4, "normal"))).toBe(true);
    expect(labelsFull(6, labelScale(6, "large"))).toBe(false);
  });

  it("lift a far label by its scaled height and a scaled gap", () => {
    const a = box2(2, 10, 5);
    const b = box2(3, 11, 5); // 64 px right of a: the 120 px names overlap
    const out = placeLabels([self2, a, b], 2, 2);
    expect(out.get(2)).toEqual({ show: true, guild: false, lift: 0 });
    expect(out.get(3)).toEqual({ show: true, guild: false, lift: 26 });
  });

  it("place the same crowd as at zoom 1, scaled", () => {
    const crowd = (mk: typeof box): LabelBox[] => [
      mk(1, 7, 5, { self: true }),
      mk(2, 11, 5),
      mk(3, 12, 5),
      mk(4, 12, 5),
      mk(5, 12, 4, { target: true }),
      mk(6, 8, 5),
    ];
    const small = placeLabels(crowd(box), 1, 1);
    const big = placeLabels(crowd(box2), 2, 2);
    for (const [id, p] of small) {
      const q = big.get(id);
      expect(q?.show, `label ${id}`).toBe(p.show);
      expect(q?.lift, `label ${id}`).toBe(p.lift * 2);
    }
  });

  it("never overlap two shown labels of far creatures", () => {
    const boxes = [self2];
    for (let i = 0; i < 12; i++) boxes.push(box2(10 + i, 9 + (i % 4), 2 + Math.floor(i / 4)));
    const out = placeLabels(boxes, 3, 2);
    const shown = boxes.filter((b) => out.get(b.id)?.show && !b.self && b.distance > 1);
    const rect = (b: LabelBox) => {
      const lift = out.get(b.id)?.lift ?? 0;
      return {
        l: b.x - b.width / 2,
        r: b.x + b.width / 2,
        t: b.y - lift - b.nameHeight,
        b: b.y - lift,
      };
    };
    for (let i = 0; i < shown.length; i++)
      for (let j = i + 1; j < shown.length; j++) {
        const p = rect(shown[i] as LabelBox);
        const q = rect(shown[j] as LabelBox);
        const hit = p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b;
        expect(hit).toBe(false);
      }
  });

  it("shorten long names with large labels but not with normal ones at zoom 2", () => {
    const long = "Sir Bartholomew the Long";
    expect(labelText(long, 2, 12, labelScale(2, "large"))).toBe("Sir Barthol…");
    expect(labelText(long, 2, 12, labelScale(2, "normal"))).toBe(long);
    expect(labelText(long, 6, 12, labelScale(6, "normal"))).toBe(long);
  });
});
