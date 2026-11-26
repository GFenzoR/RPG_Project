/** The tick of the server's game loop: no step is shorter. */
export const TICK_MS = 50;

/**
 * How long a step takes, as the server's `StepMs` counts it (docs/05 "Caminar"): a
 * straight step is `base_step_ms × terrain% / speed` rounded up to the millisecond (at
 * least one tick); a diagonal one is that × `diagonal_cost` (in thousandths, as the server
 * reads it) rounded to the nearest millisecond, never less. North, east, south and west
 * are one cost. It is not rounded to whole ticks: the server waits whole ticks and carries
 * the rest to the walk's next step, so steps drawn back to back at this duration keep its
 * pace. Integer arithmetic, so the client's prediction and the server's `duration_ms` agree
 * to the millisecond (no rubber-banding).
 */
export function stepMs(
  mv: { baseStepMs: number; diagonalCost: number },
  terrain: number,
  speed: number,
  diagonal: boolean,
): number {
  const ms = Math.max(Math.ceil((mv.baseStepMs * terrain) / Math.max(speed, 1)), TICK_MS);
  if (!diagonal) return ms;
  const diag = Math.round(mv.diagonalCost * 1000);
  return Math.max(Math.floor((ms * diag + 500) / 1000), ms);
}
