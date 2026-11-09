// One play session: the WebSocket, the world state, the keyboard and the canvas wired
// together. The client only sends intents (Walk, WalkPath, Turn, Logout) and draws what
// the server says; the one thing it predicts is the next own step.
import { nearStation } from "./state/recipes.ts";
import type { StationState } from "./state/recipes.ts";
import type { PresenceState } from "./state/world.ts";
import type { TutorialView } from "./state/tutorial.ts";
import {
  ChatChannel,
  CreatureKind,
  Direction,
  GuildAction,
  MarketSide,
  PartyAction,
} from "@rpg/protocol";
import type { DisconnectReason, EquipmentSlot, FightStance } from "@rpg/protocol";
import type { ClientContent } from "./content-types.ts";
import type { Translate } from "./i18n/i18n.ts";
import { MovementKeys, typingInField } from "./input/keyboard.ts";
import { cooldownLeft, hotkeySlot, loadHotkeys, saveHotkeys } from "./state/hotkeys.ts";
import { loadSafeMode, saveSafeMode } from "./state/pvp.ts";
import { Connection } from "./net/connection.ts";
import { createGameCanvas } from "./render/game-canvas.ts";
import type { GameCanvas } from "./render/game-canvas.ts";
import { locationInit, topItem } from "./state/items.ts";
import type { ItemLoc, ItemRef } from "./state/items.ts";
import { afterCast, afterUse, resolveClick } from "./state/aim.ts";
import type { Pending } from "./state/aim.ts";
import { findPath } from "./state/path.ts";
import type { Pos } from "./state/geometry.ts";
import { WorldState } from "./state/world.ts";
import { cuesOf, loopFor } from "./audio/cues.ts";
import type { Cue, CueContext } from "./audio/cues.ts";
import type { AudioEngine } from "./audio/engine.ts";
import type { InvitationView, PartyView } from "./state/party.ts";
import type { GuildInvitationView, GuildView } from "./state/guild.ts";
import type { MarketView, TradeView } from "./state/market.ts";
import type {
  ContainerState,
  CreatureState,
  DialogState,
  ItemView,
  DeathState,
  LevelUpState,
  VoyageState,
  ChatLine,
  LogMessage,
  PlayerStatsState,
  ShopState,
  SkillState,
  ConditionView,
} from "./state/world.ts";

/** What the DOM UI shows next to the canvas, refreshed after every server batch. */
export interface GameUi {
  battle: CreatureState[];
  target: number | undefined;
  stats: PlayerStatsState | undefined;
  skills: SkillState[];
  /** The player's own active conditions (T3.2). */
  conditions: ConditionView[];
  levelUp: LevelUpState | undefined;
  /** The last voyage (T3.5), for the fade over the map. */
  voyage: VoyageState | undefined;
  death: DeathState | undefined;
  log: LogMessage[];
  chat: ChatLine[];
  inventory: Map<EquipmentSlot, ItemView>;
  containers: ContainerState[];
  /** Spell ID of each hotkey F1..F12 (undefined = empty). */
  hotkeys: (string | undefined)[];
  /** The open NPC dialog and its shop (T1.10). */
  dialog: DialogState | undefined;
  shop: ShopState | undefined;
  /** The crafting station window (T3.4). */
  station: StationState | undefined;
  /** The trade and market windows (T5.3). */
  trade: TradeView | undefined;
  market: MarketView | undefined;
  /** A presence check waiting for an answer (T4.1), or undefined. */
  presence: PresenceState | undefined;
  /** The tutorial step (T4.2), or undefined when there is none. */
  tutorial: TutorialView | undefined;
  /** The party and the invitations not answered yet (T3.3). */
  party: PartyView | undefined;
  invitations: InvitationView[];
  /** The guild and the invitations to one (T5.1). */
  guild: GuildView | undefined;
  /** The safe mode switch (T5.2). */
  safeMode: boolean;
  guildInvitations: GuildInvitationView[];
  /** The player's own name (to tell itself apart in the guild's member list). */
  selfName: string;
  selfId: number;
}

/** Read-only hooks for the E2E tests (client/e2e). */
export interface ClientTestHooks {
  /** The first FullMapView arrived and the canvas is drawing. */
  ready: boolean;
  self(): { x: number; y: number; z: number; pending: boolean; walking: boolean } | undefined;
  walkable(x: number, y: number, z: number): boolean;
  tileToClient(x: number, y: number): { x: number; y: number };
  scale(): number;
  /** The battle list as [id, contentId, health %]. */
  battle(): { id: number; contentId: string; health: number }[];
  target(): number | undefined;
  stats(): PlayerStatsState | undefined;
  skills(): SkillState[];
  /** Floating texts that appeared less than `ms` ago. */
  floatingTexts(ms: number): number;
  /** Equipped items as [slot, item ID, count]. */
  inventory(): { slot: number; itemId: number; count: number }[];
  /** Open containers with their content. */
  containers(): ContainerState[];
  /** Item IDs of a known tile, ground first. */
  tile(x: number, y: number, z: number): readonly number[] | undefined;
  /** Numeric ID of a data/items content ID. */
  itemNumber(id: string): number | undefined;
  /** Projectiles and effects (IDs) drawn less than `ms` ago. */
  magic(ms: number): { projectiles: number; effects: number[] };
  /** NPCs the client knows, as [id, contentId, x, y, z]. */
  npcs(): { id: number; contentId: string; x: number; y: number; z: number }[];
  dialog(): DialogState | undefined;
  shop(): ShopState | undefined;
}

/** Pointer travel (CSS pixels) that turns a press on a DOM item into a drag. */
const DRAG_START_PX = 4;

declare global {
  interface Window {
    __rpgClient?: ClientTestHooks;
  }
}

export interface GameOptions {
  host: HTMLElement;
  content: ClientContent;
  t: Translate;
  locale: string;
  sessionToken: string;
  /** The character's vocation (default spell hotkeys). */
  vocation: string;
  /** Sound effects and the zone's music (T3.7); undefined = silent. */
  audio?: AudioEngine | undefined;
  /** Where the hotkey bar is remembered (localStorage; undefined in tests). */
  storage?: Storage | undefined;
  /** The world is on screen. */
  entered(): void;
  /** The session ended (Disconnect or lost connection). */
  ended(reason: DisconnectReason | undefined): void;
  /** New state for the DOM UI (battle list, health, log). */
  update(ui: GameUi): void;
}

export class Game {
  private readonly world: WorldState;
  private readonly conn: Connection;
  private readonly keys = new MovementKeys();
  private canvas: GameCanvas | undefined;
  private starting = false;
  private destroyed = false;
  /** A click that arrived while a predicted step was unconfirmed. */
  private clickTarget: Pos | undefined;
  /**
   * What waits for the next click on the map (the crosshair): a "use with" tool (T1.12) or
   * a heal for another player (T3.1). Any other cast or use drops it (`state/aim.ts`).
   */
  private pending: Pending<ItemRef>;
  private readonly opts: GameOptions;
  private hotkeys: (string | undefined)[];
  /** The last tool used on a tile and that tile: which gather sound its result makes. */
  private toolAt: { use: string; pos: Pos } | undefined;
  /** The safe mode the player chose (T5.2, `state/pvp.ts`). */
  private safe = true;

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.hotkeys = loadHotkeys(opts.content.spells, opts.vocation, opts.storage);
    this.safe = loadSafeMode(opts.storage);
    this.world = new WorldState(opts.content);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.conn = new Connection(opts.sessionToken, opts.locale, {
      batch: (batch) => {
        const now = performance.now();
        const cues: Cue[] = [];
        for (const e of batch.events) {
          if (opts.audio) cues.push(...cuesOf(e.message, this.cueContext()));
          this.world.apply(e.message, now);
          if (e.message.case === "welcome" && !this.safe) {
            // T5.2: the server starts every login in safe mode.
            this.conn.send({ case: "setSafeMode", value: { enabled: false } });
          }
        }
        this.sound(cues);
        if (this.world.self && !this.canvas && !this.starting) void this.startCanvas();
        this.publish();
      },
      closed: (reason) => {
        if (this.destroyed) return;
        this.destroy();
        opts.ended(reason);
      },
    });
  }

  logout(): void {
    this.conn.logout();
  }

  /**
   * Attacks creature id, or stops attacking it if it already is the target (SetTarget).
   * An NPC is talked to instead.
   */
  attack(id: number): void {
    if (this.world.creatures.get(id)?.kind === CreatureKind.NPC) {
      this.talk(id);
      return;
    }
    const next = this.world.target === id ? undefined : id;
    this.world.target = next;
    this.conn.send({ case: "setTarget", value: { creatureId: next ?? 0 } });
    this.publish();
  }

  setFightMode(stance: FightStance, chase: boolean): void {
    this.conn.send({ case: "setFightMode", value: { stance, chase } });
  }

  /** The safe mode (T5.2): kept in the browser and sent to the server, which enforces it. */
  get safeMode(): boolean {
    return this.safe;
  }

  setSafeMode(on: boolean): void {
    this.safe = on;
    saveSafeMode(on, this.opts.storage);
    this.conn.send({ case: "setSafeMode", value: { enabled: on } });
    this.publish();
  }

  // ---- NPCs (T1.10): the server checks distance, conditions and costs -----------------

  /** Starts talking to an NPC (NpcTalk). */
  talk(id: number): void {
    this.conn.send({ case: "npcTalk", value: { creatureId: id } });
  }

  /** Picks an option of the open dialog; 0 closes it. */
  chooseOption(optionId: number): void {
    const d = this.world.dialog;
    if (!d) return;
    this.conn.send({ case: "dialogChoose", value: { dialogId: d.id, optionId } });
  }

  closeDialog(): void {
    this.chooseOption(0);
  }

  /** Attempts a recipe at the open station (T3.4); the server answers with craft.* messages. */
  craft(recipeId: string): void {
    const s = this.world.station;
    this.toolAt = undefined; // the station's effect is not a swing of the tool
    if (s) this.conn.send({ case: "craft", value: { recipeId, station: { ...s.pos } } });
  }

  closeStation(): void {
    if (!this.world.station) return;
    this.world.station = undefined;
    this.publish();
  }

  shopBuy(itemId: number, count: number): void {
    const s = this.world.shop;
    if (s) this.conn.send({ case: "shopBuy", value: { dialogId: s.dialogId, itemId, count } });
  }

  shopSell(itemId: number, count: number): void {
    const s = this.world.shop;
    if (s) this.conn.send({ case: "shopSell", value: { dialogId: s.dialogId, itemId, count } });
  }

  // ---- trade and market (T5.3): the server validates distance, items, money and limits --

  /** Invites a player the client sees to trade, or accepts its invitation. */
  tradeRequest(id: number): void {
    this.conn.send({ case: "tradeRequest", value: { creatureId: id } });
  }

  /** Adds an item of an open container to the own trade offer. */
  tradeOffer(ref: ItemRef): void {
    this.conn.send({
      case: "tradeOffer",
      value: { item: locationInit(ref.loc), itemId: ref.itemId, stackIndex: ref.stackIndex },
    });
  }

  /** Takes the offered item at index out of the own offer. */
  tradeRemove(index: number): void {
    this.conn.send({ case: "tradeOffer", value: { remove: true, index } });
  }

  tradeAccept(): void {
    this.conn.send({ case: "tradeAccept", value: {} });
  }

  tradeCancel(): void {
    this.conn.send({ case: "tradeCancel", value: {} });
  }

  marketBrowse(itemId: number): void {
    this.conn.send({
      case: "marketCommand",
      value: { action: { case: "browse", value: { itemId } } },
    });
  }

  marketCreate(
    sell: boolean,
    itemId: number,
    amount: number,
    price: number,
    durationIndex: number,
  ): void {
    const side = sell ? MarketSide.SELL : MarketSide.BUY;
    this.conn.send({
      case: "marketCommand",
      value: {
        action: {
          case: "create",
          value: { side, itemId, amount, price: BigInt(price), durationIndex },
        },
      },
    });
  }

  marketAccept(offerId: bigint, amount: number): void {
    this.conn.send({
      case: "marketCommand",
      value: { action: { case: "accept", value: { offerId, amount } } },
    });
  }

  marketCancel(offerId: bigint): void {
    this.conn.send({
      case: "marketCommand",
      value: { action: { case: "cancel", value: { offerId } } },
    });
  }

  marketWithdraw(): void {
    this.conn.send({ case: "marketCommand", value: { action: { case: "withdraw", value: {} } } });
  }

  /** Closes the market window (the server forgets it too). */
  marketClose(): void {
    if (!this.world.market) return;
    this.world.market = undefined;
    this.conn.send({ case: "marketCommand", value: { action: { case: "close", value: {} } } });
    this.publish();
  }

  // ---- parties (T3.3): the server checks leadership, sight and the party size ---------

  private party(action: PartyAction, creatureId = 0): void {
    this.conn.send({ case: "partyCommand", value: { action, creatureId } });
  }

  /** Invites a player the client sees (battle list). */
  partyInvite(id: number): void {
    this.party(PartyAction.INVITE, id);
  }

  /** Asks the server to end the tutorial (T4.2); the panel closes when it says so. */
  skipTutorial(): void {
    this.conn.send({ case: "tutorialSkip", value: {} });
  }

  /** Answers the presence check (T4.1); the server replies the same whatever the answer. */
  presenceAnswer(id: number, option: number): void {
    // Always sent, even past its time on this side: while the player was away the server's
    // clock stopped, so the check may still be pending there (it ignores one that is not).
    this.conn.send({ case: "presenceAnswer", value: { checkId: id, optionId: option } });
    this.world.answerPresence(id);
    this.publish();
  }

  /** Reports a player the client sees to the staff (T4.1, battle list). */
  reportPlayer(id: number, reason: string): void {
    this.conn.send({ case: "reportPlayer", value: { creatureId: id, reason } });
  }

  /** Accepts or declines the invitation of inviterId. */
  partyAnswer(inviterId: number, accept: boolean): void {
    this.party(accept ? PartyAction.ACCEPT : PartyAction.DECLINE, inviterId);
    this.world.party.answered(inviterId);
    this.publish();
  }

  partyLeave(): void {
    this.party(PartyAction.LEAVE);
  }

  partyKick(id: number): void {
    this.party(PartyAction.KICK, id);
  }

  partyPassLeader(id: number): void {
    this.party(PartyAction.PASS_LEADER, id);
  }

  partyShare(on: boolean): void {
    this.party(on ? PartyAction.SHARE_ON : PartyAction.SHARE_OFF);
  }

  // ---- guilds (T5.1): the server checks ranks, names, gold and limits -----------------

  /** Sends a GuildCommand: `name` is a character or the guild (create, disband). */
  guild(action: GuildAction, name = "", text = "", guildId = 0n): void {
    this.conn.send({ case: "guildCommand", value: { action, name, text, guildId } });
  }

  /** A war action (T5.2): declare on the guild `name`, or answer/surrender war `warId`. */
  guildWar(action: GuildAction, name = "", warId = 0n): void {
    this.conn.send({ case: "guildCommand", value: { action, name, warId } });
  }

  /** Accepts or declines the invitation of guildId. */
  guildAnswer(guildId: bigint, accept: boolean): void {
    this.guild(accept ? GuildAction.ACCEPT : GuildAction.DECLINE, "", "", guildId);
    this.world.guild.answered(guildId);
    this.publish();
  }

  /** Looks at a creature the client sees (T5.1: a player's vocation, level and guild). */
  lookCreature(id: number): void {
    this.conn.send({ case: "lookAt", value: { creatureId: id } });
  }

  // ---- magic (T1.9): the server checks vocation, level, mana, cooldowns and sight -------

  /** Casts a spell by ID (hotkey) on the current target, if any. */
  castSpell(spellId: string): void {
    const aims = this.opts.content.spells.find((s) => s.id === spellId)?.aimsAtPlayer ?? false;
    this.setPending(afterCast(spellId, aims));
    if (aims) return;
    this.conn.send({ case: "castSpell", value: { spell: { case: "spellId", value: spellId } } });
  }

  /** Casts the aimed spell on a creature or a tile; the server picks the player there. */
  private castAimed(spellId: string, target: { creature: number } | { pos: Pos }): void {
    this.conn.send({
      case: "castSpell",
      value: {
        spell: { case: "spellId", value: spellId },
        target: {
          target:
            "creature" in target
              ? { case: "creatureId", value: target.creature }
              : { case: "pos", value: { ...target.pos } },
        },
      },
    });
  }

  /**
   * Says text on a channel (say, yell, whisper or global). On the say channel the
   * server casts it instead if it is a spell's words. The server enforces the length
   * and the anti-flood limits; the client only trims and caps to save a round trip.
   */
  say(text: string, channel: ChatChannel = ChatChannel.SAY): void {
    const trimmed = [...text.trim()].slice(0, this.opts.content.chat.maxLength).join("");
    if (trimmed) this.conn.send({ case: "say", value: { channel, text: trimmed } });
  }

  /** Assigns a spell (or nothing) to hotkey slot 0..11 and remembers it. */
  setHotkey(slot: number, spellId: string | undefined): void {
    if (slot < 0 || slot >= this.hotkeys.length) return;
    this.hotkeys = this.hotkeys.map((k, i) => (i === slot ? spellId : k));
    saveHotkeys(this.opts.vocation, this.hotkeys, this.opts.storage);
    this.publish();
  }

  /** Remaining fraction (0..1) of a spell's cooldown (its own or its group's). */
  spellCooldown(spellId: string, now: number): number {
    const def = this.opts.content.spells.find((s) => s.id === spellId);
    return cooldownLeft(
      [
        this.world.spellCooldowns.get(spellId),
        def ? this.world.groupCooldowns.get(def.group) : undefined,
      ],
      now,
    );
  }

  // ---- items (T1.8): the server validates every one of these ---------------------------

  useItem(ref: ItemRef): void {
    const useWith = this.opts.content.items[ref.itemId]?.useWith ?? false;
    this.setPending(afterUse(ref, useWith));
    this.toolAt = undefined;
    if (useWith) return;
    this.conn.send({
      case: "useItem",
      value: { from: locationInit(ref.loc), itemId: ref.itemId, stackIndex: ref.stackIndex },
    });
  }

  /** Uses ref on a tile (a fishing rod on water, a pickaxe on a vein). */
  useItemOn(ref: ItemRef, pos: Pos): void {
    const use = this.opts.content.items[ref.itemId]?.toolUse;
    this.toolAt = use ? { use, pos: { ...pos } } : undefined;
    this.conn.send({
      case: "useItemOn",
      value: {
        from: locationInit(ref.loc),
        itemId: ref.itemId,
        stackIndex: ref.stackIndex,
        to: { target: { case: "pos", value: { ...pos } } },
      },
    });
  }

  /** Leaves "use with" mode; reports whether it was on. */
  private cancelUse(): boolean {
    if (!this.pending) return false;
    this.setPending(undefined);
    return true;
  }

  /** Sets what waits for the next click, with the crosshair while something does. */
  private setPending(p: Pending<ItemRef>): void {
    this.pending = p;
    document.body.classList.toggle("using-item", p !== undefined);
  }

  /** A left click on the map: consumes what was pending and does what it resolves to. */
  private click(target: { creature: number } | { pos: Pos }): void {
    const action = resolveClick(this.pending, target);
    this.setPending(undefined);
    switch (action.kind) {
      case "attack":
        this.attack(action.creature);
        break;
      case "walk":
        this.clickTarget = action.pos;
        break;
      case "castOnCreature":
        this.castAimed(action.spellId, { creature: action.creature });
        break;
      case "castOnTile":
        this.castAimed(action.spellId, { pos: action.pos });
        break;
      case "useOn":
        this.useItemOn(action.ref, action.pos);
        break;
      case "none":
        break;
    }
  }

  lookAt(ref: ItemRef): void {
    this.conn.send({
      case: "lookAt",
      value: { from: locationInit(ref.loc), itemId: ref.itemId, stackIndex: ref.stackIndex },
    });
  }

  moveItem(ref: ItemRef, to: ItemLoc): void {
    this.conn.send({
      case: "moveItem",
      value: {
        from: locationInit(ref.loc),
        itemId: ref.itemId,
        stackIndex: ref.stackIndex,
        to: locationInit(to),
        count: Math.max(ref.count, 1),
      },
    });
  }

  closeContainer(id: number): void {
    this.conn.send({ case: "closeContainer", value: { containerId: id } });
  }

  /**
   * A press on a DOM item (inventory slot or container cell): it becomes a drag once the
   * pointer travels a few pixels, and the item moves where it is released.
   */
  pressItem(ref: ItemRef, e: PointerEvent): void {
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
      stop();
      this.startDrag(ref);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  /** Drags ref until the pointer is released over a drop target (canvas, slot, container). */
  private startDrag(ref: ItemRef): void {
    document.body.classList.add("dragging-item");
    const up = (ev: PointerEvent): void => {
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging-item");
      const to = this.dropTarget(ev.clientX, ev.clientY);
      if (to) this.moveItem(ref, to);
    };
    window.addEventListener("pointerup", up);
  }

  /** Where a drop at page coordinates lands: a [data-drop] element or a map tile. */
  private dropTarget(x: number, y: number): ItemLoc | undefined {
    const el = document.elementFromPoint(x, y);
    const drop = el?.closest<HTMLElement>("[data-drop]");
    if (drop) {
      const d = drop.dataset;
      if (d["drop"] === "slot") return { kind: "slot", slot: Number(d["slot"]) as EquipmentSlot };
      if (d["drop"] === "container")
        return { kind: "container", id: Number(d["container"]), index: Number(d["index"] ?? 0) };
      return undefined;
    }
    if (this.canvas && el === this.canvas.element) {
      const pos = this.canvas.clientToTile(x, y);
      if (pos) return { kind: "pos", pos };
    }
    return undefined;
  }

  /** Atlas rectangle of an item's sprite, for DOM icons (undefined until the canvas is up). */
  itemIcon(itemId: number): ReturnType<GameCanvas["itemIcon"]> {
    return this.canvas?.itemIcon(itemId);
  }

  /** Publishes again when the presence check runs out: no server batch may come then. */
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;

  private armPresenceTimer(): void {
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    const ms = this.world.presenceClosesIn(performance.now());
    if (ms !== undefined && !this.destroyed) {
      this.presenceTimer = setTimeout(() => this.publish(), ms + 50);
    }
  }

  private publish(): void {
    const w = this.world;
    const self = w.self;
    if (w.station && self && !nearStation(w.station, self.pos)) w.station = undefined;
    this.opts.update({
      battle: w.battleList(),
      target: w.target,
      stats: w.stats,
      skills: w.skills,
      conditions: w.conditions,
      levelUp: w.levelUp,
      voyage: w.voyage,
      death: w.death,
      log: [...w.log],
      chat: [...w.chat],
      inventory: w.inventory,
      containers: w.containers,
      hotkeys: this.hotkeys,
      dialog: w.dialog,
      shop: w.shop,
      station: w.station,
      trade: w.trade,
      market: w.market,
      // Until answered or out of time (the server sends nothing on a timeout).
      presence: w.activePresence(performance.now()),
      tutorial: w.tutorial,
      party: w.party.party,
      invitations: [...w.party.invitations(performance.now())],
      guild: w.guild.view(performance.now()),
      safeMode: this.safe,
      guildInvitations: [...w.guild.invitations(performance.now())],
      selfName: w.self?.name ?? "",
      selfId: w.selfId,
    });
    this.armPresenceTimer();
  }

  // ---- sound (T3.7): what each event sounds like is assets/sounds.yaml --------------------

  private cueContext(): CueContext {
    const station = this.world.station;
    const craft = station
      ? this.opts.content.recipes.find((r) => r.station === station.itemId)?.craft
      : undefined;
    return { selfId: this.world.selfId, tool: this.toolAt, craft };
  }

  /** Plays a batch's cues around the player and keeps the zone's loops. */
  private sound(cues: readonly Cue[]): void {
    const audio = this.opts.audio;
    const self = this.world.self;
    if (!audio || !self) return;
    for (const c of cues) audio.play(c.events, c.pos, self.pos);
    const { islands, sounds } = this.opts.content;
    audio.setLoops(
      loopFor(self.pos, islands, sounds.music),
      loopFor(self.pos, islands, sounds.ambient),
    );
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.presenceTimer);
    this.opts.audio?.setLoops(undefined, undefined);
    this.cancelUse();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.conn.close();
    this.canvas?.destroy();
    this.canvas = undefined;
    delete window.__rpgClient;
  }

  private async startCanvas(): Promise<void> {
    this.starting = true;
    const canvas = await createGameCanvas(this.opts.host, {
      world: this.world,
      content: this.opts.content,
      t: this.opts.t,
      frame: (now) => this.frame(now),
      clickTile: (x, y, z) => this.click({ pos: { x, y, z } }),
      clickCreature: (id) => this.click({ creature: id }),
      useTile: (x, y, z) => {
        if (this.cancelUse()) return;
        const ref = topItem(this.world, x, y, z, false);
        if (ref) this.useItem(ref);
      },
      lookTile: (x, y, z) => {
        const c = [...this.world.creatures.values()].find(
          (o) => o.pos.x === x && o.pos.y === y && o.pos.z === z,
        );
        if (c) {
          this.lookCreature(c.id);
          return;
        }
        const ref = topItem(this.world, x, y, z, true);
        if (ref) this.lookAt(ref);
      },
      dragTile: (x, y, z) => {
        const ref = topItem(this.world, x, y, z, false);
        if (ref) this.startDrag(ref);
      },
    });
    if (this.destroyed) {
      canvas.destroy();
      return;
    }
    this.canvas = canvas;
    const world = this.world;
    window.__rpgClient = {
      ready: true,
      self() {
        const s = world.self;
        if (!s) return undefined;
        const now = performance.now();
        return { ...s.pos, pending: world.pending !== undefined, walking: world.walking(s, now) };
      },
      walkable: (x, y, z) => world.free(x, y, z),
      tileToClient: (x, y) => canvas.tileToClient(x, y),
      scale: () => canvas.scale,
      battle: () =>
        world.battleList().map((c) => ({ id: c.id, contentId: c.contentId, health: c.health })),
      target: () => world.target,
      stats: () => world.stats,
      skills: () => world.skills,
      floatingTexts: (ms) => {
        const now = performance.now();
        return world.floatingTexts.filter((f) => now - f.start < ms).length;
      },
      inventory: () =>
        [...world.inventory].map(([slot, it]) => ({ slot, itemId: it.itemId, count: it.count })),
      containers: () => world.containers,
      tile: (x, y, z) => world.tile(x, y, z),
      magic: (ms) => {
        const now = performance.now();
        return {
          projectiles: world.projectiles.filter((p) => now - p.start < ms).length,
          effects: world.effects.filter((e) => now - e.start < ms).map((e) => e.effectId),
        };
      },
      npcs: () =>
        [...world.creatures.values()]
          .filter((c) => c.kind === CreatureKind.NPC)
          .map((c) => ({ id: c.id, contentId: c.contentId, ...c.pos })),
      dialog: () => world.dialog,
      shop: () => world.shop,
      itemNumber: (id) => {
        const found = Object.entries(this.opts.content.items).find(([, d]) => d.id === id);
        return found ? Number(found[0]) : undefined;
      },
    };
    this.publish(); // icons are available now
    this.opts.entered();
  }

  private frame(now: number): void {
    const self = this.world.self;
    if (!self || this.world.pending) return;
    const target = this.clickTarget;
    if (target) {
      this.clickTarget = undefined;
      const steps = findPath(self.pos, target, (x, y) => this.world.free(x, y, target.z), {
        diagonalCost: this.opts.content.movement.diagonalCost,
        maxSteps: this.opts.content.movement.maxPathTiles,
      });
      if (steps && steps.length > 0) this.conn.send({ case: "walkPath", value: { steps } });
      return;
    }
    if (!this.world.canStep(now)) return;
    const dir = this.keys.take();
    if (dir === undefined) return;
    const before = self.dir;
    if (this.world.predictStep(dir, now)) this.conn.send({ case: "walk", value: { dir } });
    else if (before !== dir && dir !== Direction.UNSPECIFIED)
      this.conn.send({ case: "turn", value: { dir } });
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const slot = hotkeySlot(e.code);
    if (slot !== undefined) {
      e.preventDefault(); // F5 must not reload the page in the middle of a fight
      const spell = this.hotkeys[slot];
      if (spell && !e.repeat) this.castSpell(spell);
      return;
    }
    if (typingInField(e)) return;
    if (e.code === "Escape" && this.world.station && !this.world.dialog) {
      this.closeStation();
      e.preventDefault();
      return;
    }
    if (e.code === "Escape" && this.cancelUse()) {
      e.preventDefault();
      return;
    }
    const d = this.world.dialog;
    if (d && !e.repeat) {
      // 1–9 pick the n-th option shown; Escape closes (docs/02-game-design.md).
      const n = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1];
      if (n !== undefined) {
        const opt = d.options[Number(n) - 1];
        if (opt) this.chooseOption(opt.id);
        e.preventDefault();
        return;
      }
      if (e.code === "Escape") {
        this.closeDialog();
        e.preventDefault();
        return;
      }
    }
    if (this.keys.down(e.code)) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.up(e.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
  };
}
