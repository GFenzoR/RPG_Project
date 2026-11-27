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
 * The MapView keys of the remains among a tile's items (`mods` by item, as the tile has
 * them): what a monster left (remainsOf) and the body of a player (bodyOf). Undefined: none.
 */
export function remainsKeys(
  items: readonly number[] | undefined,
  mods: readonly (ItemMods | undefined)[] | undefined,
): string[] | undefined {
  if (!items || !mods) return undefined;
  let out: string[] | undefined;
  for (let i = 0; i < items.length; i++) {
    const m = mods[i];
    if (m?.remainsOf || m?.bodyOf) (out ??= []).push(mapItemKey(items[i] ?? 0, m));
  }
  return out;
}

/**
 * The remains a tile got: the key there are more of `after` than `before` (remainsKeys of
 * the tile around one TileUpdate), the topmost one. Undefined: none came (one taken away,
 * another item changed).
 */
export function laidRemains(
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): string | undefined {
  if (!after) return undefined;
  for (let i = after.length - 1; i >= 0; i--) {
    const key = after[i] as string;
    let more = 0;
    for (const k of after) if (k === key) more++;
    if (before) for (const k of before) if (k === key) more--;
    if (more > 0) return key;
  }
  return undefined;
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
export type MapItemSprites = Readonly<
  Record<number, { sprite?: string; kind?: string } | undefined>
>;

/**
 * Share of its icon a carried thing shows at on the floor: the icons fill a tile, as big as
 * a person. Still larger than life, so a dropped item is easy to see and to click.
 */
export const FLOOR_ITEM_SCALE = 0.625;
/** The kinds of data/items a character carries (not furniture, grounds, walls or chests). */
const CARRIED_KINDS: ReadonlySet<string> = new Set([
  "weapon",
  "armor",
  "shield",
  "ammo",
  "consumable",
  "material",
  "currency",
  "rune",
  "tool",
]);

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
  const def = items[itemId];
  const sprite = def?.sprite;
  if (!sprite) return undefined;
  const art = atlas.tileArt(sprite);
  if (def.kind === undefined || !CARRIED_KINDS.has(def.kind)) return art;
  if (art) return { ...art, scale: FLOOR_ITEM_SCALE };
  const base = atlas.texture(sprite);
  return base === undefined
    ? undefined
    : {
        base,
        ms: DEFAULT_FRAME_MS,
        sync: "world",
        anchorX: 1,
        joinsWalls: false,
        light: 0,
        scale: FLOOR_ITEM_SCALE,
      };
}
