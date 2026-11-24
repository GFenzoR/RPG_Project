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
// the pool is big enough.
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
  /** A sprite `tex` standing with its bottom centre at (x, y), mirrored or squashed as drawn. */
  part(tex: Texture, x: number, y: number, scaleX: number, scaleY: number): void;
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

  part(tex: Texture, x: number, y: number, scaleX: number, scaleY: number): void {
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
    s.position.set(x, y);
    s.scale.set(scaleX, scaleY * this.scaleY);
    s.skew.x = this.skewX;
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
