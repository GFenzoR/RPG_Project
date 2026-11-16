// The effects of the game canvas, drawn above the map and its creatures: tile effects (the
// atlas frame strip of their id, played frame by frame; a procedural shape for an id with
// no art), projectiles, and the floating numbers in their own layer above names and bars.
//
// Budget (docs/07): every display object comes from a pool and is reused, the procedural
// shapes share one GraphicsContext per id, and a frame allocates nothing: effects and
// projectiles take pool slots in list order; a floating number keeps its Text while the
// world keeps the number (its text is set once).
import { Container, Graphics, GraphicsContext, Sprite, Text } from "pixi.js";
import type { Texture } from "pixi.js";
import { FloatingTextKind } from "@rpg/protocol";
import { tilePixels } from "@rpg/renderer";
import type { Atlas, Camera } from "@rpg/renderer";
import { effectFrame, effectFrames } from "./effects.ts";
import {
  EFFECT_BUFF,
  EFFECT_CONJURE,
  EFFECT_ELEMENT,
  EFFECT_GATHER,
  EFFECT_GATHER_MISS,
  EFFECT_HEAL,
  EFFECT_HIT,
  EFFECT_MS,
  ELEMENTS,
  FLOATING_TEXT_MS,
  PROJECTILE_ELEMENT,
  PROJECTILE_MS,
} from "../state/world.ts";
import type { FloatingTextState, WorldState } from "../state/world.ts";

const COLORS = {
  hit: 0xc01818,
  block: 0x9ab4d8,
  heal: 0x60e060,
  damage: 0xff4040,
  mana: 0x6090ff,
  experience: 0xffffff,
};

/** Colour of each element (state/world.ts ELEMENTS order), for projectiles and fallbacks. */
const ELEMENT_COLORS = [0xd8d0c0, 0xff7a1a, 0x8fd8ff, 0xc890ff, 0x7fc94a, 0xfff2a0, 0x5a3a6a];
const elementColor = (i: number): number => ELEMENT_COLORS[i] ?? ELEMENT_COLORS[0] ?? 0xffffff;

/**
 * The procedural drawing of an effect (32x32, tile top-left at 0,0): what an id without
 * frames in the atlas looks like.
 */
function effectShape(id: number): GraphicsContext {
  const g = new GraphicsContext();
  if (id === EFFECT_HIT)
    g.circle(16, 16, 7)
      .fill(COLORS.hit)
      .circle(9, 11, 3)
      .fill(COLORS.hit)
      .circle(23, 21, 3)
      .fill(COLORS.hit);
  else if (id === EFFECT_HEAL)
    g.circle(16, 16, 10)
      .stroke({ width: 2, color: COLORS.heal })
      .circle(10, 9, 2)
      .fill(COLORS.heal)
      .circle(22, 12, 2)
      .fill(COLORS.heal)
      .circle(16, 24, 2)
      .fill(COLORS.heal);
  else if (id === EFFECT_CONJURE) g.star(16, 16, 5, 11, 5).fill({ color: 0xb08cff, alpha: 0.85 });
  else if (id === EFFECT_GATHER)
    g.circle(16, 16, 11).stroke({ width: 2, color: 0xfff2a0 }).star(16, 16, 4, 7, 3).fill(0xfff2a0);
  else if (id === EFFECT_BUFF)
    g.circle(16, 16, 12)
      .stroke({ width: 2, color: 0x9ff0c8, alpha: 0.9 })
      .star(16, 16, 4, 8, 3)
      .fill({ color: 0x9ff0c8, alpha: 0.8 });
  else if (id === EFFECT_GATHER_MISS)
    g.circle(16, 16, 6)
      .stroke({ width: 2, color: 0xe8eef2, alpha: 0.8 })
      .circle(16, 16, 11)
      .stroke({ width: 1, color: 0xe8eef2, alpha: 0.5 });
  else if (id >= EFFECT_ELEMENT && id < EFFECT_ELEMENT + ELEMENTS.length) {
    const c = elementColor(id - EFFECT_ELEMENT);
    g.rect(2, 2, 28, 28).fill({ color: c, alpha: 0.35 }).star(16, 16, 6, 12, 6).fill(c);
  } else g.circle(16, 16, 9).stroke({ width: 3, color: COLORS.block });
  return g;
}

/** A projectile, centred on 0,0. */
function projectileShape(id: number): GraphicsContext {
  const c = elementColor(id - PROJECTILE_ELEMENT);
  return new GraphicsContext()
    .circle(0, 0, 5)
    .fill(c)
    .circle(0, 0, 8)
    .fill({ color: c, alpha: 0.35 });
}

const textColor = (k: FloatingTextKind): number =>
  k === FloatingTextKind.HEAL
    ? COLORS.heal
    : k === FloatingTextKind.MANA
      ? COLORS.mana
      : k === FloatingTextKind.EXPERIENCE
        ? COLORS.experience
        : COLORS.damage;

/** A floating number on screen; `seen` is the last frame that drew it. */
interface FloatingNumber {
  obj: Text;
  seen: number;
}

/** Hides the pooled objects from index `used` on. */
function hideFrom(pool: readonly Container[], used: number): void {
  for (let i = used; i < pool.length; i++) {
    const o = pool[i];
    if (o?.visible) o.visible = false;
  }
}

export interface EffectLayerOptions {
  world: WorldState;
  atlas: Atlas;
  /** Effects and projectiles: above the map and its creatures. */
  effects: Container;
  /** Floating numbers: above names and health bars. */
  texts: Container;
}

export class EffectLayer {
  /** Frame textures per effect id; empty = no art, draw the procedural shape. */
  private readonly frames = new Map<number, readonly Texture[]>();
  private readonly shapes = new Map<number, GraphicsContext>();
  private readonly shotShapes = new Map<number, GraphicsContext>();
  private readonly sprites: Sprite[] = [];
  private readonly shapeObjs: Graphics[] = [];
  private readonly shotObjs: Graphics[] = [];
  private readonly numbers = new Map<FloatingTextState, FloatingNumber>();
  private readonly spareTexts: Text[] = [];
  private readonly spriteGroup = new Container({ label: "effect sprites" });
  private readonly shapeGroup = new Container({ label: "effect shapes" });
  private readonly shotGroup = new Container({ label: "projectiles" });
  private readonly world: WorldState;
  private readonly atlas: Atlas;
  private readonly tileSize: number;
  private readonly texts: Container;
  private frame = 0;

  constructor(opts: EffectLayerOptions) {
    this.world = opts.world;
    this.atlas = opts.atlas;
    this.tileSize = opts.atlas.tileSize;
    this.texts = opts.texts;
    opts.effects.addChild(this.spriteGroup, this.shapeGroup, this.shotGroup);
  }

  /** Real art only: an automatic or manifest placeholder would look worse than the shape. */
  private readonly hasArt = (sprite: string): boolean => {
    const origin = this.atlas.index.sprites[sprite]?.origin;
    return this.atlas.has(sprite) && origin !== "auto" && origin !== "placeholder";
  };

  private framesOf(id: number): readonly Texture[] {
    let tex = this.frames.get(id);
    if (!tex) {
      tex = effectFrames(id, this.hasArt).flatMap((s) => this.atlas.texture(s) ?? []);
      this.frames.set(id, tex);
    }
    return tex;
  }

  private shapeOf(id: number): GraphicsContext {
    let ctx = this.shapes.get(id);
    if (!ctx) {
      ctx = effectShape(id);
      this.shapes.set(id, ctx);
    }
    return ctx;
  }

  private shotShapeOf(id: number): GraphicsContext {
    let ctx = this.shotShapes.get(id);
    if (!ctx) {
      ctx = projectileShape(id);
      this.shotShapes.set(id, ctx);
    }
    return ctx;
  }

  private sprite(i: number): Sprite {
    let s = this.sprites[i];
    if (!s) {
      s = new Sprite();
      // Anchored at the bottom-right corner of its tile, like MapView's sprites: a strip
      // bigger than a tile grows up and to the left.
      s.anchor.set(1, 1);
      this.spriteGroup.addChild(s);
      this.sprites.push(s);
    }
    s.visible = true;
    return s;
  }

  private shape(i: number, pool: Graphics[], group: Container, ctx: GraphicsContext): Graphics {
    let g = pool[i];
    if (!g) {
      g = new Graphics(ctx);
      group.addChild(g);
      pool.push(g);
    }
    g.context = ctx;
    g.visible = true;
    return g;
  }

  private takeText(f: FloatingTextState): Text {
    const fill = textColor(f.kind);
    const text = String(f.amount);
    const spare = this.spareTexts.pop();
    if (spare) {
      spare.text = text;
      spare.style.fill = fill;
      spare.visible = true;
      return spare;
    }
    const o = new Text({
      text,
      style: {
        fontFamily: "sans-serif",
        fontSize: 13,
        fontWeight: "bold",
        fill,
        stroke: { color: 0x000000, width: 3 },
      },
      anchor: { x: 0.5, y: 1 },
      roundPixels: true,
    });
    this.texts.addChild(o);
    return o;
  }

  /** Releases the floating numbers the last draw did not reach (the world dropped them). */
  private readonly sweep = (n: FloatingNumber, f: FloatingTextState): void => {
    if (n.seen === this.frame) return;
    n.obj.visible = false;
    this.spareTexts.push(n.obj);
    this.numbers.delete(f);
  };

  /** Draws everything the world keeps on `floor` (call after world.expire(now)). */
  draw(now: number, floor: number, cam: Camera, scale: number): void {
    this.frame++;
    const p = tilePixels(cam, this.tileSize);

    let sprites = 0;
    let shapes = 0;
    const effects = this.world.effects;
    for (let i = 0; i < effects.length; i++) {
      const e = effects[i];
      if (!e || e.pos.z !== floor) continue;
      const elapsed = now - e.start;
      const tex = this.framesOf(e.effectId);
      if (tex.length > 0) {
        const s = this.sprite(sprites++);
        s.texture = tex[effectFrame(elapsed, tex.length)] ?? s.texture;
        s.position.set(
          Math.round((e.pos.x + 1 - cam.x) * p),
          Math.round((e.pos.y + 1 - cam.y) * p),
        );
        s.scale.set(scale);
      } else {
        const g = this.shape(shapes++, this.shapeObjs, this.shapeGroup, this.shapeOf(e.effectId));
        g.position.set(Math.round((e.pos.x - cam.x) * p), Math.round((e.pos.y - cam.y) * p));
        g.scale.set(scale);
        g.alpha = 1 - Math.min(1, elapsed / EFFECT_MS) * 0.6;
      }
    }
    hideFrom(this.sprites, sprites);
    hideFrom(this.shapeObjs, shapes);

    let shots = 0;
    const projectiles = this.world.projectiles;
    for (let i = 0; i < projectiles.length; i++) {
      const pr = projectiles[i];
      if (!pr || pr.from.z !== floor) continue;
      const ctx = this.shotShapeOf(pr.projectileId);
      const g = this.shape(shots++, this.shotObjs, this.shotGroup, ctx);
      const k = Math.min(1, (now - pr.start) / PROJECTILE_MS);
      g.position.set(
        Math.round((pr.from.x + 0.5 + (pr.to.x - pr.from.x) * k - cam.x) * p),
        Math.round((pr.from.y + 0.5 + (pr.to.y - pr.from.y) * k - cam.y) * p),
      );
      g.scale.set(scale);
    }
    hideFrom(this.shotObjs, shots);

    const texts = this.world.floatingTexts;
    for (let i = 0; i < texts.length; i++) {
      const f = texts[i];
      if (!f || f.pos.z !== floor) continue;
      let n = this.numbers.get(f);
      if (!n) {
        n = { obj: this.takeText(f), seen: 0 };
        this.numbers.set(f, n);
      }
      n.seen = this.frame;
      const k = Math.min(1, (now - f.start) / FLOATING_TEXT_MS);
      n.obj.position.set(
        Math.round((f.pos.x + 0.5 - cam.x) * p),
        Math.round((f.pos.y + 0.6 - k * 0.9 - cam.y) * p),
      );
    }
    this.numbers.forEach(this.sweep);
  }

  destroy(): void {
    for (const o of [...this.sprites, ...this.shapeObjs, ...this.shotObjs]) o.destroy();
    for (const n of this.numbers.values()) n.obj.destroy();
    for (const o of this.spareTexts) o.destroy();
    for (const ctx of [...this.shapes.values(), ...this.shotShapes.values()]) ctx.destroy();
    this.spriteGroup.destroy();
    this.shapeGroup.destroy();
    this.shotGroup.destroy();
  }
}
