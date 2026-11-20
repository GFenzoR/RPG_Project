// Cosmetics (T5.7): how a player's equipped cosmetics change the way it is drawn. Pure, no
// Pixi: game-canvas.ts and the appearance panel call these and apply the result.
//
// A player's Creature.cosmetics (and CosmeticsState.equipped) hold content ids of
// data/cosmetics.yaml, one per kind; empty or unknown = the default look of that kind.
// Looks only: nothing here may ever feed a game rule (docs/02-game-design.md).
import type {
  ClientContent,
  CosmeticDef,
  CosmeticKind,
  NameEffectStyle,
  OutfitDef,
} from "../content-types.ts";
import { DEFAULT_OUTFIT } from "./outfit.ts";

/** The equipped cosmetics as the protocol sends them (protobuf Cosmetics). */
export interface EquippedCosmetics {
  outfit?: string;
  color?: string;
  nameEffect?: string;
}

/** The content these helpers read; fixtures may leave both out. */
export type CosmeticContent = Pick<ClientContent, "cosmetics" | "outfits">;

/** Multiply tint that leaves a sprite as it is (Pixi's Sprite.tint default). */
export const NO_TINT = 0xffffff;

/** Kinds in the order the appearance panel and the shop list them. */
export const COSMETIC_KINDS: readonly CosmeticKind[] = ["outfit", "outfit_color", "name_effect"];

/** i18n keys of a cosmetic and of a pack (i18n/<lang>/cosmetics.yaml). */
export const cosmeticNameKey = (id: string): string => `cosmetic.${id}.name`;
export const cosmeticDescKey = (id: string): string => `cosmetic.${id}.desc`;
export const packNameKey = (id: string): string => `cosmetic_pack.${id}.name`;
/** i18n key of each kind's heading in the in-game appearance panel. */
export const KIND_TITLE_KEY: Record<CosmeticKind, string> = {
  outfit: "client.appearance.outfit",
  outfit_color: "client.appearance.color",
  name_effect: "client.appearance.name_effect",
};
/** i18n key of each kind's "nothing equipped" choice in the appearance panel. */
export const KIND_DEFAULT_KEY: Record<CosmeticKind, string> = {
  outfit: "client.appearance.default_outfit",
  outfit_color: "client.appearance.default_color",
  name_effect: "client.appearance.default_name_effect",
};

/** The cosmetic with this id and kind, or undefined (empty, unknown or another kind). */
export function cosmeticOf(
  content: CosmeticContent,
  id: string | undefined,
  kind: CosmeticKind,
): CosmeticDef | undefined {
  if (!id) return undefined;
  const c = content.cosmetics?.find((d) => d.id === id);
  return c?.kind === kind ? c : undefined;
}

/** The equipped id of one kind (the field of EquippedCosmetics that holds it). */
export function equippedOf(eq: EquippedCosmetics | undefined, kind: CosmeticKind): string {
  if (!eq) return "";
  if (kind === "outfit") return eq.outfit ?? "";
  if (kind === "outfit_color") return eq.color ?? "";
  return eq.nameEffect ?? "";
}

/**
 * The outfit of data/outfits.yaml to draw: the equipped outfit cosmetic's look, else the
 * default (citizen). Undefined only when the content has no outfits at all.
 */
export function outfitFor(
  eq: EquippedCosmetics | undefined,
  content: CosmeticContent,
): OutfitDef | undefined {
  const look = cosmeticOf(content, eq?.outfit, "outfit")?.outfit;
  const outfits = content.outfits ?? [];
  return (
    (look ? outfits.find((o) => o.id === look) : undefined) ??
    outfits.find((o) => o.id === DEFAULT_OUTFIT)
  );
}

/** "#rrggbb" → 0xrrggbb; anything else → NO_TINT. */
export function parseTint(hex: string | undefined): number {
  return hex && /^#[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex.slice(1), 16) : NO_TINT;
}

/** Sprite.tint for the outfit: the equipped colour's tint, or NO_TINT. */
export function tintFor(eq: EquippedCosmetics | undefined, content: CosmeticContent): number {
  return parseTint(cosmeticOf(content, eq?.color, "outfit_color")?.tint);
}

/**
 * How to draw a name label: the fields of a Pixi TextStyle that a name effect changes. A
 * plain name keeps the fill it has now (self, player...) and the black stroke.
 */
export interface NameLabelStyle {
  fill: number;
  stroke: { color: number; width: number };
  /** A soft glow around the letters (Pixi TextStyle.dropShadow with distance 0). */
  dropShadow?: { color: number; alpha: number; blur: number; distance: number; angle: number };
}

/** The name effects: fill, stroke and glow per style of data/cosmetics.yaml. */
export const NAME_EFFECTS: Record<
  NameEffectStyle,
  Omit<NameLabelStyle, "dropShadow"> & {
    glow: number;
  }
> = {
  gold: { fill: 0xf2d372, stroke: { color: 0x3a2808, width: 3 }, glow: 0xd0a33b },
  ember: { fill: 0xffb26b, stroke: { color: 0x3a1206, width: 3 }, glow: 0xe0602a },
  frost: { fill: 0xd8f0ff, stroke: { color: 0x0e2a44, width: 3 }, glow: 0x7fc4ff },
};

/** The name label style for a player: its name effect, or plainFill with a black stroke. */
export function nameStyleFor(
  eq: EquippedCosmetics | undefined,
  content: CosmeticContent,
  plainFill: number,
): NameLabelStyle {
  const style = cosmeticOf(content, eq?.nameEffect, "name_effect")?.style;
  const fx = style ? NAME_EFFECTS[style] : undefined;
  if (!fx) return { fill: plainFill, stroke: { color: 0x000000, width: 3 } };
  return {
    fill: fx.fill,
    stroke: { ...fx.stroke },
    dropShadow: { color: fx.glow, alpha: 0.8, blur: 3, distance: 0, angle: 0 },
  };
}

/** Everything the renderer needs for one player, in one call. */
export interface PlayerLook {
  outfit: OutfitDef | undefined;
  tint: number;
  name: NameLabelStyle;
}

export function playerLook(
  eq: EquippedCosmetics | undefined,
  content: CosmeticContent,
  plainFill: number,
): PlayerLook {
  return {
    outfit: outfitFor(eq, content),
    tint: tintFor(eq, content),
    name: nameStyleFor(eq, content, plainFill),
  };
}

/**
 * The owned cosmetics grouped by kind, in data/cosmetics.yaml order, for the appearance
 * panel. Ids the content does not know (removed from the catalogue) are left out.
 */
export function ownedByKind(
  owned: readonly string[],
  content: CosmeticContent,
): Record<CosmeticKind, CosmeticDef[]> {
  const have = new Set(owned);
  const out: Record<CosmeticKind, CosmeticDef[]> = {
    outfit: [],
    outfit_color: [],
    name_effect: [],
  };
  for (const c of content.cosmetics ?? []) if (have.has(c.id)) out[c.kind].push(c);
  return out;
}
