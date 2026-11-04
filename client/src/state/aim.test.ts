import { describe, expect, it } from "vitest";
import { afterCast, afterUse, resolveClick } from "./aim.ts";
import type { Pending } from "./aim.ts";

const tile = { pos: { x: 3, y: 4, z: 7 } };
const wolf = { creature: 42 };
const rod = "fishing_rod";

describe("crosshair", () => {
  it("an aimed heal waits for the click and is cast on the creature or tile", () => {
    const p = afterCast<string>("mend_other", true);
    expect(resolveClick(p, wolf)).toEqual({
      kind: "castOnCreature",
      spellId: "mend_other",
      creature: 42,
    });
    expect(resolveClick(p, tile)).toEqual({
      kind: "castOnTile",
      spellId: "mend_other",
      pos: tile.pos,
    });
  });

  it("F3 then F1: the plain cast drops the aim, so a click on a creature attacks", () => {
    // Every cast sets what is pending from scratch: F1 after F3 leaves nothing.
    const steps: Pending<string>[] = [
      afterCast("mend_other", true),
      afterCast("frost_lance", false),
    ];
    expect(resolveClick(steps.at(-1), wolf)).toEqual({ kind: "attack", creature: 42 });
  });

  it("F3 then using a rod: the click on a tile uses the rod there", () => {
    const steps: Pending<string>[] = [afterCast("mend_other", true), afterUse(rod, true)];
    expect(resolveClick(steps.at(-1), tile)).toEqual({ kind: "useOn", ref: rod, pos: tile.pos });
  });

  it("aiming after a tool replaces it; a plain use drops both", () => {
    expect(resolveClick(afterCast("mend_other", true), tile).kind).toBe("castOnTile");
    expect(resolveClick(afterUse(rod, false), tile)).toEqual({ kind: "walk", pos: tile.pos });
  });

  it("a tool cancelled by a click on a creature does nothing", () => {
    expect(resolveClick(afterUse(rod, true), wolf)).toEqual({ kind: "none" });
  });
});
