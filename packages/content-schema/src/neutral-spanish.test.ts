// The player character can be a man or a woman, so the Spanish texts never address the
// player with a masculine-only form ("bienvenido", "estás listo", "tú mismo",
// "desprevenido"...). Each text is reworded to neutral Spanish instead of an ICU select
// (docs/06-content-data.md). This scans every value of i18n/es/*.yaml for the second-person
// forms that slipped in before; texts about NPCs or monsters ("Bastian se va a poner
// contento") are not second person and do not match.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ES = join(REPO, "i18n/es");

// Word boundaries written by hand: \b does not treat "ú" or "á" as word characters.
const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";

/** Masculine-only ways of speaking to the player. */
const MASCULINE: RegExp[] = [
  new RegExp(`${B}(tú|ti) mismo${E}`, "iu"),
  new RegExp(`${B}bienvenido${E}`, "iu"),
  new RegExp(`${B}desprevenido${E}`, "iu"),
  new RegExp(
    `${B}(estás|estarás|quedas|quedarás|eres|serás|pareces) (listo|lleno|herido|entero|tranquilo|solo|cansado|seguro|preparado|perdido|muerto|atrapado|envenenado|equivocado|acelerado|saciado|desprevenido|conectado)${E}`,
    "iu",
  ),
];

/**
 * The player's own lines (the dialogue options, keys `*.opt_*`) in the first person with a
 * masculine word after "estoy", "soy"... ("Estoy cansado", "Soy nuevo"): any word ending in
 * -o/-os, but a gerund ("Sigo buscando") or a word that is not gendered.
 */
const FIRST_PERSON = new RegExp(
  `${B}(estoy|estaba|soy|era|me siento|me quedé|quedé|sigo|ando|vengo|llego|vuelvo) ([\\p{L}]+)${E}`,
  "giu",
);
const NOT_GENDERED = new Set(["yo", "como", "dentro", "pronto", "tarde", "aquí"]);

function playerSpeaksAsAMan(text: string): boolean {
  for (const m of text.matchAll(FIRST_PERSON)) {
    const word = (m[2] ?? "").toLowerCase();
    if (/os?$/u.test(word) && !/ndos?$/u.test(word) && !NOT_GENDERED.has(word)) return true;
  }
  return false;
}

function isOption(key: string): boolean {
  return /(^|\.)opt_/u.test(key);
}

function texts(): Array<{ file: string; key: string; text: string }> {
  const out: Array<{ file: string; key: string; text: string }> = [];
  for (const file of readdirSync(ES).filter((f) => f.endsWith(".yaml"))) {
    const doc = parse(readFileSync(join(ES, file), "utf8")) as Record<string, unknown> | null;
    for (const [key, value] of Object.entries(doc ?? {})) {
      if (typeof value === "string") out.push({ file, key, text: value });
    }
  }
  return out;
}

describe("Spanish texts for a man or a woman", () => {
  it("reads at least the NPC and client texts", () => {
    const files = new Set(texts().map((t) => t.file));
    expect(files).toContain("npcs.yaml");
    expect(files).toContain("client.yaml");
  });

  it("never address the player with a masculine-only form", () => {
    const hits = texts()
      .filter(({ text }) => MASCULINE.some((re) => re.test(text)))
      .map(({ file, key, text }) => `${file} ${key}: ${text}`);
    expect(hits).toEqual([]);
  });

  it("never let the player speak of itself as a man in a dialogue option", () => {
    const options = texts().filter(({ key }) => isOption(key));
    expect(options.length).toBeGreaterThan(20);
    const hits = options
      .filter(({ text }) => playerSpeaksAsAMan(text))
      .map(({ file, key, text }) => `${file} ${key}: ${text}`);
    expect(hits).toEqual([]);
  });

  it("catches the first-person forms it is meant to catch", () => {
    for (const bad of [
      "Estoy cansado.",
      "Soy nuevo en la isla.",
      "Me siento perdido.",
      "Vengo preparado.",
    ]) {
      expect(playerSpeaksAsAMan(bad), bad).toBe(true);
    }
    for (const ok of [
      "Tengo heridas.",
      "Vengo del naufragio.",
      "Vengo siguiendo un bote sin bandera.",
      "Sigo buscando al contramaestre.",
      "Estoy aquí.",
      "Soy yo.",
    ]) {
      expect(playerSpeaksAsAMan(ok), ok).toBe(false);
    }
    expect(isOption("npc.harbor_master.opt_shipwreck")).toBe(true);
    expect(isOption("npc.harbor_master.greet")).toBe(false);
  });

  it("catches the forms it is meant to catch", () => {
    for (const bad of [
      "Que ninguna chispa te encuentre desprevenido.",
      "Con él podrás sacar mineral tú mismo.",
      "Bienvenido a la isla.",
      "¿Estás listo?",
    ]) {
      expect(
        MASCULINE.some((re) => re.test(bad)),
        bad,
      ).toBe(true);
    }
    for (const ok of [
      "Te doy la bienvenida al templo.",
      "Bastian se va a poner contento.",
      "Podrás sacar mineral por tu cuenta.",
    ]) {
      expect(
        MASCULINE.some((re) => re.test(ok)),
        ok,
      ).toBe(false);
    }
  });
});
