// Game wired to a fake connection and no canvas: which intents reach the server. Only what a
// pure state/ module cannot show lives here (docs/02 "Libros y cofres": a book is read
// without asking the server, a chest is asked).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "./net/connection.ts";
import type { ClientContent, ItemDef } from "./content-types.ts";
import type { GameUi } from "./game.ts";
import type { ItemRef } from "./state/items.ts";
import { NO_SOUNDS } from "./audio/cues.ts";

/** Every intent the Game sent, in order (the fake Connection below records them). */
const sent: Intent[] = [];

vi.mock("./net/connection.ts", () => ({
  Connection: class {
    send(intent: Intent): void {
      sent.push(intent);
    }
    logout(): void {}
    close(): void {}
  },
}));
// No PixiJS in a unit test: the canvas starts only after a Welcome, which never comes here.
vi.mock("./render/game-canvas.ts", () => ({ createGameCanvas: vi.fn() }));

const { Game } = await import("./game.ts");

const base: ItemDef = {
  id: "",
  sprite: "",
  ground: false,
  walkable: false,
  blocks: false,
  speed: 100,
  stackable: false,
  slots: 0,
  useWith: false,
};
const content = {
  items: {
    1: {
      ...base,
      id: "lectern_book",
      blocks: true,
      fixed: true,
      book: { title: "book.lectern.title", pages: ["book.lectern.page_1"] },
    },
    2: { ...base, id: "reward_chest", blocks: true, fixed: true, chest: true },
    3: { ...base, id: "blank_book", book: { title: "book.blank.title", pages: [] } },
  },
  monsterSprites: {},
  vocations: ["guardian"],
  spells: [],
  recipes: [],
  movement: { baseStepMs: 1000, diagonalCost: 1.5, maxPathTiles: 100 },
  chat: { maxLength: 255 },
  sounds: NO_SOUNDS,
  islands: [],
  i18n: {},
} as unknown as ClientContent;

/** itemId on top of a tile's ground. */
const onTile = (itemId: number): ItemRef => ({
  itemId,
  stackIndex: 1,
  count: 1,
  loc: { kind: "pos", pos: { x: 10, y: 20, z: 7 } },
});

describe('Game.useItem (docs/02 "Libros y cofres")', () => {
  let last: GameUi | undefined;
  let game: InstanceType<typeof Game>;

  beforeEach(() => {
    sent.length = 0;
    last = undefined;
    // The Game listens to the window's keys and marks the aim on <body>; no DOM here.
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { body: { classList: { toggle: vi.fn() } } });
    game = new Game({
      host: {} as HTMLElement,
      content,
      t: (key) => key,
      locale: "es",
      sessionToken: "token",
      vocation: "guardian",
      entered: vi.fn(),
      ended: vi.fn(),
      update: (ui) => {
        last = ui;
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the reading window on a book and sends nothing", () => {
    game.useItem(onTile(1));
    expect(sent).toEqual([]);
    expect(last?.book?.itemId).toBe(1);
    game.closeBook();
    expect(last?.book).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("asks the server for a chest, and for a book with no pages", () => {
    game.useItem(onTile(2));
    game.useItem(onTile(3));
    expect(sent.map((i) => i.case)).toEqual(["useItem", "useItem"]);
    expect(sent[0]?.value).toMatchObject({ itemId: 2, stackIndex: 1 });
    expect(last?.book).toBeUndefined();
  });
});
