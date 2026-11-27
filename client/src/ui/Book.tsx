// The reading window (docs/02 "Libros y cofres"): the title and pages of a book or scroll,
// one page at a time, with the page number and buttons to turn them. Opened by the client
// on its own (state/book.ts: the texts are content it has); closing it asks nothing either.
// On the desktop it is a GameWindow of its own (GameView), elsewhere a sheet over the map.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { BookDef, ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { bookOf, turnTo } from "../state/book.ts";

interface BodyProps {
  t: Translate;
  def: BookDef;
  /** The page shown (0-based; kept inside the book). */
  page: number;
  onPage(page: number): void;
}

/** One page and, with more than one, the page number between the buttons that turn them. */
export function BookBody({ t, def, page, onPage }: BodyProps): JSX.Element {
  const n = def.pages.length;
  const at = turnTo(def, page);
  return (
    <div class="book-body">
      <p class="book-page" data-testid="book-page">
        {t(def.pages[at] ?? "")}
      </p>
      {n > 1 && (
        <nav class="book-nav" aria-label={t("client.book.pages")}>
          <button
            type="button"
            data-testid="book-prev"
            disabled={at === 0}
            aria-label={t("client.book.prev")}
            title={t("client.book.prev")}
            onClick={() => onPage(at - 1)}
          >
            ‹
          </button>
          <span class="book-page-number" data-testid="book-page-number">
            {t("client.book.page", { page: at + 1, pages: n })}
          </span>
          <button
            type="button"
            data-testid="book-next"
            disabled={at === n - 1}
            aria-label={t("client.book.next")}
            title={t("client.book.next")}
            onClick={() => onPage(at + 1)}
          >
            ›
          </button>
        </nav>
      )}
    </div>
  );
}

interface Props {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** Inside a GameWindow (the desktop): the frame's title bar names and closes it. */
  framed?: boolean | undefined;
}

/** The title of the reading window: the book's title. */
export function bookTitle(t: Translate, content: ClientContent, itemId: number): string {
  const def = bookOf(content, itemId);
  return def ? t(def.title) : "";
}

/** The window of the book the player reads (ui.book); key it by the item to start at page 1. */
export function BookWindow({ t, content, game, ui, framed }: Props): JSX.Element | null {
  const [page, setPage] = useState(0);
  const def = ui.book ? bookOf(content, ui.book.itemId) : undefined;
  if (!def) return null;
  const title = t(def.title);
  return (
    <section
      class="book"
      data-testid={framed ? undefined : "book"}
      role={framed ? undefined : "dialog"}
      aria-label={title}
    >
      {!framed && (
        <header data-sheet-head="">
          <h2>{title}</h2>
          <button
            type="button"
            class="close"
            aria-label={t("client.book.close")}
            title={t("client.book.close")}
            onClick={() => game?.closeBook()}
          >
            ×
          </button>
        </header>
      )}
      <BookBody t={t} def={def} page={page} onPage={setPage} />
    </section>
  );
}
