// The living world's map objects on the client (livingworld/README.md): the game feeds
// createLivingObjects the server's LivingObjectEvents, the creatures' steps and the frames;
// it draws the effects (chips of a hit, the burst of a break, the slide of a push, the fade
// of debris) and asks for the sounds. The objects themselves are ordinary items of the
// tiles: the TileUpdates draw them, never this module.
//
// Budget (docs/07): particles and ghosts live in plain arrays trimmed in place; one
// Graphics draws every particle of a frame and the ghost sprites come from a pool.
import { Container, Graphics, Sprite } from "pixi.js";
import type { Texture } from "pixi.js";
import { burst, FADE_MS, ghostAt, materialOf, particleAt, SLIDE_MS } from "./effects.ts";
import type { BurstKind, Ghost, Particle } from "./effects.ts";

/**
 * Keeps the entries of list that pass keep, in order, without a new array (the per-frame
 * trim of the particles and ghosts: no garbage while nothing lives).
 */
export function keepInPlace<T>(list: T[], keep: (v: T) => boolean): void {
  let n = 0;
  for (const v of list) if (keep(v)) list[n++] = v;
  list.length = n;
}

/** A tile position. */
export interface LivingPos {
  x: number;
  y: number;
  z: number;
}

/** What happened to an object (proto LivingObjectKind, without the prefix). */
export type LivingEventKind =
  "hit" | "break" | "respawn" | "push" | "gate_open" | "gate_close" | "fade" | "reset";

/** A LivingObjectEvent of the server, as the client glue hands it over. */
export interface LivingEvent {
  kind: LivingEventKind;
  pos: LivingPos;
  /** Where a pushed or reset object went. */
  to?: LivingPos;
  /** The object's item (the debris that faded, the gate's new look). */
  itemId: number;
  /** Material of the particles (data/livingworld `effect`); "" = wood. */
  effect: string;
  /** An id of assets/sounds.yaml; "" = none. */
  sound: string;
  /** What is left of a hit object, in thousandths. */
  hpPermille: number;
}

/** What the module needs to know of a tile. */
export interface ObjectSurface {
  /** Pixels its items raise what stands on it (docs/17 ART-8). */
  elevation: number;
  /** The material of the living debris lying there, if any (a step crunches it). */
  debris?: string;
}

/** Looks a tile up in what the client knows (undefined: unknown). */
export type ObjectSurfaceLookup = (x: number, y: number, z: number) => ObjectSurface | undefined;

export interface LivingObjectsOptions {
  /** Pixels of a tile in the stage's space. */
  tileSize: number;
  /** The texture of an item (its sprite), for the ghosts of pushes and fades. */
  texture?: (itemId: number) => Texture | undefined;
  /** Plays a sound of assets/sounds.yaml at a tile. */
  playSound?: (id: string, at: LivingPos) => void;
  /** Reduced motion: no particles nor slides (sounds still play). */
  reducedMotion?: () => boolean;
  /** Math.random by default; tests pass a seeded one. */
  random?: () => number;
}

/** The living world as the game sees it. */
export interface LivingObjects {
  /** A LivingObjectEvent arrived at `now` (performance.now() ms). */
  onObjectEvent(e: LivingEvent, now: number): void;
  /** A creature stepped from one tile to another at `now`. */
  onStep(from: LivingPos, to: LivingPos, now: number): void;
  /** A frame at `now` on floor `floor`: moves and draws every effect. */
  onTick(now: number, floor: number): void;
  /** Particles and ghosts alive after the last onTick (tests, docs/07). */
  readonly alive: number;
  /** Takes its layer off the stage. */
  destroy(): void;
}

interface Placed<T> {
  z: number;
  item: T;
}

/**
 * Mounts the living world's effects on `stage` (a container in world space, `tileSize`
 * pixels per tile, the map's overlay) and returns the handle the game feeds.
 */
export function createLivingObjects(
  stage: Container,
  surfaceLookup: ObjectSurfaceLookup,
  options: LivingObjectsOptions,
): LivingObjects {
  const T = options.tileSize;
  const random = options.random ?? Math.random;
  const reduced = (): boolean => options.reducedMotion?.() === true;
  const layer = new Container({ label: "living world" });
  const dots = new Graphics({ label: "living particles" });
  const ghostLayer = new Container({ label: "living ghosts" });
  layer.addChild(ghostLayer, dots);
  stage.addChild(layer);

  const particles: Placed<Particle>[] = [];
  const ghosts: Placed<Ghost>[] = [];
  const pool: Sprite[] = [];
  let alive = 0;

  const throwAt = (
    kind: BurstKind,
    effect: string | undefined,
    p: LivingPos,
    now: number,
  ): void => {
    if (reduced()) return;
    for (const item of burst(kind, materialOf(effect), p.x, p.y, now, random))
      particles.push({ z: p.z, item });
  };
  const ghost = (g: Ghost, z: number): void => {
    if (!reduced() && options.texture?.(g.itemId)) ghosts.push({ z, item: g });
  };

  return {
    onObjectEvent(e, now) {
      if (e.sound !== "") options.playSound?.(e.sound, e.pos);
      switch (e.kind) {
        case "hit":
          throwAt("hit", e.effect, e.pos, now);
          break;
        case "break":
          throwAt("break", e.effect, e.pos, now);
          throwAt("dust", e.effect, e.pos, now);
          break;
        case "push":
        case "reset":
          if (e.to) {
            const to = e.to;
            // The tile update already shows it at `to`: the ghost glides there, over it.
            ghost(
              {
                itemId: e.itemId,
                fromX: e.pos.x,
                fromY: e.pos.y,
                toX: to.x,
                toY: to.y,
                start: now,
                ms: SLIDE_MS,
                alpha0: 0.85,
                alpha1: 0,
              },
              e.pos.z,
            );
            throwAt("dust", e.effect, e.pos, now);
          }
          break;
        case "fade":
          ghost(
            {
              itemId: e.itemId,
              fromX: e.pos.x,
              fromY: e.pos.y,
              toX: e.pos.x,
              toY: e.pos.y,
              start: now,
              ms: FADE_MS,
              alpha0: 1,
              alpha1: 0,
            },
            e.pos.z,
          );
          break;
        case "respawn":
        case "gate_open":
        case "gate_close":
          throwAt("dust", e.effect, e.pos, now);
          break;
      }
    },
    onStep(_from, to, now) {
      const debris = surfaceLookup(to.x, to.y, to.z)?.debris;
      if (debris !== undefined) throwAt("hit", debris, to, now); // stepping crunches it
    },
    onTick(now, floor) {
      keepInPlace(particles, (p) => particleAt(p.item, now) !== undefined);
      keepInPlace(ghosts, (g) => ghostAt(g.item, now) !== undefined);
      dots.clear();
      for (const { z, item } of particles) {
        if (z !== floor) continue;
        const at = particleAt(item, now);
        if (!at) continue;
        const lift = surfaceLookup(Math.floor(item.x), Math.floor(item.y), z)?.elevation ?? 0;
        dots
          .rect(Math.round(at.x * T), Math.round(at.y * T) - lift, item.size, item.size)
          .fill({ color: item.color, alpha: at.alpha });
      }
      let used = 0;
      for (const { z, item } of ghosts) {
        const at = ghostAt(item, now);
        const tex = options.texture?.(item.itemId);
        if (z !== floor || !at || !tex) continue;
        let s = pool[used];
        if (!s) {
          s = new Sprite({ roundPixels: true });
          s.anchor.set(0.5, 1);
          pool.push(s);
          ghostLayer.addChild(s);
        }
        used++;
        s.texture = tex;
        s.position.set((at.x + 0.5) * T, (at.y + 1) * T);
        s.alpha = at.alpha;
        s.visible = true;
      }
      for (let i = used; i < pool.length; i++) {
        const s = pool[i];
        if (s) s.visible = false;
      }
      alive = particles.length + ghosts.length;
    },
    get alive() {
      return alive;
    },
    destroy() {
      stage.removeChild(layer);
      layer.destroy({ children: true });
    },
  };
}
