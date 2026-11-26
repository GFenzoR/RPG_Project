// Cast shadows of creatures (owner, 2026-11-23: "characters still look like they float"):
// every creature on the own floor casts a shadow of its own current drawing (each paper
// doll layer: body, outfit and equipment, in the frame it is in) laid on the ground from
// its feet toward where the sun or the moon sends it (livingworld/client/src/sky.ts,
// through render/sky.ts): long to the west in the morning, short under the feet at noon,
// long to the east in the afternoon, faint under the moon. It starts on the line the
// creature stands on (the atlas's `stance` of its facing), so the feet touch it; the small
// contact ellipse (creature-body.ts) is for where there is no cast shadow at all
// (underground, indoors, a moonless night): the two are never drawn together (owner,
// 2026-11-25: "the round shadow under the character ruins the new one").
//
// One container over the grounds (MapView.groundOverlay, world space) under the items and
// the creatures. Its sprites are opaque and dark, and the container fades as a whole
// through one AlphaFilter: a doll's overlapping layers and two shadows crossing make one
// even shade, never a darker patch. Cheap (docs/07): a pooled sprite per layer of each
// creature in view, sharing the creature's own textures; nothing is made per frame once
// the pool is big enough. Placing a crowd's 540 is ~0.035 ms of JS a frame (docs/07). The
// shadows of the map's objects (render/object-shadows.ts) are mounted in this same
// container, under the creatures', and share its one filter pass.
import { AlphaFilter, Container, Sprite } from "pixi.js";
import type { Texture } from "pixi.js";
import { CAST_SHADOW_TINT, MISSING_TEXTURE } from "@rpg/renderer";

/** The ground transform of the shadows this frame (render/sky.ts shadowOf). */
export interface ShadowPose {
  /** Pixi skew.x and scale.y that lay an upright sprite on the ground (sky.ts shadowTransform). */
  skewX: number;
  scaleY: number;
  /** Opacity of the whole layer (0: no cast shadows). */
  alpha: number;
  /**
   * The same transform as a vector: where the tip of a caster one px high lands, px east
   * (+) or west (-) and px north of its base (sky.ts ShadowCast). The walls' box shadows
   * are built from it (render/object-shadows.ts).
   */
  x: number;
  y: number;
}

/** A pose from its transform alone (tests, callers that only lay sprites down). */
export function poseOf(skewX: number, scaleY: number, alpha: number): ShadowPose {
  return { skewX, scaleY, alpha, x: -Math.sin(skewX) * scaleY, y: Math.cos(skewX) * scaleY };
}

/** The layer's opacity under which a cast shadow is too faint to stand on. */
export const CONTACT_GONE = 0.06;

/**
 * How much of its contact ellipse a creature shows (creature-body.ts): none while it casts
 * a shadow, all of it without one, and a short crossfade while the cast shadow is fainter
 * than CONTACT_GONE (the sun rising, a thin moon), so nothing pops.
 */
export function contactShare(castAlpha: number): number {
  if (!(castAlpha > 0)) return 1;
  return castAlpha >= CONTACT_GONE ? 0 : 1 - castAlpha / CONTACT_GONE;
}

/** What a creature body hands its shadow: one call per drawn layer. */
export interface ShadowSink {
  /**
   * A sprite `tex` standing with its feet at (x, y), mirrored or squashed as drawn. `foot`:
   * the empty rows under the feet in the texture (the atlas clip's `foot`), so the shadow
   * turns around the feet and not around the texture's bottom edge. `skewX`: the lean the
   * body is drawn with (Pose.skewX), so body and shadow lean together.
   */
  part(
    tex: Texture,
    x: number,
    y: number,
    scaleX: number,
    scaleY: number,
    foot?: number,
    skewX?: number,
  ): void;
}

/**
 * The anchor.y that puts a sprite's pivot on its feet line: `foot` rows above the bottom
 * of a texture `height` tall (1: the bottom edge).
 */
export function feetAnchor(foot: number, height: number): number {
  if (!(height > 0) || !(foot > 0)) return 1;
  return 1 - Math.min(foot, height) / height;
}

/**
 * One Pixi skew.x and scale.y equal to a sprite drawn with (`bodySkew`, `bodyScaleY`) and
 * then laid on the ground with (`sunSkew`, `sunScaleY`), written into `out`.
 */
export function leanOnGround(
  bodySkew: number,
  bodyScaleY: number,
  sunSkew: number,
  sunScaleY: number,
  out: { skewX: number; scaleY: number },
): void {
  if (bodySkew === 0) {
    out.skewX = sunSkew;
    out.scaleY = bodyScaleY * sunScaleY;
    return;
  }
  // A sprite's y axis is (sin skew, cos skew) * scale.y (Pixi); compose the two.
  const up = Math.cos(bodySkew) * bodyScaleY;
  const c = Math.sin(bodySkew) * bodyScaleY + Math.sin(sunSkew) * sunScaleY * up;
  const d = Math.cos(sunSkew) * sunScaleY * up;
  const sign = d < 0 ? -1 : 1;
  out.skewX = Math.atan2(c * sign, d * sign);
  out.scaleY = Math.hypot(c, d) * sign;
}

/** The filter the layer fades through (a test passes one that needs no WebGL). */
export const newShadowFade = (): AlphaFilter =>
  new AlphaFilter({ alpha: 1, resolution: "inherit" });

export class CastShadows implements ShadowSink {
  readonly root = new Container({ label: "creature shadows", visible: false });
  private readonly pool: Sprite[] = [];
  private used = 0;
  private skewX = 0;
  private scaleY = 0;
  private readonly fade: AlphaFilter;
  private readonly lean = { skewX: 0, scaleY: 0 };
  /** Sprites made since the layer was created (a test reads it). */
  made = 0;
  /** The map objects' shadows, when mounted: the layer shows while they do. */
  private objects: Container | undefined;

  constructor(makeFade: () => AlphaFilter = newShadowFade) {
    this.fade = makeFade();
    this.root.filters = [this.fade];
  }

  /**
   * Mounts the shadows of the map's objects under the creatures': same container, same
   * fade, so shadows that cross make one shade.
   */
  mount(objects: Container): void {
    this.objects = objects;
    this.root.addChildAt(objects, 0);
  }

  /** Starts a frame with `pose`; false when there is nothing to cast (the layer hides). */
  begin(pose: ShadowPose | undefined): boolean {
    this.used = 0;
    if (!pose || pose.alpha <= 0.005) {
      this.hide();
      return false;
    }
    this.skewX = pose.skewX;
    this.scaleY = pose.scaleY;
    this.fade.alpha = pose.alpha;
    return true;
  }

  part(
    tex: Texture,
    x: number,
    y: number,
    scaleX: number,
    scaleY: number,
    foot = 0,
    skewX = 0,
  ): void {
    let s = this.pool[this.used];
    if (!s) {
      s = new Sprite({
        texture: MISSING_TEXTURE,
        anchor: { x: 0.5, y: 1 },
        tint: CAST_SHADOW_TINT,
      });
      this.made++;
      this.pool.push(s);
      this.root.addChild(s);
    }
    this.used++;
    if (s.texture !== tex) s.texture = tex;
    s.visible = true;
    const anchorY = feetAnchor(foot, tex.height);
    if (s.anchor.y !== anchorY) s.anchor.y = anchorY;
    s.position.set(x, y);
    leanOnGround(skewX, scaleY, this.skewX, this.scaleY, this.lean);
    s.scale.set(scaleX, this.lean.scaleY);
    s.skew.x = this.lean.skewX;
  }

  /** Hides the sprites this frame did not use and shows the layer. */
  end(): void {
    for (let i = this.used; i < this.pool.length; i++) (this.pool[i] as Sprite).visible = false;
    const objects = this.objects;
    this.root.visible = this.used > 0 || (objects?.visible === true && objects.children.length > 0);
  }

  /** Sprites drawn in the last frame (tests, perf). */
  get count(): number {
    return this.used;
  }

  hide(): void {
    this.root.visible = false;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.fade.destroy();
  }
}
