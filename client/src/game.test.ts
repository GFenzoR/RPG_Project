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
  TileUpdateSchema,
  DialogOpenSchema,
  ItemCountsSchema,
  PartyAction,
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
  movement: { baseStepMs: 1000, diagonalCost: 1.414, maxPathTiles: 100 },
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
    sex: "female",
    body: "slender",
    skin: "olive",
    hair: "ponytail",
    hairColor: "auburn",
    beard: "none",
  };
  const TOM = {
    sex: "male",
    body: "sturdy",
    skin: "deep",
    hair: "crop",
    hairColor: "grey",
    beard: "full",
  };
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

describe('Game names the remains of a death (docs/02 "Muerte")', () => {
  const FUR = 91;
  const remains = {
    ...content,
    items: {
      1: { ...base, id: "grass", ground: true, walkable: true },
      [FUR]: { ...base, id: "remains_fur", slots: 10, fixed: true, walkable: true },
    },
  } as unknown as ClientContent;
  // The wolf has a name (a monster without one falls back to the family's: item-name.ts).
  const t = (key: string, params?: Record<string, string | number>): string =>
    key === "monster.wolf.name" ? "wolf" : params ? `${key}${JSON.stringify(params)}` : key;
  const NAME = 'client.item.remains_of{"monster":"wolf"}';
  let last: GameUi | undefined;
  let game: InstanceType<typeof Game>;
  /** The Game's private map handlers (what the canvas calls). */
  let map: {
    longPressTile(pos: { x: number; y: number; z: number }, x: number, y: number): void;
    hoverText(pos: { x: number; y: number; z: number }): string;
  };

  beforeEach(() => {
    sent.length = 0;
    last = undefined;
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("document", { body: { classList: { toggle: vi.fn() } } });
    game = new Game({
      host: {} as HTMLElement,
      content: remains,
      t,
      locale: "es",
      sessionToken: "token",
      vocation: "guardian",
      entered: vi.fn(),
      ended: vi.fn(),
      update: (ui) => {
        last = ui;
      },
    });
    map = game as unknown as typeof map;
    deliver?.({
      tick: 1n,
      events: [
        {
          message: {
            case: "tileUpdate",
            value: create(TileUpdateSchema, {
              pos: { x: 5, y: 5, z: 7 },
              tile: {
                items: [{ itemId: 1 }, { itemId: FUR, mods: { remainsOf: "wolf" } }],
              },
            }),
          } as ServerMessage["message"],
        },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("in the title and the card of the tile's menu", () => {
    map.longPressTile({ x: 5, y: 5, z: 7 }, 100, 100);
    expect(last?.menu?.title).toBe(NAME);
    expect(last?.menu?.card?.remainsOf).toBe("wolf");
  });

  it("in the text beside the cursor", () => {
    const hint = map.hoverText({ x: 5, y: 5, z: 7 });
    expect(hint).toContain("client.action.");
    expect(hint).toContain("client.item.remains_of");
    expect(hint).toContain("wolf");
  });
});

describe('Game party invite by name (docs/02 "Grupos")', () => {
  let last: GameUi | undefined;
  let game: InstanceType<typeof Game>;

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the prompt, sends INVITE_NAME with the trimmed name and closes it", () => {
    game.partyInvitePrompt(true);
    expect(last?.partyInviting).toBe(true);
    expect(sent).toEqual([]);
    game.partyInviteByName("  Bruno Holt ");
    expect(sent.map((i) => i.case)).toEqual(["partyCommand"]);
    expect(sent[0]?.value).toMatchObject({ action: PartyAction.INVITE_NAME, name: "Bruno Holt" });
    expect(last?.partyInviting).toBe(false);
  });

  it("sends nothing for an empty name or a cancel", () => {
    game.partyInvitePrompt(true);
    game.partyInviteByName("   ");
    game.partyInvitePrompt(true);
    game.partyInvitePrompt(false);
    expect(sent).toEqual([]);
    expect(last?.partyInviting).toBe(false);
  });
});

describe('Game item hotkeys (docs/02 "Teclas rapidas de items")', () => {
  const potion: ItemDef = {
    ...base,
    id: "potion",
    stackable: true,
    consumable: { healHp: 40, healMp: 0, foodMs: 0 },
  };
  const itemContent = {
    ...content,
    items: {
      ...content.items,
      10: potion,
      11: { ...base, id: "sword", weapon: { type: "sword", attack: 10, defense: 5, hands: 1 } },
      12: { ...base, id: "heal_rune", rune: { spell: "heal_other", charges: 3, magicLevel: 1 } },
      13: { ...base, id: "bolt_rune", rune: { spell: "bolt", charges: 3, magicLevel: 1 } },
    },
    spells: [
      { id: "heal_other", aimsAtPlayer: true, group: "heal", mana: 0, level: 1, vocations: [] },
      { id: "bolt", aimsAtPlayer: false, group: "attack", mana: 0, level: 1, vocations: [] },
    ],
    inventory: { useCooldownMs: 1000 },
  } as unknown as ClientContent;
  let last: GameUi | undefined;
  let game: InstanceType<typeof Game>;
  let keydown: (e: Partial<KeyboardEvent>) => void;

  const press = (code: string, extra: Partial<KeyboardEvent> = {}): void =>
    keydown({ code, repeat: false, preventDefault: vi.fn(), target: null, ...extra });

  beforeEach(() => {
    sent.length = 0;
    last = undefined;
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: typeof keydown) => {
        if (type === "keydown") keydown = fn;
      },
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", { body: { classList: { toggle: vi.fn() } } });
    game = new Game({
      host: {} as HTMLElement,
      content: itemContent,
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

  it("assigns only usable items, and tells the server the types it must count", () => {
    game.setItemKey(0, 10);
    expect(last?.itemKeys).toEqual([10, 0, 0, 0, 0, 0]);
    expect(sent.at(-1)).toMatchObject({ case: "setItemHotkeys", value: { itemIds: [10] } });
    sent.length = 0;
    game.setItemKey(1, 11); // a sword
    game.setItemKey(2, 99); // unknown
    game.setItemKey(9, 10); // no such slot
    expect(sent).toEqual([]);
    expect(last?.itemKeys).toEqual([10, 0, 0, 0, 0, 0]);
    game.setItemKey(3, 10); // the same type moves
    expect(last?.itemKeys).toEqual([0, 0, 0, 10, 0, 0]);
    game.swapItemKeys(3, 1);
    expect(last?.itemKeys).toEqual([0, 10, 0, 0, 0, 0]);
    game.setItemKey(1, 0);
    expect(sent.at(-1)).toMatchObject({ case: "setItemHotkeys", value: { itemIds: [] } });
  });

  it("uses the type by key without saying where it is", () => {
    game.setItemKey(1, 10);
    sent.length = 0;
    press("Digit2");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ case: "useItemType", value: { itemId: 10 } });
    press("Digit2", { repeat: true }); // a held key does not repeat
    press("Digit3"); // empty slot
    press("Digit7"); // not a slot
    press("Digit2", { ctrlKey: true });
    press("Digit2", { shiftKey: true });
    expect(sent).toHaveLength(1);
    game.useItemKeyTap(1); // a tap on the slot is the same use
    expect(sent).toHaveLength(2);
  });

  it("leaves the digits to an open dialog", () => {
    game.setItemKey(0, 10);
    deliver?.({
      tick: 1n,
      events: [
        {
          message: {
            case: "dialogOpen",
            value: create(DialogOpenSchema, {
              dialogId: 1,
              text: { key: "npc.hello", params: [] },
              options: [{ optionId: 1, text: { key: "opt.one", params: [] } }],
            }),
          },
        },
      ],
    });
    sent.length = 0;
    press("Digit1");
    expect(sent.some((i) => i.case === "useItemType")).toBe(false);
  });

  it("an aimed rune waits for the click and goes by type with its target", () => {
    game.setItemKey(0, 12);
    game.setItemKey(1, 13);
    sent.length = 0;
    press("Digit1");
    expect(sent).toEqual([]); // aiming
    (game as unknown as { click(t: { creature: number }): void }).click({ creature: 77 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      case: "useItemType",
      value: { itemId: 12, to: { target: { case: "creatureId", value: 77 } } },
    });
    sent.length = 0;
    press("Digit2"); // not aimed: at once, on the current target
    expect(sent[0]).toMatchObject({ case: "useItemType", value: { itemId: 13 } });
    expect(sent[0]?.value).not.toHaveProperty("to");
  });

  it("shades a consumable's slot for the shared cooldown", () => {
    game.setItemKey(0, 10);
    expect(game.itemCooldown(10, performance.now())).toBe(0);
    press("Digit1");
    const left = game.itemCooldown(10, performance.now());
    expect(left).toBeGreaterThan(0.9);
    expect(game.itemCooldown(10, performance.now() + 2000)).toBe(0);
    expect(game.itemCooldown(11, performance.now())).toBe(0);
  });

  it("shows the totals the server sends", () => {
    game.setItemKey(0, 10);
    deliver?.({
      tick: 2n,
      events: [
        {
          message: {
            case: "itemCounts",
            value: create(ItemCountsSchema, { counts: [{ itemId: 10, count: 12 }] }),
          },
        },
      ],
    });
    expect(last?.itemCounts.get(10)).toBe(12);
  });
});
