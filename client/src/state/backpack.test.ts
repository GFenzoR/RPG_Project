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
    b.used(BACKPACK, [], 0);
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
    late.used(BACKPACK, [], 0);
    late.opened(box(4), BACKPACK_ANSWER_MS + 1);
    expect(late.id).toBeUndefined();
    const other = new EquippedBackpack();
    other.used(BACKPACK, [], 0);
    other.opened(box(4, BAG), 10);
    other.opened(box(5, BACKPACK, true), 10); // a backpack inside another
    expect(other.id).toBeUndefined();
  });

  it("does not wait when the use closes a window of that item (the server toggles)", () => {
    const b = new EquippedBackpack();
    b.used(BACKPACK, [box(2)], 0);
    b.opened(box(6), 10);
    expect(b.id).toBeUndefined();
  });

  it("lets the window go when its backpack leaves the slot, and takes it back on return", () => {
    const b = new EquippedBackpack();
    b.used(BACKPACK, [], 0);
    b.opened(box(4), 10);
    const open = [box(4)];
    b.equipped(BACKPACK, open);
    expect(b.id).toBe(4); // still worn
    b.equipped(undefined, open); // dropped beside the player: it stays open, in a window
    expect(b.id).toBeUndefined();
    expect(b.split(open)).toEqual({ backpack: undefined, others: open });
    b.equipped(BACKPACK, open); // worn again
    expect(b.id).toBe(4);
    expect(b.split(open)).toEqual({ backpack: open[0], others: [] });
  });

  it("does not take back a window that closed, or that is of another item", () => {
    const b = new EquippedBackpack();
    b.used(BACKPACK, [], 0);
    b.opened(box(4), 10);
    b.equipped(undefined, [box(4)]);
    b.closed(4);
    b.equipped(BACKPACK, []);
    expect(b.id).toBeUndefined();
    const c = new EquippedBackpack();
    c.used(BACKPACK, [], 0);
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
    b.used(BACKPACK, [], 0);
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
