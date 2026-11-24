// The characters screen (docs/02 "Cuentas", owner's request of 2026-11-23): an account
// without characters goes straight to the creation form; one with characters sees its list
// first, with a button that opens the form, and the form has a way back to the list.
// Pure: ui/App.tsx Characters renders what these decide.

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
 * The pieces of vocation's kit that are its own (the class weapon, a shield, ammo): those
 * not in every vocation's kit. The common ones (clothes, food, a poultice) are said once
 * for all of them.
 */
export function ownKit(kits: Record<string, KitEntry[]>, vocation: string): KitEntry[] {
  const all = Object.values(kits);
  const common = (item: string): boolean =>
    all.length > 1 && all.every((k) => k.some((e) => e.item === item));
  return (kits[vocation] ?? []).filter((e) => !common(e.item));
}

/** "name" or "count × name" for a kit entry, with the item's translated name. */
export function kitLabel(e: KitEntry, name: (item: string) => string): string {
  return e.count > 1 ? `${e.count} × ${name(e.item)}` : name(e.item);
}
