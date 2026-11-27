// The novice protection's level reaches the player from data/balance.yaml, never from a
// literal (docs/02 "Muerte"): balance -> loadClientContent -> the tutorial's note, and the
// real es/en texts name the level with a parameter.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { translator } from "../src/i18n/i18n.ts";
import { tutorialNoviceNote } from "../src/ui/Tutorial.tsx";
import { loadClientContent } from "./content.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const yaml = (...path: string[]): unknown => parse(readFileSync(join(REPO, ...path), "utf8"));
const balance = yaml("data", "balance.yaml") as { death: { novice_max_level: number } };
const max = balance.death.novice_max_level;
const content = loadClientContent(REPO);
const STEP = "tutorial.step.open_backpack";

describe("novice protection: from the balance to the texts", () => {
  it("the client content carries death.novice_max_level of the real balance", () => {
    expect(max).toBeGreaterThan(0);
    expect(content.death).toEqual({ noviceMaxLevel: max });
  });

  it.each(["es", "en"])("the %s tutorial note names the balance's level", (lang) => {
    const t = translator(content.i18n[lang] ?? {}, lang);
    const note = tutorialNoviceNote(t, STEP, content);
    expect(note).toBeDefined();
    expect(note).toContain(` ${max} `);
    expect(note).not.toMatch(/[{}]/);
    // Another balance, another level: nothing in the text is fixed.
    expect(tutorialNoviceNote(t, STEP, { death: { noviceMaxLevel: max + 3 } })).toContain(
      ` ${max + 3} `,
    );
    // The step itself no longer needs a parameter the panel might not have.
    expect(t(STEP, { count: 1 })).not.toMatch(/[{}]/);
  });

  it.each(["es", "en"])("no %s note without a protection or without the text", (lang) => {
    const t = translator(content.i18n[lang] ?? {}, lang);
    expect(tutorialNoviceNote(t, STEP, { death: { noviceMaxLevel: 0 } })).toBeUndefined();
    expect(tutorialNoviceNote(t, STEP, {})).toBeUndefined();
    expect(tutorialNoviceNote(t, STEP, undefined)).toBeUndefined();
    expect(tutorialNoviceNote(t, "tutorial.step.first_steps", content)).toBeUndefined();
  });

  it.each(["es", "en"])("the %s texts take every level from a parameter", (lang) => {
    const texts = content.i18n[lang] ?? {};
    const keys = [
      "death.novice",
      "death.novice_back",
      "client.death.novice",
      "progress.novice_last",
      "progress.novice_ended",
      `${STEP}.novice`,
    ];
    for (const key of keys) {
      const text = texts[key];
      expect(text, key).toBeDefined();
      expect(text, key).toMatch(/\{(level|blessing_level)\}/);
      expect(text, key).not.toMatch(/\d/); // no literal level, whatever the balance says
    }
    // The priests sell the blessings once the protection ends: no level written out either.
    const npcs = yaml("i18n", lang, "npcs.yaml") as Record<string, string>;
    const priests = Object.entries(npcs).filter(([k]) => /_priest\.blessings$/.test(k));
    expect(priests.length).toBeGreaterThan(0);
    for (const [k, text] of priests) expect(text, k).not.toMatch(/(nivel|level) \d/);
  });

  it("the priests' blessings open right after the protection, as their texts say", () => {
    const dir = join(REPO, "data", "npcs");
    let gates = 0;
    for (const f of readdirSync(dir).filter((n) => n.endsWith("_priest.yaml"))) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/level_at_least: (\d+) \}.*novice_max_level/g)) {
        gates++;
        expect(Number(m[1]), f).toBe(max + 1);
      }
    }
    expect(gates).toBeGreaterThan(0);
  });
});
