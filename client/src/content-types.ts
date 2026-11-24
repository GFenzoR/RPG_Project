// Shape of the `virtual:rpg-content` module (built by vite/content.ts from data/ and i18n/).
import type { LivingWorldData } from "@rpg/living-world/data";
import type { Look, LookTables, Worn, WornPiece } from "@rpg/renderer/look";

/** An item attribute of data/attributes.yaml: the i18n key of its card line, with {value}. */
export interface AttributeDef {
  text: string;
  /** What all worn items add up to, at most (0 or absent: no cap). */
  cap?: number;
}

/**
 * An item instance's own data (ItemStack.mods, docs/05): the one attribute an equipable
 * rolled, with its value, and its refine level (the forge; 0 = none).
 */
export interface ItemMods {
  attribute: string;
  value: number;
  refine: number;
  /** Remains a monster left: its data/monsters id (named and drawn after it, docs/05). */
  remainsOf?: string;
  /** A player's body: the player's name ("body of <player>"). */
  bodyOf?: string;
}

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
  /**
   * Ground items: what it is made of for the living world (data/items `ground.surface`,
   * livingworld/README.md). Absent on other items and on grounds without one.
   */
  surface?: string;
  /** Several units share one stack (MoveItem sends a count). */
  stackable: boolean;
  /** Slots of a container item (0 = not a container). */
  slots: number;
  /** A tool: using it picks a tile to use it on (UseItemOn), e.g. a rod on water. */
  useWith: boolean;
  /** It may change hands in the trade window (T5.3). */
  tradeable?: boolean;
  /** It may be offered on the global market: tradeable, not money, not fixed (T5.3). */
  marketable?: boolean;
  /** tool.use of a tool ("mining", "fishing"...; "" = not a tool): picks its gather sound. */
  toolUse?: string;
  /**
   * The look of a portal (a `portal` block in data/items: stairs, a ladder, a hole...): a
   * map item nobody moves, under whatever is dropped there. The touch menu offers no
   * "use" or "move" for it (state/items.ts menuItem). Absent on any other item.
   */
  portal?: true;
  /** A map door (a `door` block in data/items: open or shut). Absent on any other item. */
  door?: true;
  /**
   * What it is in the living world (data/livingworld, livingworld/README.md): a breakable
   * object or its debris, a pushable object (walking into it pushes it), a gate or a
   * pressure plate. Absent on any other item.
   */
  living?: "breakable" | "debris" | "pushable" | "gate" | "plate";
  /** The material of its particles (data/livingworld `effect`), with `living`. */
  livingEffect?: string;
  /**
   * A border piece of data/borders.yaml (docs/06 "Bordes"): the fringe of a neighbour's
   * ground drawn on the tile, never its top item (state/items.ts topItem looks past it).
   * Absent on any other item.
   */
  border?: true;
  /**
   * docs/17 ART-8: sprite pixels it raises what is stacked on it and the creature standing
   * there (a table, a crate). Display only. Absent when it raises nothing.
   */
  elevation?: number;
  /**
   * i18n key of its `description` in data/items ("item.iron_sword.desc", or a sign's
   * "text.volcan.dock_sign"): looking at the item shows it. Absent when it has none.
   */
  desc?: string;
  // ---- What the item card shows (docs/17 UI-6: right click, tooltip, shop). Optional so
  // fixtures can leave them out; the server keeps every rule, these are for display. ----
  /** data/items `kind` ("weapon", "armor", "consumable"...): the card's type line and the
   * shop's category. */
  kind?: string;
  /** Grams (docs/06), shown in g or kg (state/units.ts). Absent for 0. */
  weight?: number;
  weapon?: WeaponStats;
  /** Ammunition: the type of the bows that shoot it and the attack it adds. */
  ammo?: { type: string; attack: number };
  armor?: { slot: string; armor: number };
  shield?: { defense: number };
  /** What eating or drinking it does (each field 0 when it does not). */
  consumable?: { healHp: number; healMp: number; foodMs: number };
  /** A rune: the spell it casts, its charges and the magic level it asks for. */
  rune?: { spell: string; charges: number; magicLevel: number };
  /** Equipping it asks for a level and maybe a vocation (vocations empty = any). */
  requires?: { level: number; vocations: string[] };
  /** `pickupable: false`: a map fixture nobody carries (a station, a board). */
  fixed?: true;
  /**
   * `market_board: true` (T5.3) or `stash: true` (docs/02 "Baúl de la cuenta"): using it
   * opens the global market or the account stash.
   */
  board?: true;
  /** `quest: true` (docs/17 UI-6): a quest item, named in the quest colour. */
  quest?: true;
  /**
   * A readable book or scroll (docs/02 "Libros y cofres"): the i18n keys of its title and
   * pages. Using it opens the reading window with the texts the client already has
   * (ui/Book.tsx); the server is not asked. Absent on any other item.
   */
  book?: BookDef;
  /** A reward chest of the map (`chest` block): using it asks the server, which gives once. */
  chest?: true;
  /**
   * How the piece shows on the engine humanoid that wears it (data/items `worn`, docs/06
   * "Looks"): a shape of data/looks.yaml and a tint. Absent: it is not drawn on the figure.
   */
  worn?: WornPiece;
}

/** The `book` block of an item (data/items): i18n keys of i18n/<lang>/books.yaml. */
export interface BookDef {
  title: string;
  pages: string[];
}

/** The `weapon` block of an item (data/items). */
export interface WeaponStats {
  /** sword | axe | club | distance | wand */
  type: string;
  attack: number;
  defense: number;
  hands: number;
  /** Tiles; 0 for melee weapons. */
  range: number;
  /** Element of a wand's shot ("" = none). */
  element: string;
  /** The ammo type a distance weapon shoots ("" = none). */
  ammo: string;
}

/**
 * The topic of an NPC dialog option (docs/17 UI-8): the dialog groups its buttons by it,
 * with an icon and a colour each. "back" and "bye" go to their own row.
 */
export type DialogTopic = "quests" | "trade" | "travel" | "services" | "talk" | "back" | "bye";

/**
 * A player outfit of data/outfits.yaml (docs/06 "Looks"): the body a player is drawn with
 * until its own look arrives, its clothes, and whether it is a costume (a shop outfit: its
 * clothes cover the torso, legs and feet even over armour).
 */
export interface OutfitDef {
  id: string;
  /** Sprite folder of the still previews: "<sprite>/<n|e|s|w>_<frame>" in the atlas. */
  sprite: string;
  /** Preview frames per facing. */
  frames: number;
  /** Absent in fixtures and old content: the client draws the outfit's sprite instead. */
  look?: Look;
  clothes?: Worn;
  costume?: boolean;
}

/**
 * The choices of a player's look (data/looks.yaml, docs/02 "Apariencia"), in file order:
 * what the pickers offer. Skins only a player may choose (no creatures_only one).
 */
export interface LookOptions {
  /** male, female: drawn per sex (the first of the pickers). */
  sexes: string[];
  builds: string[];
  skins: string[];
  hairStyles: string[];
  hairColors: string[];
  beards: string[];
}

/** Kinds of data/cosmetics.yaml (T5.7); "mount" is reserved and not sold yet. */
export type CosmeticKind = "outfit" | "outfit_color" | "name_effect";

/** How a name_effect cosmetic draws the name label (render/cosmetics.ts NAME_EFFECTS). */
export type NameEffectStyle = "gold" | "ember" | "frost";

/** A cosmetic of data/cosmetics.yaml (T5.7). Looks only: no game rule reads it. */
export interface CosmeticDef {
  id: string;
  kind: CosmeticKind;
  /** Price in premium currency (the server decides; this is for display). */
  price: number;
  /** kind outfit: id of the look in data/outfits.yaml. */
  outfit?: string;
  /** kind outfit_color: "#rrggbb" multiply tint over the outfit. */
  tint?: string;
  /** kind name_effect. */
  style?: NameEffectStyle;
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

/**
 * balance.yaml forge (docs/02 "Forja"): the refine of an equipable at the station item. The
 * server keeps every rule; the forge window shows the chance, the cost and the gain with it.
 */
export interface ForgeRules {
  /** Numeric id of the station item (the anvil). */
  station: number;
  /** An attempt to reach this level or a lower one never fails. */
  safeLevel: number;
  /** Numeric id of the protection material. */
  protection: number;
  /** +1 chance point every perLevels levels of skill (smithing), at most max. */
  smithingBonus: { skill: string; perLevels: number; max: number };
  /** % of a jewel's attribute value each level adds. */
  jewelryPct: number;
  /** The attempt to reach +1, +2...: success % and stones; its length is the top level. */
  levels: { chance: number; stones: number }[];
  /** By the item's requires.level, ascending from 1. stone is a numeric item id. */
  bands: {
    level: number;
    stone: number;
    gold: number;
    attack: number;
    armor: number;
    defense: number;
  }[];
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
  /**
   * A music track's measures (make music-gemini): its length, where its body ends and the
   * seconds the director may start it from. No `seconds`: a loop file.
   */
  seconds?: number | undefined;
  end?: number | undefined;
  entries?: number[] | undefined;
}

/** Crossfade lengths of the music, ms, by what changed (audio/director.ts Fades). */
export interface MusicFades {
  zone: number;
  bossIn: number;
  bossOut: number;
  title: number;
  next: number;
}

/**
 * The music (assets/sounds.yaml `music`, audio/director.ts): every place names a pool of
 * tracks. Islands and the underground are the zones; the title screen and each boss
 * (monster content id) have their own, each optional. Ordinary fights have none: the owner
 * keeps the zone's music on in a fight (2026-11-18).
 */
export interface MusicRules {
  /** Pool id → its tracks (music sound ids). */
  pools: Record<string, string[]>;
  /** Island id → pool. */
  islands: Record<string, string>;
  /** The pool of the floors under the sea (z > 7). */
  underground: string | undefined;
  /** Outside the game: the login, sign-up and character screens. */
  title: string | undefined;
  /** Monster content id → the pool that plays while one is in view, over everything. */
  bosses: Record<string, string>;
  fades: MusicFades;
  dwellMs: number;
  bossHoldMs: number;
  resumeMs: number;
  gapMs: [number, number];
}

/**
 * An important quest's music (`music` in data/quests/<id>.yaml): its pool plays while the
 * player stands in one of its rectangles on one of its floors, over the zone's.
 */
export interface QuestMusic {
  quest: string;
  pool: string;
  floors: number[];
  rects: { x: number; y: number; w: number; h: number }[];
}

/** assets/sounds.yaml as the client uses it (vite/content.ts). */
export interface SoundManifest {
  sounds: Record<string, SoundDef>;
  /** Event name → sound ids (one is picked at random). */
  events: Record<string, string[]>;
  music: MusicRules;
}

/** An island's rectangle (world/world.yaml), to know where the player is. */
export interface IslandRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** balance.yaml experience as the client reads it (vite/content.ts). */
export interface ExperienceCurve {
  a: number;
  b: number;
  c: number;
  d: number;
  /** The highest level (0 = none known). */
  maxLevel: number;
}

export interface ClientContent {
  /** By numeric item ID (data/ids.lock.yaml), the ID the protocol uses. */
  items: Record<number, ItemDef>;
  /**
   * data/livingworld/*.yaml (livingworld/README.md): surfaces and plants. Optional so
   * fixtures can leave it out (then the living world shows nothing).
   */
  livingWorld?: LivingWorldData;
  /**
   * The item attributes of data/attributes.yaml by id (docs/02 "Atributos de items"): what
   * an instance's ItemMods.attribute names. Optional so fixtures can leave it out (then an
   * attribute shows no line).
   */
  attributes?: Record<string, AttributeDef>;
  /** Atlas sprite path of each monster (data/monsters id → "creatures/wolf"). */
  monsterSprites: Record<string, string>;
  /**
   * NPC id → option text key → topic (docs/17 UI-8), deduced at build time from the
   * dialogs of data/npcs and the routes of data/boat_routes.yaml (vite/content.ts
   * dialogTopics); an option's `tag` wins. Optional so fixtures can leave it out (every
   * option is then "talk", but "dialog.back" and "dialog.bye").
   */
  dialogTopics?: Record<string, Record<string, DialogTopic>>;
  /**
   * Atlas sprite path of each NPC (data/npcs id → "npcs/ferryman", T0.5). Optional so
   * fixtures can leave it out.
   */
  npcSprites?: Record<string, string>;
  /** data/outfits.yaml in file order (T0.5). Optional so fixtures can leave it out. */
  outfits?: OutfitDef[];
  /**
   * data/looks.yaml (docs/06 "Looks"): the skin, hair and material tints and what a head
   * piece hides. Optional so fixtures can leave it out (then no creature is a paper doll).
   */
  looks?: LookTables;
  /**
   * The choices of a player's look (data/looks.yaml): the pickers of the creation screen
   * and the Apariencia window. Optional so fixtures can leave it out (then no pickers). The
   * NPCs' and monsters' looks come from the server in their Creature, not from here.
   */
  lookOptions?: LookOptions;
  /**
   * data/cosmetics.yaml cosmetics in file order (T5.7). Optional so fixtures can leave it
   * out (then every player wears the default look).
   */
  cosmetics?: CosmeticDef[];
  /** Vocation IDs a new character can pick (data/vocations.yaml, in file order). */
  vocations: string[];
  /**
   * Each vocation's start_kit (data/vocations.yaml, item ids): the creation screen shows
   * the class's own pieces. Optional so fixtures can leave it out (then no kit line).
   */
  startKits?: Record<string, { item: string; count: number }[]>;
  /** data/spells.yaml in file order. */
  spells: SpellDef[];
  /** data/recipes.yaml in file order (T3.4). */
  recipes: RecipeDef[];
  /**
   * balance.yaml forge (docs/02 "Forja"); absent when it is off or in fixtures that leave it
   * out (then the anvil only crafts).
   */
  forge?: ForgeRules | undefined;
  /**
   * balance.yaml movement: the step formula and the click-to-walk limit. How many keyboard
   * steps the client predicts ahead comes from the server (Welcome.max_queued_steps).
   */
  movement: { baseStepMs: number; diagonalCost: number; maxPathTiles: number };
  /** balance.yaml chat (T1.13): the server enforces it, the input only caps to it. */
  chat: { maxLength: number };
  /**
   * balance.yaml experience: the level curve (total experience for level n is
   * a·n³ + b·n² + c·n + d) and the top level, for the experience bar's tooltip (state/
   * experience.ts). Optional so fixtures can leave it out (then the tooltip has no "to the
   * next level").
   */
  experience?: ExperienceCurve | undefined;
  /**
   * balance.yaml guild (T5.1): shown in the guild panel and caps its inputs; the server
   * enforces it. Optional so test fixtures can leave it out.
   */
  guild?: { foundCost: number; foundMinLevel: number; nameMax: number; motdMax: number };
  /** Sounds, event mapping and loops (assets/sounds.yaml, T3.7). */
  sounds: SoundManifest;
  /** The music areas of important quests (data/quests `music`; optional in fixtures). */
  questMusic?: QuestMusic[] | undefined;
  islands: IslandRect[];
  /**
   * Door tiles of the houses ("x,y,z", world/islands/<id>/houses.yaml, T5.4): a right
   * click on a bare door opens the house window. Optional so fixtures can leave it out.
   */
  houseDoors?: string[];
  /**
   * Entrance tile ("x,y,z") → kind of each portal (world/islands/<id>/portals.yaml): paths
   * go round stairs, holes and teleports; a right click on a bare ladder or rope spot uses
   * its ground (state/portals.ts). Optional so fixtures can leave it out.
   */
  portals?: Record<string, string>;
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
  /** client.yaml, vocations.yaml, site.yaml, world.yaml and cosmetics.yaml per language. */
  i18n: Record<string, Record<string, string>>;
  vocations: string[];
  /** Skill ids of data/balance.yaml, in their order: the highscore categories. */
  skills: string[];
  /** Newest first. */
  news: NewsPost[];
  /** data/cosmetics.yaml cosmetics in file order (T5.7): kind, look and tint for the shop. */
  cosmetics?: CosmeticDef[];
  /** data/outfits.yaml (T5.7): the shop previews an outfit with its south-facing frame. */
  outfits?: OutfitDef[];
  /** The /credits page (docs/17 A1), read from assets/CREDITS.md and the packs' CSVs. */
  credits?: Credits;
}

/**
 * Third-party art and fonts the game ships and their attribution (docs/17 A1), built by
 * client/vite/credits.ts from assets/CREDITS.md and each pack's per-file CREDITS.csv.
 */
export interface Credits {
  /** The pack rows of the first table of CREDITS.md. */
  packs: PackCredit[];
  /** Per-file credits of the packs that have them, files with the same credit grouped. */
  files: FileCredit[];
  /** Sprites composed from vendor files ("Obras derivadas de terceros"), by licence. */
  derived: DerivedCredit[];
  /** The "Fuentes (OFL 1.1)" table. */
  fonts: FontCredit[];
  /** Art and music made with the owner's Gemini ("Generado con IA", docs/17 SRC-5). */
  ai: AiCredit[];
}

/** One row of "Generado con IA": what it made, when, and the committed prompt. */
export interface AiCredit {
  /** Sprite ids or asset paths without assets/ ("creatures/wolf", "sounds/music/puerto"). */
  works: string[];
  /** The day it was asked (YYYY-MM-DD). */
  date: string;
  /** The prompt file, assets/prompts/... */
  prompt: string;
}

export interface PackCredit {
  /** Its folder, assets/vendor/<pack>/; its name and author are site.credits.pack.<pack>.* */
  pack: string;
  /** The licences its row names, GPL left out ("CC0 1.0", "OGA-BY 3.0"...). */
  licences: string[];
  /** Where it comes from. */
  url: string;
  /** Its files carry their own credits (entries of `files`). */
  perFile: boolean;
}

export interface FileCredit {
  pack: string;
  /** The works: the folders of the files inside the pack ("hair/long/adult"). */
  works: string[];
  authors: string[];
  /** The one licence the files are used under (CREDITS.md "Licencia por archivo"). */
  licence: string;
  urls: string[];
}

export interface DerivedCredit {
  licence: string;
  /** Sprite ids ("outfits/citizen", "npcs/merchant"). */
  sprites: string[];
}

export interface FontCredit {
  family: string;
  /** The copyright line of its OFL.txt. */
  copyright: string;
  licence: string;
  url: string;
}
