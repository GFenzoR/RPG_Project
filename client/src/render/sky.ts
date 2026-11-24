// Glue to the living world's sky (livingworld/README.md "Día y noche"): the one place in
// the game client that reads the day and night from @rpg/living-world. It runs the world
// clock the server sent (state/world-clock.ts) on between syncs and hands the canvas what
// it draws: the light colour and the lamps over the surface (render/light-layer.ts), the
// ground transform of the creatures' cast shadows (render/cast-shadows.ts), how strong the
// baked shadows of trees and buildings are, and night for the fireflies. The sky model
// itself lives in livingworld/client/src/sky.ts. A frame allocates nothing.
import { advance, newSky, shadowTransform, skyAt } from "@rpg/living-world";
import type { DayNightData, Sky } from "@rpg/living-world";
import type { WorldClockState } from "../state/world-clock.ts";
import type { ShadowPose } from "./cast-shadows.ts";

export type { DayNightData, Sky } from "@rpg/living-world";
/** The owner's cycle, for tests and the UI preview. */
export { DEFAULT_DAY_NIGHT } from "@rpg/living-world";

/** The player's own light at night on the surface, of the cave's (it never blinds). */
export const NIGHT_PLAYER_LIGHT = 0.55;

export class SkyView {
  private readonly sky: Sky = newSky();
  private readonly pose: ShadowPose = { skewX: 0, scaleY: 0, alpha: 0 };
  private drawn = false;

  /** `data`: data/livingworld/daynight.yaml (no data: no day and night, `update` gives undefined). */
  constructor(
    private readonly data: DayNightData | undefined,
    private readonly clock: WorldClockState,
  ) {}

  /**
   * The sky at `now` (performance.now() ms). Before the server's first WorldClock (or from
   * a server without one) it is noon: shadows under the feet, no tint.
   */
  update(now: number): Sky | undefined {
    const d = this.data;
    if (!d) return undefined;
    const c = this.clock;
    if (!c.known) skyAt(d, 0, d.dayMs / 2, this.sky);
    else {
      const t = advance(d, c.day, c.cycleMs, c.rate, now - c.at);
      skyAt(d, t.day, t.cycleMs, this.sky);
    }
    this.drawn = true;
    return this.sky;
  }

  /**
   * A frame with no sky over it (underground): nothing is drawn of it, and it is not night
   * for the critters until the surface is drawn again.
   */
  none(): undefined {
    this.drawn = false;
    return undefined;
  }

  /** The last sky drawn (fireflies ask between frames); undefined before the first and underground. */
  get current(): Sky | undefined {
    return this.drawn ? this.sky : undefined;
  }

  /** Night for the living world's critters. */
  night(): boolean {
    return this.drawn && this.sky.night;
  }

  /**
   * The creatures' cast shadows under `sky` (reused object); undefined: none. `reduced`
   * ("Animaciones reducidas", docs/16): no cast shadows at all, only the contact ellipse.
   */
  shadowPose(sky: Sky | undefined, reduced = false): ShadowPose | undefined {
    if (reduced || !sky || sky.shadow.alpha <= 0) return undefined;
    const t = shadowTransform(sky.shadow);
    this.pose.skewX = t.skewX;
    this.pose.scaleY = t.scaleY;
    this.pose.alpha = sky.shadow.alpha;
    return this.pose;
  }

  /**
   * How strong the baked shadows of trees and buildings are (MapView.castShadowStrength):
   * full under a high sun, fading at sunrise and sunset, faint under the moon.
   */
  staticShadows(sky: Sky | undefined): number {
    const d = this.data;
    if (!sky || !d || d.sunShadow <= 0) return 1;
    return Math.min(1, sky.shadow.alpha / d.sunShadow);
  }
}

/** Whether the surface needs the light map under `sky`: any tint, or any lamp. */
export const litSurface = (sky: Sky | undefined): sky is Sky =>
  sky !== undefined && (sky.ambient !== 0xffffff || sky.lamps > 0);

/** `tint` scaled by `k` (0..1) toward black: a lamp that glows only so much (added light). */
export function dimmed(tint: number, k: number): number {
  const f = Math.min(1, Math.max(0, k));
  const ch = (s: number): number => Math.round(((tint >> s) & 0xff) * f);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}
