import { describe, expect, it } from "vitest";
import { stepMs, TICK_MS } from "./step-time.ts";

const mv = { baseStepMs: 1000, diagonalCost: 1.414 };
/** data/balance.yaml since 2026-11-26 (+15 % for every creature). */
const repo = { baseStepMs: 891, diagonalCost: 1.414 };

describe("stepMs", () => {
  it("matches the server's StepMs (server/internal/session/walk_test.go TestStepDuration)", () => {
    // The same table: [terrain %, diagonal, speed, ms]. Grass 100, mud 200, road 50.
    const cases: [number, boolean, number, number][] = [
      [100, false, 200, 500],
      [100, true, 200, 707],
      [200, false, 200, 1000],
      [50, false, 200, 250],
      [100, false, 205, 488],
      [100, true, 205, 690],
      [50, true, 200, 354],
      [200, true, 200, 1414],
      [100, false, 30000, 50],
      [100, true, 30000, 71],
      [50, true, 1000, 71],
      [50, true, 999, 72],
    ];
    for (const [terrain, diagonal, speed, ms] of cases)
      expect(stepMs(mv, terrain, speed, diagonal), `${terrain} ${speed} ${diagonal}`).toBe(ms);
    expect(stepMs({ baseStepMs: 1000, diagonalCost: 1 }, 100, 30000, true)).toBe(50);
  });

  it("predicts the repo's walk: 435 ms a tile at level 1, 0.2 % faster per level", () => {
    // Level 1 (speed 205): 15 % faster than the 500 ms a tile of before 2026-11-26.
    expect(stepMs(repo, 100, 205, false)).toBe(435);
    expect(stepMs(repo, 100, 205, true)).toBe(615);
    // The server sends the speed with the level in it (PlayerStats.speed, CreatureSpeed:
    // round(205 × (1 + 0.002 × (level − 1)))); the prediction is this function of it, so a
    // few points more are a step that much shorter, not the same whole ticks.
    const speedAt = (level: number): number => Math.round(205 * (1 + 0.002 * (level - 1)));
    let prev = 435;
    for (const level of [10, 25, 50, 100, 250]) {
      const ms = stepMs(repo, 100, speedAt(level), false);
      expect(ms).toBeLessThan(prev);
      // Within a millisecond and the half point the speed is rounded to.
      const exact = 89100 / (205 * (1 + 0.002 * (level - 1)));
      expect(Math.abs(ms - exact)).toBeLessThan(1.6);
      prev = ms;
    }
    expect(stepMs(repo, 100, speedAt(50), false)).toBe(396); // +9.8 %
    expect(stepMs(repo, 100, speedAt(100), false)).toBe(363); // +19.8 %
  });

  it("walks every direction at one speed per tile of distance", () => {
    for (const terrain of [50, 100, 150, 200]) {
      for (let speed = 50; speed <= 3000; speed += 7) {
        const straight = stepMs(mv, terrain, speed, false);
        const diag = stepMs(mv, terrain, speed, true);
        expect(straight).toBeGreaterThanOrEqual(TICK_MS);
        expect(diag).toBeGreaterThan(straight);
        expect(Math.abs(diag - straight * 1.414)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it("reads the cost in thousandths, as the server does", () => {
    expect(stepMs({ baseStepMs: 1000, diagonalCost: 1.4142 }, 100, 100, true)).toBe(
      stepMs(mv, 100, 100, true),
    );
    expect(stepMs({ baseStepMs: 1000, diagonalCost: 1.5 }, 100, 200, true)).toBe(750);
  });
});
