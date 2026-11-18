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

  it("cuts a font down to a small woff2", async () => {
    const f = FONTS.find((x) => x.family === "Cinzel");
    if (!f) throw new Error("no Cinzel");
    const out = await buildFont(root, f);
    expect(out.subarray(0, 4).toString("latin1")).toBe("wOF2");
    expect(out.length).toBeLessThan(statSync(fontSource(root, f)).size / 2);
  });
});
