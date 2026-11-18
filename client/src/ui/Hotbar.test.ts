import { describe, expect, it } from "vitest";
import { FLASH_MS, flashes } from "./Hotbar.tsx";

describe("hotbar flash (docs/17 UI-9)", () => {
  it("flashes only the slot of the spell just used, for a moment", () => {
    const cast = { spellId: "light_heal", at: 1000 };
    expect(flashes(cast, "light_heal", 1050)).toBe(true);
    expect(flashes(cast, "fireball", 1050)).toBe(false);
    expect(flashes(cast, "light_heal", 1000 + FLASH_MS)).toBe(false);
    // The bar repaints every 100 ms: a "now" a little older than the cast still shows it.
    expect(flashes(cast, "light_heal", 950)).toBe(true);
    expect(flashes(undefined, "light_heal", 1000)).toBe(false);
  });
});
