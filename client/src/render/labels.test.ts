import { describe, expect, it } from "vitest";
import { LABEL_FULL_ZOOM, labelText, placeLabels } from "./labels.ts";
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
