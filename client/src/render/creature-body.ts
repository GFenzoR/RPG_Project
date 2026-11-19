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
// gives them to the next one.
import { Container, Graphics, GraphicsContext, Sprite } from "pixi.js";
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

export class CreatureBody {
  readonly root = new Container({ label: "body" });
  /** The body's sprite (a paper doll's body layer): silhouettes and the behind-wall copy. */
  readonly sprite: Sprite;
  /** How far the drawing rises above the tile (labels go over it), sprite pixels. */
  readonly lift: number;
  private readonly shadow: Graphics | undefined;
  private readonly baseX: number;
  private readonly baseY: number;
  private tint: number;
  /** Paper doll: one sprite per layer, in `layers` order; empty for a one-sprite body. */
  private readonly sprites: Sprite[] = [];
  private readonly layers: readonly BodyLayer[];
  /** Per facing (ANIM_DIRS order), the layer indices back to front. */
  private readonly orders: number[][];
  private stacked: AnimDir | undefined;
  private readonly pool: SpritePool | undefined;

  /**
   * `clips` places the drawing (anchor, feet, height): for a paper doll, the body layer's.
   * `layers`: the paper doll's layers (empty: `clips` is the one sprite).
   */
  constructor(
    readonly clips: ClipSet<Texture>,
    tile: number,
    tint = 0xffffff,
    layers: readonly BodyLayer[] = [],
    pool: SpritePool = LAYER_POOL,
  ) {
    const meta = clips.meta;
    const first = clipTexture(clips, "idle", 2, 0);
    const w = meta?.w ?? first?.width ?? tile;
    const h = meta?.h ?? first?.height ?? tile;
    const bc = meta?.anchor === "bc";
    this.baseX = bc ? tile / 2 : tile - w / 2;
    this.baseY = bc ? tile - FEET_LINE + (meta?.foot ?? 0) : tile;
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
      for (const l of layers) {
        const s = pool.take();
        s.texture = clipTexture(l.clips, "idle", 2, 0) ?? MISSING_TEXTURE;
        s.position.set(this.baseX, this.baseY);
        s.tint = l.tint;
        this.sprites.push(s);
        this.root.addChild(s);
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
  }

  /** Re-stacks the layers for `d`: the shadow stays under them. */
  private restack(d: AnimDir): void {
    const order = this.orders[dirIndex(d)] ?? [];
    const base = this.shadow ? 1 : 0;
    order.forEach((i, k) => {
      const s = this.sprites[i];
      if (s && s.parent === this.root) this.root.setChildIndex(s, base + k);
    });
    this.stacked = d;
  }

  /** Draws `pose` facing `dir` (index in ANIM_DIRS). */
  draw(pose: Pose, dir: number): void {
    if (this.sprites.length > 0) {
      this.drawLayers(pose, dir);
    } else {
      const sp = this.sprite;
      const tex = clipTexture(this.clips, pose.action, dir, pose.frame);
      if (tex && sp.texture !== tex) sp.texture = tex;
      this.place(sp, pose, this.tint);
    }
    if (this.shadow) {
      this.shadow.scale.set(pose.shadow * Math.abs(pose.scaleX));
      this.shadow.alpha = pose.alpha;
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
      this.place(sp, pose, layer.tint);
    }
  }

  private place(sp: Sprite, pose: Pose, tint: number): void {
    sp.position.set(this.baseX + pose.x, this.baseY + pose.y);
    sp.scale.set(pose.scaleX, pose.scaleY);
    sp.skew.x = pose.skewX;
    sp.alpha = pose.alpha;
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
