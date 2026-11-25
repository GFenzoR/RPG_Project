// Light in caves (docs/17 ART-7) and on the surface by night (livingworld/README.md "Día y
// noche", render/sky.ts: the sky's colour as the ambient and the lamps' glow scaled by how
// dark it is): underground floors (z >= UNDERGROUND) are dark, with a
// light round the own player and round every fire that gives light (atlas.json tiles
// `light`, MapView.forEachLight). A light map: a render texture at a quarter of the screen,
// cleared to the dark AMBIENT colour, with a soft glow sprite added per light, then laid over
// the map with a multiply blend (and smoothed when stretched back to the screen). One extra
// small pass per frame, only underground; the glow sprites come from a pool, so a frame
// allocates nothing once the pool is big enough. Surface floors by day draw nothing.
import { Container, RenderTexture, Sprite, Texture } from "pixi.js";
import type { Renderer } from "pixi.js";

/** Floors from this one down are underground and dark. */
export const UNDERGROUND = 8;
/** What an unlit cave keeps of the light (multiplied): a dim, cool grey. */
export const AMBIENT = 0x3c3a4a;
/** Light round the own player, tiles. */
export const PLAYER_LIGHT = 4.5;
/** Colours of the lights: the player's is plain, a fire's is warm. */
export const PLAYER_TINT = 0xd8d4c8;
export const FIRE_TINT = 0xffb060;
/** The light map is this many times smaller than the screen. */
export const LIGHT_SCALE = 4;
/** Radius of the glow texture, px (its whole width is twice this). */
export const GLOW_RADIUS = 32;

export const isDark = (z: number): boolean => z >= UNDERGROUND;

/**
 * The glow: white in the middle fading to nothing at GLOW_RADIUS, smoothly (a light, not a
 * disc). Built once on a 2D canvas.
 */
export function glowTexture(): Texture {
  const size = GLOW_RADIUS * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(
      GLOW_RADIUS,
      GLOW_RADIUS,
      0,
      GLOW_RADIUS,
      GLOW_RADIUS,
      GLOW_RADIUS,
    );
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.45, "rgba(255,255,255,0.8)");
    g.addColorStop(0.8, "rgba(255,255,255,0.25)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "linear";
  return tex;
}

export class LightLayer {
  /** Add this over the map (under effects and names). */
  readonly view = new Sprite({ blendMode: "multiply", visible: false, label: "lights" });
  private rt: RenderTexture | undefined;
  private readonly scene = new Container({ label: "light map" });
  private readonly ambient = new Sprite({ texture: Texture.WHITE, tint: AMBIENT });
  private readonly pool: Sprite[] = [];
  private used = 0;

  constructor(private readonly glow: Texture) {
    this.scene.addChild(this.ambient);
  }

  /**
   * Starts a frame of a screen width x height px: the lights added next are drawn over
   * `ambient` (the cave's dark by default; on the surface, the sky's colour: render/sky.ts).
   */
  begin(width: number, height: number, ambient = AMBIENT): void {
    this.ambient.tint = ambient;
    const w = Math.max(1, Math.ceil(width / LIGHT_SCALE));
    const h = Math.max(1, Math.ceil(height / LIGHT_SCALE));
    if (!this.rt || this.rt.width !== w || this.rt.height !== h) {
      this.rt?.destroy(true);
      this.rt = RenderTexture.create({ width: w, height: h, scaleMode: "linear" });
      this.view.texture = this.rt;
    }
    this.ambient.setSize(w, h);
    this.view.setSize(w * LIGHT_SCALE, h * LIGHT_SCALE);
    this.used = 0;
  }

  /** A light centred on screen point (x, y), `radius` px, coloured `tint`. */
  add(x: number, y: number, radius: number, tint: number): void {
    let s = this.pool[this.used];
    if (!s) {
      s = new Sprite({ texture: this.glow, anchor: 0.5, blendMode: "add" });
      this.pool.push(s);
      this.scene.addChild(s);
    }
    this.used++;
    s.visible = true;
    s.tint = tint;
    s.position.set(x / LIGHT_SCALE, y / LIGHT_SCALE);
    s.scale.set(radius / LIGHT_SCALE / GLOW_RADIUS);
  }

  /** Hides the unused glows, draws the light map and shows it. */
  end(renderer: Renderer): void {
    for (let i = this.used; i < this.pool.length; i++) (this.pool[i] as Sprite).visible = false;
    if (this.rt) renderer.render({ container: this.scene, target: this.rt, clear: true });
    this.view.visible = true;
  }

  /** Lights used in the last frame (tests, debug). */
  get count(): number {
    return this.used;
  }

  hide(): void {
    this.view.visible = false;
  }

  destroy(): void {
    this.rt?.destroy(true);
    this.scene.destroy({ children: true });
    this.view.destroy();
  }
}
