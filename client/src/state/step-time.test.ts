import { describe, expect, it } from "vitest";
import { stepMs } from "./step-time.ts";

const mv = { baseStepMs: 1000, diagonalCost: 1.414 };

describe("stepMs", () => {
  it("matches the server's StepTicks (server/internal/session/walk_test.go)", () => {
    expect(stepMs(mv, 100, 200, false)).toBe(500);
    expect(stepMs(mv, 100, 200, true)).toBe(700); // 10 ticks × √2 = 14.14 → 14
    expect(stepMs(mv, 100, 205, true)).toBe(700); // from the 10 straight ticks
    expect(stepMs(mv, 200, 200, true)).toBe(1400); // 20 × √2 = 28.28 → 28
    expect(stepMs(mv, 50, 200, true)).toBe(350); // 5 × √2 = 7.07 → 7
    expect(stepMs(mv, 100, 30000, true)).toBe(50); // never under one tick
  });

  it("walks every direction at one speed per tile of distance", () => {
    for (const terrain of [50, 100, 150, 200]) {
      for (let speed = 50; speed <= 1500; speed += 7) {
        const straight = stepMs(mv, terrain, speed, false) / 50;
        const diag = stepMs(mv, terrain, speed, true) / 50;
        expect(diag).toBeGreaterThanOrEqual(straight);
        expect(Math.abs(diag - straight * Math.SQRT2)).toBeLessThanOrEqual(0.5);
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
