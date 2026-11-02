import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadContent } from "./content.ts";
import { loadWorld, writeIsland, writeWorldMeta } from "./io.ts";
import { applyOps } from "./ops/index.ts";
import type { MapOp } from "./ops/index.ts";
import type { World } from "./types.ts";
import { validateLoaded, validateWorld } from "./validate.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const content = loadContent(repo);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** validateWorld on the world written to disk, for comparison. */
function onDisk(world: World): ReturnType<typeof validateWorld> {
  const root = mkdtempSync(join(tmpdir(), "rpg-validate-loaded-"));
  dirs.push(root);
  writeWorldMeta(root, world.meta);
  for (const island of world.islands.values()) writeIsland(root, island);
  return validateWorld(root, { content });
}

const strip = (r: ReturnType<typeof validateWorld>): unknown =>
  r.diagnostics.map((d) => ({ ...d, line: undefined }));

describe("validateLoaded", () => {
  it("agrees with validateWorld on the repository world", () => {
    const { world } = loadWorld(repo);
    expect(validateLoaded(world, content)).toEqual(validateWorld(repo, { content }));
  });

  it.each<[string, MapOp[]]>([
    [
      "a flooded temple",
      [{ op: "paint_ground", floor: 7, cells: [{ x: 1056, y: 1056 }], item: "water_shallow" }],
    ],
    [
      "items without ground",
      [
        { op: "place_item", pos: { x: 1030, y: 1030, z: 7 }, item: "cargo_crate" },
        { op: "erase", floor: 7, cells: [{ x: 1030, y: 1030 }], layer: "ground" },
      ],
    ],
  ])("reports the same findings as validateWorld for %s", (_name, ops) => {
    const world = applyOps(loadWorld(repo).world, ops).world;
    const mem = validateLoaded(world, content);
    expect(mem.errors).toBeGreaterThan(0);
    expect(strip(mem)).toEqual(strip(onDisk(world)));
  });

  it("uses the line lookup it is given", () => {
    const loaded = loadWorld(repo);
    const world = applyOps(loaded.world, [
      { op: "paint_ground", floor: 7, cells: [{ x: 1056, y: 1056 }], item: "water_shallow" },
    ]).world;
    const d = validateLoaded(world, content, { lines: loaded.lines }).diagnostics.find((x) =>
      x.message.includes("temple"),
    );
    expect(d?.line).toBe(5);
  });
});
