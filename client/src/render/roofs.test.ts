import { describe, expect, it } from "vitest";
import { roofLookup } from "./roofs.ts";

describe("roofLookup (docs/17 'Bajo techo')", () => {
  it("answers by floor and tile from the shipped runs", () => {
    const at = roofLookup({ "7": [10, 4, 3, 11, 4, 1] });
    const floor = at?.(7);
    expect(floor?.(4, 10)).toBe(true);
    expect(floor?.(6, 10)).toBe(true);
    expect(floor?.(7, 10)).toBe(false);
    expect(floor?.(4, 11)).toBe(true);
    expect(floor?.(5, 11)).toBe(false);
    // A floor without runs has no roofs: it is not guessed from the view.
    expect(at?.(6)?.(4, 10)).toBe(false);
  });

  it("is absent without the data: the map view guesses from the tiles in view", () => {
    expect(roofLookup(undefined)).toBeUndefined();
  });
});
