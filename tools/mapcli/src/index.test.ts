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
      islands: [{ id: "testisle", chunks: 6 }],
      load_errors: 0,
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
      npcs: [{ npc: "harbor_master" }],
    });
  });

  it("validate passes on the repository and fails with positions on a broken copy", () => {
    expect(mapcli("validate", "--root", repo, "--format", "text")).toMatchObject({
      code: 0,
      out: "maps: 0 error(s), 0 warning(s)\n",
    });
    const root = sandbox();
    const npcs = join(root, "world/islands/testisle/npcs.yaml");
    writeFileSync(npcs, readFileSync(npcs, "utf8").replace("y: 1082", "y: 1086"));
    const r = mapcli("validate", "testisle", "--root", root);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as {
      errors: number;
      diagnostics: { message: string; pos?: unknown; line?: number }[];
    };
    expect(report.errors).toBe(1);
    expect(report.diagnostics[0]).toMatchObject({
      message: "NPC is not on a walkable tile",
      pos: { x: 1056, y: 1086, z: 7 },
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
      "testisle",
      "--floor",
      "7",
      "--area",
      "1053,1053,9,7",
      "--root",
      repo,
      "--format",
      "text",
    );
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        "legend: . grass  : dirt  @ temple  _ stone_floor",
        "y\\x  1053",
        "1053 _______..",
        "1054 _______..",
        "1055 _______..",
        "1056 ___@___::",
        "1057 _______..",
        "1058 _______..",
        "1059 _______..",
        "@ 1056,1056: temple",
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
});
