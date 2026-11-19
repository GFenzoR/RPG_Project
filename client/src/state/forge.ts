// The forge window (docs/02 "Forja"): what refining one item at the anvil costs, gives and
// risks, from balance.yaml forge (content.forge) and what the player carries (the anvil's
// StationOpen: stones, protection and money). Pure, with the same formulas as the server
// (server/internal/content/forge.go); the server checks everything again on Refine.
import { RefineOutcome } from "@rpg/protocol";
import type { ClientContent, ForgeRules, ItemDef, ItemMods } from "../content-types.ts";
import type { ItemLoc } from "./items.ts";
import type { StationState } from "./recipes.ts";
import type { ContainerState, ItemView } from "./world.ts";

/** What a level of refine raises: a weapon's attack, an armor piece's armor, a shield's
 * defense or a jewel's attribute (a share of its value). */
export type RefineKind = "attack" | "armor" | "defense" | "jewel";

/** What refining def raises; undefined for an item the forge does not take. */
export function refineKind(def: ItemDef | undefined): RefineKind | undefined {
  // The equipables that roll an attribute (item-card.ts rollsAttribute, the server's
  // content.Rolls): a weapon, a shield or an armor piece, never a stack.
  if (!def || def.stackable || !(def.weapon || def.shield || def.armor)) return undefined;
  if (def.weapon) return "attack";
  if (def.shield) return "defense";
  const slot = def.armor?.slot ?? "";
  return slot === "neck" || slot === "ring" ? "jewel" : "armor";
}

/** The band of an item of requires.level level (missing or 0: level 1). */
export function forgeBand(rules: ForgeRules, level: number): ForgeRules["bands"][number] {
  const lvl = Math.max(level, 1);
  let band = rules.bands[0];
  for (const b of rules.bands.slice(1)) {
    if (b.level > lvl) break;
    band = b;
  }
  // bands is never empty (vite/content.ts loadForge).
  return band as ForgeRules["bands"][number];
}

/** The smithing bonus in chance points at smithing level skill. */
export function smithingBonus(rules: ForgeRules, skill: number): number {
  const b = rules.smithingBonus;
  if (b.perLevels <= 0) return 0;
  return Math.min(Math.floor(Math.max(skill, 0) / b.perLevels), b.max);
}

/** The success chance in % of the attempt to reach level (1..top) at smithing level skill. */
export function forgeChance(rules: ForgeRules, level: number, skill: number): number {
  const c = rules.levels[level - 1]?.chance ?? 0;
  if (c >= 100 || level <= rules.safeLevel) return 100;
  return Math.min(c + smithingBonus(rules, skill), 100);
}

/** What refine level adds to def: attack, armor or defense points; for a jewel, to the value
 * of its attribute (value: the instance's). */
export function refineGain(rules: ForgeRules, def: ItemDef, level: number, value = 0): number {
  if (level <= 0) return 0;
  const kind = refineKind(def);
  if (kind === "jewel") return value > 0 ? Math.floor((value * rules.jewelryPct * level) / 100) : 0;
  const band = forgeBand(rules, def.requires?.level ?? 0);
  const per =
    kind === "attack"
      ? band.attack
      : kind === "armor"
        ? band.armor
        : kind === "defense"
          ? band.defense
          : 0;
  // A hair over the product so 0.7 × 10 is 7, not 6.999 (as the server does).
  return Math.floor(per * level + 1e-9);
}

/** An item the forge can take that the player sees: where it is and what it is. */
export interface ForgeCandidate {
  loc: ItemLoc;
  itemId: number;
  mods: ItemMods | undefined;
}

/**
 * The items the player can refine and sees: the equipment, then each open container's
 * content (the equipped backpack's too). Items in closed containers do not show: the
 * client does not see them.
 */
export function forgeCandidates(
  content: ClientContent,
  inventory: ReadonlyMap<number, ItemView>,
  containers: readonly ContainerState[],
): ForgeCandidate[] {
  const out: ForgeCandidate[] = [];
  const takes = (v: ItemView): boolean => refineKind(content.items[v.itemId]) !== undefined;
  for (const [slot, v] of [...inventory.entries()].sort((a, b) => a[0] - b[0]))
    if (takes(v)) out.push({ loc: { kind: "slot", slot }, itemId: v.itemId, mods: v.mods });
  for (const c of containers)
    c.items.forEach((v, index) => {
      if (takes(v))
        out.push({ loc: { kind: "container", id: c.id, index }, itemId: v.itemId, mods: v.mods });
    });
  return out;
}

/** Whether two locations are the same place. */
export function sameLoc(a: ItemLoc, b: ItemLoc): boolean {
  if (a.kind === "slot" && b.kind === "slot") return a.slot === b.slot;
  if (a.kind === "container" && b.kind === "container") return a.id === b.id && a.index === b.index;
  if (a.kind === "pos" && b.kind === "pos")
    return a.pos.x === b.pos.x && a.pos.y === b.pos.y && a.pos.z === b.pos.z;
  return false;
}

/** Why an attempt cannot be made, as far as the client can tell (the server may still
 * refuse: the pace, the room for the change). */
export type ForgeBlock = "top" | "stones" | "protection" | "money";

/** The forge window for one item. */
export interface ForgeView {
  itemId: number;
  /** Its refine level now and the one the attempt aims at. */
  level: number;
  next: number;
  top: number;
  /** The attempt can fail (above the safe level): it may break without the protection. */
  risky: boolean;
  /** Success chance in %, the smithing bonus in it. */
  chance: number;
  bonus: number;
  /** Copper the attempt costs and what the player carries. */
  gold: number;
  money: number;
  stone: { itemId: number; need: number; have: number };
  /** The protection: carried units (the toggle only shows with one where it counts). */
  protection: { itemId: number; have: number };
  /** What the item gives from its refine now and at the next level, and the stat. */
  gain: { kind: RefineKind; now: number; next: number };
  blocks: ForgeBlock[];
}

/**
 * The forge window for one item of the player at the open station, or undefined when the
 * item is not one the forge takes. smithing is the player's smithing level.
 */
export function forgeView(
  rules: ForgeRules,
  content: ClientContent,
  station: StationState,
  item: { itemId: number; mods?: ItemMods | undefined },
  smithing: number,
  protect: boolean,
): ForgeView | undefined {
  const def = content.items[item.itemId];
  const kind = refineKind(def);
  if (!def || !kind) return undefined;
  const top = rules.levels.length;
  const level = item.mods?.refine ?? 0;
  const next = Math.min(level + 1, top);
  const band = forgeBand(rules, def.requires?.level ?? 0);
  const value = item.mods?.value ?? 0;
  const stone = {
    itemId: band.stone,
    need: rules.levels[next - 1]?.stones ?? 0,
    have: station.owned.get(band.stone) ?? 0,
  };
  const protection = { itemId: rules.protection, have: station.owned.get(rules.protection) ?? 0 };
  const risky = next > rules.safeLevel;
  const gold = band.gold * next;
  const money = station.money ?? 0;
  const blocks: ForgeBlock[] = [];
  if (level >= top) blocks.push("top");
  else {
    if (stone.have < stone.need) blocks.push("stones");
    if (protect && risky && protection.have < 1) blocks.push("protection");
    if (money < gold) blocks.push("money");
  }
  return {
    itemId: item.itemId,
    level,
    next,
    top,
    risky,
    chance: level >= top ? 0 : forgeChance(rules, next, smithing),
    bonus: risky ? smithingBonus(rules, smithing) : 0,
    gold,
    money,
    stone,
    protection,
    gain: {
      kind,
      now: refineGain(rules, def, level, value),
      next: refineGain(rules, def, next, value),
    },
    blocks,
  };
}

/** The forge's steps: pick an item, then (from the safe level on) confirm the risk. */
export type ForgeStep = "pick" | "confirm";

/** What the attempt button does: send it at once (a safe level) or ask to confirm first. */
export function attemptStep(view: ForgeView): "send" | "confirm" {
  return view.risky ? "confirm" : "send";
}

/** How a forge attempt ended (RefineResult.outcome). */
export type RefineEnd = "success" | "broken" | "protected";

/** The protocol's outcome as the client keeps it (an unknown one reads as a success). */
export function refineOutcome(o: RefineOutcome): RefineEnd {
  if (o === RefineOutcome.BROKEN) return "broken";
  if (o === RefineOutcome.PROTECTED) return "protected";
  return "success";
}

/** The last forge attempt (RefineResult): the item after it (itemId 0 never), its level now,
 * the level it had before and when it came (performance.now()). */
export interface RefineState {
  outcome: RefineEnd;
  level: number;
  itemId: number;
  mods: ItemMods | undefined;
  from: number;
  at: number;
}

/** The i18n key of a result's headline (client.forge.result.<outcome>). */
export const resultKey = (r: RefineState): string => `client.forge.result.${r.outcome}`;

/** The name of an item at refine level (0: the plain name), through i18n (client.item.refined
 * has {level} and {name}): never text put together in code. */
export function refinedName(
  t: (key: string, params?: Record<string, string | number>) => string,
  name: string,
  level: number | undefined,
): string {
  return level && level > 0 ? t("client.item.refined", { level, name }) : name;
}
