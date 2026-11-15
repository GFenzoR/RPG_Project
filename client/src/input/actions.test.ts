import { EquipmentSlot } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import type { ItemRef } from "../state/items.ts";
import { ItemPicker, itemActions, sameLoc, sameRef, tileActions } from "./actions.ts";

const onTile = (x: number, itemId = 10, stackIndex = 1): ItemRef => ({
  loc: { kind: "pos", pos: { x, y: 5, z: 7 } },
  itemId,
  stackIndex,
  count: 1,
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
    expect(tileActions({ known: false })).toEqual([]);
  });
});

describe("itemActions", () => {
  it("use or open, look, move", () => {
    expect(itemActions(false)).toEqual(["use", "look", "move"]);
    expect(itemActions(true)).toEqual(["open", "look", "move"]);
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
