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
import type { ContentIndex } from "./content.ts";
import type { Chunk, Island, Position, WorldMeta } from "./types.ts";
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
    houses: [],
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

  it("accepts a house and checks its rules (T5.4)", () => {
    const house = () => ({
      id: "puerto_house_net",
      name: "house.puerto_house_net.name",
      rent: 100,
      rects: [{ x: 20, y: 5, z: 7, w: 3, h: 2 }],
      doors: [{ x: 21, y: 6, z: 7 }],
      exit: { x: 21, y: 7, z: 7 },
    });
    const ok = mini();
    ok.houses = [house()];
    expect(messages(check(ok))).toEqual([]);

    const bad = mini();
    bad.houses = [
      { ...house(), doors: [{ x: 10, y: 20, z: 7 }], exit: { x: 21, y: 6, z: 7 } },
      {
        ...house(),
        id: "puerto_house_oar",
        name: "house.missing.name",
        exit: { x: 25, y: 25, z: 7 },
      },
    ];
    bad.npcs = [{ npc: "harbor_master", pos: { x: 21, y: 5, z: 7 } }];
    bad.zones.push({
      id: "mini_nl",
      type: "no_logout",
      floors: [7],
      rects: [{ x: 20, y: 5, w: 1, h: 1 }],
    });
    const m = messages(check(bad));
    expect(m).toContainEqual(expect.stringContaining("door is not a tile of the house"));
    expect(m).toContainEqual(expect.stringContaining('shares tiles with house "puerto_house_net"'));
    expect(m).toContainEqual(
      expect.stringContaining('house exit is inside house "puerto_house_net"'),
    );
    expect(m).toContainEqual(expect.stringContaining("house exit must be next to a door"));
    expect(m).toContainEqual(
      expect.stringContaining("a house's name key is house.puerto_house_oar.name"),
    );
    expect(m).toContainEqual(expect.stringContaining('NPC is inside house "puerto_house_net"'));
    expect(m).toContainEqual(expect.stringContaining('no_logout zone "mini_nl" covers a house'));

    // An open door item on the house door would take its use (docs/02 "Puertas con llave").
    const door = mini();
    door.houses = [house()];
    pushItem(must(door.chunks.get(chunkKey(7, 0, 0))), 21, 6, "forge_gate_open");
    expect(messages(check(door))).toContainEqual(
      expect.stringContaining("a house door cannot hold a door item"),
    );
  });

  it("keeps a sign item and its texts.yaml sign saying the same text (T5.5)", () => {
    const signAt = { x: 20, y: 24, z: 7 };
    const sign = (text: string) => ({ id: "mini_sign", kind: "sign" as const, pos: signAt, text });
    const withItem = (): Island => {
      const i = mini();
      pushItem(must(i.chunks.get(chunkKey(7, 0, 0))), signAt.x, signAt.y, "brasal_temple_sign");
      return i;
    };

    // The item and the text agree: fine. A sign text alone (no item yet) is fine too.
    const ok = withItem();
    ok.texts = [sign("text.volcan.temple_sign")];
    expect(messages(check(ok))).toEqual([]);
    const textOnly = mini();
    textOnly.texts = [sign("text.volcan.temple_sign")];
    expect(messages(check(textOnly))).toEqual([]);

    // A sign item with no sign text on its tile.
    expect(messages(check(withItem()))).toEqual([
      expect.stringMatching(
        /sign item "brasal_temple_sign" says text\.volcan\.temple_sign, but \S*mini\/texts\.yaml has no sign with that text at 20,24,7/,
      ),
    ]);

    // The text on the tile says something else: both sides are reported.
    const other = withItem();
    other.texts = [sign("text.volcan.dock_sign")];
    const m = messages(check(other));
    expect(m).toHaveLength(2);
    expect(m).toContainEqual(
      expect.stringContaining(
        'sign "mini_sign" says text.volcan.dock_sign, but its sign item "brasal_temple_sign" says text.volcan.temple_sign',
      ),
    );
    expect(m).toContainEqual(expect.stringContaining('sign item "brasal_temple_sign" says'));
  });

  it("rejects a house id used twice in the world (T5.4)", () => {
    const i = mini();
    const h = {
      id: "puerto_house_net",
      name: "house.puerto_house_net.name",
      rent: 100,
      rects: [{ x: 20, y: 5, z: 7, w: 1, h: 1 }],
      doors: [{ x: 20, y: 5, z: 7 }],
      exit: { x: 20, y: 6, z: 7 },
    };
    i.houses = [
      h,
      {
        ...h,
        rects: [{ x: 24, y: 5, z: 7, w: 1, h: 1 }],
        doors: [{ x: 24, y: 5, z: 7 }],
        exit: { x: 24, y: 6, z: 7 },
      },
    ];
    expect(messages(check(i))).toContainEqual(
      expect.stringContaining('house "puerto_house_net" is already defined'),
    );
  });

  it("rejects two rects of one house on the same tile (T5.4)", () => {
    const i = mini();
    i.houses = [
      {
        id: "puerto_house_net",
        name: "house.puerto_house_net.name",
        rent: 100,
        rects: [
          { x: 20, y: 5, z: 7, w: 3, h: 2 },
          { x: 21, y: 6, z: 7, w: 1, h: 2 },
        ],
        doors: [{ x: 21, y: 7, z: 7 }],
        exit: { x: 21, y: 8, z: 7 },
      },
    ];
    expect(messages(check(i))).toContainEqual(
      expect.stringContaining('house rectangle shares tiles with house "puerto_house_net"'),
    );
  });

  it("wants doors on the edge of the house and warns about split houses", () => {
    const i = mini();
    i.houses = [
      {
        id: "puerto_house_net",
        name: "house.puerto_house_net.name",
        rent: 100,
        rects: [
          { x: 20, y: 5, z: 7, w: 3, h: 3 },
          { x: 24, y: 5, z: 7, w: 1, h: 1 },
        ],
        doors: [{ x: 21, y: 6, z: 7 }],
        exit: { x: 21, y: 8, z: 7 },
      },
    ];
    const r = check(i);
    expect(messages(r)).toContainEqual(
      expect.stringContaining("door must be on the edge of the house"),
    );
    const split = r.diagnostics.find((d) => d.message.includes("not one connected area"));
    expect(split?.severity).toBe("warning");
    expect(split?.message).toBe("house tiles on floor 7 are not one connected area");
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

  it("allows one portal per tile, never to its own tile", () => {
    const i = mini();
    i.portals.push({
      id: "mini_twin",
      from: { x: 10, y: 10, z: 7 },
      to: { x: 12, y: 12, z: 7 },
      kind: "teleport",
    });
    i.portals.push({
      id: "mini_loop",
      from: { x: 12, y: 12, z: 7 },
      to: { x: 12, y: 12, z: 7 },
      kind: "teleport",
    });
    const m = messages(check(i));
    expect(m).toContainEqual(
      expect.stringContaining('portals "mini_down" and "mini_twin" leave from the same tile'),
    );
    expect(m).toContainEqual(expect.stringContaining("portal leads to its own tile"));
  });

  it("warns that a boat portal moves nobody", () => {
    const i = mini();
    i.portals.push({
      id: "mini_ferry",
      from: { x: 12, y: 12, z: 7 },
      to: { x: 13, y: 13, z: 7 },
      kind: "boat",
    });
    const r = check(i);
    expect(r.diagnostics.filter((x) => x.severity === "error")).toEqual([]);
    expect(messages(r)).toContainEqual(expect.stringContaining("a boat portal moves nobody"));
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

  it("does not walk across stairs, holes or teleports, nor sail a boat portal", () => {
    // The same water corner with one dirt tile in its wall at (18,20): a teleport on it
    // (to the open side) leaves the corner unreachable on foot, as in the game, where a
    // step onto it lands on its destination. A boat portal into the corner moves nobody.
    const i = mini();
    const c = must(i.chunks.get(chunkKey(7, 0, 0)));
    for (let k = 2; k < 30; k++) {
      setGround(c, 18, k, k < 18 ? "grass" : "water_shallow");
      setGround(c, k, 18, k < 18 ? "grass" : "water_shallow");
    }
    setGround(c, 18, 20, "dirt");
    expect(messages(check(i)).join("\n")).not.toContain("cannot be reached");
    i.portals.push(
      {
        id: "mini_gate",
        from: { x: 18, y: 20, z: 7 },
        to: { x: 14, y: 14, z: 7 },
        kind: "teleport",
      },
      { id: "mini_ferry", from: { x: 12, y: 12, z: 7 }, to: { x: 22, y: 22, z: 7 }, kind: "boat" },
    );
    const m = messages(check(i));
    expect(m).toContainEqual(
      expect.stringContaining("NPC cannot be reached on foot from the temple"),
    );
    // The corner warns as an area of its own: the teleport splits it from the rest.
    const area = m.filter((x) => x.includes("walkable tiles around here cannot be reached"));
    expect(area).toEqual([expect.stringContaining("(19,19,7) 121 walkable tiles")]);
    // A ladder there is a tile like any other: the corner is reached again.
    i.portals[i.portals.length - 2] = {
      id: "mini_gate",
      from: { x: 18, y: 20, z: 7 },
      to: { x: 12, y: 12, z: 8 },
      kind: "ladder",
    };
    i.portals.push({
      id: "mini_gate_up",
      from: { x: 12, y: 13, z: 8 },
      to: { x: 17, y: 20, z: 7 },
      kind: "ladder",
    });
    expect(messages(check(i)).join("\n")).not.toContain("cannot be reached");
  });

  it("rejects a portal into a house of another island, like the server", () => {
    const a = mini();
    const grass = emptyChunk(1, 0, 7);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) setGround(grass, x, y, "grass");
    const b: Island = {
      meta: {
        id: "mini_two",
        name: "island.testisle.name",
        rect: { x: 32, y: 0, w: 32, h: 32 },
        floors: [7],
        temple: { x: 48, y: 16, z: 7 },
        level_hint: [1, 5],
      },
      chunks: new Map([[chunkKey(7, 1, 0), grass]]),
      spawns: [],
      npcs: [],
      zones: [
        {
          id: "two_temple",
          type: "protection",
          floors: [7],
          rects: [{ x: 47, y: 15, w: 3, h: 3 }],
        },
      ],
      portals: [],
      texts: [],
      houses: [
        {
          id: "puerto_house_net",
          name: "house.puerto_house_net.name",
          rent: 100,
          rects: [{ x: 36, y: 5, z: 7, w: 3, h: 2 }],
          doors: [{ x: 37, y: 6, z: 7 }],
          exit: { x: 37, y: 7, z: 7 },
        },
      ],
    };
    expect(messages(check(a, worldOf(a, b), [b]))).toEqual([]);
    a.portals.push({
      id: "mini_gate",
      from: { x: 12, y: 12, z: 7 },
      to: { x: 37, y: 5, z: 7 },
      kind: "teleport",
    });
    expect(messages(check(a, worldOf(a, b), [b]))).toContainEqual(
      expect.stringContaining(
        'world/islands/mini/portals.yaml:14 [2].to: (37,5,7) portal destination is inside house "puerto_house_net"',
      ),
    );
  });

  it("keeps NPCs and radius-0 spawns off the entrance of stairs, holes and teleports", () => {
    const i = mini();
    i.npcs = [{ npc: "harbor_master", pos: { x: 10, y: 10, z: 7 } }];
    i.spawns[0] = { ...must(i.spawns[0]), center: { x: 10, y: 10, z: 8 }, radius: 0 };
    let m = messages(check(i));
    expect(m).toContainEqual(
      expect.stringContaining('NPC stands on the entrance of portal "mini_down"'),
    );
    expect(m).toContainEqual(
      expect.stringContaining('spawn of radius 0 on the entrance of portal "mini_up"'),
    );
    i.spawns[0] = { ...must(i.spawns[0]), radius: 1 };
    m = messages(check(i));
    expect(m.join("\n")).not.toContain("spawn of radius 0");
  });

  it("keeps the temple and house exits off the entrance of stairs, holes and teleports", () => {
    const i = mini();
    i.houses = [
      {
        id: "puerto_house_net",
        name: "house.puerto_house_net.name",
        rent: 100,
        rects: [{ x: 20, y: 5, z: 7, w: 1, h: 1 }],
        doors: [{ x: 20, y: 5, z: 7 }],
        exit: { x: 20, y: 6, z: 7 },
      },
    ];
    expect(messages(check(i))).toEqual([]);
    i.portals.push(
      {
        id: "mini_gate",
        from: { x: 16, y: 16, z: 7 },
        to: { x: 14, y: 14, z: 7 },
        kind: "teleport",
      },
      {
        id: "mini_porch",
        from: { x: 20, y: 6, z: 7 },
        to: { x: 22, y: 8, z: 7 },
        kind: "teleport",
      },
    );
    const m = messages(check(i));
    expect(m).toContainEqual(
      expect.stringContaining('temple lies on the entrance of portal "mini_gate"'),
    );
    expect(m).toContainEqual(
      expect.stringContaining('house exit lies on the entrance of portal "mini_porch"'),
    );
  });

  it("wants every tile a crowded arrival may take connected on foot with the destination", () => {
    // The cave of floor 8 split by a water column at x = 12: its east column (13,10..13) is
    // 2 tiles from where the stairs down land (11,11,8), within travel.arrival_radius (2),
    // but on the other side of the water.
    const i = mini();
    const cave = must(i.chunks.get(chunkKey(8, 0, 0)));
    for (let y = 10; y < 14; y++) setGround(cave, 12, y, "water_shallow");
    expect(content.arrivalRadius).toBe(2);
    expect(messages(check(i))).toContainEqual(
      expect.stringContaining(
        "[0].to: (11,11,8) 13,10,8 is within travel.arrival_radius (2) of the destination but not connected to it on foot",
      ),
    );
    // A bridge at the south end: the east column is a walk round, not a pocket.
    setGround(cave, 12, 13, "dirt");
    expect(messages(check(i)).join("\n")).not.toContain("not connected to it on foot");
    // Split again, with the stairs landing at 10,11,8: the east column lies beyond the
    // radius, so no arrival can take it.
    setGround(cave, 12, 13, "water_shallow");
    expect(messages(check(i)).join("\n")).toContain("not connected to it on foot");
    i.portals[0] = { ...must(i.portals[0]), to: { x: 10, y: 11, z: 8 } };
    expect(messages(check(i)).join("\n")).not.toContain("not connected to it on foot");
  });

  it("rejects a portal id used twice in the world, like the server", () => {
    const a = mini();
    const b = mini();
    b.meta = {
      ...b.meta,
      id: "mini_two",
      rect: { x: 32, y: 0, w: 32, h: 32 },
      temple: { x: 48, y: 16, z: 7 },
    };
    const shift = (c: Chunk): Chunk => ({ ...c, cx: c.cx + 1 });
    b.chunks = new Map(
      [...b.chunks.values()].map((c) => [chunkKey(c.z, c.cx + 1, c.cy), shift(c)]),
    );
    const move = (p: Position): Position => ({ ...p, x: p.x + 32 });
    b.spawns = [];
    b.npcs = [];
    b.zones = [
      { id: "two_temple", type: "protection", floors: [7], rects: [{ x: 47, y: 15, w: 3, h: 3 }] },
    ];
    b.portals = b.portals.map((p) => ({
      ...p,
      id: `two_${p.id}`,
      from: move(p.from),
      to: move(p.to),
    }));
    expect(messages(check(a, worldOf(a, b), [b]))).toEqual([]);
    must(b.portals[0]).id = "mini_down";
    expect(messages(check(a, worldOf(a, b), [b]))).toContainEqual(
      expect.stringContaining(
        'portal "mini_down" is already defined in world/islands/mini/portals.yaml',
      ),
    );
  });

  it("walks through doors, locked or not, to reach what lies behind them", () => {
    const i = mini();
    const c = must(i.chunks.get(chunkKey(7, 0, 0)));
    // The same water corner, with one dirt tile in its wall: a locked forge gate on it
    // (docs/02 "Puertas con llave") lets the reachability check through, a boulder does not.
    for (let k = 2; k < 30; k++) {
      setGround(c, 18, k, k < 18 ? "grass" : "water_shallow");
      setGround(c, k, 18, k < 18 ? "grass" : "water_shallow");
    }
    setGround(c, 18, 20, "dirt");
    pushItem(c, 18, 20, "forge_gate");
    expect(content.items.get("forge_gate")?.door).toBe(true);
    expect(messages(check(i)).join("\n")).not.toContain("cannot be reached");
    c.items = c.items.filter((e) => !(e.x === 18 && e.y === 20));
    pushItem(c, 18, 20, "boulder");
    expect(messages(check(i))).toContainEqual(
      expect.stringContaining("NPC cannot be reached on foot from the temple"),
    );
  });

  /** mini() with its south-east corner (19..29, 19..29) walled off by water and the forge gate at (18,20). */
  function gated(): { island: Island; chunk: Chunk } {
    const island = mini();
    const chunk = must(island.chunks.get(chunkKey(7, 0, 0)));
    for (let k = 2; k < 30; k++) {
      setGround(chunk, 18, k, k < 18 ? "grass" : "water_shallow");
      setGround(chunk, k, 18, k < 18 ? "grass" : "water_shallow");
    }
    setGround(chunk, 18, 20, "dirt");
    pushItem(chunk, 18, 20, "forge_gate");
    island.npcs = [{ npc: "harbor_master", pos: { x: 8, y: 20, z: 7 } }];
    return { island, chunk };
  }

  it("refuses what belongs outside in the room behind a locked door (docs/02)", () => {
    const behind = "lies in the room behind the locked door at 18,20,7";
    const ok = gated();
    // A guarded vault: a spawn may live in the room.
    ok.island.spawns[0] = { ...must(ok.island.spawns[0]), center: { x: 24, y: 24, z: 7 } };
    expect(messages(check(ok.island))).toEqual([]);

    const room = { x: 21, y: 21, z: 7 };
    const cases: [string, string, (i: Island) => ContentIndex | undefined][] = [
      ["npcs.yaml", "[0].pos", (i) => void (i.npcs = [{ npc: "harbor_master", pos: room }])],
      ["island.yaml", "temple", (i) => void (i.meta.temple = room)],
      ["portals.yaml", "[1].to", (i) => void (must(i.portals[1]).to = room)],
      [
        "houses.yaml",
        "[0].exit",
        (i) =>
          void (i.houses = [
            {
              id: "puerto_house_net",
              name: "house.puerto_house_net.name",
              rent: 100,
              rects: [{ x: 22, y: 22, z: 7, w: 2, h: 2 }],
              doors: [{ x: 22, y: 23, z: 7 }],
              exit: { x: 22, y: 24, z: 7 },
            },
          ]),
      ],
      [
        // Its exit outside the room, a tile of the house inside it (across the water).
        "houses.yaml",
        "[0].rects",
        (i) =>
          void (i.houses = [
            {
              id: "puerto_house_net",
              name: "house.puerto_house_net.name",
              rent: 100,
              rects: [{ x: 17, y: 22, z: 7, w: 3, h: 1 }],
              doors: [{ x: 17, y: 22, z: 7 }],
              exit: { x: 16, y: 22, z: 7 },
            },
          ]),
      ],
      [
        "boat_routes.yaml",
        "[0].to",
        () => ({
          ...content,
          routes: [
            { index: 0, id: "r", captain: "harbor_master", from: { x: 8, y: 21, z: 7 }, to: room },
          ],
        }),
      ],
      [
        "data/npcs/harbor_master.yaml",
        "dialog.nodes.start",
        () => ({
          ...content,
          teleports: [
            { npc: "harbor_master", file: "data/npcs/harbor_master.yaml", node: "start", to: room },
          ],
        }),
      ],
    ];
    for (const [file, path, edit] of cases) {
      const where = `${file} ${path}`;
      const { island } = gated();
      const c = edit(island);
      const root = mkdtempSync(join(tmpdir(), "map-format-"));
      dirs.push(root);
      writeWorldMeta(root, worldOf(island));
      writeIsland(root, island);
      const found = messages(validateWorld(root, { content: c ?? content })).filter((m) =>
        m.includes(behind),
      );
      expect(found, where).toHaveLength(1);
      expect(found[0], where).toContain(file);
      expect(found[0], where).toContain(` ${path}:`);
    }
  });

  it("refuses a locked door without a room and two doors on a tile; warns of an open one", () => {
    const shut = gated();
    // In the middle of the grass the gate keeps nothing apart.
    shut.chunk.items = shut.chunk.items.filter((s) => !(s.x === 18 && s.y === 20));
    pushItem(shut.chunk, 10, 22, "forge_gate");
    expect(messages(check(shut.island))).toContainEqual(
      expect.stringContaining(
        'locked door "forge_gate" at 10,22,7: it keeps nothing apart: every tile around it is one side',
      ),
    );

    const two = gated();
    pushItem(two.chunk, 18, 20, "forge_gate_open");
    expect(messages(check(two.island))).toContainEqual(
      expect.stringContaining(
        'doors "forge_gate" and "forge_gate_open" on the same tile 18,20,7: one door per tile',
      ),
    );

    const ajar = gated();
    must(ajar.chunk.items.find((s) => s.x === 18 && s.y === 20)).stack = ["forge_gate_open"];
    const r = check(ajar.island);
    expect(r.errors).toBe(0);
    expect(messages(r)).toEqual([
      expect.stringContaining('door "forge_gate_open" is placed open at 18,20,7'),
    ]);

    // A second gate splits the corner: the vault behind it (24..29) is bigger than the
    // room before it (19..22), so both gates take the small room and the vault is the
    // second gate's outside. Refused: from the vault no way leads to the temple without
    // keys (escape check), and the vault would be guarded by no door.
    const vault = (): ReturnType<typeof gated> => {
      const v = gated();
      for (let y = 19; y < 30; y++) setGround(v.chunk, 23, y, "water_shallow");
      setGround(v.chunk, 23, 24, "dirt");
      pushItem(v.chunk, 23, 24, "forge_gate");
      return v;
    };
    const doorErrors = (island: Island, c: ContentIndex = content): string[] => {
      const root = mkdtempSync(join(tmpdir(), "map-format-"));
      dirs.push(root);
      writeWorldMeta(root, worldOf(island));
      writeIsland(root, island);
      return messages(validateWorld(root, { content: c })).filter((m) => m.includes("locked door"));
    };
    expect(doorErrors(vault().island)).toEqual([
      expect.stringContaining(
        'locked door "forge_gate" at 23,24,7: a side of it reaches no temple without keys (on foot, out of rooms, by stairs, ladders, holes and teleports): whoever is there could be locked in (its side at 24,23,7)',
      ),
    ]);
    // A teleport out of the vault is a way out. A boat that arrives in it is not (a way
    // in: leaving by boat takes the captain), and a boat portal moves nobody.
    const inVault = { x: 26, y: 26, z: 7 };
    const route = { index: 0, id: "r", captain: "harbor_master", from: { x: 8, y: 21, z: 7 } };
    expect(
      doorErrors(vault().island, { ...content, routes: [{ ...route, to: inVault }] }),
    ).toHaveLength(1);
    const out = (kind: "teleport" | "boat"): Island => {
      const v = vault().island;
      v.portals.push({ id: "mini_out", kind, from: inVault, to: { x: 10, y: 22, z: 7 } });
      return v;
    };
    expect(doorErrors(out("teleport"))).toEqual([]);
    expect(doorErrors(out("boat"))).toHaveLength(1);
  });

  // A cycle of locked doors of one key is safe (docs/02 "Puertas con llave"): the vault
  // behind the second gate gets a third gate of its own to the field. With a gate of
  // another key there, the first key would open the vault's gate from inside it.
  it("accepts a cycle of locked doors of one key, not of two", () => {
    const cycle = (gate: string): Island => {
      const v = gated();
      for (let y = 19; y < 30; y++) setGround(v.chunk, 23, y, "water_shallow");
      setGround(v.chunk, 23, 24, "dirt");
      pushItem(v.chunk, 23, 24, "forge_gate");
      setGround(v.chunk, 26, 18, "dirt");
      pushItem(v.chunk, 26, 18, gate);
      return v.island;
    };
    expect(messages(check(cycle("forge_gate"))).filter((m) => m.includes("locked door"))).toEqual(
      [],
    );
    const gate = must(content.items.get("forge_gate"));
    const items = new Map(content.items).set("vault_gate", {
      ...gate,
      id: "vault_gate",
      lock: "vault",
    });
    const root = mkdtempSync(join(tmpdir(), "map-format-"));
    dirs.push(root);
    const island = cycle("vault_gate");
    writeWorldMeta(root, worldOf(island));
    writeIsland(root, island);
    expect(
      messages(validateWorld(root, { content: { ...content, items } })).filter((m) =>
        m.includes("locked door"),
      ),
    ).toEqual([
      expect.stringContaining(
        'locked door "vault_gate" at 26,18,7: a player without its key gets into its room: a locked door of another key opens onto it from a room such a player reaches (the door at 23,24,7 opens onto it from its own room)',
      ),
    ]);
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

  // Skipped as root (bypasses permissions) and on Windows (chmod only toggles read-only, never denies reads).
  it.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
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
