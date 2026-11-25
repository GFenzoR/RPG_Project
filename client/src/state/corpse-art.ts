// The remains a monster leaves are drawn as its own corpse (docs/02 "Muerte", docs/17): the
// server marks the family's container item with the monster that fell (ItemMods
// remains_of), and the map draws that item with the monster's corpse sprite,
// corpses/<monster id>, which tools/spritegen makes for every monster of data/monsters
// from its own art (recipes/corpses.ts). The map's tile stacks are strings (MapView item
// keys): a plain item is its number, the remains of a monster "<number>@<monster id>".
import { DEFAULT_FRAME_MS } from "@rpg/renderer";
import type { TileArt } from "@rpg/renderer";
import type { ItemMods } from "../content-types.ts";

/** The atlas sprite of a monster's corpse. */
export const corpseSprite = (monster: string): string => `corpses/${monster}`;

/** The MapView key of a tile item: its number, or "<number>@<monster>" for remains. */
export function mapItemKey(itemId: number, mods: ItemMods | undefined): string {
  return mods?.remainsOf ? `${itemId}@${mods.remainsOf}` : String(itemId);
}

/**
 * The item's number of a MapView key, whatever follows it. What a lookup by item wants
 * (its elevation, its living-world rule); it allocates nothing.
 */
export function mapItemId(key: string): number {
  const at = key.indexOf("@");
  return Number(at < 0 ? key : key.slice(0, at));
}

/**
 * A MapView key as the plain item's (its number alone): what code that knows items by
 * their number, and nothing of remains, is given (render/living.ts).
 */
export function plainItemKey(key: string): string {
  const at = key.indexOf("@");
  return at < 0 ? key : key.slice(0, at);
}

/** A MapView key back as the item's number and, for remains, the monster that fell. */
export function parseMapItemKey(key: string): { itemId: number; remainsOf?: string } {
  const at = key.indexOf("@");
  if (at < 0) return { itemId: Number(key) };
  return { itemId: Number(key.slice(0, at)), remainsOf: key.slice(at + 1) };
}

/**
 * How the map draws a corpse sprite: centred on its tile (anchor bc), as the creature stood
 * when it fell. The recipe already put the body where the creature's frame was.
 */
export function corpseArt<T>(base: T): TileArt<T> {
  return { base, ms: DEFAULT_FRAME_MS, sync: "world", anchorX: 0.5, joinsWalls: false, light: 0 };
}

/** What the map's lookups need of the atlas (packages/renderer Atlas). */
export interface MapItemAtlas<T> {
  texture(sprite: string): T | undefined;
  tileArt(sprite: string): TileArt<T> | undefined;
}

/** What they need of data/items: each item's sprite, by number. */
export type MapItemSprites = Readonly<Record<number, { sprite?: string } | undefined>>;

/**
 * The texture the map draws for the tile item `key`: the corpse of the monster whose
 * remains it is when the atlas has one (corpses/<monster>), else the item's own sprite
 * (the family's remains: an atlas older than the monster still shows a body). Undefined:
 * no art at all.
 */
export function mapItemTexture<T>(
  key: string,
  items: MapItemSprites,
  atlas: MapItemAtlas<T>,
): T | undefined {
  const { itemId, remainsOf } = parseMapItemKey(key);
  const corpse = remainsOf ? atlas.texture(corpseSprite(remainsOf)) : undefined;
  if (corpse) return corpse;
  const sprite = items[itemId]?.sprite;
  return sprite ? atlas.texture(sprite) : undefined;
}

/**
 * The tile art of the tile item `key`: a corpse centred on its tile (corpseArt), else the
 * item's own art (undefined: its texture is drawn as it is).
 */
export function mapItemArt<T>(
  key: string,
  items: MapItemSprites,
  atlas: MapItemAtlas<T>,
): TileArt<T> | undefined {
  const { itemId, remainsOf } = parseMapItemKey(key);
  const corpse = remainsOf ? atlas.texture(corpseSprite(remainsOf)) : undefined;
  if (corpse) return corpseArt(corpse);
  const sprite = items[itemId]?.sprite;
  return sprite ? atlas.tileArt(sprite) : undefined;
}
