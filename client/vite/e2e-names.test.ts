// The names the E2E suites give their characters (e2e/names.ts) are ones the server takes:
// a tag one letter too long once made eight Playwright tests fail with invalid_name, and
// nothing short of the whole e2e run showed it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CREATURE_NAME_MAX_CHARS } from "@rpg/content-schema/npc-role";
import { describe, expect, it } from "vitest";
import { NAME_MAX, characterName } from "../e2e/names.ts";

const dir = join(import.meta.dirname, "..", "e2e");
const specs = readdirSync(dir)
  .filter((f) => f.endsWith(".spec.ts"))
  .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }));
/** The server's rule (auth.ValidCharacterName): 1-3 capitalized ASCII words. */
const VALID = /^[A-Z][a-z]+( [A-Z][a-z]+){0,2}$/;

describe("character names of the E2E suites", () => {
  it("uses the limit of the server and the labels", () => {
    expect(NAME_MAX).toBe(CREATURE_NAME_MAX_CHARS);
  });

  it("builds a valid name of at most the limit, and refuses a tag too long", () => {
    for (const tag of ["Mano", "Walker", "Mercader", "Inquilino", "Abcdefghijk"]) {
      const name = characterName(tag);
      expect(name).toMatch(VALID);
      expect(name.startsWith(`${tag} `)).toBe(true);
      expect(name.length, name).toBeLessThanOrEqual(NAME_MAX);
      expect(name.length - tag.length - 1, name).toBeGreaterThanOrEqual(4);
    }
    expect(characterName("Longname")).toHaveLength(NAME_MAX);
    expect(() => characterName("Cartographer")).toThrow(/too long/);
    expect(() => characterName("two Words")).toThrow(/capitalized/);
  });

  it("no spec builds a character name by hand, and every tag leaves room", () => {
    const tags: string[] = [];
    for (const { file, text } of specs) {
      // A capitalized randomLetters(8): the template every spec used before characterName.
      expect(/randomLetters\(\d+\)\.replace\(/.test(text), file).toBe(false);
      for (const m of text.matchAll(
        /(?:characterName|newGuardian\(\s*playwright,|account\(\s*"[a-z-]+",)\s*\(?"([^"]+)"/g,
      ))
        tags.push(m[1] ?? "");
    }
    expect(tags.length).toBeGreaterThan(40);
    for (const tag of tags) expect(() => characterName(tag), tag).not.toThrow();
  });
});
