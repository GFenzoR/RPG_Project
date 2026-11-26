import { describe, expect, it } from "vitest";
import { Skull } from "@rpg/protocol";
import {
  DEFAULT_NAME_SIZE,
  LABEL_COLORS,
  LABEL_MIN_CONTRAST,
  LABEL_OUTLINE,
  LABEL_ROLE_COLOR,
  NAME_SIZES,
  SKULL_COLORS,
  contrastRatio,
  hueOf,
  labelFontPx,
  labelScale,
  labelStroke,
  linePitch,
  markScale,
  relativeLuminance,
  subFontPx,
} from "./label-style.ts";
import { NAME_EFFECTS } from "./cosmetics.ts";
import { skullColor } from "../state/pvp.ts";

const hex = (c: number): string => `0x${c.toString(16).padStart(6, "0")}`;

describe("contrast (WCAG)", () => {
  it("measures the known extremes", () => {
    expect(relativeLuminance(0x000000)).toBe(0);
    expect(relativeLuminance(0xffffff)).toBeCloseTo(1, 6);
    expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 6);
    expect(contrastRatio(0x777777, 0x777777)).toBe(1);
    // Symmetric.
    expect(contrastRatio(0x3a7bd5, 0)).toBeCloseTo(contrastRatio(0, 0x3a7bd5), 9);
  });

  it("would have failed the NPC and monster colours the owner could not read", () => {
    expect(contrastRatio(0x7d4fb0, LABEL_OUTLINE)).toBeLessThan(LABEL_MIN_CONTRAST);
    expect(contrastRatio(0xb03a2e, LABEL_OUTLINE)).toBeLessThan(LABEL_MIN_CONTRAST);
  });

  it("keeps every label colour readable on its black outline", () => {
    const all = { ...LABEL_COLORS, ...SKULL_COLORS };
    for (const [name, c] of Object.entries(all)) {
      const ratio = contrastRatio(c, LABEL_OUTLINE);
      expect(ratio, `${name} ${hex(c)}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
        LABEL_MIN_CONTRAST,
      );
    }
  });

  it("keeps the name effects readable on their own outline", () => {
    for (const [name, fx] of Object.entries(NAME_EFFECTS)) {
      const ratio = contrastRatio(fx.fill, fx.stroke.color);
      expect(ratio, `${name}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(LABEL_MIN_CONTRAST);
    }
  });

  it("draws the skull shapes with the tokens", () => {
    expect(skullColor(Skull.AGGRESSOR)).toBe(SKULL_COLORS.aggressor);
    expect(skullColor(Skull.MURDERER)).toBe(SKULL_COLORS.murderer);
    expect(skullColor(Skull.OUTLAW)).toBe(SKULL_COLORS.outlaw);
  });
});

describe("label colours keep their meaning", () => {
  it("are at least 40 degrees of hue apart", () => {
    const kinds = Object.entries(LABEL_COLORS);
    for (let i = 0; i < kinds.length; i++) {
      for (let j = i + 1; j < kinds.length; j++) {
        const [a, ca] = kinds[i] as [string, number];
        const [b, cb] = kinds[j] as [string, number];
        const d = Math.abs(hueOf(ca) - hueOf(cb));
        const apart = Math.min(d, 360 - d);
        expect(apart, `${a} vs ${b}`).toBeGreaterThanOrEqual(40);
      }
    }
  });

  it("are the hues they stand for", () => {
    const near = (h: number, target: number): boolean => {
      const d = Math.abs(h - target);
      return Math.min(d, 360 - d) <= 25;
    };
    expect(near(hueOf(LABEL_COLORS.self), 215)).toBe(true); // blue
    expect(near(hueOf(LABEL_COLORS.player), 40)).toBe(true); // amber
    expect(near(hueOf(LABEL_COLORS.monster), 0)).toBe(true); // red
    expect(near(hueOf(LABEL_COLORS.npc), 270)).toBe(true); // violet
    expect(near(hueOf(LABEL_COLORS.guild), 95)).toBe(true); // green
  });
});

describe("labelScale", () => {
  it("is large by default", () => {
    expect(DEFAULT_NAME_SIZE).toBe("large");
  });

  it("grows with the zoom in whole steps", () => {
    const zooms = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(zooms.map((z) => labelScale(z, "large"))).toEqual([1, 2, 2, 3, 3, 4, 5, 5]);
    expect(zooms.map((z) => labelScale(z, "normal"))).toEqual([1, 1, 1, 2, 2, 3, 3, 4]);
  });

  it("is bigger for large than for normal from zoom 2, never more than the zoom", () => {
    for (let z = 1; z <= 12; z++) {
      const large = labelScale(z, "large");
      const normal = labelScale(z, "normal");
      expect(Number.isInteger(large) && Number.isInteger(normal)).toBe(true);
      expect(large).toBeLessThanOrEqual(z);
      expect(normal).toBeGreaterThanOrEqual(1);
      if (z >= 2) expect(large).toBeGreaterThan(normal);
    }
  });

  it("treats an odd zoom as 1", () => {
    expect(labelScale(0, "large")).toBe(1);
    expect(labelScale(Number.NaN, "large")).toBe(1);
    expect(labelScale(2.7, "large")).toBe(2);
  });
});

describe("labelFontPx: the names at the screen's own resolution", () => {
  const ZOOMS = [1, 2, 3, 4];
  const DPRS = [1, 1.25, 1.5, 2];

  it("is a whole number of device pixels at every zoom and pixel density", () => {
    for (const dpr of DPRS)
      for (let scale = 1; scale <= 8; scale++)
        for (const size of NAME_SIZES) {
          const px = labelFontPx(scale, dpr, size);
          expect(Number.isInteger(px), `${scale} ${dpr} ${size}`).toBe(true);
          expect(Number.isInteger(subFontPx(px, dpr))).toBe(true);
          expect(Number.isInteger(linePitch(px))).toBe(true);
        }
  });

  it("is 12, 15, 18 and 21 px at zoom 1 to 4 on a plain screen", () => {
    expect(ZOOMS.map((z) => labelFontPx(z, 1, "large"))).toEqual([12, 15, 18, 21]);
    expect(ZOOMS.map((z) => labelFontPx(z, 1, "normal"))).toEqual([10, 12, 14, 16]);
  });

  it("is smaller than the blown-up pixel font of before, and still readable", () => {
    // Lote 19 drew 11 px cells times labelScale: 22 px at zoom 2 and 3, 33 at 4.
    for (const z of [2, 3, 4]) {
      const before = 11 * labelScale(z, "large");
      const now = labelFontPx(z, 1, "large");
      expect(now).toBeLessThan(before);
      expect(now).toBeGreaterThanOrEqual(before * 0.6);
    }
    for (const dpr of DPRS)
      for (let scale = 1; scale <= 8; scale++)
        expect(labelFontPx(scale, dpr, "normal") / dpr).toBeGreaterThanOrEqual(10 - 0.5);
  });

  it("looks the same size whatever the display scaling (Windows at 125 %, 150 %, 200 %)", () => {
    // The same seen zoom (device scale / dpr) gives the same CSS size, within a rounding.
    for (const dpr of DPRS)
      for (const seen of ZOOMS) {
        const css = labelFontPx(seen * dpr, dpr, "large") / dpr;
        expect(Math.abs(css - labelFontPx(seen, 1, "large"))).toBeLessThanOrEqual(0.5);
      }
    // A whole device scale that is a fraction of a CSS zoom still gets its own size.
    expect(labelFontPx(3, 1.5, "large")).toBe(23); // seen at 2x: 15 CSS px
    expect(labelFontPx(2, 1.25, "large")).toBe(17); // seen at 1.6x: 13.8 CSS px
  });

  it("grows with the zoom and stops growing past 4x", () => {
    for (const dpr of DPRS) {
      let last = 0;
      for (let scale = 1; scale <= 10; scale++) {
        const px = labelFontPx(scale, dpr, "large");
        expect(px).toBeGreaterThanOrEqual(last);
        last = px;
      }
      expect(labelFontPx(40, dpr, "large")).toBe(Math.round(21 * dpr));
    }
  });

  it("is bigger for large than for normal", () => {
    for (const dpr of DPRS)
      for (let scale = 1; scale <= 8; scale++)
        expect(labelFontPx(scale, dpr, "large")).toBeGreaterThan(labelFontPx(scale, dpr, "normal"));
  });

  it("treats an odd zoom or density as 1", () => {
    expect(labelFontPx(Number.NaN, 1, "large")).toBe(12);
    expect(labelFontPx(2, 0, "large")).toBe(15);
    expect(labelFontPx(2, Number.NaN, "large")).toBe(15);
  });

  it("sets the lines under a name smaller, never under 9 CSS px nor over the name", () => {
    for (const dpr of DPRS)
      for (let scale = 1; scale <= 8; scale++)
        for (const size of NAME_SIZES) {
          const name = labelFontPx(scale, dpr, size);
          const sub = subFontPx(name, dpr);
          expect(sub).toBeLessThanOrEqual(name);
          expect(sub).toBeGreaterThanOrEqual(Math.min(name, Math.round(9 * dpr)));
        }
    expect(subFontPx(15, 1)).toBe(12);
    expect(subFontPx(21, 1)).toBe(17);
  });

  it("outlines every size with at least a pixel all round", () => {
    for (let px = 9; px <= 48; px++) {
      expect(labelStroke(px)).toBeGreaterThanOrEqual(2);
      expect(labelStroke(px)).toBeLessThanOrEqual(Math.ceil(px / 4));
    }
  });

  it("scales the skull in whole steps with the name", () => {
    expect([12, 15, 18, 21, 30, 42].map(markScale)).toEqual([1, 2, 2, 2, 3, 5]);
  });

  it("keeps the role readable against the outline, and paler than the NPC's name", () => {
    expect(contrastRatio(LABEL_ROLE_COLOR, LABEL_OUTLINE)).toBeGreaterThanOrEqual(
      LABEL_MIN_CONTRAST,
    );
    expect(relativeLuminance(LABEL_ROLE_COLOR)).toBeGreaterThan(
      relativeLuminance(LABEL_COLORS.npc),
    );
  });
});
