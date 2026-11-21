import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import { auxFile, chunkFile, fromWire } from "../src/io/wire.ts";
import type { FileChange, NameText } from "../src/io/wire.ts";
import {
  BadRequest,
  PartialSave,
  SaveConflict,
  bootstrap,
  exportPatch,
  hashText,
  nodeIo,
  parseEditorPatch,
  saveChanges,
  upsertText,
  validateInMemory,
  withPendingKeys,
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
  if (withRepo)
    for (const sub of ["world", "data", "i18n"])
      cpSync(join(repo, sub), join(d, sub), { recursive: true });
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
  const changes = [
    ...r.touched.map((t) => chunkFile(t.island, t.z, t.cx, t.cy)),
    ...r.touchedAux.map((a) => auxFile(a.island, a.file)),
  ].map((file) => ({ file, base: boot.base[file] ?? null }));
  return { world: r.world, changes };
}

// Each test copies world/ and data/ and runs mapcli over them: up to 3.7 s while the whole
// suite runs, close to vitest's 5 s default.
describe("saveChanges", { timeout: 30_000 }, () => {
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
    writeFileSync(
      join(root, Z7),
      readFileSync(join(root, Z7), "utf8").replace('"grass"', '"dirt"'),
    );
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
    expect(changes).toEqual([
      { file: "world/islands/testisle/chunks/z08/c0033_0033.json", base: null },
    ]);
    expect(() => saveChanges(root, world, changes)).toThrow(SaveConflict);
    expect(readFileSync(broken, "utf8")).toBe("{ not json");
  });

  it.each<[string, FileChange[], RegExp]>([
    [
      "path traversal",
      [{ file: "world/islands/testisle/chunks/z07/../../../../../evil.json", base: null }],
      /not a chunk or auxiliary file path/,
    ],
    [
      "an absolute path",
      [{ file: "/tmp/evil.json", base: null }],
      /not a chunk or auxiliary file path/,
    ],
    [
      "a dotted island id",
      [{ file: "world/islands/../chunks/z07/c0032_0032.json", base: null }],
      /not a chunk or auxiliary file path/,
    ],
    [
      "an island not in world.yaml",
      [{ file: "world/islands/other/chunks/z07/c0032_0032.json", base: null }],
      /not in world\/world.yaml/,
    ],
    [
      "a floor out of range",
      [{ file: "world/islands/testisle/chunks/z99/c0032_0032.json", base: null }],
      /out of range/,
    ],
    ["a bad base hash", [{ file: Z7, base: "../x" }], /invalid base hash/],
    [
      "a file listed twice",
      [
        { file: Z7, base: null },
        { file: Z7, base: null },
      ],
      /listed twice/,
    ],
    ["a null change", [null as unknown as FileChange], /each change needs a file path/],
    [
      "a change without a file",
      [{ base: null } as unknown as FileChange],
      /each change needs a file path/,
    ],
    [
      "a numeric file",
      [{ file: 5, base: null } as unknown as FileChange],
      /each change needs a file path/,
    ],
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

describe("saveChanges of auxiliary lists (spawns, npcs, zones, portals)", () => {
  const SPAWNS = "world/islands/testisle/spawns.yaml";
  const NPCS = "world/islands/testisle/npcs.yaml";
  const ZONES = "world/islands/testisle/zones.yaml";
  const PORTALS = "world/islands/testisle/portals.yaml";
  const AUX_EDITS: MapOp[] = [
    { op: "remove_spawn", id: "testisle_crabs" },
    {
      op: "add_spawn",
      id: "testisle_crabs",
      center: { x: 1035, y: 1061, z: 7 },
      radius: 3,
      monsters: [{ monster: "tide_crab", count: 3 }],
      respawn_seconds: 50,
      notes: "moved by the editor",
      index: 1,
    },
    // Moving an NPC from puerto to testisle edits both islands' npcs.yaml.
    { op: "remove_npc", npc: "puerto_diver" },
    { op: "place_npc", npc: "puerto_diver", pos: { x: 1057, y: 1057, z: 7 } },
    { op: "remove_zone", id: "testisle_dock" },
    { op: "remove_portal", id: "testisle_cave_down" },
    { op: "remove_portal", id: "testisle_cave_up" },
  ];

  it("writes what mapcli fmt writes, creates new lists and removes emptied ones", () => {
    const root = scratch();
    const { world, changes } = edit(root, AUX_EDITS);
    const PUERTO_NPCS = "world/islands/puerto/npcs.yaml";
    expect(changes.map((c) => c.file).sort()).toEqual([PUERTO_NPCS, NPCS, PORTALS, SPAWNS, ZONES]);
    expect(changes.find((c) => c.file === NPCS)?.base).toBeNull();
    const r = saveChanges(root, world, changes);
    expect(r.written).toEqual([PUERTO_NPCS, NPCS, SPAWNS, ZONES]);
    expect(r.removed).toEqual([PORTALS]);
    expect(fmtCheck(root)).toEqual({ code: 0, changed: [] });
    expect(readFileSync(join(root, SPAWNS), "utf8")).toContain("moved by the editor");
    expect(readFileSync(join(root, NPCS), "utf8")).toContain("npc: puerto_diver");
    // Same bytes as map-format's writer (what mapcli ops apply writes).
    const other = scratch(false);
    writeWorldMeta(other, world.meta);
    for (const island of world.islands.values()) writeIsland(other, island);
    expect(tree(join(root, "world/islands"))).toEqual(tree(join(other, "world/islands")));
  });

  it("undo restores the auxiliary files byte for byte", () => {
    const root = scratch();
    const original = tree(join(root, "world"));
    const boot = bootstrap(root);
    const history = new History({ itemKind });
    const step = history.apply(fromWire(boot.world), "edit", AUX_EDITS);
    const files = step.touchedAux.map((a) => auxFile(a.island, a.file));
    const saved = saveChanges(
      root,
      step.world,
      files.map((file) => ({ file, base: boot.base[file] ?? null })),
    );
    const undone = history.undo(step.world)?.world ?? step.world;
    saveChanges(
      root,
      undone,
      files.map((file) => ({ file, base: saved.base[file] ?? null })),
    );
    expect(tree(join(root, "world"))).toEqual(original);
  });

  it("refuses with a conflict if the list changed on disk since it was loaded", () => {
    const root = scratch();
    const { world, changes } = edit(root, AUX_EDITS);
    const external = readFileSync(join(root, ZONES), "utf8") + "\n# edited by hand\n";
    writeFileSync(join(root, ZONES), external);
    expect(() => saveChanges(root, world, changes)).toThrow(SaveConflict);
    expect(readFileSync(join(root, ZONES), "utf8")).toBe(external);
    expect(existsSync(join(root, NPCS))).toBe(false);
  });

  it.each<[string, string, RegExp]>([
    [
      "texts.yaml (not editable yet)",
      "world/islands/testisle/texts.yaml",
      /not a chunk or auxiliary file path/,
    ],
    ["island.yaml", "world/islands/testisle/island.yaml", /not a chunk or auxiliary file path/],
    ["world.yaml", "world/world.yaml", /not a chunk or auxiliary file path/],
    [
      "a traversal",
      "world/islands/testisle/../puerto/spawns.yaml",
      /not a chunk or auxiliary file path/,
    ],
    [
      "another extension",
      "world/islands/testisle/spawns.yml",
      /not a chunk or auxiliary file path/,
    ],
    ["an island not in world.yaml", "world/islands/other/spawns.yaml", /not in world\/world.yaml/],
  ])("rejects %s", (_name, file, msg) => {
    const root = scratch();
    const before = tree(root);
    const { world } = edit(root, AUX_EDITS);
    expect(() => saveChanges(root, world, [{ file, base: null }])).toThrow(msg);
    expect(tree(root)).toEqual(before);
  });

  it("rejects lists that do not pass their schema", () => {
    const root = scratch();
    const before = tree(root);
    const { world, changes } = edit(root, AUX_EDITS);
    const spawns = world.islands.get("testisle")?.spawns as unknown as Record<string, unknown>[];
    spawns.push({
      id: "../evil",
      center: { x: 1, y: 1, z: 7 },
      radius: 1,
      monsters: [],
      respawn_seconds: 1,
    });
    expect(() => saveChanges(root, world, changes)).toThrow(BadRequest);
    spawns.pop();
    // A key with a newline would write a comment line of its choosing: the request's own
    // data must pass the schema, not only the text read back.
    spawns.push({
      id: "testisle_evil",
      center: { x: 1, y: 1, z: 7 },
      "radius: 4\n# ARBITRARY\n  notes": "x",
      monsters: [{ monster: "wolf", count: 1 }],
      respawn_seconds: 1,
    });
    // Read back, that text is a valid spawn (radius: 4, notes: x) plus a comment line: only
    // checking the request's own data catches it.
    // (the canonical-text check would catch it too; this asserts the schema one runs first).
    expect(() => saveChanges(root, world, changes)).toThrow(
      /spawns\.yaml: 3 .*(unknown field|required)/,
    );
    expect(tree(root)).toEqual(before);
    spawns.pop();
    (world.islands.get("testisle") as unknown as Record<string, unknown>)["zones"] = "nope";
    expect(() => saveChanges(root, world, changes)).toThrow(/expected a list/);
    expect(tree(root)).toEqual(before);
  });
});

// Each test copies world/ and data/ and runs mapcli over them: up to 3.7 s while the whole
// suite runs, close to vitest's 5 s default.
describe("saveChanges of houses.yaml and house names (house panel)", { timeout: 30_000 }, () => {
  const HOUSES = "world/islands/testisle/houses.yaml";
  const ES = "i18n/es/world.yaml";
  const EN = "i18n/en/world.yaml";
  const KEY = "house.testisle_house_test.name";
  const ADD: MapOp = {
    op: "add_house",
    id: "testisle_house_test",
    rent: 600,
    rects: [
      { x: 1068, y: 1044, z: 7, w: 4, h: 3 },
      { x: 1069, y: 1047, z: 7, w: 1, h: 1 },
    ],
    doors: [{ x: 1069, y: 1047, z: 7 }],
    exit: { x: 1069, y: 1048, z: 7 },
  };
  const NAMES: NameText[] = [
    { lang: "es", key: KEY, text: "Casa de Prueba", base: null },
    { lang: "en", key: KEY, text: "Test House", base: null },
  ];

  it("writes houses.yaml as mapcli does and adds the names after the other house names", () => {
    const root = scratch();
    const es = readFileSync(join(root, ES), "utf8");
    const { world, changes } = edit(root, [ADD]);
    expect(changes).toEqual([{ file: HOUSES, base: null }]);
    // Before saving, the validator takes the pending names as present.
    const missing = validateInMemory(root, world, loadContent(root));
    expect(missing.diagnostics.map((d) => d.message)).toContainEqual(
      expect.stringMatching(`^i18n key "${KEY}" is missing in: `),
    );
    const pending = withPendingKeys(loadContent(root), NAMES);
    expect(validateInMemory(root, world, pending).errors).toBe(0);

    const r = saveChanges(root, world, changes, nodeIo, NAMES);
    expect(r.written).toEqual([EN, ES, HOUSES]);
    expect(r.base[HOUSES]).toBe(hashText(readFileSync(join(root, HOUSES), "utf8")));
    expect(fmtCheck(root)).toEqual({ code: 0, changed: [] });
    expect(readFileSync(join(root, ES), "utf8")).toBe(`${es}${KEY}: "Casa de Prueba"\n`);
    expect(readFileSync(join(root, HOUSES), "utf8")).toContain("- id: testisle_house_test");
    const saved = loadWorld(root).world;
    expect(validateInMemory(root, saved, loadContent(root)).errors).toBe(0);
    expect(saved.islands.get("testisle")?.houses).toEqual(world.islands.get("testisle")?.houses);

    // Removing the island's only house removes the file; the names stay in world.yaml.
    const removed = applyOps(saved, [{ op: "remove_house", id: "testisle_house_test" }]).world;
    const again = saveChanges(root, removed, [{ file: HOUSES, base: r.base[HOUSES] ?? null }]);
    expect(again.removed).toEqual([HOUSES]);
    expect(existsSync(join(root, HOUSES))).toBe(false);
    expect(readFileSync(join(root, ES), "utf8")).toContain(KEY);
  });

  it("renames a house in place and refuses a name changed on disk since it was loaded", () => {
    const root = scratch();
    const world = loadWorld(root).world;
    const es = readFileSync(join(root, ES), "utf8");
    const key = "house.puerto_house_net.name";
    const rename = (base: string | null): NameText[] => [
      { lang: "es", key, text: "Casa de la Red Nueva", base },
    ];
    // Someone else changed the name: conflict, nothing written (not even the other files).
    const { world: edited, changes } = edit(root, [ADD]);
    expect(() =>
      saveChanges(root, edited, changes, nodeIo, rename("Casa de la Red Rota")),
    ).toThrow(SaveConflict);
    expect(readFileSync(join(root, ES), "utf8")).toBe(es);
    expect(existsSync(join(root, HOUSES))).toBe(false);

    const r = saveChanges(root, world, [], nodeIo, rename("Casa de la Red Tendida"));
    expect(r.written).toEqual([ES]);
    expect(readFileSync(join(root, ES), "utf8")).toBe(
      es.replace(`${key}: "Casa de la Red Tendida"`, `${key}: "Casa de la Red Nueva"`),
    );
    // Saving the same name again (another tab) is not a conflict and writes nothing.
    expect(saveChanges(root, world, [], nodeIo, rename("Casa de la Red Tendida")).written).toEqual(
      [],
    );
  });

  it.each<[string, unknown]>([
    ["texts that are not a list", { lang: "es", key: KEY, text: "x", base: null }],
    [
      "a key that is not a house name",
      [{ lang: "es", key: "island.puerto.name", text: "x", base: null }],
    ],
    ["an unknown language", [{ lang: "fr", key: KEY, text: "Maison", base: null }]],
    ["an i18n placeholder", [{ lang: "es", key: KEY, text: "Casa {name}", base: null }]],
    ["a second line", [{ lang: "es", key: KEY, text: "Casa\nevil: 1", base: null }]],
    ["surrounding spaces", [{ lang: "es", key: KEY, text: " Casa", base: null }]],
    ["an empty name", [{ lang: "es", key: KEY, text: "", base: null }]],
    ["a name listed twice", [NAMES[0], NAMES[0]]],
    ["a bad base", [{ lang: "es", key: KEY, text: "Casa", base: 3 }]],
  ])("refuses %s", (_what, texts) => {
    const root = scratch();
    const before = tree(join(root, "i18n"));
    expect(() => saveChanges(root, loadWorld(root).world, [], nodeIo, texts)).toThrow(BadRequest);
    expect(tree(join(root, "i18n"))).toEqual(before);
  });

  it("upsertText replaces a key's line or adds it after the last house name", () => {
    const text = '# c\na: "1"\nhouse.x.name: "X"\nb: "2"\n';
    expect(upsertText(text, "house.x.name", "Y")).toBe('# c\na: "1"\nhouse.x.name: "Y"\nb: "2"\n');
    expect(upsertText(text, "house.y.name", 'Q "q"')).toBe(
      '# c\na: "1"\nhouse.x.name: "X"\nhouse.y.name: "Q \\"q\\""\nb: "2"\n',
    );
    expect(upsertText('a: "1"\n', "house.y.name", "Y")).toBe('a: "1"\nhouse.y.name: "Y"\n');
    expect(upsertText('a: "1"', "house.y.name", "Y")).toBe('a: "1"\nhouse.y.name: "Y"\n');
  });

  it("withPendingKeys only adds house names, to a copy of the index", () => {
    const base = loadContent(repo);
    const out = withPendingKeys(base, [
      { lang: "es", key: KEY },
      { lang: "es", key: "editor.title.fake" },
      { lang: "xx", key: KEY },
    ]);
    expect(out.i18n.get("es")?.has(KEY)).toBe(true);
    expect(out.i18n.get("es")?.has("editor.title.fake")).toBe(false);
    expect(base.i18n.get("es")?.has(KEY)).toBe(false);
    expect(withPendingKeys(base, undefined)).toBe(base);
    expect(() => withPendingKeys(base, "nope")).toThrow(BadRequest);
    expect(() => withPendingKeys(base, [{ lang: "es" }])).toThrow(BadRequest);
  });

  it("never exports houses.yaml in a map patch", () => {
    const root = scratch();
    const before = loadWorld(root).world;
    const after = applyOps(before, [ADD]).world;
    expect(() => exportPatch(root, before, after, [HOUSES])).toThrow(/cannot go in a map patch/);
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
    expect(b.world.islands.map((i) => i.meta.id)).toEqual([
      "puerto",
      "testisle",
      "bosque",
      "volcan",
      "pruebas",
    ]);
    expect(b.items.find((i) => i.id === "grass")).toEqual({
      id: "grass",
      kind: "ground",
      sprite: "ground/grass",
      name: "item.grass.name",
    });
    // Doors and keys carry what the palette and the tile info say of them.
    const pick = (id: string) => {
      const i = b.items.find((x) => x.id === id);
      return { door: i?.door, lock: i?.lock, key: i?.key };
    };
    expect(pick("forge_gate")).toEqual({ door: "closed", lock: "forge_gate", key: undefined });
    expect(pick("forge_gate_open")).toEqual({ door: "open", lock: undefined, key: undefined });
    expect(pick("ember_key")).toEqual({ door: undefined, lock: undefined, key: "forge_gate" });
    expect(pick("grass")).toEqual({ door: undefined, lock: undefined, key: undefined });
    // ART-8: the canvas raises what is stacked on a crate.
    expect(b.items.find((i) => i.id === "cargo_crate")?.elevation).toBe(8);
    for (const lang of ["es", "en"]) {
      expect(b.i18n[lang]?.["editor.door_locked"]).toContain("{key}");
      expect(b.i18n[lang]?.["editor.title"]).toBeTruthy();
      expect(b.i18n[lang]?.["island.testisle.name"]).toBeTruthy();
    }
    // testisle + puerto + bosque + volcan + pruebas chunks, and their spawns/npcs/zones/portals.yaml
    // and houses.yaml (not texts.yaml).
    expect(Object.keys(b.base).filter((f) => f.endsWith(".json"))).toHaveLength(
      6 + 43 + 40 + 46 + 11,
    );
    const lists = ["houses", "npcs", "portals", "spawns", "zones"];
    expect(
      Object.keys(b.base)
        .filter((f) => f.endsWith(".yaml"))
        .sort(),
    ).toEqual([
      ...lists.map((f) => `world/islands/bosque/${f}.yaml`),
      ...lists.map((f) => `world/islands/pruebas/${f}.yaml`),
      ...lists.map((f) => `world/islands/puerto/${f}.yaml`),
      ...["portals", "spawns", "zones"].map((f) => `world/islands/testisle/${f}.yaml`),
      ...lists.map((f) => `world/islands/volcan/${f}.yaml`),
    ]);
    expect(b.borders.ladder.map((s) => s.ground)).toContain("grass");
    expect(b.monsters).toContain("wolf");
  });
});

describe("map patches", () => {
  const Z7 = "world/islands/testisle/chunks/z07/c0032_0032.json";
  const SP = "world/islands/testisle/spawns.yaml";

  it("exports a format 2 patch that mapcli applies, and writes nothing", () => {
    const root = scratch();
    const before = loadWorld(root).world;
    const after = applyOps(
      before,
      [{ op: "paint_ground", floor: 7, rect: { x: 1045, y: 1045, w: 2, h: 2 }, item: "sand" }],
      { itemKind },
    ).world;
    const snapshot = tree(join(root, "world"));
    const patch = exportPatch(root, before, after, [Z7, Z7]);
    expect(tree(join(root, "world"))).toEqual(snapshot);
    expect(patch).toMatchObject({ format: 2, kind: "rpg-map-patch", base_ref: "editor" });
    expect(patch.files.map((f) => f.path)).toEqual([Z7]);
    const file = patch.files[0];
    expect(file?.base_text).toBe(readFileSync(join(root, Z7), "utf8"));
    expect(file?.base).toBe(`sha256:${hashText(file?.base_text ?? "")}`);

    // Round trip: the editor parses its own patch; mapcli applies it to a copy.
    const parsed = parseEditorPatch(root, JSON.stringify(patch));
    expect(parsed.files[0]).toMatchObject({
      path: Z7,
      island: "testisle",
      target: { kind: "chunk", z: 7, cx: 32, cy: 32 },
      baseKnown: true,
    });
    const dst = scratch();
    const pf = join(dst, "p.rpgpatch.json");
    writeFileSync(pf, JSON.stringify(patch));
    let out = "";
    expect(
      run(["patch", "apply", pf, "--root", dst], { out: (t) => (out += t), err: () => {} }),
    ).toBe(0);
    saveChanges(root, after, [{ file: Z7, base: hashText(readFileSync(join(root, Z7), "utf8")) }]);
    expect(readFileSync(join(dst, Z7), "utf8")).toBe(readFileSync(join(root, Z7), "utf8"));
  });

  it("refuses unsafe or non-editor paths and malformed patches", () => {
    const root = scratch();
    const chunk = readFileSync(join(root, Z7), "utf8");
    const patch = (files: unknown[]) =>
      JSON.stringify({ format: 2, kind: "rpg-map-patch", base_ref: "editor", files });
    for (const path of [
      "../outside.json",
      "world/../data/items/ground.yaml",
      "data/items/ground.yaml",
      "world/islands/testisle/../../world.yaml",
      "world/world.yaml", // valid patch path, but not something the editor applies
      "world/islands/testisle/island.yaml",
      "world/islands/testisle/texts.yaml",
      "world/islands/puerto/houses.yaml", // houses never go in a patch (maintainers only)
      "world/islands/nowhere/chunks/z07/c0032_0032.json",
    ])
      expect(() => parseEditorPatch(root, patch([{ path, base: null, content: chunk }]))).toThrow(
        BadRequest,
      );
    expect(() => parseEditorPatch(root, "not json")).toThrow(BadRequest);
    expect(() => parseEditorPatch(root, 42)).toThrow(BadRequest);
    expect(() =>
      parseEditorPatch(root, patch([{ path: SP, base: null, content: "- id: Bad Id\n" }])),
    ).toThrow(BadRequest);
    expect(() =>
      exportPatch(root, loadWorld(root).world, loadWorld(root).world, ["../../etc/passwd"]),
    ).toThrow(BadRequest);
  });

  it("finds the base of format 1 patches on disk when the hash matches", () => {
    const root = scratch();
    const text = readFileSync(join(root, Z7), "utf8");
    const p1 = (base: string) =>
      JSON.stringify({
        format: 1,
        kind: "rpg-map-patch",
        base_ref: "HEAD",
        files: [{ path: Z7, base, content: text }],
      });
    expect(parseEditorPatch(root, p1(`sha256:${hashText(text)}`)).files[0]?.baseKnown).toBe(true);
    expect(parseEditorPatch(root, p1(`sha256:${"0".repeat(64)}`)).files[0]?.baseKnown).toBe(false);
  });
});
