// The halo of the attacked target (owner, 2026-11-26: "a red halo on the floor, that it
// shows it is on the floor and that the enemy's sprite covers part of it"). A flat ring in
// ground perspective, an ellipse squashed like the contact shadow and centred on the
// creature's stance (atlas `stance`, CreatureBody.stand), sized by its base. It lives in the
// creature's own container UNDER its figure: the sprite covers the back of the ring, and
// since the container is interleaved with the items by row (MapView.placeEntity), whatever
// stands in front of the creature covers its front. One small Graphics per creature that is
// the target (redrawn only when its size changes); a soft slow pulse, still with reduced
// motion. Colour: the life ramp of docs/17 (--ui-life-300 and -500).
import { Graphics } from "pixi.js";
import { CONTACT_FLAT, contactWidth } from "./creature-body.ts";

/** Ring and glow colours: --ui-life-300 and --ui-life-500 (docs/17 palette). */
export const HALO_RING = 0xe0523f;
export const HALO_FILL = 0xa3201b;
/** The halo is this much wider than the contact ellipse of the same feet, sprite px. */
export const HALO_MARGIN = 6;
/** Pulse: its period, ms, and how far alpha swings around its mean (0..1). */
export const HALO_PULSE_MS = 1800;
export const HALO_ALPHA = 0.8;
export const HALO_SWING = 0.2;

/** Where a body stands: sprite px from its container's origin, `width` of its feet. */
export interface Stance {
  x: number;
  y: number;
  width: number;
}

/** The ellipse of a halo (centre and full width/height), sprite px. */
export interface HaloShape {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The halo under `stance`: wider than its contact ellipse, flat like it, on the feet line. */
export function haloShape(stance: Stance): HaloShape {
  const w = Math.round(contactWidth(stance.width) + HALO_MARGIN);
  return { x: stance.x, y: stance.y, w, h: Math.max(4, Math.round(w * CONTACT_FLAT)) };
}

/** The halo's alpha at `now`: a slow pulse, or the mean when motion is reduced. */
export function haloAlpha(now: number, reduced: boolean): number {
  if (reduced) return HALO_ALPHA;
  return HALO_ALPHA + HALO_SWING * Math.sin((now / HALO_PULSE_MS) * Math.PI * 2);
}

/** The pooled graphic of one creature's halo: hidden until it is the target. */
export class TargetHalo {
  readonly graphic = new Graphics({ label: "target halo" });
  private w = 0;
  private h = 0;

  constructor() {
    this.graphic.visible = false;
  }

  /** Shows the halo under `stance` (or hides it: `stance` undefined) and pulses it. */
  update(stance: Stance | undefined, now: number, reduced: boolean): void {
    const g = this.graphic;
    if (!stance) {
      g.visible = false;
      return;
    }
    const s = haloShape(stance);
    if (s.w !== this.w || s.h !== this.h) {
      this.w = s.w;
      this.h = s.h;
      g.clear()
        .ellipse(0, 0, s.w / 2, s.h / 2)
        .fill({ color: HALO_FILL, alpha: 0.28 })
        .ellipse(0, 0, s.w / 2, s.h / 2)
        .stroke({ width: 2, color: HALO_RING, alignment: 0.5 });
    }
    g.position.set(s.x, s.y);
    g.alpha = haloAlpha(now, reduced);
    g.visible = true;
  }
}
