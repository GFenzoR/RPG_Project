import { describe, expect, it } from "vitest";
import { CorpseVeil, LAID_BEFORE_MS, SETTLE_STEP_MS, settle } from "./death-fall.ts";
import type { LaidRemains, Veilable } from "./death-fall.ts";

interface Item extends Veilable {
  x: number;
  y: number;
  key: string;
}

/** A map with these item sprites, bottom to top (packages/renderer MapView). */
const mapOf = (items: Item[]) => ({
  forEachItemSprite(fn: (x: number, y: number, key: string, sprite: Item) => void): void {
    for (const it of items) fn(it.x, it.y, it.key, it);
  },
});
const item = (x: number, y: number, key: string): Item => ({ x, y, key, renderable: true });
const laid = (x: number, y: number, key: string, start: number): LaidRemains => ({
  x,
  y,
  z: 7,
  key,
  start,
});

/** One frame of the canvas at `now`. */
function frame(veil: CorpseVeil, now: number, remains: LaidRemains[], items: Item[]): void {
  if (!veil.busy) return;
  veil.update(now, remains);
  veil.apply(mapOf(items), 7);
}

const WOLF = "40@wolf";
const FALL = 360;

describe("CorpseVeil", () => {
  it("hides the remains of a death until its fall ends, then shows them (docs/17)", () => {
    const veil = new CorpseVeil();
    const corpse = item(5, 5, WOLF);
    const remains = [laid(5, 5, WOLF, 1000)];
    veil.begin(5, 5, 7, 1000, FALL);
    for (const now of [1000, 1016, 1200, 1000 + FALL - 1]) {
      frame(veil, now, remains, [corpse]);
      expect(corpse.renderable).toBe(false);
      expect(veil.hides(5, 5, 7, WOLF)).toBe(true);
    }
    // The fall is over: the corpse takes over on that very frame, and nothing is left to do.
    frame(veil, 1000 + FALL, remains, [corpse]);
    expect(corpse.renderable).toBe(true);
    expect(veil.hides(5, 5, 7)).toBe(false);
    expect(veil.busy).toBe(false);
  });

  it("pairs a death with remains laid a moment before or after it was heard of", () => {
    for (const at of [1000 - LAID_BEFORE_MS, 1000, 1040]) {
      const veil = new CorpseVeil();
      const corpse = item(5, 5, WOLF);
      veil.begin(5, 5, 7, 1000, FALL);
      frame(veil, 1050, [laid(5, 5, WOLF, at)], [corpse]);
      expect(corpse.renderable).toBe(false);
    }
  });

  it("never hides remains that were already there, nor the ones of another tile", () => {
    const veil = new CorpseVeil();
    const old = item(5, 5, WOLF);
    const other = item(6, 5, WOLF);
    const remains = [laid(5, 5, WOLF, 1000 - LAID_BEFORE_MS - 1), laid(6, 5, WOLF, 1000)];
    veil.begin(5, 5, 7, 1000, FALL);
    frame(veil, 1100, remains, [old, other]);
    expect(old.renderable).toBe(true);
    expect(other.renderable).toBe(true);
    expect(veil.hides(5, 5, 7)).toBe(false);
    // Remains that enter the view with the map are no TileUpdate: nothing was laid.
    frame(veil, 1150, [], [old]);
    expect(old.renderable).toBe(true);
  });

  it("hides only the topmost of two equal remains: the older body under it stays", () => {
    const veil = new CorpseVeil();
    const older = item(5, 5, WOLF);
    const newer = item(5, 5, WOLF);
    veil.begin(5, 5, 7, 1000, FALL);
    frame(veil, 1100, [laid(5, 5, WOLF, 1000)], [older, item(5, 5, "12"), newer]);
    expect(older.renderable).toBe(true);
    expect(newer.renderable).toBe(false);
  });

  it("follows the map when it rebuilds its sprites, and frees the ones it hid", () => {
    const veil = new CorpseVeil();
    const remains = [laid(5, 5, WOLF, 1000)];
    veil.begin(5, 5, 7, 1000, FALL);
    const first = item(5, 5, WOLF);
    frame(veil, 1100, remains, [first]);
    expect(first.renderable).toBe(false);
    // A coin dropped on the tile: the chunk is built again, with other sprites.
    const second = item(5, 5, WOLF);
    frame(veil, 1150, remains, [second, item(5, 5, "7")]);
    expect(second.renderable).toBe(false);
    // The chunk was not rebuilt when the fall ended: the same sprite is shown again.
    frame(veil, 1000 + FALL + 5, remains, [second]);
    expect(second.renderable).toBe(true);
  });

  it("does not wait for remains that come late or never: the hide is capped at the fall", () => {
    const veil = new CorpseVeil();
    veil.begin(5, 5, 7, 1000, FALL);
    // Nothing yet: nothing is hidden, the body falls alone.
    frame(veil, 1200, [], []);
    expect(veil.hides(5, 5, 7)).toBe(false);
    expect(veil.busy).toBe(true);
    // The fall ended without them (a summon leaves none): the veil is done.
    frame(veil, 1000 + FALL, [], []);
    expect(veil.busy).toBe(false);
    // They come after the fall: shown at once, as any item (and they can be dragged).
    const late = item(5, 5, WOLF);
    frame(veil, 1000 + FALL + 30, [laid(5, 5, WOLF, 1000 + FALL + 20)], [late]);
    expect(late.renderable).toBe(true);
    // Late but within the fall: hidden for what is left of it only.
    const veil2 = new CorpseVeil();
    veil2.begin(5, 5, 7, 1000, FALL);
    const mid = item(5, 5, WOLF);
    frame(veil2, 1300, [laid(5, 5, WOLF, 1290)], [mid]);
    expect(mid.renderable).toBe(false);
    frame(veil2, 1000 + FALL, [laid(5, 5, WOLF, 1290)], [mid]);
    expect(mid.renderable).toBe(true);
  });

  it("gives each of two deaths its own remains, and only on the floor drawn", () => {
    const veil = new CorpseVeil();
    const a = item(5, 5, WOLF);
    const b = item(8, 5, "41");
    const remains = [laid(5, 5, WOLF, 1000), laid(8, 5, "41", 1010)];
    veil.begin(5, 5, 7, 1000, FALL);
    veil.begin(8, 5, 7, 1010, 600); // a player: its body is a plain item's key
    frame(veil, 1100, remains, [a, b]);
    expect([a.renderable, b.renderable]).toEqual([false, false]);
    frame(veil, 1000 + FALL, remains, [a, b]);
    expect([a.renderable, b.renderable]).toEqual([true, false]);
    frame(veil, 1010 + 600, remains, [a, b]);
    expect([a.renderable, b.renderable]).toEqual([true, true]);
    // Another floor is drawn: its sprites are not this fall's.
    const veil2 = new CorpseVeil();
    veil2.begin(5, 5, 6, 1000, FALL);
    const here = item(5, 5, WOLF);
    veil2.update(1100, [{ ...laid(5, 5, WOLF, 1000), z: 6 }]);
    veil2.apply(mapOf([here]), 7);
    expect(here.renderable).toBe(true);
  });

  it("hides one body each for two of a kind that die on one tile at once", () => {
    const veil = new CorpseVeil();
    const old = item(5, 5, WOLF);
    const first = item(5, 5, WOLF);
    const second = item(5, 5, WOLF);
    const items = [old, first, second];
    const remains = [laid(5, 5, WOLF, 1000), laid(5, 5, WOLF, 1050)];
    veil.begin(5, 5, 7, 1000, FALL);
    veil.begin(5, 5, 7, 1050, FALL);
    frame(veil, 1100, remains, items);
    // The two on top are the ones that fall; the body that already lay there stays drawn.
    expect(items.map((i) => i.renderable)).toEqual([true, false, false]);
    frame(veil, 1000 + FALL, remains, items);
    expect(items.map((i) => i.renderable)).toEqual([true, true, false]);
    frame(veil, 1050 + FALL, remains, items);
    expect(items.map((i) => i.renderable)).toEqual([true, true, true]);
  });

  it("shows everything again when it is cleared", () => {
    const veil = new CorpseVeil();
    const corpse = item(5, 5, WOLF);
    veil.begin(5, 5, 7, 1000, FALL);
    frame(veil, 1100, [laid(5, 5, WOLF, 1000)], [corpse]);
    veil.clear();
    veil.apply(mapOf([corpse]), 7);
    expect(corpse.renderable).toBe(true);
    expect(veil.busy).toBe(false);
  });
});

describe("the remains of a fall (docs/17: the body falls the way its corpse lies)", () => {
  it("are the fall's own from the start when they came before the death was heard of", () => {
    const veil = new CorpseVeil();
    const east = laid(3, 4, "40@wolf/e", 990);
    const fall = veil.begin(3, 4, 7, 1000, FALL, [east]);
    expect(fall.laid).toBe(east);
    expect(veil.hides(3, 4, 7, "40@wolf/e")).toBe(true);
  });

  it("come to the fall's handle when they arrive after it began, and stay once it ended", () => {
    const veil = new CorpseVeil();
    const fall = veil.begin(3, 4, 7, 1000, FALL, []);
    expect(fall.laid).toBeUndefined();
    const west = laid(3, 4, "40@wolf/w", 1010);
    const body = item(3, 4, "40@wolf/w");
    frame(veil, 1016, [west], [body]);
    expect(fall.laid).toBe(west);
    expect(body.renderable).toBe(false);
    frame(veil, 1000 + FALL, [west], [body]);
    expect(body.renderable).toBe(true);
    expect(fall.laid).toBe(west); // the canvas still knows which way it fell
  });

  it("are never another tile's, older ones, or the ones another fall took", () => {
    const veil = new CorpseVeil();
    const old = laid(3, 4, "40@wolf/n", 1000 - LAID_BEFORE_MS - 1);
    const other = laid(5, 4, "40@wolf/e", 1000);
    expect(veil.begin(3, 4, 7, 1000, FALL, [old, other]).laid).toBeUndefined();
    const one = laid(3, 4, "40@wolf/e", 1001);
    const a = veil.begin(3, 4, 7, 1001, FALL, [old, other, one]);
    const b = veil.begin(3, 4, 7, 1001, FALL, [old, other, one]);
    expect(a.laid).toBe(one);
    expect(b.laid).toBeUndefined();
  });
});

describe("settle", () => {
  it("ends the step a creature died in, so it falls where its remains lie", () => {
    expect(settle(100, 128, 0, 360)).toBe(100);
    expect(settle(100, 128, SETTLE_STEP_MS / 2, 360)).toBe(114);
    expect(settle(100, 128, SETTLE_STEP_MS, 360)).toBe(128);
    expect(settle(100, 128, 5000, 360)).toBe(128);
    // Never later than the fall itself.
    expect(settle(100, 128, 60, 60)).toBe(128);
    expect(settle(100, 128, 0, 0)).toBe(128);
  });
});
