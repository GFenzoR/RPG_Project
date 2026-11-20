// Round-trip tests for the ops added in T1.15: fill, autoborder, scatter, stamp and the
// entity ops. Each one is applied to testisle, undone with its inverse and redone with the
// inverse of the inverse, comparing every chunk and auxiliary file byte for byte.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatChunk } from "../chunk.ts";
import { loadContent } from "../content.ts";
import { loadWorld } from "../io.ts";
import { chunkKey } from "../types.ts";
import type { World } from "../types.ts";
import { formatYaml } from "../yaml.ts";
import { applyOps, borderItems, borderPieces, covers, OpError, seededRandom } from "./index.ts";
import type { BorderSet, MapOp, OpOptions, Prefab } from "./index.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const content = loadContent(repo);

// A small ladder: water, then sand (its fringe sd_*), dirt (dt_*, only over sand), grass
// (gs_*); the surf sf_* goes over fringes on water. Stone floor is off the ladder.
const SET: BorderSet = {
  ladder: [
    { ground: "water_shallow" },
    { ground: "sand", pieces: "sd" },
    { ground: "dirt", pieces: "dt", over: ["sand"] },
    { ground: "grass", pieces: "gs" },
  ],
  shore: { water: ["water_shallow"], pieces: "sf" },
};

const HUT: Prefab = {
  id: "test_hut",
  legend: [
    { char: "#", ground: "wooden_floor", items: ["cargo_crate"] },
    { char: ".", ground: "wooden_floor", items: [] },
    { char: "~", ground: "dock_planks" },
  ],
  rows: ["###", "#.#", " ~ "],
};

const opts: OpOptions = {
  itemKind: (id) => (/^(gs|sd|dt|sf)_/.test(id) ? "decoration" : content.items.get(id)?.kind),
  monsterKnown: (id) => content.monsters.has(id),
  npcKnown: (id) => content.npcs.has(id),
  borders: SET,
  prefab: (id) => (id === HUT.id ? HUT : undefined),
};

function testisle(): World {
  return loadWorld(repo).world;
}

/** testisle without the border pieces of data/borders.yaml, for the test ladder's own. */
function bare(): World {
  const world = testisle();
  for (const isl of world.islands.values())
    for (const c of isl.chunks.values())
      c.items = c.items
        .map((s) => ({ ...s, stack: s.stack.filter((id) => !id.startsWith("border_")) }))
        .filter((s) => s.stack.length > 0);
  return world;
}

/** Every chunk and auxiliary list in canonical bytes. */
function bytes(world: World): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, isl] of world.islands) {
    for (const [k, c] of isl.chunks) out.set(`${id}:${k}`, formatChunk(c));
    for (const aux of ["spawns", "zones", "portals", "npcs", "texts"] as const)
      out.set(`${id}:${aux}`, formatYaml(isl[aux]));
  }
  return out;
}

function roundTrip(world: World, ops: MapOp[]): World {
  const before = bytes(world);
  const { world: edited, inverse } = applyOps(world, ops, opts);
  expect(bytes(world)).toEqual(before); // input untouched
  expect(bytes(edited)).not.toEqual(before);
  const { world: restored, inverse: redo } = applyOps(edited, inverse, opts);
  expect(bytes(restored)).toEqual(before);
  expect(bytes(applyOps(restored, redo, opts).world)).toEqual(bytes(edited));
  return edited;
}

function tile(world: World, x: number, y: number, z = 7) {
  const c = world.islands.get("testisle")?.chunks.get(chunkKey(z, x >> 5, y >> 5));
  return {
    ground: c?.ground[(y % 32) * 32 + (x % 32)] ?? null,
    stack: c?.items.find((s) => s.x === x % 32 && s.y === y % 32)?.stack ?? [],
  };
}

describe("fill", () => {
  it("repaints the contiguous ground and nothing else", () => {
    // The temple square (stone_floor 1053..1059) touches the stone path south of it.
    const w = roundTrip(testisle(), [
      { op: "fill", pos: { x: 1056, y: 1056, z: 7 }, item: "dirt" },
    ]);
    expect(tile(w, 1053, 1053).ground).toBe("dirt");
    expect(tile(w, 1056, 1077).ground).toBe("stone_floor"); // separated by the dirt road
    expect(tile(w, 1052, 1053).ground).toBe("grass");
  });

  it("fills empty tiles inside the island only", () => {
    const w = roundTrip(testisle(), [
      { op: "fill", pos: { x: 1056, y: 1056, z: 8 }, item: "dirt" },
    ]);
    expect(tile(w, 1024, 1024, 8).ground).toBe("dirt");
    expect(tile(w, 1087, 1087, 8).ground).toBe("dirt");
  });

  it("is a no-op on the same ground", () => {
    const r = applyOps(
      testisle(),
      [{ op: "fill", pos: { x: 1056, y: 1056, z: 7 }, item: "stone_floor" }],
      opts,
    );
    expect(r.inverse).toEqual([]);
    expect(r.touched).toEqual([]);
  });

  it("rejects non-ground items", () => {
    expect(() =>
      applyOps(
        testisle(),
        [{ op: "fill", pos: { x: 1056, y: 1056, z: 7 }, item: "cargo_crate" }],
        opts,
      ),
    ).toThrow(OpError);
  });
});

describe("autoborder", () => {
  it("stacks pieces on the lower tiles, under what was there, and undoes byte for byte", () => {
    const area = { x: 1024, y: 1024, w: 64, h: 64 };
    const w = roundTrip(bare(), [{ op: "autoborder", floor: 7, rect: area }]);
    // 1049,1036 is sand with grass to the east (1050 is the first grass of row 1036).
    expect(tile(w, 1048, 1036).stack[0]).toMatch(/^gs_/);
    // Water touching sand gets the sand's fringe over the surf.
    expect(tile(w, 1050, 1031).stack).toEqual(["sf_s", "sd_s"]);
    expect(tile(w, 1048, 1031).stack).toEqual(["sf_se", "sd_se"]);
    // Running it again changes nothing.
    const again = applyOps(w, [{ op: "autoborder", floor: 7, rect: area }], opts);
    expect(again.inverse).toEqual([]);
  });

  it("keeps non-border items above the borders", () => {
    const w = roundTrip(bare(), [
      { op: "paint_ground", floor: 7, rect: { x: 1040, y: 1045, w: 1, h: 1 }, item: "sand" },
      { op: "place_item", pos: { x: 1040, y: 1045, z: 7 }, item: "cargo_crate" },
      { op: "autoborder", floor: 7, rect: { x: 1040, y: 1045, w: 1, h: 1 } },
    ]);
    expect(tile(w, 1040, 1045).stack).toEqual([
      "gs_inner_nw",
      "gs_inner_ne",
      "gs_inner_se",
      "gs_inner_sw",
      "cargo_crate",
    ]);
  });

  it("puts the pieces under a wall too: a thin wall leaves its ground in sight", () => {
    const w = roundTrip(bare(), [
      { op: "paint_ground", floor: 7, rect: { x: 1040, y: 1045, w: 2, h: 1 }, item: "sand" },
      { op: "place_item", pos: { x: 1040, y: 1045, z: 7 }, item: "stone_wall" },
      { op: "autoborder", floor: 7, rect: { x: 1040, y: 1045, w: 2, h: 1 } },
    ]);
    expect(tile(w, 1040, 1045).stack).toEqual(["gs_inner_nw", "gs_inner_sw", "stone_wall"]);
    expect(tile(w, 1041, 1045).stack).toEqual(["gs_inner_ne", "gs_inner_se"]);
  });

  it("removes stale pieces when the ground changed", () => {
    const area = { x: 1040, y: 1040, w: 5, h: 5 };
    const start = applyOps(
      bare(),
      [
        { op: "paint_ground", floor: 7, rect: { x: 1042, y: 1042, w: 1, h: 1 }, item: "sand" },
        { op: "autoborder", floor: 7, rect: area },
      ],
      opts,
    ).world;
    const w = roundTrip(start, [
      { op: "paint_ground", floor: 7, rect: { x: 1042, y: 1042, w: 1, h: 1 }, item: "grass" },
      { op: "autoborder", floor: 7, rect: area },
    ]);
    expect(tile(w, 1042, 1042).stack).toEqual([]);
  });

  it("needs the rules", () => {
    expect(() =>
      applyOps(
        bare(),
        [{ op: "autoborder", floor: 7, rect: { x: 1040, y: 1040, w: 2, h: 2 } }],
        {},
      ),
    ).toThrow(/borders\.yaml/);
  });
});

describe('borderPieces (the ladder, docs/06 "Bordes")', () => {
  const GROUND: Record<string, string> = {
    g: "grass",
    d: "dirt",
    s: "sand",
    w: "water_shallow",
    f: "stone_floor",
  };
  const map = (rows: string[]) => (x: number, y: number) => GROUND[rows[y]?.[x] ?? ""] ?? null;
  /** The pieces of the middle tile of a 3x3 map. */
  const mid = (...rows: string[]): string[] => borderPieces(1, 1, map(rows), SET);

  it("puts a side piece where the higher ground is on that side", () => {
    expect(mid("sgs", "sss", "sss")).toEqual(["gs_n"]);
    expect(mid("sss", "ssg", "sss")).toEqual(["gs_e"]);
    expect(mid("sss", "sss", "sgs")).toEqual(["gs_s"]);
    expect(mid("sss", "gss", "sss")).toEqual(["gs_w"]);
    // A side covers its two corners: the diagonals next to it add nothing.
    expect(mid("ggg", "sss", "sss")).toEqual(["gs_n"]);
    // Two opposite sides are two pieces.
    expect(mid("sgs", "sss", "sgs")).toEqual(["gs_n", "gs_s"]);
  });

  it("puts an outer corner where the higher ground is only on the diagonal", () => {
    expect(mid("gss", "sss", "sss")).toEqual(["gs_nw"]);
    expect(mid("ssg", "sss", "sss")).toEqual(["gs_ne"]);
    expect(mid("sss", "sss", "ssg")).toEqual(["gs_se"]);
    expect(mid("sss", "sss", "gss")).toEqual(["gs_sw"]);
    expect(mid("gsg", "sss", "gsg")).toEqual(["gs_nw", "gs_ne", "gs_se", "gs_sw"]);
    // A side and the far diagonals: the side, then the corners its sides do not cover.
    expect(mid("sgs", "sss", "gsg")).toEqual(["gs_n", "gs_se", "gs_sw"]);
  });

  it("puts an inner corner where the higher ground is on two adjacent sides", () => {
    expect(mid("sgs", "gss", "sss")).toEqual(["gs_inner_nw"]);
    expect(mid("sgs", "ssg", "sss")).toEqual(["gs_inner_ne"]);
    expect(mid("sss", "ssg", "sgs")).toEqual(["gs_inner_se"]);
    expect(mid("sss", "gss", "sgs")).toEqual(["gs_inner_sw"]);
    // Three sides: two inner corners share the middle side.
    expect(mid("sgs", "gsg", "sss")).toEqual(["gs_inner_nw", "gs_inner_ne"]);
    // A lone tile: the four inner corners.
    expect(mid("sgs", "gsg", "sgs")).toEqual([
      "gs_inner_nw",
      "gs_inner_ne",
      "gs_inner_se",
      "gs_inner_sw",
    ]);
  });

  it("stacks the fringes bottom to top by the ladder, one ground at a time", () => {
    // Sand with dirt to the west and grass to the north: dirt first, grass over it, and the
    // grass in the far corner is its own small corner.
    expect(mid("sgs", "dss", "ssg")).toEqual(["dt_w", "gs_n", "gs_se"]);
    // Grass covers dirt; dirt never covers grass, nor itself.
    expect(mid("sgs", "ddd", "sss")).toEqual(["gs_n"]);
    expect(mid("ddd", "dgd", "ddd")).toEqual([]);
    expect(mid("ddd", "ddd", "ddd")).toEqual([]);
    // Grass to the north and dirt to the south: the dirt's fringe first, the grass's on top.
    expect(mid("ggs", "sss", "dds")).toEqual(["dt_s", "gs_n"]);
  });

  it("honours `over`: dirt's fringe goes on sand, not on water", () => {
    expect(covers(SET, "dirt", "sand")).toBe(true);
    expect(covers(SET, "dirt", "water_shallow")).toBe(false);
    expect(covers(SET, "grass", "water_shallow")).toBe(true);
    expect(covers(SET, "sand", "grass")).toBe(false);
    expect(borderPieces(1, 1, map(["wdw", "www", "www"]), SET)).toEqual([]);
  });

  it("leaves grounds off the ladder straight, both ways", () => {
    expect(borderPieces(1, 1, map(["fgf", "fff", "fff"]), SET)).toEqual([]);
    expect(mid("sfs", "sss", "sss")).toEqual([]);
    expect(covers(SET, "grass", "stone_floor")).toBe(false);
    // No ground (outside the map) is nothing either.
    expect(borderPieces(5, 5, map(["s"]), SET)).toEqual([]);
  });

  it("puts the surf under the fringes on water, one of each fringe's shape", () => {
    const water = (...rows: string[]) => borderPieces(1, 1, map(rows), SET);
    expect(water("wsw", "www", "www")).toEqual(["sf_n", "sd_n"]);
    expect(water("sss", "sww", "www")).toEqual(["sf_inner_nw", "sd_inner_nw"]);
    // Sand north, grass west: the surf of a north side and of a west side, under the two
    // fringes (each hides the other's surf on its land), not an inner corner neither draws.
    expect(water("wsw", "gww", "www")).toEqual(["sf_n", "sf_w", "sd_n", "gs_w"]);
    // Sand north, a grass corner north-east: the corner's bulge past the sand gets its surf.
    expect(water("wsg", "www", "www")).toEqual(["sf_n", "sf_ne", "sd_n", "gs_ne"]);
    // Dirt does not cover water: no fringe and no surf.
    expect(water("wdw", "www", "www")).toEqual([]);
    // Open water: nothing.
    expect(water("www", "www", "www")).toEqual([]);
  });

  it("lists every piece item of the set, fringes and surf", () => {
    const items = borderItems(SET);
    expect(items.size).toBe(4 * 12);
    for (const id of ["sd_n", "dt_inner_se", "gs_sw", "sf_inner_nw"])
      expect(items.has(id)).toBe(true);
    expect(borderItems({ ladder: [{ ground: "sand" }] }).size).toBe(0);
  });
});

describe("scatter", () => {
  const op: MapOp = {
    op: "scatter",
    floor: 7,
    rect: { x: 1030, y: 1036, w: 48, h: 40 },
    items: ["cargo_crate", "mooring_post"],
    density: 0.1,
    seed: 42,
    on_ground: ["grass"],
  };
  it("is reproducible and only decorates empty tiles of the listed grounds", () => {
    const orig = testisle();
    const a = roundTrip(orig, [op]);
    const b = applyOps(testisle(), [op], opts).world;
    expect(bytes(a)).toEqual(bytes(b));
    let placed = 0;
    for (let y = 1036; y < 1076; y++)
      for (let x = 1030; x < 1078; x++) {
        const t = tile(a, x, y);
        const o = tile(orig, x, y);
        if (t.stack.length !== o.stack.length) {
          placed++;
          expect(t.ground).toBe("grass");
          expect(o.stack).toEqual([]);
        }
      }
    expect(placed).toBeGreaterThan(50);
    expect(placed).toBeLessThan(250);
  });
  it("changes with the seed", () => {
    const a = applyOps(testisle(), [op], opts).world;
    const b = applyOps(testisle(), [{ ...op, seed: 43 }], opts).world;
    expect(bytes(a)).not.toEqual(bytes(b));
  });
  it("rejects a bad density", () => {
    expect(() => applyOps(testisle(), [{ ...op, density: 2 } as MapOp], opts)).toThrow(/density/);
  });
  it("uses a stable generator", () => {
    const r = seededRandom(1);
    expect([r(), r(), r()].map((v) => v.toFixed(6))).toEqual(["0.627074", "0.002736", "0.527447"]);
  });
});

describe("stamp", () => {
  it("paints the legend, replaces stacks where told and leaves spaces alone", () => {
    const w = roundTrip(testisle(), [
      { op: "stamp", pos: { x: 1040, y: 1045, z: 7 }, prefab: "test_hut" },
    ]);
    expect(tile(w, 1040, 1045)).toEqual({ ground: "wooden_floor", stack: ["cargo_crate"] });
    expect(tile(w, 1041, 1046)).toEqual({ ground: "wooden_floor", stack: [] });
    expect(tile(w, 1041, 1047).ground).toBe("dock_planks");
    expect(tile(w, 1040, 1047).ground).toBe("grass");
  });
  it("clears what was under a tile with items", () => {
    const start = applyOps(
      testisle(),
      [{ op: "place_item", pos: { x: 1041, y: 1046, z: 7 }, item: "mooring_post" }],
      opts,
    ).world;
    const w = roundTrip(start, [
      { op: "stamp", pos: { x: 1040, y: 1045, z: 7 }, prefab: "test_hut" },
    ]);
    expect(tile(w, 1041, 1046).stack).toEqual([]);
  });
  it("rejects unknown prefabs and prefabs that leave the island", () => {
    expect(() =>
      applyOps(
        testisle(),
        [{ op: "stamp", pos: { x: 1040, y: 1045, z: 7 }, prefab: "nope" }],
        opts,
      ),
    ).toThrow(/unknown prefab/);
    expect(() =>
      applyOps(
        testisle(),
        [{ op: "stamp", pos: { x: 1086, y: 1086, z: 7 }, prefab: "test_hut" }],
        opts,
      ),
    ).toThrow(/not inside any island/);
  });
});

describe("entity ops", () => {
  it("adds and removes spawns, restoring the list order", () => {
    const w = roundTrip(testisle(), [
      {
        op: "add_spawn",
        id: "testisle_boars",
        center: { x: 1045, y: 1066, z: 7 },
        radius: 3,
        monsters: [{ monster: "bristleback_boar", count: 2 }],
        respawn_seconds: 90,
        notes: "test",
        index: 1,
      },
    ]);
    expect(w.islands.get("testisle")?.spawns.map((s) => s.id)).toEqual([
      "testisle_wolves",
      "testisle_boars",
      "testisle_crabs",
      "testisle_cave_rats",
    ]);
    const removed = roundTrip(testisle(), [{ op: "remove_spawn", id: "testisle_crabs" }]);
    expect(removed.islands.get("testisle")?.spawns.map((s) => s.id)).toEqual([
      "testisle_wolves",
      "testisle_cave_rats",
    ]);
  });

  it("rejects duplicate IDs and unknown monsters", () => {
    const base = {
      op: "add_spawn" as const,
      center: { x: 1045, y: 1066, z: 7 },
      radius: 3,
      monsters: [{ monster: "wolf", count: 1 }],
      respawn_seconds: 60,
    };
    expect(() => applyOps(testisle(), [{ ...base, id: "testisle_wolves" }], opts)).toThrow(
      /already exists/,
    );
    expect(() =>
      applyOps(
        testisle(),
        [{ ...base, id: "x", monsters: [{ monster: "dragon", count: 1 }] }],
        opts,
      ),
    ).toThrow(/unknown monster/);
  });

  it("adds and removes zones inside one island", () => {
    roundTrip(testisle(), [
      {
        op: "add_zone",
        id: "testisle_plot",
        type: "community_plot",
        floors: [7, 8],
        rects: [{ x: 1030, y: 1030, w: 10, h: 10 }],
      },
    ]);
    roundTrip(testisle(), [{ op: "remove_zone", id: "testisle_dock" }]);
    expect(() =>
      applyOps(
        testisle(),
        [
          {
            op: "add_zone",
            id: "z",
            type: "protection",
            floors: [7],
            rects: [{ x: 1080, y: 1080, w: 20, h: 4 }],
          },
        ],
        opts,
      ),
    ).toThrow(/not inside island/);
    expect(() =>
      applyOps(
        testisle(),
        [
          {
            op: "add_zone",
            id: "z",
            type: "nope" as "pvp",
            floors: [7],
            rects: [{ x: 1030, y: 1030, w: 2, h: 2 }],
          },
        ],
        opts,
      ),
    ).toThrow(/zone type/);
  });

  it("adds and removes portals", () => {
    roundTrip(testisle(), [
      {
        op: "add_portal",
        id: "testisle_hole",
        kind: "hole",
        from: { x: 1050, y: 1050, z: 7 },
        to: { x: 1050, y: 1050, z: 8 },
      },
    ]);
    roundTrip(testisle(), [{ op: "remove_portal", id: "testisle_cave_down" }]);
  });

  it("places an NPC once and removes it by ID", () => {
    expect(() =>
      applyOps(
        testisle(),
        [{ op: "place_npc", npc: "harbor_master", pos: { x: 1050, y: 1050, z: 7 } }],
        opts,
      ),
    ).toThrow(/already placed/);
    const moved = roundTrip(testisle(), [
      { op: "remove_npc", npc: "harbor_master", pos: { x: 3201, y: 6433, z: 7 } },
      { op: "place_npc", npc: "harbor_master", pos: { x: 1050, y: 1050, z: 7 } },
    ]);
    expect(moved.islands.get("testisle")?.npcs.at(-1)).toEqual({
      npc: "harbor_master",
      pos: { x: 1050, y: 1050, z: 7 },
    });
    expect(() =>
      applyOps(
        testisle(),
        [{ op: "remove_npc", npc: "harbor_master", pos: { x: 1, y: 1, z: 7 } }],
        opts,
      ),
    ).toThrow(/not at/);
    expect(() =>
      applyOps(
        testisle(),
        [
          { op: "remove_npc", npc: "harbor_master" },
          { op: "place_npc", npc: "ghost", pos: { x: 1050, y: 1050, z: 7 } },
        ],
        opts,
      ),
    ).toThrow(/op 1: unknown NPC/);
  });

  it("adds and removes signs and books, ids unique in the world", () => {
    const added = roundTrip(testisle(), [
      {
        op: "add_text",
        id: "testisle_beach_book",
        kind: "book",
        pos: { x: 1050, y: 1050, z: 7 },
        text: "text.testisle.temple_sign",
        notes: "a book on the beach",
      },
    ]);
    expect(added.islands.get("testisle")?.texts.at(-1)).toEqual({
      id: "testisle_beach_book",
      pos: { x: 1050, y: 1050, z: 7 },
      kind: "book",
      text: "text.testisle.temple_sign",
      notes: "a book on the beach",
    });
    // Removing a sign and undoing puts it back in its place, byte for byte: the only one of
    // testisle and one from the middle of Puerto's list.
    roundTrip(testisle(), [{ op: "remove_text", id: "testisle_temple_sign" }]);
    const harbour = roundTrip(testisle(), [{ op: "remove_text", id: "puerto_harbour_sign" }]);
    expect(harbour.islands.get("puerto")?.texts.map((t) => t.id)).toEqual([
      "puerto_temple_sign",
      "puerto_mine_sign",
    ]);
    const r = applyOps(testisle(), [{ op: "remove_text", id: "testisle_temple_sign" }], opts);
    expect(r.touchedAux).toEqual([{ island: "testisle", file: "texts" }]);
    const sign = (over: object): MapOp =>
      ({
        op: "add_text",
        id: "testisle_new_sign",
        kind: "sign",
        pos: { x: 1050, y: 1050, z: 7 },
        text: "text.testisle.temple_sign",
        ...over,
      }) as MapOp;
    const fails = (op: MapOp, why: RegExp): void => {
      expect(() => applyOps(testisle(), [op], opts)).toThrow(why);
    };
    fails(sign({ id: "testisle_temple_sign" }), /already exists in island "testisle"/);
    fails(sign({ id: "puerto_temple_sign" }), /already exists in island "puerto"/);
    fails(sign({ kind: "scroll" }), /kind must be one of sign, book/);
    fails(sign({ text: "" }), /i18n key/);
    fails(sign({ pos: { x: 1, y: 1, z: 7 } }), /not inside any island/);
    fails({ op: "remove_text", id: "nope" }, /no text "nope"/);
  });

  it("reports the aux files it touched", () => {
    const r = applyOps(testisle(), [{ op: "remove_zone", id: "testisle_dock" }], opts);
    expect(r.touchedAux).toEqual([{ island: "testisle", file: "zones" }]);
    expect(r.touched).toEqual([]);
  });
});

describe("atomicity across op kinds", () => {
  it("applies nothing when a later op fails", () => {
    const w = testisle();
    const before = bytes(w);
    expect(() =>
      applyOps(
        w,
        [
          { op: "fill", pos: { x: 1056, y: 1056, z: 7 }, item: "dirt" },
          { op: "remove_spawn", id: "testisle_wolves" },
          { op: "remove_spawn", id: "missing" },
        ],
        opts,
      ),
    ).toThrow(/op 2: no spawn/);
    expect(bytes(w)).toEqual(before);
  });
});
