import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadContent } from "./content.ts";
import { formatDiagnostic } from "./diagnostics.ts";
import { loadWorld } from "./io.ts";
import { applyOps } from "./ops/index.ts";
import { formatPrefab } from "./prefabs.ts";
import { saveApplied } from "./save.ts";
import { validateWorld } from "./validate.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const content = loadContent(repo);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function copy(): string {
  const root = mkdtempSync(join(tmpdir(), "mapfmt-"));
  dirs.push(root);
  for (const d of ["world", "data", "i18n"])
    cpSync(join(repo, d), join(root, d), { recursive: true });
  return root;
}

describe("prefabs", () => {
  it("loads world/prefabs and keeps the repo's prefabs canonical", () => {
    const { prefabs, files } = loadWorld(repo);
    const dock = prefabs.get("small_dock");
    expect(dock?.rows.length).toBeGreaterThan(0);
    const f = files.find((x) => x.file === "world/prefabs/small_dock.yaml");
    expect(f?.text).toBe(f?.canonical);
    if (!dock) throw new Error("small_dock missing");
    expect(formatPrefab(dock)).toBe(f?.text);
  });

  it("reports bad prefabs: id, legend, rows, item kinds, layout", () => {
    const root = copy();
    writeFileSync(
      join(root, "world/prefabs/bad.yaml"),
      [
        "id: other",
        "legend:",
        '  - { char: "#", ground: cargo_crate }',
        '  - { char: "#", items: [grass, nope] }',
        "rows:",
        '  - "#x"',
        "",
      ].join("\n"),
    );
    writeFileSync(join(root, "world/prefabs/Bad Name.yaml"), "id: x\n");
    const msgs = validateWorld(root, { content }).diagnostics.map(formatDiagnostic).join("\n");
    expect(msgs).toMatch(/bad\.yaml.*must match the file name "bad"/);
    expect(msgs).toMatch(/"cargo_crate" is a decoration, not a ground item/);
    expect(msgs).toMatch(/"#" is defined twice/);
    expect(msgs).toMatch(/ground item "grass" belongs in "ground"/);
    expect(msgs).toMatch(/unknown item "nope"/);
    expect(msgs).toMatch(/uses "x", not in the legend/);
    expect(msgs).toMatch(/Bad Name\.yaml.*lowercase snake_case/);
  });

  it("flags a prefab that is not canonical", () => {
    const root = copy();
    const file = join(root, "world/prefabs/small_dock.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace('char: "="', "char: '='"));
    const msgs = validateWorld(root, { content }).diagnostics.map(formatDiagnostic).join("\n");
    expect(msgs).toMatch(/small_dock\.yaml.*canonical/);
  });
});

describe("saveApplied", () => {
  it("writes only what changed and the result reloads byte-identical", () => {
    const root = copy();
    const { world } = loadWorld(root);
    const r = applyOps(world, [
      { op: "paint_ground", floor: 7, rect: { x: 1040, y: 1040, w: 2, h: 2 }, item: "sand" },
      { op: "remove_zone", id: "testisle_dock" },
      { op: "remove_zone", id: "testisle_temple" },
      { op: "erase", floor: 8, rect: { x: 1056, y: 1024, w: 32, h: 32 }, layer: "all" },
    ]);
    const saved = saveApplied(root, r.world, r);
    expect(saved.written).toEqual(["world/islands/testisle/chunks/z07/c0032_0032.json"]);
    expect(saved.removed).toEqual([
      "world/islands/testisle/chunks/z08/c0033_0032.json",
      "world/islands/testisle/zones.yaml",
    ]);
    expect(existsSync(join(root, "world/islands/testisle/zones.yaml"))).toBe(false);
    const again = loadWorld(root);
    expect(again.files.every((f) => f.text === f.canonical)).toBe(true);
    expect(again.world.islands.get("testisle")?.zones).toEqual([]);
    // Undo and save again: the original bytes come back.
    const back = applyOps(again.world, r.inverse);
    saveApplied(root, back.world, back);
    for (const f of loadWorld(repo).files)
      expect(readFileSync(join(root, f.file), "utf8")).toBe(f.text);
  });
});
