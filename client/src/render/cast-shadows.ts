// Cast shadows of creatures (owner, 2026-11-23: "characters still look like they float"):
// every creature on the own floor casts a shadow of its own current drawing (each paper
// doll layer: body, outfit and equipment, in the frame it is in) laid on the ground from
// its feet toward where the sun or the moon sends it (livingworld/client/src/sky.ts,
// through render/sky.ts): long to the west in the morning, short under the feet at noon,
// long to the east in the afternoon, faint under the moon. Its small contact ellipse
// (creature-body.ts) stays on at all times, so feet never float.
//
// One container over the grounds (MapView.groundOverlay, world space) under the items and
// the creatures. Its sprites are opaque and dark, and the container fades as a whole
// through one AlphaFilter: a doll's overlapping layers and two shadows crossing make one
// even shade, never a darker patch. Cheap (docs/07): a pooled sprite per layer of each
// creature in view, sharing the creature's own textures; nothing is made per frame once
// the pool is big enough. Placing a crowd's 540 is ~0.035 ms of JS a frame (docs/07); the
// filter pass and the frame time in a browser are not measured yet (docs/14).
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

  constructor(makeFade: () => AlphaFilter = newShadowFade) {
    this.fade = makeFade();
    this.root.filters = [this.fade];
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
    this.root.visible = this.used > 0;
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
