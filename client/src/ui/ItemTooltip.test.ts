// The tooltip's placement (docs/17 UI-6, the Diablo II idea): pure, no DOM.
import { describe, expect, it } from "vitest";
import { TIP_GAP, TIP_MARGIN, groundAnchor, tipPlacement } from "./ItemTooltip.tsx";
import type { Rect } from "./ItemTooltip.tsx";

const view = { width: 1280, height: 800 };
const size = { width: 180, height: 90 };
const cell: Rect = { left: 1100, top: 400, width: 36, height: 36 };

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

describe("tipPlacement", () => {
  it("centres the card above the item", () => {
    const at = tipPlacement(cell, size, view);
    expect(at.side).toBe("above");
    expect(at.left).toBe(1100 + 18 - 90);
    expect(at.top).toBe(400 - TIP_GAP - 90);
    expect(at.maxHeight).toBeUndefined();
  });

  it("stays inside the screen at its sides", () => {
    expect(tipPlacement({ ...cell, left: 1270 }, size, view).left).toBe(1280 - TIP_MARGIN - 180);
    expect(tipPlacement({ ...cell, left: 2 }, size, view).left).toBe(TIP_MARGIN);
  });

  it("goes below when there is no room above", () => {
    const at = tipPlacement({ ...cell, top: 40 }, size, view);
    expect(at.side).toBe("below");
    expect(at.top).toBe(40 + 36 + TIP_GAP);
  });

  it("takes the roomier side, cut to it, when neither fits", () => {
    const tall = { width: 180, height: 500 };
    const high = tipPlacement({ ...cell, top: 350 }, tall, view);
    expect(high).toMatchObject({ side: "below", top: 350 + 36 + TIP_GAP });
    expect(high.maxHeight).toBe(800 - TIP_MARGIN - (350 + 36 + TIP_GAP));
    const low = tipPlacement({ ...cell, top: 420 }, tall, view);
    expect(low).toMatchObject({
      side: "above",
      top: TIP_MARGIN,
      maxHeight: 420 - TIP_GAP - TIP_MARGIN,
    });
  });

  it("never covers the item it describes (nor the cursor on it)", () => {
    for (let top = 0; top <= 780; top += 13)
      for (let left = 0; left <= 1260; left += 97)
        for (const h of [20, 90, 300, 700]) {
          const anchor = { left, top, width: 36, height: 36 };
          const at = tipPlacement(anchor, { width: 180, height: h }, view);
          const box = { left: at.left, top: at.top, width: 180, height: at.maxHeight ?? h };
          expect(overlaps(box, anchor), `${left},${top} h${h}`).toBe(false);
          expect(box.left).toBeGreaterThanOrEqual(TIP_MARGIN);
          expect(box.top).toBeGreaterThanOrEqual(TIP_MARGIN - 0.5);
          expect(box.top + box.height).toBeLessThanOrEqual(800 - TIP_MARGIN + 0.5);
        }
  });
});

describe("groundAnchor", () => {
  it("reaches past the text of the default action under the cursor", () => {
    const tile = { left: 600, top: 300, width: 64, height: 64 };
    expect(groundAnchor(tile, 320)).toEqual(tile); // the text ends inside the tile
    expect(groundAnchor(tile, 350).height).toBe(350 + 40 - 300);
    // Placed below, the card clears the text; placed above, it sits over the tile.
    expect(tipPlacement(groundAnchor(tile, 350), size, view)).toMatchObject({
      side: "above",
      top: 300 - TIP_GAP - 90,
    });
    expect(tipPlacement(groundAnchor({ ...tile, top: 20 }, 60), size, view)).toMatchObject({
      side: "below",
      top: 60 + 40 + TIP_GAP,
    });
  });
});
