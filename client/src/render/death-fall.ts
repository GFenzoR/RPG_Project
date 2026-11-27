// One continuous death (docs/17 "Muerte continua"; owner, 2026-11-25: "it dies towards one
// side and its body appears on the other: it should be one animation until the body lies on
// the floor"). The server puts the remains on the tile the moment the creature dies, while
// the client still plays its fall there: the remains of THAT death stay hidden until the
// fall ends, and the body, which ends its fall in the pose and on the pixels of its corpse
// (packages/renderer anim.ts dying), fades over them. Pure, with tests: the canvas tells
// it which bodies fall and hands it the map's item sprites.
//
// Which remains are a death's: the ones the world saw laid on that tile (state/world.ts
// remainsLaid: a TileUpdate, never the map as it comes into view) from a moment before the
// death was heard of (the server sends both in one tick, in either order) until the fall
// ends. Remains that were already there are older and stay drawn; remains that come later,
// or never, are not waited for: the hide is capped at the fall's length, so nothing on the
// floor is ever out of sight (and out of reach of a click or a drag) for longer.

/**
 * A fall as the canvas holds it (begin): the remains it left, once the world saw them
 * laid. Their key says the way the corpse lies (state/corpse-art.ts keyFallDir), and the
 * body falls that way.
 */
export interface FallHandle {
  readonly laid: LaidRemains | undefined;
}

/** A fall the canvas plays: where the creature died, when, and how long it falls. */
interface Fall {
  x: number;
  y: number;
  z: number;
  start: number;
  ms: number;
  /** The remains it left, once the world saw them laid. */
  laid: LaidRemains | undefined;
  /** The map sprite hidden for it in the frame being drawn. */
  top: Veilable | undefined;
}

/** Remains laid on a tile, as the world keeps them (state/world.ts RemainsLaid). */
export interface LaidRemains {
  x: number;
  y: number;
  z: number;
  /** Their MapView key (state/corpse-art.ts). */
  key: string;
  start: number;
}

/** What is hidden of a map item's sprite (a Pixi Sprite). */
export interface Veilable {
  renderable: boolean;
}

/** The map's item sprites (packages/renderer MapView). */
export interface VeilMap<S extends Veilable> {
  forEachItemSprite(fn: (x: number, y: number, key: string, sprite: S) => void): void;
}

/**
 * Remains laid up to this long before the client heard of the death are still that
 * death's: the two messages of one server tick, handled a moment apart.
 */
export const LAID_BEFORE_MS = 150;

/** The remains hidden under the bodies that still fall. */
export class CorpseVeil {
  private readonly falls: Fall[] = [];
  /** Falls that ended since the last apply(): their remains are shown again there. */
  private readonly ended: Fall[] = [];
  private floor = 0;

  /**
   * A body starts to fall on tile (x, y, z) at `start` and falls for `ms`. `laid` (the
   * world's remains, oldest first): the ones it left, if they came before the death was
   * heard of, are its own from this moment. The handle says which, now or once they come.
   */
  begin(
    x: number,
    y: number,
    z: number,
    start: number,
    ms: number,
    laid?: readonly LaidRemains[],
  ): FallHandle {
    const fall: Fall = { x, y, z, start, ms, laid: undefined, top: undefined };
    this.falls.push(fall);
    if (laid) this.claim(fall, laid);
    return fall;
  }

  /** Gives `f` the remains it left, if `laid` has them and no other fall took them. */
  private claim(f: Fall, laid: readonly LaidRemains[]): void {
    for (const l of laid) {
      if (l.x !== f.x || l.y !== f.y || l.z !== f.z) continue;
      if (l.start < f.start - LAID_BEFORE_MS || l.start >= f.start + f.ms) continue;
      if (this.falls.some((o) => o.laid === l)) continue;
      f.laid = l;
      return;
    }
  }

  /**
   * Ends the falls that are over at `now` and gives each of the others the remains it left,
   * if `laid` (the world's, oldest first) has them by now.
   */
  update(now: number, laid: readonly LaidRemains[]): void {
    const falls = this.falls;
    for (let i = falls.length - 1; i >= 0; i--) {
      const f = falls[i] as Fall;
      if (now - f.start < f.ms && now >= f.start) continue;
      if (f.laid) this.ended.push(f);
      falls.splice(i, 1);
    }
    for (const f of falls) if (!f.laid) this.claim(f, laid);
  }

  /** Whether apply() has anything to do this frame. */
  get busy(): boolean {
    return this.falls.length > 0 || this.ended.length > 0;
  }

  /** Whether the remains `key` on tile (x, y, z) are hidden now (tests, the E2E hook). */
  hides(x: number, y: number, z: number, key?: string): boolean {
    return this.falls.some(
      (f) =>
        f.laid !== undefined &&
        f.x === x &&
        f.y === y &&
        f.z === z &&
        (key === undefined || f.laid.key === key),
    );
  }

  /**
   * Hides, among the item sprites of `map` (the floor `z` drawn), the remains of each
   * falling body: one sprite per fall, the topmost with its key on its tile (older remains
   * of the same monster under it stay drawn). Every other sprite of those remains on the
   * tile is shown, and so are the ones of the falls that just ended. Called every frame
   * while `busy`: the map rebuilds its sprites when a tile changes.
   */
  apply<S extends Veilable>(map: VeilMap<S>, z: number): void {
    this.floor = z;
    for (const f of this.falls) f.top = undefined;
    map.forEachItemSprite(this.visit);
    for (const f of this.falls) if (f.top) f.top.renderable = false;
    this.ended.length = 0;
  }

  private readonly visit = (x: number, y: number, key: string, sprite: Veilable): void => {
    const z = this.floor;
    for (const f of this.ended)
      if (f.x === x && f.y === y && f.z === z && f.laid?.key === key) sprite.renderable = true;
    // Two falls with the same remains on one tile (two monsters of a kind dying there in the
    // same moment) each hide a sprite of their own: the sprites come bottom to top, so the
    // newest goes to the first of those falls and the one it held passes on to the next.
    let carry: Veilable | undefined = sprite;
    for (const f of this.falls) {
      if (f.x !== x || f.y !== y || f.z !== z || f.laid?.key !== key) continue;
      sprite.renderable = true;
      const held: Veilable | undefined = f.top;
      f.top = carry;
      carry = held;
      if (!carry) break;
    }
  };

  /**
   * Forgets every fall (the canvas is destroyed): nothing stays hidden. A change of floor
   * needs none of this: MapView.setFloor drops every sprite it built, the hidden ones too.
   */
  clear(): void {
    for (const f of this.falls) if (f.laid) this.ended.push(f);
    this.falls.length = 0;
  }
}

/**
 * Where a body that died `el` ms ago is drawn, between where it was (`from`, mid-step) and
 * the tile it died on (`to`, where its remains lie): it ends the step it was taking in
 * SETTLE_STEP_MS at most, so the fall happens where the corpse is.
 */
export const SETTLE_STEP_MS = 120;
export function settle(from: number, to: number, el: number, fallMs: number): number {
  const ms = Math.min(SETTLE_STEP_MS, fallMs);
  if (ms <= 0 || el >= ms) return to;
  return from + ((to - from) * Math.max(0, el)) / ms;
}
