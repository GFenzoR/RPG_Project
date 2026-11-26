// The names the E2E suites give their characters (e2e/names.ts) are ones the server takes:
// a tag one letter too long once made eight Playwright tests fail with invalid_name, and
// nothing short of the whole e2e run showed it.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CREATURE_NAME_MAX_CHARS } from "@rpg/content-schema/npc-role";
import { describe, expect, it } from "vitest";
import { NAME_MAX, characterName } from "../e2e/names.ts";

const dir = join(import.meta.dirname, "..", "e2e");
const read = (folder: string, f: string): { file: string; text: string } => ({
  file: f,
  text: readFileSync(join(folder, f), "utf8"),
});
const specs = readdirSync(dir)
  .filter((f) => f.endsWith(".spec.ts"))
  .map((f) => read(dir, f));
/** Everything that creates characters on a real server: the specs and the desktop smoke. */
const desktop = join(import.meta.dirname, "..", "..", "apps", "desktop", "e2e");
const creators = [...specs, read(desktop, "smoke.ts")];
/** The server's rule (auth.ValidCharacterName): 1-3 capitalized ASCII words. */
const VALID = /^[A-Z][a-z]+( [A-Z][a-z]+){0,2}$/;

/**
 * Where a file creates a character (a POST to /api/characters, or the name field of the
 * form) and the identifier that carries the name there: `name`, `rangerName`, or the
 * `name` of `author.name`.
 */
function creations(text: string): { at: number; id: string }[] {
  const out: { at: number; id: string }[] = [];
  const sites = [
    // post("/api/characters", { data: { name[: expr], … } }) and
    // api("/api/characters", { name[: expr], … })
    /"\/api\/characters",\s*\{\s*(?:data:\s*\{\s*)?name(?::\s*([\w.]+))?\s*,/g,
    // The form of the character list.
    /getByLabel\("Nombre"\)\.fill\(([\w.]+)\)/g,
  ];
  for (const re of sites)
    for (const m of text.matchAll(re))
      out.push({ at: m.index, id: (m[1] ?? "name").split(".").pop() ?? "name" });
  return out;
}

/** What the nearest declaration of `id` before `at` gives it: a const, a default or a field. */
function sourceOf(text: string, id: string, at: number): string {
  const decl = new RegExp(String.raw`^[ \t]*(?:const |let )?${id}\s*[:=]\s*(.+)$`, "gm");
  let last = "";
  for (const m of text.slice(0, at).matchAll(decl)) last = m[1] ?? "";
  return last;
}

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

  it("every tag a spec gives characterName leaves room for the random letters", () => {
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

  it("every character an E2E creates takes its name from characterName", () => {
    // Not only the old template: a literal, or a name put together some other way, is
    // caught too, in the specs and in the desktop smoke test (apps/desktop/e2e/smoke.ts).
    let found = 0;
    for (const { file, text } of creators) {
      const here = creations(text);
      if (file === "smoke.ts") expect(here).toHaveLength(1);
      for (const { at, id } of here) {
        found++;
        const line = text.slice(0, at).split("\n").length;
        expect(sourceOf(text, id, at), `${file}:${line} (${id})`).toMatch(/^characterName\(/);
      }
    }
    expect(found).toBeGreaterThanOrEqual(25);
  });

  it("sees a name built by hand, whatever its shape", () => {
    const post = (decl: string): string =>
      `${decl}\nawait apiCtx.post("/api/characters", {\n  data: { name, vocation: "guardian" },\n});`;
    const bad = [
      post('const name = "Desk Abcdefgh";'),
      post("const name = `Desk ${letters(8)}`;"),
      post('const name = ["Desk", tail].join(" ");'),
      'const who = "Hand Made";\nawait api("/api/characters", { name: who, vocation: "guardian" }, token);',
      'const who = "Hand Made";\nawait form.getByLabel("Nombre").fill(who);',
    ];
    for (const text of bad) {
      const [site] = creations(text);
      expect(site, text).toBeDefined();
      expect(sourceOf(text, site?.id ?? "", site?.at ?? 0), text).not.toMatch(/^characterName\(/);
    }
    const good = post('const name = characterName("Desk");');
    expect(sourceOf(good, "name", creations(good)[0]?.at ?? 0)).toMatch(/^characterName\(/);
  });
});
