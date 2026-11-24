// Who attacks and who gets hit, and how a creature leaves, for the creature animations
// (docs/17 ANI-2, ANI-5, ANI-7). Pure, with tests.
//
// A server with Welcome.attack_events (A9) says it: CreatureAttack names the attacker and
// its target or area (attackDir, attackerOf), and CreatureDisappear says why a creature
// left (leavesDying). For an older server the client deduces it from what it sees:
//   - A ranged attack or a spell with a Projectile: the creature on its `from` tile.
//   - A melee hit (a hit, block or element effect on a tile that no projectile reached in
//     the same batch): the own player if its target is there and it stands next to it;
//     else a creature of the other side next to the tile (monsters strike players, players
//     strike monsters), the one facing the tile first, then the lowest id.
//   - A damage number on a tile: the creature there flashes and is pushed away from its
//     attacker (or back from where it faces).
import { AttackKind, CreatureKind, DisappearReason } from "@rpg/protocol";
import type { Direction } from "@rpg/protocol";
import { attackActionFor } from "@rpg/renderer";
import type { AttackAction } from "@rpg/renderer";
import { delta } from "../state/geometry.ts";
import type { Pos } from "../state/geometry.ts";

export interface Fighter {
  id: number;
  kind: CreatureKind;
  pos: Pos;
  dir: Direction;
}

/** Effects a melee blow leaves on its victim's tile: hit, block and the 7 elements. */
export const isBlowEffect = (effectId: number): boolean =>
  effectId === 1 || effectId === 2 || (effectId >= 10 && effectId <= 16);

const adjacent = (a: Pos, b: Pos): boolean =>
  a.z === b.z && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) === 1;

const isPlayer = (k: CreatureKind): boolean => k === CreatureKind.PLAYER;

/** Faces `at` from `from`: its facing points at that tile (diagonals included). */
export function faces(f: Fighter, at: Pos): boolean {
  const [dx, dy] = delta(f.dir);
  return f.pos.x + dx === at.x && f.pos.y + dy === at.y;
}

/** The creature that struck `victim` in melee, as far as the client can tell. */
export function meleeAttacker(
  victim: Fighter,
  creatures: Iterable<Fighter>,
  selfId: number | undefined,
  target: number | undefined,
): Fighter | undefined {
  if (victim.kind === CreatureKind.NPC) return undefined;
  let best: Fighter | undefined;
  let bestScore = -1;
  for (const c of creatures) {
    if (c.id === victim.id || !adjacent(c.pos, victim.pos) || c.kind === CreatureKind.NPC) continue;
    const own = c.id === selfId && target === victim.id;
    // Players strike monsters and monsters strike players; PvP needs the own target.
    if (!own && isPlayer(c.kind) === isPlayer(victim.kind)) continue;
    const score = own ? 3 : faces(c, victim.pos) ? 2 : 1;
    if (score > bestScore || (score === bestScore && best !== undefined && c.id < best.id)) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Unit push for a hit on `victim`: away from its attacker, else back from its facing. */
export function pushOf(victim: Fighter, attacker: Fighter | undefined): readonly [number, number] {
  return pushFrom(victim, attacker?.pos);
}

/**
 * Unit push for a hit on `victim` from tile `from` (its attacker, or an area's centre):
 * away from it, else (none, or the same tile) back from its facing.
 */
export function pushFrom(victim: Fighter, from: Pos | undefined): readonly [number, number] {
  const px = from ? Math.sign(victim.pos.x - from.x) : 0;
  const py = from ? Math.sign(victim.pos.y - from.y) : 0;
  if (px !== 0 || py !== 0) return [px, py];
  const [dx, dy] = delta(victim.dir);
  return [-dx || 0, -dy || 0];
}

/** A CreatureAttack the client got (state/world.ts `attacks`). */
export interface AttackSeen {
  /** The attacker. */
  id: number;
  kind: AttackKind;
  /** The creature attacked, 0 for an area spell or a target out of the window. */
  targetId: number;
  /** The target's tile, the edge of the window on its side, or the area's centre. */
  to: Pos;
  /** An area spell's radius around `to` (0: one target). */
  radius: number;
  /** When it arrived (the batch's time). */
  start: number;
}

/**
 * Unit direction of an attack from its attacker: the octant of its target where the client
 * draws it, else of `to` (a target far to the east and a tile north is to the east: the
 * attacker turns that way, anim.ts faceTo); an attack on its own tile (an area spell
 * around the caster) goes where the attacker faces.
 */
export function attackDir(
  attacker: Fighter,
  target: Fighter | undefined,
  to: Pos,
): readonly [number, number] {
  const at = target?.pos ?? to;
  const x = at.x - attacker.pos.x;
  const y = at.y - attacker.pos.y;
  const dx = Math.abs(x) * 2 < Math.abs(y) ? 0 : Math.sign(x);
  const dy = Math.abs(y) * 2 < Math.abs(x) ? 0 : Math.sign(y);
  if (dx !== 0 || dy !== 0) return [dx, dy];
  const [fx, fy] = delta(attacker.dir);
  return [fx, fy];
}

/**
 * The clip an attack plays (docs/17 ANI-2): a ranged attack shoots, a spell casts and a
 * melee blow, or a kind this client does not know, swings.
 */
export function attackAction(kind: AttackKind): AttackAction {
  if (kind === AttackKind.RANGED) return "shoot";
  if (kind === AttackKind.SPELL) return "cast";
  return "attack";
}

/** What a paper doll is known to hold: a weapon shape, or none (the bare fist). */
export interface Held {
  weapon: string | undefined;
}

/**
 * The clip a figure's attack plays. A paper doll whose weapon the client knows (an NPC's
 * or a monster's look, the own player's equipment) plays its class's clip
 * (packages/renderer attackActionFor: a bow shoots, a staff casts, a throw without a bow
 * swings). `held` undefined is a weapon the client does not know (another player, until
 * feat/character-look sends its equipment) or a sprite that is no doll: the attack's kind
 * decides (attackAction), so another player's ranged attack still shoots.
 */
export function figureAttack(kind: AttackKind, held: Held | undefined): AttackAction {
  if (!held) return attackAction(kind);
  const k = kind === AttackKind.SPELL ? "spell" : kind === AttackKind.RANGED ? "ranged" : "melee";
  return attackActionFor(k, held.weapon);
}

/** Whether an area of `radius` around `centre` covers `p` (the server's round area). */
export function inArea(centre: Pos, radius: number, p: Pos): boolean {
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  return p.z === centre.z && dx * dx + dy * dy <= radius * radius + radius;
}

/**
 * Whether an area attack of `radius` around `centre` may have hit `p`: its round area
 * (inArea) or one of the 8 lines of that length from the centre. A monster's beam arrives
 * as the circle of its length around the monster (docs/05), and the tip of a diagonal
 * one lies beyond that circle: (4, 4) for a beam of 4.
 */
export function areaCovers(centre: Pos, radius: number, p: Pos): boolean {
  const dx = Math.abs(p.x - centre.x);
  const dy = Math.abs(p.y - centre.y);
  const inLine = dx === 0 || dy === 0 || dx === dy;
  return inArea(centre, radius, p) || (p.z === centre.z && inLine && Math.max(dx, dy) <= radius);
}

/**
 * The attack behind a hit on `victim` that arrived at `start`: an attack of that batch
 * aimed at it, else an area of that batch that covers its tile (areaCovers: a beam's
 * diagonal tip too).
 */
export function attackerOf(
  victim: Fighter,
  attacks: Iterable<AttackSeen>,
  start: number,
): AttackSeen | undefined {
  let area: AttackSeen | undefined;
  for (const a of attacks) {
    if (a.start !== start) continue;
    if (a.targetId === victim.id) return a;
    if (!area && a.radius > 0 && a.id !== victim.id && areaCovers(a.to, a.radius, victim.pos))
      area = a;
  }
  return area;
}

/**
 * Whether a creature that left the view fell there: the server's reason says so (a
 * DEATH); without one (an older server, or a reason no longer at hand) an empty health
 * bar does, as the server sends CreatureHealth 0 before a death.
 */
export function leavesDying(reason: DisappearReason | undefined, health: number): boolean {
  if (reason === undefined || reason === DisappearReason.UNSPECIFIED) return health <= 0;
  return reason === DisappearReason.DEATH;
}

/**
 * How a creature that left the view goes (docs/17 ANI-7): it falls where it died (a
 * DEATH, or an older server's empty bar: leavesDying), shimmers away where it was after a
 * TELEPORT or a LOGOUT (never the fall), and otherwise goes at once (OUT_OF_VIEW, DESPAWN).
 */
export type LeaveStyle = "fall" | "vanish" | "drop";

export function leaveStyle(reason: DisappearReason | undefined, health: number): LeaveStyle {
  if (leavesDying(reason, health)) return "fall";
  return reason === DisappearReason.TELEPORT || reason === DisappearReason.LOGOUT
    ? "vanish"
    : "drop";
}

/** A CreatureDisappear the client got (state/world.ts `departures`). */
export interface DepartureSeen {
  id: number;
  reason: DisappearReason;
  /** When it arrived (the batch's time). */
  start: number;
}

/**
 * The departures not played yet, each once, by arrival: the canvas plays every one where
 * its creature was drawn, also when the creature is already back in view (a player that
 * died and woke up at a temple in view: the same id leaves and comes back in one batch).
 * take() reuses one array, so a frame makes no garbage (docs/07).
 */
export class DepartureFeed {
  private seen = Number.NEGATIVE_INFINITY;
  private readonly fresh: DepartureSeen[] = [];

  /** The departures of `list` that arrived since the last call, oldest first. */
  take(list: readonly DepartureSeen[]): readonly DepartureSeen[] {
    this.fresh.length = 0;
    let newest = this.seen;
    for (const d of list) {
      if (d.start <= this.seen) continue;
      newest = Math.max(newest, d.start);
      this.fresh.push(d);
    }
    this.seen = newest;
    return this.fresh;
  }
}
