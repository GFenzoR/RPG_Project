// Two creatures whose drawings overlap (one right behind the other) keep their own colours:
// the one behind is covered, and nothing is drawn again over the one in front. Until
// 2026-11-26 the game canvas drew a pale see-through copy (tint 0xffe2c8, alpha 0.55) of
// every creature a quarter covered by another, over both of them: with the humanoids of the
// engine (a third of the one behind is covered by the one in front) every pair of
// characters standing in a column changed colour. The canvas needs WebGL, so what it
// promises is read from its source, as ui/windows-css.test.ts does for the stylesheets.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DrawnBoxes } from "./creature-hits.ts";

const source = readFileSync(new URL("./game-canvas.ts", import.meta.url), "utf8");

describe("creatures that overlap (owner, 2026-11-26)", () => {
  it("draws nothing over the map's creatures but the ambient particles", () => {
    // MapView.overlay is drawn over every creature: a sprite added there for a creature's
    // sake (the old "hidden creatures" layer) tints whoever stands in front of it.
    const added = [...source.matchAll(/view\.overlay\.addChild\(([^)]*)\)/g)].map((m) => m[1]);
    expect(added).toEqual(["particles.view"]);
  });

  it("has no see-through copy of a covered creature, and no tint for one", () => {
    expect(source).not.toMatch(/HIDDEN_(TINT|ALPHA)/);
    expect(source).not.toMatch(/forEachHidden|showHidden|hiddenLayer|hiddenPool/);
    // The boxes of the drawn creatures are for clicks only: they do not say who is covered.
    const boxes = new DrawnBoxes() as unknown as Record<string, unknown>;
    expect(boxes["forEachHidden"]).toBeUndefined();
    expect(boxes["covered"]).toBeUndefined();
  });
});
