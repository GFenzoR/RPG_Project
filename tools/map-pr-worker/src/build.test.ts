import { describe, expect, it } from "vitest";
import {
  CONTRIBUTORS,
  buildChange,
  creditRow,
  fenced,
  prBody,
  prTitle,
  writablePath,
  withCredit,
} from "./build.ts";
import type { ReadBase } from "./build.ts";
import { PLOT_CHUNK, paint, patchOf, plotSubmission, readRepo } from "../test/fixtures.ts";

const fromRepo: ReadBase = async (path) => readRepo(path);

describe("buildChange", () => {
  it("merges a plot change onto the base and credits the author", async () => {
    const s = plotSubmission();
    const r = await buildChange(s, fromRepo);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.writes.keys()].sort()).toEqual([PLOT_CHUNK, CONTRIBUTORS].sort());
    expect(r.writes.get(PLOT_CHUNK)).toBe(paint(readRepo(PLOT_CHUNK) ?? "", 3202, 6298, "grass"));
    expect(r.islands).toEqual(["puerto"]);
    expect(r.writes.get(CONTRIBUTORS)).toContain(
      "| Cartographer Aria | puerto | envío n.º 7 | 2026-11-05 |",
    );
  });

  it("merges onto a base that changed elsewhere in the same chunk", async () => {
    const s = plotSubmission();
    const moved = paint(readRepo(PLOT_CHUNK) ?? "", 3210, 6300, "dirt");
    const r = await buildChange(s, async (p) => (p === PLOT_CHUNK ? moved : readRepo(p)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.writes.get(PLOT_CHUNK)).toBe(paint(moved, 3202, 6298, "grass"));
  });

  it("fails with conflict when the base changed the same tile", async () => {
    const changed = paint(readRepo(PLOT_CHUNK) ?? "", 3202, 6298, "dirt");
    const r = await buildChange(plotSubmission(), async (p) =>
      p === PLOT_CHUNK ? changed : readRepo(p),
    );
    expect(r).toEqual({ ok: false, code: "conflict" });
  });

  it("fails outside the community plots", async () => {
    const r = await buildChange(plotSubmission(7, 3220, 6300), fromRepo);
    expect(r).toEqual({ ok: false, code: "outside_plot" });
  });

  it("fails when the base already has it", async () => {
    const s = plotSubmission();
    const done = paint(readRepo(PLOT_CHUNK) ?? "", 3202, 6298, "grass");
    expect(await buildChange(s, async (p) => (p === PLOT_CHUNK ? done : readRepo(p)))).toEqual({
      ok: false,
      code: "no_changes",
    });
  });

  it("never writes outside the map files of world/", async () => {
    const base = plotSubmission();
    const bad = [
      patchOf(".github/workflows/ci.yml", null, "on: push\n"),
      patchOf("world/../.github/x.yaml", null, "x: 1\n"),
      patchOf(CONTRIBUTORS, null, "| me | all | #1 | today |\n"),
      patchOf("server/cmd/gameserver/main.go", null, "package main\n"),
      JSON.stringify({ format: 1, kind: "rpg-map-patch", base_ref: "HEAD", files: [] }),
      "not json",
    ];
    for (const patch of bad)
      expect(await buildChange({ ...base, patch }, fromRepo)).toEqual({
        ok: false,
        code: "invalid_patch",
      });
  });

  it("checks plots against the base, never against the change", async () => {
    // A patch that grows the plot over the tile it paints: the plot definition is a change.
    const zonesPath = "world/islands/puerto/zones.yaml";
    const zones = readRepo(zonesPath) ?? "";
    const grown = zones.replace(
      "{ x: 3200, y: 6296, w: 16, h: 12 }",
      "{ x: 3200, y: 6296, w: 32, h: 12 }",
    );
    expect(grown).not.toBe(zones);
    const s = { ...plotSubmission(), patch: patchOf(zonesPath, zones, grown) };
    expect(await buildChange(s, fromRepo)).toEqual({ ok: false, code: "outside_plot" });
  });
});

describe("paths", () => {
  it("accepts only map files and the credits", () => {
    expect(writablePath(PLOT_CHUNK)).toBe(true);
    expect(writablePath(CONTRIBUTORS)).toBe(true);
    for (const p of [
      "world/README.md",
      ".github/x",
      "world/islands/puerto/../../x.yaml",
      "/world/world.yaml",
      "data/items.yaml",
    ])
      expect(writablePath(p)).toBe(false);
  });
});

describe("texts", () => {
  const s = plotSubmission();

  it("credits once, with a safe name", () => {
    const once = withCredit("# Contribuidores\n", s, ["puerto"]);
    expect(withCredit(once, s, ["puerto"])).toBe(once);
    expect(creditRow({ ...s, author: "Bad | Name <b>" }, ["puerto"])).toBe(
      "| Bad  Name b | puerto | envío n.º 7 | 2026-11-05 |",
    );
  });

  it("titles cannot close issues or mention anyone", () => {
    const t = prTitle({ ...s, title: "fixes #12, closes acme/rpg#3, GH-4 @admin" });
    expect(t.slice(0, t.indexOf(" (envío"))).not.toMatch(/#\d|@[a-z]|gh-\d/i);
    expect(t.replace(/\u2060/g, "")).toBe(
      "map: fixes #12, closes acme/rpg#3, GH-4 @admin (envío n.º 7)",
    );
  });

  it("titles cannot close an issue by URL either", () => {
    const t = prTitle({ ...s, title: "fixes https://github.com/GFenzoR/RPG_Project/issues/12" });
    const player = t.slice(0, t.indexOf(" (envío"));
    expect(player).not.toContain("://");
    expect(player).not.toMatch(/\bfixes\b/i);
    expect(t.replace(/\u2060/g, "")).toContain(
      "fixes https://github.com/GFenzoR/RPG_Project/issues/12",
    );
    expect(prTitle({ ...s, title: "prefix fixture closet" })).toContain("fixture closet");
  });

  it("titles are cut by code points, never inside a surrogate pair", () => {
    const t = prTitle({ ...s, title: `${"a".repeat(58)}🌊🌊🌊` });
    expect(t).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(t).toContain("a🌊…");
  });

  it("titles are one line", () => {
    expect(prTitle({ ...s, title: "a\nb\u202ec" })).toBe("map: a b c (envío n.º 7)");
    expect(prTitle({ ...s, title: "x".repeat(200) }).length).toBeLessThan(90);
  });

  it("the description cannot escape its code block", () => {
    const f = fenced("a ``` b ```` c");
    expect(f.startsWith("`````text\n")).toBe(true);
    expect(f.endsWith("\n`````")).toBe(true);
    const body = prBody(s);
    expect(body).toContain("Cartographer Aria");
    expect(body).toContain(`\`${PLOT_CHUNK}\``);
    // The @mention and the link are inside the fence, not loose in the Markdown.
    const fence = body.indexOf("````text");
    expect(fence).toBeGreaterThan(0);
    expect(body.indexOf("@everyone")).toBeGreaterThan(fence);
    expect(body).not.toMatch(/@[a-z0-9-]+\.[a-z]+/i); // no email
  });
});
