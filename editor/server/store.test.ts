import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContent, loadWorld, writeIsland, writeWorldMeta } from "@rpg/map-format";
import { applyOps } from "@rpg/map-format/ops";
import type { MapOp, World } from "@rpg/map-format/ops";
import { run } from "@rpg/mapcli";
import { afterEach, describe, expect, it } from "vitest";
import { History } from "../src/history/history.ts";
import { fromWire, toWire } from "../src/io/wire.ts";
import { SaveRefused, bootstrap, saveWorld, validateInMemory } from "./store.ts";

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

function edited(root: string): World {
  // Through the wire format, as the browser sends it.
  const world = fromWire(JSON.parse(JSON.stringify(toWire(loadWorld(root).world))));
  return applyOps(world, EDITS, { itemKind }).world;
}

describe("saveWorld", () => {
  it("writes exactly what mapcli fmt writes (fmt --check finds nothing to change)", () => {
    const root = scratch();
    const result = saveWorld(root, edited(root));
    expect(result.written).toContain("world/islands/testisle/chunks/z08/c0032_0032.json");
    expect(result.removed).toEqual(["world/islands/testisle/chunks/z08/c0033_0032.json"]);
    expect(fmtCheck(root)).toEqual({ code: 0, changed: [] });
  });

  it("produces the same bytes as map-format's writer", () => {
    const root = scratch();
    const world = edited(root);
    saveWorld(root, world);
    const other = scratch(false);
    writeWorldMeta(other, world.meta);
    for (const island of world.islands.values()) writeIsland(other, island);
    expect(tree(join(root, "world/islands"))).toEqual(tree(join(other, "world/islands")));
    expect(readFileSync(join(root, "world/world.yaml"), "utf8")).toBe(
      readFileSync(join(other, "world/world.yaml"), "utf8"),
    );
  });

  it("writes nothing for an unchanged world, and undo restores the original files", () => {
    const root = scratch();
    const original = tree(join(root, "world"));
    const world = loadWorld(root).world;
    expect(saveWorld(root, world)).toEqual({ written: [], removed: [] });

    const history = new History({ itemKind });
    let w = history.apply(world, "edit", EDITS).world;
    saveWorld(root, w);
    expect(tree(join(root, "world"))).not.toEqual(original);
    w = history.undo(w)?.world ?? w;
    saveWorld(root, w);
    expect(tree(join(root, "world"))).toEqual(original);
  });

  it("refuses to save while a map file does not load", () => {
    const root = scratch();
    const world = loadWorld(root).world;
    const broken = join(root, "world/islands/testisle/chunks/z08/c0033_0033.json");
    writeFileSync(broken, "{ not json");
    expect(() => saveWorld(root, world)).toThrow(SaveRefused);
    expect(readFileSync(broken, "utf8")).toBe("{ not json");
  });
});

describe("validateInMemory", () => {
  it("reports what mapcli validate would, with the tile position", () => {
    const world = loadWorld(repo).world;
    expect(validateInMemory(world, content).errors).toBe(0);
    const temple = world.islands.get("testisle")?.meta.temple ?? { x: 0, y: 0, z: 0 };
    const flooded = applyOps(world, [
      { op: "paint_ground", floor: temple.z, cells: [temple], item: "water_shallow" },
    ]).world;
    const report = validateInMemory(flooded, content);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        file: "world/islands/testisle/island.yaml",
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
    for (const lang of ["es", "en"]) expect(b.i18n[lang]?.["editor.title"]).toBeTruthy();
  });
});
