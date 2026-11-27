// The remains a monster leaves are drawn as its own corpse (docs/02 "Muerte", docs/17): the
// server marks the family's container item with the monster that fell (ItemMods
// remains_of), and the map draws that item with the monster's corpse sprite,
// corpses/<monster id>, which tools/spritegen makes for every monster of data/monsters
// from its own art (recipes/corpses.ts). The map's tile stacks are strings (MapView item
// keys): a plain item is its number, the remains of a monster "<number>@<monster id>".
//
// A corpse per direction (docs/17 "Un cadáver por dirección"): the remains say the way the
// creature faced when it died (ItemMods facing) and the atlas has a corpse fallen each of
// the four straight ways, corpses/<monster> to the south and corpses/<monster>_<e|n|w>.
// The key of remains fallen another way than south ends in "/<e|n|w>".
import { CreatureKind, Direction } from "@rpg/protocol";
import { DEFAULT_FRAME_MS, fallDir } from "@rpg/renderer";
import type { AnimDir, FallDir, TileArt } from "@rpg/renderer";
import type { ItemMods } from "../content-types.ts";

/**
 * The atlas sprite of a monster's corpse fallen facing `dir` (tools/spritegen corpsePath):
 * the south one has the plain path.
 */
export const corpseSprite = (monster: string, dir: FallDir = "s"): string =>
  dir === "s" ? `corpses/${monster}` : `corpses/${monster}_${dir}`;

const FACINGS: Partial<Record<Direction, AnimDir>> = {
  [Direction.NORTH]: "n",
  [Direction.NORTH_EAST]: "ne",
  [Direction.EAST]: "e",
  [Direction.SOUTH_EAST]: "se",
  [Direction.SOUTH]: "s",
  [Direction.SOUTH_WEST]: "sw",
  [Direction.WEST]: "w",
  [Direction.NORTH_WEST]: "nw",
};

/**
 * The way a creature facing `facing` (a Direction of the protocol) falls dead, and its
 * corpse lies: one of the four straight ways (a diagonal falls east or west). Remains that
 * do not say (an older server: UNSPECIFIED or absent) lie facing south.
 */
export const corpseDir = (facing: Direction | undefined): FallDir =>
  fallDir(FACINGS[facing ?? Direction.UNSPECIFIED] ?? "s");

/**
 * The corpse a player's body is drawn as: "body_<sex>" (tools/spritegen corpses.ts), a person
 * lying in the last pose of the fall, in plain clothes. The server says the sex (ItemMods
 * body_sex); a body that does not say (an older server) and whose owner the client never
 * saw alive is a man's.
 */
export const bodyCorpse = (sex: string | undefined): string =>
  sex === "female" ? "body_female" : "body_male";

/**
 * Whose remains a creature leaves when it dies, as their key names them (remainsAre): a
 * monster's id, "body_<sex>" for a player. Undefined: none that the client can tell (an
 * NPC, a creature without a content id).
 */
export function remainsWho(
  kind: CreatureKind,
  contentId: string,
  sex: string | undefined,
): string | undefined {
  if (kind === CreatureKind.PLAYER) return bodyCorpse(sex);
  return kind === CreatureKind.MONSTER && contentId ? contentId : undefined;
}

/**
 * The MapView key of a tile item: its number, "<number>@<monster>" for the remains of a
 * monster and "<number>@body_<sex>" for the body of a player, each followed by "/<e|n|w>"
 * when they lie fallen another way than south.
 */
export function mapItemKey(itemId: number, mods: ItemMods | undefined): string {
  const who = mods?.remainsOf || (mods?.bodyOf ? bodyCorpse(mods.bodySex) : "");
  if (!who) return String(itemId);
  const dir = corpseDir(mods?.facing);
  return dir === "s" ? `${itemId}@${who}` : `${itemId}@${who}/${dir}`;
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

/**
 * A MapView key back as the item's number and, for remains, the monster that fell (or
 * "body_<sex>") and the way it fell.
 */
export function parseMapItemKey(key: string): {
  itemId: number;
  remainsOf?: string;
  dir?: FallDir;
} {
  const at = key.indexOf("@");
  if (at < 0) return { itemId: Number(key) };
  const itemId = Number(key.slice(0, at));
  const slash = key.indexOf("/", at);
  if (slash < 0) return { itemId, remainsOf: key.slice(at + 1), dir: "s" };
  return { itemId, remainsOf: key.slice(at + 1, slash), dir: wayOf(key, slash + 1) };
}

/**
 * The way the remains of the MapView key `key` lie (undefined: it is not remains): what
 * parseMapItemKey(key).dir says, allocating nothing.
 */
export function keyFallDir(key: string): FallDir | undefined {
  const at = key.indexOf("@");
  if (at < 0) return undefined;
  const slash = key.indexOf("/", at);
  return slash < 0 ? "s" : wayOf(key, slash + 1);
}

/** The way written from `from` to the end of `key`: e, n or w, else south. */
function wayOf(key: string, from: number): FallDir {
  if (key.length !== from + 1) return "s";
  const d = key[from];
  return d === "e" || d === "n" || d === "w" ? d : "s";
}

/**
 * Whether the MapView key `key` is the remains of `who` (a monster's id, or "body_<sex>"),
 * whatever way they lie: what parseMapItemKey(key).remainsOf === who says, allocating
 * nothing.
 */
export function remainsAre(key: string, who: string): boolean {
  const at = key.indexOf("@");
  if (at < 0) return false;
  const slash = key.indexOf("/", at);
  const end = slash < 0 ? key.length : slash;
  return end - at - 1 === who.length && key.startsWith(who, at + 1);
}

/**
 * The atlas sprite of the corpse of `who` fallen facing `dir` that `has` (the atlas) knows:
 * that facing's, else the south one (an atlas from before the four), else undefined.
 */
export function corpseSpriteIn(
  who: string,
  dir: FallDir | undefined,
  has: (sprite: string) => boolean,
): string | undefined {
  const own = corpseSprite(who, dir ?? "s");
  if (has(own)) return own;
  const south = corpseSprite(who);
  return has(south) ? south : undefined;
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

/** The corpse texture of remains: fallen their way, else the south one (corpseSpriteIn). */
function corpseTexture<T>(
  remainsOf: string | undefined,
  dir: FallDir | undefined,
  atlas: MapItemAtlas<T>,
): T | undefined {
  if (!remainsOf) return undefined;
  return (
    (dir !== undefined && dir !== "s" ? atlas.texture(corpseSprite(remainsOf, dir)) : undefined) ??
    atlas.texture(corpseSprite(remainsOf))
  );
}

/**
 * The texture the map draws for the tile item `key`: the corpse of the monster whose
 * remains it is, fallen the way the key says, when the atlas has one (corpses/<monster>
 * for the south, and for any way an older atlas lacks), else the item's own sprite (the
 * family's remains: an atlas older than the monster still shows a body). Undefined: no
 * art at all.
 */
export function mapItemTexture<T>(
  key: string,
  items: MapItemSprites,
  atlas: MapItemAtlas<T>,
): T | undefined {
  const { itemId, remainsOf, dir } = parseMapItemKey(key);
  const corpse = corpseTexture(remainsOf, dir, atlas);
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
  const { itemId, remainsOf, dir } = parseMapItemKey(key);
  const corpse = corpseTexture(remainsOf, dir, atlas);
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
