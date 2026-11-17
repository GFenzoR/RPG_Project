// Content audit M1: the world must feed about 100 concurrent players (docs/00-vision.md),
// spread over the level bands (docs/07-performance-budget.md, "Capacidad del mundo").
//
// The XP an hour the server can give for a monster is Σ count × 3600 / respawn_seconds ×
// experience over its spawns on the production islands (world/world.yaml, not dev_only).
// One player of a band needs (xp(hi) − xp(lo)) / (hours(hi) − hours(lo)) an hour, with the
// curve and the pace of data/balance.yaml (a power law between the pace anchors). Nobody
// kills a monster the instant it respawns (walking, looting, healing, and a monster never
// respawns on a tile a player sees), so only EFFICIENCY of that XP counts. A band holds
// players = Σ XP/h of its monsters × EFFICIENCY / XP/h of one player, and must reach its
// target. Wood is checked the same way: birch logs an hour of the placed birch trees.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

/** The share of the theoretical XP a hunter really takes (see above). */
const EFFICIENCY = 2 / 3;

/**
 * Target concurrent players by level band (sum 100) and the monsters that feed each band.
 * Every monster spawned on a production island belongs to exactly one band.
 */
const BANDS: { levels: [number, number]; players: number; monsters: string[] }[] = [
  {
    levels: [1, 8],
    players: 15,
    monsters: ["thieving_gull", "tide_crab", "wolf", "bilge_rat", "gloom_bat"],
  },
  {
    levels: [8, 15],
    players: 15,
    monsters: ["bristleback_boar", "moss_spider", "wreck_looter", "ore_beetle", "drowned_miner"],
  },
  { levels: [15, 20], players: 14, monsters: ["bramble_stag", "mire_toad", "thornling"] },
  { levels: [20, 25], players: 14, monsters: ["coffer_smuggler", "hollow_crawler"] },
  { levels: [25, 40], players: 16, monsters: ["ash_hound", "cinder_salamander"] },
  { levels: [40, 50], players: 14, monsters: ["obsidian_delver", "slag_golem"] },
  { levels: [50, 60], players: 12, monsters: ["ember_wyrmling", "slagbound_warden"] },
];

/** Birch logs an hour the production map must give (iron ingots and cooking use them). */
const MIN_BIRCH_LOGS_PER_HOUR = 600;

interface Pace {
  level: number;
  hours: number;
}

interface Spawn {
  id: string;
  respawn_seconds: number;
  monsters: { monster: string; count: number }[];
}

interface Chunk {
  palette: string[];
  items: { stack: number[] }[];
}

const yaml = <T>(rel: string): T => parse(readFileSync(join(REPO, rel), "utf8")) as T;

const balance = yaml<{
  experience: { curve: { a: number; b: number; c: number; d?: number }; pace: Pace[] };
}>("data/balance.yaml");

const world = yaml<{ islands: { id: string; dev_only?: boolean }[] }>("world/world.yaml");
const production = world.islands.filter((i) => i.dev_only !== true).map((i) => i.id);

function totalXp(level: number): number {
  const { a, b, c, d = 0 } = balance.experience.curve;
  return a * level ** 3 + b * level ** 2 + c * level + d;
}

/** Hours of play to reach level: a power law between consecutive pace anchors. */
function hours(level: number): number {
  const pace = balance.experience.pace;
  let i = 0;
  while (i < pace.length - 2 && level > (pace[i + 1]?.level ?? 0)) i++;
  const lo = pace[i];
  const hi = pace[i + 1];
  if (!lo || !hi) throw new Error("balance.yaml experience.pace needs two anchors");
  const k = Math.log(hi.hours / lo.hours) / Math.log(hi.level / lo.level);
  return lo.hours * (level / lo.level) ** k;
}

/** XP an hour one player of the band needs to follow the pace. */
function xpPerPlayer(levels: [number, number]): number {
  const [lo, hi] = levels;
  return (totalXp(hi) - totalXp(lo)) / (hours(hi) - hours(lo));
}

const experience = new Map<string, number>();
for (const f of readdirSync(join(REPO, "data/monsters")).filter((f) => f.endsWith(".yaml"))) {
  const m = yaml<{ id: string; experience: number }>(`data/monsters/${f}`);
  experience.set(m.id, m.experience);
}

/** Theoretical XP an hour of each monster over its production spawns. */
const xpPerHour = new Map<string, number>();
for (const island of production) {
  const rel = `world/islands/${island}/spawns.yaml`;
  if (!existsSync(join(REPO, rel))) continue;
  for (const s of yaml<Spawn[] | null>(rel) ?? [])
    for (const m of s.monsters) {
      const xp = experience.get(m.monster);
      if (xp === undefined) throw new Error(`${s.id}: unknown monster ${m.monster}`);
      xpPerHour.set(
        m.monster,
        (xpPerHour.get(m.monster) ?? 0) + (m.count * 3600 * xp) / s.respawn_seconds,
      );
    }
}

/** Placed items of the production maps, by id. */
function placed(id: string): number {
  let n = 0;
  for (const island of production) {
    const dir = join(REPO, "world/islands", island, "chunks");
    if (!existsSync(dir)) continue;
    for (const floor of readdirSync(dir))
      for (const f of readdirSync(join(dir, floor))) {
        if (!f.endsWith(".json")) continue;
        const c = JSON.parse(readFileSync(join(dir, floor, f), "utf8")) as Chunk;
        const at = c.palette.indexOf(id);
        if (at < 0) continue;
        for (const it of c.items) n += it.stack.filter((p) => p === at).length;
      }
  }
  return n;
}

describe("world capacity (content audit M1)", () => {
  it("puts every production monster in exactly one band", () => {
    const listed = BANDS.flatMap((b) => b.monsters);
    expect(new Set(listed).size, "a monster in two bands").toBe(listed.length);
    for (const id of xpPerHour.keys()) expect(listed, `${id} is in no band`).toContain(id);
  });

  it("aims at about 100 players in all", () => {
    expect(BANDS.reduce((n, b) => n + b.players, 0)).toBe(100);
  });

  it.each(BANDS)("levels $levels: room for $players players", (band) => {
    const xp = band.monsters.reduce((n, m) => n + (xpPerHour.get(m) ?? 0), 0);
    const players = (xp * EFFICIENCY) / xpPerPlayer(band.levels);
    expect(players, `${Math.round(xp)} XP/h for the band`).toBeGreaterThanOrEqual(band.players);
  });

  it(`gives at least ${MIN_BIRCH_LOGS_PER_HOUR} birch logs an hour`, () => {
    const birch = yaml<{ id: string; resource?: { charges: number; regen_ms: number } }[]>(
      "data/items/decoration.yaml",
    ).find((i) => i.id === "birch_tree");
    const res = birch?.resource;
    if (!res) throw new Error("birch_tree has no resource block");
    const logs = (placed("birch_tree") * res.charges * 3_600_000) / res.regen_ms;
    expect(logs).toBeGreaterThanOrEqual(MIN_BIRCH_LOGS_PER_HOUR);
  });
});
