import { describe, expect, it } from "vitest";
import {
  categoryKey,
  filtersToSearch,
  highscoresPath,
  linkToken,
  parseFilters,
  parseRoute,
} from "./routes.ts";

const skills = ["sword", "fishing"];
const vocations = ["guardian", "arcanist"];

describe("site routes", () => {
  it("maps paths to pages", () => {
    expect(parseRoute("/")).toEqual({ page: "home" });
    expect(parseRoute("/index.html")).toEqual({ page: "home" });
    expect(parseRoute("/highscores/")).toEqual({ page: "highscores" });
    expect(parseRoute("/news")).toEqual({ page: "news" });
    expect(parseRoute("/news/2026-11-01-hello")).toEqual({
      page: "post",
      slug: "2026-11-01-hello",
    });
    expect(parseRoute("/news/../etc")).toEqual({ page: "not_found" });
    expect(parseRoute("/elsewhere")).toEqual({ page: "not_found" });
  });
});

describe("highscore filters", () => {
  it("reads valid filters and falls back on the rest", () => {
    expect(parseFilters("?category=sword&vocation=arcanist&page=3", skills, vocations)).toEqual({
      category: "sword",
      vocation: "arcanist",
      page: 3,
    });
    expect(parseFilters("?category=dance&vocation=monk&page=99", skills, vocations)).toEqual({
      category: "level",
      vocation: "",
      page: 1,
    });
    expect(parseFilters("?page=1.5", skills, vocations).page).toBe(1);
    expect(parseFilters("", skills, vocations)).toEqual({
      category: "level",
      vocation: "",
      page: 1,
    });
  });

  it("writes the query string without defaults, keeping ?lang", () => {
    expect(filtersToSearch({ category: "level", vocation: "", page: 1 }, "?lang=en&page=4")).toBe(
      "?lang=en",
    );
    expect(filtersToSearch({ category: "sword", vocation: "guardian", page: 2 })).toBe(
      "?category=sword&vocation=guardian&page=2",
    );
  });

  it("builds the API path and the category names", () => {
    expect(highscoresPath({ category: "level", vocation: "", page: 1 })).toBe(
      "/api/highscores?category=level&page=1",
    );
    expect(highscoresPath({ category: "fishing", vocation: "arcanist", page: 2 })).toBe(
      "/api/highscores?category=fishing&page=2&vocation=arcanist",
    );
    expect(categoryKey("level")).toBe("site.highscores.level");
    expect(categoryKey("sword")).toBe("skill.sword.name");
  });
});

describe("account links (T2.1)", () => {
  it("routes the pages of the emailed links", () => {
    expect(parseRoute("/verify")).toEqual({ page: "verify" });
    expect(parseRoute("/forgot-password/")).toEqual({ page: "forgot_password" });
    expect(parseRoute("/reset-password")).toEqual({ page: "reset_password" });
  });
  it("reads the token from the fragment only when it is well formed", () => {
    const t = "A".repeat(40) + "-_9";
    expect(linkToken(`#token=${t}`)).toBe(t);
    expect(linkToken(`token=${t}`)).toBe(t);
    expect(linkToken("#token=short")).toBeUndefined();
    expect(linkToken(`#token=${t}<`)).toBeUndefined();
    expect(linkToken("")).toBeUndefined();
  });
});
