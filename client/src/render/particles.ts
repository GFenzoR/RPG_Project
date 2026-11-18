// Ambient particles (docs/17 ART-7, A13), client only: embers rise from lava and from fires
// (the forge, the hearth, braziers), pollen drifts round trees, spray leaps where the sea
// meets the shore, and dust floats in the dark of caves. Where they come from is data: the
// `particles` of a sprite in assets/sprites.yaml `tiles` (MapView.forEachEmitter); the dust
// of caves fills the view on its own. Steps kick some up too (MOV-7): a puff of dust on
// sand, dirt or ash, a ring of ripples on wet sand (`steps` of a ground in `tiles`); the
// canvas calls ParticleLayer.kick when a creature starts a step there.
//
// Cheap on purpose (docs/07): at most MAX_PARTICLES alive, kept in typed arrays and drawn
// by a fixed pool of 1-pixel sprites made once; a frame allocates nothing (the emitter
// callback is made once, the random numbers come from a seeded generator, a dead particle
// is replaced by the last one). Only emitters in view spawn. With reduced motion (the
// player's option or the system's), nothing is spawned and nothing is drawn.
import { Container, Sprite, Texture } from "pixi.js";
import { PARTICLE_KINDS } from "@rpg/renderer";
import type { ParticleKind, StepKind, TileMeta } from "@rpg/renderer";

/** ART-7: at most this many particles on screen. */
export const MAX_PARTICLES = 100;
/** Room kept for the particles of steps (MOV-7): ambient ones stop short of it. */
export const STEP_RESERVE = 16;
/** MOV-7: particles a step kicks up. */
export const STEP_PARTICLES: Readonly<Record<StepKind, number>> = { dust: 6, ripple: 8 };

/** Every kind the sim draws: the ambient ones of tile art, then the steps' puff and ripple. */
export const SIM_KINDS = [...PARTICLE_KINDS, "puff", "ripple"] as const;
export type SimKind = (typeof SIM_KINDS)[number];
/**
 * What a step on ground item `ground` kicks up (MOV-7): the `steps` of its sprite in
 * atlas.json `tiles` (assets/sprites.yaml), if any.
 */
export function stepKindOf(
  ground: number,
  items: Readonly<Record<number, { sprite: string } | undefined>>,
  tiles: Readonly<Record<string, TileMeta>> | undefined,
): StepKind | undefined {
  const sprite = items[ground]?.sprite;
  return sprite ? tiles?.[sprite]?.steps : undefined;
}

/** The kind of particle a step on a ground of that kind makes. */
const STEP_SIM: Readonly<Record<StepKind, SimKind>> = { dust: "puff", ripple: "ripple" };
/** A frame longer than this (a hidden tab) advances the particles this much only, ms. */
export const MAX_STEP_MS = 100;

/** How a kind of particle is born, moves and looks. Speeds in sprite px per second. */
interface Style {
  /** Births per emitter tile per second (dust: per screen of 32x32 tiles per second). */
  rate: number;
  lifeMs: number;
  lifeSpreadMs: number;
  /** Birth box, tiles, from the emitter tile's top-left corner. */
  x0: number;
  xw: number;
  y0: number;
  yh: number;
  vx: number;
  vxSpread: number;
  vy: number;
  vySpread: number;
  /** Added to vy every second (spray falls back). */
  gravity: number;
  /** Side to side sway, sprite px (pollen and dust drift, embers flicker). */
  sway: number;
  alpha: number;
  /** Fade in and out over this much of its life at most, ms. */
  fadeInMs: number;
  fadeOutMs: number;
  /** Colours by age: young, middle, old. */
  colors: readonly [number, number, number];
}

/** Ambient particles fade in and out over this much of their life at most, ms. */
const FADE_IN_MS = 200;
const FADE_OUT_MS = 350;

export const STYLES: Readonly<Record<SimKind, Style>> = {
  embers: {
    rate: 0.35,
    lifeMs: 1100,
    lifeSpreadMs: 900,
    x0: 0.25,
    xw: 0.5,
    y0: 0.35,
    yh: 0.4,
    vx: 0,
    vxSpread: 6,
    vy: -16,
    vySpread: 10,
    gravity: 0,
    sway: 1.5,
    alpha: 1,
    fadeInMs: FADE_IN_MS,
    fadeOutMs: FADE_OUT_MS,
    colors: [0xffe08a, 0xff9a3c, 0xd8461e],
  },
  pollen: {
    rate: 0.12,
    lifeMs: 3200,
    lifeSpreadMs: 2200,
    x0: -0.5,
    xw: 2,
    y0: -1.2,
    yh: 1.8,
    vx: 2,
    vxSpread: 4,
    vy: 1.5,
    vySpread: 3,
    gravity: 0,
    sway: 3,
    alpha: 0.8,
    fadeInMs: FADE_IN_MS,
    fadeOutMs: FADE_OUT_MS,
    colors: [0xf4efb0, 0xe8e08a, 0xd6cf7a],
  },
  spray: {
    rate: 0.18,
    lifeMs: 450,
    lifeSpreadMs: 300,
    x0: 0,
    xw: 1,
    y0: 0.2,
    yh: 0.6,
    vx: 0,
    vxSpread: 14,
    vy: -34,
    vySpread: 14,
    gravity: 120,
    sway: 0,
    alpha: 0.9,
    fadeInMs: FADE_IN_MS,
    fadeOutMs: FADE_OUT_MS,
    colors: [0xffffff, 0xe6f4ff, 0xc4e2f2],
  },
  dust: {
    rate: 30,
    lifeMs: 3500,
    lifeSpreadMs: 2500,
    x0: 0,
    xw: 1,
    y0: 0,
    yh: 1,
    vx: 0,
    vxSpread: 3,
    vy: -1,
    vySpread: 2,
    gravity: 0,
    sway: 2,
    alpha: 0.45,
    fadeInMs: FADE_IN_MS,
    fadeOutMs: FADE_OUT_MS,
    colors: [0xd2c6ae, 0xbcb09a, 0xa49884],
  },
  // MOV-7: a puff at the feet that rises a little and settles (about 3 frames, 200 ms).
  puff: {
    rate: 0,
    lifeMs: 220,
    lifeSpreadMs: 120,
    x0: 0,
    xw: 0,
    y0: 0,
    yh: 0,
    vx: 0,
    vxSpread: 18,
    vy: -20,
    vySpread: 8,
    gravity: 50,
    sway: 0,
    alpha: 0.95,
    fadeInMs: 30,
    fadeOutMs: 150,
    // Paler than the grounds it rises from (sand, dirt, ash), so it reads on them.
    colors: [0xfbf6ea, 0xece2cc, 0xd6caae],
  },
  // MOV-7: a ring of drops spreading flat round the feet on wet ground.
  ripple: {
    rate: 0,
    lifeMs: 380,
    lifeSpreadMs: 80,
    x0: 0,
    xw: 0,
    y0: 0,
    yh: 0,
    vx: 22,
    vxSpread: 0,
    vy: 11,
    vySpread: 0,
    gravity: 0,
    sway: 0,
    alpha: 0.75,
    fadeInMs: 40,
    fadeOutMs: 220,
    colors: [0xffffff, 0xdcedf7, 0xb6d4e6],
  },
};

/** A small seeded generator (mulberry32): the same seed, the same particles. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The tiles in view: a rectangle in tiles, fractional. */
export interface ParticleView {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The particles themselves, without PixiJS (tests drive it directly). */
export class ParticleSim {
  readonly x = new Float32Array(MAX_PARTICLES);
  readonly y = new Float32Array(MAX_PARTICLES);
  readonly vx = new Float32Array(MAX_PARTICLES);
  readonly vy = new Float32Array(MAX_PARTICLES);
  readonly age = new Float32Array(MAX_PARTICLES);
  readonly life = new Float32Array(MAX_PARTICLES);
  readonly phase = new Float32Array(MAX_PARTICLES);
  readonly kind = new Uint8Array(MAX_PARTICLES);
  count = 0;

  constructor(
    private readonly random: () => number,
    private readonly tile: number,
  ) {}

  /** An ambient particle of `kind` from tile (tx, ty), if there is room (STEP_RESERVE kept). */
  spawn(kind: ParticleKind, tx: number, ty: number): boolean {
    if (this.count >= MAX_PARTICLES - STEP_RESERVE) return false;
    const s = STYLES[kind];
    const r = this.random;
    const i = this.count++;
    this.x[i] = (tx + s.x0 + r() * s.xw) * this.tile;
    this.y[i] = (ty + s.y0 + r() * s.yh) * this.tile;
    this.vx[i] = s.vx + (r() * 2 - 1) * s.vxSpread;
    this.vy[i] = s.vy + (r() * 2 - 1) * s.vySpread;
    this.age[i] = 0;
    this.life[i] = s.lifeMs + r() * s.lifeSpreadMs;
    this.phase[i] = r() * Math.PI * 2;
    this.kind[i] = SIM_KINDS.indexOf(kind);
    return true;
  }

  /**
   * What a step kicks up at the feet, (px, py) in sprite pixels (MOV-7): a puff of dust
   * rising round them, or a ring of ripples spreading flat. As many as there is room for;
   * returns how many.
   */
  kick(kind: StepKind, px: number, py: number): number {
    const sim = STEP_SIM[kind];
    const s = STYLES[sim];
    const n = STEP_PARTICLES[kind];
    const r = this.random;
    let made = 0;
    for (let k = 0; k < n && this.count < MAX_PARTICLES; k++) {
      const i = this.count++;
      if (kind === "dust") {
        this.x[i] = px + (r() * 2 - 1) * 5;
        this.y[i] = py - r() * 2;
        this.vx[i] = (r() * 2 - 1) * s.vxSpread;
        this.vy[i] = s.vy + (r() * 2 - 1) * s.vySpread;
      } else {
        const a = ((k + r() * 0.5) / n) * 2 * Math.PI;
        this.x[i] = px + Math.cos(a) * 2;
        this.y[i] = py + Math.sin(a);
        this.vx[i] = Math.cos(a) * s.vx;
        this.vy[i] = Math.sin(a) * s.vy;
      }
      this.age[i] = 0;
      this.life[i] = s.lifeMs + r() * s.lifeSpreadMs;
      this.phase[i] = 0;
      this.kind[i] = SIM_KINDS.indexOf(sim);
      made++;
    }
    return made;
  }

  /** Births from one emitter tile over `ms`: each a chance of rate × time. */
  emit(kind: ParticleKind, tx: number, ty: number, ms: number): void {
    const chance = (STYLES[kind].rate * ms) / 1000;
    // Rates are well under one birth per frame; a long frame may give one more.
    let left = chance;
    while (left > 0 && this.count < MAX_PARTICLES - STEP_RESERVE) {
      if (this.random() < Math.min(1, left)) this.spawn(kind, tx, ty);
      left -= 1;
    }
  }

  /** Advances every particle `ms`; the dead ones go (the last takes their place). */
  step(ms: number): void {
    const dt = ms / 1000;
    let i = 0;
    while (i < this.count) {
      const age = (this.age[i] ?? 0) + ms;
      if (age >= (this.life[i] ?? 0)) {
        this.remove(i);
        continue;
      }
      const s = STYLES[SIM_KINDS[this.kind[i] ?? 0] ?? "dust"];
      this.age[i] = age;
      this.vy[i] = (this.vy[i] ?? 0) + s.gravity * dt;
      this.x[i] = (this.x[i] ?? 0) + (this.vx[i] ?? 0) * dt;
      this.y[i] = (this.y[i] ?? 0) + (this.vy[i] ?? 0) * dt;
      i++;
    }
  }

  /** Forgets every particle. */
  clear(): void {
    this.count = 0;
  }

  /** How visible particle i is now (fades in, then out at the end of its life). */
  alpha(i: number): number {
    const s = STYLES[SIM_KINDS[this.kind[i] ?? 0] ?? "dust"];
    const age = this.age[i] ?? 0;
    const left = (this.life[i] ?? 0) - age;
    return s.alpha * Math.min(1, age / s.fadeInMs, left / s.fadeOutMs);
  }

  /** Its colour now: young, middle or old. */
  color(i: number): number {
    const s = STYLES[SIM_KINDS[this.kind[i] ?? 0] ?? "dust"];
    const t = (this.age[i] ?? 0) / (this.life[i] || 1);
    return s.colors[t < 0.4 ? 0 : t < 0.75 ? 1 : 2];
  }

  /** Its drawn x: the position plus its sway. */
  drawX(i: number): number {
    const s = STYLES[SIM_KINDS[this.kind[i] ?? 0] ?? "dust"];
    if (s.sway === 0) return this.x[i] ?? 0;
    return (this.x[i] ?? 0) + Math.sin((this.age[i] ?? 0) / 400 + (this.phase[i] ?? 0)) * s.sway;
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.x[i] = this.x[last] ?? 0;
    this.y[i] = this.y[last] ?? 0;
    this.vx[i] = this.vx[last] ?? 0;
    this.vy[i] = this.vy[last] ?? 0;
    this.age[i] = this.age[last] ?? 0;
    this.life[i] = this.life[last] ?? 0;
    this.phase[i] = this.phase[last] ?? 0;
    this.kind[i] = this.kind[last] ?? 0;
  }
}

/** Where emitters come from: MapView.forEachEmitter. */
export type EmitterSource = (fn: (x: number, y: number, kind: ParticleKind) => void) => void;

export class ParticleLayer {
  /** Add this in world space (MapView.overlay): one unit = one sprite pixel. */
  readonly view = new Container({ label: "particles" });
  readonly sim: ParticleSim;
  private readonly sprites: Sprite[] = [];
  private last: number | undefined;
  /** Reduced motion at the last update: steps kick nothing up either. */
  private reduced = false;
  /** The frame being spawned: its length and the tiles in view (read by onEmitter). */
  private ms = 0;
  private x0 = 0;
  private y0 = 0;
  private x1 = 0;
  private y1 = 0;
  private readonly onEmitter = (x: number, y: number, kind: ParticleKind): void => {
    if (x < this.x0 || y < this.y0 || x > this.x1 || y > this.y1) return;
    this.sim.emit(kind, x, y, this.ms);
  };

  constructor(
    tile: number,
    private readonly random: () => number = seededRandom(0x5eed),
  ) {
    this.sim = new ParticleSim(random, tile);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const s = new Sprite({ texture: Texture.WHITE, visible: false, roundPixels: true });
      s.width = 1;
      s.height = 1;
      this.sprites.push(s);
      this.view.addChild(s);
    }
  }

  /**
   * Steps the particles to `now` (ms) and spawns new ones from the emitters in `tiles` (the
   * tiles in view, fractional) and, in the dark (`dust`), anywhere in view. `reduced`: no
   * particles at all.
   */
  update(
    now: number,
    tiles: ParticleView,
    emitters: EmitterSource,
    dust: boolean,
    reduced: boolean,
  ): void {
    const ms = this.last === undefined ? 0 : Math.min(MAX_STEP_MS, Math.max(0, now - this.last));
    this.last = now;
    this.reduced = reduced;
    if (reduced) {
      this.sim.clear();
      this.view.visible = false;
      return;
    }
    this.view.visible = true;
    this.sim.step(ms);
    if (ms > 0) {
      this.ms = ms;
      // A tile's particles can drift a little out of it: one tile of margin.
      this.x0 = Math.floor(tiles.x) - 1;
      this.y0 = Math.floor(tiles.y) - 1;
      this.x1 = Math.ceil(tiles.x + tiles.width);
      this.y1 = Math.ceil(tiles.y + tiles.height) + 1;
      emitters(this.onEmitter);
      if (dust) {
        // DUST.rate per 32x32 tiles: as dense on any screen.
        const area = (tiles.width * tiles.height) / (32 * 32);
        const r = this.random;
        let left = (STYLES.dust.rate * area * ms) / 1000;
        while (left > 0 && this.sim.count < MAX_PARTICLES - STEP_RESERVE) {
          if (r() < Math.min(1, left))
            this.sim.spawn("dust", tiles.x + r() * tiles.width, tiles.y + r() * tiles.height);
          left -= 1;
        }
      }
    }
    this.draw();
  }

  /**
   * A step starts with the feet at (px, py), sprite pixels, on a ground that kicks up
   * `kind` (MOV-7). Nothing with reduced motion. Drawn from the next update.
   */
  kick(kind: StepKind, px: number, py: number): void {
    if (!this.reduced) this.sim.kick(kind, px, py);
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }

  private draw(): void {
    const sim = this.sim;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const s = this.sprites[i] as Sprite;
      if (i >= sim.count) {
        if (s.visible) s.visible = false;
        continue;
      }
      s.visible = true;
      s.position.set(Math.round(sim.drawX(i)), Math.round(sim.y[i] ?? 0));
      s.alpha = sim.alpha(i);
      s.tint = sim.color(i);
    }
  }
}
