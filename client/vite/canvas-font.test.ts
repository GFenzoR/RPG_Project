// The canvas labels in Pixelify Sans (render/canvas-font.ts): the font has every letter the
// names use, and a name shortened at zoom 1 (render/labels.ts) still fits the label budget
// with the new widths. Widths come from the font's own advance table (hmtx), at the canvas
// size, so the test needs no browser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./content.ts";
import { FONTS, fontSource } from "./fonts.ts";
import { CANVAS_FONT_FAMILY, CANVAS_FONT_SIZE } from "../src/render/canvas-font.ts";
import { labelText, SHORT_NAME_CHARS } from "../src/render/labels.ts";

const root = repoRoot();

/** Advance width (font units) per code point, and units per em, of a TrueType font. */
function advances(font: Buffer): { upem: number; advance: Map<number, number> } {
  const tables = new Map<string, number>();
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const rec = 12 + i * 16;
    tables.set(font.toString("latin1", rec, rec + 4), font.readUInt32BE(rec + 8));
  }
  const at = (tag: string): number => {
    const off = tables.get(tag);
    if (off === undefined) throw new Error(`no ${tag} table`);
    return off;
  };
  const upem = font.readUInt16BE(at("head") + 18);
  const metrics = font.readUInt16BE(at("hhea") + 34);
  const hmtx = at("hmtx");
  const width = (glyph: number): number =>
    font.readUInt16BE(hmtx + 4 * Math.min(glyph, metrics - 1));
  // The Unicode BMP subtable (format 4) of cmap.
  const cmap = at("cmap");
  const advance = new Map<number, number>();
  for (let i = 0; i < font.readUInt16BE(cmap + 2); i++) {
    const t = cmap + font.readUInt32BE(cmap + 4 + i * 8 + 4);
    if (font.readUInt16BE(t) !== 4) continue;
    const seg = font.readUInt16BE(t + 6) / 2;
    const ends = t + 14;
    const starts = ends + seg * 2 + 2;
    const deltas = starts + seg * 2;
    const offsets = deltas + seg * 2;
    for (let s = 0; s < seg; s++) {
      const from = font.readUInt16BE(starts + s * 2);
      const to = font.readUInt16BE(ends + s * 2);
      const delta = font.readInt16BE(deltas + s * 2);
      const ro = font.readUInt16BE(offsets + s * 2);
      for (let c = from; c <= to && c !== 0xffff; c++) {
        let glyph = (c + delta) & 0xffff;
        if (ro !== 0) {
          const g = font.readUInt16BE(offsets + s * 2 + ro + (c - from) * 2);
          glyph = g === 0 ? 0 : (g + delta) & 0xffff;
        }
        if (glyph !== 0) advance.set(c, width(glyph));
      }
    }
    break;
  }
  return { upem, advance };
}

const font = FONTS.find((f) => f.family === CANVAS_FONT_FAMILY);
const metrics = font ? advances(readFileSync(fontSource(root, font))) : undefined;

/** Width in px of `text` at the canvas size (no kerning: Pixelify Sans is monoline). */
function widthPx(text: string): number {
  if (!metrics) return 0;
  let units = 0;
  for (const ch of text) units += metrics.advance.get(ch.codePointAt(0) ?? 0) ?? metrics.upem;
  return (units * CANVAS_FONT_SIZE) / metrics.upem;
}

/** Every monster and NPC name of both languages (what the canvas labels show). */
function creatureNames(): string[] {
  const out: string[] = [];
  for (const lang of ["es", "en"])
    for (const file of ["monsters.yaml", "npcs.yaml"]) {
      const cat = parse(readFileSync(join(root, "i18n", lang, file), "utf8")) as Record<
        string,
        unknown
      >;
      for (const [k, v] of Object.entries(cat))
        if (k.endsWith(".name") && typeof v === "string") out.push(v);
    }
  return out;
}

describe("canvas labels in the pixel font", () => {
  it("is one of the served fonts", () => {
    expect(font?.source).toBe("PixelifySans[wght].ttf");
  });

  it("has a glyph for every letter a creature name, a guild or a number uses", () => {
    const missing = new Set<string>();
    const text = creatureNames().join("") + "0123456789…¿¡ñÑáéíóúüÜ'-.";
    for (const ch of text) if (!metrics?.advance.has(ch.codePointAt(0) ?? 0)) missing.add(ch);
    expect([...missing]).toEqual([]);
  });

  it("keeps a name shortened at zoom 1 within three tiles (96 px)", () => {
    const names = creatureNames();
    expect(names.length).toBeGreaterThan(20);
    let widest = "";
    for (const name of names) {
      const shown = labelText(name, 1);
      expect([...shown].length).toBeLessThanOrEqual(SHORT_NAME_CHARS);
      if (widthPx(shown) > widthPx(widest)) widest = shown;
    }
    expect(widthPx(widest), widest).toBeLessThanOrEqual(96);
    // The widest a player's name can get: eleven of the widest letter and the ellipsis,
    // ~100 px (the bold 12 px sans-serif of before drew it ~125 px wide).
    expect(widthPx(labelText("W".repeat(30), 1))).toBeLessThanOrEqual(104);
    // And the font is not so narrow that a shortened name became a smudge.
    expect(widthPx(widest)).toBeGreaterThan(48);
  });
});
