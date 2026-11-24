/** The tick of the server's game loop: step durations are whole ticks. */
export const TICK_MS = 50;

/**
 * How long a step takes, as the server's `StepTicks` counts it (docs/05 "Caminar"): a
 * straight step is `base_step_ms × terrain% / speed` rounded up to whole ticks (at least
 * one); a diagonal one is that many ticks × `diagonal_cost` (in thousandths, as the server
 * reads it) rounded to the nearest tick, never fewer. Integer arithmetic, so the client's
 * prediction and the server's `duration_ms` agree to the millisecond (no rubber-banding).
 */
export function stepMs(
  mv: { baseStepMs: number; diagonalCost: number },
  terrain: number,
  speed: number,
  diagonal: boolean,
): number {
  const ms = Math.ceil((mv.baseStepMs * terrain) / Math.max(speed, 1));
  let ticks = Math.max(Math.ceil(ms / TICK_MS), 1);
  if (diagonal) {
    const diag = Math.round(mv.diagonalCost * 1000);
    ticks = Math.max(Math.floor((ticks * diag + 500) / 1000), ticks);
  }
  return ticks * TICK_MS;
}
