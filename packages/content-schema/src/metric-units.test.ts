// Every unit the player reads is metric (owner, 2026-11-23; docs/02 "Unidades"): weights in
// g and kg, distances in metres (1 tile = 1 m), areas in m², temperatures in °C. This
// scans every value of i18n/<lang>/*.yaml for the imperial units that slipped in before
// ("oz" in the weights of the inventory and the item cards). A few words are also
// ordinary words: the feet equipment slot ("pies", "feet"), the foot of a mountain or a
// stair, "set foot", a yard as an enclosed place. Those texts are allowed one by one
// (ALLOWED): a new text that uses one of the words must be added there on purpose.
// The news of data/news are player texts too (title and body, per language) and are
// scanned the same way; the rest of data/ holds only i18n keys (docs/06 "Convenciones").
// A distance counted in tiles ("3 casillas", "{range} tiles") fails too: 1 tile = 1 m,
// so the text says metres. The editor's catalogue is left out of that: there a tile is
// the thing being painted, not a distance.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const LANGS = ["es", "en"];

// Word boundaries written by hand: \b does not treat "ú" or "á" as word characters.
const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";

/** Imperial (and other non-metric) units, in Spanish and in English. */
const IMPERIAL = new RegExp(
  `${B}(oz|onzas?|libras?|pounds?|lbs?|pies?|pulgadas?|inch|inches|feet|foot|ft|yardas?|yards?|yd|millas?|miles?|leguas?|leagues?|fahrenheit|gallons?|pints?|quarts?)${E}|°\\s?F${E}`,
  "iu",
);

/** Texts allowed to use one of the words, and the word they use (not a unit there). */
const ALLOWED: Record<string, string[]> = {
  // The equipment slot for the feet.
  "client.inventory.slot.feet": ["pies", "feet"],
  "client.card.slot.feet": ["pies", "feet"],
  // Body parts and places in the lore.
  "book.book_still_flame.page_1": ["pies", "feet"], // "a sus pies", "at its feet"
  "book.scroll_drowned_wall.page_2": ["pie", "foot"], // "al pie de la escalera"
  "npc.volcan_ferryman.island": ["foot"], // "sets foot in"
  "npc.bosque_ferryman.island": ["foot"], // "set foot in"
  "zone.testisle_no_pvp.name": ["yard"], // "Truce Yard"
  "text.pruebas.portal_sign": ["yard"], // "Yard of portals"
  "text.pruebas.temple_sign": ["yard"], // "yard of portals"
  "news/2026-11-20-nombres-del-mundo.yaml:body": ["pie", "foot"], // "al pie de la montaña"
};

/** A distance counted in tiles: a number or a parameter, then "casillas" or "tiles". */
const TILE_DISTANCE = new RegExp(`(?:[0-9]+|[{][^}]+[}]) *(?:casillas?|tiles?)${E}`, "giu");

/** The tile distances of text. */
function tileDistances(text: string): string[] {
  return [...text.matchAll(TILE_DISTANCE)].map((m) => m[0]);
}

function texts(lang: string): Array<{ file: string; key: string; text: string }> {
  const dir = join(REPO, "i18n", lang);
  const out: Array<{ file: string; key: string; text: string }> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    const doc = parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown> | null;
    for (const [key, value] of Object.entries(doc ?? {})) {
      if (typeof value === "string") out.push({ file, key, text: value });
    }
  }
  return [...out, ...news(lang)];
}

/** The title and the body of every post of data/news in lang. */
function news(lang: string): Array<{ file: string; key: string; text: string }> {
  const dir = join(REPO, "data", "news");
  const out: Array<{ file: string; key: string; text: string }> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    const doc = parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown> | null;
    for (const field of ["title", "body"]) {
      const value = (doc?.[field] as Record<string, unknown> | undefined)?.[lang];
      if (typeof value === "string")
        out.push({ file: `news/${file}`, key: `news/${file}:${field}`, text: value });
    }
  }
  return out;
}

/** The unit words of text that ALLOWED does not let through for its key. */
function imperialWords(key: string, text: string): string[] {
  const all = new RegExp(IMPERIAL.source, "giu");
  const ok = new Set((ALLOWED[key] ?? []).map((w) => w.toLowerCase()));
  return [...text.matchAll(all)].map((m) => m[0]).filter((w) => !ok.has(w.toLowerCase()));
}

describe('metric units in every catalogue (docs/02 "Unidades")', () => {
  it("finds the imperial units it is meant to catch", () => {
    expect(imperialWords("x", "Pesa {weight} oz.")).toEqual(["oz"]);
    expect(imperialWords("x", "A diez pies del muelle.")).toEqual(["pies"]);
    expect(imperialWords("x", "Two miles north, 30 °F.")).toEqual(["miles", "°F"]);
    expect(imperialWords("x", "Five pounds of ore, 3 ft deep.")).toEqual(["pounds", "ft"]);
    // Words that only contain one: not units.
    expect(imperialWords("x", "Shipyard, graveyard, ozono, milestone, piedra")).toEqual([]);
    // An allowed text lets only its own word through.
    expect(imperialWords("client.card.slot.feet", "pies")).toEqual([]);
    expect(imperialWords("client.card.slot.feet", "pies, 3 oz")).toEqual(["oz"]);
  });

  it("finds a distance counted in tiles", () => {
    expect(tileDistances("Alcance: 5 casillas.")).toEqual(["5 casillas"]);
    expect(tileDistances("Reaches {range} tiles, or 1 tile.")).toEqual(["{range} tiles", "1 tile"]);
    // A tile that is a place, not a count, is fine.
    expect(tileDistances("Haz clic en una casilla. Click a tile; {n} tileset")).toEqual([]);
  });

  it("scans the news of data/news too", () => {
    for (const lang of LANGS) {
      expect(texts(lang).some((t) => t.key.startsWith("news/") && t.key.endsWith(":body"))).toBe(
        true,
      );
    }
  });

  // An area written by the server inside a sentence (house.look_free: the size is a
  // plain number parameter) uses the same symbol as client.unit.m2.
  it("house.look_free writes its size in m²", () => {
    for (const lang of LANGS) {
      const all = texts(lang);
      const text = (key: string) => all.find((t) => t.key === key)?.text ?? "";
      expect(text("client.unit.m2")).toBe("{m2} m²");
      expect(text("house.look_free")).toContain("{size} m²");
    }
  });

  for (const lang of LANGS) {
    it(`i18n/${lang} has no imperial unit`, () => {
      const found = texts(lang)
        .map(({ file, key, text }) => ({ file, key, words: imperialWords(key, text) }))
        .filter((f) => f.words.length > 0)
        .map((f) => `${f.file} ${f.key}: ${f.words.join(", ")}`);
      expect(found).toEqual([]);
    });

    it(`i18n/${lang} counts no distance in tiles`, () => {
      const found = texts(lang)
        .filter((t) => t.file !== "editor.yaml")
        .map(({ file, key, text }) => ({ file, key, words: tileDistances(text) }))
        .filter((f) => f.words.length > 0)
        .map((f) => `${f.file} ${f.key}: ${f.words.join(", ")}`);
      expect(found).toEqual([]);
    });
  }

  it("every allowed text still exists (a stale entry hides nothing)", () => {
    const keys = new Set(LANGS.flatMap((l) => texts(l).map((t) => t.key)));
    expect(Object.keys(ALLOWED).filter((k) => !keys.has(k))).toEqual([]);
  });
});
