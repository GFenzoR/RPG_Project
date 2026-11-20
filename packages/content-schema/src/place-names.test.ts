// Place names (docs/02-game-design.md, "Nombres del mundo"): every island, town and zone has
// a proper name in every language, the retired descriptive names ("Isla del Puerto", "Raigal",
// "Brasal"...) are gone from every player-visible text, and no name borrows a word or a place
// from Tolkien's works (the owner asked for that flavour; the legal rule forbids the names).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const LANGS = ["es", "en"] as const;

function catalog(lang: string): Record<string, string> {
  const dir = join(REPO, "i18n", lang);
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yaml"))) {
    Object.assign(out, parse(readFileSync(join(dir, f), "utf8")) as Record<string, string>);
  }
  return out;
}

const CATALOGS = Object.fromEntries(LANGS.map((l) => [l, catalog(l)])) as Record<
  (typeof LANGS)[number],
  Record<string, string>
>;

const ISLANDS = readdirSync(join(REPO, "world", "islands"));

function zoneIds(island: string): string[] {
  const raw = readFileSync(join(REPO, "world", "islands", island, "zones.yaml"), "utf8");
  const zones = (parse(raw) ?? []) as { id: string }[];
  return zones.map((z) => z.id);
}

/** The keys that hold a place name: islands, towns, zones and named hunting areas. */
function placeKeys(lang: (typeof LANGS)[number]): string[] {
  return Object.keys(CATALOGS[lang]).filter((k) =>
    /^(island|town|zone|area)\.[a-z0-9_.]+\.name$/.test(k),
  );
}

/** Descriptive names the islands and towns had before they got proper names (2026-11-20). */
const RETIRED = [
  "Isla del Puerto",
  "Isla del Bosque",
  "Isla Volcánica",
  "Isla de Pruebas",
  "Islote de ensayo",
  "Harbour Isle",
  "Forest Isle",
  "Ember Isle",
  "Sandbox Isle",
  "Raigal",
  "Brasal",
];

/**
 * Tolkien's places, peoples and words of his languages that a name must not contain
 * (lower case). Not exhaustive: the review of each name (docs/02) is the real guard; this
 * catches the obvious copies.
 */
const TOLKIEN = [
  "rivendell",
  "gondor",
  "mordor",
  "shire",
  "moria",
  "rohan",
  "isengard",
  "lorien",
  "lothl",
  "mithril",
  "mellon",
  "galad",
  "amon",
  "ithil",
  "anor",
  "minas",
  "barad",
  "erebor",
  "durin",
  "khazad",
  "bree",
  "hobbit",
  "valinor",
  "numenor",
  "eriador",
  "arnor",
  "osgiliath",
  "edoras",
  "helm",
  "fangorn",
  "mirkwood",
  "esgaroth",
  "dale",
  "beleriand",
  "doriath",
  "gondolin",
  "nargothrond",
  "silmar",
  "elrond",
  "arwen",
  "sauron",
  "gandalf",
  "olorin",
  "hollin",
  "bywater",
  "hobbiton",
  "buckland",
  "barrow",
  "orthanc",
  "angmar",
  "umbar",
  "harad",
];

describe("place names", () => {
  it("every island has a name in every language", () => {
    for (const lang of LANGS) {
      for (const island of ISLANDS) {
        expect(
          CATALOGS[lang][`island.${island}.name`],
          `${lang}: island.${island}.name`,
        ).toBeTruthy();
      }
    }
  });

  it("every zone of world/islands/*/zones.yaml has a name in every language", () => {
    const ids = ISLANDS.flatMap(zoneIds);
    expect(ids.length).toBeGreaterThan(10);
    for (const lang of LANGS) {
      for (const id of ids) {
        expect(CATALOGS[lang][`zone.${id}.name`], `${lang}: zone.${id}.name`).toBeTruthy();
      }
    }
  });

  it("every island with houses (a town) has a town name, the same in both languages", () => {
    for (const island of ISLANDS) {
      const path = join(REPO, "world", "islands", island, "houses.yaml");
      if (island === "pruebas" || !existsSync(path)) continue;
      const houses = (parse(readFileSync(path, "utf8")) ?? []) as unknown[];
      if (houses.length === 0) continue;
      const es = CATALOGS.es[`town.${island}.name`];
      expect(es, `town.${island}.name`).toBeTruthy();
      expect(CATALOGS.en[`town.${island}.name`]).toBe(es);
    }
  });

  it("place keys exist in both languages", () => {
    expect(placeKeys("es").sort()).toEqual(placeKeys("en").sort());
  });

  it("no player-visible text uses a retired name", () => {
    for (const lang of LANGS) {
      for (const [key, text] of Object.entries(CATALOGS[lang])) {
        for (const old of RETIRED) {
          expect(String(text).includes(old), `${lang}: ${key} still says "${old}"`).toBe(false);
        }
      }
    }
    // In English the Lantern is the faith; "Farol" was only the town.
    for (const [key, text] of Object.entries(CATALOGS.en)) {
      expect(String(text).includes("Farol"), `en: ${key} still says "Farol"`).toBe(false);
    }
    const newsDir = join(REPO, "data", "news");
    for (const f of readdirSync(newsDir)) {
      const text = readFileSync(join(newsDir, f), "utf8");
      for (const old of RETIRED) expect(text.includes(old), `${f} still says "${old}"`).toBe(false);
    }
  });

  it("no place name borrows a Tolkien name or word", () => {
    for (const lang of LANGS) {
      for (const key of placeKeys(lang)) {
        const words = String(CATALOGS[lang][key])
          .toLowerCase()
          .split(/[^a-záéíóúñü]+/)
          .filter(Boolean);
        for (const w of words) {
          for (const t of TOLKIEN) {
            expect(w.includes(t), `${lang}: ${key} ("${w}") contains "${t}"`).toBe(false);
          }
          expect(
            /(dor|ost|ithil|wen)$/.test(w),
            `${lang}: ${key} ("${w}") ends like a Sindarin name`,
          ).toBe(false);
        }
      }
    }
  });
});
