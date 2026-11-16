// The repository's own islands (docs/03 "Islas actuales"): what the validator allows but
// the world should keep. Signs that can be read, the forge gate's sign on the mine side,
// and molten pools shaped like pools.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TileMap,
  doorRoom,
  isWalkable,
  loadContent,
  loadWorld,
  parseYamlText,
} from "@rpg/map-format";
import type { Island, Position } from "@rpg/map-format";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const content = loadContent(repo);
const { world } = loadWorld(repo);
const tiles = new TileMap(world.islands.values());
const island = (id: string): Island => {
  const i = world.islands.get(id);
  if (!i) throw new Error(`no island ${id}`);
  return i;
};
const key = (x: number, y: number): string => `${x},${y}`;

describe("signs (T5.5)", () => {
  it.each(["puerto", "bosque", "volcan"])(
    "every sign of %s has its sign item on its tile, saying its text",
    (id) => {
      const signs = island(id).texts.filter((t) => t.kind === "sign");
      expect(signs.length).toBeGreaterThan(0);
      for (const t of signs) {
        const said = (tiles.tileAt(t.pos)?.stack ?? [])
          .map((item) => content.items.get(item))
          .map((info) => info?.description)
          .filter((text) => text?.startsWith("text."));
        expect(said, `${t.id} at ${t.pos.x},${t.pos.y},${t.pos.z}`).toContain(t.text);
      }
    },
  );

  it("puts the forge gate's sign by the gate on the mine side, and keeps the way open", () => {
    const gate: Position = { x: 3692, y: 5832, z: 8 };
    expect(tiles.tileAt(gate)?.stack).toContain("forge_gate");
    const sign = island("volcan").texts.find((t) => t.text === "text.volcan.gate_sign");
    if (!sign) throw new Error("the forge gate has no sign in volcan/texts.yaml");
    expect(sign.pos.z).toBe(gate.z);
    expect(Math.max(Math.abs(sign.pos.x - gate.x), Math.abs(sign.pos.y - gate.y))).toBeLessThan(3);
    const room = doorRoom(tiles, content, gate);
    if ("error" in room) throw new Error(`the forge gate has no room: ${room.error}`);
    // The sign blocks, so no walk counts its own tile: none of the tiles around it may be
    // in the forge either.
    const behind = new Set(room.rooms.flat().map((p) => key(p.x, p.y)));
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        expect(behind.has(key(sign.pos.x + dx, sign.pos.y + dy))).toBe(false);
    // In front of the gate (where the server test and the E2E stand) stays walkable.
    for (const x of [3691, 3692]) expect(isWalkable(tiles.tile(x, 5831, 8), content)).toBe(true);
  });

  it("says the forge gate is locked with a key, in both languages", () => {
    const text = (lang: string): string => {
      const file = join(repo, "i18n", lang, "world.yaml");
      const doc = parseYamlText(readFileSync(file, "utf8"), file, [])?.data;
      return (doc as Record<string, string> | undefined)?.["text.volcan.gate_sign"] ?? "";
    };
    expect(text("es")).toMatch(/llave/);
    expect(text("es")).not.toMatch(/sin cerradura/);
    expect(text("en")).toMatch(/key/);
    expect(text("en")).not.toMatch(/no lock/);
  });
});

describe("molten pools of the Ember Isle", () => {
  const volcan = island("volcan");
  const z = 7;
  const ground = (x: number, y: number): string | null | undefined => tiles.tile(x, y, z)?.ground;
  const pools: Set<string>[] = [];
  const seen = new Set<string>();
  const { x: rx, y: ry, w, h } = volcan.meta.rect;
  for (let y = ry; y < ry + h; y++)
    for (let x = rx; x < rx + w; x++) {
      if (seen.has(key(x, y)) || ground(x, y) !== "lava") continue;
      const pool = new Set([key(x, y)]);
      const todo: [number, number][] = [[x, y]];
      seen.add(key(x, y));
      for (let next = todo.pop(); next; next = todo.pop()) {
        const [cx, cy] = next;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const k = key(cx + dx, cy + dy);
          if (seen.has(k) || ground(cx + dx, cy + dy) !== "lava") continue;
          seen.add(k);
          pool.add(k);
          todo.push([cx + dx, cy + dy]);
        }
      }
      pools.push(pool);
    }
  const cells = (pool: Set<string>): [number, number][] =>
    [...pool].map((k) => k.split(",").map(Number) as [number, number]);

  it("are six, each a blob rather than a rectangle", () => {
    expect(pools).toHaveLength(6);
    for (const pool of pools) {
      const c = cells(pool);
      const xs = c.map(([x]) => x);
      const ys = c.map(([, y]) => y);
      const box = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
      // The old near-rectangles filled 77–93 % of their box.
      expect(pool.size / box, `pool at ${Math.min(...xs)},${Math.min(...ys)}`).toBeLessThan(0.7);
    }
  });

  it("have a crust rim, no one-tile strips and stay out of the spawns", () => {
    const spawns = volcan.spawns.filter((s) => s.center.z === z);
    for (const pool of pools)
      for (const [x, y] of cells(pool)) {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            expect(["lava", "cooled_lava"], `around ${key(x, y)}`).toContain(
              ground(x + dx, y + dy),
            );
        const inBlock = [
          [0, 0],
          [-1, 0],
          [0, -1],
          [-1, -1],
        ].some(([ox = 0, oy = 0]) =>
          [
            [0, 0],
            [1, 0],
            [0, 1],
            [1, 1],
          ].every(([a = 0, b = 0]) => pool.has(key(x + ox + a, y + oy + b))),
        );
        expect(inBlock, `${key(x, y)} is in no 2x2 block of lava`).toBe(true);
        for (const s of spawns)
          expect(
            Math.max(Math.abs(x - s.center.x), Math.abs(y - s.center.y)),
            `${key(x, y)} in spawn ${s.id}`,
          ).toBeGreaterThan(s.radius);
      }
  });
});
