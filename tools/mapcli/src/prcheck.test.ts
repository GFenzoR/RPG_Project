import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatYaml, parseYamlText } from "@rpg/map-format";
import { decodePng } from "@rpg/spritepack";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./index.ts";
import {
  insidePath,
  landContent,
  parseMaintainers,
  prCheck,
  reportPath,
  tileFor,
} from "./prcheck.ts";
import { parseMaintainers as parseMaintainersCopy } from "./prcomment.ts";
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
// Sandboxes leave out the vendor PNGs that assets/sprites.yaml does not use: a pack has
// thousands of files, and copying them all makes every sandbox seconds slower.
const spriteManifest = readFileSync(join(repo, "assets/sprites.yaml"), "utf8");
const usedFiles = (src: string): boolean => {
  const rel = src.slice(repo.length).replaceAll("\\", "/");
  return !/^assets\/vendor\/.+\.png$/.test(rel) || spriteManifest.includes(rel.slice(7));
};
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
    cpSync(join(repo, d), join(root, d), { recursive: true, filter: usedFiles });
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
const DECOR = "data/items/decoration.yaml";
/** An item the content tests add: it looks like a boulder. */
const NEW_ITEM = [
  "- id: test_crate",
  "  kind: decoration",
  "  sprite: decor/boulder",
  "  name: item.boulder.name",
  "  pickupable: false",
  "  blocks_movement: true",
  "",
].join("\n");

describe("parseMaintainers", () => {
  it("reads one login per line, ignoring comments, @ and case", () => {
    expect(parseMaintainers("# x\n@Alice\nbob # lead\n\nnot valid!\n")).toEqual(["alice", "bob"]);
    expect(parseMaintainers(null)).toEqual([]);
  });
  it("is the same in prcomment.ts (its own copy: it runs without dependencies)", () => {
    for (const text of [
      "# x\n@Alice\nbob # lead\n\nnot valid!\n",
      "  @RPG-Map-Bot   # the bot\r\n@@double\n-dash\nok-name\n",
      "a".repeat(40) + "\n" + "b".repeat(39) + "\n",
    ])
      expect(parseMaintainersCopy(text)).toEqual(parseMaintainers(text));
  });
});

describe("tileFor", () => {
  it("keeps the image side within 1024 px", () => {
    expect(tileFor({ x: 0, y: 0, w: 9, h: 9, z: 7 })).toBe(32);
    expect(tileFor({ x: 0, y: 0, w: 64, h: 10, z: 7 })).toBe(16);
  });
});

describe("insidePath", () => {
  const dir = resolve(tmpdir(), "land");
  it("keeps a plain content path inside the directory", () => {
    expect(insidePath(dir, "data/items/x.yaml")).toBe(join(dir, "data/items/x.yaml"));
    expect(insidePath(dir, "assets/sprites/decor/a_b-c.1.png")).not.toBeNull();
  });
  it("refuses what could leave it or name something else", () => {
    for (const p of [
      "data/../x.yaml",
      "../x.yaml",
      "data/./x.yaml",
      "data//x.yaml",
      "/etc/passwd",
      "data/",
      "",
      "data/.git/config",
      "data/.GIT/config",
      ".git",
      "data/a\\b.yaml",
      "data/..\\..\\x.yaml",
      "data/c:x.yaml",
      "data/x.yaml:stream",
      "data/a\0b.yaml",
      "data/a\nb.yaml",
      "data/a\rb.yaml",
    ])
      expect(insidePath(dir, p), JSON.stringify(p)).toBeNull();
  });
});

describe("landContent", () => {
  /** A repo with a base tree data/{ok.yaml,gone.yaml,fake.yaml,sub}, and a copy of it. */
  function setup(): {
    root: string;
    dir: string;
    base: string;
    blob: (text: string) => string;
    tree: (entries: [string, string, string][]) => string;
    literal: (entries: [string, string, string][]) => string;
  } {
    const root = tmp("land-repo-");
    const run = (args: string[], input?: string | Buffer): string =>
      execFileSync("git", args, { cwd: root, input, stdio: ["pipe", "pipe", "pipe"] })
        .toString()
        .trim();
    run(["init", "-q"]);
    const blob = (text: string): string => run(["hash-object", "-w", "--stdin"], text);
    /** A tree written as raw bytes (git mktree refuses some of these entries). */
    const literal = (entries: [string, string, string][]): string => {
      const sorted = [...entries].sort((a, b) =>
        Buffer.compare(Buffer.from(a[1]), Buffer.from(b[1])),
      );
      const bytes = Buffer.concat(
        sorted.flatMap(([mode, name, oid]) => [
          Buffer.from(`${mode} ${name}\0`),
          Buffer.from(oid, "hex"),
        ]),
      );
      return run(["hash-object", "-t", "tree", "--literally", "-w", "--stdin"], bytes);
    };
    const tree = (entries: [string, string, string][]): string =>
      literal([["40000", "data", literal(entries)]]);
    const base = tree([
      ["100644", "ok.yaml", blob("a\n")],
      ["100644", "gone.yaml", blob("gone\n")],
      ["100644", "fake.yaml", blob("base fake\n")],
      ["100644", "sub", blob("base sub\n")],
    ]);
    // `dir` sits in its own parent, so anything written outside it shows up there.
    const dir = join(tmp("land-"), "after");
    mkdirSync(join(dir, "data"), { recursive: true });
    for (const [name, text] of [
      ["ok.yaml", "a\n"],
      ["gone.yaml", "gone\n"],
      ["fake.yaml", "base fake\n"],
      ["sub", "base sub\n"],
    ] as const)
      writeFileSync(join(dir, "data", name), text);
    return { root, dir, base, blob, tree, literal };
  }

  it("writes the target's blobs, removes what it lacks and skips everything else", () => {
    const { root, dir, base, blob, tree } = setup();
    const emptyTree = execFileSync("git", ["hash-object", "-t", "tree", "-w", "--stdin"], {
      cwd: root,
      input: "",
    })
      .toString()
      .trim();
    const evil = blob("evil\n");
    const to = tree([
      ["100644", "ok.yaml", blob("b\n")],
      ["100644", "new.yaml", blob("new\n")],
      // A tree object under a file's mode: not a blob, so neither written nor removed.
      ["100644", "fake.yaml", emptyTree],
      // A gitlink: nothing to read, the base's file stays.
      ["160000", "sub", "1".repeat(40)],
      ["100644", "..", evil],
      ["100644", ".", evil],
      ["100644", ".git", evil],
      ["100644", ".GIT", evil],
      ["100644", "a\\b", evil],
      ["100644", "a:b", evil],
      ["100644", "a\nb", evil],
    ]);
    const res = landContent(root, dir, base, to);
    expect(res.tooLarge).toBe(false);
    expect(res.changed).toBe(3); // ok.yaml, new.yaml, gone.yaml
    expect(res.skipped).toEqual(
      [
        "data/.",
        "data/..",
        "data/.GIT",
        "data/.git",
        "data/a:b",
        "data/a\\b",
        "data/a\nb",
        "data/fake.yaml",
        "data/sub",
      ].sort(),
    );
    const read = (name: string): string => readFileSync(join(dir, "data", name), "utf8");
    expect(read("ok.yaml")).toBe("b\n");
    expect(read("new.yaml")).toBe("new\n");
    expect(existsSync(join(dir, "data/gone.yaml"))).toBe(false);
    expect(read("fake.yaml")).toBe("base fake\n");
    expect(read("sub")).toBe("base sub\n");
    expect(readdirSync(join(dir, "data")).sort()).toEqual([
      "fake.yaml",
      "new.yaml",
      "ok.yaml",
      "sub",
    ]);
    expect(readdirSync(dirname(dir))).toEqual(["after"]);
  });

  it("writes nothing over the limits", () => {
    const { root, dir, base, blob, tree } = setup();
    const to = tree([["100644", "ok.yaml", blob("a much longer text than before\n")]]);
    expect(landContent(root, dir, base, to, { files: 10, bytes: 8 })).toEqual({
      changed: 0,
      tooLarge: true,
      skipped: [],
    });
    expect(landContent(root, dir, base, to, { files: 0, bytes: 1e6 }).tooLarge).toBe(true);
    expect(readFileSync(join(dir, "data/ok.yaml"), "utf8")).toBe("a\n");
  });

  it("counts the bytes of every path, even when they share one blob", () => {
    const { root, dir, base, blob, tree } = setup();
    // 50 paths of one 1 KB blob: a push of 1 KB that would be 50 KB on disk.
    const kb = blob("x".repeat(1024));
    const copies = Array.from({ length: 50 }, (_, i): [string, string, string] => [
      "100644",
      `copy${i}.yaml`,
      kb,
    ]);
    const to = tree(copies);
    expect(landContent(root, dir, base, to, { files: 100, bytes: 10_000 }).tooLarge).toBe(true);
    expect(readdirSync(join(dir, "data")).sort()).toEqual([
      "fake.yaml",
      "gone.yaml",
      "ok.yaml",
      "sub",
    ]);
    expect(landContent(root, dir, base, to, { files: 100, bytes: 60_000 }).tooLarge).toBe(false);
  });

  it("does not count removals against the file limit", () => {
    const { root, dir, base, blob, tree } = setup();
    // Four files of base go, one comes: one path to write.
    const to = tree([["100644", "new.yaml", blob("new\n")]]);
    expect(landContent(root, dir, base, to, { files: 1, bytes: 1e6 })).toEqual({
      changed: 5,
      tooLarge: false,
      skipped: [],
    });
    expect(readdirSync(join(dir, "data"))).toEqual(["new.yaml"]);
  });

  it("removes the emptied folders where the target has a file", () => {
    const { root, dir, blob, tree, literal } = setup();
    // Base has data/x/y/z.yaml; the target has a file data/x.
    const from = tree([
      ["40000", "x", literal([["40000", "y", literal([["100644", "z.yaml", blob("z\n")]])]])],
    ]);
    rmSync(join(dir, "data"), { recursive: true });
    mkdirSync(join(dir, "data/x/y"), { recursive: true });
    writeFileSync(join(dir, "data/x/y/z.yaml"), "z\n");
    const to = tree([["100644", "x", blob("now a file\n")]]);
    expect(landContent(root, dir, from, to)).toEqual({ changed: 2, tooLarge: false, skipped: [] });
    expect(readFileSync(join(dir, "data/x"), "utf8")).toBe("now a file\n");
  });

  it("never writes through a directory that resolves outside", () => {
    const { root, dir, base, blob, tree, literal } = setup();
    // A link in the checkout (as if base had one) to a directory outside it. A junction
    // needs no privilege on Windows; elsewhere the type is ignored.
    const outside = tmp("outside-");
    symlinkSync(outside, join(dir, "data/linked"), "junction");
    const to = tree([
      ["100644", "ok.yaml", blob("a\n")],
      ["100644", "gone.yaml", blob("gone\n")],
      ["100644", "fake.yaml", blob("base fake\n")],
      ["100644", "sub", blob("base sub\n")],
      [
        "40000",
        "linked",
        literal([
          ["100644", "x.yaml", blob("escaped\n")],
          ["40000", "deep", literal([["100644", "y.yaml", blob("escaped\n")]])],
        ]),
      ],
    ]);
    expect(landContent(root, dir, base, to)).toEqual({
      changed: 0,
      tooLarge: false,
      skipped: ["data/linked/deep/y.yaml", "data/linked/x.yaml"],
    });
    expect(readdirSync(outside)).toEqual([]); // not even the folder "deep"
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
    expect(r.plots).toEqual({ count: 2, violations: [], violations_total: 0 });
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

  /** Branch "pr": a new item in data/items, placed inside the puerto community plot. */
  function addsAndPlacesItem(s: ReturnType<typeof sandbox>): void {
    s.git("checkout", "-qb", "pr");
    appendFileSync(join(s.root, DECOR), `\n${NEW_ITEM}`);
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "test_crate");
    s.git("add", "-A");
    s.git("commit", "-qm", "item and map");
  }

  it("validates a maintainer's map with the content the PR brings (PR #81)", () => {
    const s = sandbox();
    addsAndPlacesItem(s);
    const out = tmp("pr-out-");
    const r = prCheck({ root: s.root, base: "main", head: "pr", out, author: "boss" });
    expect(r.maintainer).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.validation.new_errors_total).toBe(0);
    expect(r.other_files).toEqual([DECOR]);
    // The after render draws it with its sprite: the same picture as a boulder there.
    s.git("checkout", "-qb", "boulder", "main");
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "boulder");
    s.git("commit", "-qam", "boulder");
    const out2 = tmp("pr-out-");
    prCheck({ root: s.root, base: "main", head: "boulder", out: out2, author: "boss" });
    const png = (dir: string): Buffer => readFileSync(join(dir, "after-1.png"));
    expect(png(out).equals(png(out2))).toBe(true);
  });

  it("validates and draws a community map with the base's content too", () => {
    const s = sandbox();
    addsAndPlacesItem(s);
    const out = tmp("pr-out-");
    const r = prCheck({ root: s.root, base: "main", head: "pr", out, author: "x", pr: 7 });
    expect(r.maintainer).toBe(false);
    expect(r.plots.violations).toEqual([]); // inside the plot: only the content is wrong
    expect(r.failures).toEqual(["validation"]);
    expect(r.validation.new_errors).toEqual([
      expect.stringContaining('unknown item "test_crate" (not in data/items/)'),
    ]);
    expect(r.other_files).toEqual([DECOR]);
    expect(r.notes).toEqual(["base_content"]);
    // Drawn as an unknown item, not with the sprite the PR's content gives it.
    const outBoss = tmp("pr-out-");
    prCheck({ root: s.root, base: "main", head: "pr", out: outBoss, author: "boss" });
    const png = (dir: string): Buffer => readFileSync(join(dir, "after-1.png"));
    expect(png(out).equals(png(outBoss))).toBe(false);
    expect(readReport(join(out, "report.json")).report?.notes).toEqual(["base_content"]);
  });

  it("keeps the errors a content change of the PR causes, for everyone", () => {
    const s = sandbox();
    s.git("checkout", "-qb", "pr");
    // The PR deletes an item the map uses elsewhere, and touches the map inside the plot.
    const text = readFileSync(join(s.root, DECOR), "utf8");
    const start = text.search(/^- id: oak_tree\r?$/m);
    const end = text.indexOf("- id: ", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    writeFileSync(join(s.root, DECOR), text.slice(0, start) + text.slice(end));
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "boulder");
    s.git("commit", "-qam", "drop oak_tree");
    for (const author of ["boss", "x"]) {
      const r = prCheck({ root: s.root, base: "main", head: "pr", out: tmp("pr-out-"), author });
      expect(r.failures).toEqual(["validation"]);
      expect(r.validation.new_errors.join("\n")).toContain('unknown item "oak_tree"');
    }
  });

  it("validates with git's merge of the content, not the head's copy of it", () => {
    const s = sandbox();
    addsAndPlacesItem(s);
    // After the PR branched, base adds another item to the same file and uses it (another
    // chunk). The head's decoration.yaml lacks it; git's merge has both.
    s.git("checkout", "-q", "main");
    const text = readFileSync(join(s.root, DECOR), "utf8");
    const BASE_ITEM = NEW_ITEM.replaceAll("test_crate", "base_crate");
    // At the top (the PR appended at the end): git merges both without a conflict.
    writeFileSync(join(s.root, DECOR), `${BASE_ITEM}\n${text}`);
    s.edit("place", "puerto", "--pos", "3210,6300,7", "--item", "base_crate");
    s.git("commit", "-qam", "main moves");
    const r = prCheck({
      root: s.root,
      base: "main",
      head: "pr",
      out: tmp("pr-out-"),
      author: "boss",
    });
    expect(r.failures).toEqual([]);
    expect(r.validation.new_errors_total).toBe(0);
  });

  /**
   * On main, a file of items with foo_crate on the map. The PR edits the file and main then
   * renames it: git still merges the edit into the renamed file (enough items for git to
   * see the rename after the edit).
   */
  function movedItems(s: ReturnType<typeof sandbox>): { from: string; to: string } {
    const from = "data/items/extra.yaml";
    const to = "data/items/moved.yaml";
    const ids = ["foo_crate", "bar_crate", "baz_crate", "qux_crate", "quux_crate"];
    writeFileSync(
      join(s.root, from),
      ids.map((id) => NEW_ITEM.replaceAll("test_crate", id)).join("\n"),
    );
    s.edit("place", "puerto", "--pos", "3210,6300,7", "--item", "foo_crate");
    s.git("add", "-A");
    s.git("commit", "-qm", "extra items, foo_crate on the map");
    return { from, to };
  }

  it("measures the merge when base renamed a content file: a deletion of the PR counts", () => {
    const s = sandbox();
    const { from, to } = movedItems(s);
    s.git("checkout", "-qb", "pr");
    // The PR drops foo_crate (which the map uses) and touches the map inside the plot.
    const text = readFileSync(join(s.root, from), "utf8");
    writeFileSync(join(s.root, from), text.slice(text.indexOf("- id: bar_crate")));
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "boulder");
    s.git("commit", "-qam", "drop foo_crate");
    s.git("checkout", "-q", "main");
    s.git("mv", from, to);
    s.git("commit", "-qm", "rename");
    const tree = s.git("merge-tree", "--write-tree", "--no-messages", "main", "pr").trim();
    expect(s.git("show", `${tree}:${to}`)).not.toContain("foo_crate"); // git saw the rename
    const r = prCheck({
      root: s.root,
      base: "main",
      head: "pr",
      out: tmp("pr-out-"),
      author: "boss",
    });
    expect(r.failures).toEqual(["validation"]);
    expect(r.validation.new_errors.join("\n")).toContain('unknown item "foo_crate"');
  });

  it("measures the merge when base renamed a content file: an addition of the PR counts", () => {
    const s = sandbox();
    const { from, to } = movedItems(s);
    s.git("checkout", "-qb", "pr");
    appendFileSync(join(s.root, from), `\n${NEW_ITEM}`);
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "test_crate");
    s.git("commit", "-qam", "add test_crate");
    s.git("checkout", "-q", "main");
    s.git("mv", from, to);
    s.git("commit", "-qm", "rename");
    const r = prCheck({
      root: s.root,
      base: "main",
      head: "pr",
      out: tmp("pr-out-"),
      author: "boss",
    });
    expect(r.failures).toEqual([]);
    expect(r.validation.new_errors_total).toBe(0);
  });

  it("keeps a directory base made of a file the PR deletes", () => {
    const s = sandbox();
    // A plain file where base will put a folder of sprites.
    writeFileSync(join(s.root, "assets/sprites/decor/stack"), "a file\n");
    s.git("add", "-A");
    s.git("commit", "-qm", "stack file");
    s.git("checkout", "-qb", "pr");
    s.git("rm", "-q", "assets/sprites/decor/stack");
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "oak_tree");
    s.git("commit", "-qam", "drop the file, a tree in the plot");
    s.git("checkout", "-qb", "same", "main");
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "oak_tree");
    s.git("commit", "-qam", "only the tree");
    // Base turns the file into a folder with a sprite and draws it next to the PR's change.
    s.git("checkout", "-q", "main");
    s.git("rm", "-q", "assets/sprites/decor/stack");
    mkdirSync(join(s.root, "assets/sprites/decor/stack"));
    cpSync(
      join(s.root, "assets/sprites/decor/boulder.png"),
      join(s.root, "assets/sprites/decor/stack/crate.png"),
    );
    const text = readFileSync(join(s.root, DECOR), "utf8");
    const crate = NEW_ITEM.replace("test_crate", "stack_crate").replace(
      "decor/boulder",
      "decor/stack/crate",
    );
    writeFileSync(join(s.root, DECOR), `${crate}\n${text}`);
    s.edit("place", "puerto", "--pos", "3199,6304,7", "--item", "stack_crate");
    s.git("add", "-A");
    s.git("commit", "-qm", "stack folder");
    // The PR's deletion is already in base: the after picture is the same as without it.
    const out = tmp("pr-out-");
    const outSame = tmp("pr-out-");
    const r = prCheck({ root: s.root, base: "main", head: "pr", out, author: "boss" });
    prCheck({ root: s.root, base: "main", head: "same", out: outSame, author: "boss" });
    expect(r.failures).toEqual([]);
    const png = (dir: string): Buffer => readFileSync(join(dir, "after-1.png"));
    expect(png(out).equals(png(outSame))).toBe(true);
  });

  it("fails a symlink in the content and never follows it", () => {
    const s = sandbox();
    s.git("checkout", "-qb", "pr");
    // The item lives outside data/ and a link in data/items points at it.
    const decor = readFileSync(join(s.root, DECOR), "utf8");
    appendFileSync(join(s.root, DECOR), `\n${NEW_ITEM}`);
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "test_crate");
    writeFileSync(join(s.root, DECOR), decor);
    writeFileSync(join(s.root, "outside.yaml"), NEW_ITEM);
    s.git("add", "-A");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: s.root,
      input: "../../outside.yaml",
      encoding: "utf8",
    }).trim();
    s.git("update-index", "--add", "--cacheinfo", `120000,${blob},data/items/linked.yaml`);
    s.git("commit", "-qm", "linked items");
    const out = tmp("pr-out-");
    const r = prCheck({ root: s.root, base: "main", head: "pr", out, author: "boss", pr: 7 });
    expect(r.other_files).toEqual(["data/items/linked.yaml", "outside.yaml"]);
    expect(r.failures).toEqual(["invalid", "validation"]);
    expect(r.bad_mode_files).toEqual(["data/items/linked.yaml"]);
    expect(r.validation.new_errors.join("\n")).toContain('unknown item "test_crate"');
    // The comment accepts a content path among the odd modes.
    expect(readReport(join(out, "report.json")).report?.bad_mode_files).toEqual([
      "data/items/linked.yaml",
    ]);
    // What lands is a plain file holding the link's text, never a link.
    const dir = tmp("land-");
    expect(landContent(s.root, dir, "main", "pr")).toEqual({
      changed: 1,
      tooLarge: false,
      skipped: [],
    });
    expect(lstatSync(join(dir, "data/items/linked.yaml")).isFile()).toBe(true);
    expect(readFileSync(join(dir, "data/items/linked.yaml"), "utf8")).toBe("../../outside.yaml");
  });

  it("fails a content path it cannot write as the merge has it", () => {
    const s = sandbox();
    s.git("checkout", "-qb", "pr");
    // A maintainer adds items in a file named x:y.yaml: valid on Linux, where the server
    // would load it, but not a path the check writes (insidePath).
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: s.root,
      input: NEW_ITEM,
      encoding: "utf8",
    }).trim();
    s.git(
      "-c",
      "core.protectNTFS=false",
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob},data/items/x:y.yaml`,
    );
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "boulder");
    s.git("add", "world");
    s.git("commit", "-qm", "items in an odd file");
    const out = tmp("pr-out-");
    const r = prCheck({ root: s.root, base: "main", head: "pr", out, author: "boss", pr: 7 });
    expect(r.failures).toEqual(["invalid"]);
    expect(r.ok).toBe(false);
    expect(r.notes).toEqual(["content_skipped"]);
    expect(r.skipped_content).toEqual(["data/items/x?y.yaml"]);
    expect(r.skipped_content_total).toBe(1);
    expect(r.other_files).toEqual(["data/items/x?y.yaml"]); // as the comment can show it
    const { report, error } = readReport(join(out, "report.json"));
    expect(error).toBeUndefined();
    expect(report?.skipped_content).toEqual(["data/items/x?y.yaml"]);
  });

  it("judges the modes the PR changes, not an odd file already on base", () => {
    const s = sandbox();
    // Base already has an executable in data/: not this PR's doing.
    writeFileSync(join(s.root, "data/items/tool.yaml"), "[]\n");
    s.git("add", "data/items/tool.yaml");
    s.git("update-index", "--chmod=+x", "data/items/tool.yaml");
    s.git("commit", "-qm", "an executable on main");
    s.git("checkout", "-qb", "pr");
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "boulder");
    s.git("commit", "-qam", "map only");
    const clean = prCheck({ root: s.root, base: "main", head: "pr", out: tmp("pr-out-") });
    expect(clean.failures).toEqual([]);
    expect(clean.bad_mode_files).toEqual([]);
    // The PR adds one, in a folder with a dot and a name with a space: listed as the
    // comment can show it.
    const odd = "assets/vendor/Pack.v2/a b.png";
    mkdirSync(join(s.root, dirname(odd)), { recursive: true });
    writeFileSync(join(s.root, odd), "not really a png\n");
    s.git("add", odd);
    s.git("update-index", "--chmod=+x", odd);
    s.git("commit", "-qm", "an executable in the PR");
    const out = tmp("pr-out-");
    const r = prCheck({ root: s.root, base: "main", head: "pr", out, author: "boss", pr: 7 });
    expect(r.failures).toEqual(["invalid"]);
    expect(r.bad_mode_files).toEqual(["assets/vendor/Pack.v2/a?b.png"]);
    expect(readReport(join(out, "report.json")).report?.bad_mode_files).toEqual([
      "assets/vendor/Pack.v2/a?b.png",
    ]);
  });

  it("lands the head's content when git cannot merge", () => {
    const s = sandbox();
    addsAndPlacesItem(s); // appends test_crate to decoration.yaml
    s.git("checkout", "-q", "main");
    // Base appends another item at the same place: a textual conflict, no merge tree.
    appendFileSync(join(s.root, DECOR), `\n${NEW_ITEM.replaceAll("test_crate", "base_crate")}`);
    s.git("commit", "-qam", "main appends too");
    expect(() => s.git("merge-tree", "--write-tree", "main", "pr")).toThrow();
    const r = prCheck({
      root: s.root,
      base: "main",
      head: "pr",
      out: tmp("pr-out-"),
      author: "boss",
    });
    // Rebase, but the map is still measured with the PR's content: test_crate is known.
    expect(r.failures).toEqual(["rebase"]);
    expect(r.validation.new_errors_total).toBe(0);
  });

  it("stops at the content limits and says so", () => {
    const s = sandbox();
    addsAndPlacesItem(s);
    const pr = { root: s.root, base: "main", head: "pr", author: "boss", pr: 7 };
    const files = prCheck({ ...pr, out: tmp("pr-out-"), contentLimits: { files: 0, bytes: 1e9 } });
    // The "after" keeps the base's content, so the item is unknown there.
    expect(files.failures).toEqual(["validation", "limits"]);
    expect(files.notes).toEqual(["content_too_large"]);
    const out = tmp("pr-out-");
    const bytes = prCheck({ ...pr, out, contentLimits: { files: 100, bytes: 10 } });
    expect(bytes.failures).toContain("limits");
    const { report, error } = readReport(join(out, "report.json"));
    expect(error).toBeUndefined();
    expect(report?.failures).toContain("limits");
    expect(report?.notes).toEqual(["content_too_large"]);
  });

  it("draws the after with the base's sprites when the merge's do not build", () => {
    const s = sandbox();
    s.git("checkout", "-qb", "same");
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "oak_tree");
    s.git("commit", "-qam", "a tree");
    // The same tree plus a sprite whose header declares more than the atlas takes.
    s.git("checkout", "-qb", "pr");
    const png = readFileSync(join(s.root, "assets/sprites/decor/boulder.png"));
    png.writeUInt32BE(1 << 16, 16);
    writeFileSync(join(s.root, "assets/sprites/decor/huge.png"), png);
    s.git("add", "-A");
    s.git("commit", "-qm", "a huge sprite");
    const out = tmp("pr-out-");
    const outSame = tmp("pr-out-");
    const r = prCheck({ root: s.root, base: "main", head: "pr", out, author: "boss" });
    prCheck({ root: s.root, base: "main", head: "same", out: outSame, author: "boss" });
    expect(r.notes).toEqual(["atlas_fallback"]);
    expect(r.failures).toEqual([]);
    const after = (dir: string): Buffer => readFileSync(join(dir, "after-1.png"));
    expect(after(out).equals(after(outSame))).toBe(true); // not every sprite missing
  });

  it("halves the render tile until both PNGs fit the size limit", () => {
    const s = sandbox();
    s.git("checkout", "-qb", "pr");
    s.edit("place", "puerto", "--pos", "3202,6304,7", "--item", "oak_tree");
    s.git("commit", "-qam", "inside");
    const pr = { root: s.root, base: "main", head: "pr" };
    const fullOut = tmp("pr-out-");
    const full = prCheck({ ...pr, out: fullOut });
    const images = { before: "before-1.png", after: "after-1.png" };
    expect(full.areas).toMatchObject([{ tile: 32, ...images }]);
    const biggest = Math.max(
      ...Object.values(images).map((f) => readFileSync(join(fullOut, f)).length),
    );
    const out = tmp("pr-out-");
    const small = prCheck({ ...pr, out, maxPngBytes: biggest - 1 });
    expect(small.areas).toMatchObject([{ tile: 16, ...images }]);
    expect(decodePng(readFileSync(join(out, "after-1.png"))).width).toBeLessThan(9 * 32);
    // Nothing fits even at the smallest tile: no images, and the area is still listed.
    const none = prCheck({ ...pr, out: tmp("pr-out-"), maxPngBytes: 1 });
    const { x, y, w, h, z, island } = full.areas[0] ?? {};
    expect(none.areas).toEqual([{ x, y, w, h, z, island, tile: 4 }]);
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

  it("judges map files on bytes: invalid UTF-8 fails, accents pass (F1)", () => {
    const { root, git } = sandbox();
    const SP = "world/islands/puerto/spawns.yaml";
    const spawns = parseYamlText(readFileSync(join(root, SP), "utf8"), SP, [])?.data as unknown[];
    const entry = {
      id: "plaza_crabs",
      center: { x: 3205, y: 6300, z: 7 },
      radius: 1,
      monsters: [{ monster: "wolf", count: 1 }],
      respawn_seconds: 60,
      notes: "Playa del ñandú, junto al árbol",
    };
    git("checkout", "-qb", "ok");
    writeFileSync(join(root, SP), formatYaml([...spawns, entry]));
    git("commit", "-qam", "accents");
    const good = prCheck({ root, base: "main", head: "ok", out: tmp("pr-out-"), author: "x" });
    expect(good.failures).toEqual([]);
    expect(good.noncanonical_files).toEqual([]);
    // Same text with one byte of "ñ" replaced by 0xFF: lossy decoding would turn it into
    // U+FFFD and still look canonical.
    git("checkout", "-qb", "bad", "main");
    const bytes = Buffer.from(formatYaml([...spawns, entry]), "utf8");
    bytes[bytes.indexOf(Buffer.from("ñ", "utf8"))] = 0xff;
    writeFileSync(join(root, SP), bytes);
    git("commit", "-qam", "0xff");
    const bad = prCheck({ root, base: "main", head: "bad", out: tmp("pr-out-"), author: "boss" });
    expect(bad.failures).toEqual(["invalid"]);
    expect(bad.invalid_files).toEqual([SP]);
    // A raw DEL in a canonical-looking file.
    git("checkout", "-qb", "del", "main");
    writeFileSync(join(root, SP), formatYaml([...spawns, { ...entry, notes: "a\u007fb" }]));
    git("commit", "-qam", "del");
    const del = prCheck({ root, base: "main", head: "del", out: tmp("pr-out-"), author: "boss" });
    expect(del.invalid_files).toEqual([SP]);
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

  it("names a community portal between islands (cross_island) in the plots table", () => {
    const cross = {
      kind: "entry",
      path: "world/islands/puerto/portals.yaml",
      entry: "puerto_shortcut",
      change: "added",
      reason: "cross_island",
    };
    const r = checkReport({ ...good, plots: { ...good.plots, violations: [cross] } });
    expect(r.plots.violations).toEqual([cross]);
    const body = buildComment(r, ctx, mapOnly);
    expect(body).toContain(
      "| `world/islands/puerto/portals.yaml` | entrada `puerto_shortcut` agregada | portal entre islas: se saltaría el barco y su bloqueo de combate (solo maintainers) |",
    );
    expect(body).toContain("o une dos islas con un portal");
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

  it("says how the content was measured, from fixed codes only", () => {
    const r = checkReport({
      ...good,
      ok: false,
      failures: ["invalid", "limits"],
      bad_mode_files: ["data/items/linked.yaml", "assets/vendor/Pack/x.png"],
      notes: ["base_content", "content_too_large"],
    });
    expect(r.notes).toEqual(["base_content", "content_too_large"]);
    const body = buildComment(r, ctx, trustedFacts([PLOT_CHUNK], true));
    expect(body).toContain("pasa el límite de archivos o de tamaño del check");
    expect(body).toContain("**Cómo se midió:**");
    expect(body).toContain("también se validó y se dibujó con el contenido de la base");
    expect(body).toContain("- `data/items/linked.yaml`");
    // A report from before the notes still reads; anything else in them does not.
    expect(checkReport(good).notes).toEqual([]);
    const bad = (patch: Record<string, unknown>) => () => checkReport({ ...good, ...patch });
    expect(bad({ notes: ["**evil**"] })).toThrow();
    expect(bad({ notes: "base_content" })).toThrow();
    expect(bad({ bad_mode_files: [".github/workflows/ci.yml"] })).toThrow();
    // Raw characters prcheck's reportPath would have turned into "?".
    expect(bad({ bad_mode_files: ["data/a b.yaml"] })).toThrow();
    expect(bad({ bad_mode_files: ["data/x`y.yaml"] })).toThrow();
  });

  it("lists the content paths that could not land, as reportPath shows them", () => {
    expect(reportPath("data/items/x:y.yaml")).toBe("data/items/x?y.yaml");
    expect(reportPath("data/../.../x")).toBe("data/?./??./x"); // the comment refuses ".."
    expect(reportPath("assets/vendor/Pack.v2/a b\n`.png")).toBe("assets/vendor/Pack.v2/a?b??.png");
    const r = checkReport({
      ...good,
      ok: false,
      failures: ["invalid"],
      skipped_content: ["data/items/x?y.yaml", reportPath("data/..")],
      skipped_content_total: 60,
      notes: ["content_skipped"],
    });
    const body = buildComment(r, ctx, trustedFacts([PLOT_CHUNK], true));
    expect(body).toContain("no pudo escribir como las deja el merge");
    expect(body).toContain("- `data/items/x?y.yaml`");
    expect(body).toContain("… y 58 más.");
    // Reports from before these fields still read.
    expect(checkReport(good)).toMatchObject({ skipped_content: [], skipped_content_total: 0 });
    const bad = (patch: Record<string, unknown>) => () => checkReport({ ...good, ...patch });
    expect(bad({ skipped_content: ["world/../x y"] })).toThrow();
    expect(bad({ skipped_content_total: "1" })).toThrow();
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

  /** Runs the step's script with a fake `gh` (F2): returns its exit code and the PATCH body. */
  function runPending(fake: { list: string; listFails?: boolean; patchFails?: boolean }) {
    const dir = tmp("pending-");
    // Forward slashes so the path survives inside the bash fake on Windows (Git Bash).
    const shDir = dir.replaceAll("\\", "/");
    const script = (yml.split("run: |\n")[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/^ {10}/, ""))
      .join("\n");
    writeFileSync(join(dir, "step.sh"), script);
    writeFileSync(join(dir, "list.json"), fake.list);
    writeFileSync(
      join(dir, "gh"),
      `#!/usr/bin/env bash
if [ "$1 $2" = "api -X" ]; then
  ${fake.patchFails ? "exit 1" : `printf '%s' "$@" > "${shDir}/patched"; exit 0`}
fi
${fake.listFails ? 'echo "HTTP 403: rate limit" >&2; exit 1' : `cat "${shDir}/list.json"`}
`,
      { mode: 0o755 },
    );
    let code = 0;
    try {
      execFileSync("bash", [join(dir, "step.sh")], {
        env: {
          PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
          RUNNER_TEMP: dir,
          GH_TOKEN: "x",
          REPO: "o/r",
          PR: "7",
          SHA: "a".repeat(40),
        },
        stdio: "pipe",
      });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
    }
    const patched = existsSync(join(dir, "patched"))
      ? readFileSync(join(dir, "patched"), "utf8")
      : null;
    return { code, patched };
  }

  const bot = (id: number, body: string) => ({ id, user: { login: "github-actions[bot]" }, body });

  // The step needs jq (preinstalled on GitHub runners). Native Windows rarely has it, so
  // skip there when missing; elsewhere a missing jq still fails loudly.
  // A native Windows jq.exe prints CRLF (the step's `[[ $id =~ ^[0-9]+$ ]]` would fail), so
  // on Windows only an LF-printing jq (e.g. MSYS2's) counts.
  const hasJq = (() => {
    try {
      return execFileSync("jq", ["-n", "1"], { encoding: "utf8" }) === "1\n";
    } catch {
      return false;
    }
  })();
  const itPending = it.skipIf(process.platform === "win32" && !hasJq);

  itPending("marks the bot's marked comment pending, across pages (F2)", () => {
    // `gh api --paginate` prints one JSON array per page.
    const list = `${JSON.stringify([bot(1, "hello"), { id: 2, user: { login: "u" }, body: MARKER }])}\n${JSON.stringify([bot(3, `${MARKER}\nold ✅`)])}`;
    const r = runPending({ list });
    expect(r.code).toBe(0);
    expect(r.patched).toContain("repos/o/r/issues/comments/3");
    expect(r.patched).toContain("Pendiente:** revisando el commit `aaaaaaaaaaaa`");
  });

  itPending("exits 0 without a comment, and fails when the API fails (F2)", () => {
    expect(runPending({ list: JSON.stringify([bot(1, "hi")]) })).toEqual({
      code: 0,
      patched: null,
    });
    expect(runPending({ list: "[]", listFails: true }).code).not.toBe(0);
    expect(runPending({ list: JSON.stringify([bot(3, MARKER)]), patchFails: true }).code).not.toBe(
      0,
    );
    expect(yml).not.toMatch(/\|\s*head\b/);
    expect(yml).toContain("set -euo pipefail");
  });
});
