// The drawn body of a creature (docs/17 ANI): its contact shadow (ART-5, for sprites that
// do not paint one) and its sprite, which follows a Pose from packages/renderer anim.ts
// every frame: clip frame, offset, squash, lean, mirror, fade and hit flash. Placed in the
// creature's container, whose origin is the top-left of its tile (sprite pixels). Sprites
// sit with their bottom-centre on their anchor point: br sprites keep the bottom-right
// corner on the tile's (as MapView does), bc sprites stand with their feet FEET_LINE px
// above the tile's bottom edge. Updating allocates nothing.
//
// An engine humanoid (docs/17 "Humanoides del motor") is a paper doll: one sprite per layer
// (body, legs, feet, torso, hair, beard, head piece, shield, weapon), each with its own
// clips and tint, all in the same pose and frame, stacked in packages/renderer look.ts
// LAYER_ORDER for the facing (re-stacked only when the facing changes). Its sprites come
// from a shared pool and go back to it with release(): a creature that leaves the view
// gives them to the next one. They sit in one container that fades as a whole: Pixi
// multiplies a container's alpha into each child, so a doll fading in, falling or drawn
// see-through would show the skin through the tunic and the sword through the body; while
// it is not opaque, the container draws through one AlphaFilter instead.
import { AlphaFilter, Container, Graphics, GraphicsContext, Sprite } from "pixi.js";
import type { Texture } from "pixi.js";
import {
  ANIM_DIRS,
  FEET_LINE,
  LAYER_ORDER,
  MISSING_TEXTURE,
  SHADOW_ALPHA,
  SHADOW_H,
  SHADOW_W,
  actionDir,
} from "@rpg/renderer";
import type { AnimDir, LayerSlot, Pose } from "@rpg/renderer";
import type { ShadowSink } from "./cast-shadows.ts";
import { clipTexture, dirIndex, headLift } from "./clips.ts";
import type { ClipSet } from "./clips.ts";

/** Tint of a hit flash (multiplied: the sprite turns red for HIT_FLASH_MS). */
export const FLASH_TINT = 0xff6a6a;
/** Tint of a creature leaving by a teleport or a logout (VANISH_MS): a pale blue. */
export const SHIMMER_TINT = 0xa8d0ff;

let shadowContext: GraphicsContext | undefined;
/** One ellipse shared by every contact shadow. */
const shadowShape = (): GraphicsContext =>
  (shadowContext ??= new GraphicsContext()
    .ellipse(0, 0, SHADOW_W / 2, SHADOW_H / 2)
    .fill({ color: 0x000000, alpha: SHADOW_ALPHA }));

/** One layer of a paper doll: its slot, its clips and its tint (0xrrggbb, a multiply). */
export interface BodyLayer {
  slot: LayerSlot;
  clips: ClipSet<Texture>;
  tint: number;
}

/**
 * Sprites of paper-doll layers, shared by every creature: a body takes what it needs and
 * gives it back when it leaves (docs/07: walking into a crowd reuses sprites).
 */
export class SpritePool {
  private readonly free: Sprite[] = [];
  /** Sprites made since the pool was created (a test reads it). */
  made = 0;

  take(): Sprite {
    const s = this.free.pop();
    if (s) return s;
    this.made++;
    return new Sprite({ texture: MISSING_TEXTURE, anchor: { x: 0.5, y: 1 }, roundPixels: true });
  }

  give(s: Sprite): void {
    s.removeFromParent();
    s.visible = true;
    s.alpha = 1;
    s.tint = 0xffffff;
    s.scale.set(1);
    s.skew.set(0);
    this.free.push(s);
  }

  get size(): number {
    return this.free.length;
  }
}

/** The pool the game's bodies share. */
export const LAYER_POOL = new SpritePool();

/**
 * The filter a paper doll fades through (a test passes one that needs no WebGL), at the
 * canvas's own resolution: the pixels come back as they were, only fainter.
 */
export const newFade = (): AlphaFilter => new AlphaFilter({ alpha: 1, resolution: "inherit" });

export class CreatureBody {
  readonly root = new Container({ label: "body" });
  /** The body's sprite (a paper doll's body layer): silhouettes and the behind-wall copy. */
  readonly sprite: Sprite;
  /** How far the drawing rises above the tile (labels go over it), sprite pixels. */
  readonly lift: number;
  private readonly shadow: Graphics | undefined;
  private readonly baseX: number;
  private readonly baseY: number;
  /** Empty rows under the feet in the textures (bc sprites): the cast shadow turns there. */
  private readonly foot: number;
  private tint: number;
  /** Paper doll: one sprite per layer, in `layers` order; empty for a one-sprite body. */
  private readonly sprites: Sprite[] = [];
  private readonly layers: readonly BodyLayer[];
  /** Per facing (ANIM_DIRS order), the layer indices back to front. */
  private readonly orders: number[][];
  private stacked: AnimDir | undefined;
  private readonly pool: SpritePool | undefined;
  /** A paper doll's layers, faded as one figure (`fade`, while not opaque). */
  private readonly doll: Container | undefined;
  private fade: AlphaFilter | undefined;
  private faded = false;
  /** The alpha it was last drawn with (the pose's times `opacity`). */
  private drawnAlpha = 1;
  /** The pose's sideways offset last drawn (a lunge): the cast shadow follows the feet. */
  private drawnX = 0;
  /**
   * Multiplies the pose's alpha: the own player drawn see-through while invisible (T3.2).
   * The caller sets it instead of its container's alpha, which would fade layer by layer.
   */
  opacity = 1;

  /**
   * `clips` places the drawing (anchor, feet, height): for a paper doll, the body layer's.
   * `layers`: the paper doll's layers (empty: `clips` is the one sprite). `makeFade` makes the
   * filter it fades through, the first time it is not opaque.
   */
  constructor(
    readonly clips: ClipSet<Texture>,
    tile: number,
    tint = 0xffffff,
    layers: readonly BodyLayer[] = [],
    pool: SpritePool = LAYER_POOL,
    private readonly makeFade: () => AlphaFilter = newFade,
  ) {
    const meta = clips.meta;
    const first = clipTexture(clips, "idle", 2, 0);
    const w = meta?.w ?? first?.width ?? tile;
    const h = meta?.h ?? first?.height ?? tile;
    const bc = meta?.anchor === "bc";
    this.baseX = bc ? tile / 2 : tile - w / 2;
    this.foot = bc ? (meta?.foot ?? 0) : 0;
    this.baseY = bc ? tile - FEET_LINE + this.foot : tile;
    this.lift = headLift(meta, { w, h }, tile, FEET_LINE);
    if (meta?.shadow === "ellipse") {
      this.shadow = new Graphics(shadowShape());
      this.shadow.position.set(tile / 2, tile - FEET_LINE);
      this.root.addChild(this.shadow);
    }
    this.tint = tint;
    this.layers = layers;
    this.orders = ANIM_DIRS.map((d) => layerOrder(layers, d));
    if (layers.length > 0) {
      this.pool = pool;
      const doll = new Container({ label: "layers" });
      this.doll = doll;
      this.root.addChild(doll);
      for (const l of layers) {
        const s = pool.take();
        s.texture = clipTexture(l.clips, "idle", 2, 0) ?? MISSING_TEXTURE;
        s.position.set(this.baseX, this.baseY);
        s.tint = l.tint;
        this.sprites.push(s);
        doll.addChild(s);
      }
      const body = layers.findIndex((l) => l.slot === "body");
      this.sprite = this.sprites[Math.max(0, body)] ?? pool.take();
      this.restack("s");
    } else {
      this.sprite = new Sprite({
        texture: first ?? MISSING_TEXTURE,
        anchor: { x: 0.5, y: 1 },
        roundPixels: true,
      });
      this.sprite.position.set(this.baseX, this.baseY);
      this.sprite.tint = tint;
      this.root.addChild(this.sprite);
    }
  }

  /** The cosmetic tint (T5.7) the sprite goes back to after a flash. */
  setTint(tint: number): void {
    this.tint = tint;
  }

  /** The layers' sprites back to the pool (before the root is destroyed). */
  release(): void {
    if (!this.pool) return;
    for (const s of this.sprites) this.pool.give(s);
    this.sprites.length = 0;
    if (this.doll && this.faded) this.doll.filters = [];
    this.faded = false;
    this.fade?.destroy();
    this.fade = undefined;
  }

  /** Re-stacks the layers for `d` (in their own container: the shadow stays under them). */
  private restack(d: AnimDir): void {
    const doll = this.doll;
    if (!doll) return;
    const order = this.orders[dirIndex(d)] ?? [];
    order.forEach((i, k) => {
      const s = this.sprites[i];
      if (s && s.parent === doll) doll.setChildIndex(s, k);
    });
    this.stacked = d;
  }

  /** The alpha the body was last drawn with: its see-through copies follow it. */
  get alpha(): number {
    return this.drawnAlpha;
  }

  /** A paper doll's layers as one figure: opaque, or through the fade at `alpha`. */
  private fadeLayers(alpha: number): void {
    const doll = this.doll;
    if (!doll) return;
    if (alpha >= 1) {
      if (this.faded) doll.filters = [];
      this.faded = false;
      return;
    }
    const fade = (this.fade ??= this.makeFade());
    fade.alpha = alpha;
    if (!this.faded) doll.filters = [fade];
    this.faded = true;
  }

  /** Draws `pose` facing `dir` (index in ANIM_DIRS). */
  draw(pose: Pose, dir: number): void {
    const alpha = pose.alpha * this.opacity;
    this.drawnAlpha = alpha;
    this.drawnX = pose.x;
    if (this.sprites.length > 0) {
      this.drawLayers(pose, dir);
      this.fadeLayers(alpha);
    } else {
      const sp = this.sprite;
      const tex = clipTexture(this.clips, pose.action, dir, pose.frame);
      if (tex && sp.texture !== tex) sp.texture = tex;
      this.place(sp, pose, this.tint, alpha);
    }
    if (this.shadow) {
      this.shadow.scale.set(pose.shadow * Math.abs(pose.scaleX));
      this.shadow.alpha = alpha;
    }
  }

  /**
   * Hands `into` the drawing as it was last drawn, for its cast shadow (render/cast-shadows.ts):
   * every visible layer's texture with its mirror, squash and lean, standing at the feet (the
   * feet line, `foot` rows above the texture's bottom edge). `x`, `y` is the body's
   * container position (world pixels). The shadow stays on the ground under a
   * hop (the pose's lift is left out); a body fading away below half casts none.
   */
  castShadow(into: ShadowSink, x: number, y: number): void {
    if (this.drawnAlpha < 0.5) return;
    const fx = x + this.baseX + this.drawnX;
    const foot = this.foot;
    const fy = y + this.baseY - foot;
    if (this.sprites.length > 0) {
      for (const sp of this.sprites)
        if (sp.visible) into.part(sp.texture, fx, fy, sp.scale.x, sp.scale.y, foot, sp.skew.x);
    } else {
      const sp = this.sprite;
      into.part(sp.texture, fx, fy, sp.scale.x, sp.scale.y, foot, sp.skew.x);
    }
  }

  private drawLayers(pose: Pose, dir: number): void {
    const facing = actionDir(pose.action, ANIM_DIRS[dir] ?? "s");
    if (facing !== this.stacked) this.restack(facing);
    for (let i = 0; i < this.sprites.length; i++) {
      const sp = this.sprites[i] as Sprite;
      const layer = this.layers[i] as BodyLayer;
      const tex = clipTexture(layer.clips, pose.action, dir, pose.frame);
      if (tex && sp.texture !== tex) sp.texture = tex;
      // Opaque: the layers' container fades them as one (fadeLayers).
      this.place(sp, pose, layer.tint, 1);
    }
  }

  private place(sp: Sprite, pose: Pose, tint: number, alpha: number): void {
    sp.position.set(this.baseX + pose.x, this.baseY + pose.y);
    sp.scale.set(pose.scaleX, pose.scaleY);
    sp.skew.x = pose.skewX;
    sp.alpha = alpha;
    sp.tint = pose.flash ? FLASH_TINT : pose.shimmer ? SHIMMER_TINT : tint;
  }
}

/** The indices of `layers` back to front facing `d` (LAYER_ORDER; unknown slots last). */
export function layerOrder(layers: readonly BodyLayer[], d: AnimDir): number[] {
  const rank = LAYER_ORDER[d];
  return layers
    .map((l, i) => ({ i, r: rank.indexOf(l.slot) }))
    .sort((a, b) => (a.r < 0 ? 99 : a.r) - (b.r < 0 ? 99 : b.r) || a.i - b.i)
    .map((x) => x.i);
}
