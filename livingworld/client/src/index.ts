// @rpg/living-world: the living world's client effects (livingworld/README.md). The client
// mounts it through createLivingWorld and tells it about steps and frames; everything here is
// cosmetic and client only, and nothing in it talks to the server.
//
//   ground layer  (over the grounds, under shadows, items and creatures): trail wear
//                 (the server's state: drawn even with reduced effects), footprints,
//                 water ripples and dust clouds, fish shadows
//   air layer     (over the map): falling leaves, birds, butterflies, fireflies
//   plants        the map's own plant sprites get a skew (bend) or a pixel offset (rustle)
//
// Cheap on purpose (docs/07): fixed sprite pools made once, every effect capped, and with
// reduced effects (the player's "reduced animations" or the system's reduced motion) nothing
// is spawned, drawn or moved.
import { Container, Sprite, Texture } from "pixi.js";
import { CritterSim, MAX_CRITTERS } from "./critters.ts";
import type { LivingWorldData, PlantRule, Surface } from "./data.ts";
import { FootprintSim, MAX_FOOTPRINTS, stepRotation } from "./footprints.ts";
import type { PrintKind } from "./footprints.ts";
import { footstepEvents } from "./footsteps.ts";
import { seededRandom, tileKey } from "./hash.ts";
import { LeafSim, MAX_LEAVES } from "./leaves.ts";
import { MAX_PUFFS, PuffSim, RUN_STEP_MS } from "./puffs.ts";
import { idleSway, rustleOffset, SwaySim } from "./sway.ts";
import { MAX_WEAR_DRAWN, TRAMPLE_SCALE, WearMap, wearSprite } from "./wear.ts";
import type { WearDraw, WearTile } from "./wear.ts";

export * from "./data.ts";
export * from "./sky.ts";
export {
  BREAK_MS,
  BURST_COUNT,
  burst,
  FADE_MS,
  ghostAt,
  MATERIAL_COLORS,
  materialOf,
  particleAt,
  SLIDE_MS,
} from "./effects.ts";
export type { Ghost, Material, Particle } from "./effects.ts";
export { createLivingObjects, keepInPlace } from "./objects.ts";
export type {
  LivingEvent,
  LivingEventKind,
  LivingObjects,
  LivingObjectsOptions,
  LivingPos,
  ObjectSurface,
  ObjectSurfaceLookup,
} from "./objects.ts";
export { gust, FootprintSim, MAX_FOOTPRINTS, PRINT_KINDS, stepRotation } from "./footprints.ts";
export type { Footprint, PrintKind } from "./footprints.ts";
export { SwaySim, idleSway, rustleOffset, SWAY_MS, MAX_SWAYS } from "./sway.ts";
export { PuffSim, MAX_PUFFS, RUN_STEP_MS } from "./puffs.ts";
export { LeafSim, MAX_LEAVES } from "./leaves.ts";
export { CritterSim, MAX_CRITTERS, FLEE_TILES } from "./critters.ts";
export {
  WearMap,
  MAX_WEAR_DRAWN,
  MAX_WEAR_LEVEL,
  TRAMPLE_SCALE,
  WEAR_E,
  WEAR_N,
  WEAR_S,
  WEAR_W,
  wearSprite,
} from "./wear.ts";
export type { WearDraw, WearTile } from "./wear.ts";
export { footstepEvents, STEP_EVENT } from "./footsteps.ts";
export { hash01, seededRandom } from "./hash.ts";

/** The containers the client gives it, both in world space (one unit = one sprite pixel). */
export interface LivingStage {
  /** Over the grounds and their borders, under cast shadows, items and creatures. */
  ground: Container;
  /** Over the map. */
  air: Container;
}

/** What ground surface tile (x, y, z) has, if any (the glue reads its map and data/items). */
export type SurfaceLookup = (x: number, y: number, z: number) => Surface | undefined;

/** The part of a map sprite a plant reaction moves (a Pixi Sprite has both). */
export interface PlantSprite {
  x: number;
  skew: { x: number };
  /** Its scale (a Pixi Sprite's): a trampled plant is drawn flatter. Optional for tests. */
  scale?: { y: number };
}

/**
 * The map's item sprites of the floor in view: `version` changes whenever the set changes
 * (a chunk built or dropped), and forEach lists them with their tile and item id.
 */
export interface PlantSource {
  version(): number;
  forEach(fn: (x: number, y: number, itemId: string, sprite: PlantSprite) => void): void;
}

export interface LivingWorldOptions {
  /** Sprite pixels per tile. */
  tileSize: number;
  data: LivingWorldData;
  /** An atlas sprite: livingworld/fx/<name> (assets/livingworld/sprites/fx); undefined if missing. */
  texture?: ((name: string) => Texture | undefined) | undefined;
  plants?: PlantSource | undefined;
  /** Reduced effects now: nothing at all. */
  reduced?: (() => boolean) | undefined;
  /** Night now: fireflies instead of birds and butterflies. */
  night?: (() => boolean) | undefined;
  /** Seed of the leaves' generator (tests). */
  seed?: number | undefined;
}

/** One step of a creature in view, as the client starts drawing it. */
export interface CreatureStep {
  id: number;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  /** How long the step takes, ms (a run is RUN_STEP_MS or less). */
  durationMs: number;
  /** Which marks its feet leave; "none" for a flier. */
  print: PrintKind | "none";
}

/** The frame: the tiles in view (fractional), the floor, and where the own player is. */
export interface TickView {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  self?: { x: number; y: number } | undefined;
}

export interface LivingWorld {
  onCreatureStep(step: CreatureStep, now: number): void;
  onTick(now: number, view: TickView): void;
  /**
   * Trail wear from the server (livingworld/server through the client's glue): each tile's
   * level, 0 to 3 (0 forgets it). With replace the tiles are the whole wear.
   */
  applyWear(tiles: readonly WearTile[], replace?: boolean): void;
  /** The sound events of the own player's step onto `to` (footsteps.ts). */
  footstepEvents(to: { x: number; y: number; z: number }): string[];
  /** Counts for tests and the debug overlay. */
  stats(): {
    wear: number;
    footprints: number;
    puffs: number;
    leaves: number;
    critters: number;
    sways: number;
    plants: number;
  };
  destroy(): void;
}

/** The tint of a worn tile's plain square when the atlas lacks its overlay. */
const WEAR_FALLBACK_TINT = 0x4a3c2a;

/** The tiles a frame covers, with a margin: x0, y0, x1, y1 (reused: no list per frame). */
const tilesBuf: [number, number, number, number] = [0, 0, 0, 0];
function viewTiles(view: TickView): [number, number, number, number] {
  tilesBuf[0] = Math.floor(view.x) - 1;
  tilesBuf[1] = Math.floor(view.y) - 1;
  tilesBuf[2] = Math.ceil(view.x + view.width) + 1;
  tilesBuf[3] = Math.ceil(view.y + view.height) + 2;
  return tilesBuf;
}

/** A frame longer than this (a hidden tab) advances the effects this much only, ms. */
export const MAX_FRAME_MS = 100;

interface PlantEntry {
  x: number;
  y: number;
  rule: PlantRule;
  sprite: PlantSprite;
  baseX: number;
}

/** A pool of sprites made once, shown in order each frame. */
class Pool {
  private readonly sprites: Sprite[] = [];
  private shown = 0;

  constructor(
    parent: Container,
    size: number,
    private readonly texture: (name: string) => Texture | undefined,
  ) {
    for (let i = 0; i < size; i++) {
      const s = new Sprite({
        texture: Texture.WHITE,
        anchor: 0.5,
        visible: false,
        roundPixels: true,
      });
      this.sprites.push(s);
      parent.addChild(s);
    }
  }

  begin(): void {
    this.shown = 0;
  }

  /** The next sprite with `name`'s texture (a FALLBACK_PX square when the atlas lacks it). */
  next(name: string, fallbackPx: number): Sprite | undefined {
    const s = this.sprites[this.shown];
    if (!s) return undefined;
    this.shown++;
    const tex = this.texture(name);
    if (tex) {
      if (s.texture !== tex) s.texture = tex;
      s.scale.set(1);
    } else {
      s.texture = Texture.WHITE;
      s.width = fallbackPx;
      s.height = fallbackPx;
    }
    s.visible = true;
    s.rotation = 0;
    s.tint = 0xffffff;
    s.alpha = 1;
    return s;
  }

  end(): void {
    for (let i = this.shown; i < this.sprites.length; i++) {
      const s = this.sprites[i] as Sprite;
      if (s.visible) s.visible = false;
    }
  }
}

/** Mounts the living world on `stage`. */
export function createLivingWorld(
  stage: LivingStage,
  surfaceAt: SurfaceLookup,
  options: LivingWorldOptions,
): LivingWorld {
  const T = options.tileSize;
  const data = options.data;
  const texCache = new Map<string, Texture | undefined>();
  const texture = (name: string): Texture | undefined => {
    if (!texCache.has(name)) texCache.set(name, options.texture?.(`livingworld/fx/${name}`));
    return texCache.get(name);
  };
  // Trail wear is the server's state, not an animation: its own layer, under the effects,
  // stays with reduced effects.
  const wearLayer = new Container({ label: "living world: trail wear" });
  const ground = new Container({ label: "living world: ground" });
  const air = new Container({ label: "living world: air" });
  stage.ground.addChild(wearLayer);
  stage.ground.addChild(ground);
  stage.air.addChild(air);
  const wearPool = new Pool(wearLayer, MAX_WEAR_DRAWN, texture);
  const printPool = new Pool(ground, MAX_FOOTPRINTS, texture);
  const puffPool = new Pool(ground, MAX_PUFFS, texture);
  const leafPool = new Pool(air, MAX_LEAVES, texture);
  const critterPool = new Pool(air, MAX_CRITTERS, texture);

  const prints = new FootprintSim();
  const sway = new SwaySim();
  const puffs = new PuffSim();
  const random = seededRandom(options.seed ?? 0x11fe);
  const leaves = new LeafSim(random);
  const critters = new CritterSim(T);
  const wear = new WearMap();
  /** Which foot is next, by creature (left, right, left...). */
  const foot = new Map<number, number>();

  let plants: PlantEntry[] = [];
  const plantAt = new Map<number, PlantEntry>();
  let plantsVersion = -1;
  const refreshPlants = (): void => {
    const src = options.plants;
    if (!src || src.version() === plantsVersion) return;
    plantsVersion = src.version();
    plants = [];
    plantAt.clear();
    src.forEach((x, y, id, sprite) => {
      const rule = data.plants[id];
      if (!rule) return;
      const e = { x, y, rule, sprite, baseX: sprite.x };
      plants.push(e);
      plantAt.set(tileKey(x, y), e);
    });
  };
  const settlePlants = (): void => {
    for (const p of plants) {
      p.sprite.skew.x = 0;
      p.sprite.x = p.baseX;
    }
  };

  /** The worn tiles in view, rebuilt only when the wear or the view's tiles changed. */
  let wearShown: WearDraw[] = [];
  const wearAt = { version: -1, z: -1, x0: 0, y0: 0, x1: 0, y1: 0 };
  const wearInView = (z: number, x0: number, y0: number, x1: number, y1: number): WearDraw[] => {
    const a = wearAt;
    if (
      a.version !== wear.version ||
      a.z !== z ||
      a.x0 !== x0 ||
      a.y0 !== y0 ||
      a.x1 !== x1 ||
      a.y1 !== y1
    ) {
      a.version = wear.version;
      a.z = z;
      a.x0 = x0;
      a.y0 = y0;
      a.x1 = x1;
      a.y1 = y1;
      wearShown = wear.size > 0 ? wear.inView(z, x0, y0, x1, y1) : [];
    }
    return wearShown;
  };

  /** Draws the trail wear and flattens the plants that trample on worn tiles. */
  const drawWear = (z: number, x0: number, y0: number, x1: number, y1: number): void => {
    wearPool.begin();
    for (const t of wearInView(z, x0, y0, x1, y1)) {
      const name = wearSprite(t.level, t.mask);
      const art = texture(name) !== undefined;
      const s = wearPool.next(name, T);
      if (!s) break;
      s.position.set((t.x + 0.5) * T, (t.y + 0.5) * T);
      if (!art) {
        // No art in the atlas: a plain earth-coloured square, fainter the less worn.
        s.tint = WEAR_FALLBACK_TINT;
        s.alpha = 0.15 * t.level;
      }
    }
    wearPool.end();
    for (const p of plants) {
      if (!p.rule.trample || !p.sprite.scale) continue;
      const k = TRAMPLE_SCALE[wear.size > 0 ? wear.level(p.x, p.y, z) : 0] ?? 1;
      if (p.sprite.scale.y !== k) p.sprite.scale.y = k;
    }
  };

  /** The floor of the frame, for critterSurface (made once: no closure per frame). */
  let floorZ = 0;
  const critterSurface = (x: number, y: number): Surface | undefined => surfaceAt(x, y, floorZ);

  let last: number | undefined;
  let wasReduced = false;
  const reduced = (): boolean => options.reduced?.() ?? false;

  const clearAll = (): void => {
    prints.clear();
    sway.clear();
    puffs.clear();
    leaves.clear();
    critters.clear();
    settlePlants();
  };

  return {
    onCreatureStep(step, now) {
      if (reduced()) return;
      const dx = Math.sign(step.to.x - step.from.x);
      const dy = Math.sign(step.to.y - step.from.y);
      // Plants on and round the tile it steps onto react, if it walks (a flier brushes none).
      if (step.print !== "none") {
        sway.trigger(step.to.x, step.to.y, dx, now);
        // Brushing past a tree may shake a leaf loose.
        for (let oy = -1; oy <= 1; oy++)
          for (let ox = -1; ox <= 1; ox++) {
            const p = plantAt.get(tileKey(step.to.x + ox, step.to.y + oy));
            if (p?.rule.leaves && random() < 0.5) leaves.drop((p.x + 0.5) * T, (p.y + 1) * T);
          }
      }
      const s = surfaceAt(step.from.x, step.from.y, step.from.z);
      const rules = s ? data.surfaces[s] : undefined;
      if (!s || !rules || step.print === "none") return;
      const cx = (step.from.x + 0.5) * T;
      const cy = (step.from.y + 0.6) * T;
      if (rules.footprintMs > 0) {
        const rot = stepRotation(dx, dy);
        const side = (foot.get(step.id) ?? 0) === 0 ? -1 : 1;
        if (foot.size > 256) foot.clear();
        foot.set(step.id, side < 0 ? 1 : 0);
        // A humanoid's feet alternate either side of its line; paws sit on it.
        const off = step.print === "feet" ? 3 * side : 0;
        prints.add(cx + Math.cos(rot) * off, cy + Math.sin(rot) * off, rot, step.print, s, rules);
      }
      if (rules.ripple) puffs.add("ripple", cx, cy, 0xffffff);
      if (rules.dust && step.durationMs > 0 && step.durationMs <= RUN_STEP_MS)
        puffs.add("dust", cx, cy + 2, rules.tint);
    },

    onTick(now, view) {
      const ms = last === undefined ? 0 : Math.min(MAX_FRAME_MS, Math.max(0, now - last));
      last = now;
      if (reduced()) {
        if (!wasReduced) clearAll();
        wasReduced = true;
        ground.visible = false;
        air.visible = false;
        refreshPlants();
        const [rx0, ry0, rx1, ry1] = viewTiles(view);
        drawWear(view.z, rx0, ry0, rx1, ry1);
        return;
      }
      wasReduced = false;
      floorZ = view.z;
      ground.visible = true;
      air.visible = true;
      prints.step(ms, now);
      puffs.step(ms);
      leaves.step(ms);
      sway.prune(now);
      refreshPlants();
      const [x0, y0, x1, y1] = viewTiles(view);
      // Plants: bends from steps, idle sway on tall ones; idle leaves from trees in view.
      let trees = 0;
      for (const p of plants) {
        if (p.x < x0 || p.y < y0 || p.x > x1 || p.y > y1) continue;
        let b = sway.bendAt(p.x, p.y, now);
        if (p.rule.idle) b += idleSway(p.x, p.y, now);
        // A positive skew.x leans a bottom-anchored sprite's top to the left: negate it so a
        // positive bend leans right, the way a walker going east pushes it.
        if (p.rule.reaction === "bend") p.sprite.skew.x = -b;
        else p.sprite.x = p.baseX + rustleOffset(b);
        if (p.rule.leaves) trees++;
      }
      if (trees > 0 && random() < leaves.chance(trees, ms)) {
        let pick = Math.floor(random() * trees);
        for (const p of plants) {
          if (!p.rule.leaves || p.x < x0 || p.y < y0 || p.x > x1 || p.y > y1) continue;
          if (pick-- === 0) {
            leaves.drop((p.x + 0.5) * T, (p.y + 1) * T);
            break;
          }
        }
      }
      critters.update(
        now,
        view,
        view.self,
        critterSurface,
        data.surfaces,
        options.night?.() ?? false,
      );
      draw(now, view, x0, y0, x1, y1);
    },

    applyWear(tiles, replace = false) {
      wear.apply(tiles, replace);
    },

    footstepEvents(to) {
      return footstepEvents(surfaceAt(to.x, to.y, to.z), data);
    },

    stats() {
      return {
        wear: wear.size,
        footprints: prints.count,
        puffs: puffs.puffs.length,
        leaves: leaves.leaves.length,
        critters: critters.critters.length,
        sways: sway.active,
        plants: plants.length,
      };
    },

    destroy() {
      settlePlants();
      for (const p of plants) if (p.sprite.scale) p.sprite.scale.y = 1;
      wearLayer.destroy({ children: true });
      ground.destroy({ children: true });
      air.destroy({ children: true });
    },
  };

  function draw(now: number, view: TickView, x0: number, y0: number, x1: number, y1: number): void {
    drawWear(view.z, x0, y0, x1, y1);
    printPool.begin();
    for (const p of prints.prints) {
      const s = printPool.next(`footprint_${p.kind}`, 2);
      if (!s) break;
      s.position.set(Math.round(p.x), Math.round(p.y));
      s.rotation = p.rot;
      s.tint = p.tint;
      s.alpha = FootprintSim.alpha(p);
    }
    printPool.end();
    puffPool.begin();
    for (const p of puffs.puffs) {
      const { frame, alpha } = PuffSim.frame(p);
      const s = puffPool.next(`${p.kind}_${frame}`, 3 + frame * 2);
      if (!s) break;
      s.position.set(Math.round(p.x), Math.round(p.y));
      s.tint = p.tint;
      s.alpha = alpha;
    }
    puffPool.end();
    leafPool.begin();
    for (const l of leaves.leaves) {
      const pose = LeafSim.pose(l);
      const s = leafPool.next(`leaf_${l.variant}`, 2);
      if (!s) break;
      s.position.set(Math.round(pose.x), Math.round(pose.y));
      s.rotation = pose.rot;
      s.alpha = pose.alpha;
    }
    leafPool.end();
    critterPool.begin();
    for (const c of critters.critters) {
      const s = critterPool.next(`${c.kind}_${CritterSim.frame(c, now)}`, 2);
      if (!s) break;
      s.position.set(Math.round(c.x), Math.round(c.y));
      s.alpha = CritterSim.alpha(c, now);
      if (c.fled >= 0 && c.dx < 0) s.scale.x = -Math.abs(s.scale.x);
    }
    critterPool.end();
  }
}
