import { describe, expect, it } from "vitest";
import {
  categoryKey,
  filtersToSearch,
  guildRankKey,
  highscoresPath,
  linkToken,
  linkedProvider,
  oauthErrorKey,
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

describe("guild routes (T5.1)", () => {
  it("maps /guilds and /guilds/<id>", () => {
    expect(parseRoute("/guilds")).toEqual({ page: "guilds" });
    expect(parseRoute("/guilds/")).toEqual({ page: "guilds" });
    expect(parseRoute("/guilds/12")).toEqual({ page: "guild", id: 12 });
    expect(parseRoute("/guilds/0")).toEqual({ page: "not_found" });
    expect(parseRoute("/guilds/abc")).toEqual({ page: "not_found" });
    expect(guildRankKey("vice")).toBe("client.guild.rank.vice");
    expect(guildRankKey("<x>")).toBe("client.guild.rank.member");
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

describe("oauth pages (T2.1 2/2)", () => {
  it("routes them and maps error codes to fixed keys", () => {
    expect(parseRoute("/account")).toEqual({ page: "account" });
    expect(parseRoute("/oauth/confirm")).toEqual({ page: "oauth_confirm" });
    expect(oauthErrorKey("?code=denied")).toBe("site.oauth.error.denied");
    expect(oauthErrorKey("?code=<script>")).toBe("site.oauth.error.internal");
    expect(oauthErrorKey("")).toBe("site.oauth.error.internal");
    expect(linkedProvider("?linked=discord", ["discord"])).toBe("discord");
    expect(linkedProvider("?linked=discord", [])).toBeUndefined();
    expect(
      linkedProvider("?linked=%20--%20Your%20account%20will%20be%20deleted", ["google"]),
    ).toBeUndefined();
  });
});
