import { describe, expect, it } from "vitest";
import { CorpseVeil, LAID_BEFORE_MS, SETTLE_STEP_MS, followRemains, settle } from "./death-fall.ts";
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

describe("the remains of a fall that knows who died", () => {
  it("are that creature's, never a corpse dragged onto its tile in the same moment", () => {
    // A west-facing rat corpse is dragged onto the tile; a wolf dies there facing east.
    const veil = new CorpseVeil();
    const dragged = laid(3, 4, "40@rat/w", 950);
    const own = laid(3, 4, "40@wolf/e", 1000);
    const fall = veil.begin(3, 4, 7, 1000, FALL, [dragged, own], "wolf");
    expect(fall.laid).toBe(own);
    const rat = item(3, 4, "40@rat/w");
    const wolf = item(3, 4, "40@wolf/e");
    frame(veil, 1016, [dragged, own], [rat, wolf]);
    expect([rat.renderable, wolf.renderable]).toEqual([true, false]);
    // Its own remains never come (a summon): the dragged corpse is still not its own.
    const veil2 = new CorpseVeil();
    const alone = veil2.begin(3, 4, 7, 1000, FALL, [dragged], "wolf");
    frame(veil2, 1100, [dragged], [rat]);
    expect(alone.laid).toBeUndefined();
    expect(rat.renderable).toBe(true);
    // A player's body, by sex, whatever way it lies.
    const body = laid(3, 4, "41@body_female/n", 1000);
    expect(veil2.begin(3, 4, 7, 1000, FALL, [dragged, body], "body_female").laid).toBe(body);
    expect(new CorpseVeil().begin(3, 4, 7, 1000, FALL, [body], "body_male").laid).toBeUndefined();
  });

  it("are the ones laid nearest to its death among several of its kind", () => {
    // A wolf corpse dragged onto the tile 100 ms before another wolf dies on it.
    const veil = new CorpseVeil();
    const dragged = laid(3, 4, "40@wolf/w", 900);
    const own = laid(3, 4, "40@wolf/e", 1000);
    expect(veil.begin(3, 4, 7, 1000, FALL, [dragged, own], "wolf").laid).toBe(own);
  });

  it("leave a corpse that came first for its own when they come, and show it again", () => {
    // The dragged wolf is all there is when the death is heard of; its own come a frame on.
    const veil = new CorpseVeil();
    const dragged = laid(3, 4, "40@wolf/w", 900);
    const fall = veil.begin(3, 4, 7, 1000, FALL, [dragged], "wolf");
    expect(fall.laid).toBe(dragged);
    const west = item(3, 4, "40@wolf/w");
    frame(veil, 1005, [dragged], [west]);
    expect(west.renderable).toBe(false);
    const own = laid(3, 4, "40@wolf/e", 1010);
    const east = item(3, 4, "40@wolf/e");
    frame(veil, 1016, [dragged, own], [west, east]);
    expect(fall.laid).toBe(own);
    expect([west.renderable, east.renderable]).toEqual([true, false]);
    // Nothing nearer comes: it keeps them, and a later frame changes nothing.
    frame(veil, 1100, [dragged, own, laid(3, 4, "40@wolf/n", 1090)], [west, east]);
    expect(fall.laid).toBe(own);
    expect([west.renderable, east.renderable]).toEqual([true, false]);
  });
});

describe("followRemains: the body falls the way its remains lie", () => {
  // CreatureBody.fallY: where the corpse of each way rests.
  const body = { fallY: (way: string): number => ({ s: 7, e: 3, n: 7, w: 10 })[way] ?? 0 };

  it("falls the way the client had it until the remains come, then turns once", () => {
    const veil = new CorpseVeil();
    const fall = veil.begin(3, 4, 7, 1000, FALL, [], "wolf");
    const state = { fallDir: "e" as const, fallY: 3 };
    // No remains yet: nothing changes.
    expect(followRemains(fall, undefined, state, body)).toBeUndefined();
    expect(state).toEqual({ fallDir: "e", fallY: 3 });
    // The monster turned in the tick it died: its remains lie west, and come mid-fall.
    const west = laid(3, 4, "40@wolf/w", 1040);
    frame(veil, 1050, [west], []);
    let follows = followRemains(fall, undefined, state, body);
    expect(follows).toBe(west);
    expect(state).toEqual({ fallDir: "w", fallY: 10 });
    // The same remains on the next frames: not read again (whatever the state says now).
    state.fallY = 99;
    follows = followRemains(fall, follows, state, body);
    expect(follows).toBe(west);
    expect(state).toEqual({ fallDir: "w", fallY: 99 });
  });

  it("keeps the fall as it is for remains lying the way it already falls", () => {
    const veil = new CorpseVeil();
    const south = laid(3, 4, "40@wolf", 1000);
    const fall = veil.begin(3, 4, 7, 1000, FALL, [south], "wolf");
    const state = { fallDir: "s" as const, fallY: 7 };
    expect(followRemains(fall, undefined, state, body)).toBe(south);
    expect(state).toEqual({ fallDir: "s", fallY: 7 });
    // A fall that is not one (a body shimmering away) follows nothing.
    expect(followRemains(undefined, undefined, state, body)).toBeUndefined();
  });

  it("turns again when the fall changes a dragged corpse for its own remains", () => {
    const veil = new CorpseVeil();
    const dragged = laid(3, 4, "40@wolf/w", 900);
    const fall = veil.begin(3, 4, 7, 1000, FALL, [dragged], "wolf");
    const state = { fallDir: "n" as const, fallY: 7 };
    let follows = followRemains(fall, undefined, state, body);
    expect(state.fallDir).toBe("w");
    const own = laid(3, 4, "40@wolf/e", 1010);
    frame(veil, 1016, [dragged, own], []);
    follows = followRemains(fall, follows, state, body);
    expect(follows).toBe(own);
    expect(state).toEqual({ fallDir: "e", fallY: 3 });
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
