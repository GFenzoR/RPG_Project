// The on-screen targeting buttons (lote 21, docs/15): "attack nearest" and "next target"
// over the battle list (closest first). Only monsters: a button never picks a player, so a
// thumb cannot start a PvP fight by accident (a player is attacked by tapping it).

export interface Targetable {
  id: number;
  /** A monster: the only kind the buttons pick. */
  monster: boolean;
}

/** The closest monster of the battle list, or undefined when there is none. */
export function nearestTarget(list: readonly Targetable[]): number | undefined {
  return list.find((c) => c.monster)?.id;
}

/**
 * The monster after the current target in the battle list, round and round; the nearest
 * one when nothing (or something no longer listed, or a player) is targeted. Undefined
 * when there is no monster, or the only one is already the target.
 */
export function nextTarget(
  list: readonly Targetable[],
  current: number | undefined,
): number | undefined {
  const monsters = list.filter((c) => c.monster);
  if (monsters.length === 0) return undefined;
  const i = monsters.findIndex((c) => c.id === current);
  if (i < 0) return monsters[0]?.id;
  if (monsters.length === 1) return undefined;
  return monsters[(i + 1) % monsters.length]?.id;
}
