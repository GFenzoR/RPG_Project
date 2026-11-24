import { describe, expect, it } from "vitest";
import { Skull } from "@rpg/protocol";
import {
  DEFAULT_NAME_SIZE,
  LABEL_COLORS,
  LABEL_MIN_CONTRAST,
  LABEL_OUTLINE,
  SKULL_COLORS,
  contrastRatio,
  hueOf,
  labelScale,
  relativeLuminance,
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
