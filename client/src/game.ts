// One play session: the WebSocket, the world state, the keyboard and the canvas wired
// together. The client only sends intents (Walk, WalkPath, Turn, Logout) and draws what
// the server says; the one thing it predicts is the next own step.
import { ChatChannel, CreatureKind, Direction } from "@rpg/protocol";
import type { DisconnectReason, EquipmentSlot, FightStance } from "@rpg/protocol";
import type { ClientContent } from "./content-types.ts";
import type { Translate } from "./i18n/i18n.ts";
import { MovementKeys, typingInField } from "./input/keyboard.ts";
import { cooldownLeft, hotkeySlot, loadHotkeys, saveHotkeys } from "./state/hotkeys.ts";
import { Connection } from "./net/connection.ts";
import { createGameCanvas } from "./render/game-canvas.ts";
import type { GameCanvas } from "./render/game-canvas.ts";
import { locationInit, topItem } from "./state/items.ts";
import type { ItemLoc, ItemRef } from "./state/items.ts";
import { findPath } from "./state/path.ts";
import type { Pos } from "./state/geometry.ts";
import { WorldState } from "./state/world.ts";
import type {
  ContainerState,
  CreatureState,
  DialogState,
  ItemView,
  DeathState,
  LevelUpState,
  LogMessage,
  PlayerStatsState,
  ShopState,
  SkillState,
} from "./state/world.ts";

/** What the DOM UI shows next to the canvas, refreshed after every server batch. */
export interface GameUi {
  battle: CreatureState[];
  target: number | undefined;
  stats: PlayerStatsState | undefined;
  skills: SkillState[];
  levelUp: LevelUpState | undefined;
  death: DeathState | undefined;
  log: LogMessage[];
  inventory: Map<EquipmentSlot, ItemView>;
  containers: ContainerState[];
  /** Spell ID of each hotkey F1..F12 (undefined = empty). */
  hotkeys: (string | undefined)[];
  /** The open NPC dialog and its shop (T1.10). */
  dialog: DialogState | undefined;
  shop: ShopState | undefined;
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
  /** A tool waiting for the tile to use it on (T1.12): the next click on the map picks it. */
  private usingItem: ItemRef | undefined;
  private readonly opts: GameOptions;
  private hotkeys: (string | undefined)[];

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.hotkeys = loadHotkeys(opts.content.spells, opts.vocation, opts.storage);
    this.world = new WorldState(opts.content);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.conn = new Connection(opts.sessionToken, opts.locale, {
      batch: (batch) => {
        const now = performance.now();
        for (const e of batch.events) this.world.apply(e.message, now);
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

  shopBuy(itemId: number, count: number): void {
    const s = this.world.shop;
    if (s) this.conn.send({ case: "shopBuy", value: { dialogId: s.dialogId, itemId, count } });
  }

  shopSell(itemId: number, count: number): void {
    const s = this.world.shop;
    if (s) this.conn.send({ case: "shopSell", value: { dialogId: s.dialogId, itemId, count } });
  }

  // ---- magic (T1.9): the server checks vocation, level, mana, cooldowns and sight -------

  /** Casts a spell by ID (hotkey) on the current target, if any. */
  castSpell(spellId: string): void {
    this.conn.send({ case: "castSpell", value: { spell: { case: "spellId", value: spellId } } });
  }

  /** Says text on the local channel: the server casts it if it is a spell's words. */
  say(text: string): void {
    const trimmed = text.trim().slice(0, 255);
    if (trimmed)
      this.conn.send({ case: "say", value: { channel: ChatChannel.SAY, text: trimmed } });
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
    if (this.opts.content.items[ref.itemId]?.useWith) {
      this.usingItem = ref;
      document.body.classList.add("using-item");
      return;
    }
    this.conn.send({
      case: "useItem",
      value: { from: locationInit(ref.loc), itemId: ref.itemId, stackIndex: ref.stackIndex },
    });
  }

  /** Uses ref on a tile (a fishing rod on water, a pickaxe on a vein). */
  useItemOn(ref: ItemRef, pos: Pos): void {
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
    if (!this.usingItem) return false;
    this.usingItem = undefined;
    document.body.classList.remove("using-item");
    return true;
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

  private publish(): void {
    const w = this.world;
    this.opts.update({
      battle: w.battleList(),
      target: w.target,
      stats: w.stats,
      skills: w.skills,
      levelUp: w.levelUp,
      death: w.death,
      log: [...w.log],
      inventory: w.inventory,
      containers: w.containers,
      hotkeys: this.hotkeys,
      dialog: w.dialog,
      shop: w.shop,
    });
  }

  destroy(): void {
    this.destroyed = true;
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
      clickTile: (x, y, z) => {
        const using = this.usingItem;
        if (using && this.cancelUse()) {
          this.useItemOn(using, { x, y, z });
          return;
        }
        this.clickTarget = { x, y, z };
      },
      clickCreature: (id) => {
        if (!this.cancelUse()) this.attack(id);
      },
      useTile: (x, y, z) => {
        if (this.cancelUse()) return;
        const ref = topItem(this.world, x, y, z, false);
        if (ref) this.useItem(ref);
      },
      lookTile: (x, y, z) => {
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
