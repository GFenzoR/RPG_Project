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
  /** Several units share one stack (MoveItem sends a count). */
  stackable: boolean;
  /** Slots of a container item (0 = not a container). */
  slots: number;
}

/** A spell of data/spells.yaml, for the hotkey bar (the server validates every cast). */
export interface SpellDef {
  id: string;
  words: string;
  /** attack | healing | support: casting blocks the group for its group cooldown. */
  group: string;
  level: number;
  magicLevel: number;
  mana: number;
  vocations: string[];
}

export interface ClientContent {
  /** By numeric item ID (data/ids.lock.yaml), the ID the protocol uses. */
  items: Record<number, ItemDef>;
  /** Atlas sprite path of each monster (data/monsters id → "creatures/wolf"). */
  monsterSprites: Record<string, string>;
  /** Vocation IDs a new character can pick (data/vocations.yaml, in file order). */
  vocations: string[];
  /** data/spells.yaml in file order. */
  spells: SpellDef[];
  movement: { baseStepMs: number; diagonalCost: number; maxPathTiles: number };
  /** Language → key → text. */
  i18n: Record<string, Record<string, string>>;
}
