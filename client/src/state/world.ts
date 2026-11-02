// The client's picture of the world, rebuilt from server events (docs/05, "Mensajes
// servidor → cliente"): known tiles by chunk, the creatures in view and how they move.
// Pure logic over plain data: no PixiJS, no DOM, no clock (callers pass `now` in ms).
//
// Own movement is predicted one step ahead (client/CLAUDE.md): a step the player asks for
// moves the own creature at once; the server's CreatureMove confirms it (and gives the
// real duration) and WalkRejected puts the creature back where the server says it is.
import { CreatureKind, Direction, MessageKind } from "@rpg/protocol";
import type { Creature, MapArea, ServerMessage, TextParam, FloatingTextKind } from "@rpg/protocol";
import { CHUNK_TILES } from "@rpg/renderer/camera";
import type { ChunkData, TileSource } from "@rpg/renderer";
import type { ClientContent, ItemDef } from "../content-types.ts";
import { directionTo, isDiagonal, samePos, step } from "./geometry.ts";
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

export interface PlayerStatsState {
  health: number;
  maxHealth: number;
  level: number;
  experience: number;
}

/** Effect ids (server/internal/session/combat.go). */
export const EFFECT_HIT = 1;
export const EFFECT_BLOCK = 2;
/** How long effects and floating texts live, ms. */
export const EFFECT_MS = 600;
export const FLOATING_TEXT_MS = 1000;
/** Status log length. */
const LOG_SIZE = 5;

interface ChunkTiles {
  /** Item IDs per tile (ground first), row-major; undefined = unknown. */
  tiles: (readonly number[] | undefined)[];
  /** What the renderer sees; rebuilt (new object) after a change. */
  data: ChunkData | undefined;
}

/** Chunks farther than this from the own creature are forgotten. */
const KEEP_CHUNKS = 2;

const chunkKey = (z: number, cx: number, cy: number): string => `${z}/${cx}/${cy}`;

const posOf = (p: { x: number; y: number; z: number } | undefined): Pos =>
  p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 };

export class WorldState implements TileSource {
  selfId = 0;
  readonly creatures = new Map<number, CreatureState>();
  /** The predicted own step the server has not confirmed yet. */
  pending: { from: Pos; to: Pos } | undefined;
  /** The creature the player attacks (SetTarget), if any. */
  target: number | undefined;
  stats: PlayerStatsState | undefined;
  effects: EffectState[] = [];
  floatingTexts: FloatingTextState[] = [];
  log: LogMessage[] = [];
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
        this.setTile(
          p.x,
          p.y,
          p.z,
          msg.value.tile?.items.map((s) => s.itemId),
        );
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
      case "floatingText":
        this.floatingTexts.push({
          pos: posOf(msg.value.pos),
          kind: msg.value.kind,
          amount: Number(msg.value.amount),
          start: now,
        });
        break;
      case "chatMessage": {
        const m = msg.value;
        if (m.kind !== MessageKind.SYSTEM || m.body.case !== "localized") break;
        const key = m.body.value.key;
        // The server refused the target: drop it like the server did.
        if (key === "combat.cannot_attack") this.target = undefined;
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
          level: v.level,
          experience: Number(v.experience),
        };
        break;
      }
      case "walkRejected": {
        this.pending = undefined;
        const s = this.self;
        if (s && msg.value.pos) {
          s.pos = posOf(msg.value.pos);
          s.walk = undefined;
        }
        break;
      }
      default:
        break; // combat, items, chat… arrive with their roadmap tasks
    }
  }

  private applyArea(a: MapArea): void {
    for (const floor of a.floors) {
      for (let i = 0; i < floor.tiles.length; i++) {
        const idx = floor.tiles[i] ?? -1;
        const x = a.x + (i % a.width);
        const y = a.y + Math.floor(i / a.width);
        this.setTile(
          x,
          y,
          floor.z,
          idx < 0 ? undefined : a.palette[idx]?.items.map((s) => s.itemId),
        );
      }
    }
    for (const c of a.creatures) this.addCreature(c);
  }

  private setTile(x: number, y: number, z: number, items: readonly number[] | undefined): void {
    const cx = Math.floor(x / CHUNK_TILES);
    const cy = Math.floor(y / CHUNK_TILES);
    const key = chunkKey(z, cx, cy);
    let c = this.chunks.get(key);
    if (!c) {
      if (!items) return;
      c = {
        tiles: new Array<readonly number[] | undefined>(CHUNK_TILES * CHUNK_TILES),
        data: undefined,
      };
      this.chunks.set(key, c);
    }
    c.tiles[(y % CHUNK_TILES) * CHUNK_TILES + (x % CHUNK_TILES)] = items;
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
  }

  /** The creatures of the battle list: everyone in view on the own floor but oneself, closest first. */
  battleList(): CreatureState[] {
    const s = this.self;
    if (!s) return [];
    const d = (c: CreatureState): number =>
      Math.max(Math.abs(c.pos.x - s.pos.x), Math.abs(c.pos.y - s.pos.y));
    return [...this.creatures.values()]
      .filter((c) => c.id !== this.selfId && c.pos.z === s.pos.z)
      .sort((a, b) => d(a) - d(b) || a.id - b.id);
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
