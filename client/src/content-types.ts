// Shape of the `virtual:rpg-content` module (built by vite/content.ts from data/ and i18n/).

export interface ItemDef {
  /** Content ID in data/items ("grass"). */
  id: string;
  /** Sprite path in the atlas ("ground/grass"); empty when the item has none. */
  sprite: string;
  /** A ground item (drawn first, fills the tile). */
  ground: boolean;
  /** Ground items: creatures can stand on it. */
  walkable: boolean;
  /** Items on the stack: nothing can stand on the tile. */
  blocks: boolean;
  /** Ground terrain cost in percent (100 = normal). */
  speed: number;
}

export interface ClientContent {
  /** By numeric item ID (data/ids.lock.yaml), the ID the protocol uses. */
  items: Record<number, ItemDef>;
  /** Atlas sprite path of each monster (data/monsters id → "creatures/wolf"). */
  monsterSprites: Record<string, string>;
  /** Vocation IDs a new character can pick (data/vocations.yaml, in file order). */
  vocations: string[];
  movement: { baseStepMs: number; diagonalCost: number; maxPathTiles: number };
  /** Language → key → text. */
  i18n: Record<string, Record<string, string>>;
}
