// The crosshair (T1.12, T3.1): a "use with" tool or a heal for another player waits for
// the next click on the map. Pure state transitions, so the rules are testable without a
// canvas; `Game` sends what `resolveClick` returns.
import type { Pos } from "./geometry.ts";

/** What waits for the next click: a tool (by its item reference) or an aimed spell. */
export type Pending<R> = { kind: "item"; ref: R } | { kind: "spell"; spellId: string } | undefined;

/** Casting a spell: an aimed one (heal another) waits; any other drops what was pending. */
export function afterCast<R>(spellId: string, aims: boolean): Pending<R> {
  return aims ? { kind: "spell", spellId } : undefined;
}

/** Using an item: a "use with" tool waits; any other use drops what was pending. */
export function afterUse<R>(ref: R, useWith: boolean): Pending<R> {
  return useWith ? { kind: "item", ref } : undefined;
}

export type ClickAction<R> =
  | { kind: "attack"; creature: number }
  | { kind: "walk"; pos: Pos }
  | { kind: "castOnCreature"; spellId: string; creature: number }
  | { kind: "castOnTile"; spellId: string; pos: Pos }
  | { kind: "useOn"; ref: R; pos: Pos }
  | { kind: "none" };

/**
 * What a left click does given what is pending (which the click always consumes): an aimed
 * spell is cast on the creature or tile, a tool is used on the tile (a click on a creature
 * just cancels it), and with nothing pending a creature is attacked and a tile walked to.
 */
export function resolveClick<R>(
  pending: Pending<R>,
  click: { creature: number } | { pos: Pos },
): ClickAction<R> {
  if (pending?.kind === "spell") {
    return "creature" in click
      ? { kind: "castOnCreature", spellId: pending.spellId, creature: click.creature }
      : { kind: "castOnTile", spellId: pending.spellId, pos: click.pos };
  }
  if (pending?.kind === "item") {
    return "pos" in click ? { kind: "useOn", ref: pending.ref, pos: click.pos } : { kind: "none" };
  }
  return "creature" in click
    ? { kind: "attack", creature: click.creature }
    : { kind: "walk", pos: click.pos };
}
