import { AttackKind, CreatureKind, Direction, DisappearReason } from "@rpg/protocol";
import { describe, expect, it } from "vitest";
import {
  attackAction,
  figureAttack,
  attackDir,
  attackerOf,
  faces,
  inArea,
  DepartureFeed,
  isBlowEffect,
  leaveStyle,
  leavesDying,
  meleeAttacker,
  pushFrom,
  pushOf,
} from "./creature-events.ts";
import type { AttackSeen, Fighter } from "./creature-events.ts";

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

// A9: the server says who attacked whom (CreatureAttack) and why a creature left.
const attack = (
  id: number,
  targetId: number,
  to: { x: number; y: number; z: number },
  start: number,
  radius = 0,
): AttackSeen => ({
  id,
  kind: radius > 0 ? AttackKind.SPELL : AttackKind.MELEE,
  targetId,
  to,
  radius,
  start,
});

describe("what the server says", () => {
  it("aims an attack at its target where the client draws it, else at its tile", () => {
    const self = fighter(SELF, CreatureKind.PLAYER, 4, 5);
    // The target moved since: the client's position wins over the tile of the event.
    expect(attackDir(self, fighter(10, CreatureKind.MONSTER, 4, 4), at(5, 5))).toEqual([0, -1]);
    // A target out of the window: the edge point on its side.
    expect(attackDir(self, undefined, at(20, 5))).toEqual([1, 0]);
    // An area around the caster: where it faces.
    expect(
      attackDir(fighter(2, CreatureKind.PLAYER, 3, 3, Direction.WEST), undefined, at(3, 3)),
    ).toEqual([-1, 0]);
  });

  it("finds the attack behind a hit: aimed at the victim, else an area over it, same batch", () => {
    const victim = fighter(10, CreatureKind.MONSTER, 5, 5);
    const ring = attack(SELF, 0, at(4, 4), 100, 2);
    const blow = attack(7, 10, at(5, 5), 100);
    const late = attack(8, 10, at(5, 5), 200);
    expect(attackerOf(victim, [ring, blow, late], 100)).toBe(blow);
    expect(attackerOf(victim, [ring, late], 100)).toBe(ring);
    expect(attackerOf(victim, [late], 100)).toBeUndefined();
    // The caster is not hit by its own area; a tile beyond the radius is not covered.
    expect(attackerOf(fighter(SELF, CreatureKind.PLAYER, 4, 4), [ring], 100)).toBeUndefined();
    expect(inArea(at(4, 4), 2, at(6, 6))).toBe(false);
    expect(inArea(at(4, 4), 2, at(6, 5))).toBe(true);
    expect(inArea(at(4, 4), 2, { x: 5, y: 4, z: 6 })).toBe(false);
  });

  it("finds the monster behind a hit at the diagonal tip of its beam", () => {
    // A beam of 4 arrives as the circle of 4 around the monster: (4, 4) is beyond it.
    const breath = attack(7, 0, at(2, 2), 100, 4);
    const tip = fighter(10, CreatureKind.PLAYER, 6, 6);
    expect(inArea(at(2, 2), 4, tip.pos)).toBe(false);
    expect(attackerOf(tip, [breath], 100)).toBe(breath);
    // Off every line and out of the circle: not that attack's.
    expect(attackerOf(fighter(11, CreatureKind.PLAYER, 6, 5), [breath], 100)).toBeUndefined();
    expect(attackerOf(fighter(12, CreatureKind.PLAYER, 7, 7), [breath], 100)).toBeUndefined();
  });

  it("plays the bow for a ranged attack, the spell for a spell, the swing for a blow", () => {
    expect(attackAction(AttackKind.RANGED)).toBe("shoot");
    expect(attackAction(AttackKind.SPELL)).toBe("cast");
    expect(attackAction(AttackKind.MELEE)).toBe("attack");
    expect(attackAction(AttackKind.UNSPECIFIED)).toBe("attack");
  });

  it("plays a paper doll's weapon when it is known, the attack's kind when it is not", () => {
    // Another player: its equipment does not reach this client yet. A ranged attack shoots,
    // as before the paper dolls, not a punch thrown from afar.
    expect(figureAttack(AttackKind.RANGED, undefined)).toBe("shoot");
    expect(figureAttack(AttackKind.SPELL, undefined)).toBe("cast");
    expect(figureAttack(AttackKind.MELEE, undefined)).toBe("attack");
    // The own player, an NPC or a monster: the weapon in hand decides.
    expect(figureAttack(AttackKind.RANGED, { weapon: "bow" })).toBe("shoot");
    expect(figureAttack(AttackKind.MELEE, { weapon: "staff" })).toBe("cast");
    expect(figureAttack(AttackKind.SPELL, { weapon: "sword" })).toBe("cast");
    // A known blade or bare hands throwing: the overhand swing.
    expect(figureAttack(AttackKind.RANGED, { weapon: "sword" })).toBe("attack");
    expect(figureAttack(AttackKind.RANGED, { weapon: undefined })).toBe("attack");
  });

  it("pushes the victim away from the attacker or the area's centre", () => {
    const victim = fighter(10, CreatureKind.MONSTER, 5, 5, Direction.EAST);
    expect(pushFrom(victim, at(4, 4))).toEqual([1, 1]);
    expect(pushFrom(victim, at(5, 5))).toEqual([-1, 0]); // same tile: back from its facing
    expect(pushFrom(victim, undefined)).toEqual([-1, 0]);
  });

  it("lets a creature fall only when it died; an older server's empty bar still counts", () => {
    expect(leavesDying(DisappearReason.DEATH, 0)).toBe(true);
    expect(leavesDying(DisappearReason.DEATH, 30)).toBe(true);
    for (const r of [
      DisappearReason.OUT_OF_VIEW,
      DisappearReason.TELEPORT,
      DisappearReason.LOGOUT,
      DisappearReason.DESPAWN,
    ])
      expect(leavesDying(r, 0)).toBe(false);
    expect(leavesDying(DisappearReason.UNSPECIFIED, 0)).toBe(true);
    expect(leavesDying(undefined, 0)).toBe(true);
    expect(leavesDying(undefined, 12)).toBe(false);
  });

  it("falls after a death, shimmers away after a teleport or a logout, else just goes", () => {
    expect(leaveStyle(DisappearReason.DEATH, 40)).toBe("fall");
    expect(leaveStyle(DisappearReason.TELEPORT, 0)).toBe("vanish"); // never the fall
    expect(leaveStyle(DisappearReason.LOGOUT, 100)).toBe("vanish");
    expect(leaveStyle(DisappearReason.OUT_OF_VIEW, 0)).toBe("drop");
    expect(leaveStyle(DisappearReason.DESPAWN, 0)).toBe("drop");
    expect(leaveStyle(DisappearReason.UNSPECIFIED, 0)).toBe("fall"); // an older server
    expect(leaveStyle(DisappearReason.UNSPECIFIED, 50)).toBe("drop");
  });

  it("plays each departure once, also when the creature is already back (A9)", () => {
    const feed = new DepartureFeed();
    // A player dies in view and wakes up at a temple in view: the same batch says it died
    // and brings it back. The departure stays in the list (state/world.ts marks it back).
    const died = { id: 6, reason: DisappearReason.DEATH, start: 100, back: true };
    const quit = { id: 7, reason: DisappearReason.LOGOUT, start: 100, back: false };
    const list = [died, quit];
    expect(feed.take(list)).toEqual([died, quit]);
    expect(feed.take(list)).toEqual([]); // the next frame: nothing new
    const moved = { id: 8, reason: DisappearReason.TELEPORT, start: 150, back: false };
    list.push(moved);
    expect(feed.take(list)).toEqual([moved]);
    // The array is reused: a frame makes no garbage.
    expect(feed.take(list)).toBe(feed.take(list));
  });
});
