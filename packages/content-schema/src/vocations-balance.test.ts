// Guardrails for data/vocations.yaml and the skill section of data/balance.yaml.
//
// The numbers are ours (CLAUDE.md legal rule), but they must keep the roles from
// docs/02-game-design.md: the guardian is the melee tank, the arcanist the fragile caster,
// and skills level at a pace a player of classic tile MMORPGs finds familiar. The pace
// bands below are sanity limits, not exact targets: retune freely inside them.
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

  it("fishing never trains slower than the guardian's main melee skill", () => {
    const fastestMelee = Math.min(...MELEE.map((s) => guardian.skill_factors[s] ?? Infinity));
    for (const v of [guardian, arcanist]) {
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
  ] as const)("%s %s to %i takes %i-%i tries", (voc, skill, target, min, max) => {
    const tries = triesTo(vocation(voc), skill, target);
    expect(tries).toBeGreaterThanOrEqual(min);
    expect(tries).toBeLessThanOrEqual(max);
  });
});
