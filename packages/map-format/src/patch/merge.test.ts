import { describe, expect, it } from "vitest";
import { applyOps } from "../ops/apply.ts";
import { formatChunk } from "../chunk.ts";
import { formatYaml } from "../yaml.ts";
import { chunkKey, emptyChunk } from "../types.ts";
import type { Chunk, Island, Spawn, World } from "../types.ts";
import { chunkSyncOps, diffWorlds, listSyncOps, mergeChunk, mergeList } from "./merge.ts";
import { PatchError, mergePatchFile, parsePatch, patchHash, patchPath } from "./patch.ts";

const AT = { z: 7, cx: 0, cy: 0 };

/** Chunk 0/0/7 with grass everywhere plus the given tile overrides. */
function chunk(tiles: Record<string, { g?: string | null; s?: string[] }> = {}): Chunk {
  const c = emptyChunk(0, 0, 7);
  c.ground.fill("grass");
  for (const [k, t] of Object.entries(tiles)) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    if (t.g !== undefined) c.ground[y * 32 + x] = t.g;
    if (t.s) c.items.push({ x, y, stack: t.s });
  }
  c.items.sort((a, b) => a.y - b.y || a.x - b.x);
  return c;
}

const spawn = (id: string, radius = 2, x = 5): Spawn => ({
  id,
  center: { x, y: 5, z: 7 },
  radius,
  monsters: [{ monster: "wolf", count: 2 }],
  respawn_seconds: 60,
});

describe("mergeChunk", () => {
  it("takes each tile from the side that changed it", () => {
    const base = chunk();
    const ours = chunk({ "1,1": { g: "sand" } });
    const theirs = chunk({ "2,2": { s: ["oak_tree"] } });
    const m = mergeChunk(base, ours, theirs, AT);
    expect(m.conflicts).toEqual([]);
    expect(m.result).toEqual(chunk({ "1,1": { g: "sand" }, "2,2": { s: ["oak_tree"] } }));
  });

  it("reports tiles changed differently on both sides and keeps ours there", () => {
    const base = chunk();
    const ours = chunk({ "3,4": { g: "sand" }, "9,9": { s: ["rock"] } });
    const theirs = chunk({ "3,4": { g: "water" }, "9,9": { s: ["rock"] } });
    const m = mergeChunk(base, ours, theirs, { z: 7, cx: 2, cy: 1 });
    expect(m.conflicts).toEqual([{ kind: "tile", x: 67, y: 36, z: 7 }]);
    expect(m.result?.ground[4 * 32 + 3]).toBe("sand");
  });

  it("treats a missing chunk as empty: creation, removal and remove-vs-edit", () => {
    const created = mergeChunk(undefined, undefined, chunk(), AT);
    expect(created).toEqual({ result: chunk(), conflicts: [] });
    // Removed by the patch, untouched here → removed.
    expect(mergeChunk(chunk(), chunk(), undefined, AT).result).toBeUndefined();
    // Removed by the patch, edited here → only the edited tile conflicts.
    const m = mergeChunk(chunk(), chunk({ "0,0": { g: "sand" } }), undefined, AT);
    expect(m.conflicts).toEqual([{ kind: "tile", x: 0, y: 0, z: 7 }]);
    // Both created the same chunk differently: tiles merge against an empty base.
    const both = mergeChunk(undefined, chunk(), chunk({ "5,5": { s: ["rock"] } }), AT);
    expect(both.conflicts).toHaveLength(1);
  });
});

describe("mergeList", () => {
  it("merges by id: one-sided changes, additions and removals", () => {
    const base = [spawn("a"), spawn("b"), spawn("c")];
    const ours = [spawn("a", 3), spawn("b"), spawn("d")]; // edit a, remove c, add d
    const theirs = [spawn("a"), spawn("b", 5), spawn("c"), spawn("e")]; // edit b, add e
    const m = mergeList(base, ours, theirs);
    expect(m.conflicts).toEqual([]);
    expect(m.result).toEqual([spawn("a", 3), spawn("b", 5), spawn("d"), spawn("e")]);
  });

  it("reports entries changed on both sides, and removed on one but changed on the other", () => {
    const base = [spawn("a"), spawn("b")];
    const ours = [spawn("a", 3)];
    const theirs = [spawn("a", 4), spawn("b", 9)];
    const m = mergeList(base, ours, theirs);
    expect(m.conflicts).toEqual([
      { kind: "entry", key: "a" },
      { kind: "entry", key: "b" },
    ]);
    expect(m.result).toEqual([spawn("a", 3)]);
  });

  it("refuses lists with repeated keys", () => {
    const m = mergeList([spawn("a")], [spawn("a", 7)], [spawn("a"), spawn("a", 3)]);
    expect(m.conflicts[0]?.kind).toBe("file");
  });

  it("keys NPC placements by npc", () => {
    const n = (npc: string, x: number) => ({ npc, pos: { x, y: 1, z: 7 } });
    const m = mergeList([n("bob", 1)], [n("bob", 1), n("ann", 2)], [n("bob", 3)]);
    expect(m).toEqual({ result: [n("bob", 3), n("ann", 2)], conflicts: [] });
  });
});

describe("mergePatchFile", () => {
  const SP = "world/islands/isla/spawns.yaml";
  const CH = "world/islands/isla/chunks/z07/c0000_0000.json";

  it("merges chunk texts by tile and lists by entry", () => {
    const m = mergePatchFile(
      CH,
      formatChunk(chunk()),
      formatChunk(chunk({ "1,1": { g: "sand" } })),
      formatChunk(chunk({ "2,2": { g: "water" } })),
    );
    expect(m).toEqual({
      text: formatChunk(chunk({ "1,1": { g: "sand" }, "2,2": { g: "water" } })),
      conflicts: [],
    });
    const l = mergePatchFile(
      SP,
      formatYaml([spawn("a")]),
      formatYaml([spawn("a"), spawn("b")]),
      null, // the patch removes the file (its only entry)
    );
    expect(l).toEqual({ text: formatYaml([spawn("b")]), conflicts: [] });
  });

  it("conflicts whole files it cannot merge, or when the base is unknown", () => {
    expect(mergePatchFile(SP, undefined, "a: 1\n", "a: 2\n").conflicts[0]?.kind).toBe("file");
    const isl = "world/islands/isla/island.yaml";
    expect(mergePatchFile(isl, "x\n", "y\n", "z\n").conflicts).toEqual([
      { kind: "file", reason: "the file changed on both sides" },
    ]);
  });
});

describe("parsePatch", () => {
  const ok = formatChunk(chunk());
  const CH = "world/islands/isla/chunks/z07/c0000_0000.json";
  const patch = (files: unknown[], extra: object = {}) =>
    JSON.stringify({ format: 2, kind: "rpg-map-patch", base_ref: "HEAD", files, ...extra });

  it("accepts a valid patch (format 1 and 2)", () => {
    const p = parsePatch(patch([{ path: CH, base: patchHash(ok), base_text: ok, content: ok }]));
    expect(p.files[0]?.base_text).toBe(ok);
    expect(
      parsePatch(patch([{ path: CH, base: patchHash(ok), content: ok }], { format: 1 })).format,
    ).toBe(1);
  });

  it.each([
    "../etc/passwd",
    "/etc/passwd",
    "world/../data/items/x.yaml",
    "data/monsters/wolf.yaml",
    "world/islands/isla/../../../x.json",
    "world/islands/Isla/spawns.yaml",
    "world/islands/isla/chunks/z07/../c0000_0000.json",
    "world/islands/isla/chunks/z99/c0000_0000.json",
    "world/islands/isla/secrets.yaml",
    "world\\islands\\isla\\spawns.yaml",
    "world/islands/isla/spawns.yaml\u0000.json",
    "world/patches/x.rpgpatch.json",
    "world/islands/isla/chunks/z07/c0000_0000.json/",
  ])("rejects the path %j", (path) => {
    expect(patchPath(path)).toBeUndefined();
    expect(() => parsePatch(patch([{ path, base: null, content: ok }]))).toThrow(PatchError);
  });

  it("rejects bad content, mismatched coordinates, hashes and refs", () => {
    const other = formatChunk({ ...chunk(), cx: 1 });
    const bad = [
      patch([{ path: CH, base: null, content: "{" }]),
      patch([{ path: CH, base: null, content: other }]),
      patch([{ path: CH, base: patchHash(ok), base_text: other, content: ok }]),
      patch([{ path: CH, base: patchHash(ok), content: ok }]), // format 2 without base_text
      patch([{ path: CH, base: null, content: null }]),
      patch([{ path: "world/islands/isla/spawns.yaml", base: null, content: "- {id: 1}\n" }]),
      patch([], { base_ref: "--output=/tmp/x" }),
      patch([
        { path: CH, base: null, content: ok },
        { path: CH, base: null, content: ok },
      ]),
      "x".repeat((32 << 20) + 1),
    ];
    for (const text of bad) expect(() => parsePatch(text)).toThrow(PatchError);
  });
});

describe("diffWorlds and sync ops", () => {
  const island = (chunks: Chunk[], spawns: Spawn[]): Island => ({
    meta: {
      id: "isla",
      name: "island.isla.name",
      rect: { x: 0, y: 0, w: 64, h: 64 },
      floors: [7],
      temple: { x: 1, y: 1, z: 7 },
      level_hint: [1, 5],
    },
    chunks: new Map(chunks.map((c) => [chunkKey(c.z, c.cx, c.cy), c])),
    spawns,
    npcs: [],
    zones: [],
    portals: [],
    texts: [],
  });
  const world = (isl: Island): World => ({
    meta: { format: 1, islands: [], boat_routes: [] },
    islands: new Map([["isla", isl]]),
  });

  it("turns the current world into the target with ops, and lists the differences", () => {
    const before = world(island([chunk({ "1,1": { s: ["rock"] } })], [spawn("a"), spawn("b")]));
    const target = island(
      [chunk({ "1,1": { g: null }, "2,3": { g: "sand", s: ["oak_tree", "rock"] } })],
      [spawn("c"), spawn("a", 4)],
    );
    const cur = before.islands.get("isla") as Island;
    const ops = [
      ...chunkSyncOps(cur, cur.chunks.get("7/0/0"), target.chunks.get("7/0/0"), AT),
      ...listSyncOps(cur, "spawns", cur.spawns, target.spawns),
    ];
    const after = applyOps(before, ops).world;
    const got = after.islands.get("isla") as Island;
    expect(got.chunks.get("7/0/0")).toEqual(target.chunks.get("7/0/0"));
    expect(got.spawns).toEqual(target.spawns);

    const d = diffWorlds(before, after);
    expect(d.chunks).toEqual([
      expect.objectContaining({
        island: "isla",
        tiles: [
          { x: 1, y: 1 },
          { x: 2, y: 3 },
        ],
        bbox: { x: 1, y: 1, w: 2, h: 3 },
      }),
    ]);
    expect(d.lists).toEqual([
      { island: "isla", list: "spawns", added: ["c"], removed: ["b"], changed: ["a"] },
    ]);
    expect(diffWorlds(after, after)).toEqual({ chunks: [], lists: [] });
  });

  it("refuses tiles outside the island", () => {
    const isl = island([], []);
    const far = { ...chunk(), cx: 5 };
    expect(() => chunkSyncOps(isl, undefined, far, { z: 7, cx: 5, cy: 0 })).toThrow(/outside/);
  });
});
