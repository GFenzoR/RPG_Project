import { describe, expect, it } from "vitest";
import {
  ORNAMENTS,
  ORNAMENT_PALETTE,
  mirrored,
  ornamentStyle,
  padded,
  ornamentSvg,
  ornamentUrl,
} from "./ornaments.ts";

describe("the gothic ornaments (docs/17 UI-2)", () => {
  it("are rectangular drawings in the palette's colours", () => {
    for (const [name, rows] of Object.entries(ORNAMENTS)) {
      const width = rows[0]?.length ?? 0;
      expect(width, name).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row, `${name}: "${row}"`).toHaveLength(width);
        for (const ch of row)
          expect(ch === "." || ch in ORNAMENT_PALETTE, `${name}: "${ch}"`).toBe(true);
      }
    }
  });

  it("mirrors a corner into the other three", () => {
    const rows = ["#o.", "-.."];
    expect(mirrored(rows, true, false)).toEqual([".o#", "..-"]);
    expect(mirrored(rows, false, true)).toEqual(["-..", "#o."]);
    expect(mirrored(rows, true, true)).toEqual(["..-", ".o#"]);
    expect(rows).toEqual(["#o.", "-.."]); // the drawing itself is left as it was
  });

  it("spaces a drawing with transparent columns (the studs along the bar)", () => {
    expect(padded(["#o", "o#"], 4)).toEqual(["#o..", "o#.."]);
  });

  it("draws an SVG with square pixels and one path per colour", () => {
    const svg = ornamentSvg(["#o", "o."]);
    expect(svg).toContain('viewBox="0 0 2 2"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(ornamentUrl(["#"])).toMatch(/^url\("data:image\/svg\+xml,%3Csvg%20/);
  });

  it("gives windows.css its variables, url()s only (CSP: images from data:)", () => {
    const style = ornamentStyle();
    expect(Object.keys(style).sort()).toEqual([
      "--orn-corner-bl",
      "--orn-corner-br",
      "--orn-corner-tl",
      "--orn-corner-tr",
      "--orn-spire",
      "--orn-stud",
      "--orn-studs",
    ]);
    for (const v of Object.values(style))
      expect(v).toMatch(/^url\("data:image\/svg\+xml,[^"]+"\)$/);
    expect(ornamentStyle()).toBe(style); // computed once
  });
});
