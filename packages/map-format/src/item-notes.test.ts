// The books and chests of data/items (docs/02 "Libros y cofres") say in their notes where they
// stand on the map. Those notes guide whoever moves or reuses them (and docs/16 repeats them),
// so every "(x,y,z)" in them must be a tile of the repository world that holds that item.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { stackAt } from "./chunk.ts";
import { loadWorld } from "./io.ts";
import { CHUNK_SIZE, chunkKey } from "./types.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));

interface NotedItem {
  id: string;
  notes: string;
}

/** The items of data/items with a book or chest block and notes. */
function notedItems(): NotedItem[] {
  const dir = join(repo, "data", "items");
  const out: NotedItem[] = [];
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".yaml"))
    .sort()) {
    const items: unknown = parse(readFileSync(join(dir, name), "utf8"));
    if (!Array.isArray(items)) continue;
    for (const it of items as Record<string, unknown>[]) {
      if ((it["book"] || it["chest"]) && typeof it["notes"] === "string")
        out.push({ id: String(it["id"]), notes: it["notes"] });
    }
  }
  return out;
}

describe("the notes of books and chests", () => {
  it("name tiles that hold the item", () => {
    const { world } = loadWorld(repo);
    const holds = (id: string, x: number, y: number, z: number): boolean => {
      const key = chunkKey(z, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
      for (const island of world.islands.values()) {
        const chunk = island.chunks.get(key);
        if (chunk && stackAt(chunk, x % CHUNK_SIZE, y % CHUNK_SIZE).includes(id)) return true;
      }
      return false;
    };
    const items = notedItems();
    expect(items.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const { id, notes } of items) {
      const places = [...notes.matchAll(/\((\d+),(\d+),(\d+)\)/g)];
      if (places.length === 0) wrong.push(`${id}: no (x,y,z) in its notes`);
      for (const [text, x, y, z] of places)
        if (!holds(id, Number(x), Number(y), Number(z))) wrong.push(`${id} is not at ${text}`);
    }
    expect(wrong).toEqual([]);
  });
});
