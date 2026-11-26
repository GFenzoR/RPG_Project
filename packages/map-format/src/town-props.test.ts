// The furnished towns and the lit caves of lote 12 (docs/17 "Kit de props de pueblo", docs/03
// "Muebles y luces"): the town prop kit is fixed decoration that blocks only where it should;
// Lanternby, Ivernel and Cinderstead have a fountain in their plaza, braziers, banners and windows at
// their temple, and every rented house a bed and a window that take no tile from its tenant;
// the mines of Puerto, Bosque and Volcán have a wall torch every 6 to 8 tiles on the faces of
// their rock walls; and nothing that blocks stands where a player, a test or the server needs
// the tile.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadContent } from "./content.ts";
import { loadWorld } from "./io.ts";
import { TileMap, isWalkable } from "./tiles.ts";
import type { Island, Position, Rect } from "./types.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const { world } = loadWorld(repo);
const content = loadContent(repo);
const tiles = new TileMap(world.islands.values());

const island = (id: string): Island => {
  const is = world.islands.get(id);
  if (!is) throw new Error(`no island ${id}`);
  return is;
};
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const stack = (x: number, y: number, z: number): string[] => tiles.tile(x, y, z)?.stack ?? [];
const blocks = (id: string): boolean => content.items.get(id)?.blocksMovement === true;
const chebyshev = (a: Position, b: Position): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Every tile of an island on floor z holding `item`. */
function find(is: Island, z: number, item: string): Position[] {
  const out: Position[] = [];
  const { x, y, w, h } = is.meta.rect;
  for (let ty = y; ty < y + h; ty++)
    for (let tx = x; tx < x + w; tx++)
      if (stack(tx, ty, z).includes(item)) out.push({ x: tx, y: ty, z });
  return out;
}

const inRect = (p: Position, r: Rect, grow = 0): boolean =>
  p.x >= r.x - grow && p.x < r.x + r.w + grow && p.y >= r.y - grow && p.y < r.y + r.h + grow;

/** What each prop of the kit is in data/items/decoration.yaml. */
const KIT: Record<string, { blocks: boolean; elevation?: number }> = {
  barrel: { blocks: true, elevation: 8 },
  table: { blocks: true, elevation: 8 },
  bench: { blocks: false },
  shelf: { blocks: true },
  bed: { blocks: false },
  lamp_post: { blocks: true },
  well: { blocks: true },
  sacks: { blocks: true },
  fishing_net: { blocks: true },
  flower_box: { blocks: false },
  market_stall: { blocks: true },
  flag_pole: { blocks: true },
};

/** The towns: their island, plaza and temple zones (zones.yaml). */
const TOWNS = [
  { name: "Lanternby", island: "puerto", plaza: "puerto_plaza", temple: "puerto_temple" },
  { name: "Ivernel", island: "bosque", plaza: "bosque_town", temple: "bosque_temple" },
  { name: "Cinderstead", island: "volcan", plaza: "volcan_town", temple: "volcan_temple" },
] as const;

/**
 * Tiles the end-to-end test walks, clicks or uses in the towns (client/e2e/game.spec.ts):
 * the temple aisle and doorway of Lanternby, its sign and market board, the hearth, the house
 * of the house test, the harbour; the click path from the temple of Ivernel to the druid; the
 * one from the temple of Cinderstead to the keeper's archive; the ferry landings.
 */
const E2E_TILES: readonly (readonly [number, number])[] = [
  ...[3158, 3159, 3160, 3161, 3162].flatMap((x) => [[x, 6385] as const, [x, 6386] as const]),
  [3163, 6384],
  [3168, 6382],
  [3167, 6382],
  [3167, 6383],
  [3172, 6366],
  [3172, 6367],
  [3153, 6399],
  [3153, 6400],
  [3153, 6401],
  [3153, 6402],
  [3153, 6403],
  [3152, 6403],
  [3154, 6403],
  [3154, 6398],
  [3154, 6400],
  [3201, 6431],
  [3201, 6433],
  ...[6105, 6106, 6107, 6108, 6109].map((y) => [4150, y] as const),
  ...Array.from({ length: 21 }, (_, i) => [4150 + i, 6109] as const),
  ...Array.from({ length: 14 }, (_, i) => [4165 + i, 6110] as const),
  [4178, 6111],
  [4178, 6112],
  [4120, 6100],
  [4122, 6100],
  ...[5789, 5790, 5791, 5792, 5793].map((y) => [3642, y] as const),
  ...Array.from({ length: 21 }, (_, i) => [3642 + i, 5794] as const),
  [3662, 5795],
  [3662, 5796],
  [3662, 5797],
  [3641, 5793],
  [3615, 5794],
  [3617, 5795],
];

describe("the town prop kit in data/items", () => {
  const decorations = parse(
    readFileSync(join(repo, "data/items/decoration.yaml"), "utf8"),
  ) as Record<string, unknown>[];
  it("is fixed decoration that blocks only where it should and lifts what is on it", () => {
    for (const [id, want] of Object.entries(KIT)) {
      const d = decorations.find((it) => it["id"] === id);
      expect(d, id).toBeDefined();
      expect(d?.["kind"], id).toBe("decoration");
      expect(d?.["sprite"], id).toBe(`decor/${id}`);
      expect(d?.["pickupable"], id).toBe(false);
      expect(Boolean(d?.["blocks_movement"]), id).toBe(want.blocks);
      expect(d?.["elevation"], id).toBe(want.elevation);
      expect(blocks(id), id).toBe(want.blocks);
    }
  });
});

describe("the furnished towns", () => {
  for (const town of TOWNS) {
    const is = island(town.island);
    const zone = (id: string): Rect => {
      const r = is.zones.find((z) => z.id === id)?.rects[0];
      if (!r) throw new Error(`no zone ${id}`);
      return r;
    };

    it(`${town.name} has a fountain in its plaza and a furnished temple`, () => {
      const plaza = zone(town.plaza);
      expect(find(is, 7, "fountain").filter((p) => inRect(p, plaza)).length).toBeGreaterThan(0);
      // The temple zone and its walls (and the steps outside its doors).
      const temple = zone(town.temple);
      const at = (item: string): number =>
        find(is, 7, item).filter((p) => inRect(p, temple, 1)).length;
      expect(at("brazier")).toBeGreaterThanOrEqual(2);
      expect(at("wall_banner")).toBeGreaterThanOrEqual(2);
      expect(at("stone_wall_window")).toBeGreaterThanOrEqual(2);
      expect(at("bench")).toBeGreaterThanOrEqual(4);
    });

    it(`${town.name} has its plaza dressed with the kit`, () => {
      const plaza = zone(town.plaza);
      const kit = Object.keys(KIT).flatMap((id) => find(is, 7, id).filter((p) => inRect(p, plaza)));
      expect(kit.length).toBeGreaterThanOrEqual(8);
      for (const id of ["market_stall", "lamp_post"])
        expect(find(is, 7, id).filter((p) => inRect(p, plaza, 2)).length, id).toBeGreaterThan(0);
    });

    it(`every house of ${town.name} has a bed and a window that take no tile from its tenant`, () => {
      expect(is.houses.length).toBeGreaterThan(0);
      for (const h of is.houses) {
        const inside: Position[] = [];
        for (const r of h.rects)
          for (let y = r.y; y < r.y + r.h; y++)
            for (let x = r.x; x < r.x + r.w; x++) inside.push({ x, y, z: r.z });
        const isInside = (p: Position): boolean =>
          inside.some((q) => q.x === p.x && q.y === p.y && q.z === p.z);
        expect(
          inside.some((p) => stack(p.x, p.y, p.z).includes("bed")),
          `${h.id}: bed`,
        ).toBe(true);
        // A window in the walls round it (a wall piece next to one of its tiles).
        const window = inside.some((p) =>
          [-1, 0, 1].some((dx) =>
            [-1, 0, 1].some((dy) => {
              const q = { x: p.x + dx, y: p.y + dy, z: p.z };
              return !isInside(q) && stack(q.x, q.y, q.z).some((i) => i.endsWith("_wall_window"));
            }),
          ),
        );
        expect(window, `${h.id}: window`).toBe(true);
        // Nothing fixed on its tiles blocks: every tile stays walkable for the tenant.
        for (const p of inside)
          expect(
            isWalkable(tiles.tile(p.x, p.y, p.z), content),
            `${h.id} ${key(p.x, p.y, p.z)}`,
          ).toBe(true);
      }
    });
  }

  it("never blocks a tile that players, tests or the server need", () => {
    const wrong: string[] = [];
    for (const town of TOWNS) {
      const is = island(town.island);
      const guarded = new Map<string, string>();
      const guard = (p: Position, what: string): void => {
        guarded.set(key(p.x, p.y, p.z), what);
      };
      for (const n of is.npcs)
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            guard({ x: n.pos.x + dx, y: n.pos.y + dy, z: n.pos.z }, `beside NPC ${n.npc}`);
      for (const s of is.spawns) guard(s.center, `spawn ${s.id}`);
      for (const p of is.portals) {
        guard(p.from, `portal ${p.id}`);
        guard(p.to, `portal ${p.id}`);
      }
      for (const t of is.texts) guard(t.pos, `text ${t.id}`);
      for (const h of is.houses) {
        for (const d of h.doors) guard(d, `door of ${h.id}`);
        guard(h.exit, `exit of ${h.id}`);
      }
      guard(is.meta.temple, "the temple");
      for (const [x, y] of E2E_TILES) guard({ x, y, z: 7 }, "a tile of the e2e test");
      // A bush is solid too (docs/06 "Qué bloquea el paso").
      const props = [...Object.keys(KIT), "brazier", "fountain", "bush"].filter(blocks);
      for (const id of props)
        for (const z of is.meta.floors)
          for (const p of find(is, z, id)) {
            const what = guarded.get(key(p.x, p.y, p.z));
            if (what) wrong.push(`${town.island}: ${id} at ${key(p.x, p.y, p.z)} blocks ${what}`);
          }
    }
    expect(wrong).toEqual([]);
  });
});

describe("the lit caves", () => {
  /**
   * A rock wall whose face shows: an open tile south of it (docs/17 ART-3). Border pieces
   * (docs/06 "Bordes") lie under it.
   */
  const face = (x: number, y: number, z: number): boolean => {
    const s = stack(x, y, z).filter((i) => !i.startsWith("border_"));
    const south = tiles.tile(x, y + 1, z);
    return (
      s[0] === "rock_wall" &&
      s.every((i) => i === "rock_wall" || i === "wall_torch") &&
      !!south?.ground &&
      !south.stack.some((i) => content.items.get(i)?.kind === "wall")
    );
  };

  for (const id of ["puerto", "bosque", "volcan"]) {
    it(`the mine of ${id} has a wall torch every 6 to 8 tiles on its rock faces`, () => {
      const is = island(id);
      const torches = find(is, 8, "wall_torch");
      expect(torches.length).toBeGreaterThan(0);
      const faces: Position[] = [];
      const { x, y, w, h } = is.meta.rect;
      for (let ty = y; ty < y + h; ty++)
        for (let tx = x; tx < x + w; tx++) if (face(tx, ty, 8)) faces.push({ x: tx, y: ty, z: 8 });
      // Each torch hangs on a face (the torch is drawn on the wall's south face).
      for (const t of torches) expect(face(t.x, t.y, t.z), key(t.x, t.y, t.z)).toBe(true);
      // No face is more than 6 tiles from a torch, and no two torches are closer than 6.
      const far = faces.filter((f) => torches.every((t) => chebyshev(f, t) > 6));
      expect(far.map((f) => key(f.x, f.y, f.z))).toEqual([]);
      for (const a of torches)
        for (const b of torches)
          if (a !== b)
            expect(
              chebyshev(a, b),
              `${key(a.x, a.y, 8)} ${key(b.x, b.y, 8)}`,
            ).toBeGreaterThanOrEqual(6);
      // And a brazier lights the deep end of the halls the torches do not reach.
      expect(find(is, 8, "brazier").length).toBeGreaterThan(0);
    });
  }

  it("hangs every wall torch and banner of the world on the face of a wall", () => {
    const wrong: string[] = [];
    for (const [id, is] of world.islands)
      for (const z of is.meta.floors)
        for (const item of ["wall_torch", "wall_banner"])
          for (const p of find(is, z, item)) {
            const s = stack(p.x, p.y, p.z);
            const wall = s
              .slice(0, s.indexOf(item))
              .some((i) => content.items.get(i)?.kind === "wall");
            const south = tiles.tile(p.x, p.y + 1, p.z);
            const open =
              !!south?.ground && !south.stack.some((i) => content.items.get(i)?.kind === "wall");
            if (!wall || !open) wrong.push(`${id}: ${item} at ${key(p.x, p.y, p.z)}`);
          }
    expect(wrong).toEqual([]);
  });
});
