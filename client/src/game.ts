// One play session: the WebSocket, the world state, the keyboard and the canvas wired
// together. The client only sends intents (Walk, Turn, Logout...) and draws what the server
// says; the one thing it predicts is the own steps (a few ahead: keys, the pad, a click's
// route and the mouse held, state/steering.ts).
import { nearStation } from "./state/recipes.ts";
import { bookOf } from "./state/book.ts";
import type { BookState } from "./state/book.ts";
import { refineMessage } from "./state/forge.ts";
import type { ForgeCandidate, RefineState } from "./state/forge.ts";
import type { StationState } from "./state/recipes.ts";
import type { PresenceState } from "./state/world.ts";
import type { TutorialView } from "./state/tutorial.ts";
import type { QuestLogView } from "./state/quests.ts";
import { sameLook } from "./state/look.ts";
import type { EquipmentView } from "./state/look.ts";
import type { Look } from "@rpg/renderer/look";
import {
  ChatChannel,
  CreatureKind,
  DisappearReason,
  EquipmentSlot,
  GuildAction,
  MarketSide,
  PartyAction,
} from "@rpg/protocol";
import type { Direction, DisconnectReason, FightStance, Skull } from "@rpg/protocol";
import {
  ItemPicker,
  defaultAction,
  itemActions,
  itemPrimary,
  tileActions,
} from "./input/actions.ts";
import type { ActionKind, ItemFacts, TileFacts } from "./input/actions.ts";
import { itemContext, pressAnswer } from "./input/mouse.ts";
import type { PressAnswer } from "./input/mouse.ts";
import { loadControls } from "./state/controls.ts";
import { motionReduced } from "./state/ui-prefs.ts";
import { stepSoundEvents } from "./render/living.ts";
import type { ControlsMode } from "./state/controls.ts";
import { equipSlot, groundCard, itemCard } from "./state/item-card.ts";
import type { ItemCardView, Viewer } from "./state/item-card.ts";
import { dialogLayout, optionForKey } from "./state/dialog.ts";
import { HeldDirection } from "./input/dpad.ts";
import { DEFAULT_GESTURES, GestureRecognizer, isTouchPointer } from "./input/gestures.ts";
import type { Gesture } from "./input/gestures.ts";
import { creatureName } from "./state/messages.ts";
import type { ClientContent, ItemMods } from "./content-types.ts";
import type { Translate } from "./i18n/i18n.ts";
import {
  MovementKeys,
  TurnTap,
  isTextField,
  keyDirection,
  turnKeyDirection,
  typingInField,
} from "./input/keyboard.ts";
import { cooldownLeft, hotkeySlot, loadHotkeys, saveHotkeys } from "./state/hotkeys.ts";
import { loadSafeMode, saveSafeMode } from "./state/pvp.ts";
import { loadZoom, saveZoom } from "./render/zoom.ts";
import type { ZoomView } from "./render/zoom.ts";
import { DEFAULT_NAME_SIZE } from "./render/label-style.ts";
import type { NameSize } from "./render/label-style.ts";
import type { ViewTiles } from "./state/view.ts";
import { Connection } from "./net/connection.ts";
import { createGameCanvas } from "./render/game-canvas.ts";
import type { GameCanvas, LabelsShown, SkyHook } from "./render/game-canvas.ts";
import { locationInit, menuItem, splitCount, splittable, tileUse, topItem } from "./state/items.ts";
import type { ItemLoc, ItemRef } from "./state/items.ts";
import { afterCast, afterUse, resolveClick } from "./state/aim.ts";
import type { Pending } from "./state/aim.ts";
import { Steering } from "./state/steering.ts";
import type { SteerInput, StepChoice } from "./state/steering.ts";
import { climbable, usedBare, useMode } from "./state/portals.ts";
import type { Pos } from "./state/geometry.ts";
import { WorldState } from "./state/world.ts";
import { parseHex } from "./state/minimap.ts";
import type { MinimapState, ObjectiveHintView } from "./state/minimap.ts";
import type { PocketsState } from "./state/pockets.ts";
import { MotionTrail } from "./state/motion.ts";
import { cuesOf, sceneFor } from "./audio/cues.ts";
import { AMBIENCE_STEP_MS, ambienceAt, mountAmbience } from "./audio/ambience.ts";
import type { Ambience } from "./audio/ambience.ts";
import type { Cue, CueContext } from "./audio/cues.ts";
import type { AudioEngine } from "./audio/engine.ts";
import type { InvitationView, PartyView } from "./state/party.ts";
import type { GuildInvitationView, GuildView } from "./state/guild.ts";
import type { MarketView, TradeView } from "./state/market.ts";
import type { StashCell, StashView } from "./state/stash.ts";
import { doorKey } from "./state/house.ts";
import type { HouseView } from "./state/house.ts";
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
  CosmeticsStateView,
  CosmeticsView,
} from "./state/world.ts";

/** What the DOM UI shows next to the canvas, refreshed after every server batch. */
/** What the minimap draws (GameUi.minimap). */
export interface MinimapUi {
  /** Grows with every change of what is explored or known (MinimapState.version). */
  version: number;
  self: { x: number; y: number; z: number; dir: Direction };
  /** Party members in view on the own floor. */
  party: { id: number; x: number; y: number }[];
  hint: ObjectiveHintView | undefined;
  /** The quest the server says is tracked ("": none). */
  tracked: string;
}

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
  /** The character's pockets (docs/02 "Bolsillos"): under the figure, above the backpack. */
  pockets: PocketsState;
  /**
   * The open containers that have a window of their own: every one but the equipped
   * backpack, which the inventory shows under the figure (`backpack`, docs/17 UI-5).
   */
  containers: ContainerState[];
  /** The equipped backpack's open container, shown under the figure (docs/17 UI-5). */
  backpack?: ContainerState | undefined;
  /** Spell ID of each hotkey F1..F12 (undefined = empty). */
  hotkeys: (string | undefined)[];
  /** The open NPC dialog and its shop (T1.10). */
  dialog: DialogState | undefined;
  shop: ShopState | undefined;
  /** The crafting station window (T3.4). */
  station: StationState | undefined;
  /** The last forge attempt (docs/02 "Forja"), for the forge window. */
  refine: RefineState | undefined;
  /** The trade and market windows (T5.3). */
  trade: TradeView | undefined;
  /** The account stash window (docs/02 "Baúl de la cuenta"). */
  stash: StashView | undefined;
  market: MarketView | undefined;
  /** The house window (T5.4). */
  house: HouseView | undefined;
  /** The book or scroll being read (docs/02 "Libros y cofres"): the client's own window. */
  book?: BookState | undefined;
  /** A presence check waiting for an answer (T4.1), or undefined. */
  presence: PresenceState | undefined;
  /** The tutorial step (T4.2), or undefined when there is none. */
  tutorial: TutorialView | undefined;
  /**
   * The quest log (docs/02 "Diario de misiones"), undefined before the server sends it,
   * and the server's clock minus the client's (ms) for a task's countdown.
   */
  quests: QuestLogView | undefined;
  /** The minimap (docs/02 "Minimapa", ui/Minimap.tsx); undefined before the own creature. */
  minimap?: MinimapUi | undefined;
  clockOffset: number;
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
  /** T5.6: the item picked by a tap, waiting for a tap on its destination. */
  picked?: ItemRef | undefined;
  /** The item dragged with the pointer right now (docs/17 UI-5: the slots that take it glow). */
  dragging?: ItemRef | undefined;
  /** T5.6: the contextual menu of a long press (or a right click, docs/17 UI-6). */
  menu?: ActionMenuView | undefined;
  /** The character's vocation (an item card's requirements). */
  vocation?: string | undefined;
  /** T5.7: owned cosmetics, premium balance and what is equipped (undefined until sent). */
  cosmetics?: CosmeticsStateView | undefined;
  /**
   * The player's own body (docs/02 "Apariencia"), as the server says (its Creature,
   * CreatureLook); undefined from a server without looks.
   */
  look?: Look | undefined;
  /** The look being chosen in the Apariencia window, not sent yet (Game.setLookDraft). */
  lookDraft?: Look | undefined;
  /** The player's own visible equipment (item ids): what the Apariencia figure wears. */
  selfEquipment?: EquipmentView | undefined;
  /** The map's zoom and its limits (render/zoom.ts), for the +/- buttons on touch screens. */
  zoom?: ZoomView | undefined;
  /**
   * Shift+drag of a stack (docs/17 UI-6): it was dropped at (x, y) and asks how many of
   * its `count` units go there (ui/SplitPrompt.tsx).
   */
  split?: SplitView | undefined;
  /** The last spell used from the hotbar and when (docs/17 UI-9: its slot flashes). */
  cast?: { spellId: string; at: number } | undefined;
  /**
   * The item lying on the map tile under the mouse, at page (x, y): its card shows above the
   * tile, `tile` in page coordinates (docs/17 UI-6, ui/ItemTooltip.tsx).
   */
  groundTip?:
    | {
        itemId: number;
        count: number;
        mods?: ItemMods | undefined;
        x: number;
        y: number;
        tile: { left: number; top: number; width: number; height: number };
      }
    | undefined;
}

/** A Shift+drag of a stack waiting for how many units move. */
export interface SplitView {
  /** Page coordinates of the drop. */
  x: number;
  y: number;
  itemId: number;
  count: number;
}

/**
 * The contextual menu of a long press (T5.6) or a right click (docs/17 UI-6): where it was
 * pressed, its buttons and the card of its item.
 */
export interface ActionMenuView {
  /** Page coordinates of the press (the menu opens next to it). */
  x: number;
  y: number;
  /** What was pressed: a creature's or an item's name ("" = a bare tile). */
  title: string;
  actions: ActionKind[];
  /** The card of the item it is about (docs/17 UI-6), if any. */
  card?: ItemCardView | undefined;
  /** Opened by the mouse: at the pointer, with compact buttons (ui/ActionMenu.tsx). */
  mouse?: boolean | undefined;
  /** The units of the stack ("Move part…" asks for fewer). */
  stack?: number | undefined;
}

/**
 * What a menu acts on: a map tile (resolved again when a button is chosen), a DOM item, or
 * nothing (a shop's item: only its card).
 */
type MenuTarget = { tile: Pos; creature: number | undefined } | { ref: ItemRef } | { card: true };

/** Read-only hooks for the E2E tests (client/e2e). */
export interface ClientTestHooks {
  /**
   * The first FullMapView arrived and the canvas is drawing; its camera already follows
   * the player, so `tileToClient` points at the map (before the first frame too).
   */
  ready: boolean;
  /** The own creature: where, whether steps wait for the server or are drawn, and its facing (a Direction). */
  self():
    | { x: number; y: number; z: number; pending: boolean; walking: boolean; dir: Direction }
    | undefined;
  /**
   * Where the own creature was on each frame of the last `ms` (`WorldState.drawPos` in
   * `frame`, what the canvas draws from: fractional tiles, oldest first, before rounding
   * to screen pixels): continuous motion means it moves on every frame while walking.
   */
  trail(ms: number): { t: number; x: number; y: number }[];
  /** How long a straight own step onto (x, y, z) lasts at the player's speed now, ms. */
  stepMs(x: number, y: number, z: number): number;
  walkable(x: number, y: number, z: number): boolean;
  tileToClient(x: number, y: number): { x: number; y: number };
  scale(): number;
  /** The map's zoom: the scale drawn and the scales the player may choose. */
  zoom(): ZoomView;
  /** The server's window (Welcome) and the tiles the canvas shows of it (fractional when cut). */
  view(): { server: ViewTiles; shown: ViewTiles };
  /** The names over creatures drawn now (docs/17 UI-3; GameCanvas.labels). */
  labels(): LabelsShown | undefined;
  /** Wall pieces on (x, y) of the own floor and the translucent copies (docs/17 ART-3). */
  wallFade(x: number, y: number): { alphas: number[]; copies: number } | undefined;
  /** The battle list as [id, contentId, health %]. */
  battle(): { id: number; contentId: string; health: number }[];
  target(): number | undefined;
  stats(): PlayerStatsState | undefined;
  skills(): SkillState[];
  /** Floating texts that appeared less than `ms` ago. */
  floatingTexts(ms: number): number;
  /** Equipped items as [slot, item ID, count]. */
  inventory(): { slot: number; itemId: number; count: number }[];
  /** The pockets (docs/02 "Bolsillos"): how many cells, and each item as [item ID, count]. */
  pockets(): { capacity: number; items: { itemId: number; count: number }[] };
  /** Open containers with their content. */
  containers(): ContainerState[];
  /** The item id of the book or scroll being read, if any (docs/02 "Libros y cofres"). */
  book(): number | undefined;
  /** Item IDs of a known tile, ground first. */
  tile(x: number, y: number, z: number): readonly number[] | undefined;
  /** Numeric ID of a data/items content ID. */
  itemNumber(id: string): number | undefined;
  /** Projectiles and effects (IDs) drawn less than `ms` ago. */
  magic(ms: number): { projectiles: number; effects: number[] };
  /**
   * A9: the CreatureAttack events of the last `ms` (attacker, kind, target), while the
   * world keeps them (`ATTACK_MS`).
   */
  attacks(ms: number): { id: number; kind: number; targetId: number }[];
  /**
   * A9: why creatures left the view in the last `ms` (`reason`: the DisappearReason's
   * name, `DEATH`, `OUT_OF_VIEW`...), while the world keeps them (`DEPARTURE_MS`).
   */
  departures(ms: number): { id: number; reason: string }[];
  /**
   * A9 (docs/17 ANI-7): creatures in an attack pose now, the ones falling dead and the
   * ones shimmering away after a teleport or a logout (`ms` into it, `of` its length,
   * `action` the clip: attack, shoot, cast or lunge; death; vanish; `x`, `y` its tile).
   */
  poses(): {
    attacking: PoseView[];
    dying: PoseView[];
    vanishing: PoseView[];
  };
  /**
   * docs/17 UI-11: the speech bubbles on screen now: the speaker's creature id, the kind
   * (say, yell, whisper, npc) and each message's wrapped lines.
   */
  bubbles(): { id: number; style: string; lines: string[] }[];
  /**
   * The day and night as last drawn (livingworld/README.md "Día y noche"): phase, light
   * colour, lamps, moon, and how many cast shadow sprites the frame drew.
   */
  sky(): SkyHook | undefined;
  /** NPCs the client knows, as [id, contentId, x, y, z]. */
  npcs(): { id: number; contentId: string; x: number; y: number; z: number }[];
  /** T5.6: monsters the client knows, as [id, contentId, x, y, z] (to tap one). */
  monsters(): { id: number; contentId: string; x: number; y: number; z: number }[];
  dialog(): DialogState | undefined;
  shop(): ShopState | undefined;
  /** T5.7: the own shop state (CosmeticsState). */
  cosmetics(): CosmeticsStateView | undefined;
  /**
   * T5.7: players the client sees with their equipped cosmetics, and their body and
   * visible equipment (item ids; docs/05 "Apariencia y equipo visible").
   */
  players(): {
    id: number;
    name: string;
    cosmetics: CosmeticsView;
    look: Look | undefined;
    equipment: EquipmentView;
  }[];
}

/** One creature in a pose (ClientTestHooks.poses): its id, how far in, the clip and its tile. */
interface PoseView {
  id: number;
  ms: number;
  of: number;
  action: string;
  x: number;
  y: number;
}

/** Pointer travel (CSS pixels) that turns a press on a DOM item into a drag. */
const DRAG_START_PX = 4;

/** How long after a touch press a contextmenu event is taken as the finger's, ms. */
const TOUCH_CONTEXTMENU_MS = 1500;

/** How often the frame looks again at what should play (a boss leaves view silently). */
const LOOPS_EVERY_MS = 500;
/** How often a key held into a pushable object pushes it (the server's pace is 400 ms). */
const PUSH_EVERY_MS = 400;

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
  /**
   * What the right button does on items (Options → Controls, docs/17 UI-6), read at each
   * click; without it, what this device remembers (state/controls.ts).
   */
  controls?(): ControlsMode;
  /**
   * Whether a heavy hit shakes the camera (Options → Interface, docs/17 UI-9), read at each
   * hit; reduced motion turns it off anyway. Without it, it shakes.
   */
  cameraShake?(): boolean;
  /**
   * docs/17 UI-11: whether what creatures say shows over their heads (Options →
   * Interface), read every frame. Without it, it does.
   */
  chatBubbles?(): boolean;
  /**
   * How big the names over creatures are (Options → Interface, docs/17 UI-3), read at each
   * frame. Without it, DEFAULT_NAME_SIZE.
   */
  nameSize?(): NameSize;
  /** The world is on screen. */
  entered(): void;
  /**
   * The canvas could not be made (its atlas did not load after the retries of
   * @rpg/renderer's retry.ts): show the error with a button that calls `retryCanvas`. The
   * session stays open meanwhile.
   */
  loadFailed?(): void;
  /** The session ended (Disconnect or lost connection). */
  ended(reason: DisconnectReason | undefined): void;
  /** New state for the DOM UI (battle list, health, log). */
  update(ui: GameUi): void;
}

export class Game {
  private readonly world: WorldState;
  private readonly conn: Connection;
  private readonly keys = new MovementKeys();
  /** MOV-2: a short tap toward another way, standing still, only turns. */
  private readonly turnTap = new TurnTap();
  /** A pad button activated from the keyboard (padStep): one step, never only a turn. */
  private padStepped: Direction | undefined;
  private canvas: GameCanvas | undefined;
  private starting = false;
  /** The canvas failed to start: it waits for `retryCanvas` (the "Retry" button). */
  private canvasFailed = false;
  private destroyed = false;
  /**
   * Where the own creature walks besides the keys (docs/17 MOV-3, MOV-4): a click's route
   * and the mouse held on the map, predicted step by step like a held key.
   */
  private readonly steer: Steering;
  /** The left button held on the map (MOV-3): the cursor's page coordinates. */
  private hold: { x: number; y: number } | undefined;
  /** decideStep's input to Steering.next, reused (asked every frame while standing). */
  private readonly steerInput: SteerInput = {};
  /** Where the own creature was drawn on the last frames (the E2E `trail` hook). */
  private readonly trail = new MotionTrail();
  /**
   * What waits for the next click on the map (the crosshair): a "use with" tool (T1.12) or
   * a heal for another player (T3.1). Any other cast or use drops it (`state/aim.ts`).
   */
  private pending: Pending<ItemRef>;
  private readonly opts: GameOptions;
  private hotkeys: (string | undefined)[];
  /** The last tool used on a tile and that tile: which gather sound its result makes. */
  private toolAt: { use: string; pos: Pos } | undefined;
  /** The surface sound of an own step (living world, render/living.ts); made once. */
  private stepEvents: ((to: Pos) => string[]) | undefined;
  /** performance.now() of the last look at which loops should play (frame, LOOPS_EVERY_MS). */
  private loopsAt = Number.NEGATIVE_INFINITY;
  /** The positional ambience over the map (audio/ambience.ts) and its last step. */
  private readonly ambience: Ambience | undefined;
  private ambienceAt = Number.NEGATIVE_INFINITY;
  /** When a key into a pushable object may push again (pushAhead). */
  private pushAt = Number.NEGATIVE_INFINITY;
  /** The safe mode the player chose (T5.2, `state/pvp.ts`). */
  private safe = true;
  /** T5.6: the direction held on the on-screen pad (read like the movement keys). */
  private readonly pad = new HeldDirection();
  /** T5.6: tap an item, then tap where it goes. */
  private readonly picker = new ItemPicker();
  /**
   * T5.6: the open contextual menu, what it acts on, and whether a press started on it
   * since it opened (only then its buttons take clicks: ui/ActionMenu.tsx menuClickCounts).
   */
  private menu: { view: ActionMenuView; target: MenuTarget; pressed: boolean } | undefined;
  /** The pointerup that placed the picked item (the item's own tap must not pick again). */
  private placedBy: Event | undefined;
  /** Where the last pointer went down while an item is picked (a drag is not a tap). */
  private pickDown: { x: number; y: number } | undefined;
  /** performance.now() of the last touch press: a contextmenu right after it is a finger's. */
  private touchAt = Number.NEGATIVE_INFINITY;
  /** The last finger press on a DOM item already opened its menu. */
  private itemMenuOpened = false;
  /** The last spell used from the hotbar (its slot flashes, docs/17 UI-9). */
  private cast: { spellId: string; at: number } | undefined;
  /** The look being picked in the Apariencia window (setLookDraft), not sent yet. */
  private lookDraft: Look | undefined;
  /** The item on the tile the mouse rests on, for its card (docs/17 UI-6). */
  private groundTip: GameUi["groundTip"];
  /** The book or scroll being read (docs/02 "Libros y cofres"); undefined when closed. */
  private book: BookState | undefined;
  /**
   * The last state given to the UI: a change of the ground card alone (the mouse sweeping
   * the map) reuses it instead of building it again (publishTip).
   */
  private shown: GameUi | undefined;
  /** A Shift+drag of a stack, dropped, waiting for how many move (ui/SplitPrompt.tsx). */
  private split: { ref: ItemRef; to: ItemLoc; x: number; y: number } | undefined;
  /** The item dragged with the pointer right now (docs/17 UI-5). */
  private dragging: ItemRef | undefined;
  /** The map's zoom this device remembers (undefined = fit the view) and the one drawn. */
  private zoomPref: number | undefined;
  private zoomView: ZoomView | undefined;

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.hotkeys = loadHotkeys(opts.content.spells, opts.vocation, opts.storage);
    this.safe = loadSafeMode(opts.storage);
    this.zoomPref = loadZoom(opts.storage);
    this.world = new WorldState(opts.content);
    this.stepEvents = stepSoundEvents(this.world, opts.content);
    this.ambience = mountAmbience(this.world, opts.content);
    this.steer = new Steering({
      portals: opts.content.portals,
      diagonalCost: opts.content.movement.diagonalCost,
      maxPathTiles: opts.content.movement.maxPathTiles,
    });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("focusin", this.onFocusIn);
    this.conn = new Connection(opts.sessionToken, opts.locale, {
      batch: (batch) => {
        const now = performance.now();
        // The steps of this batch start on the server's tick timeline (state/motion.ts).
        const at = this.world.batchTime(Number(batch.tick), now);
        const cues: Cue[] = [];
        for (const e of batch.events) {
          if (opts.audio) cues.push(...cuesOf(e.message, this.cueContext()));
          this.world.apply(e.message, now, at);
          this.steer.heard(e.message);
          if (e.message.case === "creatureLook") this.lookAnswered(e.message.value.id);
          if (e.message.case === "welcome") this.trackAfterWelcome = true;
          if (e.message.case === "welcome" && !this.safe) {
            // T5.2: the server starts every login in safe mode.
            this.conn.send({ case: "setSafeMode", value: { enabled: false } });
          }
        }
        this.sound(cues);
        if (this.trackAfterWelcome && this.world.self) {
          // The tracked quest is not saved by the server (docs/05 TrackQuest): sent again.
          this.trackAfterWelcome = false;
          const id = loadTracked(this.world.self.name);
          if (id) this.conn.send({ case: "trackQuest", value: { questId: id } });
        }
        if (this.world.self && !this.canvas && !this.starting && !this.canvasFailed)
          void this.startCanvas();
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

  /**
   * One forge attempt (docs/02 "Forja") on item at the open station: the piece's mods as the
   * client sees them go along (refineMessage), so a repeated click never refines twice nor
   * another piece. The server answers with RefineResult or a system message.
   */
  refine(item: ForgeCandidate, protect: boolean): void {
    const s = this.world.station;
    if (!s) return;
    this.conn.send({ case: "refine", value: refineMessage(s.pos, item, protect) });
  }

  closeStation(): void {
    if (!this.world.station) return;
    this.world.station = undefined;
    this.publish();
  }

  /** Opens the reading window on a book or scroll (docs/02 "Libros y cofres"). */
  openBook(itemId: number): void {
    if (!bookOf(this.opts.content, itemId)) return;
    this.book = { itemId, at: performance.now() };
    this.publish();
  }

  /** Closes the reading window (nothing goes to the server). */
  closeBook(): void {
    if (!this.book) return;
    this.book = undefined;
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

  /** Adds an item of an open container or of the pockets to the own trade offer. */
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

  /** mods: the instance of an equipable to sell (MarketUpdate.owned_mods). */
  marketCreate(
    sell: boolean,
    itemId: number,
    amount: number,
    price: number,
    durationIndex: number,
    mods?: ItemMods | undefined,
  ): void {
    const side = sell ? MarketSide.SELL : MarketSide.BUY;
    this.conn.send({
      case: "marketCommand",
      value: {
        action: {
          case: "create",
          value: {
            side,
            itemId,
            amount,
            price: BigInt(price),
            durationIndex,
            ...(mods ? { mods } : {}),
          },
        },
      },
    });
  }

  /** mods: selling an equipable to a buy offer, the instance the player picked. */
  marketAccept(offerId: bigint, amount: number, mods?: ItemMods | undefined): void {
    this.conn.send({
      case: "marketCommand",
      value: { action: { case: "accept", value: { offerId, amount, ...(mods ? { mods } : {}) } } },
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

  // ---- houses (T5.4): the server validates the door, the owner, money and limits ----

  houseRent(): void {
    this.conn.send({ case: "houseCommand", value: { action: { case: "rent", value: {} } } });
  }

  houseExtend(): void {
    this.conn.send({ case: "houseCommand", value: { action: { case: "extend", value: {} } } });
  }

  houseLeave(): void {
    this.conn.send({ case: "houseCommand", value: { action: { case: "leave", value: {} } } });
  }

  houseGuest(name: string, add: boolean): void {
    this.conn.send({
      case: "houseCommand",
      value: {
        action: add
          ? { case: "guestAdd", value: { name } }
          : { case: "guestRemove", value: { name } },
      },
    });
  }

  houseGuildAccess(enabled: boolean): void {
    this.conn.send({
      case: "houseCommand",
      value: { action: { case: "guildAccess", value: { enabled } } },
    });
  }

  houseTransfer(name: string, price: number): void {
    this.conn.send({
      case: "houseCommand",
      value: { action: { case: "transferOffer", value: { name, price: BigInt(price) } } },
    });
  }

  houseTransferCancel(): void {
    this.conn.send({
      case: "houseCommand",
      value: { action: { case: "transferCancel", value: {} } },
    });
  }

  /** Accepts the transfer of houseId at the price the player saw (refused if it changed). */
  houseAccept(houseId: string, price: number): void {
    this.conn.send({
      case: "houseCommand",
      value: { action: { case: "transferAccept", value: { houseId, price: BigInt(price) } } },
    });
  }

  /** Steps in (past whoever stands at the door) or out of the house of the window. */
  houseEnter(): void {
    this.conn.send({ case: "houseCommand", value: { action: { case: "enter", value: {} } } });
  }

  houseExit(): void {
    this.conn.send({ case: "houseCommand", value: { action: { case: "exit", value: {} } } });
  }

  /** Closes the house window (the server forgets it too). */
  houseClose(): void {
    if (!this.world.house) return;
    this.world.house = undefined;
    this.conn.send({ case: "houseCommand", value: { action: { case: "close", value: {} } } });
    this.publish();
  }

  // ---- account stash (docs/02 "Baúl de la cuenta"): the server checks the chest, the item,
  // room and weight, and answers every move with a StashUpdate ----

  /** Puts count units of a carried item (an open container or the pockets) in the stash. */
  stashDeposit(ref: ItemRef, count: number): void {
    this.conn.send({
      case: "stashCommand",
      value: {
        action: {
          case: "deposit",
          value: { from: locationInit(ref.loc), itemId: ref.itemId, count },
        },
      },
    });
  }

  /** Takes count units of a stash cell (as the window shows it) into the backpack. */
  stashWithdraw(cell: StashCell, count: number): void {
    this.conn.send({
      case: "stashCommand",
      value: {
        action: {
          case: "withdraw",
          value: {
            index: cell.index,
            itemId: cell.itemId,
            count,
            ...(cell.mods ? { mods: cell.mods } : {}),
          },
        },
      },
    });
  }

  /** Closes the stash window (the server forgets it too). */
  stashClose(): void {
    if (!this.world.stash) return;
    this.world.stash = undefined;
    this.conn.send({ case: "stashCommand", value: { action: { case: "close", value: {} } } });
    this.publish();
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

  /** Puts on an owned cosmetic (T5.7); the server answers with CosmeticsState. */
  equipCosmetic(cosmeticId: string): void {
    this.conn.send({ case: "equipCosmetic", value: { cosmeticId } });
  }

  /** Goes back to the default look of one kind (outfit, outfit_color, name_effect). */
  unequipCosmetic(kind: string): void {
    this.conn.send({ case: "unequipCosmetic", value: { kind } });
  }

  /**
   * The look the Apariencia window shows while the player picks (docs/02 "Apariencia"):
   * nothing is sent until applyLook. undefined goes back to the one it has.
   */
  setLookDraft(look: Look | undefined): void {
    this.lookDraft = look;
    this.publish();
  }

  /**
   * Sends the look being picked (SetLook): free; the server answers with a CreatureLook to
   * the player and to everyone who sees it, or appearance.invalid.
   */
  applyLook(): void {
    const draft = this.lookDraft;
    if (!draft || sameLook(draft, this.world.self?.look)) return;
    this.conn.send({ case: "setLook", value: { look: { ...draft } } });
  }

  /**
   * A CreatureLook came: when it is the player's own and shows the look being picked, the
   * change went through and the draft is done. Any other (a piece of equipment changed
   * while picking, a refused look) keeps the draft.
   */
  private lookAnswered(id: number): void {
    if (id !== this.world.selfId || !this.lookDraft) return;
    if (sameLook(this.lookDraft, this.world.self?.look)) this.lookDraft = undefined;
  }

  /** Asks the server to end the tutorial (T4.2); the panel closes when it says so. */
  /**
   * Tracks quest id on the minimap ("" stops): the server answers with its estimate. Kept
   * per character on this device and sent again at every login.
   */
  trackQuest(id: string): void {
    this.conn.send({ case: "trackQuest", value: { questId: id } });
    const name = this.world.self?.name;
    if (name) saveTracked(name, id);
  }

  /** Asks the server for explored minimap sectors of floor z (MinimapState.wanted). */
  minimapRequest(z: number, sectors: number[]): void {
    if (sectors.length > 0) this.conn.send({ case: "minimapRequest", value: { z, sectors } });
  }

  private readonly minimapColours = new Map<number, readonly [number, number, number]>();

  /**
   * What the minimap paints with: the explored state, the colour item of a tile (what the
   * server gave, else what the client was sent of it: MinimapState.item, kept after the
   * map itself is forgotten) and an item's colour (the atlas's
   * average of its sprite; a plain shade by kind until the atlas is up or without one).
   */
  minimapSource(): {
    state: MinimapState;
    tileItem(x: number, y: number, z: number): number;
    colour(item: number): readonly [number, number, number];
  } {
    const w = this.world;
    return {
      state: w.minimap,
      tileItem: (x, y, z) => w.minimap.item(x, y, z),
      colour: (item) => {
        let c = this.minimapColours.get(item);
        if (c) return c;
        const hex = this.canvas?.itemColor(item);
        const def = w.item(item);
        c = hex
          ? parseHex(hex)
          : def?.blocks
            ? ([110, 104, 96] as const)
            : def?.ground && !def.walkable
              ? ([38, 64, 112] as const)
              : ([64, 88, 52] as const);
        if (hex) this.minimapColours.set(item, c);
        return c;
      },
    };
  }

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
    // Its slot flashes (docs/17 UI-9), whatever the server answers.
    this.cast = { spellId, at: performance.now() };
    this.publish();
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
    // docs/02 "Libros y cofres": a book or scroll opens the reading window with the texts
    // the client has; the server is not asked (state/book.ts).
    if (bookOf(this.opts.content, ref.itemId)) {
      this.setPending(undefined);
      this.toolAt = undefined;
      this.openBook(ref.itemId);
      return;
    }
    const useWith = this.opts.content.items[ref.itemId]?.useWith ?? false;
    this.setPending(afterUse(ref, useWith));
    this.toolAt = undefined;
    if (!useWith) this.sendUse(ref);
  }

  /** The UseItem of ref, and nothing else (what the player aimed at stays aimed). */
  private sendUse(ref: ItemRef): void {
    // docs/17 UI-5: the window this opens is the equipped backpack's, under the figure.
    if (ref.loc.kind === "slot" && ref.loc.slot === EquipmentSlot.BACKPACK)
      this.world.backpack.used(ref.itemId, performance.now());
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

  /**
   * Uses a map tile (a right click): a ladder is climbed whatever lies on it; else its top
   * item, or the ground of a bare house door (T5.4: the house window) or rope spot (it
   * says a rope is needed). With `item` (Ctrl+right click, or the touch menu's "use" and
   * "open", whose menu climbs with its own button) the top item even on a ladder
   * (state/portals.ts useMode).
   */
  private useTop(x: number, y: number, z: number, item = false): void {
    const portals = this.opts.content.portals;
    const ground = useMode(portals, this.usesGround(x, y, z), x, y, z, item);
    const ref = tileUse(this.world, x, y, z, ground);
    if (ref) this.useItem(ref);
  }

  /** Whether using the bare tile (x, y, z) means something: a house door or a portal used by hand. */
  private usesGround(x: number, y: number, z: number): boolean {
    const c = this.opts.content;
    return (c.houseDoors?.includes(doorKey(x, y, z)) ?? false) || usedBare(c.portals, x, y, z);
  }

  /**
   * What input/actions.ts knows of a map tile but its creature: `item` (its menuItem), a
   * bare house door or rope spot, a ladder, whether anything is known there.
   */
  private groundFacts(x: number, y: number, z: number, item: ItemRef | undefined): TileFacts {
    return {
      item: item && this.itemFacts(item),
      door: this.usesGround(x, y, z),
      climb: climbable(this.opts.content.portals, x, y, z),
      known: (this.world.tile(x, y, z)?.length ?? 0) > 0,
    };
  }

  /**
   * ART-2: whether a map tile has something of its own to use (a door, an item, a ladder),
   * leaving its creature out: then a head rising into it from the tile below does not take
   * its click (the canvas's creatureUnder), and the click does what the cursor's hint says.
   */
  private ownUse(x: number, y: number, z: number): boolean {
    return defaultAction(this.groundFacts(x, y, z, menuItem(this.world, x, y, z))) !== undefined;
  }

  /** Looks at the creature on a tile, or else at its top item (the ground counts). */
  private lookTileAt(x: number, y: number, z: number): void {
    const c = [...this.world.creatures.values()].find(
      (o) => o.pos.x === x && o.pos.y === y && o.pos.z === z,
    );
    if (c) {
      this.lookCreature(c.id);
      return;
    }
    const ref = topItem(this.world, x, y, z, true);
    if (ref) this.lookAt(ref);
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
        this.walkTo(action.pos);
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
   * Opens the backpack worn on the back (docs/17 UI-5: the inventory opens it by itself
   * when it shows, state/backpack.ts autoOpen). A use of the slot, as a double click, that
   * leaves alone a rune or a tool the player is aiming (useItem would drop it).
   */
  openBackpack(): void {
    const it = this.world.inventory.get(EquipmentSlot.BACKPACK);
    if (!it || (this.opts.content.items[it.itemId]?.slots ?? 0) <= 0) return;
    this.sendUse({
      loc: { kind: "slot", slot: EquipmentSlot.BACKPACK },
      itemId: it.itemId,
      stackIndex: 0,
      count: it.count,
    });
  }

  /**
   * A use of the backpack slot still waits for its answer: the inventory shown again
   * meanwhile does not open the backpack once more (the server would toggle it shut).
   */
  backpackWaiting(): boolean {
    return this.world.backpack.waiting(performance.now());
  }

  /**
   * The player's tile on the page, CSS px (undefined before the canvas is up): a window
   * that opens keeps clear of what is around the player (docs/17 UI-5: the trade never
   * covers the tiles north of it, where the partner stands).
   */
  selfTile(): { left: number; top: number; width: number; height: number } | undefined {
    const s = this.world.self;
    if (!s || !this.canvas) return undefined;
    const c = this.canvas.tileToClient(s.pos.x, s.pos.y);
    const n = this.canvas.tileToClient(s.pos.x + 1, s.pos.y + 1);
    const width = n.x - c.x;
    const height = n.y - c.y;
    return { left: c.x - width / 2, top: c.y - height / 2, width, height };
  }

  /**
   * A press on a DOM item (inventory slot or container cell): it becomes a drag once the
   * pointer travels a few pixels, and the item moves where it is released. With Shift a
   * click looks at the item and a drag moves part of a stack (docs/17 UI-6: it asks how
   * many where it is dropped).
   */
  pressItem(ref: ItemRef, e: PointerEvent): void {
    if (isTouchPointer(e.pointerType)) {
      this.pressItemTouch(ref, e);
      return;
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    const shift = e.shiftKey;
    const move = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_START_PX) return;
      stop();
      this.startDrag(ref, shift);
    };
    const up = (): void => {
      stop();
      if (shift) this.lookAt(ref);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", stop);
  }

  /**
   * Drags ref until the pointer is released over a drop target (canvas, slot, container).
   * `split` (a Shift+drag) of a stack asks first how many units go (splitDrop).
   */
  private startDrag(ref: ItemRef, split = false): void {
    this.closeSplit();
    document.body.classList.add("dragging-item");
    // docs/17 UI-5: the equipment slots that take it glow while it is dragged.
    this.dragging = ref;
    this.groundTip = undefined;
    this.publish();
    const end = (): void => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.body.classList.remove("dragging-item");
      this.dragging = undefined;
      this.publish();
    };
    // The browser took the pointer (a touch turned into a scroll, the window lost it):
    // nothing moves, and the slots stop glowing.
    const cancel = (): void => end();
    const up = (ev: PointerEvent): void => {
      end();
      const to = this.dropTarget(ev.clientX, ev.clientY);
      if (!to) return;
      if (split && splittable(this.opts.content.items[ref.itemId], ref.count)) {
        this.split = { ref, to, x: ev.clientX, y: ev.clientY };
        this.publish();
      } else this.moveItem(ref, to);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  /** How many units of a Shift+dragged stack go where it was dropped (the prompt's OK). */
  splitConfirm(count: number): void {
    const s = this.split;
    this.split = undefined;
    if (s) this.moveItem({ ...s.ref, count: splitCount(count, s.ref.count) }, s.to);
    this.publish();
  }

  /** Drops a Shift+drag without moving anything (the prompt's Cancel or Escape). */
  splitCancel(): void {
    if (this.closeSplit()) this.publish();
  }

  private closeSplit(): boolean {
    if (!this.split) return false;
    this.split = undefined;
    return true;
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
      if (d["drop"] === "pocket") return { kind: "pocket", index: Number(d["index"] ?? 0) };
      return undefined;
    }
    if (this.canvas && el === this.canvas.element) {
      const pos = this.canvas.clientToTile(x, y);
      if (pos) return { kind: "pos", pos };
    }
    return undefined;
  }

  // ---- touch (T5.6): the same intents as the mouse, from taps, long presses and the pad --

  /**
   * A finger on a DOM item: a tap picks it (or places the picked one there), a long press
   * opens its menu, a drag moves it like the mouse.
   */
  private pressItemTouch(ref: ItemRef, e: PointerEvent): void {
    this.touchAt = performance.now();
    this.itemMenuOpened = false;
    const id = e.pointerId;
    const g = new GestureRecognizer();
    // Pointer event times share performance.now()'s clock.
    g.down(id, e.clientX, e.clientY, e.timeStamp);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handle = (gs: Gesture[], ev: PointerEvent | undefined): void => {
      for (const x of gs) {
        if (x.kind === "tap" && ev) this.tapItem(ref, ev);
        else if (x.kind === "longPress" && !this.itemMenuOpened) {
          this.itemMenuOpened = true;
          this.openItemMenu(ref, x.x, x.y);
        } else if (x.kind === "dragStart") this.startDrag(ref);
      }
      if (!g.active || g.deadline() === undefined) clearTimeout(timer);
      if (!g.active) stop();
    };
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId === id) handle(g.move(id, ev.clientX, ev.clientY, ev.timeStamp), ev);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId === id) handle(g.up(id, ev.clientX, ev.clientY, ev.timeStamp), ev);
    };
    const cancel = (ev: PointerEvent): void => {
      if (ev.pointerId === id) handle(g.cancel(id), ev);
    };
    const stop = (): void => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    const due = g.deadline();
    if (due !== undefined) {
      timer = setTimeout(
        () => handle(g.tick(performance.now()), undefined),
        Math.max(0, due - performance.now()),
      );
    }
  }

  /** A tap on a DOM item: places the picked item there, or picks this one. */
  private tapItem(ref: ItemRef, ev: PointerEvent): void {
    if (ev === this.placedBy) return; // the pick listener already placed the picked item
    if (this.picker.picked) {
      const to = this.dropTarget(ev.clientX, ev.clientY);
      if (to) this.placePicked(to);
      return;
    }
    this.pickItem(ref);
  }

  /** Picks ref to move it with the next tap on a slot, a container cell or a map tile;
   * the picked item again drops the pick. */
  pickItem(ref: ItemRef): void {
    this.closeMenuQuietly();
    this.watchPick(this.picker.pick(ref) !== undefined);
    this.publish();
  }

  /** Drops the picked item without moving it; reports whether there was one. */
  cancelPick(): boolean {
    if (!this.picker.cancel()) return false;
    this.watchPick(false);
    this.publish();
    return true;
  }

  /** The item waiting for its destination (T5.6), if any. */
  get picked(): ItemRef | undefined {
    return this.picker.picked;
  }

  /** Moves the picked item to `to` (MoveItem; the server validates it like a drop). */
  private placePicked(to: ItemLoc): void {
    const move = this.picker.place(to);
    this.watchPick(false);
    if (move) this.moveItem(move.ref, move.to);
    this.publish();
  }

  private watchPick(on: boolean): void {
    document.body.classList.toggle("picking-item", on);
    window.removeEventListener("pointerdown", this.onPickDown, true);
    window.removeEventListener("pointerup", this.onPickUp, true);
    this.pickDown = undefined;
    if (!on) return;
    window.addEventListener("pointerdown", this.onPickDown, true);
    window.addEventListener("pointerup", this.onPickUp, true);
  }

  private readonly onPickDown = (e: PointerEvent): void => {
    this.pickDown = { x: e.clientX, y: e.clientY };
  };

  /**
   * While an item is picked, a tap on a DOM drop target (an equipment slot or a container
   * cell, empty or not) places it there. Taps on the map arrive through the canvas.
   */
  private readonly onPickUp = (e: PointerEvent): void => {
    const d = this.pickDown;
    this.pickDown = undefined;
    if (!this.picker.picked || !d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= DEFAULT_GESTURES.slopPx) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el?.closest("[data-drop]")) return;
    const to = this.dropTarget(e.clientX, e.clientY);
    if (!to) return;
    this.placedBy = e;
    this.placePicked(to);
  };

  /** A finger tapped a map tile: place the picked item, aim, attack, talk or walk. */
  private tapTile(pos: Pos): void {
    if (this.closeMenuQuietly()) {
      this.publish(); // a tap beside the open menu only closes it
      return;
    }
    if (this.picker.picked) {
      this.placePicked({ kind: "pos", pos });
      return;
    }
    const c = this.world.creatureAt(pos.x, pos.y, pos.z);
    // A "use with" tool goes on the tile even with a creature there; else the creature is
    // what the finger meant (the mouse's right click: attack it, or talk to an NPC).
    if (c && c.id !== this.world.selfId && this.pending?.kind !== "item")
      this.click({ creature: c.id });
    else this.click({ pos });
  }

  /**
   * A long press on a map tile: the menu of what can be done there. The look of a portal
   * (a ladder's own item) gets no "use" or "move" (state/items.ts menuItem), only its name
   * as the title.
   */
  private longPressTile(pos: Pos, x: number, y: number, mouse = false): void {
    const { x: tx, y: ty, z } = pos;
    const c = this.world.creatureAt(tx, ty, z);
    const top = topItem(this.world, tx, ty, z, false);
    const item = menuItem(this.world, tx, ty, z);
    const actions = tileActions({
      ...this.groundFacts(tx, ty, z, item),
      creature: c && { npc: c.kind === CreatureKind.NPC, self: c.id === this.world.selfId },
    });
    if (actions.length === 0) return;
    // The player itself on the tile: the menu is about what lies there.
    const other = c && c.id !== this.world.selfId ? c : undefined;
    const title = other
      ? creatureName(other, this.opts.t)
      : top
        ? this.itemTitle(top.itemId)
        : c
          ? creatureName(c, this.opts.t)
          : "";
    // The card of the item there (docs/17 UI-6), unless the menu is about a creature.
    const card = !other && top ? this.card(top) : undefined;
    // A right click on bare ground opens nothing: the mouse looks with Shift+click.
    if (mouse && !card && actions.length === 1 && actions[0] === "look") return;
    this.openMenu(
      { x, y, title, actions, card, mouse, stack: item?.count },
      { tile: { ...pos }, creature: c?.id },
    );
  }

  /** The menu of a DOM item: its default action first, look, move, maybe move part. */
  private openItemMenu(ref: ItemRef, x: number, y: number, mouse = false): void {
    const actions = itemActions(this.itemFacts(ref));
    const title = this.itemTitle(ref.itemId);
    this.openMenu({ x, y, title, actions, card: this.card(ref), mouse, stack: ref.count }, { ref });
  }

  /** What the menu needs to know of an item to offer its buttons (input/actions.ts). */
  private itemFacts(ref: ItemRef): ItemFacts {
    const def = this.opts.content.items[ref.itemId];
    return {
      container: (def?.slots ?? 0) > 0,
      book: def?.book !== undefined,
      chest: def?.chest === true,
      useWith: def?.useWith === true,
      food: (def?.consumable?.foodMs ?? 0) > 0,
      equip: ref.loc.kind !== "slot" && equipSlot(def) !== undefined,
      split: def?.stackable === true && ref.count > 1,
      fixed: def?.fixed === true,
      usable:
        def?.door === true ||
        def?.board === true ||
        def?.chest === true ||
        def?.book !== undefined ||
        this.opts.content.recipes.some((r) => r.station === ref.itemId),
    };
  }

  /** Who looks at an item card: the player's level, vocation and magic level. */
  private viewer(): Viewer {
    const magic = this.world.skills.find((s) => s.id === "magic");
    return {
      level: this.world.stats?.level,
      vocation: this.opts.vocation,
      magicLevel: magic?.level,
    };
  }

  /** The card of an item (docs/17 UI-6) for the player, with the instance's attribute. */
  card(ref: { itemId: number; count: number; mods?: ItemMods | undefined }): ItemCardView {
    const c = this.opts.content;
    return itemCard(
      c.items[ref.itemId],
      ref.itemId,
      ref.count,
      this.viewer(),
      ref.mods,
      c.attributes,
      false,
      c.forge,
    );
  }

  /** The controls mode now (Options → Controls). */
  private controls(): ControlsMode {
    return this.opts.controls?.() ?? loadControls(this.opts.storage);
  }

  /**
   * A right click (contextmenu) on a DOM item: its menu or use it, by the controls mode
   * (input/mouse.ts itemContext). A finger's long press also fires contextmenu: it opens
   * the menu (touchContextMenu) instead.
   */
  itemContextMenu(
    ref: ItemRef,
    e: Pick<MouseEvent, "clientX" | "clientY" | "shiftKey" | "ctrlKey">,
  ): void {
    if (this.touchContextMenu(ref, e.clientX, e.clientY)) return;
    // A right click drops the crosshair of a "use with" tool or an aimed spell, as on the map.
    if (this.cancelUse()) return;
    if (itemContext(e, this.controls()) === "menu")
      this.openItemMenu(ref, e.clientX, e.clientY, true);
    else this.useItem(ref);
  }

  /** A double click on a DOM item: its default action (open, use with, eat, equip, use). */
  itemDefault(ref: ItemRef): void {
    this.closeMenuQuietly();
    this.itemAction(itemPrimary(this.itemFacts(ref)), ref);
    this.publish();
  }

  /** A menu with only an item's card (a shop's item: in no place the player reaches). */
  openCardMenu(itemId: number, x: number, y: number): void {
    const card = this.card({ itemId, count: 1 });
    this.openMenu(
      { x, y, title: this.itemTitle(itemId), actions: [], card, mouse: true },
      { card: true },
    );
  }

  /** Does one of an item's menu actions (use, open, read, use with, eat, equip, look, move). */
  private itemAction(kind: ActionKind, ref: ItemRef): void {
    if (
      kind === "use" ||
      kind === "open" ||
      kind === "read" ||
      kind === "use_with" ||
      kind === "eat"
    )
      this.useItem(ref);
    else if (kind === "equip") this.equip(ref);
    else if (kind === "look") this.lookAt(ref);
    else if (kind === "move") this.pickItem(ref);
  }

  /** Moves an item to its equipment slot (the menu's "Equip"; the server checks it). */
  private equip(ref: ItemRef): void {
    const slot = equipSlot(this.opts.content.items[ref.itemId]);
    if (slot !== undefined) this.moveItem(ref, { kind: "slot", slot });
  }

  private itemTitle(itemId: number): string {
    const def = this.opts.content.items[itemId];
    return def ? this.opts.t(`item.${def.id}.name`) : "";
  }

  private openMenu(view: ActionMenuView, target: MenuTarget): void {
    this.menu = { view, target, pressed: false };
    this.publish();
  }

  /** A press started on the open menu (a new finger, a pen or the mouse on its buttons). */
  menuPress(): void {
    if (this.menu) this.menu.pressed = true;
  }

  /** Whether a press started on the open menu since it opened. */
  get menuPressed(): boolean {
    return this.menu?.pressed ?? false;
  }

  /** Closes the contextual menu without doing anything. */
  closeMenu(): void {
    if (this.closeMenuQuietly()) this.publish();
  }

  private closeMenuQuietly(): boolean {
    if (!this.menu) return false;
    this.menu = undefined;
    return true;
  }

  /** A button of the contextual menu: the same intent the mouse sends for it. */
  menuChoose(kind: ActionKind): void {
    const m = this.menu;
    this.menu = undefined;
    if (!m) return;
    const t = m.target;
    if ("ref" in t) {
      this.itemAction(kind, t.ref);
    } else if ("tile" in t) {
      const { x, y, z } = t.tile;
      if ((kind === "attack" || kind === "talk") && t.creature !== undefined)
        this.attack(t.creature);
      else if (kind === "climb") this.useTop(x, y, z);
      else if (
        kind === "use" ||
        kind === "open" ||
        kind === "read" ||
        kind === "use_with" ||
        kind === "eat"
      )
        this.useTop(x, y, z, true);
      else if (kind === "look") this.lookTileAt(x, y, z);
      else if (kind === "move" || kind === "equip") {
        const ref = menuItem(this.world, x, y, z);
        if (ref) this.itemAction(kind, ref);
      }
    }
    this.publish();
  }

  /** "Move part…" of the menu: picks `count` units of its stack, placed by the next click. */
  menuSplit(count: number): void {
    const m = this.menu;
    this.menu = undefined;
    if (!m) return;
    const t = m.target;
    const ref =
      "ref" in t
        ? t.ref
        : "tile" in t
          ? menuItem(this.world, t.tile.x, t.tile.y, t.tile.z)
          : undefined;
    if (ref) this.pickItem({ ...ref, count: Math.max(1, Math.min(count, ref.count)) });
    this.publish();
  }

  /**
   * A double click on a map tile (menu controls, docs/17 UI-6): what the classic right
   * click does there (attack or talk to its creature, climb, use its top item). The walk
   * the double click's first click started is stopped: it meant this, not walking.
   */
  private doubleClickTile(pos: Pos): void {
    if (this.controls() !== "menu") return;
    if (performance.now() - this.touchAt < TOUCH_CONTEXTMENU_MS) return; // a finger's taps
    // The route its first click started ends; the steps already sent are taken (no
    // StopWalk: the client waits for every Walk's answer, docs/05 "Caminar").
    this.steer.cancel();
    this.closeMenuQuietly();
    const c = this.world.creatureAt(pos.x, pos.y, pos.z);
    if (c && c.id !== this.world.selfId) this.attack(c.id);
    else if (!this.cancelUse()) this.useTop(pos.x, pos.y, pos.z);
    this.publish();
  }

  /**
   * The on-screen pad (T5.6): a finger holds a direction; holding keeps walking. A new
   * direction (the pointer moves report the same one again and again) tries a step the
   * server refused once more, like a fresh key press (WorldState.retryWalk).
   */
  padPress(dir: Direction): void {
    if (this.pad.current !== dir) this.world.retryWalk();
    this.pad.press(dir);
  }

  padRelease(): void {
    this.pad.release();
    this.world.retryWalk();
  }

  /** One step (a pad button activated from the keyboard). */
  padStep(dir: Direction): void {
    this.pad.tap(dir);
    this.padStepped = dir;
    this.world.retryWalk();
  }

  /**
   * True when a contextmenu event comes from a finger's long press (mobile browsers send
   * one): the DOM item handler does not use the item then. Given the item and where the
   * event happened, it opens the item's menu if the finger's long press has not yet (the
   * browser may cancel the pointer for its own long press before our timer fires).
   */
  touchContextMenu(ref?: ItemRef, x?: number, y?: number): boolean {
    if (performance.now() - this.touchAt >= TOUCH_CONTEXTMENU_MS) return false;
    if (ref && x !== undefined && y !== undefined && !this.itemMenuOpened) {
      this.itemMenuOpened = true;
      this.openItemMenu(ref, x, y);
    }
    return true;
  }

  /** Zooms the map `steps` whole scales in (+) or out (-) (the +/- buttons). */
  zoom(steps: number): void {
    this.canvas?.zoomBy(steps);
  }

  /** Atlas rectangle of an item's sprite, for DOM icons (undefined until the canvas is up). */
  itemIcon(itemId: number): ReturnType<GameCanvas["itemIcon"]> {
    return this.canvas?.itemIcon(itemId);
  }

  /** Atlas rectangle of any sprite (an NPC's portrait), undefined until the canvas is up. */
  spriteIcon(path: string): ReturnType<GameCanvas["spriteIcon"]> {
    return this.canvas?.spriteIcon(path);
  }

  /** Atlas rectangle of a PvP mark's sprite, for the battle list (undefined without art). */
  markIcon(mark: Skull): ReturnType<GameCanvas["markIcon"]> {
    return this.canvas?.markIcon(mark);
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

  /** The open containers as the UI shows them: the equipped backpack apart (docs/17 UI-5). */
  private containersUi(): Pick<GameUi, "containers" | "backpack"> {
    const { backpack, others } = this.world.backpack.split(this.world.containers);
    return { containers: others, backpack };
  }

  private trackAfterWelcome = false;

  /** The minimap's part of GameUi; the own view is explored here, as the server does. */
  private minimapUi(): MinimapUi | undefined {
    const w = this.world;
    const s = w.self;
    if (!s) return undefined;
    w.minimap.revealView(s.pos.x, s.pos.y, s.pos.z, w.view.width, w.view.height);
    const party: MinimapUi["party"] = [];
    for (const m of w.party.party?.members ?? []) {
      const c = m.id === w.selfId ? undefined : w.creatures.get(m.id);
      if (c && c.pos.z === s.pos.z) party.push({ id: m.id, x: c.pos.x, y: c.pos.y });
    }
    return {
      version: w.minimap.version,
      self: { x: s.pos.x, y: s.pos.y, z: s.pos.z, dir: s.dir },
      party,
      hint: w.minimap.hint,
      tracked: w.minimap.tracked,
    };
  }

  private publish(): void {
    const w = this.world;
    const self = w.self;
    if (w.station && self && !nearStation(w.station, self.pos)) w.station = undefined;
    const ui: GameUi = {
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
      pockets: w.pockets,
      // docs/17 UI-5: the equipped backpack goes under the figure, not in a window.
      ...this.containersUi(),
      hotkeys: this.hotkeys,
      dialog: w.dialog,
      shop: w.shop,
      station: w.station,
      refine: w.refine,
      trade: w.trade,
      market: w.market,
      house: w.house,
      stash: w.stash,
      book: this.book,
      // Until answered or out of time (the server sends nothing on a timeout).
      presence: w.activePresence(performance.now()),
      tutorial: w.tutorial,
      quests: w.quests,
      minimap: this.minimapUi(),
      clockOffset: w.clockOffset,
      party: w.party.party,
      invitations: [...w.party.invitations(performance.now())],
      guild: w.guild.view(performance.now()),
      safeMode: this.safe,
      guildInvitations: [...w.guild.invitations(performance.now())],
      selfName: w.self?.name ?? "",
      selfId: w.selfId,
      picked: this.picker.picked,
      dragging: this.dragging,
      menu: this.menu?.view,
      vocation: this.opts.vocation,
      cosmetics: w.cosmetics,
      look: w.self?.look,
      lookDraft: this.lookDraft,
      selfEquipment: w.self?.equipment,
      zoom: this.zoomView,
      cast: this.cast,
      groundTip: this.groundTip,
      split: this.split && {
        x: this.split.x,
        y: this.split.y,
        itemId: this.split.ref.itemId,
        count: this.split.ref.count,
      },
    };
    this.shown = ui;
    this.opts.update(ui);
    this.armPresenceTimer();
  }

  /**
   * Only the ground card changed (docs/17 UI-6: it follows the mouse from tile to tile at
   * once): the last state with the new card, without building the battle list or copying
   * the log and the chat again on every tile the mouse crosses.
   */
  private publishTip(): void {
    if (!this.shown) {
      this.publish();
      return;
    }
    this.shown = { ...this.shown, groundTip: this.groundTip };
    this.opts.update(this.shown);
  }

  // ---- sound (T3.7): what each event sounds like is assets/sounds.yaml --------------------

  private cueContext(): CueContext {
    const station = this.world.station;
    const craft = station
      ? this.opts.content.recipes.find((r) => r.station === station.itemId)?.craft
      : undefined;
    return { selfId: this.world.selfId, tool: this.toolAt, craft, stepEvents: this.stepEvents };
  }

  /** Plays a batch's cues around the player and keeps the zone's loops. */
  private sound(cues: readonly Cue[]): void {
    const audio = this.opts.audio;
    const self = this.world.self;
    if (!audio || !self) return;
    for (const c of cues) audio.play(c.events, c.pos, self.pos);
    this.keepLoops(performance.now());
  }

  /**
   * The music's scene for now: the zone, an important quest's area
   * and a boss in view (assets/sounds.yaml `music`, audio/cues.ts sceneFor; the music
   * director, audio/director.ts, decides what plays and when). An ordinary fight is not
   * part of it: the owner keeps the zone's music on (2026-11-18). After each batch and,
   * because a boss leaves the view without a message, every LOOPS_EVERY_MS from the frame.
   */
  private keepLoops(now: number): void {
    const audio = this.opts.audio;
    const self = this.world.self;
    if (!audio || !self) return;
    this.loopsAt = now;
    const { islands, sounds, questMusic } = this.opts.content;
    const bosses = Object.keys(sounds.music.bosses).length > 0;
    const inView = bosses ? this.world.battleList().map((c) => c.contentId) : [];
    audio.setMusic(sceneFor(self.pos, islands, sounds.music, questMusic ?? [], inView));
  }

  /**
   * The ambience's loops for where the player stands (livingworld/README.md "Ambiente"):
   * every AMBIENCE_STEP_MS from the frame; the engine ramps between the steps.
   */
  private keepAmbience(now: number): void {
    const self = this.world.self;
    if (!this.opts.audio || !self) return;
    this.ambienceAt = now;
    this.opts.audio.setAmbience(ambienceAt(this.ambience, now, self.pos));
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.presenceTimer);
    // The ambience fades out; the music goes on until the menus set the title's (App.tsx).
    this.opts.audio?.setAmbience([]);
    this.cancelUse();
    this.picker.cancel();
    this.watchPick(false);
    this.pad.clear();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("focusin", this.onFocusIn);
    this.conn.close();
    this.canvas?.destroy();
    this.canvas = undefined;
    if (__RPG_E2E_HOOKS__) delete window.__rpgClient;
  }

  /**
   * Starts the canvas again after it failed (the "Retry" button of the error): the atlas is
   * fetched again with its retries, and the session, still open, goes on as if nothing
   * happened. Does nothing unless it failed.
   */
  retryCanvas(): void {
    if (!this.canvasFailed || this.destroyed || this.canvas || this.starting) return;
    this.canvasFailed = false;
    void this.startCanvas();
  }

  private async startCanvas(): Promise<void> {
    this.starting = true;
    let canvas: GameCanvas;
    try {
      canvas = await this.makeCanvas();
    } catch (e) {
      this.starting = false;
      if (this.destroyed) return;
      // Not again on the next batch: the player retries with the button (a server batch
      // arrives every few ticks, which would hammer a server that is down).
      this.canvasFailed = true;
      console.warn("game canvas failed to start", e);
      this.opts.loadFailed?.();
      return;
    }
    this.starting = false;
    if (this.destroyed) {
      canvas.destroy();
      return;
    }
    this.canvas = canvas;
    this.publishHooks(canvas);
    this.publish(); // icons are available now
    this.opts.entered();
  }

  private makeCanvas(): Promise<GameCanvas> {
    return createGameCanvas(this.opts.host, {
      world: this.world,
      content: this.opts.content,
      t: this.opts.t,
      frame: (now) => this.frame(now),
      playSound: (id, at) => this.opts.audio?.playId(id, at, this.world.self?.pos),
      clickTile: (x, y, z) => {
        // A picked item (the menu's "Move", docs/17 UI-6) goes where the mouse clicks.
        if (this.picker.picked) this.placePicked({ kind: "pos", pos: { x, y, z } });
        else this.click({ pos: { x, y, z } });
      },
      menuTile: (x, y, z, cx, cy) => {
        if (this.cancelUse()) return;
        this.longPressTile({ x, y, z }, cx, cy, true);
      },
      doubleClickTile: (x, y, z) => this.doubleClickTile({ x, y, z }),
      pressTile: (x, y, z) => this.pressTile({ x, y, z }),
      holdAt: (x, y) => {
        // The route of the press ends: the cursor leads now (state/steering.ts).
        this.hold = { x, y };
      },
      holdEnd: () => {
        // The steps already sent are taken, as when a key is let go: no StopWalk.
        this.hold = undefined;
      },
      walkMark: () => this.steer.mark,
      hoverText: (x, y, z) => this.hoverText({ x, y, z }),
      restTile: (at) => this.restTile(at),
      shake: () => (this.opts.cameraShake?.() ?? true) && !motionReduced(document.documentElement),
      bubbles: () => this.opts.chatBubbles?.() ?? true,
      nameSize: () => this.opts.nameSize?.() ?? DEFAULT_NAME_SIZE,
      controls: () => this.controls(),
      clickCreature: (id) => this.click({ creature: id }),
      useTile: (x, y, z, top) => {
        if (this.cancelUse()) return;
        this.useTop(x, y, z, top);
      },
      lookTile: (x, y, z) => this.lookTileAt(x, y, z),
      doorAt: (x, y, z) =>
        (this.opts.content.houseDoors?.includes(doorKey(x, y, z)) ?? false) ||
        (this.world.tile(x, y, z)?.some((id) => this.world.item(id)?.door === true) ?? false),
      ownUse: (x, y, z) => this.ownUse(x, y, z),
      dragTile: (x, y, z, e) => {
        const ref = topItem(this.world, x, y, z, false);
        // Shift+drag from the map moves part of its stack too (docs/17 UI-6).
        if (ref) this.startDrag(ref, e.shiftKey);
      },
      tapTile: (x, y, z) => this.tapTile({ x, y, z }),
      longPressTile: (x, y, z, cx, cy) => this.longPressTile({ x, y, z }, cx, cy),
      touched: () => {
        this.touchAt = performance.now();
      },
      zoom: this.zoomPref,
      zoomed: (pref) => {
        this.zoomPref = pref;
        saveZoom(pref, this.opts.storage);
      },
      zoomView: (view) => {
        this.zoomView = view;
        // The first one comes before the canvas is up: startCanvas publishes then.
        if (this.canvas) this.publish();
      },
    });
  }

  /**
   * The read-only E2E hooks, once the canvas is up (`ready`). Only in the dev server or an
   * RPG_E2E_HOOKS=1 build (`__RPG_E2E_HOOKS__`): a production build has none of this code.
   */
  private publishHooks(canvas: GameCanvas): void {
    if (!__RPG_E2E_HOOKS__) return;
    const world = this.world;
    window.__rpgClient = {
      ready: true,
      self() {
        const s = world.self;
        if (!s) return undefined;
        const now = performance.now();
        return {
          ...s.pos,
          pending: world.unconfirmed > 0,
          walking: world.walking(s, now),
          dir: s.dir,
        };
      },
      trail: (ms) => this.trail.since(performance.now() - ms),
      stepMs: (x, y, z) => {
        const s = world.self;
        return s ? world.stepDuration({ x, y, z }, s.speed, false) : 0;
      },
      walkable: (x, y, z) => world.free(x, y, z),
      tileToClient: (x, y) => canvas.tileToClient(x, y),
      scale: () => canvas.scale,
      zoom: () => canvas.zoom,
      view: () => ({ server: world.view, shown: canvas.shown }),
      labels: () => canvas.labels(),
      wallFade: (x, y) => canvas.wallFade(x, y),
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
      pockets: () => ({
        capacity: world.pockets.capacity,
        items: world.pockets.items.map((it) => ({ itemId: it.itemId, count: it.count })),
      }),
      containers: () => world.containers,
      book: () => this.book?.itemId,
      tile: (x, y, z) => world.tile(x, y, z),
      magic: (ms) => {
        const now = performance.now();
        return {
          projectiles: world.projectiles.filter((p) => now - p.start < ms).length,
          effects: world.effects.filter((e) => now - e.start < ms).map((e) => e.effectId),
        };
      },
      attacks: (ms) => {
        const now = performance.now();
        return world.attacks
          .filter((a) => now - a.start < ms)
          .map((a) => ({ id: a.id, kind: a.kind, targetId: a.targetId }));
      },
      departures: (ms) => {
        const now = performance.now();
        return world.departures
          .filter((d) => now - d.start < ms)
          .map((d) => ({ id: d.id, reason: DisappearReason[d.reason] }));
      },
      poses: () => canvas.poses(),
      bubbles: () => canvas.bubbles(),
      sky: () => canvas.sky(),
      npcs: () =>
        [...world.creatures.values()]
          .filter((c) => c.kind === CreatureKind.NPC)
          .map((c) => ({ id: c.id, contentId: c.contentId, ...c.pos })),
      monsters: () =>
        [...world.creatures.values()]
          .filter((c) => c.kind === CreatureKind.MONSTER)
          .map((c) => ({ id: c.id, contentId: c.contentId, ...c.pos })),
      dialog: () => world.dialog,
      shop: () => world.shop,
      cosmetics: () => world.cosmetics,
      players: () =>
        [...world.creatures.values()]
          .filter((c) => c.kind === CreatureKind.PLAYER)
          .map((c) => ({
            id: c.id,
            name: c.name,
            cosmetics: { ...c.cosmetics },
            look: c.look && { ...c.look },
            equipment: { ...c.equipment },
          })),
      itemNumber: (id) => {
        const found = Object.entries(this.opts.content.items).find(([, d]) => d.id === id);
        return found ? Number(found[0]) : undefined;
      },
    };
  }

  private frame(now: number): void {
    const self = this.world.self;
    if (!self) return;
    if (now - this.loopsAt >= LOOPS_EVERY_MS) this.keepLoops(now);
    if (now - this.ambienceAt >= AMBIENCE_STEP_MS) this.keepAmbience(now);
    this.world.expirePredicted(now);
    const drawn = this.world.drawPos(self, now);
    this.trail.record(now, drawn.x, drawn.y);
    this.decideStep(now);
  }

  /**
   * The next own step, decided just before the drawn one ends (STEP_LEAD_MS): its Walk
   * waits in the server's queue and the drawing goes on without a stop. A key or the pad
   * first, then the mouse held on the map, then a click's route (state/steering.ts).
   */
  private decideStep(now: number): void {
    if (!this.world.canStep(now)) return;
    const fromKeys = this.keys.take();
    const key = fromKeys ?? this.pad.take();
    const fresh = fromKeys !== undefined ? this.keys.fresh : this.pad.fresh;
    const stepped = this.padStepped;
    this.padStepped = undefined;
    const self = this.world.self;
    // MOV-2: standing still, a short tap (key or pad) toward another way only turns.
    if (key === undefined || key === stepped || !self) this.turnTap.clear();
    else {
      const still = this.world.standingStill(now);
      const tap = this.turnTap.decide(key, still, self.dir, now, fresh);
      if (tap === "turn") this.sendStep(this.world.turn(key));
      if (tap === "turn" || tap === "wait") return;
    }
    const hold = this.hold;
    const input = this.steerInput;
    input.key = key;
    input.toward = key === undefined && hold ? this.canvas?.worldAt(hold.x, hold.y) : undefined;
    const next = this.steer.next(this.world, now, input);
    // A key into a pushable object (livingworld/README.md) pushes it: the step would be
    // refused, the server moves the object (and nothing else) if the tile behind is free.
    if (next?.kind !== "walk" && key !== undefined) this.pushAhead(key, now);
    this.sendStep(next);
  }

  /** Sends PushObject for the pushable object a step in `dir` walks into, if any. */
  private pushAhead(dir: Direction, now: number): void {
    const to = this.world.pushableAhead(dir);
    if (!to || now < this.pushAt) return;
    this.pushAt = now + PUSH_EVERY_MS;
    this.conn.send({ case: "pushObject", value: { pos: to, dir } });
  }

  private sendStep(step: StepChoice | undefined): void {
    if (step?.kind === "walk")
      this.conn.send({
        case: "walk",
        value: { dir: step.dir, walkEpoch: this.world.walkEpoch, seq: step.seq },
      });
    else if (step?.kind === "turn") this.conn.send({ case: "turn", value: { dir: step.dir } });
  }

  /**
   * Click-to-walk (docs/17 MOV-4, MOV-7): the route is planned from where the client has
   * the player and its first step leaves at once (if none is drawn), predicted like a key.
   */
  private walkTo(pos: Pos): void {
    const now = performance.now();
    this.steer.walkTo(this.world, pos, now);
    this.decideStep(now);
  }

  /**
   * A plain left press on a map tile (docs/17 MOV-3, MOV-7): with nothing aimed or picked,
   * a tile without an item to drag is walked to at once (the first step leaves on the
   * press, not on the release); one with an item waits, so a drag moves the item and a
   * release walks. Held, it walks toward the cursor either way. A press is a fresh intent,
   * like a fresh key press: a step the server refused is tried again (one refusal and one
   * message a press, WorldState.retryWalk); the hold it may become does not retry again.
   */
  private pressTile(pos: Pos): PressAnswer {
    const aiming = this.picker.picked !== undefined || this.pending !== undefined;
    const top = aiming ? undefined : topItem(this.world, pos.x, pos.y, pos.z, false);
    const answer = pressAnswer(
      aiming,
      top !== undefined && this.opts.content.items[top.itemId]?.fixed !== true,
    );
    if (!aiming) this.world.retryWalk();
    if (answer.walked) this.click({ pos });
    return answer;
  }

  /**
   * The default action on a map tile as text for beside the cursor (docs/17 MOV-7, UI-5):
   * what the right click (or, with the menu controls, its menu's first button and the double
   * click) does there. "" for none: bare ground, the own tile with nothing on it.
   */
  private hoverText(pos: Pos): string {
    // Nothing over an open menu (the right click's, z-index under the text's).
    if (this.pending || this.picker.picked || this.menu) return "";
    const { x, y, z } = pos;
    const c = this.world.creatureAt(x, y, z);
    const other = c && c.id !== this.world.selfId ? c : undefined;
    const item = menuItem(this.world, x, y, z);
    const kind = defaultAction({
      ...this.groundFacts(x, y, z, item),
      creature: c && { npc: c.kind === CreatureKind.NPC, self: c.id === this.world.selfId },
    });
    if (kind === undefined) return "";
    const name = other ? creatureName(other, this.opts.t) : item ? this.itemTitle(item.itemId) : "";
    const t = this.opts.t;
    return name && kind !== "climb"
      ? t(`client.action.${kind}`, { name })
      : t(`client.touch.action.${kind}`);
  }

  /**
   * The mouse rested on a map tile (or left it): the card of the item lying there, if it is
   * one people carry (state/item-card.ts groundCard); nothing while a menu, a pick or an
   * aim is up.
   */
  private restTile(
    at: { x: number; y: number; z: number; cx: number; cy: number } | undefined,
  ): void {
    let tip: GameUi["groundTip"];
    if (at && this.canvas && !this.menu && !this.pending && !this.picker.picked && !this.dragging) {
      const ref = menuItem(this.world, at.x, at.y, at.z);
      if (ref && groundCard(this.opts.content.items[ref.itemId])) {
        // The tile in page coordinates (docs/17 UI-6: the card goes above it).
        const c = this.canvas.tileToClient(at.x, at.y);
        const n = this.canvas.tileToClient(at.x + 1, at.y + 1);
        const width = n.x - c.x;
        const height = n.y - c.y;
        tip = {
          itemId: ref.itemId,
          count: Math.max(1, ref.count),
          mods: ref.mods,
          x: at.cx,
          y: at.cy,
          tile: { left: c.x - width / 2, top: c.y - height / 2, width, height },
        };
      }
    }
    if (tip === undefined && this.groundTip === undefined) return;
    this.groundTip = tip;
    this.publishTip();
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
    // T5.6: Escape closes the long-press menu, then drops a picked item.
    if (e.code === "Escape" && this.menu) {
      this.closeMenu();
      e.preventDefault();
      return;
    }
    if (e.code === "Escape" && this.cancelPick()) {
      e.preventDefault();
      return;
    }
    if (e.code === "Escape" && this.world.station && !this.world.dialog) {
      this.closeStation();
      e.preventDefault();
      return;
    }
    if (e.code === "Escape" && this.book) {
      this.closeBook();
      e.preventDefault();
      return;
    }
    if (e.code === "Escape" && this.cancelUse()) {
      e.preventDefault();
      return;
    }
    const d = this.world.dialog;
    if (d && !e.repeat) {
      // 1–9 pick the button with that number, 0 "Back" (state/dialog.ts: the dialog's grid
      // sorted by topic); Escape closes (docs/02-game-design.md, docs/17 UI-8).
      const n = /^(?:Digit|Numpad)([0-9])$/.exec(e.code)?.[1];
      if (n !== undefined) {
        const opt = optionForKey(dialogLayout(this.opts.content, d), Number(n));
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
    // MOV-2: Ctrl+arrow only turns, as in Tibia (with every step confirmed: WorldState.turn).
    const turnTo = e.ctrlKey ? turnKeyDirection(e.code) : undefined;
    if (turnTo !== undefined) {
      e.preventDefault();
      if (!e.repeat) this.sendStep(this.world.turn(turnTo));
      return;
    }
    if (this.keys.down(e.code)) {
      e.preventDefault();
      // A fresh press tries a refused step again; the OS auto-repeat of a held key does not.
      if (!e.repeat) this.world.retryWalk();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.up(e.code);
    if (keyDirection(e.code) !== undefined) this.world.retryWalk();
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.pad.clear();
    this.turnTap.clear();
    this.hold = undefined;
    this.world.retryWalk();
  };

  /** A text field took the focus (the chat): a movement key held until now stops walking. */
  private readonly onFocusIn = (e: FocusEvent): void => {
    if (isTextField(e.target)) this.keys.clear();
  };
}

const TRACK_KEY = "rpg.track";

/** The quest a character tracks on this device ("" or undefined: none). */
export function loadTracked(name: string): string | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(TRACK_KEY) ?? "{}") as Record<string, unknown>;
    const v = all[name];
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch {
    return undefined;
  }
}

function saveTracked(name: string, id: string): void {
  try {
    const all = new Map(
      Object.entries(JSON.parse(localStorage.getItem(TRACK_KEY) ?? "{}") as Record<string, string>),
    );
    if (id) all.set(name, id);
    else all.delete(name);
    localStorage.setItem(TRACK_KEY, JSON.stringify(Object.fromEntries(all)));
  } catch {
    // Storage blocked: tracking lasts for this login only.
  }
}
