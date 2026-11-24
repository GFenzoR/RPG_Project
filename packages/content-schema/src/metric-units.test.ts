// Every unit the player reads is metric (owner, 2026-11-23; docs/02 "Unidades"): weights in
// g and kg, distances in metres (1 tile = 1 m), areas in m², temperatures in °C. This
// scans every value of i18n/<lang>/*.yaml for the imperial units that slipped in before
// ("oz" in the weights of the inventory and the item cards). A few words are also
// ordinary words: the feet equipment slot ("pies", "feet"), the foot of a mountain or a
// stair, "set foot", a yard as an enclosed place. Those texts are allowed one by one
// (ALLOWED): a new text that uses one of the words must be added there on purpose.
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
};

function texts(lang: string): Array<{ file: string; key: string; text: string }> {
  const dir = join(REPO, "i18n", lang);
  const out: Array<{ file: string; key: string; text: string }> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
    const doc = parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown> | null;
    for (const [key, value] of Object.entries(doc ?? {})) {
      if (typeof value === "string") out.push({ file, key, text: value });
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

  for (const lang of LANGS) {
    it(`i18n/${lang} has no imperial unit`, () => {
      const found = texts(lang)
        .map(({ file, key, text }) => ({ file, key, words: imperialWords(key, text) }))
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
