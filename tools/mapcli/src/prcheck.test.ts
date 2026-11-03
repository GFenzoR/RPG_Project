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
import { MARKER, buildComment, checkReport, readReport } from "./prcomment.ts";

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

describe("mapcli pr-check", () => {
  it("passes a change inside a community plot and renders it before/after", () => {
    const { root, git, edit } = sandbox();
    git("checkout", "-qb", "pr");
    edit("place", "puerto", "--pos", "3204,6299,7", "--item", "boulder");
    git("commit", "-qam", "inside");
    const out = tmp("pr-out-");
    const r = prCheck({ root, base: "main", head: "pr", out, author: "someone", pr: 3 });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.plots).toEqual({ count: 1, violations: [] });
    expect(r.files).toMatchObject([{ path: PLOT_CHUNK, status: "modified", tiles_changed: 1 }]);
    expect(r.areas).toEqual([
      {
        x: 3200,
        y: 6295,
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
    expect(bad.failures).toEqual(["conflicts"]);
    expect(bad.conflicts).toMatchObject([{ path: PLOT_CHUNK, at: ["3204,6299,7"] }]);
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
    format: 1,
    pr: 5,
    author: "someone",
    maintainer: false,
    base: "a".repeat(40),
    head: "b".repeat(40),
    merge_base: "a".repeat(40),
    ok: false,
    failures: ["plots"],
    files: [{ path: PLOT_CHUNK, status: "modified", base_matches: true, tiles_changed: 2 }],
    conflicts: [],
    plots: {
      count: 1,
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
    validation: { errors: 0, new_errors: [] },
    other_files: [],
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
  const ctx = {
    repo: "o/r",
    runUrl: "https://github.com/o/r/actions/runs/1",
    conclusion: "failure",
  };

  it("builds one marked comment with plots, changes and images", () => {
    const body = buildComment(checkReport(good), ctx);
    expect(body.startsWith(MARKER)).toBe(true);
    expect(body).toContain("❌ **No pasa:**");
    expect(body).toContain(
      "| `world/islands/puerto/spawns.yaml` | entrada `w` agregada | fuera de toda parcela |",
    );
    expect(body).toContain("`before-1.png` `after-1.png`");
  });

  it("rejects anything unexpected in the untrusted report", () => {
    const bad = (patch: Record<string, unknown>) => () => checkReport({ ...good, ...patch });
    expect(bad({ author: "x](http://evil)" })).toThrow();
    expect(bad({ files: [{ ...good.files[0], path: "world/../.github/x" }] })).toThrow();
    expect(bad({ files: [{ ...good.files[0], path: "data/items.yaml" }] })).toThrow();
    expect(bad({ areas: [{ ...good.areas[0], after: "../../evil.png" }] })).toThrow();
    expect(bad({ failures: ["<img src=x>"] })).toThrow();
    expect(bad({ pr: "5" })).toThrow();
    expect(bad({ format: 2 })).toThrow();
    // Free text is neutralised, not rejected: no backticks or line breaks survive.
    const body = buildComment(
      checkReport({ ...good, validation: { errors: 1, new_errors: ["a```\n@everyone [x](y)"] } }),
      ctx,
    );
    expect(body).toContain("a    @everyone [x](y)");
    expect(body.split("```").length).toBe(3);
  });

  it("explains a missing or invalid report instead of failing silently", () => {
    const body = buildComment(null, ctx, "invalid report: author: unexpected value");
    expect(body).toContain("no dejó un reporte utilizable");
    expect(readReport(join(tmpdir(), "does-not-exist.json"))).toEqual({
      report: null,
      error: "no report",
    });
  });
});
