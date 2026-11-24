// An item instance's mods (ItemStack.mods, docs/05; docs/02 "Atributos de items"): the one
// attribute an equipable rolled, with its value, and its refine level; for the remains a
// death leaves, whose they are (remainsOf, bodyOf).
import type { ItemMods } from "../content-types.ts";

/** The mods of an ItemStack as the client keeps them (undefined: a plain item). */
export function modsOf(s: { mods?: ItemMods | undefined } | undefined): ItemMods | undefined {
  const m = s?.mods;
  if (!m) return undefined;
  const out: ItemMods = { attribute: m.attribute, value: m.value, refine: m.refine };
  if (m.remainsOf) out.remainsOf = m.remainsOf;
  if (m.bodyOf) out.bodyOf = m.bodyOf;
  if (m.attribute === "" && m.value === 0 && m.refine === 0 && !out.remainsOf && !out.bodyOf)
    return undefined;
  return out;
}

/**
 * An instance's mods as a data-tip-mods value ("attack:3:0"; undefined for a plain item):
 * what an element with data-tip-item adds so its card (ui/ItemTooltip.tsx) shows them.
 */
export function tipMods(mods: ItemMods | undefined): string | undefined {
  return mods ? `${mods.attribute}:${mods.value}:${mods.refine}` : undefined;
}

/** The mods a data-tip-mods value names (undefined: none or malformed). */
export function parseTipMods(v: string | undefined): ItemMods | undefined {
  const [attribute, value, refine] = (v ?? "").split(":");
  const n = Number(value);
  const r = Number(refine ?? "0");
  if (!attribute || value === undefined || !Number.isFinite(n) || !Number.isFinite(r))
    return undefined;
  return { attribute, value: n, refine: r };
}

/** Whether two instances' mods are the same (both plain counts as the same). */
export function sameMods(a: ItemMods | undefined, b: ItemMods | undefined): boolean {
  return (
    (a?.attribute ?? "") === (b?.attribute ?? "") &&
    (a?.value ?? 0) === (b?.value ?? 0) &&
    (a?.refine ?? 0) === (b?.refine ?? 0)
  );
}
