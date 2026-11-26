// The drawn body of a creature (docs/17 ANI): its contact shadow (ART-5, for sprites that
// do not paint one; only while it casts no shadow under the sun or the moon, `contact`: the
// two are never drawn together) and its sprite, which follows a Pose from packages/renderer anim.ts
// every frame: clip frame, offset, squash, lean, mirror, fade and hit flash. Placed in the
// creature's container, whose origin is the top-left of its tile (sprite pixels). Sprites
// sit with their bottom-centre on their anchor point: br sprites keep the bottom-right
// corner on the tile's (as MapView does), bc sprites stand with their feet FEET_LINE px
// above the tile's bottom edge. Updating allocates nothing.
//
// Where it stands (owner, 2026-11-25: "the round shadow is far from the character, it seems
// to float"): `foot` of atlas.json is the lowest reach of the walk, and a person's foot
// stepping toward the viewer goes 3 to 5 px lower than the body stands. Both shadows start
// on the stance of the facing drawn instead (AnimMeta.stance: the standing pose's own
// lowest row and the span of the feet), so the ellipse sits under the feet of a rat and of
// a warden alike, and the cast shadow leaves from the soles.
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
  stanceOf,
} from "@rpg/renderer";
import type { AnimDir, AnimMeta, LayerSlot, Pose } from "@rpg/renderer";
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

/** A body drawn fainter than this casts no shadow and stands on its contact ellipse. */
export const CAST_MIN_ALPHA = 0.5;
/** The contact ellipse is this much wider than the span of the feet, sprite px. */
export const CONTACT_MARGIN = 8;
/** Its width never goes under or over these, sprite px (a rat, a warden). */
export const CONTACT_MIN_W = 12;
export const CONTACT_MAX_W = 56;
/** Its height for its width: flat on the ground in the 3/4 view. */
export const CONTACT_FLAT = 0.3;

/** Where a body stands facing one way: sprite px. */
export interface Footing {
  /** Transparent rows under the standing pose, from the frame's bottom edge. */
  foot: number;
  /** The middle of what touches the ground, from the frame's middle (east is +). */
  cx: number;
  /** How wide that is. */
  width: number;
}

/**
 * The footing of each facing (ANIM_DIRS order) of a body drawn with `metas` (one sprite's,
 * or a paper doll's body and footwear: the lowest of them stands on the ground). An atlas
 * without stances gives `foot` for every facing and the default ellipse.
 */
export function footings(metas: readonly (AnimMeta | undefined)[], foot: number): Footing[] {
  return ANIM_DIRS.map((dir) => {
    let low = Infinity;
    let x0 = Infinity;
    let x1 = -Infinity;
    let w = 0;
    for (const meta of metas) {
      const st = stanceOf(meta, dir);
      if (!st || !meta) continue;
      low = Math.min(low, st[0]);
      x0 = Math.min(x0, st[1]);
      x1 = Math.max(x1, st[2]);
      w = meta.w;
    }
    if (low === Infinity) return { foot, cx: 0, width: SHADOW_W - CONTACT_MARGIN };
    return { foot: low, cx: (x0 + x1) / 2 - w / 2, width: x1 - x0 };
  });
}

/** The contact ellipse's width under feet `span` px apart, sprite px. */
export const contactWidth = (span: number): number =>
  Math.min(CONTACT_MAX_W, Math.max(CONTACT_MIN_W, span + CONTACT_MARGIN));

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
  /**
   * Drawn in eight facings (docs/17 ANI-1): its clips, and every layer of a paper doll,
   * have the diagonals. One layer without them turns the whole figure four ways: a doll
   * never mixes a diagonal body with a straight cloak.
   */
  readonly eight: boolean;
  private readonly shadow: Graphics | undefined;
  private readonly baseX: number;
  private readonly baseY: number;
  /**
   * Where its feet are on its tile (sprite pixels from the tile's top-left): the middle of
   * the drawing across, the lowest row of its walk frames down. The living world drops
   * the footprints from there (render/living.ts).
   */
  readonly feetX: number;
  readonly feetY: number;
  /** Where it stands facing each way (ANIM_DIRS order): both shadows start there. */
  private readonly footing: Footing[];
  /** The facing last drawn (index in ANIM_DIRS). */
  private drawnDir = 2;
  /** The mirror last drawn (a single drawing looking the other way): -1 or 1. */
  private drawnFlip = 1;
  /**
   * How much of the contact ellipse shows, 0 to 1 (cast-shadows.ts contactShare): 0 while
   * the creature casts a shadow under the sun or the moon. The canvas sets it every frame
   * before draw(); 1 for a body drawn outside the map (no sun there).
   */
  contact = 1;
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
    const foot = bc ? (meta?.foot ?? 0) : 0;
    this.baseY = bc ? tile - FEET_LINE + foot : tile;
    this.feetX = this.baseX;
    this.feetY = this.baseY - foot;
    // A paper doll stands on its body and on what it wears on its feet (a boot's sole);
    // a sword's tip or a cloak's hem are not on the ground.
    const standing = layers.filter((l) => l.slot === "body" || l.slot === "feet");
    this.footing = footings(
      standing.length > 0 ? standing.map((l) => l.clips.meta) : [meta],
      meta?.foot ?? 0,
    );
    this.lift = headLift(meta, { w, h }, tile, FEET_LINE);
    if (meta?.shadow === "ellipse") {
      this.shadow = new Graphics(shadowShape());
      this.root.addChild(this.shadow);
      this.placeContact(0, 1);
    }
    this.tint = tint;
    this.layers = layers;
    this.eight = clips.eight && layers.every((l) => l.clips.eight);
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

  /** The alpha the body was last drawn with. */
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

  /** Where it stands facing `dir` (index in ANIM_DIRS): the south's for an unknown one. */
  footingOf(dir: number): Footing {
    return (this.footing[dir] ?? this.footing[2]) as Footing;
  }

  /** The row its feet stand on facing `dir`, sprite px from its tile's top edge. */
  groundY(dir: number): number {
    return this.baseY - this.footingOf(dir).foot;
  }

  /** Where its feet stand now (the facing drawn): its container's px, and how wide. */
  stand(): { x: number; y: number; width: number } {
    const f = this.footingOf(this.drawnDir);
    return { x: this.baseX + f.cx * this.drawnFlip, y: this.baseY - f.foot, width: f.width };
  }

  /** The contact ellipse under the feet of the facing drawn, as wide as they stand. */
  private placeContact(poseX: number, k: number): void {
    const sh = this.shadow;
    if (!sh) return;
    const f = this.footingOf(this.drawnDir);
    const w = contactWidth(f.width);
    sh.position.set(this.baseX + f.cx * this.drawnFlip + poseX, this.baseY - f.foot);
    sh.scale.set(
      (w / SHADOW_W) * k,
      (Math.max(SHADOW_H, Math.round(w * CONTACT_FLAT)) / SHADOW_H) * k,
    );
  }

  /** Draws `pose` facing `dir` (index in ANIM_DIRS). */
  draw(pose: Pose, dir: number): void {
    const alpha = pose.alpha * this.opacity;
    this.drawnAlpha = alpha;
    this.drawnX = pose.x;
    this.drawnDir = dir;
    this.drawnFlip = pose.scaleX < 0 ? -1 : 1;
    if (this.sprites.length > 0) {
      this.drawLayers(pose, dir);
      this.fadeLayers(alpha);
    } else {
      const sp = this.sprite;
      const tex = clipTexture(this.clips, pose.action, dir, pose.frame);
      if (tex && sp.texture !== tex) sp.texture = tex;
      this.place(sp, pose, this.tint, alpha);
    }
    const sh = this.shadow;
    if (sh) {
      // Never with a cast shadow (contact 0): nothing is even drawn then. A body under
      // half opacity casts none (castShadow), so it keeps its ellipse.
      const contact = alpha < CAST_MIN_ALPHA ? 1 : this.contact;
      const show = contact > 0;
      if (sh.visible !== show) sh.visible = show;
      if (show) {
        this.placeContact(pose.x, pose.shadow * Math.abs(pose.scaleX));
        sh.alpha = alpha * contact;
      }
    }
  }

  /** Whether the contact ellipse is drawn now (tests, the E2E hook). */
  get contactShown(): boolean {
    return this.shadow?.visible === true && this.shadow.alpha > 0;
  }

  /**
   * Hands `into` the drawing as it was last drawn, for its cast shadow (render/cast-shadows.ts):
   * every visible layer's texture with its mirror, squash and lean, standing where the
   * facing drawn stands (its stance, `foot` rows above the texture's bottom edge: the shadow
   * leaves from the soles, with no gap). `x`, `y` is the body's
   * container position (world pixels). The shadow stays on the ground under a
   * hop (the pose's lift is left out); a body fading away below half casts none.
   */
  castShadow(into: ShadowSink, x: number, y: number): void {
    if (this.drawnAlpha < CAST_MIN_ALPHA) return;
    const fx = x + this.baseX + this.drawnX;
    const foot = this.footingOf(this.drawnDir).foot;
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
