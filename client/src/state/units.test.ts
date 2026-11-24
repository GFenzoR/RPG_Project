import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { translator } from "../i18n/i18n.ts";
import { formatArea, formatLength, formatMass } from "./units.ts";

/** The real client catalogue of a language: the unit symbols come from i18n too. */
function catalogue(lang: string): Record<string, string> {
  const path = fileURLToPath(new URL(`../../../i18n/${lang}/client.yaml`, import.meta.url));
  return parse(readFileSync(path, "utf8")) as Record<string, string>;
}

const es = translator(catalogue("es"), "es");
const en = translator(catalogue("en"), "en");

describe('formatMass (docs/02 "Unidades")', () => {
  it("writes grams below 1 kg, rounded to whole grams", () => {
    expect(formatMass(0, es)).toBe("0 g");
    expect(formatMass(5, es)).toBe("5 g");
    expect(formatMass(350, es)).toBe("350 g");
    expect(formatMass(349.6, en)).toBe("350 g");
    expect(formatMass(999, en)).toBe("999 g");
  });

  it("switches to kg from 1000 g, also when the grams round up to it", () => {
    expect(formatMass(1000, es)).toBe("1 kg");
    expect(formatMass(999.6, es)).toBe("1 kg");
    expect(formatMass(3000, en)).toBe("3 kg");
  });

  it("writes kg with up to two decimals, trailing zeros dropped", () => {
    expect(formatMass(3250, en)).toBe("3.25 kg");
    expect(formatMass(12400, en)).toBe("12.4 kg");
    expect(formatMass(1234, en)).toBe("1.23 kg");
    expect(formatMass(1235, en)).toBe("1.24 kg");
    expect(formatMass(1999, en)).toBe("2 kg");
  });

  it("takes the language's decimal separator and grouping", () => {
    expect(formatMass(3250, es)).toBe("3,25 kg");
    expect(formatMass(12400, es)).toBe("12,4 kg");
    expect(formatMass(45000, es)).toBe("45 kg");
    expect(formatMass(12_345_670, es)).toBe("12.345,67 kg");
    expect(formatMass(12_345_670, en)).toBe("12,345.67 kg");
  });

  it("never writes a negative or broken weight", () => {
    expect(formatMass(-20, es)).toBe("0 g");
    expect(formatMass(Number.NaN, en)).toBe("0 g");
  });
});

describe('formatLength and formatArea (1 tile = 1 m, docs/02 "Unidades")', () => {
  it("writes a range in metres", () => {
    expect(formatLength(5, es)).toBe("5 m");
    expect(formatLength(1, en)).toBe("1 m");
  });

  it("writes an area of tiles in square metres, grouped", () => {
    expect(formatArea(32, es)).toBe("32 m²");
    expect(formatArea(12000, en)).toBe("12,000 m²");
  });
});
