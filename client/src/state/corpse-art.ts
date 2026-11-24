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
