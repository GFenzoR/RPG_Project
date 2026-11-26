// The step's sound over the real game data (owner, 2026-11-25: "caminé por tierra, piedra
// y pasto y en todos suena igual"): every ground tile of world/ is walked, and the chain
// from its ground item (data/items `ground.surface`) through the living world's surfaces
// (data/livingworld/surfaces.yaml `sound`) to the event and the files of assets/sounds.yaml
// has to hold, with a sample of its own for every surface.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { stepSoundEvents, surfaceLookup } from "../src/render/living.ts";
import { loadClientContent } from "./content.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const content = loadClientContent(REPO);
const lw = content.livingWorld;
if (!lw) throw new Error("no living world data");
const byId = new Map(Object.entries(content.items).map(([n, d]) => [d.id, { n: Number(n), d }]));

interface RawSound {
  file: string;
  channel: string;
  volume: number;
  max_voices?: number;
}
const manifest = parse(readFileSync(join(REPO, "assets", "sounds.yaml"), "utf8")) as {
  sounds: Record<string, RawSound>;
  events: Record<string, string | string[]>;
};
/** A surface name (the living world's `Surface`; this test does not import the module). */
type Surface = NonNullable<ReturnType<typeof surfaceAt>>;
const takesOf = (event: string): string[] => {
  const v = manifest.events[event];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
};

interface Chunk {
  chunk: { cx: number; cy: number; z: number };
  palette: string[];
  ground: number[][];
}

/** Every chunk file of the real map. */
function chunks(): Chunk[] {
  const out: Chunk[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^c\d+_\d+\.json$/.test(e.name))
        out.push(JSON.parse(readFileSync(p, "utf8")) as Chunk);
    }
  };
  walk(join(REPO, "world", "islands"));
  return out;
}

/** The ground item number of every tile of the real map, by "x,y,z". */
const grounds = new Map<string, number>();
for (const c of chunks())
  c.ground.forEach((row, y) =>
    row.forEach((i, x) => {
      const id = c.palette[i];
      const item = id === undefined ? undefined : byId.get(id);
      if (item) grounds.set(`${c.chunk.cx * 32 + x},${c.chunk.cy * 32 + y},${c.chunk.z}`, item.n);
    }),
  );
/** The world as the client's glue reads it. */
const world = {
  tile: (x: number, y: number, z: number): readonly number[] | undefined => {
    const g = grounds.get(`${x},${y},${z}`);
    return g === undefined ? undefined : [g];
  },
};
const surfaceAt = surfaceLookup(world, content);
const eventsAt = stepSoundEvents(world, content);

const sha = (file: string): string =>
  createHash("sha1")
    .update(readFileSync(join(REPO, "assets", file)))
    .digest("hex");

describe("the step's sound over the real map", () => {
  /** Walkable tiles by surface, and one tile of each. */
  const tiles = new Map<Surface, { n: number; at: [number, number, number] }>();
  for (const [key, n] of grounds) {
    const item = content.items[n];
    if (!item?.walkable) continue;
    const [x, y, z] = key.split(",").map(Number) as [number, number, number];
    const s = surfaceAt(x, y, z);
    if (!s) continue;
    const t = tiles.get(s);
    if (t) t.n++;
    else tiles.set(s, { n: 1, at: [x, y, z] });
  }

  it("has a real map to walk", () => {
    expect(grounds.size).toBeGreaterThan(10_000);
  });

  it("knows the surface of every walkable ground tile of the map", () => {
    const missing = new Set<string>();
    for (const [key, n] of grounds) {
      const item = content.items[n];
      if (!item?.walkable) continue;
      const [x, y, z] = key.split(",").map(Number) as [number, number, number];
      if (!surfaceAt(x, y, z)) missing.add(item.id);
    }
    expect([...missing]).toEqual([]);
  });

  it("gives each ground item the surface it looks like", () => {
    const surface = (id: string): string | undefined => byId.get(id)?.d.surface;
    expect(surface("grass")).toBe("grass");
    expect(surface("dirt")).toBe("dirt");
    expect(surface("sand")).toBe("sand");
    expect(surface("wet_sand")).toBe("wet_sand");
    expect(surface("ash")).toBe("ash");
    for (const id of ["stone_floor", "basalt", "cinder_path", "cooled_lava"])
      expect(surface(id), id).toBe("stone");
    for (const id of ["dock_planks", "wooden_floor"]) expect(surface(id), id).toBe("wood");
  });

  it("walks grass, dirt and stone on the real map, and each plays its own sample", () => {
    const files = new Map<string, string>();
    for (const s of ["grass", "dirt", "stone"] as const) {
      const t = tiles.get(s);
      expect(t?.n ?? 0, `walkable ${s} tiles in world/`).toBeGreaterThan(50);
      if (!t) continue;
      const events = eventsAt({ x: t.at[0], y: t.at[1], z: t.at[2] });
      expect(events).toEqual([`step.self.${s}`, "step.self"]);
      // The engine plays the first event sounds.yaml maps: the surface's own.
      const takes = takesOf(events[0] as string);
      expect(takes.length, s).toBeGreaterThanOrEqual(3);
      for (const take of takes) {
        const file = manifest.sounds[take]?.file ?? "";
        expect(file, take).toContain(`/steps/${s}_`);
        files.set(sha(file), s);
      }
    }
    // Nine different recordings, three per surface: none shared.
    expect(files.size).toBe(9);
  });

  it("plays a sample of its own on every surface the map has, three takes each", () => {
    const owner = new Map<string, string>();
    for (const [s, t] of tiles) {
      const event = eventsAt({ x: t.at[0], y: t.at[1], z: t.at[2] })[0] as string;
      expect(event).toBe(`step.self.${lw.surfaces[s]?.sound ?? s}`);
      const takes = takesOf(event);
      expect(takes.length, `${s} (${t.n} tiles): ${event}`).toBeGreaterThanOrEqual(3);
      expect(new Set(takes).size, event).toBe(takes.length);
      for (const take of takes) {
        const def = manifest.sounds[take];
        expect(def, take).toBeDefined();
        if (!def) continue;
        expect(existsSync(join(REPO, "assets", def.file)), def.file).toBe(true);
        expect(def.channel).toBe("sfx");
        const h = sha(def.file);
        expect(owner.get(h) ?? s, `${def.file} is also the sample of another surface`).toBe(s);
        owner.set(h, s);
      }
    }
    // The map has the grounds the owner walked, and more.
    for (const s of ["grass", "dirt", "stone", "sand", "wood"] as const)
      expect(tiles.has(s), s).toBe(true);
  });

  it("changes the sample where the ground changes: neighbours of another surface exist", () => {
    let borders = 0;
    for (const [key] of grounds) {
      const [x, y, z] = key.split(",").map(Number) as [number, number, number];
      const a = surfaceAt(x, y, z);
      const b = surfaceAt(x + 1, y, z);
      if (!a || !b || a === b) continue;
      if ((a === "grass" && b === "dirt") || (a === "dirt" && b === "grass")) {
        borders++;
        expect(eventsAt({ x, y, z })[0]).not.toBe(eventsAt({ x: x + 1, y, z })[0]);
      }
    }
    expect(borders).toBeGreaterThan(10);
  });

  it("keeps steps a quiet background: one number, under the ambience and far under a hit", () => {
    const steps = lw.steps;
    expect(steps).toBeDefined();
    if (!steps) return;
    const volumes = new Set<number>();
    for (const [id, def] of Object.entries(manifest.sounds))
      if (id.startsWith("step_")) volumes.add(def.volume);
    // Every surface take at the same level in sounds.yaml: surfaces.yaml `steps.volume`
    // is the one knob.
    expect(volumes.size).toBe(1);
    const base = [...volumes][0] ?? 1;
    const loudest = base * steps.volume * Math.max(steps.left.gain, steps.right.gain);
    expect(loudest).toBeLessThanOrEqual(0.12);
    expect(loudest).toBeGreaterThan(0.04); // still heard
    expect(loudest).toBeLessThan((manifest.sounds["hit"]?.volume ?? 1) / 5);
    for (const [id, def] of Object.entries(manifest.sounds))
      if (def.channel === "music") expect(loudest, id).toBeLessThan(def.volume / 5);
    // Two feet a tile, three takes: a take may overlap its own tail once.
    for (const [id, def] of Object.entries(manifest.sounds))
      if (id.startsWith("step_")) expect(def.max_voices ?? 1, id).toBeGreaterThanOrEqual(2);
  });
});
