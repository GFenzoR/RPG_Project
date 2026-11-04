// The client's picture of the world, rebuilt from server events (docs/05, "Mensajes
// servidor → cliente"): known tiles by chunk, the creatures in view and how they move.
// Pure logic over plain data: no PixiJS, no DOM, no clock (callers pass `now` in ms).
//
// Own movement is predicted one step ahead (client/CLAUDE.md): a step the player asks for
// moves the own creature at once; the server's CreatureMove confirms it (and gives the
// real duration) and WalkRejected puts the creature back where the server says it is.
import type { StationState } from "./recipes.ts";
import { CreatureKind, Direction, MessageKind } from "@rpg/protocol";
import type {
  Creature,
  EquipmentSlot,
  ItemStack,
  MapArea,
  ServerMessage,
  TextParam,
  FloatingTextKind,
} from "@rpg/protocol";
import { CHUNK_TILES } from "@rpg/renderer/camera";
import type { ChunkData, TileSource } from "@rpg/renderer";
import type { ClientContent, ItemDef } from "../content-types.ts";
import type { Cooldown } from "./hotkeys.ts";
import { directionTo, isDiagonal, samePos, step } from "./geometry.ts";
import { PartyState } from "./party.ts";
import type { Pos } from "./geometry.ts";

export interface Walk {
  from: Pos;
  to: Pos;
  /** Local time the step started, ms. */
  start: number;
  duration: number;
}

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
}

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

/** The last death (death.died), for the death screen. */
/** One of the player's own active conditions (PlayerConditions, T3.2). */
export interface ConditionView {
  /** balance.yaml conditions id: poison, hasted... (name: condition.<id>.name). */
  id: string;
  /** performance.now() at which it ends (or its last hit lands). */
  until: number;
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
/** Projectile ids are PROJECTILE_ELEMENT + index of ELEMENTS. */
export const PROJECTILE_ELEMENT = 1;
export const ELEMENTS = ["physical", "fire", "ice", "energy", "earth", "holy", "death"] as const;
/** Flight time of a projectile, ms. */
export const PROJECTILE_MS = 250;
/** How long effects and floating texts live, ms. */
export const EFFECT_MS = 600;
export const FLOATING_TEXT_MS = 1000;
/** Status log length. */
const LOG_SIZE = 5;
/** Chat lines kept on screen. */
export const CHAT_SIZE = 50;

interface ChunkTiles {
  /** Item IDs per tile (ground first), row-major; undefined = unknown. */
  tiles: (readonly number[] | undefined)[];
  /** Stack sizes per tile, only for tiles with a stackable item (0 = not stackable). */
  counts: (readonly number[] | undefined)[];
  /** What the renderer sees; rebuilt (new object) after a change. */
  data: ChunkData | undefined;
}

/** Chunks farther than this from the own creature are forgotten. */
const KEEP_CHUNKS = 2;

const chunkKey = (z: number, cx: number, cy: number): string => `${z}/${cx}/${cy}`;

const posOf = (p: { x: number; y: number; z: number } | undefined): Pos =>
  p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 };

/** One item as the client sees it: numeric ID and stack size (0 when it does not stack). */
export interface ItemView {
  itemId: number;
  count: number;
}

/** An open container window (ContainerOpen): its session ID, item and content. */
export interface ContainerState {
  id: number;
  itemId: number;
  capacity: number;
  items: ItemView[];
  hasParent: boolean;
}

const itemView = (s: ItemStack): ItemView => ({ itemId: s.itemId, count: s.count });

/** An open NPC dialog (DialogOpen): the NPC's text and the options the player sees. */
export interface DialogState {
  id: number;
  npcId: number;
  /** data/npcs id of the NPC (its name is npc.<id>.name), when the client knows it. */
  npcContentId: string;
  text: string;
  options: { id: number; text: string }[];
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
  /** The predicted own step the server has not confirmed yet. */
  pending: { from: Pos; to: Pos } | undefined;
  /** Whether the player is invisible (its own condition): it is drawn see-through. */
  get invisible(): boolean {
    return this.conditions.some((c) => c.id === "invisible");
  }
  /** The creature the player attacks (SetTarget), if any. */
  target: number | undefined;
  stats: PlayerStatsState | undefined;
  skills: SkillState[] = [];
  /** The crafting station the player opened (T3.4), until it closes the window or walks away. */
  station: StationState | undefined;
  /** The player's own active conditions (T3.2), in the server's order. */
  conditions: ConditionView[] = [];
  levelUp: LevelUpState | undefined;
  death: DeathState | undefined;
  effects: EffectState[] = [];
  floatingTexts: FloatingTextState[] = [];
  projectiles: ProjectileState[] = [];
  /** Running cooldowns (SpellCooldown) by spell ID and by spell group. */
  readonly spellCooldowns = new Map<string, Cooldown>();
  readonly groupCooldowns = new Map<string, Cooldown>();
  log: LogMessage[] = [];
  chat: ChatLine[] = [];
  dialog: DialogState | undefined;
  shop: ShopState | undefined;
  /** Equipped items by slot (Inventory). */
  inventory = new Map<EquipmentSlot, ItemView>();
  /** Open container windows, oldest first. */
  containers: ContainerState[] = [];
  /** The party and pending invitations (T3.3). */
  readonly party = new PartyState();
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

  apply(msg: ServerMessage["message"], now: number): void {
    switch (msg.case) {
      case "welcome":
        this.selfId = msg.value.creatureId;
        break;
      case "fullMapView":
        this.chunks.clear();
        this.creatures.clear();
        this.pending = undefined;
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
        if (this.target === msg.value.id) this.target = undefined;
        break;
      case "creatureHealth": {
        const c = this.creatures.get(msg.value.id);
        if (c) c.health = msg.value.healthPercent;
        break;
      }
      case "effect":
        this.effects.push({ pos: posOf(msg.value.pos), effectId: msg.value.effectId, start: now });
        break;
      case "projectile":
        this.projectiles.push({
          from: posOf(msg.value.from),
          to: posOf(msg.value.to),
          projectileId: msg.value.projectileId,
          start: now,
        });
        break;
      case "partyUpdate":
        this.party.update(msg.value);
        break;
      case "partyInvitation":
        this.party.invited(msg.value, now);
        break;
      case "playerConditions":
        this.conditions = msg.value.conditions.map((c) => ({
          id: c.conditionId,
          until: now + c.remainingMs,
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
        this.floatingTexts.push({
          pos: posOf(msg.value.pos),
          kind: msg.value.kind,
          amount: Number(msg.value.amount),
          start: now,
        });
        break;
      case "dialogOpen": {
        const v = msg.value;
        if (this.shop && this.shop.dialogId !== v.dialogId) this.shop = undefined;
        this.dialog = {
          id: v.dialogId,
          npcId: v.npcCreatureId,
          npcContentId: this.creatures.get(v.npcCreatureId)?.contentId ?? "",
          text: v.text?.key ?? "",
          options: v.options.map((o) => ({ id: o.optionId, text: o.text?.key ?? "" })),
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
        };
        break;
      }
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
        if (key === "combat.cannot_attack") this.target = undefined;
        if (key === "progress.level_up") {
          const p = m.body.value.params.find((x) => x.name === "level");
          if (p?.value.case === "number") this.levelUp = { level: Number(p.value.value), at: now };
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
          now,
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
        this.pending = undefined;
        const s = this.self;
        if (s && msg.value.pos) {
          s.pos = posOf(msg.value.pos);
          s.walk = undefined;
        }
        break;
      }
      case "inventory":
        this.inventory = new Map(
          msg.value.slots.flatMap((s) => (s.item ? [[s.slot, itemView(s.item)] as const] : [])),
        );
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
        break;
      }
      case "containerUpdate": {
        const v = msg.value;
        this.containers = this.containers.map((c) =>
          c.id === v.containerId ? { ...c, items: v.items.map(itemView) } : c,
        );
        break;
      }
      case "containerClose":
        this.containers = this.containers.filter((c) => c.id !== msg.value.containerId);
        break;
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
        data: undefined,
      };
      this.chunks.set(key, c);
    }
    const i = (y % CHUNK_TILES) * CHUNK_TILES + (x % CHUNK_TILES);
    c.tiles[i] = items;
    c.counts[i] = stack?.some((s) => s.count > 0) ? stack.map((s) => s.count) : undefined;
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
    });
  }

  private move(id: number, from: Pos, to: Pos, duration: number, now: number): void {
    const c = this.creatures.get(id);
    if (!c) return;
    const dir = directionTo(from, to);
    if (dir !== Direction.UNSPECIFIED) c.dir = dir;
    const p = this.pending;
    if (id === this.selfId && p && samePos(p.from, from) && samePos(p.to, to)) {
      // Our prediction, confirmed: keep the local start, take the server's duration.
      this.pending = undefined;
      if (c.walk) c.walk.duration = duration;
      return;
    }
    if (id === this.selfId) this.pending = undefined;
    c.pos = to;
    c.walk = { from, to, start: now, duration };
  }

  /** Forgets effects and floating texts that finished. */
  expire(now: number): void {
    if (this.effects.length > 0)
      this.effects = this.effects.filter((e) => now - e.start < EFFECT_MS);
    if (this.floatingTexts.length > 0)
      this.floatingTexts = this.floatingTexts.filter((f) => now - f.start < FLOATING_TEXT_MS);
    if (this.projectiles.length > 0)
      this.projectiles = this.projectiles.filter((p) => now - p.start < PROJECTILE_MS);
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

  /** True while a creature's step is still being animated. */
  walking(c: CreatureState, now: number): boolean {
    return c.walk !== undefined && now < c.walk.start + c.walk.duration;
  }

  /** The own creature can start a new step: no step running and nothing unconfirmed. */
  canStep(now: number): boolean {
    const s = this.self;
    return s !== undefined && this.pending === undefined && !this.walking(s, now);
  }

  /**
   * Predicts one own step in `dir` if the client believes it is possible. Returns true when
   * the step was predicted (the caller then sends Walk), false when it should not be sent.
   */
  predictStep(dir: Direction, now: number): boolean {
    const s = this.self;
    if (!s || !this.canStep(now)) return false;
    const to = step(s.pos, dir);
    s.dir = dir;
    if (!this.free(to.x, to.y, to.z)) return false;
    const from = s.pos;
    this.pending = { from, to };
    s.pos = to;
    s.walk = { from, to, start: now, duration: this.stepDuration(to, s.speed, isDiagonal(dir)) };
    return true;
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

  /** Where to draw a creature (fractional tiles), interpolated along its current step. */
  drawPos(c: CreatureState, now: number): { x: number; y: number } {
    const w = c.walk;
    if (!w || now >= w.start + w.duration || w.duration <= 0) return { x: c.pos.x, y: c.pos.y };
    const t = Math.max(0, (now - w.start) / w.duration);
    return { x: w.from.x + (w.to.x - w.from.x) * t, y: w.from.y + (w.to.y - w.from.y) * t };
  }
}

export const isPlayer = (c: CreatureState): boolean => c.kind === CreatureKind.PLAYER;
