import { describe, expect, it } from "vitest";
import { contextAction, tileContext } from "./context-action.ts";
import type { ContextTile } from "./context-action.ts";

const bare: ContextTile = { facts: { known: true } };
const tile = (t: Partial<ContextTile> & { facts?: ContextTile["facts"] }): ContextTile => ({
  facts: { known: true },
  ...t,
});

describe("tileContext", () => {
  it("talks to an NPC and attacks a monster, never the own player", () => {
    expect(
      tileContext(tile({ facts: { known: true, creature: { npc: true, self: false } } })),
    ).toBe("talk");
    expect(
      tileContext(tile({ facts: { known: true, creature: { npc: false, self: false } } })),
    ).toBe("attack");
    expect(
      tileContext(tile({ facts: { known: true, creature: { npc: false, self: true } } })),
    ).toBeUndefined();
  });

  it("climbs a ladder, opens a container, loots a corpse, reads a book", () => {
    expect(tileContext(tile({ facts: { known: true, climb: true } }))).toBe("climb");
    expect(tileContext(tile({ facts: { known: true, item: { container: true } } }))).toBe("open");
    expect(
      tileContext(tile({ facts: { known: true, item: { container: true } }, corpse: true })),
    ).toBe("loot");
    expect(
      tileContext(tile({ facts: { known: true, item: { container: false, book: true } } })),
    ).toBe("read");
    expect(
      tileContext(tile({ facts: { known: true, item: { container: false, chest: true } } })),
    ).toBe("open");
  });

  it("uses a door or a station, not a tree nor a loose item", () => {
    expect(tileContext(tile({ facts: { known: true, door: true } }))).toBe("use");
    expect(
      tileContext(
        tile({ facts: { known: true, item: { container: false, fixed: true, usable: true } } }),
      ),
    ).toBe("use");
    expect(
      tileContext(tile({ facts: { known: true, item: { container: false, fixed: true } } })),
    ).toBeUndefined();
    expect(
      tileContext(tile({ facts: { known: true, item: { container: false, food: true } } })),
    ).toBeUndefined();
    expect(
      tileContext(tile({ facts: { known: true, item: { container: false, equip: true } } })),
    ).toBeUndefined();
    expect(tileContext(bare)).toBeUndefined();
  });

  it("breaks a breakable and pushes a boulder only straight ahead", () => {
    expect(tileContext(tile({ living: "breakable" }))).toBe("break");
    expect(tileContext(tile({ living: "pushable", ahead: true }))).toBe("push");
    expect(tileContext(tile({ living: "pushable" }))).toBeUndefined();
  });
});

describe("contextAction", () => {
  it("prefers the tile faced, then the own tile, then the rest", () => {
    const ladder = tile({ facts: { known: true, climb: true } });
    const crate = tile({ living: "breakable" });
    expect(contextAction([crate, ladder])).toEqual({ kind: "break", index: 0 });
    expect(contextAction([bare, ladder, crate])).toEqual({ kind: "climb", index: 1 });
    expect(contextAction([bare, bare, bare, crate])).toEqual({ kind: "break", index: 3 });
  });

  it("has nothing to do on bare ground", () => {
    expect(contextAction([bare, bare])).toBeUndefined();
    expect(contextAction([])).toBeUndefined();
  });
});
