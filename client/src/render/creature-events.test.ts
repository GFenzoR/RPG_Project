import { CreatureKind, Direction } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import { faces, isBlowEffect, meleeAttacker, pushOf } from "./creature-events.ts";
import type { Fighter } from "./creature-events.ts";

const at = (x: number, y: number): { x: number; y: number; z: number } => ({ x, y, z: 7 });
const fighter = (
  id: number,
  kind: CreatureKind,
  x: number,
  y: number,
  dir = Direction.SOUTH,
): Fighter => ({ id, kind, pos: at(x, y), dir });

const SELF = 1;
const wolf = fighter(10, CreatureKind.MONSTER, 5, 5);

describe("who strikes whom", () => {
  it("counts hits, blocks and element effects as blows, not heals or harvests", () => {
    expect([1, 2, 10, 16].every(isBlowEffect)).toBe(true);
    expect([3, 4, 5, 6, 7, 17].some(isBlowEffect)).toBe(false);
  });

  it("is the own player when it targets the victim and stands next to it", () => {
    const self = fighter(SELF, CreatureKind.PLAYER, 4, 5, Direction.NORTH);
    const other = fighter(2, CreatureKind.PLAYER, 6, 5, Direction.WEST);
    expect(meleeAttacker(wolf, [self, other, wolf], SELF, wolf.id)).toBe(self);
    // Another target: the player facing the wolf.
    expect(meleeAttacker(wolf, [self, other, wolf], SELF, 99)).toBe(other);
  });

  it("is a monster next to a player, the one facing it first", () => {
    const self = fighter(SELF, CreatureKind.PLAYER, 5, 5);
    const rat = fighter(11, CreatureKind.MONSTER, 4, 4, Direction.SOUTH_EAST);
    const bat = fighter(12, CreatureKind.MONSTER, 6, 6, Direction.NORTH);
    const far = fighter(13, CreatureKind.MONSTER, 7, 5, Direction.WEST);
    expect(faces(rat, self.pos)).toBe(true);
    expect(meleeAttacker(self, [bat, far, rat, self], SELF, undefined)).toBe(rat);
    expect(meleeAttacker(self, [bat, far, self], SELF, undefined)).toBe(bat);
    expect(meleeAttacker(self, [far, self], SELF, undefined)).toBeUndefined();
  });

  it("never blames NPCs, monsters for monsters, or strangers in PvP", () => {
    const npc = fighter(20, CreatureKind.NPC, 4, 5);
    const ally = fighter(14, CreatureKind.MONSTER, 6, 5, Direction.WEST);
    const p1 = fighter(2, CreatureKind.PLAYER, 1, 1);
    const p2 = fighter(3, CreatureKind.PLAYER, 2, 1, Direction.WEST);
    expect(meleeAttacker(wolf, [npc, ally, wolf], SELF, undefined)).toBeUndefined();
    expect(meleeAttacker(p1, [p2, p1], SELF, undefined)).toBeUndefined();
    expect(meleeAttacker(npc, [wolf], SELF, undefined)).toBeUndefined();
  });

  it("pushes the victim away from its attacker, or back from its facing", () => {
    const self = fighter(SELF, CreatureKind.PLAYER, 4, 6);
    expect(pushOf(wolf, self)).toEqual([1, -1]);
    expect(pushOf(fighter(5, CreatureKind.MONSTER, 0, 0, Direction.EAST), undefined)).toEqual([
      -1, 0,
    ]);
  });
});
