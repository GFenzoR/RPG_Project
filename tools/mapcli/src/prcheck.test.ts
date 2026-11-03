import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "@rpg/spritepack";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./index.ts";
import { parseMaintainers, prCheck, tileFor } from "./prcheck.ts";
import {
  MARKER,
  MAX_API_FILES,
  buildComment,
  filePaths,
  checkReport,
  isMaintainer,
  matchReport,
  noMapComment,
  readReport,
  trustedFacts,
} from "./prcomment.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

/** Copy of the map, content and assets in a fresh repo; main has the puerto plot and "boss". */
function sandbox(): {
  root: string;
  git: (...a: string[]) => string;
  edit: (...a: string[]) => void;
} {
  const root = tmp("mapcli-pr-");
  for (const d of ["world", "data", "i18n", "assets"])
    cpSync(join(repo, d), join(root, d), { recursive: true });
  mkdirSync(join(root, ".github"));
  writeFileSync(join(root, ".github/MAINTAINERS"), "# maintainers\n@Boss\n");
  const git = (...a: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "base");
  const edit = (...a: string[]): void => {
    let err = "";
    const code = run([...a, "--root", root], { out: () => {}, err: (t) => (err += t) });
    if (code !== 0) throw new Error(`mapcli ${a.join(" ")}: ${err}`);
  };
  return { root, git, edit };
}

const PLOT_CHUNK = "world/islands/puerto/chunks/z07/c0100_0196.json";

describe("parseMaintainers", () => {
  it("reads one login per line, ignoring comments, @ and case", () => {
    expect(parseMaintainers("# x\n@Alice\nbob # lead\n\nnot valid!\n")).toEqual(["alice", "bob"]);
    expect(parseMaintainers(null)).toEqual([]);
  });
});

describe("tileFor", () => {
  it("keeps the image side within 1024 px", () => {
    expect(tileFor({ x: 0, y: 0, w: 9, h: 9, z: 7 })).toBe(32);
    expect(tileFor({ x: 0, y: 0, w: 64, h: 10, z: 7 })).toBe(16);
  });
});

describe("mapcli pr-check", { timeout: 60_000 }, () => {
  it("passes a change inside a community plot and renders it before/after", () => {
    const { root, git, edit } = sandbox();
    git("checkout", "-qb", "pr");
    edit("place", "puerto", "--pos", "3202,6304,7", "--item", "oak_tree");
    git("commit", "-qam", "inside");
    const out = tmp("pr-out-");
    const r = prCheck({ root, base: "main", head: "pr", out, author: "someone", pr: 3 });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.plots).toEqual({ count: 1, violations: [], violations_total: 0 });
    expect(r.files).toMatchObject([
      {
        path: "world/islands/puerto/chunks/z07/c0100_0197.json",
        status: "modified",
        tiles_changed: 1,
      },
    ]);
    expect(r.areas).toEqual([
      {
        x: 3198,
        y: 6300,
        w: 9,
        h: 9,
        z: 7,
        island: "puerto",
        tile: 32,
        before: "before-1.png",
        after: "after-1.png",
      },
    ]);
    const before = readFileSync(join(out, "before-1.png"));
    const after = readFileSync(join(out, "after-1.png"));
    expect(decodePng(after).width).toBeGreaterThan(9 * 32);
    expect(after.equals(before)).toBe(false);
    // The worktrees are gone.
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
    // The report is what the comment workflow accepts.
    const { report, error } = readReport(join(out, "report.json"));
    expect(error).toBeUndefined();
    expect(report?.ok).toBe(true);
  });

  it("fails outside the plots unless the base lists the author as maintainer", () => {
    const { root, git, edit } = sandbox();
    git("checkout", "-qb", "pr");
    edit("paint", "puerto", "--floor", "7", "--rect", "3170,6330,2,2", "--ground", "sand");
    // Adding yourself to the maintainers in the PR does not count: base decides.
    writeFileSync(join(root, ".github/MAINTAINERS"), "boss\nsomeone\n");
    git("commit", "-qam", "outside");
    const out = tmp("pr-out-");
    const r = prCheck({ root, base: "main", head: "pr", out, author: "someone", pr: 4 });
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(["plots"]);
    expect(r.maintainer).toBe(false);
    expect(r.plots.violations).toMatchObject([{ kind: "tiles", tiles: 4 }]);
    expect(r.other_files).toEqual([".github/MAINTAINERS"]);
    const boss = prCheck({ root, base: "main", head: "pr", out, author: "boss", pr: 4 });
    expect(boss).toMatchObject({ ok: true, maintainer: true });
    expect(boss.plots.violations).toHaveLength(1);
    // The repository owner is a maintainer even when not listed.
    const owner = prCheck({
      root,
      base: "main",
      head: "pr",
      out,
      author: "o",
      association: "OWNER",
    });
    expect(owner).toMatchObject({ ok: true, maintainer: true });
    const member = prCheck({
      root,
      base: "main",
      head: "pr",
      out,
      author: "m",
      association: "MEMBER",
    });
    expect(member.maintainer).toBe(false);
    // Through the CLI: exit code 1 and a summary.
    let text = "";
    const code = run(
      ["pr-check", "--root", root, "--base", "main", "--head", "pr", "--out", out, "--author", "x"],
      { out: (t) => (text += t), err: () => {} },
    );
    expect(code).toBe(1);
    expect(JSON.parse(text)).toMatchObject({ ok: false, failures: ["plots"] });
  });

  it("measures against the merge with the current base and reports conflicts", () => {
    const { root, git, edit } = sandbox();
    git("checkout", "-qb", "pr");
    edit("place", "puerto", "--pos", "3204,6299,7", "--item", "boulder");
    git("commit", "-qam", "pr");
    git("checkout", "-q", "main");
    // Base moves on: another tile of the same chunk (no conflict) and the same tile (conflict).
    edit("place", "puerto", "--pos", "3210,6300,7", "--item", "bush");
    git("commit", "-qam", "main moves");
    const out = tmp("pr-out-");
    const ok = prCheck({ root, base: "main", head: "pr", out, author: "boss" });
    // Only the PR's tile changes: the bush that landed on main is not shown as reverted.
    expect(ok.files).toMatchObject([{ path: PLOT_CHUNK, tiles_changed: 1, base_matches: false }]);
    expect(ok.failures).toEqual([]);
    edit("place", "puerto", "--pos", "3204,6299,7", "--item", "bush");
    git("commit", "-qam", "main conflicts");
    const bad = prCheck({ root, base: "main", head: "pr", out, author: "boss" });
    expect(bad.failures).toContain("conflicts");
    expect(bad.conflicts).toMatchObject([{ path: PLOT_CHUNK, code: "tiles", at: ["3204,6299,7"] }]);
  });

  it("flags plot definitions and new validator errors", () => {
    const { root, git, edit } = sandbox();
    git("checkout", "-qb", "pr");
    edit(
      "zone",
      "add",
      "puerto",
      "--id",
      "my_plot",
      "--type",
      "community_plot",
      "--floor",
      "7",
      "--rect",
      "3204,6298,2,2",
    );
    edit(
      "spawn",
      "add",
      "puerto",
      "--id",
      "wet_wolves",
      "--pos",
      "3220,6300,7",
      "--monster",
      "wolf",
    );
    git("commit", "-qam", "pr");
    const r = prCheck({ root, base: "main", head: "pr", out: tmp("pr-out-"), author: "x" });
    expect(r.plots.violations).toMatchObject([
      { kind: "entry", entry: "wet_wolves", change: "added", reason: "outside_plot" },
      { kind: "entry", entry: "my_plot", change: "added", reason: "plot_definition" },
    ]);
    expect(r.validation.new_errors.join("\n")).toContain("walkable");
    expect(r.failures).toEqual(["plots", "validation"]);
  });

  it("fails when git would merge the text differently from the tile merge (B3)", () => {
    const { root, git, edit } = sandbox();
    const CHUNK = "world/islands/puerto/chunks/z07/c0100_0197.json";
    type Raw = { palette: string[]; items: { x: number; y: number; stack: number[] }[] };
    git("checkout", "-qb", "pr");
    // The palette is in first-use order: a bush near the top moves `bush` up the palette and
    // renumbers the items after it.
    edit("place", "puerto", "--pos", "3202,6305,7", "--item", "bush");
    git("commit", "-qam", "pr");
    git("checkout", "-q", "main");
    // main adds an item on a line the PR did not touch, with main's numbering.
    edit("place", "puerto", "--pos", "3221,6333,7", "--item", "border_sand_water_w");
    git("commit", "-qam", "main");
    // git merges the text cleanly, but the new index now names another item.
    const tree = git("merge-tree", "--write-tree", "--no-messages", "main", "pr").trim();
    const merged = JSON.parse(git("show", `${tree}:${CHUNK}`)) as Raw;
    const tile = merged.items.find((i) => i.x === 21 && i.y === 29);
    expect(tile?.stack.map((i) => merged.palette[i])).not.toContain("border_sand_water_w");
    const r = prCheck({ root, base: "main", head: "pr", out: tmp("pr-out-"), author: "boss" });
    expect(r.conflicts).toEqual([]);
    expect(r.failures).toEqual(["merge_mismatch"]);
    expect(r.merge_mismatch).toEqual([CHUNK]);
    expect(r.ok).toBe(false);
  });

  it("does not report an invalid map file of the PR as a base conflict (S4)", () => {
    const { root, git } = sandbox();
    git("checkout", "-qb", "pr");
    const c = JSON.parse(readFileSync(join(root, PLOT_CHUNK), "utf8")) as {
      items: { x: number }[];
    };
    c.items.push({ ...(c.items[0] as { x: number }), x: 40 });
    writeFileSync(join(root, PLOT_CHUNK), JSON.stringify(c));
    git("commit", "-qam", "bad");
    const out = tmp("pr-out-");
    const r = prCheck({ root, base: "main", head: "pr", out, author: "boss", pr: 1 });
    expect(r.failures).toContain("invalid");
    expect(r.failures).not.toContain("conflicts");
    expect(r.invalid_files).toEqual([PLOT_CHUNK]);
    expect(r.maintainer).toBe(true); // fails for maintainers too
    expect(readReport(join(out, "report.json")).report?.invalid_files).toEqual([PLOT_CHUNK]);
  });

  it("only trusts a maintainer when nobody else can push the head (S3)", () => {
    const { root, git, edit } = sandbox();
    git("checkout", "-qb", "pr");
    edit("paint", "puerto", "--floor", "7", "--rect", "3170,6330,2,2", "--ground", "sand");
    git("commit", "-qam", "outside");
    const out = tmp("pr-out-");
    const fork = { root, base: "main", head: "pr", out, repo: "boss/game" };
    expect(prCheck({ ...fork, author: "boss", headRepo: "contributor/game" }).failures).toEqual([
      "plots",
    ]);
    expect(prCheck({ ...fork, author: "boss", headRepo: "boss/game" }).ok).toBe(true);
    expect(prCheck({ ...fork, author: "Boss", headRepo: "Boss/game-fork" }).ok).toBe(true);
  });

  it("exits early when the branch does not change world/ (S2)", () => {
    const { root, git } = sandbox();
    git("checkout", "-qb", "pr");
    writeFileSync(join(root, "README.md"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "docs");
    const r = prCheck({ root, base: "main", head: "pr", out: tmp("pr-out-"), author: "x" });
    expect(r).toMatchObject({
      ok: true,
      map_changes: false,
      files: [],
      other_files: ["README.md"],
    });
  });

  it("counts the spawn's whole radius against the plot (B4)", () => {
    const { root, git, edit } = sandbox();
    git("checkout", "-qb", "pr");
    edit(
      "spawn",
      "add",
      "puerto",
      "--id",
      "huge",
      "--pos",
      "3207,6302,7",
      "--monster",
      "wolf",
      "--radius",
      "32",
      "--count",
      "3",
    );
    git("commit", "-qam", "pr");
    const r = prCheck({ root, base: "main", head: "pr", out: tmp("pr-out-"), author: "x" });
    expect(r.plots.violations).toMatchObject([{ entry: "huge", reason: "outside_plot" }]);
  });

  it("fails a map file that is not byte for byte canonical, even for maintainers (R2)", () => {
    const { root, git } = sandbox();
    git("checkout", "-qb", "pr");
    const SP = "world/islands/puerto/spawns.yaml";
    // 03207 is 3207 for the TS parser but octal (1671) for the Go server's yaml.v3.
    writeFileSync(
      join(root, SP),
      `${readFileSync(join(root, SP), "utf8")}\n- id: octal\n  center: { x: 03207, y: 06305, z: 7 }\n  radius: 1\n  monsters:\n    - { monster: wolf, count: 1 }\n  respawn_seconds: 60\n`,
    );
    git("commit", "-qam", "octal");
    const r = prCheck({ root, base: "main", head: "pr", out: tmp("pr-out-"), author: "boss" });
    expect(r.maintainer).toBe(true);
    expect(r.failures).toEqual(["invalid"]);
    expect(r.noncanonical_files).toEqual([SP]);
    expect(r.plots.violations_total).toBe(0); // not merged, so not measured either
  });

  it("fails a world/ path that becomes a symlink without changing its blob (R3)", () => {
    const { root, git } = sandbox();
    git("checkout", "-qb", "pr");
    const SP = "world/islands/puerto/spawns.yaml";
    const blob = git("rev-parse", `HEAD:${SP}`).trim();
    git("update-index", "--cacheinfo", `120000,${blob},${SP}`);
    git("commit", "-qm", "mode only");
    const r = prCheck({ root, base: "main", head: "pr", out: tmp("pr-out-"), author: "boss" });
    expect(r.map_changes).toBe(true);
    expect(r.files).toEqual([]);
    expect(r.failures).toEqual(["invalid"]);
    expect(r.bad_mode_files).toEqual([SP]);
  });

  it("rejects refs that look like options", () => {
    const { root } = sandbox();
    expect(() => prCheck({ root, base: "--output=x", head: "main", out: tmp("o-") })).toThrow(
      RangeError,
    );
    expect(existsSync(join(root, "x"))).toBe(false);
  });
});

describe("pr comment", () => {
  const good = {
    format: 2,
    pr: 5,
    author: "someone",
    maintainer: true, // what the report claims; the comment does not believe it
    base: "a".repeat(40),
    head: "b".repeat(40),
    merge_base: "a".repeat(40),
    ok: true,
    failures: [],
    map_changes: true,
    files: [{ path: PLOT_CHUNK, status: "modified", base_matches: true, tiles_changed: 2 }],
    conflicts: [],
    invalid_files: [],
    noncanonical_files: [],
    bad_mode_files: [],
    merge_mismatch: [],
    plots: {
      count: 1,
      violations_total: 1,
      violations: [
        {
          kind: "entry",
          path: "world/islands/puerto/spawns.yaml",
          entry: "w",
          change: "added",
          reason: "outside_plot",
        },
      ],
    },
    validation: { errors: 0, new_errors: [], new_errors_total: 0 },
    other_files: [],
    other_files_total: 0,
    areas: [
      {
        x: 1,
        y: 2,
        w: 9,
        h: 9,
        z: 7,
        island: "puerto",
        tile: 32,
        before: "before-1.png",
        after: "after-1.png",
      },
    ],
    omitted_areas: 0,
  };
  const ctx = { runUrl: "https://github.com/o/r/actions/runs/1", conclusion: "success" };
  const mapOnly = trustedFacts([PLOT_CHUNK, "world/islands/puerto/spawns.yaml"], false);

  it("builds one marked comment; plots are judged with the trusted maintainer answer (B1)", () => {
    const body = buildComment(checkReport(good), ctx, mapOnly);
    expect(body.startsWith(MARKER)).toBe(true);
    // The report says ok and maintainer: the trusted side says the author is not one.
    expect(body).not.toContain("✅");
    expect(body).not.toContain("(maintainer)");
    expect(body).toContain("❌ **No pasa:**");
    expect(body).toContain(
      "| `world/islands/puerto/spawns.yaml` | entrada `w` agregada | fuera de toda parcela |",
    );
    expect(body).toContain("`before-1.png` `after-1.png`");
    expect(body).toContain("Vale para el commit `bbbbbbbbbbbb`");
    const asMaintainer = trustedFacts([PLOT_CHUNK], true);
    expect(buildComment(checkReport(good), ctx, asMaintainer)).toContain("✅ **Pasa.**");
  });

  it("never shows a pass when the PR changes the check's code or config (B1)", () => {
    const files = [PLOT_CHUNK, "packages/map-format/src/patch/plots.ts", "docs/03.md"];
    const t = trustedFacts(files, true);
    expect(t.checkChanged).toBe(true);
    const body = buildComment(checkReport({ ...good, other_files: [] }), ctx, t);
    expect(body).not.toContain("✅");
    expect(body).toContain("El veredicto no es confiable");
    // The list of files comes from the API, not from the report (which said none).
    expect(body).toContain("- `packages/map-format/src/patch/plots.ts` ⚠️");
    expect(trustedFacts([PLOT_CHUNK, "docs/03.md"], true).checkChanged).toBe(false);
    for (const f of ["package.json", ".npmrc", ".github/MAINTAINERS", "pnpm-lock.yaml", "x.ts"])
      expect(trustedFacts([PLOT_CHUNK, f], true).checkChanged).toBe(true);
  });

  it("lists sensitive files first and says how many more there are (S1)", () => {
    const docs = Array.from({ length: 45 }, (_, i) => `docs/n${String(i).padStart(2, "0")}.md`);
    const t = trustedFacts([...docs, "server/evil.go", PLOT_CHUNK], true);
    expect(t.otherFiles[0]).toBe("server/evil.go");
    const body = buildComment(checkReport(good), ctx, t);
    expect(body).toContain("- `server/evil.go` ⚠️");
    expect(body).toContain("… y 6 más (ver Files changed).");
    const many = checkReport({
      ...good,
      plots: { ...good.plots, violations_total: 75 },
      validation: { errors: 99, new_errors: ["e"], new_errors_total: 99 },
    });
    const b2 = buildComment(many, ctx, mapOnly);
    expect(b2).toContain("… y 74 más (ver Files changed).");
    expect(b2).toContain("99 errores nuevos:");
    expect(b2).toContain("… y 98 más.");
  });

  it("renders conflicts and errors from fixed codes only (B2)", () => {
    const evil = "**x** [l](https://e) ![i](https://e) @u #1 <img>";
    expect(() => checkReport({ ...good, conflicts: [{ path: PLOT_CHUNK, code: evil }] })).toThrow();
    expect(() =>
      checkReport({ ...good, conflicts: [{ path: PLOT_CHUNK, reason: evil, code: "tiles" }] }),
    ).not.toThrow(); // extra fields are dropped, never rendered
    const r = checkReport({
      ...good,
      failures: ["conflicts"],
      conflicts: [{ path: PLOT_CHUNK, reason: evil, code: "invalid_file" }],
      validation: { errors: 1, new_errors: [evil], new_errors_total: 1 },
    });
    const body = buildComment(r, ctx, mapOnly);
    expect(body).toContain("- `world/islands/puerto/chunks/z07/c0100_0196.json`: archivo inválido");
    // The free-text validator line only appears inside the fenced block.
    const outside = body.replace(/```text[\s\S]*?```/g, "");
    for (const bit of ["**x**", "](https://e)", "@u", "#1", "<img>"])
      expect(outside).not.toContain(bit);
    expect(body.split("```").length).toBe(3);
    const err = buildComment(null, ctx, mapOnly, "invalid_report");
    expect(err).toContain("el reporte no tiene el formato esperado");
  });

  it("rejects anything unexpected in the untrusted report", () => {
    const bad = (patch: Record<string, unknown>) => () => checkReport({ ...good, ...patch });
    expect(bad({ author: "x](http://evil)" })).toThrow();
    expect(bad({ files: [{ ...good.files[0], path: "world/../.github/x" }] })).toThrow();
    expect(bad({ files: [{ ...good.files[0], path: "data/items.yaml" }] })).toThrow();
    expect(bad({ areas: [{ ...good.areas[0], after: "../../evil.png" }] })).toThrow();
    expect(bad({ failures: ["<img src=x>"] })).toThrow();
    expect(bad({ invalid_files: ["world/x **y**"] })).toThrow();
    expect(bad({ pr: "5" })).toThrow();
    expect(bad({ format: 1 })).toThrow();
  });

  it("checks the report against the PR and the maintainer rule against the head repo", () => {
    const r = checkReport(good);
    expect(matchReport(r, 5, "b".repeat(40), "SomeOne")).toBeUndefined();
    expect(matchReport(r, 6, "b".repeat(40), "someone")).toBe("other_pr");
    expect(matchReport(r, 5, "c".repeat(40), "someone")).toBe("other_commit");
    expect(matchReport(r, 5, "b".repeat(40), "other")).toBe("other_author");
    const pull = { author: "boss", association: "NONE", repo: "o/game" };
    expect(isMaintainer({ ...pull, headRepo: "o/game" }, ["boss"])).toBe(true);
    expect(isMaintainer({ ...pull, headRepo: "contributor/game" }, ["boss"])).toBe(false);
    expect(isMaintainer({ ...pull, headRepo: "Boss/fork" }, ["boss"])).toBe(true);
    expect(isMaintainer({ ...pull, headRepo: null }, ["boss"])).toBe(false);
    expect(isMaintainer({ ...pull, association: "OWNER", headRepo: "o/game" }, [])).toBe(true);
    expect(isMaintainer({ ...pull, association: "MEMBER", headRepo: "o/game" }, [])).toBe(false);
  });

  it("explains a missing report and a PR that no longer touches world/", () => {
    expect(buildComment(null, ctx, mapOnly, "no_report")).toContain(
      "no dejó un reporte utilizable",
    );
    expect(readReport(join(tmpdir(), "does-not-exist.json"))).toEqual({
      report: null,
      error: "no_report",
    });
    expect(noMapComment("c".repeat(40), ctx.runUrl)).toContain("ya no cambia nada en `world/`");
  });
  it("counts a rename by its source too, so moving a workflow to docs/ is not harmless (R1)", () => {
    const paths = filePaths([
      { filename: PLOT_CHUNK },
      { filename: "docs/ci.yml", previous_filename: ".github/workflows/ci.yml" },
      { filename: "docs/x.go", previous_filename: "server/internal/auth/x.go" },
    ]);
    expect(paths).toEqual([
      PLOT_CHUNK,
      "docs/ci.yml",
      ".github/workflows/ci.yml",
      "docs/x.go",
      "server/internal/auth/x.go",
    ]);
    const t = trustedFacts(paths, true);
    expect(t.checkChanged).toBe(true);
    const body = buildComment(checkReport(good), ctx, t);
    expect(body).not.toContain("✅");
    expect(body).toContain("- `.github/workflows/ci.yml` ⚠️");
    expect(body).toContain("- `server/internal/auth/x.go` ⚠️");
  });

  it("does not trust a file list the API cut short (R4)", () => {
    const docs = Array.from({ length: MAX_API_FILES - 1 }, (_, i) => `docs/f${i}.md`);
    const t = trustedFacts([...docs, PLOT_CHUNK], true, MAX_API_FILES + 3);
    expect(t).toMatchObject({ truncated: true, checkChanged: true, unlisted: 3 });
    const body = buildComment(checkReport(good), ctx, t);
    expect(body).not.toContain("✅");
    expect(body).toContain("la API de GitHub lista solo una parte de los 3003 archivos");
    expect(body).toContain(`… y ${MAX_API_FILES - 1 + 3 - 40} más (ver Files changed).`);
    // Fewer listed than the PR's own count, even far below the cap.
    expect(trustedFacts([PLOT_CHUNK], true, 2).truncated).toBe(true);
    expect(trustedFacts([PLOT_CHUNK], true, 1).truncated).toBe(false);
  });

  it("reports non-canonical files and odd modes with fixed text", () => {
    const r = checkReport({
      ...good,
      failures: ["invalid"],
      noncanonical_files: ["world/islands/puerto/spawns.yaml"],
      bad_mode_files: [PLOT_CHUNK],
    });
    const body = buildComment(r, ctx, trustedFacts([PLOT_CHUNK], true));
    expect(body).toContain("no está en formato canónico");
    expect(body).toContain("no son archivos normales");
  });
});

describe("map-pr-pending workflow (R5)", () => {
  const yml = readFileSync(join(repo, ".github/workflows/map-pr-pending.yml"), "utf8");
  it("runs from the base with a comment-only token and never touches the PR's code", () => {
    expect(yml).toMatch(/pull_request_target:/);
    expect(yml).not.toMatch(/actions\/checkout|pnpm|npm |node /);
    expect(yml).toMatch(/permissions:\s*\n\s*pull-requests: write\s*\n/);
    expect(yml).not.toMatch(/github\.event\.pull_request\.(title|body|head\.ref|head\.label)/);
    // Only validated event data reaches the text.
    expect(yml).toMatch(/\^\[0-9\]\+\$/);
    expect(yml).toMatch(/\^\[0-9a-f\]\{40\}\$/);
    expect(yml).toContain("<!-- rpg-map-pr-check -->");
  });
});
