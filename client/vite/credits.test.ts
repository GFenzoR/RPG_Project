import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { markdownSection, markdownTableRows } from "@rpg/spritepack";
import { describe, expect, it } from "vitest";
import { licenceUrl, packKeys } from "../src/site/credits.ts";
import { loadSiteContent, repoRoot } from "./content.ts";
import { FONTS } from "./fonts.ts";
import { creditsFrom, fileCredits, licenceNames, loadCredits } from "./credits.ts";

const root = repoRoot();

const MD = [
  "# Créditos",
  "",
  "| Pack / archivo | Autor | Licencia | Fuente (URL) | Carpeta | Atribución requerida |",
  "|---|---|---|---|---|---|",
  "| Tiles | Artists | CC0 1.0 | https://example.org/tiles (también https://x) | `assets/vendor/tiles/` | No |",
  "| People | By file | Por archivo: OGA-BY 3.0 o CC-BY-SA 3.0. Nunca bajo GPL | https://example.org/people (commit `abc`) | `assets/vendor/people/` | Sí |",
  "| Template | | | | `assets/vendor/...` | |",
  "",
  "## Obra propia",
  "| Archivos | Autor | Licencia | Fuente reproducible |",
  "|---|---|---|---|",
  "| `assets/vendor/not-a-pack/` | Us | CC0 1.0 | here |",
  "",
  "## Fuentes (OFL 1.1)",
  "| Familia | Autor | Licencia | Fuente | Carpeta |",
  "|---|---|---|---|---|",
  "| Serif (`Serif[wght].ttf`) | Copyright 2020 The Serif Authors (https://example.org/serif) | OFL 1.1 | https://example.org/fonts/serif | `assets/vendor/font-serif/` |",
  "",
  "## Obras derivadas de terceros",
  "| Archivos | Sale de | Licencia | Herramienta |",
  "|---|---|---|---|",
  "| Frames `<sprite>/<acción>_<dir>_<n>` de `outfits/citizen` y `npcs/merchant` | capas | OGA-BY 3.0 | spritepack |",
  "| Frames de `npcs/sailor_old` | capas | CC-BY-SA 3.0 | spritepack |",
  "| Más de `npcs/priest` | capas | **OGA-BY 3.0** | spritepack |",
  "",
  "## Generado con IA",
  "| Archivos | Herramienta | Fecha | Prompt | Notas |",
  "|---|---|---|---|---|",
  "| `assets/sprites/creatures/wolf/*.png` (frames de `creatures/wolf`) | Gemini | 2026-11-18 | `assets/prompts/sprites/creatures/wolf.txt` | 64x64 |",
  "| `assets/sounds/music/puerto.ogg` | Gemini | 2026-11-19 | `assets/prompts/sounds/music/puerto.txt` | — |",
  "| `assets/sprites/creatures/rat/*.png` | Gemini | sin fecha | `assets/prompts/sprites/creatures/rat.txt` | no day: not shown |",
  "| `assets/sprites/creatures/bat/*.png` | Gemini | 2026-11-18 | en el chat | no prompt file: not shown |",
].join("\n");

const CSV = [
  "filename,notes,authors,licenses,urls",
  '"body/male/walk.png","" ,"A,B" ,"OGA-BY 3.0,CC-BY-SA 3.0,GPL 3.0" ,"https://example.org/body"',
  '"body/male/idle.png","" ,"A,B" ,"OGA-BY 3.0,CC-BY-SA 3.0,GPL 3.0" ,"https://example.org/body"',
  '"hair/long/walk.png","" ,"C" ,"CC-BY-SA 3.0,GPL 3.0" ,"https://example.org/hair,javascript:alert(1)"',
  '"bad/only-gpl.png","" ,"D" ,"GPL 3.0" ,"https://example.org/gpl"',
].join("\n");

describe("credits page data (docs/17 A1)", () => {
  it("reads packs, per-file credits, derived sprites and fonts from CREDITS.md", () => {
    const c = creditsFrom(MD, (pack) => (pack === "people" ? CSV : undefined));
    expect(c.packs).toEqual([
      { pack: "tiles", licences: ["CC0 1.0"], url: "https://example.org/tiles", perFile: false },
      {
        pack: "people",
        licences: ["OGA-BY 3.0", "CC-BY-SA 3.0"],
        url: "https://example.org/people",
        perFile: true,
      },
    ]);
    expect(c.files).toEqual([
      {
        pack: "people",
        works: ["body/male"],
        authors: ["A", "B"],
        licence: "OGA-BY 3.0",
        urls: ["https://example.org/body"],
      },
      {
        pack: "people",
        works: ["hair/long"],
        authors: ["C"],
        licence: "CC-BY-SA 3.0",
        // Only web links: anything else in the CSV never becomes a link.
        urls: ["https://example.org/hair"],
      },
    ]);
    expect(c.derived).toEqual([
      { licence: "OGA-BY 3.0", sprites: ["outfits/citizen", "npcs/merchant", "npcs/priest"] },
      { licence: "CC-BY-SA 3.0", sprites: ["npcs/sailor_old"] },
    ]);
    expect(c.ai).toEqual([
      {
        works: ["creatures/wolf"],
        date: "2026-11-18",
        prompt: "assets/prompts/sprites/creatures/wolf.txt",
      },
      {
        works: ["sounds/music/puerto"],
        date: "2026-11-19",
        prompt: "assets/prompts/sounds/music/puerto.txt",
      },
    ]);
    expect(c.fonts).toEqual([
      {
        family: "Serif",
        copyright: "Copyright 2020 The Serif Authors (https://example.org/serif)",
        licence: "OFL 1.1",
        url: "https://example.org/fonts/serif",
      },
    ]);
  });

  it("names licences without GPL or prose, and skips files with no accepted one", () => {
    expect(licenceNames("Por archivo: **OGA-BY 3.0** y CC-BY-SA 3.0, nunca GPL 3.0")).toEqual([
      "OGA-BY 3.0",
      "CC-BY-SA 3.0",
    ]);
    expect(licenceNames("CC0 1.0 (CC0 1.0)")).toEqual(["CC0 1.0"]);
    expect(fileCredits("p", CSV).flatMap((f) => f.works)).not.toContain("bad");
    expect(creditsFrom("", () => undefined)).toEqual({
      packs: [],
      files: [],
      derived: [],
      fonts: [],
      ai: [],
    });
  });

  it("credits every vendor pack, LPC file, composed sprite and font of the repository", () => {
    const c = loadCredits(root);
    const md = readFileSync(join(root, "assets", "CREDITS.md"), "utf8");
    expect(c.packs.map((p) => p.pack)).toEqual(expect.arrayContaining(["dungeon-crawl"]));
    for (const p of c.packs) {
      expect(md).toContain(`assets/vendor/${p.pack}/`);
      expect(p.licences.length, p.pack).toBeGreaterThan(0);
      expect(p.url, p.pack).toMatch(/^https:\/\//);
    }
    // Every row of a per-file pack's CREDITS.csv is on the page, each under an accepted
    // licence. Since the engine humanoids (docs/17) replaced the LPC characters there is no
    // such pack, nor any composed sprite: the page leaves those sections out.
    const works = new Set<string>();
    for (const p of c.packs.filter((x) => x.perFile)) {
      const csv = readFileSync(join(root, "assets", "vendor", p.pack, "CREDITS.csv"), "utf8");
      for (const l of csv.split("\n").filter((x) => x.startsWith('"')))
        works.add((l.slice(1, l.indexOf('"', 1)).match(/^(.*)\//) ?? [])[1] ?? "");
    }
    expect(new Set(c.files.flatMap((f) => f.works))).toEqual(works);
    for (const f of c.files) {
      expect(f.authors.length, f.works.join()).toBeGreaterThan(0);
      expect(["OGA-BY 3.0", "CC-BY-SA 3.0"]).toContain(f.licence);
    }
    expect(c.derived.flatMap((d) => d.sprites)).toEqual([]);
    expect(new Set(c.fonts.map((f) => f.family))).toEqual(new Set(FONTS.map((f) => f.family)));
    // Every row of "Generado con IA" is on the page, and its prompt file is committed.
    const aiRows = markdownTableRows(markdownSection(md, "## Generado con IA")).slice(1);
    expect(c.ai.length).toBe(aiRows.length);
    for (const a of c.ai) expect(existsSync(join(root, a.prompt)), a.prompt).toBe(true);
    expect(c.ai.flatMap((a) => a.works)).toEqual(expect.arrayContaining(["creatures/wolf"]));
  });

  it("links every licence it names and has a name and author for every pack in es and en", () => {
    const c = loadCredits(root);
    const named = [
      ...c.packs.flatMap((p) => p.licences),
      ...c.files.map((f) => f.licence),
      ...c.derived.map((d) => d.licence),
      ...c.fonts.map((f) => f.licence),
    ];
    for (const l of named) expect(licenceUrl(l), l).toMatch(/^https:\/\//);
    const { i18n } = loadSiteContent(root);
    for (const lang of ["es", "en"])
      for (const p of c.packs) {
        const keys = packKeys(p.pack);
        expect(i18n[lang]?.[keys.title], `${lang} ${keys.title}`).toBeTruthy();
        expect(i18n[lang]?.[keys.author], `${lang} ${keys.author}`).toBeTruthy();
      }
    expect(licenceUrl("GPL 3.0")).toBeUndefined();
    expect(licenceUrl("toString")).toBeUndefined();
  });
});
