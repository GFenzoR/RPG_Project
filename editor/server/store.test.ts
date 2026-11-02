import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent, loadWorld, writeIsland, writeWorldMeta } from "@rpg/map-format";
import { applyOps } from "@rpg/map-format/ops";
import { chunkKey } from "@rpg/map-format/ops";
import type { MapOp, World } from "@rpg/map-format/ops";
import { run } from "@rpg/mapcli";
import { afterEach, describe, expect, it } from "vitest";
import { History } from "../src/history/history.ts";
import { chunkFile, fromWire } from "../src/io/wire.ts";
import type { FileChange } from "../src/io/wire.ts";
import {
  BadRequest,
  PartialSave,
  SaveConflict,
  bootstrap,
  hashText,
  nodeIo,
  saveChanges,
  validateInMemory,
} from "./store.ts";
import type { SaveIo } from "./store.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const content = loadContent(repo);
const itemKind = (id: string): string | undefined => content.items.get(id)?.kind;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(withRepo = true): string {
  const d = mkdtempSync(join(tmpdir(), "rpg-editor-test-"));
  dirs.push(d);
  if (withRepo) for (const sub of ["world", "data", "i18n"]) cpSync(join(repo, sub), join(d, sub), { recursive: true });
  return d;
}

function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/** mapcli fmt --check on root: exit code and the files it would change. */
function fmtCheck(root: string): { code: number; changed: string[] } {
  let out = "";
  const code = run(["fmt", "--check", "--root", root], { out: (t) => (out += t), err: () => {} });
  return { code, changed: (JSON.parse(out) as { changed: string[] }).changed };
}

const EDITS: MapOp[] = [
  { op: "paint_ground", floor: 7, rect: { x: 1040, y: 1040, w: 6, h: 4 }, item: "sand" },
  { op: "place_item", pos: { x: 1041, y: 1041, z: 7 }, item: "cargo_crate" },
  { op: "place_item", pos: { x: 1041, y: 1041, z: 7 }, item: "mooring_post" },
  // A new chunk on z8 and a whole chunk erased (its file must disappear).
  { op: "paint_ground", floor: 8, cells: [{ x: 1030, y: 1030 }], item: "dirt" },
  { op: "erase", floor: 8, rect: { x: 1056, y: 1024, w: 32, h: 32 }, layer: "all" },
];

const Z7 = "world/islands/testisle/chunks/z07/c0032_0032.json";
const NEW_Z8 = "world/islands/testisle/chunks/z08/c0032_0032.json";
const GONE_Z8 = "world/islands/testisle/chunks/z08/c0033_0032.json";

/** Loads root as the browser gets it, applies ops and lists the changes to save. */
function edit(root: string, ops: MapOp[] = EDITS): { world: World; changes: FileChange[] } {
  const boot = JSON.parse(JSON.stringify(bootstrap(root))) as ReturnType<typeof bootstrap>;
  const r = applyOps(fromWire(boot.world), ops, { itemKind });
  const changes = r.touched.map((t) => {
    const file = chunkFile(t.island, t.z, t.cx, t.cy);
    return { file, base: boot.base[file] ?? null };
  });
  return { world: r.world, changes };
}

describe("saveChanges", () => {
  it("writes exactly what mapcli fmt writes (fmt --check finds nothing to change)", () => {
    const root = scratch();
    const { world, changes } = edit(root);
    const result = saveChanges(root, world, changes);
    expect(result.written).toEqual([Z7, NEW_Z8]);
    expect(result.removed).toEqual([GONE_Z8]);
    expect(result.base[GONE_Z8]).toBeNull();
    expect(result.base[Z7]).toBe(hashText(readFileSync(join(root, Z7), "utf8")));
    expect(fmtCheck(root)).toEqual({ code: 0, changed: [] });
  });

  it("produces the same bytes as map-format's writer", () => {
    const root = scratch();
    const { world, changes } = edit(root);
    saveChanges(root, world, changes);
    const other = scratch(false);
    writeWorldMeta(other, world.meta);
    for (const island of world.islands.values()) writeIsland(other, island);
    expect(tree(join(root, "world/islands"))).toEqual(tree(join(other, "world/islands")));
  });

  it("writes nothing without changes, and undo restores the original files", () => {
    const root = scratch();
    const original = tree(join(root, "world"));
    const { world } = edit(root, []);
    expect(saveChanges(root, world, [])).toEqual({ written: [], removed: [], base: {} });

    const boot = bootstrap(root);
    const history = new History({ itemKind });
    const step = history.apply(fromWire(boot.world), "edit", EDITS);
    const files = step.touched.map((t) => chunkFile(t.island, t.z, t.cx, t.cy));
    const saved = saveChanges(
      root,
      step.world,
      files.map((file) => ({ file, base: boot.base[file] ?? null })),
    );
    expect(tree(join(root, "world"))).not.toEqual(original);
    const undone = history.undo(step.world)?.world ?? step.world;
    saveChanges(
      root,
      undone,
      files.map((file) => ({ file, base: saved.base[file] ?? null })),
    );
    expect(tree(join(root, "world"))).toEqual(original);
  });

  it("keeps changes made on disk to files the editor did not touch", () => {
    const root = scratch();
    const { world, changes } = edit(root, [EDITS[0] as MapOp]);
    const other = join(root, "world/islands/testisle/chunks/z07/c0033_0033.json");
    const external = readFileSync(other, "utf8").replace('"grass"', '"dirt"');
    writeFileSync(other, external); // e.g. a git pull after the editor loaded
    saveChanges(root, world, changes);
    expect(readFileSync(other, "utf8")).toBe(external);
  });

  it("refuses with a conflict, and writes nothing, if a changed file moved on disk", () => {
    const root = scratch();
    const { world, changes } = edit(root);
    const before = tree(join(root, "world"));
    writeFileSync(join(root, Z7), readFileSync(join(root, Z7), "utf8").replace('"grass"', '"dirt"'));
    const after = tree(join(root, "world"));
    expect(() => saveChanges(root, world, changes)).toThrow(SaveConflict);
    try {
      saveChanges(root, world, changes);
    } catch (e) {
      expect((e as SaveConflict).conflicts).toEqual([Z7]);
    }
    expect(tree(join(root, "world"))).toEqual(after);
    expect(after).not.toEqual(before);
  });

  it("treats a file created on disk meanwhile as a conflict", () => {
    const root = scratch();
    const { world, changes } = edit(root);
    writeFileSync(join(root, NEW_Z8), "{}\n");
    expect(() => saveChanges(root, world, changes)).toThrow(SaveConflict);
  });

  it("never overwrites a file that did not load", () => {
    const root = scratch();
    const broken = join(root, "world/islands/testisle/chunks/z08/c0033_0033.json");
    writeFileSync(broken, "{ not json");
    const { world, changes } = edit(root, [
      { op: "paint_ground", floor: 8, cells: [{ x: 1060, y: 1060 }], item: "dirt" },
    ]);
    expect(changes).toEqual([{ file: "world/islands/testisle/chunks/z08/c0033_0033.json", base: null }]);
    expect(() => saveChanges(root, world, changes)).toThrow(SaveConflict);
    expect(readFileSync(broken, "utf8")).toBe("{ not json");
  });

  it.each<[string, FileChange[], RegExp]>([
    ["path traversal", [{ file: "world/islands/testisle/chunks/z07/../../../../../evil.json", base: null }], /not a chunk file path/],
    ["an absolute path", [{ file: "/tmp/evil.json", base: null }], /not a chunk file path/],
    ["a dotted island id", [{ file: "world/islands/../chunks/z07/c0032_0032.json", base: null }], /not a chunk file path/],
    ["an island not in world.yaml", [{ file: "world/islands/other/chunks/z07/c0032_0032.json", base: null }], /not in world\/world.yaml/],
    ["a floor out of range", [{ file: "world/islands/testisle/chunks/z99/c0032_0032.json", base: null }], /out of range/],
    ["a bad base hash", [{ file: Z7, base: "../x" }], /invalid base hash/],
    ["a file listed twice", [{ file: Z7, base: null }, { file: Z7, base: null }], /listed twice/],
    ["a null change", [null as unknown as FileChange], /each change needs a file path/],
    ["a change without a file", [{ base: null } as unknown as FileChange], /each change needs a file path/],
    ["a numeric file", [{ file: 5, base: null } as unknown as FileChange], /each change needs a file path/],
  ])("rejects %s and touches nothing", (_name, changes, msg) => {
    const root = scratch();
    const before = tree(root);
    const { world } = edit(root);
    expect(() => saveChanges(root, world, changes)).toThrow(BadRequest);
    expect(() => saveChanges(root, world, changes)).toThrow(msg);
    expect(tree(root)).toEqual(before);
  });

  it("rejects chunks with invalid content (IDs that are not IDs, wrong coordinates)", () => {
    const root = scratch();
    const { world, changes } = edit(root, [EDITS[0] as MapOp]);
    const chunk = world.islands.get("testisle")?.chunks.get(chunkKey(7, 32, 32));
    if (!chunk) throw new Error("fixture");
    chunk.ground[0] = "../../etc";
    expect(() => saveChanges(root, world, changes)).toThrow(BadRequest);
    chunk.ground[0] = "sand";
    chunk.cx = 99;
    expect(() => saveChanges(root, world, changes)).toThrow(/chunk says cx=99/);
  });
});

describe("saveChanges when the disk fails", () => {
  /** Node io that throws on the nth call of one operation. */
  function failing(op: keyof SaveIo, nth: number): SaveIo {
    let calls = 0;
    const wrap =
      <A extends string[]>(name: keyof SaveIo, fn: (...a: A) => void) =>
      (...a: A): void => {
        if (name === op && ++calls === nth) throw new Error(`EIO: ${op} failed`);
        fn(...a);
      };
    return {
      writeFile: wrap("writeFile", nodeIo.writeFile),
      rename: wrap("rename", nodeIo.rename),
      remove: wrap("remove", nodeIo.remove),
    };
  }

  it("writes nothing if staging the second file fails, and leaves no temp files", () => {
    const root = scratch();
    const before = tree(join(root, "world"));
    const { world, changes } = edit(root);
    expect(() => saveChanges(root, world, changes, failing("writeFile", 2))).toThrow(/EIO/);
    expect(tree(join(root, "world"))).toEqual(before);
  });

  it("reports what reached the disk if a rename fails half-way", () => {
    const root = scratch();
    const { world, changes } = edit(root);
    let err: unknown;
    try {
      saveChanges(root, world, changes, failing("rename", 2));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PartialSave);
    const r = (err as PartialSave).result;
    expect(r.written).toEqual([Z7]);
    expect(r.removed).toEqual([]);
    expect(r.base[Z7]).toBe(hashText(readFileSync(join(root, Z7), "utf8")));
    // No temp file is left behind, so world/ still loads cleanly.
    expect([...tree(join(root, "world")).keys()].filter((f) => f.endsWith(".saving"))).toEqual([]);
    expect(loadWorld(root).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    // Saving again with the reported bases finishes the job without a conflict.
    const retry = changes.map((c) => ({
      file: c.file,
      base: r.written.includes(c.file) ? (r.base[c.file] ?? null) : c.base,
    }));
    expect(saveChanges(root, world, retry).written).toEqual([NEW_Z8]);
    expect(fmtCheck(root)).toEqual({ code: 0, changed: [] });
  });
});

describe("validateInMemory", () => {
  it("reports what mapcli validate would, with the tile position and line", () => {
    const world = loadWorld(repo).world;
    expect(validateInMemory(repo, world, content).errors).toBe(0);
    const temple = world.islands.get("testisle")?.meta.temple ?? { x: 0, y: 0, z: 0 };
    const flooded = applyOps(world, [
      { op: "paint_ground", floor: temple.z, cells: [temple], item: "water_shallow" },
    ]).world;
    const report = validateInMemory(repo, flooded, content);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        file: "world/islands/testisle/island.yaml",
        line: 5,
        message: "temple is not on a walkable tile",
        pos: temple,
      }),
    );
  });
});

describe("bootstrap", () => {
  it("sends the world, the palette and the editor texts", () => {
    const b = bootstrap(repo);
    expect(b.loadErrors).toEqual([]);
    expect(b.world.islands.map((i) => i.meta.id)).toEqual(["testisle"]);
    expect(b.items.find((i) => i.id === "grass")).toEqual({
      id: "grass",
      kind: "ground",
      sprite: "ground/grass",
      name: "item.grass.name",
    });
    for (const lang of ["es", "en"]) {
      expect(b.i18n[lang]?.["editor.title"]).toBeTruthy();
      expect(b.i18n[lang]?.["island.testisle.name"]).toBeTruthy();
    }
    expect(Object.keys(b.base)).toHaveLength(6);
  });
});
