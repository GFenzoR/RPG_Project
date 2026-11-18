// Who attacks and who gets hit, for the creature animations (docs/17 ANI-2, ANI-5). The
// protocol does not say who struck whom yet (ANI-7, task A9: Effect only carries the
// tile), so the client deduces it from what it sees. Pure, with tests.
//   - A ranged attack or a spell with a Projectile: the creature on its `from` tile.
//   - A melee hit (a hit, block or element effect on a tile that no projectile reached in
//     the same batch): the own player if its target is there and it stands next to it;
//     else a creature of the other side next to the tile (monsters strike players, players
//     strike monsters), the one facing the tile first, then the lowest id.
//   - A damage number on a tile: the creature there flashes and is pushed away from its
//     attacker (or back from where it faces).
import { CreatureKind } from "@rpg/protocol";
import type { Direction } from "@rpg/protocol";
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
  if (attacker)
    return [Math.sign(victim.pos.x - attacker.pos.x), Math.sign(victim.pos.y - attacker.pos.y)];
  const [dx, dy] = delta(victim.dir);
  return [-dx || 0, -dy || 0];
}
