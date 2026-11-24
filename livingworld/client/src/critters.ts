// Ambient critters (livingworld/README.md), cosmetic and client only: birds and butterflies
// by day that flee when a player comes close, fireflies at night, fish shadows under shallow
// water. Where they live is deterministic: a tile in view hosts one when its hash says so and
// its surface lists that kind (data/livingworld/surfaces.yaml `critters`). The view is
// scanned every SCAN_MS, not every frame; at most MAX_CRITTERS live (docs/07).
import type { CritterKind, Surface, SurfaceRules } from "./data.ts";
import { hash01, tileKey } from "./hash.ts";

/** docs/07: critters at once. */
export const MAX_CRITTERS = 10;
/** How often the view is searched for homes, ms. */
export const SCAN_MS = 1000;
/** A bird or butterfly flees when a player is this close, tiles. */
export const FLEE_TILES = 2.5;
export const FLEE_MS = 900;
/** A home stays empty this long after its critter fled, ms. */
export const RETURN_MS = 20000;
/** Of the tiles a kind may live on, about this share host one. */
export const DENSITY: Readonly<Record<CritterKind, number>> = {
  bird: 0.012,
  butterfly: 0.01,
  firefly: 0.03,
  fish: 0.05,
};

/** Day kinds flee; night kinds glow; fish swim either way. */
const DAY: readonly CritterKind[] = ["bird", "butterfly"];
const NIGHT: readonly CritterKind[] = ["firefly"];

export interface Critter {
  kind: CritterKind;
  hx: number;
  hy: number;
  /** Sprite pixels, now. */
  x: number;
  y: number;
  /** When it fled (ms on the clock), or -1. */
  fled: number;
  dx: number;
  dy: number;
  phase: number;
}

export interface CritterView {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SurfaceAt = (x: number, y: number) => Surface | undefined;

export class CritterSim {
  readonly critters: Critter[] = [];
  private readonly away = new Map<number, number>();
  private lastScan = Number.NEGATIVE_INFINITY;

  constructor(private readonly tile: number) {}

  /**
   * Steps the critters to `now`: finds homes in `view` (tiles), moves them, makes the ones
   * near `self` (tile, may be undefined) flee, and drops the ones gone or out of view.
   */
  update(
    now: number,
    view: CritterView,
    self: { x: number; y: number } | undefined,
    surfaceAt: SurfaceAt,
    rules: Partial<Record<Surface, SurfaceRules>>,
    night: boolean,
  ): void {
    const x0 = Math.floor(view.x);
    const y0 = Math.floor(view.y);
    const x1 = Math.ceil(view.x + view.width);
    const y1 = Math.ceil(view.y + view.height);
    // Drop the gone, the out of view, and the ones out of their hour.
    let w = 0;
    for (const c of this.critters) {
      const gone = c.fled >= 0 && now - c.fled >= FLEE_MS;
      const out = c.hx < x0 || c.hy < y0 || c.hx > x1 || c.hy > y1;
      const hour = DAY.includes(c.kind) ? !night : NIGHT.includes(c.kind) ? night : true;
      if (!gone && !out && hour) this.critters[w++] = c;
    }
    this.critters.length = w;
    if (now - this.lastScan >= SCAN_MS || now < this.lastScan) {
      this.lastScan = now;
      for (const [k, until] of this.away) if (until <= now) this.away.delete(k);
      this.scan(x0, y0, x1, y1, surfaceAt, rules, night, now);
    }
    for (const c of this.critters) this.move(c, now, self);
  }

  private scan(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    surfaceAt: SurfaceAt,
    rules: Partial<Record<Surface, SurfaceRules>>,
    night: boolean,
    now: number,
  ): void {
    for (let y = y0; y <= y1 && this.critters.length < MAX_CRITTERS; y++) {
      for (let x = x0; x <= x1 && this.critters.length < MAX_CRITTERS; x++) {
        const h = hash01(x, y, 29);
        if (h >= 0.05) continue; // cheap early out: no kind is denser than this
        const s = surfaceAt(x, y);
        const kinds = s ? rules[s]?.critters : undefined;
        if (!kinds || kinds.length === 0) continue;
        const kind = kinds[Math.floor(hash01(x, y, 31) * kinds.length)] as CritterKind;
        if (h >= DENSITY[kind]) continue;
        if (DAY.includes(kind) && night) continue;
        if (NIGHT.includes(kind) && !night) continue;
        const k = tileKey(x, y);
        if ((this.away.get(k) ?? 0) > now) continue;
        if (this.critters.some((c) => c.hx === x && c.hy === y)) continue;
        const T = this.tile;
        this.critters.push({
          kind,
          hx: x,
          hy: y,
          x: (x + 0.5) * T,
          y: (y + 0.5) * T,
          fled: -1,
          dx: 0,
          dy: 0,
          phase: hash01(x, y, 37) * Math.PI * 2,
        });
      }
    }
  }

  private move(c: Critter, now: number, self: { x: number; y: number } | undefined): void {
    const T = this.tile;
    const hx = (c.hx + 0.5) * T;
    const hy = (c.hy + 0.5) * T;
    if (c.fled < 0 && self && DAY.includes(c.kind)) {
      const ddx = c.hx - self.x;
      const ddy = c.hy - self.y;
      if (ddx * ddx + ddy * ddy <= FLEE_TILES * FLEE_TILES) {
        const len = Math.hypot(ddx, ddy) || 1;
        c.fled = now;
        c.dx = ddx / len;
        c.dy = ddy / len - 0.6; // and up, away into the sky
        this.away.set(tileKey(c.hx, c.hy), now + RETURN_MS);
      }
    }
    if (c.fled >= 0) {
      const t = (now - c.fled) / 1000;
      const speed = c.kind === "bird" ? 120 : 60;
      c.x = hx + c.dx * speed * t;
      c.y = hy + c.dy * speed * t;
      return;
    }
    const s = now / 1000 + c.phase;
    switch (c.kind) {
      case "bird": // pecks about its spot
        c.x = hx + Math.round(Math.sin(s * 0.7) * 3);
        c.y = hy;
        break;
      case "butterfly":
        c.x = hx + Math.sin(s * 0.9) * 10;
        c.y = hy - 8 + Math.sin(s * 2.3) * 4;
        break;
      case "firefly":
        c.x = hx + Math.sin(s * 0.5) * 12;
        c.y = hy - 6 + Math.cos(s * 0.37) * 8;
        break;
      case "fish": // slow circles
        c.x = hx + Math.cos(s * 0.4) * 9;
        c.y = hy + Math.sin(s * 0.4) * 5;
        break;
    }
  }

  /** How visible c is now (fireflies pulse; fleeing ones fade). */
  static alpha(c: Critter, now: number): number {
    if (c.fled >= 0) return Math.max(0, 1 - (now - c.fled) / FLEE_MS);
    if (c.kind === "firefly") return 0.35 + 0.65 * Math.max(0, Math.sin(now / 400 + c.phase));
    if (c.kind === "fish") return 0.45;
    return 1;
  }

  /** Which of 2 frames c shows (wings flap faster when it flees). */
  static frame(c: Critter, now: number): number {
    const ms = c.fled >= 0 ? 80 : c.kind === "butterfly" ? 160 : c.kind === "bird" ? 700 : 500;
    return Math.floor((now + c.phase * 1000) / ms) % 2;
  }

  clear(): void {
    this.critters.length = 0;
  }
}
