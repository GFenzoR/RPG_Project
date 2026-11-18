import { describe, expect, it } from "vitest";
import { ICONS, ICON_PALETTE, ICON_SIZE, iconPath } from "./icons.tsx";

describe("UI icons", () => {
  it("are 16x16 drawings in the palette's colours", () => {
    for (const [name, rows] of Object.entries(ICONS)) {
      expect(rows, name).toHaveLength(ICON_SIZE);
      for (const row of rows) {
        expect(row, `${name}: "${row}"`).toHaveLength(ICON_SIZE);
        for (const ch of row)
          expect(ch === "." || ch in ICON_PALETTE, `${name}: "${ch}"`).toBe(true);
      }
    }
  });

  it("draws one rectangle per run of a colour", () => {
    expect(iconPath([".##.", "#..#"], "#")).toBe("M1 0h2v1h-2zM0 1h1v1h-1zM3 1h1v1h-1z");
    expect(iconPath(["...."], "#")).toBe("");
  });
});
