// The level curve of balance.yaml experience on the client (the experience bar's tooltip,
// docs/17 "Placa del nombre"): the same formula as the server's content.Experience.TotalFor.
// Pure. The server sends the experience and the level; this only says what is missing.
import type { ExperienceCurve } from "../content-types.ts";

/** Total experience to reach level n (0 for n <= 1), cut to a whole number as Go's int64(). */
export function totalFor(curve: ExperienceCurve, n: number): number {
  if (n <= 1) return 0;
  return Math.trunc(curve.a * n ** 3 + curve.b * n ** 2 + curve.c * n + curve.d);
}

/**
 * What the player needs for the next level: the level and the experience still missing
 * (at least 0), or undefined at the top level or without a curve.
 */
export function toNextLevel(
  curve: ExperienceCurve | undefined,
  level: number,
  experience: number,
): { next: number; missing: number } | undefined {
  if (!curve || (curve.maxLevel > 0 && level >= curve.maxLevel)) return undefined;
  const next = level + 1;
  const need = totalFor(curve, next);
  if (need <= totalFor(curve, level)) return undefined; // a curve that does not grow
  return { next, missing: Math.max(0, need - experience) };
}
