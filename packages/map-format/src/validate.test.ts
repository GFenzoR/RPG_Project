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
import { groundAt, pushItem, setGround, stackAt } from "./chunk.ts";
import { loadContent, showsPortal } from "./content.ts";
import { formatDiagnostic } from "./diagnostics.ts";
import { writeIsland, writeWorldMeta } from "./io.ts";
import { CHUNK_SIZE, chunkKey, emptyChunk } from "./types.ts";
import type { ContentIndex, ItemInfo, ReachInfo, SigilInfo } from "./content.ts";
import type { Chunk, Island, Position, WorldMeta } from "./types.ts";
import { validateWorld } from "./validate.ts";
import { NO_BORDERS, borderPieces } from "./ops/borders.ts";

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("fixture value missing");
  return v;
}

const repo = fileURLToPath(new URL("../../../", import.meta.url));
// The real routes, dialog teleports and milestone plates of data/ point at the real islands,
// not at these mini worlds: each test that checks them brings its own.
const real = loadContent(repo);
const full = { ...real, routes: [], teleports: [], sigils: [] };
// The mini worlds carry no border pieces: the border check has its own test, with the
// ladder of data/borders.yaml (full).
const content = { ...full, borders: NO_BORDERS };
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

/**
 * A copy of island with an item that shows each portal (but a boat) on its entrance, as
 * make validate wants (docs/03): the fixtures put portals anywhere. A tile without ground,
 * or one that already holds a portal item, is left as it is.
 */
function shown(island: Island): Island {
  const out = structuredClone(island);
  for (const p of out.portals) {
    if (p.kind === "boat") continue;
    const c = out.chunks.get(
      chunkKey(p.from.z, Math.floor(p.from.x / CHUNK_SIZE), Math.floor(p.from.y / CHUNK_SIZE)),
    );
    const lx = p.from.x % CHUNK_SIZE;
    const ly = p.from.y % CHUNK_SIZE;
    if (!c || groundAt(c, lx, ly) === null) continue;
    if (stackAt(c, lx, ly).some((id) => content.items.get(id)?.portal)) continue;
    const look = [...content.items.values()].find((i) => showsPortal(i, p.kind, p.from, p.to));
    if (look) pushItem(c, lx, ly, look.id);
  }
  return out;
}

function check(
  island: Island,
  meta: WorldMeta = worldOf(island),
  extra: Island[] = [],
  c: ContentIndex = content,
) {
  const root = mkdtempSync(join(tmpdir(), "map-format-"));
  dirs.push(root);
  writeWorldMeta(root, meta);
  for (const i of [island, ...extra]) writeIsland(root, shown(i));
  return { root, ...validateWorld(root, { content: c }) };
}

/** Puts on every tile of an island the border pieces of the real ladder, like autoborder. */
function bordered(island: Island): Island {
  for (const c of island.chunks.values()) {
    const at = (x: number, y: number): string | null =>
      x < 0 || y < 0 || x >= CHUNK_SIZE || y >= CHUNK_SIZE ? null : groundAt(c, x, y);
    const pieces = new Map<string, string[]>();
    for (let y = 0; y < CHUNK_SIZE; y++)
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const p = borderPieces(x, y, at, full.borders);
        if (p.length > 0) pieces.set(`${x},${y}`, p);
      }
    for (const s of c.items) {
      s.stack = [...(pieces.get(`${s.x},${s.y}`) ?? []), ...s.stack];
      pieces.delete(`${s.x},${s.y}`);
    }
    for (const [k, p] of pieces) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      c.items.push({ x, y, stack: p });
    }
  }
  return island;
}

const messages = (r: { diagnostics: Parameters<typeof formatDiagnostic>[0][] }): string[] =>
  r.diagnostics.map(formatDiagnostic);

describe("validateWorld", () => {
  it("accepts a valid island", () => {
    const r = check(mini());
    expect(messages(r)).toEqual([]);
  });

  it("keeps the living world's objects off protection zones, doors and other objects", () => {
    const island = mini();
    const top = must(island.chunks.get(chunkKey(7, 0, 0)));
    pushItem(top, 22, 22, "weathered_crate"); // fine: grass, outside every zone
    pushItem(top, 16, 15, "thorny_vines"); // in the temple's protection zone
    pushItem(top, 24, 24, "mossy_boulder");
    pushItem(top, 24, 24, "cracked_rock"); // two objects on one tile
    pushItem(top, 25, 25, "forge_gate_open"); // a door's tile
    pushItem(top, 25, 25, "spider_web");
    const out = messages(check(island)).filter((m) => m.includes("living world object"));
    expect(out).toEqual([
      expect.stringContaining("16,15,7: not in a protection zone"),
      expect.stringContaining("24,24,7: one object per tile"),
      expect.stringContaining("25,25,7: not on a door's tile"),
    ]);
  });

  it("walks through what anyone breaks, never through a rock that needs a pick", () => {
    expect(content.items.get("thorny_vines")?.breaksFreely).toBe(true);
    expect(content.items.get("cracked_rock")?.breaksFreely).toBeUndefined();
    expect(content.items.get("mossy_boulder")?.living).toBe("pushable");
    expect(content.items.get("barrel")?.living).toBeUndefined();
  });

  it("accepts the repository world (world/islands/testisle)", () => {
    const r = validateWorld(repo, { content: { ...full, sigils: real.sigils ?? [] } });
    expect(messages(r)).toEqual([]);
  });

  it("wants on every tile the border pieces its neighbours' grounds give now (docs/06)", () => {
    const stale = (i: Island): string[] =>
      messages(check(i, worldOf(i), [], full)).filter((m) => m.includes("border pieces"));
    // Grass by the water ring and around the stone temple tile, no piece anywhere: one error
    // for the chunk of z7, at its first tile; the dirt of the z8 cave borders nothing.
    expect(stale(mini())).toEqual([
      expect.stringMatching(
        /z07\/c0000_0000\.json.*\(1,1,7\) \d+ tile\(s\) with border pieces out of date \(first at 1,1,7: has none, needs border_surf_se, border_grass_se at the bottom of its stack\); run `mapcli autoborder mini --floor 7`/,
      ),
    ]);
    // What the autoborder leaves passes.
    expect(stale(bordered(mini()))).toEqual([]);
    // A ground painted after it, a piece above another item, a piece missing: out of date.
    const painted = bordered(mini());
    setGround(must(painted.chunks.get(chunkKey(7, 0, 0))), 8, 8, "sand");
    expect(stale(painted)).toEqual([
      expect.stringContaining("1 tile(s) with border pieces out of date (first at 8,8,7: has none"),
    ]);
    const above = bordered(mini());
    const c = must(above.chunks.get(chunkKey(7, 0, 0)));
    const s = must(c.items.find((t) => t.x === 1 && t.y === 1));
    s.stack = ["rope", ...s.stack];
    expect(stale(above)).toEqual([
      expect.stringContaining(
        "1 tile(s) with border pieces out of date (first at 1,1,7: has border_surf_se, border_grass_se, needs border_surf_se, border_grass_se at the bottom",
      ),
    ]);
    const missing = bordered(mini());
    const m = must(missing.chunks.get(chunkKey(7, 0, 0)));
    m.items = m.items.filter((t) => !(t.x === 16 && t.y === 16));
    expect(stale(missing)).toEqual([
      expect.stringContaining("(first at 16,16,7: has none, needs border_grass_inner_nw"),
    ]);
    // Without a ladder (no fringe anywhere), nothing is checked.
    expect(messages(check(mini(), undefined, [], { ...full, borders: NO_BORDERS }))).toEqual([]);
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

  it("wants the item that shows each portal on its entrance; warns of one with no portal", () => {
    // Bare: the stairs of mini() without their items.
    const root = mkdtempSync(join(tmpdir(), "map-format-"));
    dirs.push(root);
    const bare = mini();
    writeWorldMeta(root, worldOf(bare));
    writeIsland(root, bare);
    expect(messages(validateWorld(root, { content }))).toEqual([
      'error world/islands/mini/portals.yaml:3 [0].from: (10,10,7) stairs "mini_down" has no item that shows it on its entrance (one with portal: { kind: stairs, leads: down }, e.g. stairs_down)',
      'error world/islands/mini/portals.yaml:8 [1].from: (10,10,8) stairs "mini_up" has no item that shows it on its entrance (one with portal: { kind: stairs, leads: up }, e.g. stairs_up)',
    ]);

    // A ladder pair whose foot wears the hatch of a ladder going down (the wrong way), a
    // teleport on its floor with its item (check adds the rest) and a hole item lying
    // where no hole leads anywhere.
    const i = mini();
    const top = must(i.chunks.get(chunkKey(7, 0, 0)));
    const cave = must(i.chunks.get(chunkKey(8, 0, 0)));
    i.portals.push(
      {
        id: "mini_ladder",
        kind: "ladder",
        from: { x: 12, y: 12, z: 8 },
        to: { x: 12, y: 13, z: 7 },
      },
      {
        id: "mini_hatch",
        kind: "ladder",
        from: { x: 13, y: 13, z: 7 },
        to: { x: 13, y: 12, z: 8 },
      },
      { id: "mini_gate", kind: "teleport", from: { x: 24, y: 8, z: 7 }, to: { x: 6, y: 20, z: 7 } },
    );
    pushItem(cave, 12, 12, "ladder_down");
    pushItem(top, 22, 10, "hole");
    const m = messages(check(i));
    expect(m).toEqual([
      'warning world/islands/mini/chunks/z07/c0000_0000.json items: (22,10,7) "hole" shows a hole, but no such portal of world/islands/mini/portals.yaml leaves from this tile',
      'warning world/islands/mini/chunks/z08/c0000_0000.json items: (12,12,8) "ladder_down" shows a ladder leading down, but no such portal of world/islands/mini/portals.yaml leaves from this tile',
      'error world/islands/mini/portals.yaml:13 [2].from: (12,12,8) ladder "mini_ladder" has no item that shows it on its entrance (one with portal: { kind: ladder, leads: up }, e.g. ladder_up)',
    ]);
  });

  it("takes a ground item that shows a portal like one on the stack", () => {
    // No ground item of data/ shows a portal today: a pit floor that shows a hole.
    const pit: ItemInfo = {
      id: "pit_floor",
      kind: "ground",
      walkable: true,
      blocksMovement: false,
      portal: { kind: "hole" },
    };
    const withPit: ContentIndex = { ...content, items: new Map([...content.items, [pit.id, pit]]) };
    const i = shown(mini());
    const top = must(i.chunks.get(chunkKey(7, 0, 0)));
    i.portals.push({
      id: "mini_pit",
      kind: "hole",
      from: { x: 20, y: 24, z: 7 },
      to: { x: 12, y: 12, z: 8 },
    });
    setGround(top, 20, 24, "pit_floor"); // shows the hole that leaves from it
    setGround(top, 22, 10, "pit_floor"); // no hole leaves from here
    const root = mkdtempSync(join(tmpdir(), "map-format-"));
    dirs.push(root);
    writeWorldMeta(root, worldOf(i));
    writeIsland(root, i);
    expect(messages(validateWorld(root, { content: withPit }))).toEqual([
      'warning world/islands/mini/chunks/z07/c0000_0000.json ground[10][22]: (22,10,7) "pit_floor" shows a hole, but no such portal of world/islands/mini/portals.yaml leaves from this tile',
    ]);
  });

  it("warns of a hole or a teleport into a place with no way to a temple", () => {
    // A pit on floor 8 (20..22, 20..22), apart from the cave, that a hole of floor 7 leads
    // into. Its only way up is a rope spot: whoever falls in without a rope is stuck.
    const i = mini();
    const cave = must(i.chunks.get(chunkKey(8, 0, 0)));
    for (let y = 20; y < 23; y++) for (let x = 20; x < 23; x++) setGround(cave, x, y, "dirt");
    i.portals.push(
      { id: "mini_pit", from: { x: 20, y: 5, z: 7 }, to: { x: 21, y: 21, z: 8 }, kind: "hole" },
      {
        id: "mini_pit_rope",
        from: { x: 21, y: 20, z: 8 },
        to: { x: 21, y: 6, z: 7 },
        kind: "rope_spot",
      },
    );
    const warning =
      'world/islands/mini/portals.yaml:14 [2].to: (21,21,8) from where hole "mini_pit" leads, no temple is reached without keys or tools';
    const r = check(i);
    expect(r.errors).toBe(0);
    expect(messages(r)).toEqual([expect.stringContaining(warning)]);
    // A teleport there warns the same.
    i.portals[2] = { ...must(i.portals[2]), kind: "teleport" };
    expect(messages(check(i))).toEqual([
      expect.stringContaining('from where teleport "mini_pit" leads, no temple is reached'),
    ]);
    // Landing on the entrance of a teleport (in no area) puts the player in an area next to
    // it: here the pit, which a teleport to the pit itself does not get anyone out of.
    i.portals[2] = { ...must(i.portals[2]), kind: "hole" };
    i.portals.push(
      {
        id: "mini_pit_loop",
        from: { x: 22, y: 22, z: 8 },
        to: { x: 20, y: 20, z: 8 },
        kind: "teleport",
      },
      {
        id: "mini_pit_gate",
        from: { x: 5, y: 25, z: 7 },
        to: { x: 22, y: 22, z: 8 },
        kind: "teleport",
      },
    );
    const stuck = (m: string[]): string[] =>
      m.flatMap((x) => /from where (\w+ "\w+") leads, no temple/.exec(x)?.[1] ?? []);
    expect(stuck(messages(check(i)))).toEqual([
      'hole "mini_pit"',
      'teleport "mini_pit_loop"',
      'teleport "mini_pit_gate"',
    ]);
    i.portals.splice(4, 2);
    // A ladder up instead of the rope (with its way down, like any ladder): no warning.
    i.portals[3] = { ...must(i.portals[3]), kind: "ladder" };
    i.portals.push({
      id: "mini_pit_down",
      from: { x: 22, y: 6, z: 7 },
      to: { x: 22, y: 21, z: 8 },
      kind: "ladder",
    });
    expect(messages(check(i))).toEqual([]);
    // Stairs up from the pit (with their way down) do as well.
    i.portals.splice(
      3,
      2,
      {
        id: "mini_pit_stairs",
        from: { x: 22, y: 22, z: 8 },
        to: { x: 23, y: 6, z: 7 },
        kind: "stairs",
      },
      {
        id: "mini_pit_stairs_down",
        from: { x: 24, y: 6, z: 7 },
        to: { x: 21, y: 22, z: 8 },
        kind: "stairs",
      },
    );
    expect(messages(check(i))).toEqual([]);
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

  it('places each reward chest once, next to a tile reached from the temple (docs/02 "Libros y cofres")', () => {
    const i = mini();
    const c = must(i.chunks.get(chunkKey(7, 0, 0)));
    pushItem(c, 20, 10, "chest_pruebas");
    expect(messages(check(i))).toEqual([]);
    // A second copy shares its chest id: it would open once between the two.
    pushItem(c, 22, 10, "chest_pruebas");
    // Water all around: nobody stands next to it.
    for (let y = 4; y <= 6; y++)
      for (let x = 24; x <= 26; x++) if (x !== 25 || y !== 5) setGround(c, x, y, "water_shallow");
    pushItem(c, 25, 5, "chest_puerto_grove");
    expect(messages(check(i))).toEqual([
      'error world/islands/mini/chunks/z07/c0000_0000.json items: (25,5,7) chest "chest_puerto_grove" cannot be opened: no tile next to it is reached on foot from the temple',
      'error world/islands/mini/chunks/z07/c0000_0000.json items: (22,10,7) chest "pruebas" ("chest_pruebas") is also at 20,10,7 ("chest_pruebas"): a chest gives once per character, so each one stands once in the world',
    ]);
  });

  it('checks milestone plates and their reward room (docs/02 "Quests de hito")', () => {
    const i = mini();
    const top = must(i.chunks.get(chunkKey(7, 0, 0)));
    pushItem(top, 20, 8, "sigil_plate");
    pushItem(top, 22, 8, "sigil_plate");
    // The reward room is the cave on z8 (its stairs lead back up): reached from the plates.
    const s: SigilInfo = {
      quest: "ms_test",
      file: "data/quests/ms_test.yaml",
      step: 0,
      at: { x: 21, y: 8, z: 7 },
      radius: 1,
      to: { x: 12, y: 12, z: 8 },
      players: 2,
      vocations: [],
    };
    const run = (sigils: SigilInfo[]): string[] =>
      messages(check(i, undefined, [], { ...content, sigils }));
    expect(run([s])).toEqual([]);
    // Three players for two plates; plates marked for nobody where vocations are asked.
    expect(run([{ ...s, players: 3 }])).toEqual([
      'error data/quests/ms_test.yaml steps[0].complete_when.sigils: (21,8,7) milestone "ms_test": 2 sigil plates within radius 1 of 21,8,7, requires.players is 3',
    ]);
    expect(run([{ ...s, vocations: ["guardian", "druid"] }])[0]).toContain(
      "its plates are marked [, ], requires.vocations is [guardian, druid]",
    );
    // A reward room nobody leaves: a grass pocket walled by water, no portal out.
    for (let y = 3; y <= 7; y++)
      for (let x = 23; x <= 27; x++)
        setGround(top, x, y, x === 25 && y === 5 ? "grass" : "water_shallow");
    expect(run([{ ...s, to: { x: 25, y: 5, z: 7 } }])).toEqual([
      'error data/quests/ms_test.yaml steps[0].complete_when.sigils.to: (25,5,7) milestone "ms_test": its reward room at 25,5,7: no temple is reached from there without keys or tools (on foot, stairs, ladders, holes, teleports, out of a room through its door): whoever lands there is stuck',
    ]);
    // A plate of no milestone, and one nobody reaches on foot.
    pushItem(top, 25, 5, "sigil_plate_druid");
    const m = run([
      { ...s, at: { x: 24, y: 6, z: 7 }, radius: 1, players: 1, vocations: ["druid"] },
    ]);
    expect(m).toContainEqual(
      expect.stringContaining('sigil plate "sigil_plate" at 20,8,7 belongs to no milestone'),
    );
    expect(m).toContainEqual(
      expect.stringContaining(
        'sigil plate of milestone "ms_test" at 25,5,7 is not reached on foot from the temple',
      ),
    );
  });

  it("refuses plates the server refuses: two on a tile, in a house, on a portal entrance", () => {
    const i = mini();
    const top = must(i.chunks.get(chunkKey(7, 0, 0)));
    i.houses = [
      {
        id: "puerto_house_net",
        name: "house.puerto_house_net.name",
        rent: 100,
        rects: [{ x: 20, y: 5, z: 7, w: 3, h: 2 }],
        doors: [{ x: 21, y: 6, z: 7 }],
        exit: { x: 21, y: 7, z: 7 },
      },
    ];
    pushItem(top, 20, 8, "sigil_plate");
    pushItem(top, 20, 8, "sigil_plate");
    pushItem(top, 20, 5, "sigil_plate");
    pushItem(top, 10, 10, "sigil_plate"); // the entrance of the stairs mini_down
    const one = (
      quest: string,
      at: { x: number; y: number; z: number },
      players = 1,
    ): SigilInfo => ({
      quest,
      file: `data/quests/${quest}.yaml`,
      step: 0,
      at,
      radius: 0,
      to: { x: 12, y: 12, z: 8 },
      players,
      vocations: [],
    });
    const m = messages(
      check(i, undefined, [], {
        ...content,
        sigils: [
          one("ms_twice", { x: 20, y: 8, z: 7 }, 2),
          one("ms_house", { x: 20, y: 5, z: 7 }),
          one("ms_stairs", { x: 10, y: 10, z: 7 }),
        ],
      }),
    );
    expect(m).toContainEqual(expect.stringContaining('milestone "ms_twice": two plates on 20,8,7'));
    expect(m).toContainEqual(
      expect.stringContaining('milestone "ms_house": the plate at 20,5,7 lies in a house'),
    );
    expect(m).toContainEqual(
      expect.stringContaining(
        'milestone "ms_stairs": the plate at 10,10,7 lies on the entrance of stairs, a hole or a teleport',
      ),
    );
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
    // Not across a house tile (a wall of the area the server searches in) ...
    const stray =
      "[0].to: (11,11,8) 13,10,8 is within travel.arrival_radius (2) of the destination but not connected to it on foot";
    i.houses = [
      {
        id: "puerto_house_net",
        name: "house.puerto_house_net.name",
        rent: 100,
        rects: [{ x: 12, y: 13, z: 8, w: 1, h: 1 }],
        doors: [{ x: 12, y: 13, z: 8 }],
        exit: { x: 11, y: 13, z: 8 },
      },
    ];
    expect(messages(check(i))).toContainEqual(expect.stringContaining(stray));
    // ... nor past an NPC: it never leaves its tile, so the bridge it stands on is a wall.
    i.houses = [];
    i.npcs.push({ npc: "puerto_provisioner", pos: { x: 12, y: 13, z: 8 } });
    expect(messages(check(i))).toContainEqual(expect.stringContaining(stray));
    i.npcs.pop();
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

  it("refuses a living object in the wall of a locked room, not one inside it", () => {
    const wall = "stands in the wall of the room behind a locked door";
    const inside = gated();
    pushItem(inside.chunk, 24, 24, "weathered_crate");
    expect(messages(check(inside.island)).filter((m) => m.includes(wall))).toEqual([]);
    const { island, chunk } = gated();
    setGround(chunk, 18, 25, "dirt");
    pushItem(chunk, 18, 25, "weathered_crate");
    expect(messages(check(island)).filter((m) => m.includes(wall))).toEqual([
      expect.stringContaining("living world object at 18,25,7: it stands in the wall"),
    ]);
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

  it("keeps everything the server checks against the map off a dev-only island", () => {
    // mini_two is dev_only: a build without -dev (the production image) leaves it out.
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
      npcs: [{ npc: "bosque_ferryman", pos: { x: 40, y: 20, z: 7 } }],
      zones: [
        {
          id: "two_temple",
          type: "protection",
          floors: [7],
          rects: [{ x: 47, y: 15, w: 3, h: 3 }],
        },
      ],
      portals: [
        // Out of the dev island is fine: it never runs without the rest.
        {
          id: "two_out",
          from: { x: 44, y: 10, z: 7 },
          to: { x: 12, y: 12, z: 7 },
          kind: "teleport",
        },
      ],
      texts: [],
      houses: [],
    };
    const meta = worldOf(a, b);
    const two = meta.islands[1];
    if (!two) throw new Error("no second island");
    two.dev_only = true;
    const ok = check(a, meta, [b]);
    expect(messages(ok)).toEqual([]);
    expect(readFileSync(join(ok.root, "world", "world.yaml"), "utf8")).toContain(
      "level_hint: [1, 5]\n    dev_only: true",
    );

    a.portals.push({
      id: "mini_in",
      from: { x: 12, y: 12, z: 7 },
      to: { x: 40, y: 10, z: 7 },
      kind: "teleport",
    });
    const { root } = check(a, meta, [b]);
    const route = (index: number, captain: string, from: Position, to: Position) => ({
      index,
      id: `r${index}`,
      captain,
      from,
      to,
    });
    const r = validateWorld(root, {
      content: {
        ...content,
        routes: [
          route(0, "harbor_master", { x: 20, y: 21, z: 7 }, { x: 40, y: 22, z: 7 }),
          route(1, "bosque_ferryman", { x: 40, y: 21, z: 7 }, { x: 16, y: 17, z: 7 }),
        ],
        teleports: [
          {
            npc: "puerto_priest",
            file: "data/npcs/puerto_priest.yaml",
            node: "greet",
            to: { x: 45, y: 25, z: 7 },
          },
        ],
      },
    });
    const m = messages(r);
    const has = (...parts: string[]): boolean => m.some((l) => parts.every((p) => l.includes(p)));
    expect(
      has("portals.yaml", "[2].to:", 'portal "mini_in" leads into dev-only island "mini_two"'),
    ).toBe(true);
    expect(
      has("boat_routes.yaml", "[0].to:", 'boat route "r0" lands on dev-only island "mini_two"'),
    ).toBe(true);
    expect(
      has("boat_routes.yaml", "[1].from:", 'boat route "r1" leaves from dev-only island'),
    ).toBe(true);
    expect(
      has("[1].captain:", 'captain "bosque_ferryman" of boat route "r1" stands on dev-only island'),
    ).toBe(true);
    expect(
      has(
        "puerto_priest.yaml",
        'teleport of NPC "puerto_priest" (node "greet") lands on dev-only island',
      ),
    ).toBe(true);
    expect(m.join("\n")).not.toContain("two_out");

    // The first island is where characters with no town start: never a dev-only one.
    const first = worldOf(b, a);
    const head = first.islands[0];
    if (!head) throw new Error("no first island");
    head.dev_only = true;
    expect(messages(check(a, first, [b]))).toContainEqual(
      expect.stringContaining('"mini_two" cannot be dev-only'),
    );
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

  it("refuses a zone of more than 255 rects (world.bin keeps the count in a byte)", () => {
    const i = mini();
    const rects = Array.from({ length: 256 }, (_, k) => ({
      x: 2 + (k % 16),
      y: 2 + Math.floor(k / 16),
      w: 1,
      h: 1,
    }));
    i.zones.push({ id: "mini_many", type: "no_logout", floors: [7], rects });
    expect(messages(check(i))).toContainEqual(expect.stringMatching(/zones\.yaml.*rects.*255/));
    i.zones[i.zones.length - 1] = {
      id: "mini_many",
      type: "no_logout",
      floors: [7],
      rects: rects.slice(0, 255),
    };
    expect(messages(check(i))).toEqual([]);
  });

  it('refuses a reach step whose place has no tile reached on foot from the temple (docs/06 "Quest")', () => {
    const reachErrors = (island: Island, reaches: ReachInfo[]): string[] => {
      const root = mkdtempSync(join(tmpdir(), "map-format-"));
      dirs.push(root);
      writeWorldMeta(root, worldOf(island));
      writeIsland(root, shown(island));
      return messages(validateWorld(root, { content: { ...content, reaches } })).filter((m) =>
        m.includes("reach step"),
      );
    };
    const file = "data/quests/errand.yaml";
    const point = (x: number, y: number, z: number, radius = 0): ReachInfo => ({
      quest: "errand",
      file,
      step: 1,
      at: { x, y, z },
      radius,
    });
    const i = mini();
    // A dirt tile of the cave floor that nothing leads to.
    const cave = must(i.chunks.get(chunkKey(8, 0, 0)));
    setGround(cave, 20, 20, "dirt");
    expect(
      reachErrors(i, [
        point(12, 12, 8), // the cave, down the stairs
        point(20, 4, 7, 2), // the grass
        point(10, 10, 7, 1), // the stairs and the grass around them
        { quest: "errand", file, step: 0, zone: "mini_temple" },
        point(3000, 3000, 7), // another island's
        { quest: "errand", file, step: 0, zone: "elsewhere" },
      ]),
    ).toEqual([]);
    for (const [name, r] of [
      ["the water ring", point(0, 0, 7, 1)],
      ["a cave tile nothing leads to", point(20, 20, 8)],
      ["the stairs alone", point(10, 10, 7)],
    ] as const) {
      const found = reachErrors(i, [r]);
      expect(found, name).toHaveLength(1);
      expect(found[0], name).toContain(`${file} steps[1].complete_when.reach`);
      expect(found[0], name).toContain('reach step of quest "errand": no tile of its point');
    }
    i.zones.push({
      id: "mini_pocket",
      type: "community_plot",
      floors: [8],
      rects: [{ x: 19, y: 19, w: 3, h: 3 }],
    });
    expect(reachErrors(i, [{ quest: "errand", file, step: 0, zone: "mini_pocket" }])).toEqual([
      expect.stringContaining('no tile of its zone "mini_pocket" on island "mini"'),
    ]);
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
