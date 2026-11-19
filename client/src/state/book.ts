// The reading window (docs/02 "Libros y cofres"): a book or scroll the player uses opens with
// the texts the client already has (its `book` block names i18n keys of books.yaml). The
// server is not asked: the text is static content with nothing to hide, the same for every
// player, like a sign's (which Look reads from any tile in view). Pure, unit-tested.
import type { BookDef, ClientContent } from "../content-types.ts";

/** The book the window shows: the item read, and when it was opened (performance.now()). */
export interface BookState {
  itemId: number;
  at: number;
}

/** The book block of itemId, if it is a readable item with at least one page. */
export function bookOf(content: Pick<ClientContent, "items">, itemId: number): BookDef | undefined {
  const def = content.items[itemId]?.book;
  return def && def.pages.length > 0 ? def : undefined;
}

/** A page index (0-based) kept inside the book. */
export function turnTo(def: BookDef, page: number): number {
  return Math.min(Math.max(Math.trunc(page), 0), def.pages.length - 1);
}
