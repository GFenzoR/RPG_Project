// The shadows lamps, torches and fires cast (owner, 2026-11-26: "inside a building the
// shadow must follow the building's own lighting or the nearest light, dynamically; without
// that nothing looks roofed"). Under a roof, underground and under the sky at night, a
// creature or a map object with height near a light casts a shadow away from it, blended
// between the two nearest lights (livingworld/client/src/light-shadows.ts has the math and
// data/livingworld/shadows.yaml `lights` the numbers; which items give light and how far is
// the `light` of their sprite, the same the light map glows with).
//
// Drawn like the sun's (render/cast-shadows.ts): pooled opaque dark sprites in one container
// faded through one AlphaFilter, a second CastShadows mounted on MapView.litOverlay, over the
// indoor floors (which hide the sun's shadows) and under the items. Each caster has its own
// direction and strength, so the creatures' are placed every frame (CastShadows.aim) and
// the objects' only when the map or the night changed.
import { Container, Sprite } from "pixi.js";
import { CAST_SHADOW_TINT } from "@rpg/renderer";
import {
  LIGHT_STRIDE,
  SIDE_BOTH,
  SIDE_IN,
  SIDE_OUT,
  lightBreath,
  lightCast,
} from "@rpg/living-world";
import type { LightCast, LightShadowRules } from "@rpg/living-world";
import { feetAnchor } from "./cast-shadows.ts";
import type { ObjectShadowHint, ShadowMap } from "./object-shadows.ts";

/** The numbers of the game data when a test has none. */
export { DEFAULT_LIGHT_SHADOWS } from "@rpg/living-world";

/** The map as the lights read it (packages/renderer MapView). */
export interface LightMap extends ShadowMap {
  forEachLight(fn: (x: number, y: number, radius: number) => void): void;
}

/** A light shadow weaker than this is not drawn. */
export const MIN_LIGHT_STRENGTH = 0.02;

/** The Pixi skew.x and scale.y that lay an upright sprite along `cast` (sky.ts shadowTransform). */
export function castTransform(cast: LightCast, out: { skewX: number; scaleY: number }): void {
  out.skewX = Math.atan2(-cast.x, cast.y);
  out.scaleY = Math.hypot(cast.x, cast.y);
}

/** The lights of the map in view, and the shadow they give a caster. */
export class LightField {
  private lights: number[] = [];
  private mapVersion = -1;
  private readonly cast: LightCast = { x: 0, y: 0, strength: 0 };
  /** The transform of the last shadow `at` answered. */
  readonly pose = { skewX: 0, scaleY: 0 };

  constructor(readonly rules: LightShadowRules) {}

  /**
   * The opacity of the lights' shadow layer at `now` ms: the data's, breathing with the
   * flames unless `still` ("Animaciones reducidas").
   */
  alpha(now: number, still: boolean): number {
    return this.rules.alpha * (still ? 1 : lightBreath(this.rules, now));
  }

  /** Lights known now (tests, the E2E hook). */
  get count(): number {
    return this.lights.length / LIGHT_STRIDE;
  }

  /**
   * Reads the lights again when the map changed. A light on a roofed tile lights the room;
   * one on a wall of a building (a torch: its tile is no floor) lights both sides of it.
   */
  sync(map: LightMap): void {
    if (map.version === this.mapVersion) return;
    this.mapVersion = map.version;
    const lights = this.lights;
    lights.length = 0;
    map.forEachLight((x, y, radius) => {
      const side = map.indoorAt(x, y)
        ? SIDE_IN
        : map.indoorAt(x - 1, y) ||
            map.indoorAt(x + 1, y) ||
            map.indoorAt(x, y - 1) ||
            map.indoorAt(x, y + 1)
          ? SIDE_BOTH
          : SIDE_OUT;
      lights.push(x, y, radius, side);
    });
  }

  /**
   * How strong the lights' shadow of a caster at (x, y), tiles, is: 0 for none, else up to 1
   * with its transform in `pose`. `indoor`: it stands under a roof; `open`: how much the
   * lights show under the open sky (0 by day, 1 at night and underground).
   */
  at(x: number, y: number, indoor: boolean, open: number): number {
    const k = indoor ? 1 : open;
    if (!(k > 0)) return 0;
    if (!lightCast(this.rules, this.lights, x, y, indoor ? SIDE_IN : SIDE_OUT, this.cast)) return 0;
    const strength = this.cast.strength * k;
    if (strength < MIN_LIGHT_STRENGTH) return 0;
    castTransform(this.cast, this.pose);
    return strength;
  }
}

/** `open` moves this much before the objects' shadows are placed again. */
const OPEN_STEPS = 16;
/** A shadow shorter than this share of its caster is not drawn (right under the light). */
const MIN_LENGTH = 0.03;

/**
 * The light shadows of the map's objects (silhouettes only: a wall casts none indoors, it
 * would cover the room). Rebuilt from the pool when the map or the night changed; a frame
 * in between touches nothing.
 */
export class LitObjectShadows {
  /** Mounted in the lights' shadow layer (CastShadows.mount), under the creatures'. */
  readonly root = new Container({ label: "lit object shadows", visible: false });
  private readonly pool: Sprite[] = [];
  private used = 0;
  private mapVersion = -1;
  private open = -1;
  /** Sprites made since the layer was created, and how many times it was rebuilt (tests). */
  made = 0;
  placed = 0;

  constructor(private readonly hintOf: (key: string) => ObjectShadowHint | undefined) {}

  /** Shadows drawn now. */
  get count(): number {
    return this.root.visible ? this.used : 0;
  }

  /** A frame: `field` undefined hides them all. */
  update(map: ShadowMap, field: LightField | undefined, open: number): void {
    if (!field) {
      this.root.visible = false;
      return;
    }
    const step = Math.round(Math.min(1, Math.max(0, open)) * OPEN_STEPS);
    if (map.version !== this.mapVersion || step !== this.open) {
      this.mapVersion = map.version;
      this.open = step;
      this.place(map, field, step / OPEN_STEPS);
    }
    this.root.visible = this.used > 0;
  }

  private place(map: ShadowMap, field: LightField, open: number): void {
    this.placed++;
    this.used = 0;
    map.forEachItemSprite((x, y, key, item) => {
      const hint = this.hintOf(key);
      if (!hint || hint.cast !== "silhouette") return;
      const strength = field.at(x, y, map.indoorAt(x, y), open);
      const length = field.pose.scaleY * hint.length;
      if (strength <= 0 || length < MIN_LENGTH) return;
      const tex = item.texture;
      let s = this.pool[this.used];
      if (!s) {
        s = new Sprite({ texture: tex, tint: CAST_SHADOW_TINT });
        this.made++;
        this.pool.push(s);
        this.root.addChild(s);
      } else if (s.texture !== tex) s.texture = tex;
      this.used++;
      const foot = Math.min(hint.foot, Math.max(0, tex.height - 1));
      s.visible = true;
      s.alpha = strength;
      s.anchor.set(item.anchor.x, feetAnchor(foot, tex.height));
      s.position.set(item.x, item.y - foot);
      s.skew.x = field.pose.skewX;
      s.scale.set(1, length);
    });
    for (let i = this.used; i < this.pool.length; i++) (this.pool[i] as Sprite).visible = false;
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.pool.length = 0;
  }
}
