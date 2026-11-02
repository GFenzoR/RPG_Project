// Balance check for the Isla del Puerto bestiary (levels 1-15, Chapter 1).
//
// Combat is not implemented yet (T1.6), so this test runs a small, deterministic Monte
// Carlo model of melee combat built from docs/02-game-design.md and the numbers in data/.
// The model's constants are provisional and live in COMBAT below; when T1.6 lands the real
// formula in Go, port these targets to server/internal/sim/balance_test.go and delete the
// model here.
//
// Targets (skill add-monster + balance.yaml pace):
// - Each monster, fought by a guardian at its target level with that level's kit, lasts
//   5-15 s and costs the player 10-40 % of max health.
// - Hunting the island's best monster for each level reaches level 8 in ~1 h and level 15
//   in ~3.6 h (the curve's interpolation between "8 in 1 h" and "20 in 8 h").
// - XP grows with the monster's target level, and loot stays a small gold faucet.
//
// DEBUG_BALANCE=1 prints the per-monster table.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

// ---- content -------------------------------------------------------------------------

interface Attack {
  type: "melee" | "distance" | "spell";
  element?: string;
  min: number;
  max: number;
  interval_ms: number;
  chance?: number;
}

interface Monster {
  id: string;
  health: number;
  experience: number;
  armor?: number;
  defense?: number;
  attacks: Attack[];
  resistances?: Record<string, number>;
  loot?: { item: string; chance: number; count?: [number, number] }[];
  tags?: string[];
}

interface Item {
  id: string;
  value?: number;
  weapon?: { attack: number; defense?: number };
  armor?: { armor: number };
  shield?: { defense: number };
}

interface Vocation {
  id: string;
  start: { health: number };
  per_level: { health: number };
}

interface Balance {
  experience: { curve: { a: number; b: number; c: number } };
}

const readYaml = <T>(rel: string): T => parse(readFileSync(join(REPO, rel), "utf8")) as T;

const monsters = new Map<string, Monster>(
  readdirSync(join(REPO, "data/monsters"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => readYaml<Monster>(`data/monsters/${f}`))
    .map((m) => [m.id, m]),
);
const items = new Map<string, Item>(
  readdirSync(join(REPO, "data/items"))
    .filter((f) => f.endsWith(".yaml"))
    .flatMap((f) => readYaml<Item[]>(`data/items/${f}`))
    .map((i) => [i.id, i]),
);
const guardian = readYaml<Vocation[]>("data/vocations.yaml").find((v) => v.id === "guardian");
const curve = readYaml<Balance>("data/balance.yaml").experience.curve;

function item(id: string): Item {
  const it = items.get(id);
  if (!it) throw new Error(`unknown item ${id}`);
  return it;
}

function xpForLevel(n: number): number {
  return curve.a * n ** 3 + curve.b * n ** 2 + curve.c * n;
}

// ---- provisional combat model ---------------------------------------------------------

const COMBAT = {
  playerAttackMs: 2000,
  /** Max melee hit = skill * attack / skillAttackDivisor + level / levelDivisor. */
  skillAttackDivisor: 10,
  levelDivisor: 4,
  /** Expected melee skill of a guardian who hunts at each level: start + perLevel*(L-1). */
  skillStart: 10,
  skillPerLevel: 1.5,
  /** Shield blocks up to defense / shieldBlockDivisor per physical hit. */
  shieldBlockDivisor: 4,
  /** Walking, looting and short rests between kills. */
  overheadSeconds: 15,
  fights: 400,
  maxFightMs: 120_000,
};

/** Expected kit by level: what the island's shops and loot provide at that point. */
function kitFor(level: number): { weapon: string; armor: string[]; shield: string } {
  if (level >= 10)
    return {
      weapon: "boarding_saber",
      armor: ["sailcloth_cap", "leather_jerkin", "canvas_trousers", "tarred_boots"],
      shield: "riveted_round_shield",
    };
  if (level >= 5)
    return {
      weapon: "iron_sword",
      armor: ["sailcloth_cap", "patched_tunic", "canvas_trousers", "tarred_boots"],
      shield: "plank_shield",
    };
  return { weapon: "rusty_cutlass", armor: ["patched_tunic"], shield: "barrel_lid_shield" };
}

/** mulberry32: small seeded PRNG so every run gives the same numbers. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const roll = (r: () => number, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));

interface FightStats {
  seconds: number;
  damagePct: number;
}

function simulate(m: Monster, level: number, seed = 1): FightStats {
  if (!guardian) throw new Error("guardian vocation missing");
  const r = rng(seed);
  const kit = kitFor(level);
  const weapon = item(kit.weapon).weapon;
  if (!weapon) throw new Error(`${kit.weapon} is not a weapon`);
  const armor = kit.armor.reduce((s, id) => s + (item(id).armor?.armor ?? 0), 0);
  const shieldDef = item(kit.shield).shield?.defense ?? 0;
  const maxHp = guardian.start.health + guardian.per_level.health * (level - 1);
  const skill = COMBAT.skillStart + Math.floor(COMBAT.skillPerLevel * (level - 1));
  const maxHit = Math.floor(
    (skill * weapon.attack) / COMBAT.skillAttackDivisor + level / COMBAT.levelDivisor,
  );
  const physRes = (m.resistances?.["physical"] ?? 0) / 100;
  const mArmor = m.armor ?? 0;
  const mDef = m.defense ?? 0;

  let totalMs = 0;
  let totalDmg = 0;
  for (let f = 0; f < COMBAT.fights; f++) {
    let hp = m.health;
    let taken = 0;
    let t = 0;
    let nextPlayer = 0;
    const nextMonster = m.attacks.map((a) => a.interval_ms);
    while (hp > 0 && t < COMBAT.maxFightMs) {
      const tMonster = Math.min(...nextMonster);
      if (nextPlayer <= tMonster) {
        t = nextPlayer;
        const raw = Math.round(roll(r, 0, maxHit) * (1 - physRes));
        const reduced =
          raw - roll(r, Math.floor(mArmor / 2), mArmor) - roll(r, 0, Math.floor(mDef / 2));
        hp -= Math.max(0, reduced);
        nextPlayer += COMBAT.playerAttackMs;
      } else {
        t = tMonster;
        m.attacks.forEach((a, i) => {
          if (nextMonster[i] !== tMonster) return;
          nextMonster[i] = tMonster + a.interval_ms;
          if (r() >= (a.chance ?? 1)) return;
          let dmg = roll(r, a.min, a.max);
          const physical = (a.element ?? "physical") === "physical";
          if (physical) {
            dmg -= roll(r, Math.floor(armor / 2), armor);
            dmg -= roll(r, 0, Math.floor(shieldDef / COMBAT.shieldBlockDivisor));
          }
          taken += Math.max(0, dmg);
        });
      }
    }
    totalMs += t;
    totalDmg += taken;
  }
  return {
    seconds: totalMs / COMBAT.fights / 1000,
    damagePct: (100 * totalDmg) / COMBAT.fights / maxHp,
  };
}

function xpPerHour(m: Monster, level: number): number {
  const s = simulate(m, level);
  return (m.experience * 3600) / (s.seconds + COMBAT.overheadSeconds);
}

function lootValue(m: Monster): number {
  return (m.loot ?? []).reduce((sum, l) => {
    const [lo, hi] = l.count ?? [1, 1];
    return sum + l.chance * ((lo + hi) / 2) * (item(l.item).value ?? 0);
  }, 0);
}

// ---- targets --------------------------------------------------------------------------

/** Level a guardian should be to hunt each Puerto monster comfortably. */
const TARGET_LEVEL: Record<string, number> = {
  bilge_rat: 1,
  thieving_gull: 2,
  wolf: 4,
  gloom_bat: 4,
  tide_crab: 5,
  bristleback_boar: 7,
  moss_spider: 8,
  wreck_looter: 10,
  ore_beetle: 12,
  drowned_miner: 14,
};

/**
 * Level 1-2 pests: a fresh guardian has 150 health, so they are meant to be nearly
 * harmless (2-40 % instead of the 10-40 % band of a common monster).
 */
const PESTS = new Set(["bilge_rat", "thieving_gull"]);

describe("Isla del Puerto balance", () => {
  const puerto = [...monsters.values()].filter((m) => m.tags?.includes("puerto"));

  if (process.env["DEBUG_BALANCE"]) {
    const rows = puerto.map((m) => {
      const lvl = TARGET_LEVEL[m.id] ?? 0;
      const s = simulate(m, lvl);
      return {
        id: m.id,
        lvl,
        seconds: +s.seconds.toFixed(1),
        dmgPct: +s.damagePct.toFixed(1),
        xph: Math.round(xpPerHour(m, lvl)),
        lootPerKill: +lootValue(m).toFixed(1),
      };
    });
    console.table(rows);
  }

  it("has a target level for every Puerto monster", () => {
    for (const m of puerto) expect(TARGET_LEVEL[m.id], m.id).toBeDefined();
    expect(puerto.length).toBeGreaterThanOrEqual(8);
  });

  it.each(Object.entries(TARGET_LEVEL))(
    "%s at level %i: 5-15 s of combat, health loss within its tier band",
    (id, level) => {
      const m = monsters.get(id);
      expect(m, id).toBeDefined();
      if (!m) return;
      const s = simulate(m, level);
      expect(s.seconds).toBeGreaterThanOrEqual(5);
      expect(s.seconds).toBeLessThanOrEqual(15);
      expect(s.damagePct).toBeGreaterThanOrEqual(PESTS.has(id) ? 2 : 10);
      expect(s.damagePct).toBeLessThanOrEqual(40);
    },
  );

  it("gives more experience to monsters meant for higher levels", () => {
    // Every pair, not just neighbours: monsters sharing a target level must not hide
    // an inversion against the levels around them.
    const entries = Object.entries(TARGET_LEVEL);
    for (const [lowId, lowLvl] of entries) {
      for (const [highId, highLvl] of entries) {
        if (highLvl <= lowLvl) continue;
        const low = monsters.get(lowId)?.experience ?? 0;
        const high = monsters.get(highId)?.experience ?? 0;
        expect(high, `${highId} (level ${highLvl}) vs ${lowId} (level ${lowLvl})`).toBeGreaterThan(
          low,
        );
      }
    }
  });

  it("follows the balance.yaml pace: level 8 in ~1 h, level 15 in ~3.6 h", () => {
    // Each level, hunt the best monster whose target level is at most the player's level.
    const hoursTo = (goal: number): number => {
      let hours = 0;
      for (let lvl = 1; lvl < goal; lvl++) {
        const best = Math.max(
          ...Object.entries(TARGET_LEVEL)
            .filter(([, t]) => t <= lvl)
            .map(([id]) => {
              const m = monsters.get(id);
              return m ? xpPerHour(m, lvl) : 0;
            }),
        );
        hours += (xpForLevel(lvl + 1) - xpForLevel(lvl)) / best;
      }
      return hours;
    };
    const to8 = hoursTo(8);
    const to15 = hoursTo(15);
    if (process.env["DEBUG_BALANCE"]) console.log({ to8, to15 });
    expect(to8).toBeGreaterThanOrEqual(0.6);
    expect(to8).toBeLessThanOrEqual(1.5);
    expect(to15).toBeGreaterThanOrEqual(2.5);
    expect(to15).toBeLessThanOrEqual(5);
  });

  it("keeps loot a small gold faucet (0.1-1.5 copper per XP)", () => {
    for (const id of Object.keys(TARGET_LEVEL)) {
      const m = monsters.get(id);
      if (!m) continue;
      const ratio = lootValue(m) / m.experience;
      expect(ratio, id).toBeGreaterThanOrEqual(0.1);
      expect(ratio, id).toBeLessThanOrEqual(1.5);
    }
  });
});
