import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyChunk, formatChunk, parseChunk } from "@rpg/map-format";
import { decodePng } from "@rpg/spritepack";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./index.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mapcli(...argv: string[]): {
  code: number;
  out: string;
  err: string;
  json: () => Record<string, unknown>;
} {
  let out = "";
  let err = "";
  const code = run(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err, json: () => JSON.parse(out) as Record<string, unknown> };
}

/** Copy of world/, data/, i18n/ and assets/, committed in a fresh git repo. */
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "mapcli-edit-"));
  dirs.push(root);
  for (const d of ["world", "data", "i18n", "assets"])
    cpSync(join(repo, d), join(root, d), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return root;
}

const read = (root: string, f: string) => readFileSync(join(root, f), "utf8");
const Z7 = "world/islands/testisle/chunks/z07/c0032_0032.json";

describe("mapcli edit commands", () => {
  it("paint writes only the touched chunk and validates", () => {
    const root = sandbox();
    const r = mapcli(
      "paint",
      "testisle",
      "--floor",
      "7",
      "--rect",
      "1040,1040,3,3",
      "--ground",
      "sand",
      "--root",
      root,
    );
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ ok: true, written: [Z7], validation: { errors: 0 } });
    expect(mapcli("fmt", "--check", "--root", root).code).toBe(0);
  });

  it("--dry-run writes nothing; a bad op writes nothing and exits 1", () => {
    const root = sandbox();
    const before = read(root, Z7);
    expect(
      mapcli(
        "paint",
        "testisle",
        "--floor",
        "7",
        "--rect",
        "1040,1040,3,3",
        "--ground",
        "sand",
        "--dry-run",
        "--root",
        root,
      ).json(),
    ).toMatchObject({ ok: true, dry_run: true, written: [] });
    const bad = mapcli(
      "place",
      "testisle",
      "--pos",
      "1040,1040,7",
      "--item",
      "grass",
      "--root",
      root,
    );
    expect(bad.code).toBe(1);
    expect(bad.json().error).toMatch(/use paint_ground/);
    expect(read(root, Z7)).toBe(before);
  });

  it("refuses ops that touch another island than the one named", () => {
    const root = sandbox();
    const r = mapcli(
      "paint",
      "otherisle",
      "--floor",
      "7",
      "--rect",
      "1040,1040,1,1",
      "--ground",
      "sand",
      "--root",
      root,
    );
    expect(r.code).toBe(1);
    expect(r.json().error).toMatch(/touch island\(s\) testisle/);
  });

  it("spawn, zone and npc add/remove edit the YAML files", () => {
    const root = sandbox();
    expect(
      mapcli(
        "spawn",
        "add",
        "testisle",
        "--pos",
        "1045,1066,7",
        "--monster",
        "bristleback_boar",
        "--count",
        "2",
        "--radius",
        "3",
        "--respawn",
        "90",
        "--root",
        root,
      ).code,
    ).toBe(0);
    expect(read(root, "world/islands/testisle/spawns.yaml")).toContain(
      "- id: testisle_bristleback_boar_1045_1066\n  center: { x: 1045, y: 1066, z: 7 }",
    );
    expect(
      mapcli(
        "zone",
        "add",
        "testisle",
        "--rect",
        "1030,1030,4,4",
        "--floor",
        "7,8",
        "--type",
        "community_plot",
        "--id",
        "testisle_plot",
        "--root",
        root,
      ).code,
    ).toBe(0);
    expect(read(root, "world/islands/testisle/zones.yaml")).toContain("floors: [7, 8]");
    expect(mapcli("npc", "remove", "puerto", "--npc", "harbor_master", "--root", root).code).toBe(
      0,
    );
    expect(read(root, "world/islands/puerto/npcs.yaml")).not.toContain("harbor_master");
    expect(
      mapcli(
        "npc",
        "place",
        "testisle",
        "--pos",
        "1056,1082,7",
        "--npc",
        "harbor_master",
        "--root",
        root,
      ).code,
    ).toBe(0);
    expect(read(root, "world/islands/testisle/npcs.yaml")).toMatch(
      /- npc: harbor_master\n {2}pos: \{ x: 1056, y: 1082, z: 7 \}\n$/,
    );
    expect(
      mapcli(
        "spawn",
        "remove",
        "testisle",
        "--id",
        "testisle_bristleback_boar_1045_1066",
        "--root",
        root,
      ).code,
    ).toBe(0);
    expect(mapcli("zone", "remove", "testisle", "--id", "testisle_plot", "--root", root).code).toBe(
      0,
    );
    for (const f of ["spawns", "zones"])
      expect(read(root, `world/islands/testisle/${f}.yaml`)).toBe(
        read(repo, `world/islands/testisle/${f}.yaml`),
      );
    expect(mapcli("spawn", "frob", "testisle", "--root", root).code).toBe(2);
  });

  it("ops apply is all or nothing", () => {
    const root = sandbox();
    const ops = join(root, "ops.json");
    writeFileSync(
      ops,
      JSON.stringify([
        { op: "paint_ground", floor: 7, rect: { x: 1040, y: 1040, w: 2, h: 2 }, item: "sand" },
        { op: "remove_spawn", id: "nope" },
      ]),
    );
    const before = read(root, Z7);
    const bad = mapcli("ops", "apply", ops, "--root", root);
    expect(bad.code).toBe(1);
    expect(bad.json()).toMatchObject({ ok: false, op_index: 1 });
    expect(read(root, Z7)).toBe(before);
    writeFileSync(
      ops,
      JSON.stringify({
        ops: [
          { op: "paint_ground", floor: 7, rect: { x: 1040, y: 1040, w: 2, h: 2 }, item: "sand" },
          { op: "autoborder", floor: 7, rect: { x: 1038, y: 1038, w: 6, h: 6 } },
          { op: "stamp", pos: { x: 1030, y: 1070, z: 7 }, prefab: "small_dock" },
        ],
      }),
    );
    expect(mapcli("ops", "apply", ops, "--root", root).json()).toMatchObject({
      ok: true,
      validation: { errors: 0 },
    });
    expect(read(root, Z7)).toContain("border_grass_sand_");
    writeFileSync(ops, "{");
    expect(mapcli("ops", "apply", ops, "--root", root).code).toBe(2);
  });

  it("generate needs --force on a floor with tiles and builds a valid floor", () => {
    const root = sandbox();
    expect(
      mapcli(
        "generate",
        "testisle",
        "--recipe",
        "island",
        "--seed",
        "3",
        "--size",
        "60",
        "--root",
        root,
      ).code,
    ).toBe(1);
    const r = mapcli(
      "generate",
      "testisle",
      "--recipe",
      "island",
      "--seed",
      "3",
      "--size",
      "60",
      "--force",
      "--root",
      root,
    );
    expect(r.code).toBe(0);
    expect(r.json().ok).toBe(true);
    expect(read(root, Z7)).toContain("border_sand_water_");
    expect(
      mapcli(
        "generate",
        "testisle",
        "--recipe",
        "volcano",
        "--seed",
        "3",
        "--size",
        "60",
        "--root",
        root,
      ).code,
    ).toBe(2);
  });

  it("render writes a PNG of the requested size", () => {
    const out = join(sandbox(), "shot.png");
    const r = mapcli(
      "render",
      "testisle",
      "--floor",
      "7",
      "--area",
      "1050,1050,10,8",
      "--out",
      out,
      "--root",
      repo,
    );
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ tile: 32, missing_sprites: [] });
    const png = decodePng(readFileSync(out));
    expect(png.width).toBe(r.json().width);
    expect(png.height).toBe(r.json().height);
    expect(png.width).toBeGreaterThan(10 * 32);
    expect(
      mapcli("render", "testisle", "--floor", "7", "--out", out, "--tile", "12", "--root", repo)
        .code,
    ).toBe(2);
    expect(mapcli("render", "testisle", "--floor", "7", "--root", repo).code).toBe(2);
  });

  it("render is deterministic", () => {
    const root = sandbox();
    const a = join(root, "a.png");
    const b = join(root, "b.png");
    mapcli("render", "testisle", "--floor", "8", "--out", a, "--root", repo);
    mapcli("render", "testisle", "--floor", "8", "--out", b, "--root", repo);
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
  });
});

describe("mapcli patch", () => {
  it("create, diff and apply round-trip a change; conflicts apply nothing", () => {
    const src = sandbox();
    mapcli(
      "paint",
      "testisle",
      "--floor",
      "7",
      "--rect",
      "1045,1045,3,3",
      "--ground",
      "sand",
      "--root",
      src,
    );
    mapcli("zone", "remove", "testisle", "--id", "testisle_dock", "--root", src);
    const patchFile = join(src, "change.rpgpatch.json");
    const created = mapcli("patch", "create", "--out", patchFile, "--root", src);
    expect(created.json().files).toEqual([Z7, "world/islands/testisle/zones.yaml"]);
    // base_ref is the commit HEAD named, not "HEAD": it means something outside this clone.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: src, encoding: "utf8" }).trim();
    expect(JSON.parse(read(src, "change.rpgpatch.json")).base_ref).toBe(head);

    const dst = sandbox();
    const diff = mapcli("patch", "diff", patchFile, "--root", dst).json();
    expect(diff.files).toMatchObject([
      {
        path: Z7,
        status: "modified",
        base_matches: true,
        tiles_changed: 9,
        bbox: { x: 1045, y: 1045, w: 3, h: 3, z: 7 },
      },
      { path: "world/islands/testisle/zones.yaml", removed: ["testisle_dock"], added: [] },
    ]);
    expect(mapcli("patch", "apply", patchFile, "--root", dst).json()).toMatchObject({ ok: true });
    expect(read(dst, Z7)).toBe(read(src, Z7));
    // Applying again is a no-op (files already match the patch).
    expect(mapcli("patch", "apply", patchFile, "--root", dst).code).toBe(0);

    const other = sandbox();
    mapcli(
      "paint",
      "testisle",
      "--floor",
      "7",
      "--rect",
      "1050,1050,1,1",
      "--ground",
      "dirt",
      "--root",
      other,
    );
    // The base changed elsewhere in the chunk: the patch merges tile by tile.
    const merged = mapcli("patch", "apply", patchFile, "--root", other);
    expect(merged.json()).toMatchObject({ ok: true, merged: [Z7] });
    const view = (root: string, area: string) =>
      mapcli("view", "testisle", "--floor", "7", "--area", area, "--root", root).json();
    expect(view(other, "1045,1045,3,3")).toEqual(view(src, "1045,1045,3,3"));
    expect(view(other, "1050,1050,1,1")).not.toEqual(view(src, "1050,1050,1,1"));

    // The same tile changed differently on both sides: conflict, nothing written.
    const clash = sandbox();
    mapcli(
      "paint",
      "testisle",
      "--floor",
      "7",
      "--rect",
      "1046,1046,1,1",
      "--ground",
      "dirt",
      "--root",
      clash,
    );
    const before = read(clash, "world/islands/testisle/zones.yaml");
    const conflict = mapcli("patch", "apply", patchFile, "--root", clash);
    expect(conflict.code).toBe(1);
    expect(conflict.json().conflicts).toEqual([
      { path: Z7, reason: "tiles changed on both sides", at: ["1046,1046,7"] },
    ]);
    expect(read(clash, "world/islands/testisle/zones.yaml")).toBe(before);
    expect(mapcli("patch", "diff", patchFile, "--root", clash).json().files).toMatchObject([
      { base_matches: false, conflicts: 1 },
      { base_matches: true },
    ]);
    // --partial writes everything else and keeps the current tile where they clash.
    expect(mapcli("patch", "apply", patchFile, "--partial", "--root", clash).code).toBe(0);
    expect(read(clash, "world/islands/testisle/zones.yaml")).toBe(
      read(src, "world/islands/testisle/zones.yaml"),
    );
    expect(view(clash, "1046,1046,1,1")).not.toEqual(view(src, "1046,1046,1,1"));
  }, 30_000); // ~10 mapcli processes and git calls: over 5 s on a slow machine

  it("merges format 1 patches using the base at base_ref", () => {
    const src = sandbox();
    mapcli(
      "paint",
      "testisle",
      "--floor",
      "7",
      "--rect",
      "1045,1045,1,1",
      "--ground",
      "sand",
      "--root",
      src,
    );
    const p2 = JSON.parse(mapcli("patch", "create", "--root", src).out) as {
      format: number;
      files: { base_text: string }[];
    };
    expect(p2.format).toBe(2);
    expect(typeof p2.files[0]?.base_text).toBe("string");
    // Each sandbox is its own git repository: the commit create wrote as base_ref does not
    // exist in dst, so the format 1 patch names dst's HEAD (the same tree).
    const p1 = {
      ...p2,
      format: 1,
      base_ref: "HEAD",
      files: p2.files.map((f) => ({ ...f, base_text: undefined })),
    };
    const dst = sandbox();
    mapcli(
      "paint",
      "testisle",
      "--floor",
      "7",
      "--rect",
      "1050,1050,1,1",
      "--ground",
      "dirt",
      "--root",
      dst,
    );
    const file = join(dst, "p1.rpgpatch.json");
    writeFileSync(file, JSON.stringify(p1));
    expect(mapcli("patch", "apply", file, "--root", dst).json()).toMatchObject({
      ok: true,
      merged: [Z7],
    });
  });

  it("rejects patches that reach outside the map files", () => {
    const root = sandbox();
    const evil = join(root, "evil.json");
    for (const path of [
      "data/items/ground.yaml",
      "world/../data/x.yaml",
      "world/islands/testisle/../../x.json",
    ]) {
      writeFileSync(
        evil,
        JSON.stringify({
          format: 1,
          kind: "rpg-map-patch",
          base_ref: "HEAD",
          files: [{ path, base: null, content: "x" }],
        }),
      );
      expect([path, mapcli("patch", "apply", evil, "--root", root).code]).toEqual([path, 2]);
    }
  });

  it("diff shows what the merge would write, not local edits as reverted", () => {
    const src = sandbox();
    const paint = (root: string, rect: string, ground: string) =>
      mapcli(
        "paint",
        "testisle",
        "--floor",
        "7",
        "--rect",
        rect,
        "--ground",
        ground,
        "--root",
        root,
      );
    const spawn = (root: string, id: string) =>
      mapcli(
        "spawn",
        "add",
        "testisle",
        "--pos",
        "1050,1045,7",
        "--monster",
        "wolf",
        "--id",
        id,
        "--root",
        root,
      );
    paint(src, "1045,1045,2,1", "sand");
    spawn(src, "patch_spawn");
    const pf = join(src, "p1.rpgpatch.json");
    mapcli("patch", "create", "--out", pf, "--root", src);

    const dst = sandbox();
    paint(dst, "1052,1052,3,1", "dirt"); // same chunk, other tiles
    spawn(dst, "local_spawn");
    const diff = mapcli("patch", "diff", pf, "--root", dst);
    expect(diff.code).toBe(0);
    expect(diff.json().files).toEqual([
      expect.objectContaining({
        path: Z7,
        status: "modified",
        base_matches: false,
        conflicts: 0,
        tiles_changed: 2,
      }),
      expect.objectContaining({
        path: "world/islands/testisle/spawns.yaml",
        base_matches: false,
        conflicts: 0,
        added: ["patch_spawn"],
        removed: [],
        changed: [],
      }),
    ]);
  });

  it("writes patch contents in canonical form, never as they come", () => {
    const root = sandbox();
    const SP = "world/islands/testisle/spawns.yaml";
    const Z8 = "world/islands/testisle/chunks/z07/c0032_0033.json";
    const chunkText = read(root, Z7);
    const spawns = read(root, SP);
    const hash = (t: string) => `sha256:${createHash("sha256").update(t).digest("hex")}`;
    // Minified, with an unused palette entry and one changed tile.
    const raw = JSON.parse(chunkText) as { palette: string[]; ground: number[][] };
    raw.palette.push("dirt", "wet_sand"); // wet_sand is never used
    (raw.ground[0] as number[])[0] = raw.palette.length - 2;
    const minified = JSON.stringify(raw);
    // Octal-looking and hex numbers that YAML parsers read differently.
    const odd = spawns
      .replace("center: { x: 1056, y: 1041, z: 7 }", "center: { x: 01056, y: 01041, z: 7 }  # x")
      .replace("radius: 4", "radius: 0x4");
    expect(odd).not.toBe(spawns);
    const z8 = read(root, Z8);
    const evil = join(root, "odd.json");
    writeFileSync(
      evil,
      JSON.stringify({
        format: 2,
        kind: "rpg-map-patch",
        base_ref: "HEAD",
        files: [
          { path: Z7, base: hash(chunkText), base_text: chunkText, content: minified },
          { path: Z8, base: hash(z8), base_text: z8, content: formatChunk(emptyChunk(32, 33, 7)) },
          { path: SP, base: hash(spawns), base_text: spawns, content: odd },
        ],
      }),
    );
    expect(mapcli("patch", "apply", evil, "--root", root).code).toBe(0);
    expect(read(root, Z7)).toBe(formatChunk(parseChunk(minified, Z7) ?? emptyChunk(0, 0, 0)));
    expect(read(root, Z7)).not.toContain("wet_sand");
    expect(existsSync(join(root, Z8))).toBe(false); // an empty chunk is removed
    expect(read(root, SP)).toContain("center: { x: 1056, y: 1041, z: 7 }");
    expect(read(root, SP)).toMatch(/radius: 4\n/);
    expect(mapcli("fmt", "--check", "--root", root).code).toBe(0);
  });

  it("applying a non-canonical whole-file patch twice is a clean no-op the second time", () => {
    const root = sandbox();
    const hash = (t: string) => `sha256:${createHash("sha256").update(t).digest("hex")}`;
    const ISL = "world/islands/testisle/island.yaml";
    const WLD = "world/world.yaml";
    const PRF = "world/prefabs/small_dock.yaml";
    const edits: [string, string, string][] = [
      [ISL, "level_hint: [1, 8]", "level_hint: [01, 011] # c"],
      [WLD, "level_hint: [1, 8]", "level_hint: [01, 0x10]"],
      [PRF, `  - "P===P"`, `  - 'P=C=P'`],
    ];
    const files = edits.map(([path, from, to]) => {
      const text = read(root, path);
      expect(text).toContain(from);
      return { path, base: hash(text), base_text: text, content: text.replace(from, to) };
    });
    const pf = join(root, "odd.json");
    writeFileSync(
      pf,
      JSON.stringify({ format: 2, kind: "rpg-map-patch", base_ref: "HEAD", files }),
    );
    expect(mapcli("patch", "apply", pf, "--root", root).code).toBe(0);
    expect(read(root, ISL)).toContain("level_hint: [1, 11]");
    const again = mapcli("patch", "apply", pf, "--root", root);
    expect(again.code).toBe(0);
    expect(again.json()).toMatchObject({ ok: true, written: [], conflicts: [] });
    expect(mapcli("patch", "diff", pf, "--root", root).code).toBe(0);
  });

  it("diff shows what the patch would change when the whole file conflicts", () => {
    const root = sandbox();
    const Z = "world/islands/testisle/chunks/z07/c0033_0032.json";
    const text = read(root, Z);
    const raw = JSON.parse(text) as { palette: string[]; ground: number[][] };
    if (!raw.palette.includes("sand")) raw.palette.push("sand");
    (raw.ground[8] as number[])[2] = raw.palette.indexOf("sand"); // 1058,1040,7
    const p1 = {
      format: 1,
      kind: "rpg-map-patch",
      base_ref: "deadbeef",
      files: [{ path: Z, base: `sha256:${"0".repeat(64)}`, content: JSON.stringify(raw) }],
    };
    const pf = join(root, "p1.json");
    writeFileSync(pf, JSON.stringify(p1));
    const diff = mapcli("patch", "diff", pf, "--root", root);
    expect([diff.code, diff.err]).toEqual([1, ""]);
    expect(diff.json().files).toEqual([
      expect.objectContaining({ path: Z, status: "conflict", conflicts: 1, tiles_changed: 1 }),
    ]);
  });

  it("never writes through a symlink that leaves world/", () => {
    const root = sandbox();
    const outside = mkdtempSync(join(tmpdir(), "mapcli-outside-"));
    dirs.push(outside);
    const chunk = read(root, Z7);
    const z = "world/islands/testisle/chunks/z09";
    symlinkSync(outside, join(root, z));
    const path = `${z}/c0032_0032.json`;
    const evil = join(root, "evil.json");
    writeFileSync(
      evil,
      JSON.stringify({
        format: 2,
        kind: "rpg-map-patch",
        base_ref: "HEAD",
        files: [{ path, base: null, content: chunk.replace('"z": 7', '"z": 9') }],
      }),
    );
    const r = mapcli("patch", "apply", evil, "--root", root);
    expect(r.code).toBe(2);
    expect(readdirSync(outside)).toEqual([]);
  });
});
