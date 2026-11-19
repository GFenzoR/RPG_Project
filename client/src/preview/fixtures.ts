// Made-up game states for the UI preview (src/preview/main.tsx): a character with items,
// creatures in view, a party, a guild, chat and log lines. Only for looking at the UI
// without a server (make ui-preview); nothing here reaches the game.
import {
  CreatureKind,
  Direction,
  EquipmentSlot,
  GuildRank,
  MessageKind,
  SharedExperience,
} from "@rpg/protocol";
import type { Skull, TextParam } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import type { GameUi } from "../game.ts";
import type { CreatureState, ItemView } from "../state/world.ts";
import { emptyGameUi } from "../ui/GameView.tsx";
import { itemCard } from "../state/item-card.ts";
import type { QuestEntryView, QuestLogView } from "../state/quests.ts";

/** Numeric id of an item by its content id (0 when the item is gone from data/). */
export function itemNumber(content: ClientContent, id: string): number {
  for (const [n, def] of Object.entries(content.items)) if (def.id === id) return Number(n);
  return 0;
}

const param = (name: string, value: TextParam["value"]): TextParam =>
  ({ name, value }) as unknown as TextParam;

function creature(
  id: number,
  kind: CreatureKind,
  name: string,
  contentId: string,
  health: number,
): CreatureState {
  return {
    id,
    kind,
    name,
    contentId,
    pos: { x: 0, y: 0, z: 7 },
    dir: Direction.SOUTH,
    speed: 200,
    health,
    walk: undefined,
    guild: "",
    skull: 0 as Skull,
    cosmetics: { outfit: "", color: "", nameEffect: "" },
  } as unknown as CreatureState;
}

export interface Scene {
  ui: GameUi;
  name: string;
}

/** The base: a level 15 guardian in Puerto with a full backpack and a wolf hunt nearby. */
export function baseScene(content: ClientContent, now: number): Scene {
  const ui = emptyGameUi();
  const item = (id: string, count = 1): ItemView => ({ itemId: itemNumber(content, id), count });
  // An equipable carries its rolled attribute (docs/02 "Atributos de items").
  const rolled = (id: string, attribute: string, value: number): ItemView => ({
    ...item(id),
    mods: { attribute, value, refine: 0 },
  });
  ui.stats = {
    health: 312,
    maxHealth: 420,
    mana: 96,
    maxMana: 180,
    level: 15,
    experience: 35280,
    levelPercent: 62,
    capacity: 41250,
    maxCapacity: 66000,
    speed: 230,
  };
  ui.selfName = "Aldric Varn";
  ui.selfId = 1;
  ui.skills = [
    ["fist", 12, 40],
    ["sword", 24, 71],
    ["shield", 21, 18],
    ["distance", 10, 5],
    ["magic", 3, 55],
    ["fishing", 14, 90],
    ["mining", 8, 22],
    ["cooking", 6, 0],
  ].map(([id, level, percent]) => ({
    id: String(id),
    level: Number(level),
    percent: Number(percent),
  })) as GameUi["skills"];
  // Every slot filled with the engine's item icons (docs/17 "Íconos de items"): the level 15
  // pieces of the catalog's band 3 and the iron sword of band 2.
  ui.inventory = new Map([
    [EquipmentSlot.HEAD, rolled("stagleather_hood", "max_health", 14)],
    [EquipmentSlot.NECK, item("antler_amulet")],
    [EquipmentSlot.BACKPACK, item("backpack")],
    [EquipmentSlot.ARMOR, item("stagleather_coat")],
    [EquipmentSlot.LEFT_HAND, rolled("elmwood_shield", "defense", 2)],
    [EquipmentSlot.RIGHT_HAND, rolled("iron_sword", "attack", 2)],
    [EquipmentSlot.LEGS, item("stagleather_leggings")],
    [EquipmentSlot.FEET, rolled("stagleather_boots", "speed", 4)],
    [EquipmentSlot.RING, item("briar_ring")],
    [EquipmentSlot.AMMO, item("arrow", 37)],
  ]);
  // docs/17 UI-5: the equipped backpack, open under the figure (not in a window).
  ui.backpack = {
    id: 1,
    itemId: itemNumber(content, "backpack"),
    capacity: 20,
    hasParent: false,
    items: [
      item("rope"),
      item("pickaxe"),
      item("ship_biscuit", 7),
      item("raw_fish", 12),
      item("copper_coin", 86),
      item("felling_axe"),
      // A quest item: the gold ring of its colour (docs/17 UI-6).
      item("smuggler_tally", 3),
      item("boarding_saber"),
      // Pieces of the next bands, waiting in the backpack.
      item("embersteel_helm"),
      item("smuggler_crossbow"),
      item("bolt", 24),
      item("cinder_amulet"),
    ],
  };
  ui.containers = [];
  ui.battle = [
    creature(11, CreatureKind.MONSTER, "", "wolf", 64),
    creature(12, CreatureKind.MONSTER, "", "wolf", 100),
    creature(13, CreatureKind.PLAYER, "Brisa Molina", "", 88),
    creature(14, CreatureKind.MONSTER, "", "bilge_rat", 30),
  ];
  ui.target = 11;
  ui.hotkeys = Array.from({ length: 12 }, (_, i) => content.spells[i]?.id);
  ui.hotkeys[5] = undefined;
  ui.chat = [
    {
      kind: MessageKind.SAY,
      speakerName: "Brisa Molina",
      speakerContentId: "",
      text: "¿Vamos a los lobos del norte?",
      localized: undefined,
      at: now - 9000,
    },
    {
      kind: MessageKind.SAY,
      speakerName: "Aldric Varn",
      speakerContentId: "",
      text: "Voy, llevo galletas y vendas.",
      localized: undefined,
      at: now - 7000,
    },
    {
      kind: MessageKind.PARTY,
      speakerName: "Brisa Molina",
      speakerContentId: "",
      text: "Te espero en la puerta norte.",
      localized: undefined,
      at: now - 5000,
    },
    {
      kind: MessageKind.GUILD,
      speakerName: "Corvo",
      speakerContentId: "",
      text: "Cacería al amanecer, no falten.",
      localized: undefined,
      at: now - 3000,
    },
  ] as GameUi["chat"];
  ui.log = [
    {
      key: "progress.skill_up",
      params: [
        param("skill", { case: "contentId", value: "sword" }),
        param("level", { case: "number", value: 24n }),
      ],
      at: now - 1200,
    },
  ];
  ui.party = {
    leaderId: 1,
    shared: SharedExperience.ACTIVE,
    members: [
      {
        id: 1,
        name: "Aldric Varn",
        vocation: "guardian",
        level: 15,
        inView: true,
        health: 74,
        mana: 53,
        island: "puerto",
        sharing: true,
      },
      {
        id: 13,
        name: "Brisa Molina",
        vocation: "ranger",
        level: 14,
        inView: true,
        health: 88,
        mana: 61,
        island: "puerto",
        sharing: true,
      },
      {
        id: 21,
        name: "Tomás Rial",
        vocation: "arcanist",
        level: 16,
        inView: false,
        health: 0,
        mana: 0,
        island: "bosque",
        sharing: false,
      },
    ],
  };
  ui.guild = {
    id: 4n,
    name: "Faro Austral",
    motd: "Cacería al amanecer en el bosque. Traigan cuerda.",
    rank: GuildRank.LEADER,
    members: [
      { name: "Aldric Varn", rank: GuildRank.LEADER, online: true },
      { name: "Corvo", rank: GuildRank.VICE, online: true },
      { name: "Brisa Molina", rank: GuildRank.MEMBER, online: true },
      { name: "Tomás Rial", rank: GuildRank.MEMBER, online: false },
    ],
    pending: [{ name: "Lía Puerto", until: now + 30 * 3600 * 1000 }],
    wars: [],
  };
  ui.cosmetics = {
    owned: ["outfit_sailor", "name_frost"],
    balance: 120,
    equipped: { outfit: "", color: "", nameEffect: "" },
  };
  ui.conditions = [{ id: "well_fed", until: now + 60_000, ticks: 0 }];
  ui.quests = questLog(Date.now());
  ui.clockOffset = 0;
  return { ui, name: "base" };
}

/**
 * The quest log of the preview (docs/02 "Diario de misiones"), at wall clock time `at`:
 * two quests in progress (a kill step 5/8 of chapter 2 and a side quest's item), chapter
 * 1 done, the sandbox task cooling down for 2 h 14 min and a finished task back already.
 */
export function questLog(at: number): QuestLogView {
  const entry = (e: Partial<QuestEntryView> & Pick<QuestEntryView, "id">): QuestEntryView => ({
    name: `quest.${e.id}.name`,
    chapter: 0,
    state: "done",
    stepId: "",
    stepText: "",
    kills: 0,
    killsNeeded: 0,
    repeatable: false,
    availableAt: 0,
    ...e,
  });
  return {
    entries: [
      entry({ id: "ch1_shipwreck", chapter: 1 }),
      entry({
        id: "ch2_roots",
        chapter: 2,
        state: "active",
        stepId: "cull_toads",
        stepText: "quest.ch2_roots.step_cull_toads",
        kills: 5,
        killsNeeded: 8,
      }),
      entry({
        id: "foreman_ore",
        state: "active",
        stepId: "gather_ore",
        stepText: "quest.foreman_ore.step_gather_ore",
      }),
      entry({
        id: "pruebas_rats",
        state: "cooling",
        repeatable: true,
        availableAt: at + (2 * 60 + 14) * 60_000 + 20_000,
      }),
      entry({ id: "diver_locket" }),
    ],
  };
}

/** An NPC dialog with its shop open. */
export function withDialog(content: ClientContent, s: Scene): Scene {
  const ui = { ...s.ui };
  ui.dialog = {
    id: 7,
    npcId: 50,
    npcContentId: "puerto_provisioner",
    text: "npc.puerto_provisioner.greet",
    options: [
      { id: 1, text: "dialog.trade", params: [] },
      { id: 2, text: "npc.puerto_provisioner.opt_tools", params: [] },
      { id: 3, text: "npc.puerto_provisioner.opt_gossip", params: [] },
      { id: 4, text: "dialog.bye", params: [] },
    ],
  };
  ui.shop = {
    dialogId: 7,
    npcId: 50,
    money: 86,
    lines: ["rope", "pickaxe", "ship_biscuit", "felling_axe", "raw_fish"].map((id, i) => ({
      itemId: itemNumber(content, id),
      buyPrice: [10, 50, 3, 40, 0][i] ?? 0,
      sellPrice: [0, 0, 0, 0, 2][i] ?? 0,
      owned: [1, 1, 7, 1, 12][i] ?? 0,
    })),
  };
  return { ui, name: "dialog" };
}

/** Low health, poisoned, just levelled up. */
export function withDanger(s: Scene, now: number): Scene {
  const ui = { ...s.ui };
  if (ui.stats) ui.stats = { ...ui.stats, health: 74, mana: 20, level: 16, levelPercent: 3 };
  ui.conditions = [
    { id: "poison", until: now + 9000, ticks: 3 },
    { id: "hasted", until: now + 20_000, ticks: 0 },
  ];
  ui.levelUp = { level: 16, at: now };
  ui.log = [
    ...ui.log,
    {
      key: "progress.level_up",
      params: [
        param("from", { case: "number", value: 15n }),
        param("level", { case: "number", value: 16n }),
      ],
      at: now - 100,
    },
  ];
  return { ui, name: "danger" };
}

/** Dead: the death screen over the map. */
export function withDeath(s: Scene, now: number): Scene {
  const ui = { ...s.ui };
  if (ui.stats) ui.stats = { ...ui.stats, health: 0 };
  ui.death = { experience: 4120, blessings: 0, at: now };
  return { ui, name: "death" };
}

/** The armorer's shop with many items (docs/17 UI-8: categories, a second page). */
export function withShop(content: ClientContent, s: Scene): Scene {
  const ui = { ...s.ui };
  // Mostly equipment, the engine's item icons (docs/17 "Íconos de items"), and a few tools,
  // consumables and runes so every category shows.
  const gear = new Set(["weapon", "armor", "shield", "ammo"]);
  const other = new Set(["tool", "consumable", "rune"]);
  const pick = (kinds: Set<string>, n: number): number[] =>
    Object.entries(content.items)
      .filter(([, d]) => kinds.has(d.kind ?? "") && d.sprite !== "")
      .slice(0, n)
      .map(([id]) => Number(id));
  const ids = [...pick(gear, 24), ...pick(other, 6)];
  ui.dialog = {
    id: 8,
    npcId: 51,
    npcContentId: "puerto_armorer",
    text: "npc.puerto_armorer.greet",
    options: [
      { id: 1, text: "dialog.trade", params: [] },
      { id: 2, text: "npc.puerto_armorer.opt_advice", params: [] },
      { id: 3, text: "npc.puerto_armorer.opt_salvage", params: [] },
      { id: 4, text: "dialog.bye", params: [] },
    ],
  };
  ui.shop = {
    dialogId: 8,
    npcId: 51,
    money: 310,
    lines: ids.map((itemId, i) => ({
      itemId,
      buyPrice: 10 + ((i * 37) % 400),
      sellPrice: 3 + ((i * 13) % 120),
      owned: i % 4 === 0 ? 2 : 0,
    })),
  };
  return { ui, name: "shop" };
}

/** A dialog with 18 options (docs/17 UI-8: they fit without scrolling at 1280x720). */
export function withManyOptions(content: ClientContent, s: Scene): Scene {
  const ui = { ...s.ui };
  const texts = Object.keys(content.i18n["es"] ?? {}).filter((k) => /^npc\.[a-z_]+\.opt_/.test(k));
  const own = texts.filter((k) => k.startsWith("npc.harbor_master."));
  const other = texts.filter((k) => !k.startsWith("npc.harbor_master."));
  const options = [...own, "dialog.ask_travel", ...other]
    .slice(0, 16)
    .map((text, i) => ({ id: i + 1, text, params: [] }));
  options.push(
    { id: 17, text: "dialog.back", params: [] },
    { id: 18, text: "dialog.bye", params: [] },
  );
  ui.dialog = {
    id: 9,
    npcId: 52,
    npcContentId: "harbor_master",
    text: "npc.harbor_master.greet",
    options,
  };
  return { ui, name: "dialog18" };
}

/** The right-click menu of a sword in the backpack, with its card (docs/17 UI-6). */
export function withItemMenu(
  content: ClientContent,
  s: Scene,
  name: (id: string) => string,
  at: { x: number; y: number },
): Scene {
  const id = itemNumber(content, "boarding_saber");
  const card = itemCard(
    content.items[id],
    id,
    1,
    { level: 9, vocation: "guardian" },
    { attribute: "sword_skill", value: 2, refine: 0 },
    content.attributes,
  );
  const ui: GameUi = {
    ...s.ui,
    menu: {
      ...at,
      title: name("boarding_saber"),
      actions: ["equip", "look", "move"],
      card,
      mouse: true,
      stack: 1,
    },
  };
  return { ui, name: "itemmenu" };
}

/**
 * docs/17 UI-5: the server's windows as GameWindows (a crafting station and a trade) and two
 * corpses opened on the map (the first where the player left it, the second at its default
 * place, right under the equipment), with the Shift+drag split prompt and the card of an
 * item lying on the map under a resting mouse (docs/17 UI-6).
 */
export function withServerWindows(
  content: ClientContent,
  s: Scene,
  at: { x: number; y: number },
): Scene {
  const id = (name: string): number => itemNumber(content, name);
  const ui: GameUi = {
    ...s.ui,
    station: {
      pos: { x: 3160, y: 6380, z: 7 },
      itemId: id("cooking_hearth"),
      owned: new Map([[id("raw_fish"), 12]]),
      tools: new Set(),
    },
    trade: {
      partnerId: 13,
      partnerName: "Brisa Molina",
      invited: false,
      negotiating: true,
      own: [{ itemId: id("raw_fish"), count: 5 }],
      partner: [{ itemId: id("copper_coin"), count: 20 }],
      ownAccepted: false,
      partnerAccepted: true,
      maxItems: 8,
    },
    containers: [
      ...s.ui.containers,
      {
        id: 2,
        itemId: id("creature_remains"),
        capacity: 8,
        hasParent: true,
        items: [{ itemId: id("ship_biscuit"), count: 4 }],
      },
      {
        id: 3,
        itemId: id("creature_remains"),
        capacity: 8,
        hasParent: true,
        items: [{ itemId: id("copper_coin"), count: 7 }],
      },
    ],
    split: { x: at.x, y: at.y, itemId: id("raw_fish"), count: 12 },
  };
  return { ui, name: "server" };
}

/**
 * A new character in Puerto's tutorial (T4.2), at the step that opens the backpack: the
 * backpack is not open under the figure (it does not open by itself during the tutorial),
 * so the equipment's window is short, as in the e2e's 43-tutorial-shop-960 and
 * 44-controls-help-960 (docs/17 UI-5: the dialog gives way down to its foot; the hint
 * gives way to the help).
 */
export function withTutorial(s: Scene): Scene {
  const ui: GameUi = {
    ...s.ui,
    backpack: undefined,
    tutorial: {
      stepId: "open_backpack",
      step: 3,
      total: 6,
      text: "tutorial.step.open_backpack",
      highlight: "inventory",
      progress: 0,
      count: 1,
    },
  };
  return { ui, name: "tutorial" };
}

/**
 * docs/17 UI-5: a trade with the party member who stands just north of the player: the
 * trade opens clear of the tiles north of the player (ui/windows.ts defaultPlace).
 */
export function withTrade(content: ClientContent, s: Scene): Scene {
  const id = (name: string): number => itemNumber(content, name);
  const ui: GameUi = {
    ...s.ui,
    trade: {
      partnerId: 13,
      partnerName: "Brisa Molina",
      invited: false,
      negotiating: true,
      own: [{ itemId: id("raw_fish"), count: 5 }],
      partner: [{ itemId: id("copper_coin"), count: 20 }],
      ownAccepted: false,
      partnerAccepted: true,
      maxItems: 8,
    },
  };
  return { ui, name: "trade" };
}

/**
 * docs/17 UI-10: lines that arrive while the chat shows another tab (a party line, a
 * global one, a local one and a system message): the other tabs get a dot.
 */
export function withLaterChat(s: Scene, now: number): Scene {
  const line = (kind: MessageKind, speakerName: string, text: string) => ({
    kind,
    speakerName,
    speakerContentId: "",
    text,
    localized: undefined,
    at: now,
  });
  const ui: GameUi = {
    ...s.ui,
    chat: [
      ...s.ui.chat,
      line(MessageKind.PARTY, "Brisa Molina", "Llegué a la puerta norte."),
      line(MessageKind.GLOBAL, "Lía Puerto", "Vendo cuerda y galletas en el muelle."),
      line(MessageKind.SAY, "Corvo", "¿Alguien vio al herrero?"),
    ],
    log: [
      ...s.ui.log,
      {
        key: "progress.skill_up",
        params: [
          param("skill", { case: "contentId", value: "shield" }),
          param("level", { case: "number", value: 22n }),
        ],
        at: now,
      },
    ],
  };
  return { ui, name: "chattabs" };
}

/** The card of an item lying on the map, under a resting mouse (docs/17 UI-6). */
export function withGroundTip(
  content: ClientContent,
  s: Scene,
  at: { x: number; y: number },
): Scene {
  const ui: GameUi = {
    ...s.ui,
    groundTip: {
      itemId: itemNumber(content, "iron_sword"),
      count: 1,
      x: at.x,
      y: at.y,
      // The tile under the cursor at the fitted zoom (2x: 64 CSS px).
      tile: { left: at.x - 32, top: at.y - 32, width: 64, height: 64 },
    },
  };
  return { ui, name: "groundtip" };
}

/**
 * docs/17 UI-5: a sword of the backpack dragged over the equipment: the right hand glows (it
 * takes it), the other slots do not (the screenshot script hovers one: it tints red).
 */
export function withHeld(content: ClientContent, s: Scene): Scene {
  const id = itemNumber(content, "boarding_saber");
  const index = s.ui.backpack?.items.findIndex((it) => it.itemId === id) ?? -1;
  const ui: GameUi = {
    ...s.ui,
    dragging: {
      loc: { kind: "container", id: s.ui.backpack?.id ?? 1, index },
      itemId: id,
      stackIndex: index,
      count: 1,
    },
  };
  return { ui, name: "inventory" };
}

/**
 * The forge (docs/02 "Forja"): the anvil's window open with its stones, the amber and the
 * money, smithing 18 (+3 points), a +2 iron sword in hand and a +6 helmet; the screenshot
 * script opens the Forge tab and picks the item (e2e/ui-preview.ts). "result": the last
 * attempt broke a +7 boarding saber (it is gone from the backpack).
 */
export function withForge(
  content: ClientContent,
  s: Scene,
  variant: "pick" | "result",
  now: number,
): Scene {
  const id = (name: string): number => itemNumber(content, name);
  const inventory = new Map(s.ui.inventory);
  const refined = (slot: EquipmentSlot, refine: number): void => {
    const it = inventory.get(slot);
    if (it?.mods) inventory.set(slot, { ...it, mods: { ...it.mods, refine } });
  };
  refined(EquipmentSlot.RIGHT_HAND, 2);
  refined(EquipmentSlot.HEAD, 6);
  const backpack = s.ui.backpack && {
    ...s.ui.backpack,
    items: s.ui.backpack.items.filter(
      (it) => variant !== "result" || it.itemId !== id("boarding_saber"),
    ),
  };
  const ui: GameUi = {
    ...s.ui,
    inventory,
    backpack,
    skills: [...s.ui.skills, { id: "smithing", level: 18, percent: 40 }] as GameUi["skills"],
    station: {
      pos: { x: 3160, y: 6380, z: 7 },
      itemId: id("anvil"),
      owned: new Map([
        [id("lesser_temper_stone"), 12],
        [id("greater_temper_stone"), 9],
        [id("warding_amber"), 2],
        [id("iron_ingot"), 4],
      ]),
      tools: new Set(["smithing"]),
      money: 4860,
    },
    refine:
      variant === "result"
        ? {
            outcome: "broken",
            level: 0,
            itemId: id("boarding_saber"),
            mods: undefined,
            from: 7,
            at: now,
          }
        : undefined,
  };
  return { ui, name: `forge-${variant}` };
}

/**
 * docs/02 "Libros y cofres": the reading window on a book of the islands (the lectern of the
 * Lantern's temple, three pages) or a scroll (the manifest of the wreck, two pages).
 */
export function withBook(content: ClientContent, s: Scene, item: string): Scene {
  return { ui: { ...s.ui, book: { itemId: itemNumber(content, item), at: 0 } }, name: item };
}
