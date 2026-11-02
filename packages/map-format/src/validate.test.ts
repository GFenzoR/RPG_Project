import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pushItem, setGround } from "./chunk.ts";
import { loadContent } from "./content.ts";
import { formatDiagnostic } from "./diagnostics.ts";
import { writeIsland, writeWorldMeta } from "./io.ts";
import { chunkKey, emptyChunk } from "./types.ts";
import type { Island, WorldMeta } from "./types.ts";
import { validateWorld } from "./validate.ts";

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("fixture value missing");
  return v;
}

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const content = loadContent(repo);
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
    boat_routes: [],
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
    b.meta.rect = { x: 16, y: 0, w: 32, h: 32 };
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
      expect.stringContaining('i18n key "island.nowhere.name" is missing in: en, es'),
    );
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
