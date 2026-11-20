// Game wired to a fake connection and no canvas: which intents reach the server. Only what a
// pure state/ module cannot show lives here (docs/02 "Libros y cofres": a book is read
// without asking the server, a chest is asked).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Intent } from "./net/connection.ts";
import type { ClientContent, ItemDef } from "./content-types.ts";
import type { GameUi } from "./game.ts";
import type { ItemRef } from "./state/items.ts";
import { NO_SOUNDS } from "./audio/cues.ts";
import {
  BodyLookSchema,
  CreatureKind,
  CreatureLookSchema,
  CreatureSchema,
  create,
} from "@rpg/protocol";
import type { ServerMessage } from "@rpg/protocol";

/** Every intent the Game sent, in order (the fake Connection below records them). */
const sent: Intent[] = [];
/** The batch handler of the last Connection made: what the server sends. */
let deliver:
  ((batch: { tick: bigint; events: { message: ServerMessage["message"] }[] }) => void) | undefined;

vi.mock("./net/connection.ts", () => ({
  Connection: class {
    constructor(_token: string, _locale: string, handlers: { batch: typeof deliver }) {
      deliver = handlers.batch;
    }
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

describe('Game look draft (docs/02 "Apariencia")', () => {
  const MIRA = {
    body: "slender",
    skin: "olive",
    hair: "ponytail",
    hairColor: "auburn",
    beard: "none",
  };
  const TOM = { body: "sturdy", skin: "deep", hair: "crop", hairColor: "grey", beard: "full" };
  let last: GameUi | undefined;
  let game: InstanceType<typeof Game>;
  const look = (l: typeof MIRA, torso = 0): ServerMessage["message"] => ({
    case: "creatureLook",
    value: create(CreatureLookSchema, {
      id: 7,
      look: create(BodyLookSchema, l),
      equipment: {
        $typeName: "game.v1.VisibleEquipment",
        head: 0,
        torso,
        legs: 0,
        feet: 0,
        leftHand: 0,
        rightHand: 0,
      },
    }),
  });
  const serve = (...m: ServerMessage["message"][]): void =>
    deliver?.({ tick: 1n, events: m.map((message) => ({ message })) });

  beforeEach(() => {
    sent.length = 0;
    last = undefined;
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
    // The player (id 7) appears; no Welcome, so no canvas starts: its id is set by hand.
    (game as unknown as { world: { selfId: number } }).world.selfId = 7;
    serve({
      case: "creatureAppear",
      value: {
        $typeName: "game.v1.CreatureAppear",
        creature: create(CreatureSchema, {
          id: 7,
          kind: CreatureKind.PLAYER,
          name: "Mira",
          pos: { x: 5, y: 5, z: 7 },
          look: create(BodyLookSchema, MIRA),
        }),
      },
    } as ServerMessage["message"]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the draft through other CreatureLooks and drops it once the server applies it", () => {
    game.setLookDraft(TOM);
    serve(look(MIRA, 64)); // a piece of equipment changed while picking
    expect(last?.lookDraft).toEqual(TOM);
    game.applyLook();
    expect(sent.map((i) => i.case)).toEqual(["setLook"]);
    serve(look(TOM, 64)); // the answer
    expect(last?.lookDraft).toBeUndefined();
  });
});
