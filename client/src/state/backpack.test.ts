import { describe, expect, it } from "vitest";
import { BACKPACK_ANSWER_MS, EquippedBackpack, autoOpen } from "./backpack.ts";
import type { AutoOpenInput } from "./backpack.ts";
import type { ContainerState } from "./world.ts";

const BACKPACK = 48;
const BAG = 49;
const box = (id: number, itemId = BACKPACK, hasParent = false): ContainerState => ({
  id,
  itemId,
  capacity: 20,
  items: [],
  hasParent,
});

describe("EquippedBackpack (docs/17 UI-5: the backpack under the figure)", () => {
  it("takes the window that answers a use of the backpack slot", () => {
    const b = new EquippedBackpack();
    b.used(BACKPACK, 0);
    // Another window opening meanwhile (a corpse) is not it; the backpack's is.
    b.opened(box(3, 77, true), 10);
    expect(b.id).toBeUndefined();
    b.opened(box(4), 20);
    expect(b.id).toBe(4);
    // One answer per use: a backpack opened later from the floor stays in its window.
    b.closed(4);
    b.opened(box(5), 30);
    expect(b.id).toBeUndefined();
  });

  it("ignores an answer that comes too late, of another item or with a parent", () => {
    const late = new EquippedBackpack();
    late.used(BACKPACK, 0);
    late.opened(box(4), BACKPACK_ANSWER_MS + 1);
    expect(late.id).toBeUndefined();
    const other = new EquippedBackpack();
    other.used(BACKPACK, 0);
    other.opened(box(4, BAG), 10);
    other.opened(box(5, BACKPACK, true), 10); // a backpack inside another
    expect(other.id).toBeUndefined();
  });

  it("does not wait once the use closed a window of that item (the server toggles)", () => {
    const b = new EquippedBackpack();
    b.used(BACKPACK, 0);
    b.opened(box(2), 10);
    b.used(BACKPACK, 20); // the second use closes it
    b.closed(2, box(2));
    expect(b.id).toBeUndefined();
    b.opened(box(6), 30); // a backpack opened from the floor afterwards: a window of its own
    expect(b.id).toBeUndefined();
    // Another window closing meanwhile (a corpse left behind) does not cancel the wait.
    const c = new EquippedBackpack();
    c.used(BACKPACK, 0);
    c.closed(3, box(3, 77));
    c.closed(9); // one the client did not know
    c.opened(box(4), 10);
    expect(c.id).toBe(4);
  });

  it("lets the window go when its backpack leaves the slot, and never takes it back", () => {
    const b = new EquippedBackpack();
    b.used(BACKPACK, 0);
    b.opened(box(4), 10);
    const open = [box(4)];
    b.equipped(BACKPACK, open);
    expect(b.id).toBe(4); // still worn
    b.equipped(undefined, open); // dropped beside the player: it stays open, in a window
    expect(b.id).toBeUndefined();
    expect(b.split(open)).toEqual({ backpack: undefined, others: open });
    // A backpack of that kind worn again may be another one (the final review of lote 9:
    // the loot dragged under the figure would go to the one on the floor): the window
    // stays a window of its own.
    b.equipped(BACKPACK, open);
    expect(b.id).toBeUndefined();
    expect(b.split(open)).toEqual({ backpack: undefined, others: open });
  });

  it("puts the worn one below once a use of the slot opens it", () => {
    // The first backpack (4) lies open on the floor; another of that kind is worn.
    const b = new EquippedBackpack();
    b.used(BACKPACK, 0);
    b.opened(box(4), 10);
    b.equipped(undefined, [box(4)]);
    b.equipped(BACKPACK, [box(4)]);
    // A use of the slot opens the worn one (5): it goes below, the one on the floor stays.
    b.used(BACKPACK, 100);
    b.opened(box(5), 110);
    expect(b.id).toBe(5);
    expect(b.split([box(4), box(5)])).toEqual({ backpack: box(5), others: [box(4)] });
    // The same backpack worn again instead: the use closes its window, the next opens it.
    const c = new EquippedBackpack();
    c.used(BACKPACK, 0);
    c.opened(box(4), 10);
    c.equipped(undefined, [box(4)]);
    c.equipped(BACKPACK, [box(4)]);
    c.used(BACKPACK, 100);
    c.closed(4, box(4));
    expect(c.id).toBeUndefined();
    c.used(BACKPACK, 200);
    c.opened(box(7), 210);
    expect(c.id).toBe(7);
  });

  it("lets a window go that closed, or when another kind of bag is worn", () => {
    const b = new EquippedBackpack();
    b.used(BACKPACK, 0);
    b.opened(box(4), 10);
    b.closed(4, box(4));
    expect(b.id).toBeUndefined();
    b.equipped(BACKPACK, []);
    expect(b.id).toBeUndefined();
    const c = new EquippedBackpack();
    c.used(BACKPACK, 0);
    c.opened(box(4), 10);
    c.equipped(BAG, [box(4)]); // another kind of bag on the back now
    expect(c.id).toBeUndefined();
    c.equipped(BAG, [box(4)]);
    expect(c.id).toBeUndefined();
  });

  it("splits the open containers: the backpack apart, the same list without it", () => {
    const b = new EquippedBackpack();
    const open = [box(2, 77, true), box(4)];
    expect(b.split(open).others).toBe(open);
    b.used(BACKPACK, 0);
    b.opened(box(4), 10);
    expect(b.split(open)).toEqual({ backpack: open[1], others: [open[0]] });
  });
});

describe("autoOpen (the inventory opens the backpack when it shows)", () => {
  const input = (over: Partial<AutoOpenInput>): AutoOpenInput => ({
    equipped: BACKPACK,
    docked: false,
    tutorial: false,
    lookalike: false,
    done: undefined,
    ...over,
  });

  it("opens a worn backpack once", () => {
    const first = autoOpen(input({}));
    expect(first).toEqual({ open: true, done: BACKPACK });
    // Closed by hand afterwards: it stays closed while the inventory shows.
    expect(autoOpen(input({ done: first.done }))).toEqual({ open: false, done: BACKPACK });
  });

  it("leaves it alone when it is open, during the tutorial and when a use would close a window", () => {
    expect(autoOpen(input({ docked: true }))).toEqual({ open: false, done: BACKPACK });
    expect(autoOpen(input({ tutorial: true }))).toEqual({ open: false, done: BACKPACK });
    expect(autoOpen(input({ lookalike: true }))).toEqual({ open: false, done: BACKPACK });
  });

  it("forgets when the slot empties, and opens another backpack worn later", () => {
    expect(autoOpen(input({ equipped: undefined, done: BACKPACK }))).toEqual({
      open: false,
      done: undefined,
    });
    expect(autoOpen(input({ equipped: BAG, done: BACKPACK }))).toEqual({ open: true, done: BAG });
  });
});
