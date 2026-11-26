// How the own player's steps sound (footsteps.ts): both feet, a little apart, never the
// same take twice in a row, quiet by one number of data/livingworld/surfaces.yaml.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseYaml } from "../../../tools/spritepack/src/content.ts";
import { parseLivingWorldData, SURFACES } from "./data.ts";
import { DEFAULT_STEP_RULES, footstepEvents, StepVoicer } from "./footsteps.ts";
import type { StepRules } from "./footsteps.ts";

const DATA = parseLivingWorldData(
  parseYaml(
    readFileSync(new URL("../../../data/livingworld/surfaces.yaml", import.meta.url), "utf8"),
  ),
  { plants: [] },
);
const RULES = DATA.steps as StepRules;

describe("the step's sound", () => {
  it("names the surface under the foot first, then the plain step", () => {
    expect(footstepEvents("grass", DATA)).toEqual(["step.self.grass", "step.self"]);
    expect(footstepEvents("water_shallow", DATA)).toEqual(["step.self.water", "step.self"]);
    expect(footstepEvents(undefined, DATA)).toEqual(["step.self"]);
  });

  it("gives every surface with a sound an event of its own", () => {
    const events = new Map<string, string>();
    for (const s of SURFACES) {
      if (s === "lava") continue;
      const e = footstepEvents(s, DATA)[0] as string;
      expect(events.has(e), `${s} shares ${e} with ${events.get(e) ?? ""}`).toBe(false);
      events.set(e, s);
    }
  });
});

describe("both feet", () => {
  it("sound a few percent apart: the left a little lower and softer", () => {
    expect(RULES.left.pitch).not.toBe(RULES.right.pitch);
    expect(Math.abs(RULES.left.pitch - RULES.right.pitch)).toBeLessThanOrEqual(0.08);
    expect(Math.abs(RULES.left.gain - RULES.right.gain)).toBeLessThanOrEqual(0.1);
    const flat = new StepVoicer({ ...RULES, jitter: 0 });
    const right = { ...flat.next(1) };
    const left = { ...flat.next(-1) };
    expect(right.rate).toBeCloseTo(1 + RULES.right.pitch);
    expect(left.rate).toBeCloseTo(1 + RULES.left.pitch);
    expect(left.gain).toBeLessThan(right.gain);
    // Neither foot is silent or far from the other: no limp.
    expect(left.gain / right.gain).toBeGreaterThan(0.85);
  });

  it("is quiet by one number: steps.volume scales every step", () => {
    expect(RULES.volume).toBeGreaterThan(0);
    expect(RULES.volume).toBeLessThanOrEqual(0.8);
    const loud = new StepVoicer({ ...RULES, volume: 1 }).next(1).gain;
    const quiet = new StepVoicer({ ...RULES, volume: 0.5 }).next(1).gain;
    expect(quiet).toBeCloseTo(loud / 2);
  });

  it("moves each step's pitch a little, within the jitter, the same way every run", () => {
    const rates = (): number[] => {
      const v = new StepVoicer(RULES);
      return Array.from({ length: 200 }, (_, i) => v.next(i % 2 === 0 ? 1 : -1).rate);
    };
    const a = rates();
    expect(a).toEqual(rates());
    const rights = a.filter((_, i) => i % 2 === 0);
    expect(new Set(rights.map((r) => r.toFixed(4))).size).toBeGreaterThan(20);
    for (const r of rights)
      expect(Math.abs(r - 1 - RULES.right.pitch)).toBeLessThanOrEqual(RULES.jitter + 1e-9);
    expect(Math.max(...rights) - Math.min(...rights)).toBeGreaterThan(RULES.jitter);
  });

  it("never plays the same take twice in a row, and uses them all", () => {
    for (const n of [2, 3, 5]) {
      const v = new StepVoicer(RULES);
      const takes: number[] = [];
      for (let i = 0; i < 300; i++) takes.push(v.next(i % 2 === 0 ? 1 : -1).pick(n));
      for (let i = 1; i < takes.length; i++)
        expect(takes[i], `n=${n} i=${i}`).not.toBe(takes[i - 1]);
      expect(new Set(takes).size).toBe(n);
      for (const t of takes) expect(t >= 0 && t < n && Number.isInteger(t)).toBe(true);
    }
    // One take only: that one.
    expect(new StepVoicer(RULES).next(1).pick(1)).toBe(0);
  });

  it("with three takes neither foot is stuck with one: left and right both get them all", () => {
    const v = new StepVoicer(RULES);
    const bySide = { l: new Set<number>(), r: new Set<number>() };
    for (let i = 0; i < 120; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      (side > 0 ? bySide.r : bySide.l).add(v.next(side).pick(3));
    }
    expect(bySide.l.size).toBe(3);
    expect(bySide.r.size).toBe(3);
  });

  it("without data every take plays as recorded", () => {
    const v = new StepVoicer(DEFAULT_STEP_RULES).next(-1);
    expect(v.gain).toBe(1);
    expect(v.rate).toBe(1);
  });
});
