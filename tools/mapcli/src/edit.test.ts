import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
    expect(mapcli("npc", "remove", "testisle", "--npc", "harbor_master", "--root", root).code).toBe(
      0,
    );
    expect(read(root, "world/islands/testisle/npcs.yaml")).not.toContain("harbor_master");
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
    const before = read(other, "world/islands/testisle/zones.yaml");
    const conflict = mapcli("patch", "apply", patchFile, "--root", other);
    expect(conflict.code).toBe(1);
    expect(conflict.json().conflicts).toEqual([
      { path: Z7, reason: "the file changed since the patch was made" },
    ]);
    expect(read(other, "world/islands/testisle/zones.yaml")).toBe(before);
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
});
