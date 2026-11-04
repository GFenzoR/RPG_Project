import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pushItem, setGround } from "./chunk.ts";
import { loadContent } from "./content.ts";
import { formatDiagnostic } from "./diagnostics.ts";
import { writeIsland, writeWorldMeta } from "./io.ts";
import { chunkKey, emptyChunk } from "./types.ts";
import type { Island, Position, WorldMeta } from "./types.ts";
import { validateWorld } from "./validate.ts";

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("fixture value missing");
  return v;
}

const repo = fileURLToPath(new URL("../../../", import.meta.url));
// The real routes of data/ point at the real islands, not at these mini worlds: each test
// that checks routes brings its own.
const content = { ...loadContent(repo), routes: [] };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 32x32 island at (0,0): water ring, grass inside, stone temple tile; a dirt cave on z8. */
function mini(): Island {
  const top = emptyChunk(0, 0, 7);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const edge = x < 2 || y < 2 || x > 29 || y > 29;
      setGround(top, x, y, edge ? "water_shallow" : "grass");
    }
  setGround(top, 16, 16, "stone_floor");
  const cave = emptyChunk(0, 0, 8);
  for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) setGround(cave, x, y, "dirt");
  return {
    meta: {
      id: "mini",
      name: "island.testisle.name",
      rect: { x: 0, y: 0, w: 32, h: 32 },
      floors: [7, 8],
      temple: { x: 16, y: 16, z: 7 },
      level_hint: [1, 5],
    },
    chunks: new Map([
      [chunkKey(7, 0, 0), top],
      [chunkKey(8, 0, 0), cave],
    ]),
    spawns: [
      {
        id: "mini_wolves",
        center: { x: 6, y: 6, z: 7 },
        radius: 3,
        monsters: [{ monster: "wolf", count: 2 }],
        respawn_seconds: 60,
      },
    ],
    npcs: [{ npc: "harbor_master", pos: { x: 20, y: 20, z: 7 } }],
    zones: [
      { id: "mini_temple", type: "protection", floors: [7], rects: [{ x: 15, y: 15, w: 3, h: 3 }] },
    ],
    portals: [
      { id: "mini_down", from: { x: 10, y: 10, z: 7 }, to: { x: 11, y: 11, z: 8 }, kind: "stairs" },
      { id: "mini_up", from: { x: 10, y: 10, z: 8 }, to: { x: 11, y: 10, z: 7 }, kind: "stairs" },
    ],
    texts: [],
  };
}

function worldOf(...islands: Island[]): WorldMeta {
  return {
    format: 1,
    islands: islands.map((i) => ({
      id: i.meta.id,
      rect: i.meta.rect,
      level_hint: i.meta.level_hint,
    })),
  };
}

function check(island: Island, meta: WorldMeta = worldOf(island), extra: Island[] = []) {
  const root = mkdtempSync(join(tmpdir(), "map-format-"));
  dirs.push(root);
  writeWorldMeta(root, meta);
  for (const i of [island, ...extra]) writeIsland(root, i);
  return { root, ...validateWorld(root, { content }) };
}

const messages = (r: { diagnostics: Parameters<typeof formatDiagnostic>[0][] }): string[] =>
  r.diagnostics.map(formatDiagnostic);

describe("validateWorld", () => {
  it("accepts a valid island", () => {
    const r = check(mini());
    expect(messages(r)).toEqual([]);
  });

  it("accepts the repository world (world/islands/testisle)", () => {
    const r = validateWorld(repo, { content });
    expect(messages(r)).toEqual([]);
  });

  it("rejects unknown items and ground items in the wrong layer", () => {
    const i = mini();
    const c = must(i.chunks.get(chunkKey(7, 0, 0)));
    setGround(c, 3, 3, "lava_pit");
    setGround(c, 4, 3, "rope");
    pushItem(c, 5, 3, "grass");
    const m = messages(check(i));
    expect(m).toContainEqual(expect.stringContaining('unknown item "lava_pit"'));
    expect(m).toContainEqual(expect.stringContaining('"rope" is a tool, not a ground item'));
    expect(m).toContainEqual(
      expect.stringContaining('ground item "grass" belongs in the ground layer'),
    );
  });

  it("rejects items on a tile without ground", () => {
    const i = mini();
    pushItem(must(i.chunks.get(chunkKey(8, 0, 0))), 0, 0, "rope");
    expect(messages(check(i))).toContainEqual(
      expect.stringMatching(/z08.*\(0,0,8\) items on a tile without ground/),
    );
  });

  it("rejects spawns, NPCs and temples off walkable ground", () => {
    const i = mini();
    must(i.spawns[0]).center = { x: 0, y: 0, z: 7 };
    must(i.npcs[0]).pos = { x: 1, y: 1, z: 7 };
    i.meta.temple = { x: 31, y: 31, z: 7 };
    const m = messages(check(i));
    expect(m).toContainEqual(expect.stringContaining("spawn center is not on a walkable tile"));
    expect(m).toContainEqual(expect.stringContaining("NPC is not on a walkable tile"));
    expect(m).toContainEqual(expect.stringContaining("temple is not on a walkable tile"));
  });

  it("rejects unknown monsters and NPCs", () => {
    const i = mini();
    must(must(i.spawns[0]).monsters[0]).monster = "dragon_king";
    must(i.npcs[0]).npc = "nobody";
    const m = messages(check(i));
    expect(m).toContainEqual(
      expect.stringMatching(
        /spawns\.yaml:\d+ \[0\]\.monsters\[0\]\.monster: unknown monster "dragon_king"/,
      ),
    );
    expect(m).toContainEqual(expect.stringContaining('unknown NPC "nobody"'));
  });

  it("requires a protection zone over the temple", () => {
    const i = mini();
    must(i.zones[0]).type = "no_logout";
    expect(messages(check(i))).toContainEqual(
      expect.stringContaining("temple is not covered by a protection zone"),
    );
  });

  it("requires stairs to have a way back", () => {
    const i = mini();
    i.portals.pop();
    expect(messages(check(i))).toContainEqual(
      expect.stringContaining("stairs at 10,10,7 has no way back"),
    );
  });

  it("rejects portals into the void and holes that go up", () => {
    const i = mini();
    i.portals.push({
      id: "mini_hole",
      from: { x: 12, y: 12, z: 8 },
      to: { x: 25, y: 25, z: 7 },
      kind: "hole",
    });
    i.portals.push({
      id: "mini_void",
      from: { x: 20, y: 5, z: 7 },
      to: { x: 2, y: 2, z: 8 },
      kind: "teleport",
    });
    const m = messages(check(i));
    expect(m).toContainEqual(expect.stringContaining("a hole leads down"));
    expect(m).toContainEqual(expect.stringContaining("portal destination is not a walkable tile"));
  });

  it("reports what cannot be reached from the temple", () => {
    const i = mini();
    const c = must(i.chunks.get(chunkKey(7, 0, 0)));
    // Water wall around the NPC's corner: x = 18 and y = 18 lines.
    for (let k = 2; k < 30; k++) {
      setGround(c, 18, k, k < 18 ? "grass" : "water_shallow");
      setGround(c, k, 18, k < 18 ? "grass" : "water_shallow");
    }
    i.spawns.push({
      id: "mini_rats",
      center: { x: 12, y: 12, z: 8 },
      radius: 1,
      monsters: [{ monster: "bilge_rat", count: 1 }],
      respawn_seconds: 30,
    });
    const m = messages(check(i));
    expect(m).toContainEqual(
      expect.stringContaining("NPC cannot be reached on foot from the temple"),
    );
    expect(m.join("\n")).not.toContain("spawn cannot be reached"); // the cave is reached by the stairs
  });

  it("rejects chunks and tiles outside the island rectangle", () => {
    const i = mini();
    i.meta.rect = { x: 0, y: 0, w: 31, h: 32 };
    const far = emptyChunk(5, 5, 7);
    setGround(far, 0, 0, "grass");
    i.chunks.set(chunkKey(7, 5, 5), far);
    const m = messages(check(i, worldOf(i)));
    expect(m).toContainEqual(
      expect.stringContaining("c0005_0005.json chunk: chunk lies outside the island rectangle"),
    );
    expect(m).toContainEqual(expect.stringContaining("(31,0,7) tile outside the island rectangle"));
  });

  it("rejects overlapping islands and rect mismatches with world.yaml", () => {
    const a = mini();
    const b = mini();
    b.meta.id = "mini_two";
    b.meta.rect = { x: 0, y: 0, w: 64, h: 32 };
    b.chunks = new Map();
    b.spawns = [];
    b.npcs = [];
    b.portals = [];
    b.zones = [
      { id: "two_temple", type: "protection", floors: [7], rects: [{ x: 16, y: 16, w: 1, h: 1 }] },
    ];
    const meta = worldOf(a, b);
    must(meta.islands[0]).level_hint = [2, 5];
    const m = messages(check(a, meta, [b]));
    expect(m).toContainEqual(expect.stringContaining('overlaps island "mini"'));
    expect(m).toContainEqual(expect.stringContaining('differs from the level_hint of "mini"'));
  });

  it("rejects missing translations", () => {
    const i = mini();
    i.meta.name = "island.nowhere.name";
    expect(messages(check(i))).toContainEqual(
      expect.stringContaining('i18n key "island.nowhere.name" is missing in: es, en'),
    );
  });

  it("warns about large walkable areas the temple cannot reach (T3.6)", () => {
    const i = mini();
    const top = must(i.chunks.get(chunkKey(7, 0, 0)));
    // A 3x4 sandbar cut off by water, a 2x2 pocket (too small to warn) and a walled-off
    // 3x4 inside a community plot (skipped).
    for (let y = 2; y < 30; y++) setGround(top, 24, y, "water_shallow");
    for (let y = 2; y < 30; y++)
      for (let x = 25; x < 30; x++) setGround(top, x, y, "water_shallow");
    for (let y = 4; y < 8; y++) for (let x = 26; x < 29; x++) setGround(top, x, y, "sand");
    for (let y = 12; y < 14; y++) for (let x = 26; x < 28; x++) setGround(top, x, y, "sand");
    for (let y = 20; y < 24; y++) for (let x = 26; x < 29; x++) setGround(top, x, y, "sand");
    i.zones.push({
      id: "mini_plot",
      type: "community_plot",
      floors: [7],
      rects: [{ x: 26, y: 20, w: 3, h: 4 }],
    });
    const r = check(i);
    const warns = messages(r).filter((m) =>
      m.includes("cannot be reached on foot from the temple"),
    );
    expect(warns).toEqual([expect.stringContaining("warning world/islands/mini/island.yaml")]);
    expect(warns[0]).toContain("(26,4,7) 12 walkable tiles");
  });

  it("warns about overcrowded spawns", () => {
    const i = mini();
    must(must(i.spawns[0]).monsters[0]).count = 40;
    const r = check(i);
    expect(r.errors).toBe(0);
    expect(messages(r)).toContainEqual(
      expect.stringContaining(
        "warning world/islands/mini/spawns.yaml:1 [0]: (6,6,7) 40 monsters on 49 walkable tiles",
      ),
    );
  });

  it("rejects files that are not in canonical form, and schema errors with lines", () => {
    const i = mini();
    const { root } = check(i);
    const file = join(root, "world/islands/mini/spawns.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("radius: 3", "radius:   3"));
    const zones = join(root, "world/islands/mini/zones.yaml");
    writeFileSync(zones, readFileSync(zones, "utf8").replace("type: protection", "type: safe"));
    const m = messages(validateWorld(root, { content }));
    expect(m).toContainEqual(
      "error world/islands/mini/spawns.yaml:1 not in canonical format; run `mapcli fmt`",
    );
    expect(m).toContainEqual(
      expect.stringMatching(
        /zones\.yaml:2 \[0\]\.type: must be equal to one of the allowed values: protection/,
      ),
    );
  });

  it("filters by island", () => {
    const i = mini();
    must(i.npcs[0]).npc = "nobody";
    const { root } = check(i);
    expect(validateWorld(root, { content, island: "mini" }).errors).toBe(1);
    expect(validateWorld(root, { content, island: "other" }).diagnostics).toEqual([
      {
        severity: "error",
        file: "world/islands/other/",
        path: [],
        message: 'island "other" is not loaded',
      },
    ]);
  });
});

describe("review fixes", () => {
  it("requires island rectangles aligned to chunks", () => {
    const i = mini();
    i.meta.rect = { x: 0, y: 0, w: 40, h: 32 };
    expect(messages(check(i))).toContainEqual(
      expect.stringMatching(
        /world\.yaml:\d+ islands\[0\]\.rect: island rectangles must be aligned to chunks/,
      ),
    );
  });

  it("treats kind: wall as blocking unless blocks_movement is false", () => {
    const root = mkdtempSync(join(tmpdir(), "map-format-content-"));
    dirs.push(root);
    mkdirSync(join(root, "data", "items"), { recursive: true });
    writeFileSync(
      join(root, "data", "items", "walls.yaml"),
      [
        "- { id: stone_wall, kind: wall }",
        "- { id: arch, kind: wall, blocks_movement: false }",
        "- { id: crate, kind: decoration, blocks_movement: true }",
        "- { id: flower, kind: decoration }",
      ].join("\n"),
    );
    const items = loadContent(root).items;
    expect([...items.values()].map((it) => [it.id, it.blocksMovement])).toEqual([
      ["stone_wall", true],
      ["arch", false],
      ["crate", true],
      ["flower", false],
    ]);
  });

  it("keeps world.yaml and boat route findings about the island when filtering by island", () => {
    const i = mini();
    const meta = worldOf(i);
    must(meta.islands[0]).level_hint = [9, 2];
    const { root } = check(i, meta);
    const withRoutes = {
      ...content,
      routes: [
        {
          index: 0,
          id: "r",
          captain: "harbor_master",
          from: { x: 20, y: 21, z: 7 },
          to: { x: 0, y: 0, z: 7 },
        },
        {
          index: 1,
          id: "s",
          captain: "harbor_master",
          from: { x: 20, y: 21, z: 7 },
          to: { x: 900, y: 900, z: 7 },
        },
        {
          index: 2,
          id: "t",
          captain: "ghost",
          from: { x: 20, y: 21, z: 7 },
          to: { x: 16, y: 17, z: 7 },
        },
      ],
    };
    const m = validateWorld(root, { content: withRoutes, island: "mini" }).diagnostics.map(
      formatDiagnostic,
    );
    expect(m).toContainEqual(
      expect.stringContaining("islands[0].level_hint: level_hint is [min, max]"),
    );
    expect(
      m.some((l) => l.includes("[0].to:") && l.includes("arrival is not a walkable tile")),
    ).toBe(true);
    // Route 1 leaves from this island, so its arrival elsewhere is reported here too.
    expect(m.some((l) => l.includes("[1].to:") && l.includes("outside every island"))).toBe(true);
    // A captain that is not placed anywhere concerns the island of its dock.
    expect(m.some((l) => l.includes("[2].captain:") && l.includes('"ghost" is not placed'))).toBe(
      true,
    );
    // Filtering by another island drops it.
    const other = validateWorld(root, { content: withRoutes, island: "nope" }).diagnostics;
    expect(other.some((d) => d.file === "data/boat_routes.yaml")).toBe(false);
  });

  it("checks boat routes against the map", () => {
    const i = mini();
    const { root } = check(i);
    const route = (index: number, captain: string, from: Position, to: Position) => ({
      index,
      id: `r${index}`,
      captain,
      from,
      to,
    });
    const withRoutes = {
      ...content,
      routes: [
        route(0, "harbor_master", { x: 20, y: 21, z: 7 }, { x: 16, y: 17, z: 7 }),
        route(1, "ghost", { x: 20, y: 21, z: 7 }, { x: 16, y: 17, z: 7 }),
        route(2, "harbor_master", { x: 5, y: 5, z: 7 }, { x: 16, y: 17, z: 7 }),
        route(3, "harbor_master", { x: 21, y: 30, z: 7 }, { x: 900, y: 900, z: 7 }),
        route(4, "harbor_master", { x: 20, y: 21, z: 7 }, { x: 16, y: 17, z: 8 }),
      ],
    };
    const m = validateWorld(root, { content: withRoutes })
      .diagnostics.map(formatDiagnostic)
      .filter((d) => d.includes("data/boat_routes.yaml"));
    expect(m.join("\n")).not.toMatch(/boat_routes\.yaml.*\[0\]/);
    expect(m.some((l) => l.includes("[1].captain:") && l.includes('"ghost" is not placed'))).toBe(
      true,
    );
    expect(
      m.some((l) => l.includes("[2].from:") && l.includes("the dock is more than 8 tiles")),
    ).toBe(true);
    expect(
      m.some((l) => l.includes("[3].from:") && l.includes("dock is not a walkable tile")),
    ).toBe(true);
    expect(
      m.some((l) => l.includes("[3].to:") && l.includes("arrival is outside every island")),
    ).toBe(true);
    expect(
      m.some((l) => l.includes("[4].to:") && l.includes("arrival is not a walkable tile")),
    ).toBe(true);
  });

  it("ignores dotfiles and reports wrong entry types without throwing", () => {
    const { root } = check(mini());
    const isle = join(root, "world/islands/mini");
    writeFileSync(join(root, "world/islands/.DS_Store"), "x");
    writeFileSync(join(isle, ".DS_Store"), "x");
    writeFileSync(join(isle, "chunks/.DS_Store"), "x");
    writeFileSync(join(isle, "chunks/z07/.gitkeep"), "");
    expect(messages(validateWorld(root, { content }))).toEqual([]);
    mkdirSync(join(isle, "chunks/z07/c0009_0009.json"));
    writeFileSync(join(isle, "chunks/z09"), "not a directory");
    rmSync(join(isle, "zones.yaml"));
    mkdirSync(join(isle, "zones.yaml"));
    const m = messages(validateWorld(root, { content }));
    expect(m).toContainEqual(expect.stringContaining("chunks/z07/c0009_0009.json expected a file"));
    expect(m).toContainEqual(expect.stringContaining("chunks/z09 expected a directory"));
    expect(m).toContainEqual(expect.stringContaining("mini/zones.yaml expected a file"));
  });

  it("reports chunks that is a file and YAML alias bombs as diagnostics", () => {
    const { root } = check(mini());
    const isle = join(root, "world/islands/mini");
    rmSync(join(isle, "chunks"), { recursive: true });
    writeFileSync(join(isle, "chunks"), "oops");
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x]"];
    for (let k = 0; k < 9; k++)
      bomb.push(
        `${String.fromCharCode(98 + k)}: &${String.fromCharCode(98 + k)} [*${String.fromCharCode(97 + k)}, *${String.fromCharCode(97 + k)}, *${String.fromCharCode(97 + k)}, *${String.fromCharCode(97 + k)}, *${String.fromCharCode(97 + k)}, *${String.fromCharCode(97 + k)}, *${String.fromCharCode(97 + k)}, *${String.fromCharCode(97 + k)}, *${String.fromCharCode(97 + k)}]`,
      );
    writeFileSync(join(isle, "texts.yaml"), `${bomb.join("\n")}\n`);
    const m = messages(validateWorld(root, { content }));
    expect(m).toContainEqual(expect.stringContaining("mini/chunks expected a directory"));
    expect(m).toContainEqual(expect.stringMatching(/texts\.yaml.* invalid YAML: .*alias/i));
  });

  it("reports an island listed twice once and loads it once", () => {
    const i = mini();
    const meta = worldOf(i);
    meta.islands.push({ ...must(meta.islands[0]) });
    const m = messages(check(i, meta));
    expect(m.filter((x) => x.includes('island "mini" is listed twice'))).toHaveLength(1);
    expect(m.join("\n")).not.toContain("already defined");
  });

  it("points diagnostics at the real directory when island.yaml has another id", () => {
    const i = mini();
    const { root } = check(i);
    const file = join(root, "world/islands/mini/island.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("id: mini", "id: renamed"));
    const npcs = join(root, "world/islands/mini/npcs.yaml");
    writeFileSync(npcs, readFileSync(npcs, "utf8").replace("npc: harbor_master", "npc: nobody"));
    const m = messages(validateWorld(root, { content }));
    expect(m).toContainEqual(
      expect.stringContaining(
        'island.yaml:1 id: id "renamed" must match the directory name "mini"',
      ),
    );
    expect(m).toContainEqual(
      expect.stringContaining('world/islands/mini/npcs.yaml:1 [0].npc: unknown NPC "nobody"'),
    );
    expect(m.join("\n")).not.toContain("world/islands/renamed");
  });

  it("clips huge zone rectangles to the island before scanning them", () => {
    const i = mini();
    i.zones.push({
      id: "mini_huge",
      type: "no_logout",
      floors: [8],
      rects: [{ x: 0, y: 0, w: 65536, h: 65536 }],
    });
    const cave = must(i.chunks.get(chunkKey(8, 0, 0)));
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setGround(cave, x, y, null);
    setGround(cave, 11, 11, "dirt");
    i.portals = [];
    const started = performance.now();
    const m = messages(check(i));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(m).toContainEqual(
      expect.stringContaining('zone "mini_huge" has no tile reachable from the temple'),
    );
    expect(m).toContainEqual(
      expect.stringContaining("rects[0]: rectangle leaves the island rectangle"),
    );
  });

  it("only reads the configured languages and survives stray files in i18n/", () => {
    const root = mkdtempSync(join(tmpdir(), "map-format-i18n-"));
    dirs.push(root);
    cpSync(join(repo, "i18n"), join(root, "i18n"), { recursive: true });
    writeFileSync(join(root, "i18n", "README.md"), "notes");
    mkdirSync(join(root, "i18n", "fr"));
    const i18n = loadContent(root).i18n;
    expect([...i18n.keys()]).toEqual(["es", "en"]);
    expect(i18n.get("es")?.has("island.testisle.name")).toBe(true);
  });
});

describe("review fixes, round 2", () => {
  const two = (): Island => {
    const b = mini();
    b.meta.id = "mini_two";
    b.meta.rect = { x: 0, y: 0, w: 64, h: 32 };
    b.chunks = new Map();
    b.spawns = [];
    b.npcs = [];
    b.portals = [];
    b.zones = [
      { id: "two_temple", type: "protection", floors: [7], rects: [{ x: 16, y: 16, w: 1, h: 1 }] },
    ];
    return b;
  };
  const only = (root: string, island: string): string[] =>
    validateWorld(root, { content, island }).diagnostics.map(formatDiagnostic);

  it("reports an overlap on both islands, whatever their order", () => {
    for (const order of [0, 1]) {
      const a = mini();
      const b = two();
      const { root } = check(a, order === 0 ? worldOf(a, b) : worldOf(b, a), [b]);
      expect(only(root, "mini")).toContainEqual(
        expect.stringContaining('overlaps island "mini_two"'),
      );
      expect(only(root, "mini_two")).toContainEqual(
        expect.stringContaining('overlaps island "mini"'),
      );
    }
  });

  it("keeps world.yaml rect and duplicate-id findings when filtering by island", () => {
    const i = mini();
    const meta = worldOf(i);
    must(meta.islands[0]).rect = { x: 65504, y: 0, w: 64, h: 32 };
    meta.islands.push({ ...must(meta.islands[0]) });
    const { root } = check(i, meta);
    const m = only(root, "mini");
    expect(m).toContainEqual(
      expect.stringContaining("islands[0].rect: rectangle leaves the world"),
    );
    expect(m).toContainEqual(
      expect.stringContaining('islands[1].id: island "mini" is listed twice'),
    );
  });

  it("shows a schema error in world.yaml instead of 'not listed' when filtering", () => {
    const { root } = check(mini());
    const file = join(root, "world/world.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("level_hint: [1, 5]", 'level_hint: [1, "x"]'),
    );
    const m = only(root, "mini");
    expect(m).toContainEqual(
      expect.stringMatching(/world\.yaml:\d+ islands\[0\]\.level_hint\[1\]: must be integer/),
    );
    expect(m.join("\n")).not.toContain("is not listed");
  });

  it("follows symlinked islands, chunk directories and chunk files", () => {
    const { root } = check(mini());
    const isles = join(root, "world/islands");
    const away = join(root, "elsewhere");
    mkdirSync(away);
    renameSync(join(isles, "mini"), join(away, "mini"));
    symlinkSync(join(away, "mini"), join(isles, "mini"));
    const z07 = join(away, "mini/chunks/z07");
    renameSync(join(z07, "c0000_0000.json"), join(away, "c0000_0000.json"));
    symlinkSync(join(away, "c0000_0000.json"), join(z07, "c0000_0000.json"));
    renameSync(join(away, "mini/chunks/z08"), join(away, "z08"));
    symlinkSync(join(away, "z08"), join(away, "mini/chunks/z08"));
    expect(messages(validateWorld(root, { content }))).toEqual([]);
  });

  it("reports unreadable entries (ELOOP, dangling links) instead of treating them as missing", () => {
    const { root } = check(mini());
    const isle = join(root, "world/islands/mini");
    rmSync(join(isle, "spawns.yaml"));
    symlinkSync("spawns.yaml", join(isle, "spawns.yaml")); // ELOOP
    symlinkSync("nowhere.yaml", join(isle, "texts.yaml")); // dangling
    rmSync(join(isle, "chunks/z08/c0000_0000.json"));
    symlinkSync("c0000_0000.json", join(isle, "chunks/z08/c0000_0000.json"));
    symlinkSync("z09", join(isle, "chunks/z09"));
    const m = messages(validateWorld(root, { content }));
    expect(m).toContainEqual(expect.stringMatching(/mini\/spawns\.yaml cannot read: ELOOP/));
    expect(m).toContainEqual(expect.stringMatching(/mini\/texts\.yaml cannot read: ENOENT/));
    expect(m).toContainEqual(expect.stringMatching(/z08\/c0000_0000\.json cannot read: ELOOP/));
    expect(m).toContainEqual(expect.stringMatching(/chunks\/z09 cannot read: ELOOP/));
    expect(m.join("\n")).not.toContain("expected a");
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports unreadable directories and files (needs non-root)",
    () => {
      const { root } = check(mini());
      const isle = join(root, "world/islands/mini");
      chmodSync(join(isle, "spawns.yaml"), 0o000);
      chmodSync(join(isle, "chunks/z08"), 0o000);
      try {
        const m = messages(validateWorld(root, { content }));
        expect(m).toContainEqual(expect.stringMatching(/spawns\.yaml cannot read file: EACCES/));
        expect(m).toContainEqual(
          expect.stringMatching(/chunks\/z08\/ cannot read directory: EACCES/),
        );
      } finally {
        chmodSync(join(isle, "chunks/z08"), 0o755);
      }
    },
  );

  it("reports world/islands and an island path that are files", () => {
    const { root } = check(mini());
    rmSync(join(root, "world/islands/mini"), { recursive: true });
    writeFileSync(join(root, "world/islands/mini"), "not a directory");
    expect(only(root, "mini")).toContainEqual("error world/islands/mini/ expected a directory");
    rmSync(join(root, "world/islands"), { recursive: true });
    writeFileSync(join(root, "world/islands"), "not a directory");
    expect(messages(validateWorld(root, { content }))).toContainEqual(
      "error world/islands/ expected a directory",
    );
  });

  it("reports 'listed twice' once when the island fails to load", () => {
    const i = mini();
    const meta = worldOf(i);
    meta.islands.push({ ...must(meta.islands[0]) });
    const { root } = check(i, meta);
    writeFileSync(join(root, "world/islands/mini/island.yaml"), "id: [\n");
    const m = messages(validateWorld(root, { content }));
    expect(m.filter((x) => x.includes("listed twice"))).toHaveLength(1);
    expect(m.filter((x) => x.includes("island.yaml") && x.includes("invalid YAML"))).toHaveLength(
      1,
    );
  });
});
