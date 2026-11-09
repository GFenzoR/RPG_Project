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
  /** A tool: using it picks a tile to use it on (UseItemOn), e.g. a rod on water. */
  useWith: boolean;
  /** tool.use of a tool ("mining", "fishing"...; "" = not a tool): picks its gather sound. */
  toolUse?: string;
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
  /** A heal cast on another player (T3.1): the hotkey asks for the target with a click. */
  aimsAtPlayer: boolean;
}

/** A recipe of data/recipes.yaml (T3.4), for the station window (the server validates). */
export interface RecipeDef {
  id: string;
  /** Skill id that sets the chance (smithing, cooking...). */
  craft: string;
  /** Numeric id of the station item. */
  station: number;
  /** tool.use of a tool the player must carry ("" = none). */
  tool: string;
  level: number;
  timeMs: number;
  inputs: { itemId: number; count: number }[];
  output: { itemId: number; count: number };
  baseSuccess: number;
  successPerLevel: number;
  maxSuccess: number;
}

/** Audio channels with their own volume (T3.7); "master" scales all of them. */
export type SoundChannel = "sfx" | "ui" | "music" | "ambient";

/** A sound of assets/sounds.yaml. */
export interface SoundDef {
  /** URL of the file, relative to the page ("audio/sounds/sfx/hit.ogg"). */
  url: string;
  channel: SoundChannel;
  /** 0..1, multiplied with the channel volume. */
  volume: number;
  /** Copies of this sound that may play at once. */
  maxVoices: number;
}

/** Which loop plays where: by island id, and under the sea floor (z > 7). */
export interface LoopRules {
  fadeMs: number;
  islands: Record<string, string>;
  underground: string | undefined;
}

/** assets/sounds.yaml as the client uses it (vite/content.ts). */
export interface SoundManifest {
  sounds: Record<string, SoundDef>;
  /** Event name → sound ids (one is picked at random). */
  events: Record<string, string[]>;
  music: LoopRules;
  ambient: LoopRules;
}

/** An island's rectangle (world/world.yaml), to know where the player is. */
export interface IslandRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
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
  /** data/recipes.yaml in file order (T3.4). */
  recipes: RecipeDef[];
  movement: { baseStepMs: number; diagonalCost: number; maxPathTiles: number };
  /** balance.yaml chat (T1.13): the server enforces it, the input only caps to it. */
  chat: { maxLength: number };
  /**
   * balance.yaml guild (T5.1): shown in the guild panel and caps its inputs; the server
   * enforces it. Optional so test fixtures can leave it out.
   */
  guild?: { foundCost: number; foundMinLevel: number; nameMax: number; motdMax: number };
  /** Sounds, event mapping and loops (assets/sounds.yaml, T3.7). */
  sounds: SoundManifest;
  islands: IslandRect[];
  /** Language → key → text. */
  i18n: Record<string, Record<string, string>>;
}

/** A post of data/news (T4.3); title and body per language. */
export interface NewsPost {
  /** File name without .yaml ("2026-11-01-welcome"): the URL /news/<slug>. */
  slug: string;
  date: string;
  title: Record<string, string>;
  /** Minimal Markdown subset (site/markdown.ts), rendered as text. */
  body: Record<string, string>;
}

/** Shape of the `virtual:rpg-site` module (the public website, T4.3). */
export interface SiteContent {
  /** client.yaml, vocations.yaml and site.yaml per language. */
  i18n: Record<string, Record<string, string>>;
  vocations: string[];
  /** Skill ids of data/balance.yaml, in their order: the highscore categories. */
  skills: string[];
  /** Newest first. */
  news: NewsPost[];
}
