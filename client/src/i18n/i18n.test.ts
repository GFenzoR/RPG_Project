import { describe, expect, it } from "vitest";
import { pickLanguage, translator } from "./i18n.ts";

describe("i18n", () => {
  it("picks ?lang=, then the browser language, then Spanish", () => {
    expect(pickLanguage(["es", "en"], "en", "es-CL")).toBe("en");
    expect(pickLanguage(["es", "en"], "fr", "en-US")).toBe("en");
    expect(pickLanguage(["es", "en"], null, "de-DE")).toBe("es");
  });

  it("fills {params} and returns unknown keys as is", () => {
    const t = translator({ "a.b": "Hola {name}, nivel {level}" });
    expect(t("a.b", { name: "Mira", level: 3 })).toBe("Hola Mira, nivel 3");
    expect(t("missing.key")).toBe("missing.key");
  });
});
