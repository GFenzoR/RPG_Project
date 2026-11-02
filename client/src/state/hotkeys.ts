// Spell hotkeys F1–F12 (T1.9): which spell each key casts, kept per vocation in the
// browser. The server still decides everything (vocation, level, mana, cooldowns).
import type { SpellDef } from "../content-types.ts";

export const HOTKEY_COUNT = 12;

/** "F1".."F12" → slot index 0..11, or undefined for any other key code. */
export function hotkeySlot(code: string): number | undefined {
  const m = /^F(\d{1,2})$/.exec(code);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= HOTKEY_COUNT ? n - 1 : undefined;
}

/** Default bar: the vocation's spells by level, then empty slots. */
export function defaultHotkeys(
  spells: readonly SpellDef[],
  vocation: string,
): (string | undefined)[] {
  const own = spells
    .filter((s) => s.vocations.includes(vocation))
    .sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  return Array.from({ length: HOTKEY_COUNT }, (_, i) => own[i]?.id);
}

const storageKey = (vocation: string): string => `rpg.hotkeys.${vocation}`;

/** The saved bar of a vocation (unknown spell IDs dropped), or the default one. */
export function loadHotkeys(
  spells: readonly SpellDef[],
  vocation: string,
  storage: Pick<Storage, "getItem"> | undefined,
): (string | undefined)[] {
  const known = new Set(spells.map((s) => s.id));
  let raw: unknown;
  try {
    raw = JSON.parse(storage?.getItem(storageKey(vocation)) ?? "null");
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) return defaultHotkeys(spells, vocation);
  return Array.from({ length: HOTKEY_COUNT }, (_, i) => {
    const v: unknown = raw[i];
    return typeof v === "string" && known.has(v) ? v : undefined;
  });
}

export function saveHotkeys(
  vocation: string,
  keys: readonly (string | undefined)[],
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  try {
    storage?.setItem(storageKey(vocation), JSON.stringify(keys.map((k) => k ?? null)));
  } catch {
    // Private mode or full storage: the bar just is not remembered.
  }
}

/** A running cooldown: when it ends and how long it lasted (performance.now ms). */
export interface Cooldown {
  until: number;
  total: number;
}

/** Remaining fraction (0..1) of the longest of a spell's own and group cooldowns. */
export function cooldownLeft(cds: readonly (Cooldown | undefined)[], now: number): number {
  let best = 0;
  for (const c of cds)
    if (c && c.until > now && c.total > 0) best = Math.max(best, (c.until - now) / c.total);
  return Math.min(best, 1);
}
