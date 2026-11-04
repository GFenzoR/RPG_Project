// Guardrails for data/vocations.yaml and the skill section of data/balance.yaml.
//
// The numbers are ours (CLAUDE.md legal rule), but they must keep the roles from
// docs/02-game-design.md: the guardian is the melee tank, the arcanist the fragile caster
// of area damage, the ranger (T3.1) the distance hybrid and the druid (T3.1) the healer;
// skills level at a pace a player of classic tile MMORPGs finds familiar. The pace bands
// below are sanity limits, not exact targets: retune freely inside them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

interface Stats {
  health: number;
  mana: number;
  capacity: number;
  speed: number;
}

interface Vocation {
  id: string;
  start: Stats;
  per_level: Stats;
  skill_factors: Record<string, number>;
}

interface SkillBase {
  start_level: number;
  base_tries: number;
}

const vocations = parse(readFileSync(join(REPO, "data/vocations.yaml"), "utf8")) as Vocation[];
const balance = parse(readFileSync(join(REPO, "data/balance.yaml"), "utf8")) as {
  skills: { base: Record<string, SkillBase> };
};

interface Scaling {
  base: number;
  per_level?: number;
  per_magic_level?: number;
  skill?: string;
  per_skill?: number;
}

interface Spell {
  id: string;
  vocations: string[];
  effect: {
    heal?: Scaling & { range?: number };
    damage?: Scaling & { range?: number; radius?: number };
  };
}

const spells = parse(readFileSync(join(REPO, "data/spells.yaml"), "utf8")) as Spell[];

/** Amount of s (no spread) at level, magic level and weapon skill level. */
function amount(s: Scaling, level: number, magic: number, skill: number): number {
  return (
    s.base +
    level * (s.per_level ?? 0) +
    magic * (s.per_magic_level ?? 0) +
    (s.skill ? skill * (s.per_skill ?? 0) : 0)
  );
}

function vocation(id: string): Vocation {
  const v = vocations.find((x) => x.id === id);
  if (!v) throw new Error(`vocation ${id} missing from data/vocations.yaml`);
  return v;
}

/** Tries (or mana spent, for magic) to go from the skill's start level to `target`. */
function triesTo(voc: Vocation, skill: string, target: number): number {
  const base = balance.skills.base[skill];
  const factor = voc.skill_factors[skill];
  if (!base || factor === undefined) throw new Error(`no data for skill ${skill}`);
  let total = 0;
  for (let n = base.start_level; n < target; n++) {
    total += base.base_tries * factor ** (n - base.start_level);
  }
  return total;
}

const guardian = vocation("guardian");
const arcanist = vocation("arcanist");
const ranger = vocation("ranger");
const druid = vocation("druid");
const ALL = [guardian, arcanist, ranger, druid];
const MELEE = ["sword", "axe", "club"];

describe("vocation roles", () => {
  it("guardian gains much more health per level, arcanist much more mana", () => {
    expect(guardian.per_level.health).toBeGreaterThanOrEqual(2 * arcanist.per_level.health);
    expect(arcanist.per_level.mana).toBeGreaterThanOrEqual(5 * guardian.per_level.mana);
  });

  it("guardian trains melee and shield faster, arcanist trains magic faster", () => {
    for (const skill of [...MELEE, "shield", "fist"]) {
      expect(guardian.skill_factors[skill], skill).toBeLessThan(arcanist.skill_factors[skill] ?? 0);
    }
    expect(arcanist.skill_factors.magic).toBeLessThan(guardian.skill_factors.magic ?? 0);
  });

  it("the ranger trains distance fastest and shield nearly like a guardian", () => {
    for (const v of [guardian, arcanist, druid]) {
      expect(ranger.skill_factors.distance, v.id).toBeLessThan(v.skill_factors.distance ?? 0);
    }
    expect(ranger.skill_factors.shield).toBeLessThanOrEqual(
      (guardian.skill_factors.shield ?? 0) * 1.05,
    );
    // A hybrid: more magic than the guardian, much less than the casters.
    expect(ranger.skill_factors.magic).toBeLessThan(guardian.skill_factors.magic ?? 0);
    expect(ranger.skill_factors.magic).toBeGreaterThan(druid.skill_factors.magic ?? 0);
  });

  it("the ranger sits between tank and caster in health and mana per level", () => {
    expect(ranger.per_level.health).toBeLessThan(guardian.per_level.health);
    expect(ranger.per_level.health).toBeGreaterThan(arcanist.per_level.health);
    expect(ranger.per_level.mana).toBeGreaterThan(guardian.per_level.mana);
    expect(ranger.per_level.mana).toBeLessThan(arcanist.per_level.mana);
  });

  it("the druid trains magic as fast as the arcanist, faster than the others", () => {
    expect(druid.skill_factors.magic).toBeLessThanOrEqual(arcanist.skill_factors.magic ?? 0);
    for (const v of [guardian, ranger]) {
      expect(druid.skill_factors.magic, v.id).toBeLessThan(v.skill_factors.magic ?? 0);
    }
    expect(druid.per_level.mana).toBeGreaterThanOrEqual(5 * guardian.per_level.mana);
    expect(guardian.per_level.health).toBeGreaterThanOrEqual(2 * druid.per_level.health);
  });

  it("fishing never trains slower than the guardian's main melee skill", () => {
    const fastestMelee = Math.min(...MELEE.map((s) => guardian.skill_factors[s] ?? Infinity));
    for (const v of ALL) {
      expect(v.skill_factors.fishing, v.id).toBeLessThanOrEqual(fastestMelee);
    }
  });
});

describe("skill pace bands", () => {
  it.each([
    ["guardian", "sword", 50, 15_000, 45_000],
    ["guardian", "shield", 50, 30_000, 90_000],
    ["guardian", "fishing", 50, 5_000, 25_000],
    ["arcanist", "magic", 30, 150_000, 500_000],
    ["arcanist", "fishing", 50, 5_000, 25_000],
    ["ranger", "distance", 50, 12_000, 40_000],
    ["ranger", "shield", 50, 30_000, 120_000],
    ["druid", "magic", 30, 150_000, 500_000],
    ["druid", "fishing", 50, 5_000, 25_000],
  ] as const)("%s %s to %i takes %i-%i tries", (voc, skill, target, min, max) => {
    const tries = triesTo(vocation(voc), skill, target);
    expect(tries).toBeGreaterThanOrEqual(min);
    expect(tries).toBeLessThanOrEqual(max);
  });
});

describe("spell roles", () => {
  // A mid-game character of each vocation: level 30 with the magic level and weapon skill
  // its vocation reaches there (rough, but in the right order).
  const profile: Record<string, { magic: number; skill: number }> = {
    guardian: { magic: 4, skill: 60 },
    arcanist: { magic: 40, skill: 15 },
    ranger: { magic: 12, skill: 60 },
    druid: { magic: 40, skill: 15 },
  };
  const castBy = (v: string): Spell[] => spells.filter((s) => s.vocations.includes(v));
  const best = (v: string, pick: (s: Spell) => Scaling | undefined): number => {
    const p = profile[v];
    if (!p) throw new Error(`no profile for ${v}`);
    const amounts = castBy(v).flatMap((s) => {
      const sc = pick(s);
      return sc ? [amount(sc, 30, p.magic, p.skill)] : [];
    });
    return Math.max(0, ...amounts);
  };

  it("every vocation but the guardian has 3-5 spells of its own", () => {
    // Own = only it casts them; the support spells every vocation shares (haste and the
    // poison cure, T3.2) do not count.
    const own = (v: string) => castBy(v).filter((s) => s.vocations.length === 1);
    for (const v of ["arcanist", "ranger", "druid"]) {
      expect(own(v).length, v).toBeGreaterThanOrEqual(3);
      expect(own(v).length, v).toBeLessThanOrEqual(5);
    }
  });

  it("the druid is the best healer and the only one that heals others", () => {
    const heal = (s: Spell) => s.effect.heal;
    for (const v of ["arcanist", "ranger"]) {
      expect(best("druid", heal), v).toBeGreaterThan(1.25 * best(v, heal));
    }
    const healers = spells
      .filter((s) => (s.effect.heal?.range ?? 0) > 0)
      .flatMap((s) => s.vocations);
    expect(new Set(healers)).toEqual(new Set(["druid"]));
  });

  it("the ranger's spells scale with distance and it has the longest single-target reach", () => {
    const rangerDamage = castBy("ranger").filter((s) => s.effect.damage);
    expect(rangerDamage.length).toBeGreaterThan(0);
    for (const s of rangerDamage) expect(s.effect.damage?.skill, s.id).toBe("distance");
    const reach = (v: string) => Math.max(0, ...castBy(v).map((s) => s.effect.damage?.range ?? 0));
    for (const v of ["arcanist", "druid"]) expect(reach("ranger"), v).toBeGreaterThan(reach(v));
  });

  it("the arcanist keeps the strongest area damage", () => {
    const area = (s: Spell) => (s.effect.damage?.radius ? s.effect.damage : undefined);
    const radius = (v: string) =>
      Math.max(0, ...castBy(v).map((s) => s.effect.damage?.radius ?? 0));
    expect(best("arcanist", area)).toBeGreaterThan(best("druid", area));
    expect(radius("arcanist")).toBeGreaterThan(radius("druid"));
  });
});
