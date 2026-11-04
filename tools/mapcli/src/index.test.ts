import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./index.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const chunk = "world/islands/testisle/chunks/z07/c0032_0032.json";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mapcli(...argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = run(argv, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

/** Copy of the repository's world/, data/ and i18n/ that a test may modify. */
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "mapcli-"));
  dirs.push(root);
  for (const d of ["world", "data", "i18n"])
    cpSync(join(repo, d), join(root, d), { recursive: true });
  return root;
}

describe("mapcli", () => {
  it("info summarizes the world and an island", () => {
    const world = mapcli("info", "--root", repo);
    expect(world.code).toBe(0);
    expect(JSON.parse(world.out)).toMatchObject({
      islands: [
        { id: "puerto", chunks: 43 },
        { id: "testisle", chunks: 6 },
        { id: "bosque", chunks: 40 },
      ],
      load_errors: [],
    });
    const isle = JSON.parse(mapcli("info", "testisle", "--root", repo).out) as Record<
      string,
      unknown
    >;
    expect(isle).toMatchObject({
      id: "testisle",
      rect: { x: 1024, y: 1024, w: 64, h: 64 },
      floors: [7, 8],
      floor_stats: [
        { z: 7, chunks: 4, tiles: 4096 },
        { z: 8, chunks: 2 },
      ],
      npcs: [],
    });
    expect(JSON.parse(mapcli("info", "puerto", "--root", repo).out)).toMatchObject({
      id: "puerto",
      rect: { x: 3072, y: 6272, w: 192, h: 192 },
      level_hint: [1, 15],
      npcs: [
        { npc: "harbor_master" },
        { npc: "puerto_priest" },
        { npc: "puerto_provisioner" },
        { npc: "puerto_armorer" },
        { npc: "puerto_foreman" },
        { npc: "puerto_diver" },
      ],
    });
  });

  it("validate passes on the repository and fails with positions on a broken copy", () => {
    expect(mapcli("validate", "--root", repo, "--format", "text")).toMatchObject({
      code: 0,
      out: "maps: 0 error(s), 0 warning(s)\n",
    });
    const root = sandbox();
    const npcs = join(root, "world/islands/puerto/npcs.yaml");
    writeFileSync(npcs, readFileSync(npcs, "utf8").replace("y: 6433", "y: 6440"));
    const r = mapcli("validate", "puerto", "--root", root);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as {
      errors: number;
      diagnostics: { message: string; pos?: unknown; line?: number }[];
    };
    expect(report.errors).toBe(1);
    expect(report.diagnostics[0]).toMatchObject({
      message: "NPC is not on a walkable tile",
      pos: { x: 3201, y: 6440, z: 7 },
      line: 2,
    });
  });

  it("fmt --check reports non-canonical files and fmt rewrites them", () => {
    const root = sandbox();
    const file = join(root, chunk);
    const canonical = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify(JSON.parse(canonical)));
    expect(mapcli("fmt", "--check", "--root", root)).toMatchObject({ code: 1 });
    expect(JSON.parse(mapcli("fmt", "--check", "--root", root).out)).toMatchObject({
      changed: [chunk],
    });
    expect(readFileSync(file, "utf8")).not.toBe(canonical); // --check writes nothing
    expect(mapcli("fmt", "testisle", "--root", root).code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(canonical);
    expect(JSON.parse(mapcli("fmt", "--check", "--root", root).out)).toMatchObject({ changed: [] });
  });

  it("view draws the temple area with a legend", () => {
    const r = mapcli(
      "view",
      "puerto",
      "--floor",
      "7",
      "--area",
      "3153,6382,13,6",
      "--root",
      repo,
      "--format",
      "text",
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "legend: ? text  @ temple  N npc  _ stone_floor  s stone_wall",
        "y\\x  3153      3163",
        "6382 _________s___",
        "6383 _________s___",
        "6384 ___N_____s?__",
        "6385 _____________",
        "6386 _____@_____N_",
        "6387 _____________",
        "N 3156,6384: npc puerto_priest",
        "? 3163,6384: sign puerto_temple_sign: text.puerto.temple_sign",
        "@ 3158,6386: temple",
        "N 3164,6386: npc puerto_provisioner",
        "",
      ].join("\n"),
    );
    const json = JSON.parse(
      mapcli("view", "testisle", "--floor", "8", "--area", "1066,1055,4,3", "--root", repo).out,
    ) as Record<string, unknown>;
    expect(json).toMatchObject({
      legend: { "<": "portal up" },
      markers: [{ x: 1068, y: 1056, char: "<" }],
    });
  });

  it("rejects bad usage with exit code 2", () => {
    expect(mapcli().code).toBe(2);
    expect(mapcli("frobnicate").code).toBe(2);
    expect(mapcli("view", "testisle", "--floor", "7", "--area", "1,2,3").code).toBe(2);
    expect(
      mapcli("view", "testisle", "--floor", "7", "--area", "0,0,65,10", "--root", repo),
    ).toMatchObject({ code: 2, err: expect.stringContaining("64x64") as unknown });
    expect(mapcli("info", "nowhere", "--root", repo).code).toBe(1);
  });

  it("parses --floor and --area strictly", () => {
    const view = (floor: string, area: string) =>
      mapcli("view", "testisle", "--floor", floor, "--area", area, "--root", repo).code;
    for (const area of [
      "1e3,0,1,1",
      "0x10,0,1,1",
      "-1,0,1,1",
      " 1,0,1,1",
      "1.0,0,1,1",
      "65536,0,1,1",
      "65535,0,2,1",
      "0,65000,1,537",
      "0,65535,1,2",
      "0,0,0,1",
    ])
      expect([area, view("7", area)]).toEqual([area, 2]);
    for (const floor of ["7.0", " 7", "0x7", "16", "-1", ""])
      expect([floor, view(floor, "1024,1024,4,4")]).toEqual([floor, 2]);
    expect(view("7", "65532,65532,4,4")).toBe(0); // inside the world, just no tiles there
  });

  it("info and view report load errors and exit non-zero", () => {
    const missing = mapcli("info", "--root", join(tmpdir(), "mapcli-does-not-exist"));
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out)).toMatchObject({
      load_errors: [
        expect.stringContaining("world/world.yaml required file is missing") as unknown,
      ],
    });
    const root = sandbox();
    writeFileSync(join(root, "world/islands/testisle/chunks/z08/c0033_0033.json"), "{");
    const info = mapcli("info", "testisle", "--root", root);
    expect(info.code).toBe(1);
    expect(JSON.parse(info.out)).toMatchObject({
      id: "testisle",
      load_errors: [expect.stringContaining("invalid JSON") as unknown],
    });
    const view = mapcli(
      "view",
      "testisle",
      "--floor",
      "7",
      "--area",
      "1056,1056,2,2",
      "--root",
      root,
    );
    expect(view.code).toBe(1);
    expect(JSON.parse(view.out)).toMatchObject({
      rows: ["@_", "__"],
      load_errors: [expect.stringContaining("c0033_0033.json") as unknown],
    });
  });
});
