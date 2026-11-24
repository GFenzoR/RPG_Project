// The characters screen (docs/02 "Cuentas", owner's request of 2026-11-23): an account
// without characters goes straight to the creation form; one with characters sees its list
// first, with a button that opens the form, and the form has a way back to the list.
// Pure: ui/App.tsx Characters renders what these decide.

import type { Look } from "@rpg/renderer/look";
import type { LookJSON } from "../net/api.ts";
import { startingLook } from "./look.ts";
import type { LookChoices } from "./look.ts";

/** One entry of a vocation's start_kit (data/vocations.yaml). */
export interface KitEntry {
  item: string;
  count: number;
}

/** Which part of the screen shows. */
export type CharactersView = "list" | "create";

/** The view right after the list loads: the form when there are no characters yet. */
export function firstView(characters: number): CharactersView {
  return characters === 0 ? "create" : "list";
}

/** The form has "Volver" only when there is a list to go back to. */
export function canGoBack(characters: number): boolean {
  return characters > 0;
}

/**
 * Whether the account may create another character: max is the server's per-account
 * limit (GET /api/characters max_characters; 0 or absent: unknown, so allowed and the
 * server decides).
 */
export function canCreate(characters: number, max: number | undefined): boolean {
  return !max || characters < max;
}

/**
 * "Cuenta y seguridad" shows under the list, and under the first character's form too: an
 * account without characters has no list to go back to, and must still be able to change
 * its password or close its sessions. The form opened from the list stays short.
 */
export function showsAccount(view: CharactersView, characters: number): boolean {
  return view === "list" || characters === 0;
}

/**
 * The line of what a vocation starts with: every piece of its start_kit by name, in the
 * data's order (the class weapon first), so the text never says more or less than
 * data/vocations.yaml. Undefined without a kit (or with an empty one): no line.
 */
export function kitLine(
  kits: Record<string, KitEntry[]> | undefined,
  vocation: string,
  name: (item: string) => string,
): string | undefined {
  const kit = kits?.[vocation] ?? [];
  return kit.length > 0 ? kit.map((e) => kitLabel(e, name)).join(", ") : undefined;
}

/** "name" or "count × name" for a kit entry, with the item's translated name. */
export function kitLabel(e: KitEntry, name: (item: string) => string): string {
  return e.count > 1 ? `${e.count} × ${name(e.item)}` : name(e.item);
}

/**
 * The look the list draws for a character: the server's, with every id the client's
 * content no longer has (retired from data/looks.yaml, or a newer server) replaced by the
 * first choice, so the figure never asks the tables for a tint they lack. Without the
 * choices (fixtures) it is the server's as it came.
 */
export function listLook(look: LookJSON, choices: LookChoices | undefined): Look {
  const sent: Look = {
    sex: look.sex,
    body: look.body,
    skin: look.skin,
    hair: look.hair,
    hairColor: look.hair_color,
    beard: look.beard,
  };
  return choices ? startingLook(choices, sent) : sent;
}
