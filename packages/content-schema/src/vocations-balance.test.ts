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
  level: number;
  magic_level?: number;
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

describe("each vocation trains its own skills, the others slowly", () => {
  // Vocation identity (owner's request, 2026-11-23): an arcanist trains the sword much
  // slower than a guardian. Tries to reach skill 30 (magic level 15) against the vocation
  // that trains it fastest; the table is in docs/02 "Vocaciones".
  const OWN: Record<string, string[]> = {
    guardian: [...MELEE, "shield"],
    arcanist: ["magic"],
    druid: ["magic"],
    ranger: ["distance", "shield"],
  };
  const target = (skill: string) => (skill === "magic" ? 15 : 30);
  const fastest = (skill: string) => Math.min(...ALL.map((v) => triesTo(v, skill, target(skill))));
  it.each(Object.entries(OWN))("%s trains its own skills fastest", (id, own) => {
    for (const skill of own) {
      // The ranger's shield is almost the guardian's (at most 1.2 times its tries).
      const slack = id === "ranger" && skill === "shield" ? 1.2 : 1;
      expect(triesTo(vocation(id), skill, target(skill)), skill).toBeLessThanOrEqual(
        slack * fastest(skill),
      );
    }
  });
  it.each(Object.entries(OWN))("the others need many more tries for %s's skills", (id, own) => {
    for (const skill of own) {
      for (const v of ALL) {
        if (OWN[v.id]?.includes(skill)) continue;
        // The ranger trains melee as a hybrid: about 4-5 times the guardian's tries; any
        // other vocation outside its role, at least 15 times.
        const min = v.id === "ranger" && MELEE.includes(skill) ? 3 : 15;
        expect(triesTo(v, skill, target(skill)), `${v.id} ${skill}`).toBeGreaterThanOrEqual(
          min * fastest(skill),
        );
      }
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
  // The magic level each vocation has on reaching these levels in the career simulation
  // of server/internal/sim/balance_vocations_test.go (DEBUG_BALANCE=1 prints it level by
  // level): what a hunter really spends (regeneration, food and mana draughts). The roles
  // must hold along the whole career, not at one level: a spell counts from its level and
  // magic level on (review of the spell progression, 2026-11: at level 30 alone, a level 48
  // area evaluated at magic level 20 hid a guardian strike stronger than the arcanist's
  // areas from 35 to 47, and the guardian's heal outgrew the druid's from 12 to 29).
  // From 12, when the guardian's heal comes; retune this table with the careers.
  const careerMagic: Record<number, Record<string, number>> = {
    12: { guardian: 1, arcanist: 4, druid: 5, ranger: 2 },
    20: { guardian: 3, arcanist: 12, druid: 12, ranger: 5 },
    25: { guardian: 3, arcanist: 17, druid: 17, ranger: 7 },
    30: { guardian: 4, arcanist: 21, druid: 21, ranger: 8 },
    35: { guardian: 5, arcanist: 25, druid: 25, ranger: 9 },
    40: { guardian: 5, arcanist: 29, druid: 28, ranger: 11 },
    45: { guardian: 6, arcanist: 33, druid: 32, ranger: 12 },
    49: { guardian: 6, arcanist: 35, druid: 35, ranger: 13 },
  };
  const LEVELS = Object.keys(careerMagic).map(Number);
  // Weapon skill: the guardian sims' rule (skillStart + skillPerLevel × (level − 1)). The
  // guardian's strikes scale with the skill of the weapon it holds (`skill: weapon`), the
  // ranger's spells with distance; the casters' spells with no skill.
  const weaponSkill = (level: number) => 10 + Math.floor(1.5 * (level - 1));
  const castBy = (v: string): Spell[] => spells.filter((s) => s.vocations.includes(v));
  /** The most of pick among the spells v can cast at level (its level and magic level). */
  const best = (v: string, level: number, pick: (s: Spell) => Scaling | undefined): number => {
    const magic = careerMagic[level]?.[v];
    if (magic === undefined) throw new Error(`no career magic level for ${v} at ${level}`);
    const amounts = castBy(v)
      .filter((s) => s.level <= level && (s.magic_level ?? 0) <= magic)
      .flatMap((s) => {
        const sc = pick(s);
        return sc ? [amount(sc, level, magic, weaponSkill(level))] : [];
      });
    return Math.max(0, ...amounts);
  };

  it("every vocation has 3-10 spells of its own and all of them fit the hotbar", () => {
    // Own = only it casts them; the support spells every vocation shares (haste and the
    // poison cure, T3.2) do not count. Six since the content audit (M5): each caster has
    // a second area spell of another element for the island that resists the first; eight
    // since the spell progression (2026-11), when the guardian got spells of its own too;
    // ten since the vocation identity (2026-11-23), a spell of its own in every band.
    // The default hotbar (client/src/state/hotkeys.ts) puts a vocation's spells on its 12
    // keys by level: they all fit.
    const own = (v: string) => castBy(v).filter((s) => s.vocations.length === 1);
    for (const v of ["guardian", "arcanist", "ranger", "druid"]) {
      expect(own(v).length, v).toBeGreaterThanOrEqual(3);
      expect(own(v).length, v).toBeLessThanOrEqual(10);
      expect(castBy(v).length, v).toBeLessThanOrEqual(12);
    }
  });

  it("every vocation learns a spell of its own in each band of levels 1 to 30", () => {
    // Vocation identity (owner's request, 2026-11-23): the powers of each vocation are its
    // own, and a player feels it all along the first 30 levels, not only at the start.
    const BANDS = [
      [1, 7],
      [8, 15],
      [16, 23],
      [24, 30],
    ] as const;
    for (const v of ["guardian", "arcanist", "ranger", "druid"]) {
      for (const [from, to] of BANDS) {
        const own = castBy(v).filter(
          (s) => s.vocations.length === 1 && s.level >= from && s.level <= to,
        );
        expect(own.length, `${v} levels ${from}-${to}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("the spells several vocations share are basics: support, no damage, early", () => {
    const shared = spells.filter((s) => s.vocations.length > 1);
    expect(shared.length).toBeLessThanOrEqual(3);
    for (const s of shared) {
      expect(s.effect.damage, s.id).toBeUndefined();
      expect(s.effect.heal, s.id).toBeUndefined();
      expect(s.level, s.id).toBeLessThanOrEqual(10);
    }
  });

  it("the guardian's strikes scale with the weapon it holds", () => {
    const strikes = castBy("guardian").filter((s) => s.vocations.length === 1 && s.effect.damage);
    expect(strikes.length).toBeGreaterThanOrEqual(2);
    for (const s of strikes) {
      expect(s.effect.damage?.skill, s.id).toBe("weapon");
      expect(s.effect.damage?.radius, s.id).toBe(1); // around itself: melee
    }
  });

  it.each(LEVELS)(
    "the druid is the best healer at level %i and the only one that heals others",
    (level) => {
      const heal = (s: Spell) => s.effect.heal;
      for (const v of ["guardian", "arcanist", "ranger"]) {
        expect(best("druid", level, heal), v).toBeGreaterThan(1.25 * best(v, level, heal));
      }
      const healers = spells
        .filter((s) => (s.effect.heal?.range ?? 0) > 0)
        .flatMap((s) => s.vocations);
      expect(new Set(healers)).toEqual(new Set(["druid"]));
    },
  );

  it("the ranger's spells scale with distance and it has the longest single-target reach", () => {
    const rangerDamage = castBy("ranger").filter((s) => s.effect.damage);
    expect(rangerDamage.length).toBeGreaterThan(0);
    for (const s of rangerDamage) expect(s.effect.damage?.skill, s.id).toBe("distance");
    const reach = (v: string) => Math.max(0, ...castBy(v).map((s) => s.effect.damage?.range ?? 0));
    for (const v of ["arcanist", "druid"]) expect(reach("ranger"), v).toBeGreaterThan(reach(v));
  });

  it.each(LEVELS)("the arcanist keeps the strongest area damage at level %i", (level) => {
    const area = (s: Spell) => (s.effect.damage?.radius ? s.effect.damage : undefined);
    for (const v of ["guardian", "ranger", "druid"]) {
      expect(best("arcanist", level, area), v).toBeGreaterThan(best(v, level, area));
    }
  });

  it("the arcanist has the widest area", () => {
    const radius = (v: string) =>
      Math.max(0, ...castBy(v).map((s) => s.effect.damage?.radius ?? 0));
    for (const v of ["guardian", "ranger", "druid"]) {
      expect(radius("arcanist"), v).toBeGreaterThan(radius(v));
    }
  });
});
