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
import { applyOps, borderPieces, OpError, seededRandom } from "./index.ts";
import type { BorderRule, MapOp, OpOptions, Prefab } from "./index.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const content = loadContent(repo);

const RULES: BorderRule[] = [
  {
    id: "test_grass_sand",
    from: "grass",
    to: "sand",
    pieces: {
      n: "gs_n",
      s: "gs_s",
      e: "gs_e",
      w: "gs_w",
      ne: "gs_ne",
      nw: "gs_nw",
      se: "gs_se",
      sw: "gs_sw",
    },
  },
  {
    id: "test_sand_water",
    from: "sand",
    to: "water_shallow",
    priority: -1,
    pieces: {
      n: "sw_n",
      s: "sw_s",
      e: "sw_e",
      w: "sw_w",
      ne: "sw_ne",
      nw: "sw_nw",
      se: "sw_se",
      sw: "sw_sw",
      inner_ne: "sw_inner_ne",
    },
  },
];

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
  itemKind: (id) => (/^(gs|sw)_/.test(id) ? "decoration" : content.items.get(id)?.kind),
  monsterKnown: (id) => content.monsters.has(id),
  npcKnown: (id) => content.npcs.has(id),
  borders: RULES,
  prefab: (id) => (id === HUT.id ? HUT : undefined),
};

function testisle(): World {
  return loadWorld(repo).world;
}

/** Every chunk and auxiliary list in canonical bytes. */
function bytes(world: World): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, isl] of world.islands) {
    for (const [k, c] of isl.chunks) out.set(`${id}:${k}`, formatChunk(c));
    for (const aux of ["spawns", "zones", "portals", "npcs"] as const)
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
  it("stacks pieces on the 'to' tiles, under what was there, and undoes byte for byte", () => {
    const area = { x: 1024, y: 1024, w: 64, h: 64 };
    const w = roundTrip(testisle(), [{ op: "autoborder", floor: 7, rect: area }]);
    // 1049,1036 is sand with grass to the east (1050 is the first grass of row 1036).
    expect(tile(w, 1048, 1036).stack[0]).toMatch(/^gs_/);
    // Water touching sand gets sand_water pieces; priority -1 puts them below any other.
    expect(tile(w, 1050, 1031).stack).toEqual(["sw_s"]);
    expect(tile(w, 1048, 1031).stack).toEqual(["sw_se"]);
    // Running it again changes nothing.
    const again = applyOps(w, [{ op: "autoborder", floor: 7, rect: area }], opts);
    expect(again.inverse).toEqual([]);
  });

  it("keeps non-border items above the borders", () => {
    const w = roundTrip(testisle(), [
      { op: "paint_ground", floor: 7, rect: { x: 1040, y: 1045, w: 1, h: 1 }, item: "sand" },
      { op: "place_item", pos: { x: 1040, y: 1045, z: 7 }, item: "cargo_crate" },
      { op: "autoborder", floor: 7, rect: { x: 1040, y: 1045, w: 1, h: 1 } },
    ]);
    expect(tile(w, 1040, 1045).stack).toEqual(["gs_n", "gs_e", "gs_s", "gs_w", "cargo_crate"]);
  });

  it("removes stale pieces when the ground changed", () => {
    const area = { x: 1040, y: 1040, w: 5, h: 5 };
    const start = applyOps(
      testisle(),
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
        testisle(),
        [{ op: "autoborder", floor: 7, rect: { x: 1040, y: 1040, w: 2, h: 2 } }],
        {},
      ),
    ).toThrow(/borders\.yaml/);
  });
});

describe("borderPieces", () => {
  const map = (rows: string[]) => (x: number, y: number) => {
    const ch = rows[y]?.[x];
    return ch === "g" ? "grass" : ch === "s" ? "sand" : ch === "w" ? "water_shallow" : null;
  };
  const rules = [RULES[0] as BorderRule];
  it("uses sides, diagonal corners and both sides when there is no inner piece", () => {
    const m = map(["gss", "sss", "ssg"]);
    expect(borderPieces(1, 1, m, rules)).toEqual(["gs_nw", "gs_se"]);
    expect(borderPieces(0, 1, m, rules)).toEqual(["gs_n"]);
    const l = map(["gg", "gs"]);
    expect(borderPieces(1, 1, l, rules)).toEqual(["gs_n", "gs_w"]);
  });
  it("uses the inner piece when the rule has one", () => {
    const l = map(["ss", "ws"]);
    // water at 0,1 with sand n (0,0) and e (1,1) → inner_ne
    expect(borderPieces(0, 1, l, [RULES[1] as BorderRule])).toEqual(["sw_inner_ne"]);
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
      { op: "remove_npc", npc: "harbor_master", pos: { x: 1056, y: 1082, z: 7 } },
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
