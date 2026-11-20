// The client's picture of the world, rebuilt from server events (docs/05, "Mensajes
// servidor → cliente"): known tiles by chunk, the creatures in view and how they move.
// Pure logic over plain data: no PixiJS, no DOM, no clock (callers pass `now` in ms).
//
// Own movement is predicted a few steps ahead (client/CLAUDE.md "Movimiento fluido"): a
// step the player asks for is drawn right after the one before; the server's CreatureMove
// confirms each (and gives the real duration) and WalkRejected puts the creature back
// where the server says it is, gliding. Steps the server takes (other creatures, a
// click-to-walk path) are drawn on the server's tick timeline (state/motion.ts Playout).
import type { StationState } from "./recipes.ts";
import { refineOutcome } from "./forge.ts";
import type { RefineState } from "./forge.ts";

/** How long before its time a presence check closes (covers the latency). */
export const PRESENCE_GRACE_MS = 3000;

/** A presence check (T4.1): the question's i18n key, the options and when it runs out. */
export interface PresenceState {
  id: number;
  question: string;
  options: { id: number; key: string }[];
  until: number;
}
import { CreatureKind, Direction, EquipmentSlot, MessageKind } from "@rpg/protocol";
import type {
  AttackKind,
  Cosmetics,
  DisappearReason,
  Creature,
  Skull,
  ItemStack,
  MapArea,
  ServerMessage,
  TextParam,
  FloatingTextKind,
} from "@rpg/protocol";
import { CHUNK_TILES } from "@rpg/renderer/camera";
import type { ChunkData, TileSource } from "@rpg/renderer";
import type { Look, Worn } from "@rpg/renderer/look";
import type { ClientContent, ItemDef, ItemMods } from "../content-types.ts";
import type { Cooldown } from "./hotkeys.ts";
import { EquippedBackpack } from "./backpack.ts";
import { modsOf } from "./mods.ts";
import { delta, directionTo, isDiagonal, samePos, step } from "./geometry.ts";
import {
  PLAYOUT_CATCH_UP,
  PLAYOUT_MAX_LAG_MS,
  PREDICT_TIMEOUT_MS,
  Playout,
  STEP_LEAD_MS,
  ownSlideMaxTiles,
  slideBetween,
  slideLeft,
  stepChoices,
} from "./motion.ts";
import type { Slide } from "./motion.ts";
import { movesOnStep } from "./portals.ts";
import { NO_POCKETS } from "./pockets.ts";
import type { PocketsState } from "./pockets.ts";
import { PartyState } from "./party.ts";
import { GuildState } from "./guild.ts";
import { tutorialFrom } from "./tutorial.ts";
import { questLogFrom } from "./quests.ts";
import { equipmentView, lookView, sameEquipment, sameLook, sameWorn, wornView } from "./look.ts";
import type { EquipmentView } from "./look.ts";
import type { QuestLogView } from "./quests.ts";
import { heavyHit } from "../render/shake.ts";
import { houseFrom } from "./house.ts";
import type { HouseView } from "./house.ts";
import { applyMarket, tradeFrom } from "./market.ts";
import type { MarketView, TradeView } from "./market.ts";
import type { TutorialView } from "./tutorial.ts";
import type { Pos } from "./geometry.ts";
import { CLASSIC_VIEW, serverView } from "./view.ts";
import type { ViewTiles } from "./view.ts";

export interface Walk {
  from: Pos;
  to: Pos;
  /** Local time the step starts, ms (it may be ahead: then `prev` is still drawn). */
  start: number;
  duration: number;
  /** The step before, while it is still being drawn (it ends when this one starts). */
  prev?: Walk | undefined;
}

/** An own step the client predicted and sent, until the server confirms it. */
export interface PredictedStep {
  from: Pos;
  to: Pos;
  walk: Walk;
  /** Its Walk's number (Walk.seq): the CreatureMove of the step carries it back. */
  seq: number;
}

/** System messages that mean the server dropped (or refused) the player's target. */
const TARGET_REFUSED = new Set([
  "combat.cannot_attack",
  // T5.2: an attack on a player the rules do not allow.
  "pvp.off",
  "pvp.staff",
  "pvp.protected_staff",
  "pvp.your_level",
  "pvp.their_level",
  "pvp.zone",
  "pvp.safe_mode",
]);

export interface CreatureState {
  id: number;
  kind: CreatureKind;
  name: string;
  contentId: string;
  /** Logical position: it changes when a step starts (as on the server). */
  pos: Pos;
  dir: Direction;
  speed: number;
  /** Health bar, 0-100. */
  health: number;
  walk: Walk | undefined;
  /** A correction of where it is drawn, gliding out (state/motion.ts). */
  slide?: Slide | undefined;
  /** A player's guild name (T5.1), "" for none. */
  guild: string;
  /** A player's PvP mark (T5.2). */
  skull: Skull;
  /** A player's equipped cosmetics (T5.7): content ids, "" = default look. Looks only. */
  cosmetics: CosmeticsView;
  /**
   * The body of an engine humanoid (docs/05 "Apariencia y equipo visible"): a player's,
   * an NPC's or a humanoid monster's; undefined for a beast (or an old server).
   */
  look: Look | undefined;
  /** A player's visible slots: item ids (Creature.equipment, CreatureLook). */
  equipment: EquipmentView;
  /** What an NPC or a humanoid monster wears (its data's pieces, which are no items). */
  worn: Worn | undefined;
  /**
   * Takes a new value whenever the look, the visible equipment or the cosmetics change,
   * and when the creature appears again: the canvas builds its figure again when it
   * differs. The values come from one counter of the WorldState, so a creature sent again
   * after a FullMapView never repeats the value its sprite was drawn with.
   */
  lookRev: number;
}

/** Equipped cosmetics by slot (protocol Cosmetics); "" = the default look of that kind. */
export interface CosmeticsView {
  outfit: string;
  color: string;
  nameEffect: string;
}

/** The player's own shop state (CosmeticsState, T5.7). */
export interface CosmeticsStateView {
  owned: string[];
  balance: number;
  equipped: CosmeticsView;
}

const cosmeticsView = (c: Cosmetics | undefined): CosmeticsView => ({
  outfit: c?.outfit ?? "",
  color: c?.color ?? "",
  nameEffect: c?.nameEffect ?? "",
});

/** Whether the canvas draws a and b with the same figure (kind, sprite, body, dress). */
const sameFigure = (a: CreatureState, b: CreatureState): boolean =>
  a.kind === b.kind &&
  a.contentId === b.contentId &&
  sameLook(a.look, b.look) &&
  sameEquipment(a.equipment, b.equipment) &&
  sameWorn(a.worn, b.worn) &&
  a.cosmetics.outfit === b.cosmetics.outfit &&
  a.cosmetics.color === b.cosmetics.color &&
  a.cosmetics.nameEffect === b.cosmetics.nameEffect;

/** A visual effect on a tile (Effect.effect_id, docs/05 "Combate"). */
export interface EffectState {
  pos: Pos;
  effectId: number;
  start: number;
}

/** A projectile flying between two tiles (Projectile.projectile_id, T1.9). */
export interface ProjectileState {
  from: Pos;
  to: Pos;
  projectileId: number;
  start: number;
}

/**
 * A CreatureAttack (A9, docs/05 "Quién ataca y por qué sale una criatura"): creature `id`
 * attacked `targetId` (0: an area, or a target out of the window) towards `to`.
 */
export interface AttackState {
  id: number;
  kind: AttackKind;
  targetId: number;
  to: Pos;
  /** An area spell's radius around `to`; 0 for one target. */
  radius: number;
  start: number;
}

/** Why a creature left the view (CreatureDisappear.reason), kept a moment for the canvas. */
export interface DepartureState {
  id: number;
  reason: DisappearReason;
  start: number;
  /**
   * It came back into view since (a player that died and woke up at a temple in view, a
   * teleport within the view): departureOf no longer gives this reason, but the canvas
   * still plays the leaving where it was (render/game-canvas.ts).
   */
  back: boolean;
}

/** A number rising from a tile: damage, healing, experience. */
export interface FloatingTextState {
  pos: Pos;
  kind: FloatingTextKind;
  amount: number;
  start: number;
}

/** A server message for the status log: an i18n key plus its parameters. */
export interface LogMessage {
  key: string;
  params: TextParam[];
  at: number;
}

/**
 * A chat line (T1.13). Player text travels as is in `text` and is only ever rendered as
 * DOM text; what the server or an NPC says is an i18n key in `localized`.
 */
export interface ChatLine {
  kind: MessageKind;
  /** A speaking player's name; empty for NPCs and monsters. */
  speakerName: string;
  /** Monster or NPC content id when they speak. */
  speakerContentId: string;
  text: string | undefined;
  localized: { key: string; params: TextParam[] } | undefined;
  at: number;
}

export interface PlayerStatsState {
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  level: number;
  experience: number;
  /** Progress to the next level, 0-99. */
  levelPercent: number;
  /** Free capacity and maximum, in grams. */
  capacity: number;
  maxCapacity: number;
  /** Speed with the speed conditions (T3.2): what steps last. */
  speed: number;
}

/** One skill as PlayerSkills reports it (skill ids from data/balance.yaml). */
export interface SkillState {
  id: string;
  level: number;
  /** Progress to the next level, 0-99. */
  percent: number;
}

/**
 * The statuses with no end (docs/05 "Condiciones"): their remaining_ms is always 0, which
 * only for them means "no end"; any other id with 0 left is ending now.
 */
export const ENDLESS_STATUSES: ReadonlySet<string> = new Set(["protection_zone"]);

/** The last death (death.died), for the death screen. */
/**
 * One of the player's own active conditions (PlayerConditions, T3.2), or a status the
 * server adds to them (in_combat, pvp_locked, protection_zone: docs/05 "Condiciones").
 */
export interface ConditionView {
  /**
   * balance.yaml conditions id (poison, hasted...) or a status id (name:
   * condition.<id>.name, what it does: condition.<id>.desc).
   */
  id: string;
  /**
   * performance.now() at which it ends (or its last hit lands); undefined for one with no
   * end (ENDLESS_STATUSES: protection_zone).
   */
  until: number | undefined;
  /** Hits left of a damage condition (0 for the others). */
  ticks: number;
}

export interface DeathState {
  /** Experience lost. */
  experience: number;
  /** Blessings that softened the death (and were consumed). */
  blessings: number;
  at: number;
}

/** The last voyage (travel.sailed, T3.5): the island sailed to, for the fade. */
export interface VoyageState {
  island: string;
  at: number;
}

/** The last level-up (progress.level_up), for the on-screen notice. */
export interface LevelUpState {
  level: number;
  at: number;
}

/** Effect ids (server/internal/session/combat.go). */
export const EFFECT_HIT = 1;
export const EFFECT_BLOCK = 2;
/** Magic effects (server/internal/session/magic.go): heal, conjure, and the element of
 * an elemental hit or area tile as EFFECT_ELEMENT + index of ELEMENTS. */
export const EFFECT_HEAL = 3;
export const EFFECT_CONJURE = 4;
export const EFFECT_ELEMENT = 10;
/** Gathering (server/internal/session/gathering.go): a harvest, or an attempt that got nothing. */
export const EFFECT_GATHER = 5;
export const EFFECT_GATHER_MISS = 6;
/** A condition spell on its target, or a cure (T3.2, server/internal/session/condition.go). */
export const EFFECT_BUFF = 7;
/** The forge (docs/02 "Forja", server/internal/session/refine.go) on the anvil: sparks on a
 * success, a shatter on a break or when the protection breaks instead. */
export const EFFECT_REFINE = 8;
export const EFFECT_SHATTER = 9;
/** Projectile ids are PROJECTILE_ELEMENT + index of ELEMENTS. */
export const PROJECTILE_ELEMENT = 1;
export const ELEMENTS = ["physical", "fire", "ice", "energy", "earth", "holy", "death"] as const;
/** Flight time of a projectile, ms. */
export const PROJECTILE_MS = 250;
/** How long effects and floating texts live, ms. */
export const EFFECT_MS = 600;
export const FLOATING_TEXT_MS = 1000;
/** How long attacks (for the hits of their batch) and departures are kept, ms. */
export const ATTACK_MS = FLOATING_TEXT_MS;
export const DEPARTURE_MS = 1000;

/** Removes, in place and keeping the order, the entries that started `ms` or more before now. */
export function dropFinished(list: { start: number }[], now: number, ms: number): void {
  let kept = 0;
  for (let i = 0; i < list.length; i++) {
    const x = list[i];
    if (x && now - x.start < ms) list[kept++] = x;
  }
  list.length = kept;
}

/**
 * Adds x (started now) to a list kept in start order, first dropping what finished if its
 * oldest entry did. The canvas drops them every frame (WorldState.expire), but a tab in the
 * background draws no frames: without this the lists would grow with every batch until it
 * comes back, and so would what walks them on the way in (a departure forgotten on every
 * CreatureAppear) and on the first frame back. One pass per batch at most: the entries of
 * one batch start together.
 */
function pushLive<T extends { start: number }>(list: T[], x: T, ms: number): void {
  const first = list[0];
  if (first && x.start - first.start >= ms) dropFinished(list, x.start, ms);
  list.push(x);
}

/** Status log length. */
const LOG_SIZE = 5;
/** Chat lines kept on screen. */
export const CHAT_SIZE = 50;

interface ChunkTiles {
  /** Item IDs per tile (ground first), row-major; undefined = unknown. */
  tiles: (readonly number[] | undefined)[];
  /** Stack sizes per tile, only for tiles with a stackable item (0 = not stackable). */
  counts: (readonly number[] | undefined)[];
  /** Each item's mods, only for tiles with an item that has some (an equipable's attribute). */
  mods: (readonly (ItemMods | undefined)[] | undefined)[];
  /** What the renderer sees; rebuilt (new object) after a change. */
  data: ChunkData | undefined;
}

/** Chunks farther than this from the own creature are forgotten. */
const KEEP_CHUNKS = 2;

const chunkKey = (z: number, cx: number, cy: number): string => `${z}/${cx}/${cy}`;

const posOf = (p: { x: number; y: number; z: number } | undefined): Pos =>
  p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 };

/**
 * One item as the client sees it: numeric ID, stack size (0 when it does not stack) and, on
 * an instance with them, its mods (an equipable's attribute, docs/02 "Atributos de items").
 */
export interface ItemView {
  itemId: number;
  count: number;
  mods?: ItemMods | undefined;
}

/** An open container window (ContainerOpen): its session ID, item and content. */
export interface ContainerState {
  id: number;
  itemId: number;
  capacity: number;
  items: ItemView[];
  hasParent: boolean;
}

const itemView = (s: ItemStack): ItemView => {
  const mods = modsOf(s);
  return mods ? { itemId: s.itemId, count: s.count, mods } : { itemId: s.itemId, count: s.count };
};

/** An open NPC dialog (DialogOpen): the NPC's text and the options the player sees. */
export interface DialogState {
  id: number;
  npcId: number;
  /** data/npcs id of the NPC (its name is npc.<id>.name), when the client knows it. */
  npcContentId: string;
  text: string;
  /** Each option's i18n key and its parameters (a blessing's {price}, content audit M6). */
  options: { id: number; text: string; params: TextParam[] }[];
}

/** One line of an open shop (ShopOpen): prices 0 mean the NPC does not trade it that way. */
export interface ShopLine {
  itemId: number;
  buyPrice: number;
  sellPrice: number;
  owned: number;
}

/** The open shop of the dialog's NPC (closes with the dialog). */
export interface ShopState {
  dialogId: number;
  npcId: number;
  money: number;
  lines: ShopLine[];
}

export class WorldState implements TileSource {
  selfId = 0;
  readonly creatures = new Map<number, CreatureState>();
  /**
   * The own steps predicted and sent that the server has not confirmed yet, oldest first
   * (at most Welcome.max_queued_steps: the server queues no more).
   */
  predicted: PredictedStep[] = [];
  /** The seq of the last Walk predicted (docs/05 "Caminar"): one more for each. */
  private walkSeq = 0;
  /** The last lookRev handed out: every new one is greater (CreatureState.lookRev). */
  private lookSeq = 0;
  /** Welcome.max_queued_steps: how many own steps may wait for the server. */
  private maxQueued = 0;
  /**
   * The window the server keeps this client up to date with (Welcome.view_width and
   * view_height, 31x21; 15x11 before the Welcome or from an older server): the canvas
   * draws at most this much (render/viewport.ts).
   */
  view: ViewTiles = CLASSIC_VIEW;
  /**
   * The walk epoch of the last WalkRejected or FullMapView (docs/05 "Caminar"), sent with
   * every Walk: the server drops Walks sent before the client heard of a reset.
   */
  walkEpoch = 0;
  /** Server ticks to local time for the steps the server takes. */
  readonly playout = new Playout();
  /**
   * The predicted own step the server refused (WalkRejected from where it started, that
   * way): a held movement key would predict it again as soon as a step can start, and every
   * refusal brings its message back (portal.blocked: no room on the other side;
   * house.no_access). predictStep keeps off that very step (same tile, same target) until
   * retryWalk (a fresh press or a release of a movement key or the pad, a new direction,
   * a click or a fresh press of the left button on the map), an own move or a full map
   * view. The click's route and the mouse held (state/steering.ts) plan round it.
   */
  private refused: { from: Pos; to: Pos } | undefined;
  /** The own step the server refused last (`refused`), while the client keeps off it. */
  get refusedStep(): Readonly<{ from: Pos; to: Pos }> | undefined {
    return this.refused;
  }
  /** Whether the player is invisible (its own condition): it is drawn see-through. */
  get invisible(): boolean {
    return this.conditions.some((c) => c.id === "invisible");
  }
  /** The creature the player attacks (SetTarget), if any. */
  target: number | undefined;
  stats: PlayerStatsState | undefined;
  /**
   * performance.now() of the last heavy hit to the player (render/shake.ts heavyHit: a
   * tenth of the maximum health or more at once): the canvas shakes its camera (UI-9).
   */
  heavyHitAt: number | undefined;
  skills: SkillState[] = [];
  /** The crafting station the player opened (T3.4), until it closes the window or walks away. */
  station: StationState | undefined;
  /** The last forge attempt's result (docs/02 "Forja"), for the forge window. */
  refine: RefineState | undefined;
  /**
   * A presence check waiting for an answer (T4.1), until answered or out of time (see
   * `activePresence`). The server's clock runs only while the player plays, it is sent
   * again with the time left after every idle stretch, and the server's deadline is never
   * earlier than that time: `until` is later only by the latency. While the player is
   * away it is earlier than the server's (its clock stopped).
   */
  presence: PresenceState | undefined;
  /** The last check answered: the server may send it again before the answer reached it. */
  private presenceAnswered = 0;
  /** The tutorial step on screen (T4.2), until the server says it ended. */
  tutorial: TutorialView | undefined;
  /**
   * The quest log (QuestLog, docs/02 "Diario de misiones"); undefined until the server
   * sends it (at login), or from a server without one.
   */
  quests: QuestLogView | undefined;
  /** The server's clock minus the client's at the Welcome (ms): a task's countdown. */
  clockOffset = 0;
  /** The player's own active conditions (T3.2), in the server's order. */
  conditions: ConditionView[] = [];
  levelUp: LevelUpState | undefined;
  voyage: VoyageState | undefined;
  death: DeathState | undefined;
  effects: EffectState[] = [];
  floatingTexts: FloatingTextState[] = [];
  projectiles: ProjectileState[] = [];
  /**
   * Welcome.attack_events: the server says who attacks whom (`attacks`) and why a
   * creature leaves (`departures`), A9. False for an older server: the canvas works the
   * fights out from effects and projectiles (render/creature-events.ts).
   */
  attackEvents = false;
  attacks: AttackState[] = [];
  departures: DepartureState[] = [];
  /** Running cooldowns (SpellCooldown) by spell ID and by spell group. */
  readonly spellCooldowns = new Map<string, Cooldown>();
  readonly groupCooldowns = new Map<string, Cooldown>();
  log: LogMessage[] = [];
  chat: ChatLine[] = [];
  dialog: DialogState | undefined;
  shop: ShopState | undefined;
  /** The trade window (T5.3), until completed or cancelled. */
  trade: TradeView | undefined;
  /** The market window (T5.3), until closed or the player walks away from the board. */
  market: MarketView | undefined;
  /** The house window (T5.4), until closed or the player walks away from the door. */
  house: HouseView | undefined;
  /** Equipped items by slot (Inventory). */
  inventory = new Map<EquipmentSlot, ItemView>();
  /** What the character's pockets hold and how many cells they have (Inventory, docs/02 "Bolsillos"). */
  pockets: PocketsState = NO_POCKETS;
  /** Open container windows, oldest first. */
  containers: ContainerState[] = [];
  /** Which of them is the equipped backpack, shown under the figure (docs/17 UI-5). */
  readonly backpack = new EquippedBackpack();
  /** The party and pending invitations (T3.3). */
  readonly party = new PartyState();
  /** The guild and the invitations to one (T5.1). */
  readonly guild = new GuildState();
  /** Owned cosmetics, premium balance and what is equipped (T5.7); undefined until sent. */
  cosmetics: CosmeticsStateView | undefined;
  private readonly chunks = new Map<string, ChunkTiles>();
  private readonly content: ClientContent;

  constructor(content: ClientContent) {
    this.content = content;
  }

  get self(): CreatureState | undefined {
    return this.creatures.get(this.selfId);
  }

  item(id: number): ItemDef | undefined {
    return this.content.items[id];
  }

  /** Item IDs of a known tile (ground first), or undefined. */
  tile(x: number, y: number, z: number): readonly number[] | undefined {
    if (x < 0 || y < 0) return undefined;
    const c = this.chunks.get(
      chunkKey(z, Math.floor(x / CHUNK_TILES), Math.floor(y / CHUNK_TILES)),
    );
    return c?.tiles[(y % CHUNK_TILES) * CHUNK_TILES + (x % CHUNK_TILES)];
  }

  /** The mods of each item of a known tile (undefined: none has any), parallel to tile(). */
  tileMods(x: number, y: number, z: number): readonly (ItemMods | undefined)[] | undefined {
    if (x < 0 || y < 0) return undefined;
    const c = this.chunks.get(
      chunkKey(z, Math.floor(x / CHUNK_TILES), Math.floor(y / CHUNK_TILES)),
    );
    return c?.mods[(y % CHUNK_TILES) * CHUNK_TILES + (x % CHUNK_TILES)];
  }

  /** Stack size of each item of a known tile (0 = not stackable), parallel to tile(). */
  tileCounts(x: number, y: number, z: number): readonly number[] | undefined {
    if (x < 0 || y < 0) return undefined;
    const c = this.chunks.get(
      chunkKey(z, Math.floor(x / CHUNK_TILES), Math.floor(y / CHUNK_TILES)),
    );
    return c?.counts[(y % CHUNK_TILES) * CHUNK_TILES + (x % CHUNK_TILES)];
  }

  /** Walkable by what the client knows: known walkable ground and no blocking item. */
  walkable(x: number, y: number, z: number): boolean {
    const t = this.tile(x, y, z);
    if (!t || t.length === 0) return false;
    const ground = this.item(t[0] ?? 0);
    if (!ground?.ground || !ground.walkable) return false;
    return t.every((id) => this.item(id)?.blocks !== true);
  }

  /** Walkable and free of creatures (other than the own one). */
  free(x: number, y: number, z: number): boolean {
    if (!this.walkable(x, y, z)) return false;
    for (const c of this.creatures.values())
      if (c.id !== this.selfId && c.pos.x === x && c.pos.y === y && c.pos.z === z) return false;
    return true;
  }

  // ---- TileSource for @rpg/renderer's MapView ----------------------------------------

  chunk(z: number, cx: number, cy: number): ChunkData | undefined {
    const c = this.chunks.get(chunkKey(z, cx, cy));
    if (!c) return undefined;
    c.data ??= this.chunkData(c);
    return c.data;
  }

  private chunkData(c: ChunkTiles): ChunkData {
    const ground: (string | null)[] = new Array<string | null>(CHUNK_TILES * CHUNK_TILES).fill(
      null,
    );
    const items: { x: number; y: number; stack: string[] }[] = [];
    c.tiles.forEach((t, i) => {
      if (!t || t.length === 0) return;
      const first = t[0] ?? 0;
      const hasGround = this.item(first)?.ground === true;
      if (hasGround) ground[i] = String(first);
      const stack = (hasGround ? t.slice(1) : t).map(String);
      if (stack.length > 0)
        items.push({ x: i % CHUNK_TILES, y: Math.floor(i / CHUNK_TILES), stack });
    });
    return { ground, items };
  }

  // ---- server events ------------------------------------------------------------------

  /** Forgets the check once answered, and ignores it if the server sends it again. */
  answerPresence(id: number): void {
    this.presenceAnswered = id;
    if (this.presence?.id === id) this.presence = undefined;
  }

  /**
   * The presence check still open at now: it closes PRESENCE_GRACE_MS before its time, so
   * an answer from the dialog reaches the server in time (a timeout sends nothing).
   */
  activePresence(now: number): PresenceState | undefined {
    if (this.presence && this.presence.until - PRESENCE_GRACE_MS <= now) this.presence = undefined;
    return this.presence;
  }

  /** How long until the open presence check closes, or undefined if none is open. */
  presenceClosesIn(now: number): number | undefined {
    const p = this.activePresence(now);
    return p && p.until - PRESENCE_GRACE_MS - now;
  }

  /**
   * Local time at which the steps of a batch of server tick `tick`, arriving at `now`,
   * start (the `at` of apply). Call once per batch.
   */
  batchTime(tick: number, now: number): number {
    return this.playout.time(tick, now);
  }

  /**
   * Applies one server event at `now`. `at` is when the steps the server took in its
   * batch start (batchTime); by default now.
   */
  apply(msg: ServerMessage["message"], now: number, at = now): void {
    switch (msg.case) {
      case "welcome":
        this.selfId = msg.value.creatureId;
        this.maxQueued = msg.value.maxQueuedSteps;
        this.view = serverView(msg.value.viewWidth, msg.value.viewHeight);
        this.attackEvents = msg.value.attackEvents;
        if (msg.value.serverTime > 0n) this.clockOffset = Number(msg.value.serverTime) - Date.now();
        break;
      case "fullMapView":
        this.chunks.clear();
        this.creatures.clear();
        this.predicted = [];
        this.walkEpoch = msg.value.walkEpoch;
        this.refused = undefined;
        this.target = undefined;
        if (msg.value.area) this.applyArea(msg.value.area);
        break;
      case "mapSlice":
        if (msg.value.area) this.applyArea(msg.value.area);
        this.prune();
        break;
      case "tileUpdate": {
        const p = posOf(msg.value.pos);
        this.setTile(p.x, p.y, p.z, msg.value.tile?.items);
        break;
      }
      case "creatureAppear":
        if (msg.value.creature) this.addCreature(msg.value.creature);
        break;
      case "creatureDisappear":
        this.creatures.delete(msg.value.id);
        pushLive(
          this.departures,
          { id: msg.value.id, reason: msg.value.reason, start: now, back: false },
          DEPARTURE_MS,
        );
        if (this.target === msg.value.id) this.target = undefined;
        break;
      case "creatureHealth": {
        const c = this.creatures.get(msg.value.id);
        if (c) c.health = msg.value.healthPercent;
        break;
      }
      case "effect":
        pushLive(
          this.effects,
          { pos: posOf(msg.value.pos), effectId: msg.value.effectId, start: now },
          EFFECT_MS,
        );
        break;
      case "creatureAttack":
        pushLive(
          this.attacks,
          {
            id: msg.value.id,
            kind: msg.value.kind,
            targetId: msg.value.targetId,
            to: posOf(msg.value.to),
            radius: msg.value.radius,
            start: now,
          },
          ATTACK_MS,
        );
        break;
      case "projectile":
        pushLive(
          this.projectiles,
          {
            from: posOf(msg.value.from),
            to: posOf(msg.value.to),
            projectileId: msg.value.projectileId,
            start: now,
          },
          PROJECTILE_MS,
        );
        break;
      case "partyUpdate":
        this.party.update(msg.value);
        break;
      case "partyInvitation":
        this.party.invited(msg.value, now);
        break;
      case "guildUpdate":
        this.guild.update(msg.value, now);
        break;
      case "creatureGuild": {
        const c = this.creatures.get(msg.value.id);
        if (c) c.guild = msg.value.guild;
        break;
      }
      case "creatureSkull": {
        const c = this.creatures.get(msg.value.id);
        if (c) c.skull = msg.value.skull;
        break;
      }
      case "creatureCosmetics": {
        const c = this.creatures.get(msg.value.id);
        if (c) {
          c.cosmetics = cosmeticsView(msg.value.cosmetics);
          c.lookRev = ++this.lookSeq;
        }
        break;
      }
      case "creatureLook": {
        const c = this.creatures.get(msg.value.id);
        if (c) {
          c.look = lookView(msg.value.look);
          c.equipment = equipmentView(msg.value.equipment);
          c.lookRev = ++this.lookSeq;
        }
        break;
      }
      case "cosmeticsState": {
        const equipped = cosmeticsView(msg.value.equipped);
        this.cosmetics = {
          owned: [...msg.value.owned],
          balance: Number(msg.value.balance),
          equipped,
        };
        const s = this.self;
        if (s) {
          s.cosmetics = { ...equipped };
          s.lookRev = ++this.lookSeq;
        }
        break;
      }
      case "tutorialStep":
        this.tutorial = tutorialFrom(msg.value);
        break;
      case "questLog":
        this.quests = questLogFrom(msg.value);
        break;
      case "presenceCheck":
        if (msg.value.checkId === this.presenceAnswered) break;
        this.presence = {
          id: msg.value.checkId,
          question: msg.value.question?.key ?? "",
          options: msg.value.options.map((o) => ({ id: o.optionId, key: o.text?.key ?? "" })),
          until: now + msg.value.timeoutMs,
        };
        break;
      case "playerConditions":
        this.conditions = msg.value.conditions.map((c) => ({
          id: c.conditionId,
          until: ENDLESS_STATUSES.has(c.conditionId) ? undefined : now + c.remainingMs,
          ticks: c.ticks,
        }));
        break;
      case "spellCooldown": {
        const v = msg.value;
        if (v.cooldownMs > 0)
          this.spellCooldowns.set(v.spellId, { until: now + v.cooldownMs, total: v.cooldownMs });
        if (v.groupCooldownMs > 0)
          this.groupCooldowns.set(v.group, {
            until: now + v.groupCooldownMs,
            total: v.groupCooldownMs,
          });
        break;
      }
      case "floatingText":
        pushLive(
          this.floatingTexts,
          {
            pos: posOf(msg.value.pos),
            kind: msg.value.kind,
            amount: Number(msg.value.amount),
            start: now,
          },
          FLOATING_TEXT_MS,
        );
        break;
      case "dialogOpen": {
        const v = msg.value;
        if (this.shop && this.shop.dialogId !== v.dialogId) this.shop = undefined;
        this.dialog = {
          id: v.dialogId,
          npcId: v.npcCreatureId,
          npcContentId: this.creatures.get(v.npcCreatureId)?.contentId ?? "",
          text: v.text?.key ?? "",
          options: v.options.map((o) => ({
            id: o.optionId,
            text: o.text?.key ?? "",
            params: o.text?.params ?? [],
          })),
        };
        break;
      }
      case "dialogClose":
        if (this.dialog?.id === msg.value.dialogId) this.dialog = undefined;
        if (this.shop?.dialogId === msg.value.dialogId) this.shop = undefined;
        break;
      case "stationOpen": {
        const v = msg.value;
        this.station = {
          pos: posOf(v.pos),
          itemId: v.itemId,
          owned: new Map(v.owned.map((o) => [o.itemId, o.count])),
          tools: new Set(v.tools),
          money: Number(v.money),
        };
        break;
      }
      case "refineResult": {
        const v = msg.value;
        this.refine = {
          outcome: refineOutcome(v.outcome),
          level: v.level,
          itemId: v.item?.itemId ?? 0,
          mods: v.item ? modsOf(v.item) : undefined,
          from: Number(v.text?.params.find((p) => p.name === "from")?.value.value ?? 0),
          at: now,
        };
        break;
      }
      case "tradeUpdate": {
        const r = tradeFrom(msg.value);
        this.trade = r.view;
        if (r.closedReason) {
          this.log.push({ key: r.closedReason, params: [], at: now });
          if (this.log.length > LOG_SIZE) this.log.shift();
        }
        break;
      }
      case "marketUpdate":
        this.market = applyMarket(this.market, msg.value);
        break;
      case "houseUpdate":
        this.house = houseFrom(msg.value);
        break;
      case "shopOpen": {
        const v = msg.value;
        this.shop = {
          dialogId: v.dialogId,
          npcId: v.npcCreatureId,
          money: Number(v.money),
          lines: v.offers.map((o) => ({
            itemId: o.itemId,
            buyPrice: Number(o.buyPrice),
            sellPrice: Number(o.sellPrice),
            owned: o.owned,
          })),
        };
        break;
      }
      case "chatMessage": {
        const m = msg.value;
        if (m.kind !== MessageKind.SYSTEM) {
          if (m.body.case === undefined) break;
          this.chat.push({
            kind: m.kind,
            speakerName: m.speakerName,
            speakerContentId: m.speakerContentId,
            text: m.body.case === "text" ? m.body.value : undefined,
            localized:
              m.body.case === "localized"
                ? { key: m.body.value.key, params: m.body.value.params }
                : undefined,
            at: now,
          });
          if (this.chat.length > CHAT_SIZE) this.chat.shift();
          break;
        }
        if (m.body.case !== "localized") break;
        const key = m.body.value.key;
        // The server refused the target: drop it like the server did.
        if (TARGET_REFUSED.has(key)) this.target = undefined;
        if (key === "progress.level_up") {
          const p = m.body.value.params.find((x) => x.name === "level");
          if (p?.value.case === "number") this.levelUp = { level: Number(p.value.value), at: now };
        }
        if (key === "travel.sailed") {
          const p = m.body.value.params.find((x) => x.name === "island");
          if (p?.value.case === "contentId") this.voyage = { island: p.value.value, at: now };
        }
        if (key === "death.died") {
          const params = m.body.value.params;
          const num = (name: string): number => {
            const p = params.find((x) => x.name === name);
            return p?.value.case === "number" ? Number(p.value.value) : 0;
          };
          this.death = { experience: num("experience"), blessings: num("blessings"), at: now };
          this.target = undefined;
        }
        this.log.push({ key, params: m.body.value.params, at: now });
        if (this.log.length > LOG_SIZE) this.log.shift();
        break;
      }
      case "creatureMove":
        this.move(
          msg.value.id,
          posOf(msg.value.from),
          posOf(msg.value.to),
          msg.value.durationMs,
          at,
          now,
          msg.value.walkSeq,
        );
        break;
      case "creatureTurn": {
        const c = this.creatures.get(msg.value.id);
        if (c) c.dir = msg.value.dir;
        break;
      }
      case "creatureSpeed": {
        const c = this.creatures.get(msg.value.id);
        if (c) c.speed = msg.value.speed;
        break;
      }
      case "playerStats": {
        const v = msg.value;
        const s = this.self;
        if (heavyHit(this.stats?.health, v.health, v.maxHealth)) this.heavyHitAt = now;
        if (s && v.speed > 0) s.speed = v.speed;
        if (s && v.maxHealth > 0) s.health = Math.round((v.health * 100) / v.maxHealth);
        this.stats = {
          health: v.health,
          maxHealth: v.maxHealth,
          mana: v.mana,
          maxMana: v.maxMana,
          level: v.level,
          experience: Number(v.experience),
          levelPercent: v.levelPercent,
          capacity: v.capacity,
          maxCapacity: v.maxCapacity,
          speed: v.speed,
        };
        break;
      }
      case "playerSkills":
        this.skills = msg.value.skills.map((s) => ({
          id: s.skillId,
          level: s.level,
          percent: s.percent,
        }));
        break;
      case "walkRejected": {
        const steps = this.predicted;
        this.predicted = [];
        this.walkEpoch = msg.value.walkEpoch;
        const s = this.self;
        const back = msg.value.pos ? posOf(msg.value.pos) : undefined;
        // The refusal of a predicted step itself (the server says the refused step's
        // direction and where the player stands), not of a step the server took on its own
        // (a chase).
        const p = steps.find(
          (q) => back && samePos(back, q.from) && msg.value.dir === directionTo(q.from, q.to),
        );
        if (p) this.refused = { from: p.from, to: p.to };
        if (s && back) {
          const before = this.drawPos(s, now);
          s.pos = back;
          s.walk = undefined;
          // Back to where the server says, gliding (no snap under normal latency), from
          // as far ahead as the predictions go.
          s.slide = slideBetween(before, back, now, this.ownSlideMax);
        }
        break;
      }
      case "inventory":
        this.inventory = new Map(
          msg.value.slots.flatMap((s) => (s.item ? [[s.slot, itemView(s.item)] as const] : [])),
        );
        this.backpack.equipped(this.inventory.get(EquipmentSlot.BACKPACK)?.itemId, this.containers);
        this.pockets = { capacity: msg.value.pocketSlots, items: msg.value.pockets.map(itemView) };
        break;
      case "containerOpen": {
        const v = msg.value;
        const c: ContainerState = {
          id: v.containerId,
          itemId: v.itemId,
          capacity: v.capacity,
          items: v.items.map(itemView),
          hasParent: v.hasParent,
        };
        this.containers = [...this.containers.filter((o) => o.id !== c.id), c];
        this.backpack.opened(c, now);
        break;
      }
      case "containerUpdate": {
        const v = msg.value;
        this.containers = this.containers.map((c) =>
          c.id === v.containerId ? { ...c, items: v.items.map(itemView) } : c,
        );
        break;
      }
      case "containerClose": {
        const id = msg.value.containerId;
        const gone = this.containers.find((c) => c.id === id);
        this.containers = this.containers.filter((c) => c.id !== id);
        this.backpack.closed(id, gone);
        break;
      }
      default:
        break; // chat, dialogs… arrive with their roadmap tasks
    }
  }

  private applyArea(a: MapArea): void {
    for (const floor of a.floors) {
      for (let i = 0; i < floor.tiles.length; i++) {
        const idx = floor.tiles[i] ?? -1;
        const x = a.x + (i % a.width);
        const y = a.y + Math.floor(i / a.width);
        this.setTile(x, y, floor.z, idx < 0 ? undefined : a.palette[idx]?.items);
      }
    }
    for (const c of a.creatures) this.addCreature(c);
  }

  private setTile(x: number, y: number, z: number, stack: readonly ItemStack[] | undefined): void {
    const items = stack?.map((s) => s.itemId);
    const cx = Math.floor(x / CHUNK_TILES);
    const cy = Math.floor(y / CHUNK_TILES);
    const key = chunkKey(z, cx, cy);
    let c = this.chunks.get(key);
    if (!c) {
      if (!items) return;
      c = {
        tiles: new Array<readonly number[] | undefined>(CHUNK_TILES * CHUNK_TILES),
        counts: new Array<readonly number[] | undefined>(CHUNK_TILES * CHUNK_TILES),
        mods: new Array<readonly (ItemMods | undefined)[] | undefined>(CHUNK_TILES * CHUNK_TILES),
        data: undefined,
      };
      this.chunks.set(key, c);
    }
    const i = (y % CHUNK_TILES) * CHUNK_TILES + (x % CHUNK_TILES);
    c.tiles[i] = items;
    c.counts[i] = stack?.some((s) => s.count > 0) ? stack.map((s) => s.count) : undefined;
    c.mods[i] = stack?.some((s) => modsOf(s)) ? stack.map(modsOf) : undefined;
    c.data = undefined;
  }

  /** Forgets chunks far from the own creature so memory stays bounded while exploring. */
  private prune(): void {
    const s = this.self;
    if (!s) return;
    const pcx = Math.floor(s.pos.x / CHUNK_TILES);
    const pcy = Math.floor(s.pos.y / CHUNK_TILES);
    for (const key of [...this.chunks.keys()]) {
      const [, cx = 0, cy = 0] = key.split("/").map(Number);
      if (Math.abs(cx - pcx) > KEEP_CHUNKS || Math.abs(cy - pcy) > KEEP_CHUNKS)
        this.chunks.delete(key);
    }
  }

  private addCreature(c: Creature): void {
    const prev = this.creatures.get(c.id);
    // It is back: why it left last no longer holds (a player that died and woke up in
    // view must not fall when it later leaves the drawn floor).
    if (!prev) this.markBack(c.id);
    this.creatures.set(c.id, {
      id: c.id,
      kind: c.kind,
      name: c.name,
      contentId: c.contentId,
      pos: posOf(c.pos),
      dir: c.dir === Direction.UNSPECIFIED ? Direction.SOUTH : c.dir,
      speed: c.speed || prev?.speed || 0,
      health: c.healthPercent,
      walk: undefined,
      guild: c.guild,
      skull: c.skull,
      cosmetics: cosmeticsView(c.cosmetics),
      look: lookView(c.look),
      equipment: equipmentView(c.equipment),
      worn: wornView(c.worn),
      lookRev: prev ? prev.lookRev : ++this.lookSeq,
    });
    // Built again only when what the figure is drawn from changed: a FullMapView or a
    // MapSlice (a teleport, another floor) sends every creature in view again.
    const next = this.creatures.get(c.id);
    if (prev && next && !sameFigure(prev, next)) next.lookRev = ++this.lookSeq;
  }

  /**
   * A step the server took: `at` is when it starts on the server's timeline (batchTime).
   * An own step while steps are predicted is ownStep's. Any other step is drawn from `at`
   * after the one still drawn (`prev`): if that one ends later, the new one waits for it
   * and is drawn faster until it is back on time (PLAYOUT_CATCH_UP); much later
   * (PLAYOUT_MAX_LAG_MS), it skips ahead. A jump in the drawing glides.
   */
  private move(
    id: number,
    from: Pos,
    to: Pos,
    duration: number,
    at: number,
    now: number,
    seq = 0,
  ): void {
    if (id === this.selfId) this.refused = undefined; // another tile, or the way opened
    const c = this.creatures.get(id);
    if (!c) return;
    if (id === this.selfId && this.ownStep(c, from, to, duration, seq, now)) return;
    const dir = directionTo(from, to);
    if (dir !== Direction.UNSPECIFIED) c.dir = dir;
    const before = this.drawPos(c, now);
    c.slide = undefined; // folded into the new one
    const old = c.walk;
    let start = Math.max(at, now);
    let drawn = duration;
    let prev: Walk | undefined;
    if (old && old.start + old.duration > now && samePos(old.to, from)) {
      const lag = old.start + old.duration - start;
      if (lag <= PLAYOUT_MAX_LAG_MS) {
        prev = pruned(old, now);
        if (lag > 0) {
          start += lag;
          drawn = duration - Math.min(lag, duration * PLAYOUT_CATCH_UP);
        }
      }
    }
    c.pos = to;
    c.walk = { from, to, start, duration: drawn, prev };
    c.slide = slideBetween(
      before,
      this.drawPos(c, now),
      now,
      id === this.selfId ? this.ownSlideMax : undefined,
    );
  }

  /**
   * An own step of the server while steps are predicted (docs/05 "Caminar"). The oldest
   * prediction, confirmed (its Walk's seq, the same tiles): it keeps its local start and
   * takes the server's duration (the ones after it shift with it). Otherwise the server's
   * step and the predictions part ways: the Walks before `seq` never came back (lost on
   * the way), and the step is the server's in their place; a step without seq (a path's,
   * a chase's) or of a Walk given up (expirePredicted) came before the Walks still on
   * their way. Either way the server takes those next, back to back, from where this step
   * ends: the step is drawn in the oldest prediction's place, the predictions left move
   * after it, and the drawing glides over the difference. False when nothing is
   * predicted: a plain step of the server.
   */
  private ownStep(
    c: CreatureState,
    from: Pos,
    to: Pos,
    duration: number,
    seq: number,
    now: number,
  ): boolean {
    const ps = this.predicted;
    const first = ps[0];
    if (!first) return false;
    // How many predictions this step answers: the lost ones before it and its own.
    let n = 0;
    if (seq !== 0) while (n < ps.length && (ps[n]?.seq ?? 0) <= seq) n++;
    if (n === 1 && first.seq === seq && samePos(first.from, from) && samePos(first.to, to)) {
      // Confirmed: it keeps its local start (and the facing of the newest step predicted).
      ps.shift();
      const shift = duration - first.walk.duration;
      first.walk.duration = duration;
      if (shift !== 0) for (const q of ps) q.walk.start += shift;
      return true;
    }
    const rest = ps.slice(n);
    if (rest.length === 0 && ps[n - 1]?.seq !== seq) {
      this.predicted = []; // all lost, and this one was not predicted: a plain step
      return false;
    }
    const before = this.drawPos(c, now);
    // The server's step takes the place of the oldest prediction in the drawing.
    const slot = first.walk;
    let last: Walk = {
      from,
      to,
      start: slot.start,
      duration,
      prev: slot.prev && pruned(slot.prev, now),
    };
    let cur = to;
    for (const q of rest) {
      const d = directionTo(q.from, q.to);
      q.from = cur;
      q.to = step(cur, d);
      q.walk.from = q.from;
      q.walk.to = q.to;
      q.walk.start = last.start + last.duration; // back to back, as the server takes them
      q.walk.prev = last;
      last = q.walk;
      cur = q.to;
    }
    this.predicted = rest;
    const facing = directionTo(last.from, last.to);
    if (facing !== Direction.UNSPECIFIED) c.dir = facing;
    c.pos = cur;
    c.walk = last;
    c.slide = undefined;
    c.slide = slideBetween(before, this.drawPos(c, now), now, this.ownSlideMax);
    return true;
  }

  /**
   * Gives up the own steps the server never answered PREDICT_TIMEOUT_MS after the oldest
   * was drawn: its Walk was lost on the way, and nothing else would end the wait (a click
   * waits for `unconfirmed` 0). The player glides back to where the server last had it.
   * Call it every frame.
   */
  expirePredicted(now: number): void {
    const first = this.predicted[0];
    if (!first || now < first.walk.start + first.walk.duration + PREDICT_TIMEOUT_MS) return;
    this.predicted = [];
    const s = this.self;
    if (!s) return;
    const before = this.drawPos(s, now);
    s.pos = first.from;
    s.walk = undefined;
    s.slide = slideBetween(before, first.from, now, this.ownSlideMax);
  }

  /**
   * Forgets effects, floating texts, projectiles, attacks and departures that finished. In
   * place: the canvas calls this every frame, and a new array per frame would be garbage
   * (docs/07).
   */
  expire(now: number): void {
    dropFinished(this.effects, now, EFFECT_MS);
    dropFinished(this.floatingTexts, now, FLOATING_TEXT_MS);
    dropFinished(this.projectiles, now, PROJECTILE_MS);
    dropFinished(this.attacks, now, ATTACK_MS);
    dropFinished(this.departures, now, DEPARTURE_MS);
  }

  /**
   * Why creature id last left the view, while it is kept (DEPARTURE_MS) and the creature
   * has not come back since.
   */
  departureOf(id: number): DisappearReason | undefined {
    for (let i = this.departures.length - 1; i >= 0; i--) {
      const d = this.departures[i];
      if (d?.id === id) return d.back ? undefined : d.reason;
    }
    return undefined;
  }

  /** Marks the departures of creature id as over: it came back into view. */
  private markBack(id: number): void {
    for (const d of this.departures) if (d.id === id) d.back = true;
  }

  /** The creatures of the battle list: everyone in view on the own floor but oneself, closest first. */
  battleList(): CreatureState[] {
    const s = this.self;
    if (!s) return [];
    const d = (c: CreatureState): number =>
      Math.max(Math.abs(c.pos.x - s.pos.x), Math.abs(c.pos.y - s.pos.y));
    return (
      [...this.creatures.values()]
        // NPCs are talked to, not fought: they stay out of the battle list.
        .filter((c) => c.id !== this.selfId && c.pos.z === s.pos.z && c.kind !== CreatureKind.NPC)
        .sort((a, b) => d(a) - d(b) || a.id - b.id)
    );
  }

  /** The creature standing on a tile, if the client knows one. */
  creatureAt(x: number, y: number, z: number): CreatureState | undefined {
    for (const c of this.creatures.values())
      if (c.pos.x === x && c.pos.y === y && c.pos.z === z) return c;
    return undefined;
  }

  // ---- own movement -------------------------------------------------------------------

  /** True while a creature has a step still to draw (running, or waiting to start). */
  walking(c: CreatureState, now: number): boolean {
    return c.walk !== undefined && now < c.walk.start + c.walk.duration;
  }

  /** The step being drawn at `now`: the latest, or the one before while it lasts. */
  activeWalk(c: CreatureState, now: number): Walk | undefined {
    let w = c.walk;
    while (w && now < w.start && w.prev) w = w.prev;
    return w;
  }

  /** The direction to draw a creature facing: its step's while walking, else its own. */
  facing(c: CreatureState, now: number): Direction {
    const w = this.activeWalk(c, now);
    if (w && now >= w.start && now < w.start + w.duration) {
      const d = directionTo(w.from, w.to);
      if (d !== Direction.UNSPECIFIED) return d;
    }
    return c.dir;
  }

  /** How many own steps were sent and not confirmed yet. */
  get unconfirmed(): number {
    return this.predicted.length;
  }

  /**
   * The own creature can start deciding its next step: the step drawn now ends within
   * STEP_LEAD_MS (or none runs), fewer than max_queued_steps wait for the server, and the
   * last one predicted is not onto stairs, a hole or a teleport (the server moves the
   * player elsewhere there: the FullMapView says where).
   */
  canStep(now: number): boolean {
    const s = this.self;
    if (!s || this.predicted.length >= this.maxPredicted) return false;
    const last = this.predicted[this.predicted.length - 1];
    if (last && movesOnStep(this.content.portals, last.to.x, last.to.y, last.to.z)) return false;
    const w = s.walk;
    return !w || now >= w.start + w.duration - STEP_LEAD_MS;
  }

  /**
   * The own creature stands still: no step drawn now and none predicted (MOV-2: a short
   * tap toward another way only turns it then).
   */
  standingStill(now: number): boolean {
    const s = this.self;
    if (!s || this.predicted.length > 0) return false;
    const w = s.walk;
    return !w || now >= w.start + w.duration;
  }

  private get maxPredicted(): number {
    return Math.max(1, this.maxQueued);
  }

  /** The longest correction of the own creature that glides (motion.ts ownSlideMaxTiles). */
  private get ownSlideMax(): number {
    return ownSlideMaxTiles(this.maxPredicted);
  }

  /** Whether an own step in `dir` looks possible: a free tile, not the step just refused. */
  stepOpen(dir: Direction): boolean {
    const s = this.self;
    if (!s) return false;
    // No Pos made: the mouse held against a wall asks this every frame (docs/07).
    const [dx, dy] = delta(dir);
    const x = s.pos.x + dx;
    const y = s.pos.y + dy;
    if (!this.free(x, y, s.pos.z)) return false;
    const r = this.refused;
    return !(r && samePos(r.from, s.pos) && r.to.x === x && r.to.y === y && r.to.z === s.pos.z);
  }

  /**
   * Predicts one own step in `dir` if the client believes it is possible (canStep and
   * stepOpen). It starts when the step drawn now ends, so the drawing never stops between
   * tiles. Returns the step's seq when it was predicted (the caller then sends Walk with
   * it and walkEpoch), undefined when it should not be sent.
   */
  predictStep(dir: Direction, now: number): number | undefined {
    const s = this.self;
    if (!s || !this.canStep(now) || !this.stepOpen(dir)) return undefined;
    const from = s.pos;
    const to = step(from, dir);
    const old = s.walk;
    const end = old ? old.start + old.duration : now;
    const start = Math.max(end, now);
    const walk: Walk = {
      from,
      to,
      start,
      duration: this.stepDuration(to, s.speed, isDiagonal(dir)),
      prev: old && start > now ? pruned(old, now) : undefined,
    };
    const seq = ++this.walkSeq;
    this.predicted.push({ from, to, walk, seq });
    s.pos = to;
    s.dir = dir;
    s.walk = walk;
    return seq;
  }

  /**
   * The own step for a wanted direction (a key, the pad): the direction, or for a diagonal
   * one of its halves when the diagonal is blocked (sliding along a wall). Nothing open:
   * the player turns that way (`turn`, sent only when the facing changes), but only with
   * every step confirmed. The server turns at once and each step still queued there sets
   * the facing again: the player would face the turn here and the last step for everyone
   * else. A held key turns once the steps are confirmed.
   */
  chooseStep(
    dir: Direction,
    now: number,
  ): { kind: "walk"; dir: Direction; seq: number } | { kind: "turn"; dir: Direction } | undefined {
    const s = this.self;
    if (!s || !this.canStep(now)) return undefined;
    for (const d of stepChoices(dir)) {
      const seq = this.predictStep(d, now);
      if (seq !== undefined) return { kind: "walk", dir: d, seq };
    }
    return this.turn(dir);
  }

  /**
   * Turns the own creature toward `dir` without a step (chooseStep's "nothing open"): only
   * with every step confirmed and when the facing changes; the Turn to send, if any.
   */
  turn(dir: Direction): { kind: "turn"; dir: Direction } | undefined {
    const s = this.self;
    if (!s || this.predicted.length > 0) return undefined;
    if (s.dir === dir || dir === Direction.UNSPECIFIED) return undefined;
    s.dir = dir;
    return { kind: "turn", dir };
  }

  /**
   * Forgets the refused step: the player pressed or released a movement key or the pad, or
   * changed direction, so the next step that way is tried again (one refusal, one message
   * per press).
   */
  retryWalk(): void {
    this.refused = undefined;
  }

  /** Same formula as the server (docs/05, "Caminar"), used until it sends duration_ms. */
  stepDuration(to: Pos, speed: number, diagonal: boolean): number {
    const ground = this.item(this.tile(to.x, to.y, to.z)?.[0] ?? 0);
    const terrain = ground?.ground ? ground.speed : 100;
    const mv = this.content.movement;
    const ms = Math.ceil(
      (mv.baseStepMs * terrain * (diagonal ? mv.diagonalCost : 1)) / Math.max(speed, 1),
    );
    return Math.max(Math.ceil(ms / 50), 1) * 50;
  }

  /**
   * Where to draw a creature (fractional tiles): along the step drawn now (waiting at its
   * start before it begins), plus what is left of a correction gliding out. Written into
   * `out` when given (a caller asking every frame makes no object, docs/07).
   */
  drawPos(
    c: CreatureState,
    now: number,
    out: { x: number; y: number } = { x: 0, y: 0 },
  ): { x: number; y: number } {
    const w = this.activeWalk(c, now);
    let x = c.pos.x;
    let y = c.pos.y;
    if (w && now < w.start) {
      x = w.from.x;
      y = w.from.y;
    } else if (w && now < w.start + w.duration && w.duration > 0) {
      const t = (now - w.start) / w.duration;
      x = w.from.x + (w.to.x - w.from.x) * t;
      y = w.from.y + (w.to.y - w.from.y) * t;
    } else if (w && w !== c.walk) {
      x = w.to.x;
      y = w.to.y;
    }
    const left = slideLeft(c.slide, now);
    if (left) {
      x += left.x;
      y += left.y;
    } else if (c.slide) c.slide = undefined;
    out.x = x;
    out.y = y;
    return out;
  }
}

/** The step with the steps before it that ended by now cut off: only those still drawn stay. */
function pruned(w: Walk, now: number): Walk {
  for (let n: Walk | undefined = w; n; n = n.prev)
    if (n.prev && n.prev.start + n.prev.duration <= now) n.prev = undefined;
  return w;
}

export const isPlayer = (c: CreatureState): boolean => c.kind === CreatureKind.PLAYER;
