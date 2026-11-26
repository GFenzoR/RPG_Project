// The canvas fonts. The pixel font (Pixelify Sans, render/canvas-font.ts: floating numbers
// and speech bubbles) has every letter they use. The names' font (Alegreya Sans,
// render/label-style.ts) has every letter of every creature name and NPC role, and with its
// real widths every NPC of data/npcs shows its name whole on one line and its role whole on
// at most two, at every zoom and pixel density (render/labels.ts). Widths come from each
// font's own advance table (hmtx), so the test needs no browser.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadClientContent, repoRoot } from "./content.ts";
import { FONTS, fontSource } from "./fonts.ts";
import { CANVAS_FONT_FAMILY, CANVAS_FONT_SIZE } from "../src/render/canvas-font.ts";
import {
  LABEL_FONT_FAMILY,
  LABEL_NAME_WEIGHT,
  LABEL_SUB_WEIGHT,
  SHRINK_MIN,
  labelFontPx,
  labelStroke,
  subFontPx,
} from "../src/render/label-style.ts";
import { ROLE_LINES, fitName, labelMaxWidth, wrapRole } from "../src/render/labels.ts";
import type { MeasureLine } from "../src/render/labels.ts";

const root = repoRoot();

/** A glyph's outline box and left side bearing, font units (y up from the baseline). */
interface GlyphBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  lsb: number;
}

/**
 * Advance width (font units) per code point, units per em and each code point's glyph box
 * (glyf header, the default instance of a variable font) of a TrueType font.
 */
function advances(font: Buffer): {
  upem: number;
  advance: Map<number, number>;
  box: (c: number) => GlyphBox | undefined;
} {
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
  const lsb = (glyph: number): number =>
    glyph < metrics
      ? font.readInt16BE(hmtx + 4 * glyph + 2)
      : font.readInt16BE(hmtx + 4 * metrics + 2 * (glyph - metrics));
  const longLoca = font.readInt16BE(at("head") + 50) === 1;
  const loca = at("loca");
  const glyf = at("glyf");
  const glyphAt = (glyph: number): number =>
    glyf +
    (longLoca ? font.readUInt32BE(loca + 4 * glyph) : font.readUInt16BE(loca + 2 * glyph) * 2);
  const glyphOf = new Map<number, number>();
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
        if (glyph !== 0) {
          advance.set(c, width(glyph));
          glyphOf.set(c, glyph);
        }
      }
    }
    break;
  }
  const box = (c: number): GlyphBox | undefined => {
    const glyph = glyphOf.get(c);
    if (glyph === undefined) return undefined;
    const o = glyphAt(glyph);
    return {
      xMin: font.readInt16BE(o + 2),
      yMin: font.readInt16BE(o + 4),
      xMax: font.readInt16BE(o + 6),
      yMax: font.readInt16BE(o + 8),
      lsb: lsb(glyph),
    };
  };
  return { upem, advance, box };
}

const font = FONTS.find((f) => f.family === CANVAS_FONT_FAMILY);
const metrics = font ? advances(readFileSync(fontSource(root, font))) : undefined;

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

  // render/canvas-font.ts says what the font does at CANVAS_FONT_SIZE: one cell of its grid
  // per screen pixel in height, but advances that are not whole cells.
  it("draws letters whole pixels tall, but advances them by fractions of a pixel", () => {
    if (!metrics) throw new Error("no canvas font");
    const px = (units: number): number => (units * CANVAS_FONT_SIZE) / metrics.upem;
    const box = (ch: string): GlyphBox => {
      const b = metrics.box(ch.codePointAt(0) ?? 0);
      if (!b) throw new Error(`no glyph for ${ch}`);
      return b;
    };
    // Capitals 7 px tall and lower case 5 (the outlines overshoot the grid by ~0.1 px).
    for (const [ch, rows] of [
      ["H", 7],
      ["W", 7],
      ["x", 5],
      ["o", 5],
    ] as const) {
      const b = box(ch);
      expect(Math.abs(px(b.yMax - b.yMin) - rows), ch).toBeLessThan(0.1);
    }
    // Across it is not pixel perfect: every letter starts 0.66 px into its place and H
    // advances 6.45 px, so the columns fall between pixels.
    expect(px(metrics.advance.get(72) ?? 0)).toBeCloseTo(6.45, 2);
    expect(px(box("H").lsb)).toBeCloseTo(0.66, 2);
    const between = [..."Lobo gris"].filter((ch) => {
      const a = px(metrics.advance.get(ch.codePointAt(0) ?? 0) ?? 0);
      return Math.abs(a - Math.round(a)) > 0.1;
    });
    expect(between.length).toBeGreaterThan(0);
  });
});

/** A measurer from a served font's advance table, as the canvas measures (plus the outline). */
function measurer(weight: string): MeasureLine {
  const file = FONTS.find((f) => f.family === LABEL_FONT_FAMILY && f.weight === weight);
  if (!file) throw new Error(`no ${LABEL_FONT_FAMILY} ${weight} among the served fonts`);
  const m = advances(readFileSync(fontSource(root, file)));
  return (text, px) => {
    let units = 0;
    for (const ch of text) units += m.advance.get(ch.codePointAt(0) ?? 0) ?? m.upem;
    return (units * px) / m.upem + labelStroke(px);
  };
}

describe("creature labels in the interface's sans", () => {
  const content = loadClientContent(root);
  const catalogs = ["es", "en"].map(
    (lang) =>
      parse(readFileSync(join(root, "i18n", lang, "npcs.yaml"), "utf8")) as Record<string, string>,
  );
  const npcIds = Object.keys(content.npcRoles ?? {});

  it("serves both weights of the names' font", () => {
    expect(() => measurer(LABEL_NAME_WEIGHT)).not.toThrow();
    expect(() => measurer(LABEL_SUB_WEIGHT)).not.toThrow();
  });

  it("has a glyph for every letter of a creature name or an NPC role", () => {
    const roles = catalogs.flatMap((c) =>
      Object.entries(c)
        .filter(([k]) => k.endsWith(".role") || k.startsWith("npc_role."))
        .map(([, v]) => v),
    );
    const text = creatureNames().join("") + roles.join("") + "…¿¡ñÑáéíóúüÜ'-.";
    for (const weight of [LABEL_NAME_WEIGHT, LABEL_SUB_WEIGHT]) {
      const file = FONTS.find((f) => f.family === LABEL_FONT_FAMILY && f.weight === weight);
      if (!file) throw new Error("no font");
      const m = advances(readFileSync(fontSource(root, file)));
      const missing = new Set<string>();
      for (const ch of text) if (!m.advance.has(ch.codePointAt(0) ?? 0)) missing.add(ch);
      expect([...missing], weight).toEqual([]);
    }
  });

  it("gives every NPC of data/npcs a role text in both languages", () => {
    expect(npcIds.length).toBeGreaterThanOrEqual(20);
    for (const id of npcIds) {
      const key = content.npcRoles?.[id] ?? "";
      for (const cat of catalogs) {
        expect(cat[key], `${id}: ${key}`).toBeTruthy();
        expect(cat[`npc.${id}.name`], id).toBeTruthy();
        // The name is the name alone: what the NPC does is the line under it.
        expect(cat[`npc.${id}.name`], id).not.toContain(",");
      }
    }
  });

  it("shows every NPC's name whole on one line and its role whole on two at most, never cut", () => {
    const name = measurer(LABEL_NAME_WEIGHT);
    const sub = measurer(LABEL_SUB_WEIGHT);
    for (const dpr of [1, 1.25, 1.5, 2])
      for (const zoom of [1, 2, 3, 4])
        for (const size of ["normal", "large"] as const) {
          // The map scale is whole device pixels per sprite pixel.
          const scale = Math.max(1, Math.round(zoom * dpr));
          const px = labelFontPx(scale, dpr, size);
          const max = labelMaxWidth(32 * scale, px);
          for (const id of npcIds)
            for (const cat of catalogs) {
              const at = `${id} zoom ${zoom} dpr ${dpr} ${size}`;
              const n = cat[`npc.${id}.name`] ?? "";
              const fit = fitName(n, px, max, name, false);
              expect(fit.text, at).toBe(n);
              expect(name(fit.text, fit.fontPx), at).toBeLessThanOrEqual(max);
              expect(fit.fontPx, at).toBeGreaterThanOrEqual(Math.ceil(px * SHRINK_MIN));
              const role = cat[content.npcRoles?.[id] ?? ""] ?? "";
              const wrapped = wrapRole(role, subFontPx(px, dpr), max, sub);
              expect(wrapped.lines.join(" "), at).toBe(role);
              expect(wrapped.lines.length, at).toBeGreaterThanOrEqual(1);
              expect(wrapped.lines.length, at).toBeLessThanOrEqual(ROLE_LINES);
              for (const l of wrapped.lines)
                expect(sub(l, wrapped.fontPx), `${at}: ${l}`).toBeLessThanOrEqual(max);
              expect(`${fit.text}${wrapped.lines.join("")}`, at).not.toContain("…");
            }
        }
  });

  it("keeps a monster's name on one line, cut only when even the smaller size is too wide", () => {
    const name = measurer(LABEL_NAME_WEIGHT);
    const px = labelFontPx(2, 1, "large");
    const max = labelMaxWidth(64, px);
    for (const n of creatureNames()) {
      const fit = fitName(n, px, max, name);
      expect(name(fit.text, fit.fontPx)).toBeLessThanOrEqual(max);
      // At the fitted desktop zoom no creature of the game is cut.
      expect(fit.text, n).toBe(n);
    }
    const long = fitName("W".repeat(40), px, max, name);
    expect(long.text.endsWith("…")).toBe(true);
    expect(name(long.text, long.fontPx)).toBeLessThanOrEqual(max);
  });
});
