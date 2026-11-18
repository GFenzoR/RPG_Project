import { describe, expect, it } from "vitest";
import { licenceUrl, packKeys, safeLink } from "./credits.ts";

describe("credits page helpers (docs/17 A1)", () => {
  it("links each accepted licence to its text", () => {
    expect(licenceUrl("OGA-BY 3.0")).toBe("https://static.opengameart.org/OGA-BY-3.0.txt");
    expect(licenceUrl("CC-BY-SA 3.0")).toBe("https://creativecommons.org/licenses/by-sa/3.0/");
    expect(licenceUrl("CC0")).toBe(licenceUrl("CC0 1.0"));
    expect(licenceUrl("OFL 1.1")).toMatch(/^https:\/\/openfontlicense\.org\//);
    expect(licenceUrl("GPL 3.0")).toBeUndefined();
    expect(licenceUrl("__proto__")).toBeUndefined();
  });

  it("only turns web addresses into links", () => {
    expect(safeLink("https://opengameart.org/content/lpc")).toBe(
      "https://opengameart.org/content/lpc",
    );
    expect(safeLink("http://example.org")).toBe("http://example.org/");
    expect(safeLink("javascript:alert(1)")).toBeUndefined();
    expect(safeLink("data:text/html,x")).toBeUndefined();
    expect(safeLink("not a url")).toBeUndefined();
  });

  it("names a pack's texts by its folder, in snake_case", () => {
    expect(packKeys("ulpc")).toEqual({
      title: "site.credits.pack.ulpc.title",
      author: "site.credits.pack.ulpc.author",
    });
    expect(packKeys("dungeon-crawl").title).toBe("site.credits.pack.dungeon_crawl.title");
    expect(packKeys("Some.Pack").author).toBe("site.credits.pack.some_pack.author");
  });
});
