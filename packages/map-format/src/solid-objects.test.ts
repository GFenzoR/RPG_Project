// What stands in the way (docs/06 "Qué bloquea el paso", owner's report of 2026-11-24: one
// walked over the bushes). A bush is solid like a tree or a boulder, and making it so cut
// nothing: on every island of world/ each place one walked to before is still walked to,
// nothing that stands somewhere (a spawn, an NPC, a portal end, a house) stands on a solid
// tile, and the validator (the temple reach of every spawn, NPC, house, chest, plate and
// quest place) has nothing to say.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadContent } from "./content.ts";
import { loadWorld } from "./io.ts";
import { TileMap, isPassableBreaking, isWalkable } from "./tiles.ts";
import type { Tile } from "./tiles.ts";
import type { Island, Position } from "./types.ts";
import { validateWorld } from "./validate.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const { world } = loadWorld(repo);
const content = loadContent(repo);
const tiles = new TileMap(world.islands.values());
const at = (p: Position): string => `${p.x},${p.y},${p.z}`;

/** The plants and rocks that stop feet, and the low growth one walks through. */
const SOLID = [
  "bush",
  "thick_bush",
  "thorny_vines",
  "oak_tree",
  "pine_tree",
  "birch_tree",
  "elm_tree",
  "boulder",
  "mossy_boulder",
  "cracked_rock",
  "iron_vein",
  "ember_vein",
  "well",
  "fountain",
  "barrel",
  "cargo_crate",
  "table",
  "shelf",
  "lamp_post",
];
const WALKED_OVER = [
  "grass_tuft",
  "tall_grass",
  "wildflowers",
  "reeds",
  "cut_bush",
  "cut_vines",
  "rock_rubble",
  "bench",
  "bed",
  "flower_box",
];

/** Every tile of an island holding `item`, on any floor. */
function find(is: Island, item: string): Position[] {
  const out: Position[] = [];
  for (const c of is.chunks.values())
    for (const st of c.items)
      if (st.stack.includes(item)) out.push({ x: c.cx * 32 + st.x, y: c.cy * 32 + st.y, z: c.z });
  return out;
}

/**
 * The walking areas (8 directions, one floor, as the validator's temple walk) of the tiles
 * of an island that `open` lets through: the area number of each tile, by "x,y,z".
 */
function areas(is: Island, open: (t: Tile | undefined) => boolean): Map<string, number> {
  const area = new Map<string, number>();
  let n = 0;
  for (const c of is.chunks.values()) {
    for (let i = 0; i < 32 * 32; i++) {
      const start = { x: c.cx * 32 + (i % 32), y: c.cy * 32 + Math.floor(i / 32), z: c.z };
      if (area.has(at(start)) || !open(tiles.tileAt(start))) continue;
      n++;
      area.set(at(start), n);
      const queue = [start];
      while (queue.length > 0) {
        const p = queue.pop() as Position;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const q = { x: p.x + dx, y: p.y + dy, z: p.z };
            if (area.has(at(q)) || !open(tiles.tileAt(q))) continue;
            area.set(at(q), n);
            queue.push(q);
          }
      }
    }
  }
  return area;
}

describe("solid map objects", () => {
  it("block the way when their sprite fills the tile, and only then", () => {
    for (const id of SOLID) expect(content.items.get(id)?.blocksMovement, id).toBe(true);
    for (const id of WALKED_OVER) {
      expect(content.items.has(id), id).toBe(true);
      expect(content.items.get(id)?.blocksMovement, id).toBe(false);
    }
  });

  it("have a bush on every island but the tools island, and nobody stands on one", () => {
    for (const is of world.islands.values()) {
      const bushes = find(is, "bush");
      if (is.meta.id === "testisle") continue;
      expect(bushes.length, is.meta.id).toBeGreaterThan(20);
      for (const p of bushes) expect(isWalkable(tiles.tileAt(p), content), at(p)).toBe(false);
    }
  });

  it("leave walkable every tile something stands on", () => {
    const solid: string[] = [];
    const need = (what: string, p: Position): void => {
      if (!isWalkable(tiles.tileAt(p), content)) solid.push(`${what} at ${at(p)}`);
    };
    for (const is of world.islands.values()) {
      const id = is.meta.id;
      need(`${id}: temple`, is.meta.temple);
      for (const s of is.spawns) need(`${id}: spawn ${s.id}`, s.center);
      for (const n of is.npcs) need(`${id}: NPC ${n.npc}`, n.pos);
      for (const p of is.portals) need(`${id}: where portal ${p.id} leads`, p.to);
      for (const h of is.houses) {
        need(`${id}: exit of house ${h.id}`, h.exit);
        for (const d of h.doors) {
          // A house door is a door: shut it blocks, and that is all that may.
          const others = (tiles.tileAt(d)?.stack ?? []).filter(
            (item) => content.items.get(item)?.door !== true,
          );
          const t = tiles.tileAt(d);
          if (!isWalkable(t ? { ground: t.ground, stack: others } : undefined, content))
            solid.push(`${id}: door of house ${h.id} at ${at(d)}`);
        }
        // Nothing fixed takes a tile from a tenant (docs/03 "Muebles y luces"): no bush,
        // tree or boulder inside a house.
        for (const r of h.rects)
          for (let y = r.y; y < r.y + r.h; y++)
            for (let x = r.x; x < r.x + r.w; x++)
              for (const item of tiles.tile(x, y, r.z)?.stack ?? [])
                if (["bush", "oak_tree", "pine_tree", "boulder"].includes(item))
                  solid.push(`${id}: ${item} in house ${h.id} at ${x},${y},${r.z}`);
      }
    }
    expect(solid).toEqual([]);
  });

  it("cut no way on any island: what one walked to with bushes underfoot is still one place", () => {
    const walk = (t: Tile | undefined): boolean => isPassableBreaking(t, content);
    // The same tiles as before the bushes were solid: a bush stops nobody.
    const before = (t: Tile | undefined): boolean =>
      walk(t ? { ground: t.ground, stack: t.stack.filter((id) => id !== "bush") } : undefined);
    for (const is of world.islands.values()) {
      const was = areas(is, before);
      const now = areas(is, walk);
      // Each area of before is at most one area now (its bush tiles are in none).
      const split = new Map<number, Map<number, string>>();
      for (const [k, a] of was) {
        const b = now.get(k);
        if (b === undefined) continue;
        let parts = split.get(a);
        if (!parts) split.set(a, (parts = new Map()));
        if (!parts.has(b)) parts.set(b, k);
      }
      const cuts = [...split.values()]
        .filter((parts) => parts.size > 1)
        .map((parts) => `${is.meta.id}: bushes part ${[...parts.values()].join(" from ")}`);
      expect(cuts).toEqual([]);
      // And the bushes were looked at: the areas of before have their tiles, the ones of
      // now do not.
      for (const p of find(is, "bush")) {
        if (!before(tiles.tileAt(p))) continue; // under something else that blocks
        expect(was.has(at(p)), at(p)).toBe(true);
        expect(now.has(at(p)), at(p)).toBe(false);
      }
    }
  });

  it("pass the map validator: every spawn, NPC, house, chest and quest place is reached", () => {
    expect(validateWorld(repo).diagnostics).toEqual([]);
  });
});
