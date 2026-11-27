import { EquipmentSlot } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ItemRef } from "../state/items.ts";
import {
  ItemPicker,
  defaultAction,
  itemActions,
  itemPrimary,
  sameLoc,
  sameRef,
  tileActions,
} from "./actions.ts";

const onTile = (x: number, itemId = 10, stackIndex = 1): ItemRef => ({
  loc: { kind: "pos", pos: { x, y: 5, z: 7 } },
  itemId,
  stackIndex,
  count: 1,
});

describe("defaultAction (the text beside the cursor, docs/17 MOV-7)", () => {
  it("is the menu's first button, but never just looking", () => {
    expect(defaultAction({ creature: { npc: false, self: false }, known: true })).toBe("attack");
    expect(defaultAction({ creature: { npc: true, self: false }, known: true })).toBe("talk");
    expect(defaultAction({ known: true, door: true, climb: true })).toBe("climb");
    expect(defaultAction({ item: { container: true, fixed: true }, known: true })).toBe("open");
    expect(defaultAction({ item: { container: false, food: true }, known: true })).toBe("eat");
    expect(defaultAction({ known: true, door: true })).toBe("use");
    expect(defaultAction({ known: true })).toBeUndefined();
    expect(defaultAction({ creature: { npc: false, self: true }, known: true })).toBeUndefined();
    expect(defaultAction({ known: false })).toBeUndefined();
  });

  it("says nothing of a fixture that does nothing when used (a tree), but a station's use", () => {
    expect(defaultAction({ item: { container: false, fixed: true }, known: true })).toBeUndefined();
    expect(
      defaultAction({ item: { container: false, fixed: true, usable: true }, known: true }),
    ).toBe("use");
    expect(defaultAction({ item: { container: false }, known: true })).toBe("use"); // loose
  });

  it('reads a book or scroll and opens a reward chest (docs/02 "Libros y cofres")', () => {
    const book = { container: false, fixed: true, usable: true, book: true };
    const chest = { container: false, fixed: true, usable: true, chest: true };
    expect(defaultAction({ item: book, known: true })).toBe("read");
    expect(defaultAction({ item: chest, known: true })).toBe("open");
    expect(itemPrimary({ container: false, book: true })).toBe("read");
    expect(tileActions({ item: chest, known: true })).toEqual(["open", "look"]);
  });
});

describe("tileActions", () => {
  it("a monster is attacked, an NPC talked to, the own creature neither", () => {
    expect(tileActions({ creature: { npc: false, self: false }, known: true })).toEqual([
      "attack",
      "look",
    ]);
    expect(tileActions({ creature: { npc: true, self: false }, known: true })).toEqual([
      "talk",
      "look",
    ]);
    expect(tileActions({ creature: { npc: false, self: true }, known: true })).toEqual(["look"]);
  });

  it("an item is used (a container opened), looked at and moved", () => {
    expect(tileActions({ item: { container: false }, known: true })).toEqual([
      "use",
      "look",
      "move",
    ]);
    expect(tileActions({ item: { container: true }, known: true })).toEqual([
      "open",
      "look",
      "move",
    ]);
    expect(
      tileActions({
        creature: { npc: false, self: false },
        item: { container: false },
        known: true,
      }),
    ).toEqual(["attack", "use", "look", "move"]);
  });

  it("bare ground is only looked at, a bare house door also used, an unknown tile nothing", () => {
    expect(tileActions({ known: true })).toEqual(["look"]);
    expect(tileActions({ known: true, door: true })).toEqual(["use", "look"]);
  });

  it("a ladder is climbed first, and what lies on it keeps its buttons", () => {
    expect(tileActions({ known: true, door: true, climb: true })).toEqual(["climb", "look"]);
    expect(tileActions({ item: { container: true }, known: true, climb: true })).toEqual([
      "climb",
      "open",
      "look",
      "move",
    ]);
    expect(tileActions({ known: false })).toEqual([]);
  });
});

describe("itemActions", () => {
  it("use or open, look, move", () => {
    expect(itemActions({ container: false })).toEqual(["use", "look", "move"]);
    expect(itemActions({ container: true })).toEqual(["open", "look", "move"]);
  });

  it("docs/17 UI-6: the default action first (use with, eat, equip), and part of a stack", () => {
    expect(itemActions({ container: false, useWith: true })).toEqual(["use_with", "look", "move"]);
    expect(itemActions({ container: false, food: true, split: true })).toEqual([
      "eat",
      "look",
      "move",
      "split",
    ]);
    expect(itemActions({ container: false, equip: true })).toEqual(["equip", "look", "move"]);
    // A container wins: a backpack opens even where it could be worn.
    expect(itemPrimary({ container: true, equip: true })).toBe("open");
  });

  it("food, potions and runes also offer a quick key, after the rest", () => {
    expect(itemActions({ container: false, food: true, hotkey: true })).toEqual([
      "eat",
      "look",
      "move",
      "hotkey",
    ]);
    expect(itemActions({ container: false, hotkey: true, split: true })).toEqual([
      "use",
      "look",
      "move",
      "split",
      "hotkey",
    ]);
    // A tile's menu never does: a quick key is for what is carried.
    expect(
      tileActions({ item: { container: false, food: true, hotkey: true }, known: true }),
    ).toEqual(["eat", "look", "move"]);
  });

  it("a fixture (a station, a board) is used and looked at, never moved", () => {
    expect(tileActions({ item: { container: false, fixed: true }, known: true })).toEqual([
      "use",
      "look",
    ]);
  });

  it("a tile's item gets the same default action and its split", () => {
    expect(
      tileActions({ item: { container: false, food: true, split: true }, known: true }),
    ).toEqual(["eat", "look", "move", "split"]);
  });
});

describe("sameRef / sameLoc", () => {
  it("compares place, item and stack index", () => {
    expect(sameRef(onTile(1), onTile(1))).toBe(true);
    expect(sameRef(onTile(1), onTile(2))).toBe(false);
    expect(sameRef(onTile(1, 10), onTile(1, 11))).toBe(false);
    expect(sameRef(onTile(1, 10, 1), onTile(1, 10, 2))).toBe(false);
    expect(
      sameLoc(
        { kind: "slot", slot: EquipmentSlot.HEAD },
        { kind: "slot", slot: EquipmentSlot.HEAD },
      ),
    ).toBe(true);
    expect(
      sameLoc({ kind: "slot", slot: EquipmentSlot.HEAD }, { kind: "container", id: 1, index: 0 }),
    ).toBe(false);
    expect(
      sameLoc({ kind: "container", id: 1, index: 2 }, { kind: "container", id: 1, index: 2 }),
    ).toBe(true);
    expect(
      sameLoc({ kind: "container", id: 1, index: 2 }, { kind: "container", id: 2, index: 2 }),
    ).toBe(false);
  });
});

describe("ItemPicker", () => {
  it("tap an item, then its destination: one move, and the pick ends", () => {
    const p = new ItemPicker();
    expect(p.place({ kind: "slot", slot: EquipmentSlot.HEAD })).toBeUndefined();
    const ref = onTile(1);
    expect(p.pick(ref)).toBe(ref);
    expect(p.picked).toBe(ref);
    const to = { kind: "container", id: 3, index: 0 } as const;
    expect(p.place(to)).toEqual({ ref, to });
    expect(p.picked).toBeUndefined();
    expect(p.place(to)).toBeUndefined();
  });

  it("tapping the picked item again drops the pick; another item replaces it", () => {
    const p = new ItemPicker();
    p.pick(onTile(1));
    expect(p.pick(onTile(1))).toBeUndefined();
    p.pick(onTile(1));
    const other = onTile(2);
    expect(p.pick(other)).toBe(other);
  });

  it("placing on its own place sends nothing", () => {
    const p = new ItemPicker();
    const ref = onTile(1);
    p.pick(ref);
    expect(p.place({ kind: "pos", pos: { x: 1, y: 5, z: 7 } })).toBeUndefined();
    expect(p.picked).toBeUndefined();
  });

  it("cancel reports whether something was picked", () => {
    const p = new ItemPicker();
    expect(p.cancel()).toBe(false);
    p.pick(onTile(1));
    expect(p.cancel()).toBe(true);
    expect(p.picked).toBeUndefined();
  });
});
