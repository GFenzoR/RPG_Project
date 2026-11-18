import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./content.ts";
import { FONTS, buildFont, fontSource, subsetText } from "./fonts.ts";

const root = repoRoot();
const css = readFileSync(join(root, "client", "src", "ui", "fonts.css"), "utf8");
const credits = readFileSync(join(root, "assets", "CREDITS.md"), "utf8");

/** The @font-face rules of fonts.css as plain fields. */
function faces(): { family: string; url: string; weight: string; style: string }[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const body = m[1] ?? "";
    const field = (name: string): string =>
      new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? "";
    return {
      family: field("font-family").replace(/"/g, ""),
      url: /url\("([^"]+)"\)/.exec(body)?.[1] ?? "",
      weight: field("font-weight"),
      style: field("font-style"),
    };
  });
}

/**
 * The Windows Unicode English strings (platform 3, language 0x409) of an sfnt's `name`
 * table, by name id: what a font viewer shows as its copyright, licence and so on.
 */
function nameTable(font: Buffer): Map<number, string> {
  const out = new Map<number, string>();
  const tables = font.readUInt16BE(4);
  for (let i = 0; i < tables; i++) {
    const rec = 12 + i * 16;
    if (font.toString("latin1", rec, rec + 4) !== "name") continue;
    const at = font.readUInt32BE(rec + 8);
    const count = font.readUInt16BE(at + 2);
    const strings = at + font.readUInt16BE(at + 4);
    for (let j = 0; j < count; j++) {
      const r = at + 6 + j * 12;
      if (font.readUInt16BE(r) !== 3 || font.readUInt16BE(r + 4) !== 0x409) continue;
      const len = font.readUInt16BE(r + 8);
      const off = strings + font.readUInt16BE(r + 10);
      // UTF-16BE: swap a copy (swap16 works in place, and records may share strings).
      const utf16 = Buffer.from(font.subarray(off, off + len)).swap16();
      out.set(font.readUInt16BE(r + 6), utf16.toString("utf16le"));
    }
  }
  return out;
}

describe("UI fonts (docs/17 UI-3)", () => {
  it("keeps every original file with its OFL licence and a CREDITS.md row", () => {
    for (const f of FONTS) {
      expect(existsSync(fontSource(root, f)), f.source).toBe(true);
      const dir = join(root, "assets", "vendor", f.pack);
      const ofl = readFileSync(join(dir, "OFL.txt"), "utf8");
      expect(ofl).toContain("SIL Open Font License, Version 1.1");
      // A Reserved Font Name would forbid serving a subset under the same name.
      expect(ofl.split("\n")[0]).not.toMatch(/Reserved Font Name/i);
      expect(readFileSync(join(dir, "LICENSE.txt"), "utf8")).toBe(ofl);
      expect(credits).toContain(`assets/vendor/${f.pack}/`);
    }
  });

  it("declares one @font-face per font, served from /fonts/", () => {
    const declared = faces();
    expect(declared).toHaveLength(FONTS.length);
    for (const f of FONTS)
      expect(declared).toContainEqual({
        family: f.family,
        url: `/fonts/${f.out}`,
        weight: f.weight,
        style: f.style,
      });
  });

  it("keeps the letters Spanish and English need", () => {
    const text = subsetText();
    for (const c of "AZaz09¿¡ñÑáéíóúüÜ×–—…‹›“”€") expect(text).toContain(c);
  });

  it("keeps the copyright and the OFL notice in every served font (OFL 1.1 §2)", async () => {
    for (const f of FONTS) {
      // The same subset as the woff2, uncompressed so its name table can be read.
      const names = nameTable(await buildFont(root, f, "truetype"));
      const original = nameTable(readFileSync(fontSource(root, f)));
      for (const id of [0, 13, 14]) {
        expect(original.get(id), `${f.source} has name ${id}`).toBeTruthy();
        expect(names.get(id), `${f.out} keeps name ${id}`).toBe(original.get(id));
      }
      expect(names.get(13)).toMatch(/SIL Open Font License, Version 1\.1/);
      expect(names.get(14)).toMatch(/openfontlicense\.org|scripts\.sil\.org\/OFL/);
    }
  });

  it("cuts a font down to a small woff2", async () => {
    const f = FONTS.find((x) => x.family === "Cinzel");
    if (!f) throw new Error("no Cinzel");
    const out = await buildFont(root, f);
    expect(out.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(out.length).toBeLessThan(statSync(fontSource(root, f)).size / 2);
  });
});
