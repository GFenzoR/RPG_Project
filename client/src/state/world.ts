// The client's picture of the world, rebuilt from server events (docs/05, "Mensajes
// servidor → cliente"): known tiles by chunk, the creatures in view and how they move.
// Pure logic over plain data: no PixiJS, no DOM, no clock (callers pass `now` in ms).
//
// Own movement is predicted one step ahead (client/CLAUDE.md): a step the player asks for
// moves the own creature at once; the server's CreatureMove confirms it (and gives the
// real duration) and WalkRejected puts the creature back where the server says it is.
import { CreatureKind, Direction } from "@rpg/protocol";
import type { Creature, MapArea, ServerMessage } from "@rpg/protocol";
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
  walk: Walk | undefined;
}

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
        break;
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
        const s = this.self;
        if (s && msg.value.speed > 0) s.speed = msg.value.speed;
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
