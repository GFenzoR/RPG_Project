// The units the player sees (docs/02 "Unidades"): the metric system. Weights travel in
// grams (data/items `weight`, PlayerStats capacity) and show in g below 1 kg and in kg
// with up to two decimals from there; one tile is one metre, so a range is metres and an
// area of tiles (a house) square metres. The numbers take the language's decimal
// separator and grouping through the translator ("3,25 kg" in Spanish, "3.25 kg" in
// English); the unit symbols are i18n texts too (client.unit.*).
import type { Translate } from "../i18n/i18n.ts";

/** Grams in a kilogram: from this many grams on, a weight shows in kg. */
export const GRAMS_PER_KG = 1000;

/**
 * A weight in grams as the UI writes it: "350 g", "3 kg", "3,25 kg", "12,4 kg". Grams
 * round to whole grams and kilograms to two decimals (trailing zeros dropped); a weight
 * that rounds to 1000 g or more is written in kg. Negative or not finite weights are 0 g.
 */
export function formatMass(grams: number, t: Translate): string {
  const g = Number.isFinite(grams) ? Math.max(0, Math.round(grams)) : 0;
  if (g < GRAMS_PER_KG) return t("client.unit.g", { g });
  return t("client.unit.kg", { kg: Math.round(g / 10) / 100 });
}

/** A distance in tiles as metres (1 tile = 1 m): "5 m". */
export function formatLength(tiles: number, t: Translate): string {
  return t("client.unit.m", { m: tiles });
}

/** An area in tiles as square metres (a tile is 1 m × 1 m): "42 m²". */
export function formatArea(tiles: number, t: Translate): string {
  return t("client.unit.m2", { m2: tiles });
}
