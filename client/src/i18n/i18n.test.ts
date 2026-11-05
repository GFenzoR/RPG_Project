import { describe, expect, it } from "vitest";
import { pickLanguage, takeLangParam, translator } from "./i18n.ts";

describe("i18n", () => {
  it("picks ?lang=, then the stored choice, then the browser language, then Spanish", () => {
    expect(pickLanguage(["es", "en"], "en", "es-CL")).toBe("en");
    expect(pickLanguage(["es", "en"], "fr", "en-US")).toBe("en");
    expect(pickLanguage(["es", "en"], null, "de-DE")).toBe("es");
    expect(pickLanguage(["es", "en"], null, "es-CL", "en")).toBe("en");
    expect(pickLanguage(["es", "en"], "es", "en-US", "en")).toBe("es");
    expect(pickLanguage(["es", "en"], null, "en-US", "xx")).toBe("en");
  });

  it("fills {params} and returns unknown keys as is", () => {
    const t = translator({ "a.b": "Hola {name}, nivel {level}" });
    expect(t("a.b", { name: "Mira", level: 3 })).toBe("Hola Mira, nivel 3");
    expect(t("missing.key")).toBe("missing.key");
  });

  it("formats ICU plurals per language, exact matches first", () => {
    const text = "{n, plural, =0 {nada} one {# segundo} other {# segundos}} ({who})";
    const es = translator({ k: text }, "es");
    expect(es("k", { n: 0, who: "x" })).toBe("nada (x)");
    expect(es("k", { n: 1, who: "x" })).toBe("1 segundo (x)");
    expect(es("k", { n: 5, who: "x" })).toBe("5 segundos (x)");
    const en = translator({ k: "{n, plural, one {# second} other {# seconds}}" }, "en");
    expect(en("k", { n: 1 })).toBe("1 second");
    expect(en("k", { n: 2 })).toBe("2 seconds");
  });

  it("never parses parameter values again", () => {
    const t = translator({ k: "{name}: {text}" });
    expect(t("k", { name: "A", text: "{name} <b>#</b> {n, plural, other {x}}" })).toBe(
      "A: {name} <b>#</b> {n, plural, other {x}}",
    );
  });
});

describe("takeLangParam (T4.3)", () => {
  it("splits ?lang= off and keeps the other parameters", () => {
    expect(takeLangParam("?lang=en&page=2")).toEqual({ lang: "en", rest: "?page=2" });
    expect(takeLangParam("?lang=es")).toEqual({ lang: "es", rest: "" });
    expect(takeLangParam("?category=sword")).toEqual({ lang: null, rest: "?category=sword" });
    expect(takeLangParam("")).toEqual({ lang: null, rest: "" });
  });
});
