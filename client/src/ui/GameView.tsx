// The game screen's DOM over the canvas (docs/17 UI-4, UI-5). Two shapes:
// - desktop (layout "sidebar"): full screen, as the owner asked (2026-11-18): the map
//   fills the screen above the gothic bottom bar (ui/HudBar.tsx: orbs, experience, hotbar
//   and toolbar), the only fixed piece; every window (ui/windows.ts) floats over the map,
//   anywhere the player drops it, with a magnet that aligns it to the edges;
// - tablets and phones (T5.6): the compact header and the side panel as tabs or a drawer.
// It draws what the Game publishes (GameUi) and sends intents through it. App.tsx's
// GameScreen creates the Game; the UI preview (src/preview) feeds this a made-up GameUi.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren, JSX, Ref } from "preact";
import { CreatureKind, FightStance } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import { creatureName, formatMessage } from "../state/messages.ts";
import {
  CHAT_TABS,
  CHAT_TAB_LABEL,
  markSeen,
  nextTab,
  unreadTabs,
  viewedTab,
  wheelAlong,
} from "../state/chat.ts";
import type { ChatTab } from "../state/chat.ts";
import type { ChatLine } from "../state/world.ts";
import { NO_POCKETS } from "../state/pockets.ts";
import { skullId } from "../state/pvp.ts";
import { markIconStyle } from "../render/marks.ts";
import type { Translate } from "../i18n/i18n.ts";
import { typingInField } from "../input/keyboard.ts";
import { motionReduced } from "../state/ui-prefs.ts";
import { ContainerView, InventoryPanel, itemName } from "./Inventory.tsx";
import { Hotbar } from "./Hotbar.tsx";
import { ChatPanel } from "./Chat.tsx";
import { DialogBox, DialogWindow, ShopWindow } from "./Dialog.tsx";
import { CraftingWindow, stationTitle } from "./Crafting.tsx";
import { BookWindow, bookTitle } from "./Book.tsx";
import { TradeWindow } from "./Trade.tsx";
import { HouseWindow } from "./House.tsx";
import { MarketWindow } from "./Market.tsx";
import { PartyInvitations, PartyPanel } from "./Party.tsx";
import { GuildInvitations, GuildPanel } from "./Guild.tsx";
import type { GuildTab } from "./Guild.tsx";
import { AppearancePanel } from "./Appearance.tsx";
import { QuestsPanel } from "./Quests.tsx";
import { CreditsLink } from "./CreditsLink.tsx";
import { PresenceCheck } from "./Presence.tsx";
import { TutorialPanel } from "./Tutorial.tsx";
import { PANEL_TABS, TAB_TITLE, layoutFor, tabForHighlight } from "./layout.ts";
import type { Layout, PanelTab } from "./layout.ts";
import { activeNotices, nextExpiry } from "./notices.ts";
import { ActionMenu, PickBanner, paddingInsets } from "./ActionMenu.tsx";
import { ItemTooltip } from "./ItemTooltip.tsx";
import type { ControlsMode } from "../state/controls.ts";
import { LoadStatus } from "./LoadStatus.tsx";
import { PAD_RESERVE_PX, TouchPad } from "./TouchPad.tsx";
import { ZoomButtons } from "./ZoomButtons.tsx";
import { coarsePointer } from "../state/touch-prefs.ts";
import { GameWindow } from "./GameWindow.tsx";
import type { IconName } from "./icons.tsx";
import { SplitPrompt } from "./SplitPrompt.tsx";
import { Toolbar, windowIcon } from "./Toolbar.tsx";
import { lowHealth } from "./Vitals.tsx";
import { HudBar } from "./HudBar.tsx";
import { StatusTray } from "./StatusTray.tsx";
import { ornamentStyle } from "./ornaments.ts";
import { partyBonus } from "../state/party.ts";
import {
  dragWindow,
  outsiders,
  placeOpened,
  resizeDrag,
  transformScale,
  watchedRef,
} from "./window-dom.ts";
import type { DragEnv, PageBox, WatchedRef } from "./window-dom.ts";
import {
  WINDOWS_STORAGE_KEY,
  WINDOW_KEYS,
  WINDOW_TITLE,
  closeWindow,
  collapseWindow,
  containerKeys,
  containersTop,
  focusWindow,
  isClosable,
  isToolWindow,
  knownWindows,
  loadWindows,
  moveWindow,
  openWindow,
  openWindows,
  pageOrder,
  placeContext,
  placeOf,
  placeWindow,
  resetWindows,
  resizeWindow,
  saveWindows,
  serverWindows,
  shownKey,
  syncWindows,
  toLookAt,
  toggleWindow,
  tutorialCovered,
  windowForHighlight,
  windowKey,
  windowNudge,
} from "./windows.ts";
import type {
  AutoPlace,
  ContainerKey,
  LastLook,
  Rect,
  WinKey,
  WindowId,
  WindowsState,
} from "./windows.ts";

/** The pieces of the desktop Options window (main.tsx builds them: they outlive a game). */
export interface GameSettings {
  language: JSX.Element;
  sound: JSX.Element;
  touchPad: JSX.Element;
  /** What the right button does on items (docs/17 UI-6): the choice and its radios. */
  controlsMode: ControlsMode;
  controls: JSX.Element;
  reducedMotion: boolean;
  setReducedMotion(on: boolean): void;
  /**
   * docs/17 UI-3, UI-9: the interface scale, the text size and the camera shake (Options →
   * Interface; main.tsx keeps them).
   */
  interfaceOptions?: JSX.Element | undefined;
  /** The interface scale (1 = 100 %): the CSS zoom of the bottom bar and the windows. */
  uiScale?: number | undefined;
  /** The camera shakes on a heavy hit (off with reduced motion whatever this says). */
  cameraShake?: boolean | undefined;
}

/** What the screen shows before the first batch of the server. */
export function emptyGameUi(): GameUi {
  return {
    battle: [],
    safeMode: true,
    target: undefined,
    stats: undefined,
    skills: [],
    conditions: [],
    levelUp: undefined,
    voyage: undefined,
    death: undefined,
    log: [],
    chat: [],
    inventory: new Map(),
    pockets: NO_POCKETS,
    containers: [],
    hotkeys: [],
    dialog: undefined,
    shop: undefined,
    station: undefined,
    refine: undefined,
    trade: undefined,
    market: undefined,
    house: undefined,
    presence: undefined,
    tutorial: undefined,
    quests: undefined,
    clockOffset: 0,
    party: undefined,
    invitations: [],
    guild: undefined,
    guildInvitations: [],
    selfName: "",
    selfId: 0,
  };
}

export interface GameViewProps {
  t: Translate;
  content: ClientContent;
  /** Language and sound, for the phone menu. */
  languagePicker: JSX.Element | undefined;
  /** The desktop Options window's pieces. */
  settings: GameSettings | undefined;
  touchPad: boolean;
  characterName: string;
  ui: GameUi;
  game: Game | undefined;
  /** The world arrived and the map is drawn. */
  entered: boolean;
  loadFailed: boolean;
  onRetry(): void;
  /** The map's box: the Game puts its canvas in it. */
  host: Ref<HTMLDivElement>;
  storage: Storage | undefined;
}

export function GameView(props: GameViewProps): JSX.Element {
  const { t, ui, game } = props;
  // .game: its padding is the safe area (client.css), which the long-press menu, fixed to
  // the screen, takes once too.
  const gameBox = useRef<HTMLDivElement>(null);
  const [levelNotice, setLevelNotice] = useState<number | undefined>(undefined);
  const [voyage, setVoyage] = useState<string | undefined>(undefined);
  // The death screen stays until the player closes it.
  const [deathSeen, setDeathSeen] = useState<number | undefined>(undefined);
  const death = ui.death && ui.death.at !== deathSeen ? ui.death : undefined;
  const [stance, setStance] = useState(FightStance.BALANCED);
  // T4.1: the player being reported from the battle list (the reason form is open).
  const [reporting, setReporting] = useState<{ id: number; name: string } | undefined>(undefined);
  const [chase, setChase] = useState(false);
  // T5.6: small screens. The layout follows the window; the side panel becomes tabs (or a
  // drawer over the map) and the server messages float over the map.
  const layout = useLayout();
  useKeyboardViewport();
  // A touch screen gets the map's zoom buttons (a PC zooms with Ctrl+wheel).
  const [touch] = useState(coarsePointer);
  // Portrait with the pad: the hotbar goes right of the pad, slots under their arrows.
  const stackedHotbar = props.touchPad && layout.flow === "column";
  const [tab, setTab] = useState<PanelTab>("battle");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [, setNoticeTick] = useState(0);
  const tabbed = layout.panel !== "sidebar";
  // Desktop: the windows of the toolbar (docs/17 UI-5), remembered per device.
  const windowed = !tabbed;
  const zoom = props.settings?.uiScale ?? 1;
  // The server's windows close through it (docs/17 UI-5): the dialog, the station...
  const serverClose = useRef<(id: WinKey) => void>(() => {});
  // The player's tile on the page: the trade opens clear of the tiles north of it.
  const playerTile = useRef<() => PageBox | undefined>(() => undefined);
  playerTile.current = () => game?.selfTile();
  const win = useWindows(props.storage, serverClose, zoom, playerTile, ui.dialog?.id);
  // One window per open container, with a key that stays while it is open (its place).
  const containerKeysRef = useRef(new Map<number, ContainerKey>());
  const ckeys = windowed
    ? containerKeys(
        containerKeysRef.current,
        ui.containers.map((c) => {
          const def = props.content.items[c.itemId];
          return { id: c.id, item: def?.id ?? "item", fixed: def?.fixed === true };
        }),
      )
    : new Map<number, ContainerKey>();
  containerKeysRef.current = ckeys;
  const serverOpen =
    windowed && props.entered
      ? serverWindows(
          {
            dialog: ui.dialog !== undefined,
            shop: ui.shop !== undefined,
            station: ui.station !== undefined,
            market: ui.market !== undefined,
            house: ui.house !== undefined,
            trade: ui.trade !== undefined,
            book: ui.book !== undefined,
          },
          [...ckeys.values()],
        )
      : [];
  const serverOpenKey = serverOpen.join("|");
  // Before the paint: a window the server opened shows in the same frame.
  useLayoutEffect(() => {
    if (windowed) win.update((s) => syncWindows(s, serverOpen));
  }, [serverOpenKey, windowed]);
  serverClose.current = (id) => {
    if (id === "dialog" || id === "shop") game?.closeDialog();
    else if (id === "crafting") game?.closeStation();
    else if (id === "market") game?.marketClose();
    else if (id === "house") game?.houseClose();
    else if (id === "trade") game?.tradeCancel();
    else if (id === "book") game?.closeBook();
    else
      for (const [cid, key] of ckeys)
        if (key === id) {
          game?.closeContainer(cid);
          break;
        }
  };
  const [guildTab, setGuildTab] = useState<GuildTab>("summary");
  // The chat window's tabs (docs/17 UI-10, state/chat.ts): the lines shown on the open tab
  // count as seen (marked as they render, so a dot never blinks on for a line in view)
  // while the window shows them: folded to its title bar, nothing does (viewedTab); a tab
  // with lines not seen yet gets a dot, the log one when its newest message is.
  const [chatTab, setChatTab] = useState<ChatTab>("chat");
  const chatPlace = placeOf(win.state, "chat");
  const viewed = viewedTab(chatTab, !windowed || (chatPlace.open && !chatPlace.collapsed));
  const [logSeen, setLogSeen] = useState(0);
  const lastLog = ui.log[ui.log.length - 1]?.at ?? 0;
  useEffect(() => {
    if (viewed === "log") setLogSeen(lastLog);
  }, [viewed, lastLog]);
  const chatSeen = useRef(new WeakSet<ChatLine>());
  markSeen(ui.chat, viewed, chatSeen.current);
  const chatUnread = unreadTabs(
    ui.chat,
    (l) => chatSeen.current.has(l),
    viewed,
    props.characterName,
  );
  if (viewed !== "log" && lastLog > logSeen) chatUnread.add("log");
  // With the log out of view (tabs, drawer, the chat tab of the desktop's chat window, or
  // that window folded) every message floats over the map, not only the important ones.
  const notices = activeNotices(ui.log, performance.now(), {
    all: tabbed || viewed !== "log",
  });
  const noticesExpire = nextExpiry(notices);
  // Re-render when the oldest notice is due to go (nothing else may update the UI).
  useEffect(() => {
    if (noticesExpire === undefined) return undefined;
    const timer = setTimeout(
      () => setNoticeTick((n) => n + 1),
      Math.max(0, noticesExpire - performance.now()) + NOTICE_SLACK_MS,
    );
    return () => clearTimeout(timer);
  }, [noticesExpire]);
  // A tutorial step that highlights a panel section brings its tab (or window) to the front.
  const highlight = ui.tutorial?.highlight;
  useEffect(() => {
    const tabFor = tabForHighlight(highlight);
    if (tabFor) setTab(tabFor);
    const w = windowForHighlight(highlight);
    if (w) win.update((s) => openWindow(s, w));
    // The chat window may show its log tab: a step about the chat shows the chat.
    if (highlight === "chat") setChatTab("chat");
  }, [highlight]);

  // The level-up notice stays on screen for a few seconds.
  const levelUpAt = ui.levelUp?.at;
  useEffect(() => {
    if (!ui.levelUp) return undefined;
    setLevelNotice(ui.levelUp.level);
    const timer = setTimeout(() => setLevelNotice(undefined), LEVEL_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [levelUpAt]);

  // Sailing (T3.5): the map fades out and in while "You set sail for…" shows.
  const voyageAt = ui.voyage?.at;
  useEffect(() => {
    if (!ui.voyage) return undefined;
    setVoyage(ui.voyage.island);
    const timer = setTimeout(() => setVoyage(undefined), VOYAGE_MS);
    return () => clearTimeout(timer);
  }, [voyageAt]);

  // Window keys (I, K, P, G, O, H, B, M and Escape). Handled after the Game's own listener
  // (a timeout): Escape that closed a menu, a dialog or an aim, or a key the Game used,
  // arrives here prevented and does nothing more. On tabs, a window key shows its tab.
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const gameRef = useRef(game);
  gameRef.current = game;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || typingInField(e)) return;
      setTimeout(() => {
        if (e.defaultPrevented) return;
        if (!windowed) {
          const id = WINDOW_KEYS[e.code];
          if (id && !e.ctrlKey && !e.altKey && !e.metaKey && isPanelTab(id)) setTab(id);
          return;
        }
        if (e.code === "KeyM" && !e.ctrlKey && !e.altKey && !e.metaKey) {
          if (uiRef.current.market) gameRef.current?.marketClose();
          return;
        }
        win.key(e);
      }, 0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [windowed]);

  const pane = (
    name: PanelTab,
    first: boolean,
  ): JSX.HTMLAttributes<HTMLDivElement> & { "data-pane": PanelTab } => ({
    class: "pane",
    "data-pane": name,
    role: "tabpanel",
    ...(first
      ? { id: `pane-${name}`, "aria-labelledby": `tab-${name}` }
      : { "aria-label": t(TAB_TITLE[name]) }),
    hidden: tab !== name,
  });
  const stats = ui.stats;
  const experience = stats && (
    <span class="stat" data-testid="experience">
      {t("client.game.experience", { experience: stats.experience })}
    </span>
  );
  const logout = (
    <button type="button" onClick={() => game?.logout()}>
      {t("client.game.logout")}
    </button>
  );
  // The system log: a tab of the chat box on desktop, atop the chat tab on small screens.
  const log = (
    <ul class="log" data-testid="game-log" aria-live="polite">
      {ui.log.map((m, i) => (
        <li key={`${m.at}-${i}`}>{formatMessage(m, props.content, t)}</li>
      ))}
    </ul>
  );
  const battle = (
    <section
      class="battle"
      data-testid="battle-list"
      data-tutorial="battle"
      aria-label={t("client.battle.title")}
    >
      <h2>{t("client.battle.title")}</h2>
      {ui.battle.length === 0 ? (
        <p class="empty">{t("client.battle.empty")}</p>
      ) : (
        <ul>
          {ui.battle.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                class={ui.target === c.id ? "target" : ""}
                data-creature={c.id}
                aria-pressed={ui.target === c.id}
                title={t("client.battle.attack_hint")}
                onClick={() => game?.attack(c.id)}
              >
                <span class="cname">
                  {skullId(c.skull) && (
                    <MarkIcon
                      id={skullId(c.skull) ?? ""}
                      style={markIconStyle(game?.markIcon(c.skull))}
                      t={t}
                    />
                  )}
                  {creatureName(c, t)}
                </span>
                <span class="hp" aria-label={t("client.battle.health", { health: c.health })}>
                  <span style={{ transform: `scaleX(${c.health / 100})` }} />
                </span>
              </button>
              {c.kind === CreatureKind.PLAYER && canInvite(ui, c.id) && (
                <button
                  type="button"
                  class="invite"
                  data-invite={c.id}
                  title={t("client.battle.invite")}
                  aria-label={t("client.battle.invite")}
                  onClick={() => game?.partyInvite(c.id)}
                >
                  +
                </button>
              )}
              {c.kind === CreatureKind.PLAYER && !ui.trade && (
                <button
                  type="button"
                  class="trade-with"
                  data-trade={c.id}
                  title={t("client.battle.trade")}
                  aria-label={t("client.battle.trade")}
                  onClick={() => game?.tradeRequest(c.id)}
                >
                  ⇄
                </button>
              )}
              {c.kind === CreatureKind.PLAYER && (
                <button
                  type="button"
                  class="report"
                  data-report={c.id}
                  title={t("client.battle.report")}
                  aria-label={t("client.battle.report")}
                  onClick={() => setReporting({ id: c.id, name: creatureName(c, t) })}
                >
                  !
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {reporting && (
        <ReportForm
          key={reporting.id}
          t={t}
          target={reporting}
          onSend={(reason) => {
            game?.reportPlayer(reporting.id, reason);
            setReporting(undefined);
          }}
          onCancel={() => setReporting(undefined)}
        />
      )}
    </section>
  );
  const fight = (
    <section class="fight" aria-label={t("client.fight.title")}>
      <label class="stance">
        <span>{t("client.fight.stance")}</span>
        <select
          value={stance}
          onChange={(e) => {
            const s = Number(e.currentTarget.value) as FightStance;
            setStance(s);
            game?.setFightMode(s, chase);
          }}
        >
          <option value={FightStance.OFFENSIVE}>{t("client.fight.offensive")}</option>
          <option value={FightStance.BALANCED}>{t("client.fight.balanced")}</option>
          <option value={FightStance.DEFENSIVE}>{t("client.fight.defensive")}</option>
        </select>
      </label>
      <label class="check" title={t("client.fight.chase")}>
        {/* The narrow battle window shows "Chase": the box keeps its whole name. */}
        <input
          type="checkbox"
          aria-label={t("client.fight.chase")}
          checked={chase}
          onChange={(e) => {
            const c = e.currentTarget.checked;
            setChase(c);
            game?.setFightMode(stance, c);
          }}
        />
        {t(windowed ? "client.fight.chase_short" : "client.fight.chase")}
      </label>
      <label class="check" title={t("client.pvp.safe_mode_hint")}>
        <input
          type="checkbox"
          data-testid="safe-mode"
          checked={ui.safeMode}
          onChange={(e) => game?.setSafeMode(e.currentTarget.checked)}
        />
        {t("client.pvp.safe_mode")}
      </label>
    </section>
  );
  const party = <PartyPanel t={t} game={game} ui={ui} />;
  const inventory = (
    <InventoryPanel t={t} content={props.content} game={game} ui={ui} containers={!windowed} />
  );
  const skills = <SkillsPanel t={t} skills={ui.skills} />;
  const appearance = <AppearancePanel t={t} content={props.content} game={game} ui={ui} />;
  const quests = (
    <QuestsPanel t={t} log={ui.quests} clockOffset={ui.clockOffset} content={props.content} />
  );
  const chat = (
    <ChatPanel
      t={t}
      content={props.content}
      game={game}
      ui={ui}
      tab={windowed && chatTab !== "log" ? chatTab : undefined}
    />
  );
  const guild = (tabs: boolean): JSX.Element => (
    <GuildPanel
      t={t}
      content={props.content}
      game={game}
      ui={ui}
      now={performance.now()}
      {...(tabs ? { tab: guildTab, onTab: setGuildTab } : {})}
    />
  );
  const low = lowHealth(stats);

  // Over the map, in both shapes: load status, notices, the server's windows, the hotbar.
  const overMap = (
    <>
      {!props.entered && (
        <LoadStatus t={t} failed={props.loadFailed} retry={() => props.onRetry()} />
      )}
      {voyage !== undefined && (
        <div class="voyage" role="status" data-testid="voyage">
          <span>{t("client.voyage.sailed", { island: t(`island.${voyage}.name`) })}</span>
        </div>
      )}
      {levelNotice !== undefined && (
        <div class="level-up" role="status" data-testid="level-up">
          <strong>{t("client.level_up.title")}</strong>
          <span>{t("client.characters.level", { level: levelNotice })}</span>
        </div>
      )}
      {/* Server notices over the map (T5.6): the newest messages, also in the log. They
          never take a click (pointer-events: none in client.css). */}
      <div
        class={
          ui.invitations.length > 0 || ui.guildInvitations.length > 0 ? "notices raised" : "notices"
        }
        data-testid="notices"
        aria-label={t("client.notices.title")}
        aria-live={tabbed ? "polite" : "off"}
      >
        {notices.map((m) => (
          <p key={`${m.at}-${m.key}`} class="notice-line" data-key={m.key}>
            {formatMessage(m, props.content, t)}
          </p>
        ))}
      </div>
      {death && (
        <div
          class="death"
          role="alertdialog"
          aria-labelledby="death-title"
          data-testid="death-screen"
        >
          <h2 id="death-title">{t("client.death.title")}</h2>
          <p>{t("client.death.experience", { experience: death.experience })}</p>
          <p>
            {death.blessings > 0
              ? t("client.death.blessings", { blessings: death.blessings })
              : t("client.death.no_blessings")}
          </p>
          <p>{t("client.death.temple")}</p>
          <button type="button" onClick={() => setDeathSeen(death.at)}>
            {t("client.death.ok")}
          </button>
        </div>
      )}
      {/* The hotbar: in the bottom bar on the desktop (below), over the map elsewhere. */}
      {props.entered && !windowed && (
        <Hotbar
          t={t}
          content={props.content}
          game={game}
          ui={ui}
          reserve={props.touchPad ? PAD_RESERVE_PX : 0}
          stacked={stackedHotbar}
        />
      )}
      {/* T5.6 touch controls, over the map and under the windows: the direction pad
          (Options), the banner of an item picked by a tap and the long-press menu. */}
      {props.entered && props.touchPad && (
        <div class="touch-pad-dock">
          <TouchPad t={t} game={game} />
        </div>
      )}
      {/* The map's zoom (pinch does the same): bottom right of the map, or in the strip
          under it in portrait with the pad (touch.css), where the banner of a picked
          item takes its place while it shows. */}
      {props.entered && touch && !(stackedHotbar && ui.picked) && (
        <ZoomButtons t={t} game={game} zoom={ui.zoom} />
      )}
      {props.entered && ui.picked && (
        <PickBanner t={t} content={props.content} picked={ui.picked} game={game} />
      )}
      {/* The server's windows: on the desktop they are GameWindows of their own (below);
          on tablets and phones, sheets over the map. */}
      {props.entered && !windowed && (
        <DialogWindow t={t} content={props.content} game={game} ui={ui} compact={tabbed} />
      )}
      {props.entered && !windowed && !ui.dialog && (
        <CraftingWindow t={t} content={props.content} game={game} ui={ui} />
      )}
      {props.entered && !windowed && !ui.dialog && (
        <MarketWindow t={t} content={props.content} game={game} ui={ui} />
      )}
      {props.entered && !windowed && !ui.dialog && !ui.market && (
        <HouseWindow t={t} game={game} ui={ui} />
      )}
      {props.entered && !windowed && (
        <TradeWindow t={t} content={props.content} game={game} ui={ui} />
      )}
      {props.entered && !windowed && ui.book && (
        <BookWindow key={ui.book.at} t={t} content={props.content} game={game} ui={ui} />
      )}
      {props.entered && <PartyInvitations t={t} game={game} ui={ui} />}
      {props.entered && <GuildInvitations t={t} game={game} ui={ui} />}
      {props.entered && <PresenceCheck t={t} game={game} ui={ui} />}
      {props.entered && (
        <TutorialPanel t={t} game={game} ui={ui} covered={windowed && tutorialCovered(win.state)} />
      )}
    </>
  );
  const menu = props.entered && (
    <>
      {ui.menu && (
        <ActionMenu
          t={t}
          menu={ui.menu}
          game={game}
          viewport={{ width: window.innerWidth, height: window.innerHeight }}
          insets={gameBox.current ? paddingInsets(getComputedStyle(gameBox.current)) : undefined}
        />
      )}
      {ui.split && (
        <SplitPrompt
          key={`${ui.split.x},${ui.split.y}`}
          t={t}
          content={props.content}
          split={ui.split}
          game={game}
        />
      )}
      <ItemTooltip
        t={t}
        content={props.content}
        game={game}
        ui={ui}
        blocked={ui.menu !== undefined || ui.picked !== undefined || ui.split !== undefined}
        windows={
          windowed
            ? shownKey(win.state)
            : [ui.dialog, ui.shop, ui.station, ui.market, ui.house, ui.trade, ui.book]
                .map((w) => (w ? "1" : "0"))
                .join("")
        }
      />
    </>
  );

  // Both shapes keep the same .game-body and .viewport (keys): the Game's canvas lives in
  // the viewport, so switching between them (a window resized across a breakpoint) must
  // not replace that element.
  if (windowed) {
    const toolBody = (id: WindowId): JSX.Element => {
      switch (id) {
        case "battle":
          return (
            <>
              {fight}
              {battle}
            </>
          );
        case "inventory":
          return inventory;
        case "skills":
          return skills;
        case "quests":
          return quests;
        case "party":
          return party;
        case "guild":
          return guild(true);
        case "appearance":
          return appearance;
        case "options":
          return <OptionsBody t={t} settings={props.settings} onReset={() => win.reset()} />;
        case "help":
          return <HelpBody t={t} />;
        case "chat":
          return (
            <ChatPanes tab={chatTab} log={log}>
              {chat}
            </ChatPanes>
          );
      }
    };
    const common = { t, content: props.content, game, ui, framed: true } as const;
    /** What a window shows: its title, icon and body (undefined: nothing to show now). */
    const windowOf = (id: WinKey): ShownWindow | undefined => {
      if (id === "chat")
        return {
          title: t(WINDOW_TITLE.chat),
          icon: windowIcon("chat"),
          body: toolBody("chat"),
          // The tabs (the channels and the log) take the title's place in the bar (RO-like).
          barExtra: <ChatTabs t={t} tab={chatTab} onTab={setChatTab} unread={chatUnread} />,
          hideTitle: true,
        };
      if (isToolWindow(id))
        return {
          title: t(WINDOW_TITLE[id]),
          icon: windowIcon(id),
          body: toolBody(id),
          testid: id === "options" ? "options" : `window-${id}`,
          size: WINDOW_SIZE[id],
        };
      const d = ui.dialog;
      switch (id) {
        case "dialog":
          return d
            ? {
                title: d.npcContentId ? t(`npc.${d.npcContentId}.name`) : t("client.dialog.title"),
                icon: "talk",
                // A new node starts with an empty filter.
                body: <DialogBox key={`${d.id}:${d.text}`} {...common} dialog={d} />,
                testid: "dialog",
                closeLabel: t("client.dialog.close"),
              }
            : undefined;
        case "shop":
          return d && ui.shop
            ? {
                title: t("client.shop.title"),
                icon: "market",
                body: <ShopWindow key={ui.shop.dialogId} {...common} shop={ui.shop} />,
                testid: "shop",
                closable: false,
              }
            : undefined;
        case "crafting":
          return ui.station && !d
            ? {
                title: stationTitle(t, props.content, ui.station.itemId),
                icon: "craft",
                body: <CraftingWindow {...common} />,
                testid: "crafting",
                closeLabel: t("client.dialog.close"),
              }
            : undefined;
        case "market":
          return ui.market && !d
            ? {
                title: t("client.market.title"),
                icon: "market",
                body: <MarketWindow {...common} />,
                testid: "market",
                closeLabel: t("client.market.close"),
              }
            : undefined;
        case "house":
          return ui.house && !d && !ui.market
            ? {
                title: t(ui.house.name),
                icon: "house",
                body: <HouseWindow t={t} game={game} ui={ui} framed />,
                testid: "house",
                titleTestid: "house-name",
                closeLabel: t("client.house.close"),
              }
            : undefined;
        case "trade":
          return ui.trade
            ? {
                title: t("client.trade.title"),
                icon: "trade",
                body: <TradeWindow {...common} />,
                testid: "trade",
                closeLabel: t("client.trade.cancel"),
              }
            : undefined;
        case "book":
          // A new book (or the same one used again) starts at its first page.
          return ui.book
            ? {
                title: bookTitle(t, props.content, ui.book.itemId),
                icon: "book",
                body: <BookWindow key={ui.book.at} {...common} />,
                testid: "book",
                closeLabel: t("client.book.close"),
              }
            : undefined;
      }
      let cid: number | undefined;
      for (const [c, key] of ckeys) if (key === id) cid = c;
      const c = ui.containers.find((o) => o.id === cid);
      return c
        ? {
            title: itemName(props.content, t, c.itemId),
            icon: "inventory",
            // In .inventory: the slots and items look as under the equipment.
            body: (
              <div class="inventory container-window">
                <ContainerView {...common} container={c} />
              </div>
            ),
            size: "narrow",
            closeLabel: t("client.inventory.close"),
            // Unmoved, each container steps down from the last (windows.css).
            nth: [...ckeys.values()].indexOf(id),
          }
        : undefined;
    };
    const frame = (id: WinKey, stack: number): JSX.Element | null => {
      const w = windowOf(id);
      if (!w) return null; // the server closed it: the next sync closes the window too
      return (
        <GameWindow
          key={id}
          t={t}
          id={id}
          icon={w.icon}
          title={w.title}
          place={placeOf(win.state, id)}
          auto={win.auto.get(id)}
          stack={stack}
          zoom={zoom}
          closing={win.closing.has(id)}
          testid={w.testid ?? `window-${id}`}
          titleTestid={w.titleTestid}
          size={w.size}
          closable={w.closable ?? isClosable(id)}
          closeLabel={w.closeLabel}
          barExtra={w.barExtra}
          hideTitle={w.hideTitle}
          nth={w.nth}
          boxRef={id === "inventory" ? win.equipment.set : undefined}
          badge={id === "guild" && ui.guildInvitations.length > 0}
          onClose={() => win.close(id)}
          onCollapse={(c) => win.update((s) => collapseWindow(s, id, c))}
          onFocus={() => win.update((s) => focusWindow(s, id))}
          onGrab={(e, el) => win.grab(id, e, el)}
          onResize={(e, el) => win.resize(id, e, el)}
          onMoveKey={(e, el) => win.moveKey(id, e, el)}
        >
          {w.body}
        </GameWindow>
      );
    };
    // The stacking, bottom to top (a closing one stays drawn for its fade, on top), is
    // each window's z-index; in the page they keep one order (pageOrder).
    const stack = openWindows(win.state);
    for (const id of win.closing) if (!stack.includes(id)) stack.push(id);
    const shown = pageOrder(stack);
    return (
      <div
        ref={gameBox}
        class="game"
        data-testid="game"
        data-layout={layout.id}
        data-panel={layout.panel}
        data-flow={layout.flow}
        data-ui="windows"
        data-pad={props.touchPad ? "" : undefined}
        data-touch={touch ? "" : undefined}
        style={ornamentStyle()}
      >
        <div class="game-body" key="body" data-shop={ui.dialog && ui.shop ? "" : undefined}>
          <div class="viewport" key="viewport" ref={props.host} data-low={low ? "" : undefined}>
            {overMap}
          </div>
          <HudBar
            key="bar"
            t={t}
            name={props.characterName}
            stats={stats}
            levelUp={levelNotice !== undefined}
            curve={props.content.experience}
            tray={
              <StatusTray
                t={t}
                conditions={ui.conditions}
                partyBonus={partyBonus(ui.party)}
                game={game}
                compact={false}
              />
            }
            hotbar={
              props.entered && (
                <Hotbar t={t} content={props.content} game={game} ui={ui} margin={0} />
              )
            }
            toolbar={
              <Toolbar
                t={t}
                windows={win.state}
                onToggle={(id) => win.toggle(id)}
                marketOpen={ui.market !== undefined}
                onCloseMarket={() => game?.marketClose()}
                guildBadge={ui.guildInvitations.length > 0}
                onLogout={() => game?.logout()}
              />
            }
          />
          {/* The windows' area: the screen above the bar (windows never go under it). The
              containers' default column starts under the equipment (windows.css). */}
          <div
            class="win-layer"
            key="windows"
            ref={win.layer.set}
            style={{ "--containers-top": `${win.containersTop}px` }}
          >
            {shown.map((id) => frame(id, stack.indexOf(id)))}
          </div>
        </div>
        {menu}
      </div>
    );
  }

  const panelToggle = layout.panel === "drawer" && (
    <button
      type="button"
      class="panel-toggle"
      data-testid="panel-toggle"
      aria-expanded={drawerOpen}
      aria-controls="side-panel"
      onClick={() => setDrawerOpen(!drawerOpen)}
    >
      {t(drawerOpen ? "client.panel.close" : "client.panel.open")}
    </button>
  );
  return (
    <div
      ref={gameBox}
      class="game"
      data-testid="game"
      data-layout={layout.id}
      data-panel={layout.panel}
      data-flow={layout.flow}
      data-pad={props.touchPad ? "" : undefined}
      data-touch={touch ? "" : undefined}
    >
      <header key="hud" class={layout.compactHeader ? "hud compact" : "hud"} data-tutorial="stats">
        <span class="name" title={props.characterName}>
          {props.characterName}
        </span>
        {stats && (
          <span class="stat" data-testid="health">
            {t("client.game.health", { health: stats.health, max: stats.maxHealth })}
          </span>
        )}
        {stats && (
          <span class="stat" data-testid="mana">
            {t("client.game.mana", { mana: stats.mana, max: stats.maxMana })}
          </span>
        )}
        {stats && (
          <span class="stat level" data-testid="level">
            {t("client.game.level", { level: stats.level, percent: stats.levelPercent })}
          </span>
        )}
        {!layout.compactHeader && experience}
        <StatusTray
          t={t}
          conditions={ui.conditions}
          partyBonus={partyBonus(ui.party)}
          game={game}
          compact={true}
        />
        {layout.compactHeader ? (
          <>
            {panelToggle}
            {/* Phones: experience, the controls help, language, sound and logout fold into
                one menu so the header stays one line. */}
            <details class="hud-menu" data-testid="hud-menu">
              <summary aria-label={t("client.hud.menu")} title={t("client.hud.menu")}>
                ☰
              </summary>
              <div class="hud-menu-body">
                {experience}
                <p class="controls-text">{t("client.game.controls")}</p>
                {props.languagePicker}
                {logout}
              </div>
            </details>
          </>
        ) : (
          <>
            {/* Tablets on their side: the help folds into a button so the header stays
                one line and the map keeps its height. */}
            <details class="controls-help" data-testid="controls-help">
              <summary>{t("client.game.controls_button")}</summary>
              <p>{t("client.game.controls")}</p>
            </details>
            {panelToggle}
            {props.languagePicker}
            {logout}
          </>
        )}
      </header>
      <div class="game-body" key="body">
        <div class="viewport" key="viewport" ref={props.host} data-low={low ? "" : undefined}>
          {overMap}
        </div>
        <aside
          class="side"
          id="side-panel"
          data-open={layout.panel === "drawer" && drawerOpen ? "" : undefined}
          inert={layout.panel === "drawer" && !drawerOpen ? true : undefined}
        >
          <PanelTabs t={t} tab={tab} onTab={setTab} />
          <div class="side-scroll">
            <div {...pane("battle", true)}>{battle}</div>
            <div {...pane("party", true)}>{party}</div>
            <div {...pane("guild", true)}>{guild(false)}</div>
            {/* The fight mode goes with the battle list. */}
            <div {...pane("battle", false)}>{fight}</div>
            <div {...pane("inventory", true)}>{inventory}</div>
            <div {...pane("skills", true)}>{skills}</div>
            <div {...pane("quests", true)}>{quests}</div>
            <div {...pane("appearance", true)}>{appearance}</div>
          </div>
          <div {...pane("chat", true)}>
            {log}
            {chat}
          </div>
        </aside>
      </div>
      {menu}
    </div>
  );
}

/** What a window shows (GameView windowOf): its title bar and its body. */
interface ShownWindow {
  title: string;
  icon: IconName;
  body: JSX.Element;
  testid?: string | undefined;
  titleTestid?: string | undefined;
  size?: "narrow" | "normal" | "wide" | undefined;
  closable?: boolean | undefined;
  /** The close button's name when it is not "Close <title>" (what it did before). */
  closeLabel?: string | undefined;
  /** More in the title bar (the chat's tabs), and the title only for screen readers. */
  barExtra?: JSX.Element | undefined;
  hideTitle?: boolean | undefined;
  /** Its place among the windows of its kind (the n-th open container). */
  nth?: number | undefined;
}

/** Width of each window (windows.css .gwin[data-size]; the chat has its own). */
const WINDOW_SIZE: Record<Exclude<WindowId, "chat">, "narrow" | "normal" | "wide"> = {
  battle: "narrow",
  inventory: "narrow",
  skills: "narrow",
  quests: "normal",
  party: "narrow",
  guild: "wide",
  appearance: "normal",
  options: "normal",
  help: "wide",
};

const isPanelTab = (id: string): id is PanelTab => (PANEL_TABS as readonly string[]).includes(id);

/** How long a closing window fades out (matches .gwin[data-closing] in windows.css), ms. */
const CLOSE_MS = 100;

interface WindowsApi {
  state: WindowsState;
  /** Windows fading out: still drawn, already closed for the toolbar. */
  closing: ReadonlySet<WinKey>;
  update(f: (s: WindowsState) => WindowsState): void;
  toggle(id: WindowId): void;
  /** Closes a window: a toolbar window fades out, a server's asks the server. */
  close(id: WinKey): void;
  key(e: KeyboardEvent): void;
  reset(): void;
  /** The title bar: the window follows the pointer, with the magnet (snapPlace). */
  grab(id: WinKey, e: PointerEvent, el: HTMLElement): void;
  /** The resize grip: the window's corner follows the pointer. */
  resize(id: WinKey, e: PointerEvent, el: HTMLElement): void;
  /** A key on the move handle (ui/windows.ts windowNudge): true when it was the window's. */
  moveKey(id: WinKey, e: KeyboardEvent, el: HTMLElement): boolean;
  /**
   * The windows' area (.win-layer: the screen above the bar), watched while it is in the
   * page: only the desktop layout has one, and each switch back to it mounts a new one.
   */
  layer: WatchedRef<HTMLDivElement>;
  /** The equipment's window, measured for the containers' default place (containersTop). */
  equipment: WatchedRef<HTMLElement>;
  /** Where the containers' default column starts, the windows' own px (containersTop). */
  containersTop: number;
  /** Windows that sit elsewhere than their usual place (defaultPlace), screen px. */
  auto: ReadonlyMap<WinKey, AutoPlace>;
}

/** A box on screen in px from the top left of `area`. */
const rectIn = (r: DOMRect, area: DOMRect): Rect => ({
  x: r.left - area.left,
  y: r.top - area.top,
  width: r.width,
  height: r.height,
});

/** The scale of an element's computed transform (a window opening grows from 0.96). */
const scaleOnScreen = (el: Element): number => transformScale(getComputedStyle(el).transform);

/**
 * Brings back inside the area (`layer`) the windows the player placed that are (partly)
 * out of it now (outsiders of ui/window-dom.ts), their stacking unchanged.
 */
function pullInside(
  layer: HTMLElement,
  s: WindowsState,
  set: (f: (s: WindowsState) => WindowsState) => void,
): void {
  const windows = [...layer.children].filter((w): w is HTMLElement => w instanceof HTMLElement);
  const moves = outsiders(layer.getBoundingClientRect(), windows, s, scaleOnScreen);
  if (moves.length > 0)
    set((st) => moves.reduce((acc, [id, x, y]) => placeWindow(acc, id, x, y), st));
}

/** The boxes of the other windows in the area, for the magnet (not those fading out). */
function otherRects(layer: HTMLElement, el: HTMLElement, area: DOMRect): Rect[] {
  return [...layer.children]
    .filter(
      (w): w is HTMLElement =>
        w instanceof HTMLElement &&
        w !== el &&
        w.classList.contains("gwin") &&
        !w.hasAttribute("data-closing"),
    )
    .map((w) => rectIn(w.getBoundingClientRect(), area));
}

/**
 * The desktop windows: their state (ui/windows.ts) saved on every change, the close fade,
 * dragging a title bar (the window follows the pointer and the magnet snaps it to the
 * screen's edges, the bar's top and the other windows), the resize grip, the keys of the
 * move handle, and moving back inside the screen whatever a smaller window (or a larger
 * interface scale) left outside. Positions and sizes are screen px from the top left of the
 * windows' area; with the interface scale (`zoom`) a window's own lengths are those divided
 * by it.
 */
function useWindows(
  storage: Storage | undefined,
  serverClose: { current: (id: WinKey) => void },
  zoom: number,
  playerTile: { current: () => PageBox | undefined },
  dialogId: number | undefined,
): WindowsApi {
  const [state, setState] = useState<WindowsState>(() =>
    loadWindows(readStorage(storage, WINDOWS_STORAGE_KEY)),
  );
  const [closing, setClosing] = useState<ReadonlySet<WinKey>>(() => new Set());
  const timers = useRef(new Map<WinKey, ReturnType<typeof setTimeout>>());
  const stateRef = useRef(state);
  stateRef.current = state;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom > 0 ? zoom : 1;
  // docs/17 UI-5: a window that opens at its factory place sees the open windows
  // (defaultPlace): measured where windows.css puts it, before it is painted, it moves (or
  // shortens) when that place covers another window or, the trade, the tiles north of the
  // player. The place lasts while it stays open and unmoved, and while its usual place
  // stays where it was (placeContext: the dialog the shop comes beside, another NPC's
  // dialog, is looked at again); nothing of it is saved. When the area changes size they
  // all go back to their usual places and are looked at again (`resized`).
  const [auto, setAuto] = useState<ReadonlyMap<WinKey, AutoPlace>>(() => new Map());
  const [resized, setResized] = useState(0);
  // Never off the screen nor under the bar (docs/17 UI-5): when the area shrinks (a smaller
  // window, a larger interface scale) or a remembered place came from a larger screen, the
  // windows the player placed move back inside, all of them. Watched through the ref, not
  // an effect of the first render: the area comes and goes with the desktop layout.
  const [layer] = useState(() =>
    watchedRef<HTMLDivElement>((el) => {
      if (typeof ResizeObserver === "undefined") return () => {};
      let size = "";
      const observer = new ResizeObserver(() => {
        pullInside(el, stateRef.current, setState);
        const r = el.getBoundingClientRect();
        const now = `${Math.round(r.width)}x${Math.round(r.height)}`;
        if (size !== "" && now !== size) {
          setAuto(new Map());
          setResized((n) => n + 1);
        }
        size = now;
      });
      observer.observe(el);
      return () => observer.disconnect();
    }),
  );
  // The observer only sees the area change: a window closed meanwhile kept its place, so
  // each time one opens or unfolds (shownKey) the same check runs, before it is painted. A
  // window opened at x 1600 on a smaller screen, or unfolded against the bar, comes in.
  const shown = shownKey(state);
  useLayoutEffect(() => {
    const el = layer.current;
    if (el) pullInside(el, stateRef.current, setState);
  }, [shown, zoom, layer]);
  // The windows that opened since the last look (all of them after a resize) or whose
  // usual place moved while open (toLookAt), and may sit elsewhere; a window closed or
  // moved by the player forgets its place, one looked at again its old one.
  const context = placeContext(state, dialogId);
  const contextKey = JSON.stringify(context);
  const lastLook = useRef<LastLook>({ open: new Set(), context: {} });
  const lookedAt = useRef(0);
  useLayoutEffect(() => {
    const open = new Set(knownWindows(state).filter((id) => placeOf(state, id).open));
    const fresh = lookedAt.current !== resized;
    lookedAt.current = resized;
    const opened = toLookAt(state, lastLook.current, context, fresh);
    lastLook.current = { open, context };
    const next = new Map(
      [...auto].filter(
        ([id]) => open.has(id) && placeOf(state, id).x === undefined && !opened.has(id),
      ),
    );
    const el = layer.current;
    if (el && opened.size > 0) {
      const found = placeOpened(
        el.getBoundingClientRect(),
        [...el.children].filter((w): w is HTMLElement => w instanceof HTMLElement),
        opened,
        playerTile.current(),
        scaleOnScreen,
      );
      for (const [id, at] of found) next.set(id, at);
    }
    if (next.size !== auto.size || [...next].some(([id, at]) => auto.get(id) !== at)) setAuto(next);
  }, [state, resized, layer, contextKey]);
  // The equipment's height in its own px, for the containers' default place right under
  // it (containersTop, windows.css --containers-top): it changes with the backpack under
  // the figure, its fold and the text scale. Watched while its window is in the page.
  const [equipmentHeight, setEquipmentHeight] = useState<number | undefined>(undefined);
  const [equipment] = useState(() =>
    watchedRef<HTMLElement>((el) => {
      if (typeof ResizeObserver === "undefined") return () => {};
      const observer = new ResizeObserver(() =>
        setEquipmentHeight(
          el.getBoundingClientRect().height / (zoomRef.current * scaleOnScreen(el)),
        ),
      );
      observer.observe(el);
      return () => {
        observer.disconnect();
        setEquipmentHeight(undefined);
      };
    }),
  );
  const dragEnv: DragEnv = {
    pointer: window,
    body: document.body.classList,
    zoom: () => zoomRef.current,
  };
  useEffect(() => {
    try {
      storage?.setItem(WINDOWS_STORAGE_KEY, saveWindows(state));
    } catch {
      // Private mode or full storage: the windows stay as they are for this session.
    }
  }, [state]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  const update = (f: (s: WindowsState) => WindowsState): void => setState((s) => f(s));

  const stopClosing = (id: WinKey): void => {
    const timer = timers.current.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.current.delete(id);
    setClosing((c) => {
      const n = new Set(c);
      n.delete(id);
      return n;
    });
  };
  const close = (id: WinKey): void => {
    if (!isClosable(id)) return;
    // The server's windows close when the server says so (syncWindows).
    if (!isToolWindow(id)) {
      serverClose.current(id);
      return;
    }
    if (!stateRef.current.win[id].open || timers.current.has(id)) return;
    if (motionReduced(document.documentElement)) {
      update((s) => closeWindow(s, id));
      return;
    }
    setClosing((c) => new Set(c).add(id));
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setClosing((c) => {
          const n = new Set(c);
          n.delete(id);
          return n;
        });
        update((s) => closeWindow(s, id));
      }, CLOSE_MS),
    );
  };
  const toggle = (id: WindowId): void => {
    if (timers.current.has(id)) {
      stopClosing(id); // pressed again while fading: it stays
      return;
    }
    if (stateRef.current.win[id].open) close(id);
    else update((s) => toggleWindow(s, id));
  };
  const key = (e: KeyboardEvent): void => {
    const next = windowKey(stateRef.current, e);
    if (!next) return;
    // Closing goes through the fade (or the server); opening is immediate.
    const s = stateRef.current;
    const closed = knownWindows(s).find((id) => placeOf(s, id).open && !placeOf(next, id).open);
    if (closed) close(closed);
    else update(() => next);
  };
  const reset = (): void => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current.clear();
    setClosing(new Set());
    // Keep the options open (the reset button is in it) and the server's windows open.
    update((s) => resetWindows(s));
  };

  const grab = (id: WinKey, e: PointerEvent, el: HTMLElement): void => {
    const area = layer.current;
    if (e.button !== 0 || !area) return;
    e.preventDefault();
    const box = area.getBoundingClientRect();
    // The others are measured once: they do not move while this one does.
    dragWindow(
      dragEnv,
      el,
      e,
      box,
      otherRects(area, el, box),
      placeOf(stateRef.current, id),
      (x, y) => update((s) => moveWindow(s, id, x, y)),
    );
  };

  const resize = (id: WinKey, e: PointerEvent, el: HTMLElement): void => {
    const area = layer.current;
    if (e.button !== 0 || !area) return;
    e.preventDefault();
    e.stopPropagation();
    resizeDrag(
      dragEnv,
      el,
      e,
      area.getBoundingClientRect(),
      placeOf(stateRef.current, id),
      (x, y, w, h) => update((s) => resizeWindow(placeWindow(s, id, x, y), id, w, h)),
    );
  };

  const moveKey = (id: WinKey, e: KeyboardEvent, el: HTMLElement): boolean => {
    const area = layer.current;
    if (!area) return false;
    const box = area.getBoundingClientRect();
    const next = windowNudge(stateRef.current, id, e, {
      rect: rectIn(el.getBoundingClientRect(), box),
      area: { width: box.width, height: box.height },
      others: otherRects(area, el, box),
    });
    if (!next) return false;
    // A move raises the window: only its z-index changes (pageOrder), so the focus stays
    // on its handle.
    update(() => next);
    return true;
  };

  return {
    state,
    closing,
    update,
    toggle,
    close,
    key,
    reset,
    grab,
    resize,
    moveKey,
    layer,
    equipment,
    containersTop: containersTop(state.win.inventory, equipmentHeight),
    auto,
  };
}

function readStorage(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * The tabs of the chat window, in its title bar (docs/17 UI-10): All, Local, Party, Guild
 * and Global filter the chat lines (state/chat.ts), and the system log is the last one
 * (its notices float over the map meanwhile). A dot says a tab has something new.
 */
function ChatTabs(props: {
  t: Translate;
  tab: ChatTab;
  onTab(tab: ChatTab): void;
  unread: ReadonlySet<ChatTab>;
}): JSX.Element {
  const { t } = props;
  return (
    <div
      class="chat-tabs"
      role="tablist"
      aria-label={t("client.chat.tabs")}
      onWheel={(e) => {
        // Too wide for the bar (a large text size): the wheel moves them sideways.
        const to = wheelAlong(e.currentTarget, e);
        if (to === undefined) return;
        e.preventDefault();
        e.currentTarget.scrollLeft = to;
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        // The tab's arrows, not the character's.
        e.stopPropagation();
        const next = nextTab(props.tab, e.key === "ArrowRight" ? 1 : -1);
        props.onTab(next);
        document.getElementById(`chat-tab-${next}`)?.focus();
      }}
    >
      {CHAT_TABS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`chat-tab-${id}`}
          data-chat-tab={id}
          data-unread={props.unread.has(id) ? "" : undefined}
          aria-selected={props.tab === id}
          aria-controls={id === "log" ? "chat-pane-log" : "chat-pane-chat"}
          tabIndex={props.tab === id ? 0 : -1}
          onClick={() => props.onTab(id)}
        >
          {t(CHAT_TAB_LABEL[id])}
          {props.unread.has(id) && <span class="tab-dot" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

/** The two panes of the chat window: the chat (its tab filters it) and the system log. */
function ChatPanes(props: {
  tab: ChatTab;
  log: JSX.Element;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="chat-box">
      <div
        class="chat-pane"
        id="chat-pane-chat"
        role="tabpanel"
        aria-labelledby={`chat-tab-${props.tab === "log" ? "chat" : props.tab}`}
        hidden={props.tab === "log"}
      >
        {props.children}
      </div>
      <div
        class="chat-pane"
        id="chat-pane-log"
        role="tabpanel"
        aria-labelledby="chat-tab-log"
        hidden={props.tab !== "log"}
      >
        {props.log}
      </div>
    </div>
  );
}

/** The desktop Options window: sound, controls and the interface. */
function OptionsBody(props: {
  t: Translate;
  settings: GameSettings | undefined;
  onReset(): void;
}): JSX.Element {
  const { t, settings } = props;
  return (
    <div class="options-body">
      {settings && (
        <>
          <h3>{t("client.options.sound")}</h3>
          <div class="options-group">{settings.sound}</div>
          <h3>{t("client.options.controls")}</h3>
          <div class="options-group">
            {settings.controls}
            {settings.touchPad}
          </div>
          <h3>{t("client.options.interface")}</h3>
          <div class="options-group">
            {settings.language}
            <label class="check">
              <input
                type="checkbox"
                data-testid="reduced-motion"
                checked={settings.reducedMotion}
                onChange={(e) => settings.setReducedMotion(e.currentTarget.checked)}
              />
              {t("client.options.reduced_motion")}
            </label>
            {settings.interfaceOptions}
            <button type="button" data-testid="windows-reset" onClick={() => props.onReset()}>
              {t("client.options.reset_windows")}
            </button>
            <CreditsLink t={t} />
          </div>
        </>
      )}
    </div>
  );
}

/** The help window: how to play and the keys of the windows. */
function HelpBody(props: { t: Translate }): JSX.Element {
  const { t } = props;
  const keys: [string, string][] = [
    ["I", "client.inventory.title"],
    ["K", "client.skills.title"],
    ["L", "client.quests.title"],
    ["B", "client.battle.title"],
    ["P", "client.party.title"],
    ["G", "client.guild.title"],
    ["O", "client.appearance.title"],
    ["M", "client.market.title"],
    ["H", "client.help.title"],
  ];
  return (
    <div class="help-body" data-testid="controls-help">
      <p class="controls-text">{t("client.game.controls")}</p>
      <h3>{t("client.help.keys")}</h3>
      <dl class="keys">
        {keys.map(([k, title]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{t(title)}</dd>
          </div>
        ))}
        <div>
          <dt>
            <kbd>{t("client.toolbar.key_escape")}</kbd>
          </dt>
          <dd>{t("client.help.escape")}</dd>
        </div>
        <div>
          <dt>
            <kbd>F1–F12</kbd>
          </dt>
          <dd>{t("client.hotbar.title")}</dd>
        </div>
      </dl>
      {/* docs/17 UI-1: the windows from the keyboard (their ✥ handle). */}
      <p class="help-windows">{t("client.help.windows")}</p>
    </div>
  );
}

/**
 * The tab bar of the side panel on small screens (T5.6): an ARIA tablist; the arrow keys,
 * Home and End move between tabs.
 */
function PanelTabs(props: {
  t: Translate;
  tab: PanelTab;
  onTab(tab: PanelTab): void;
}): JSX.Element {
  const { t } = props;
  const move = (e: KeyboardEvent): void => {
    const i = PANEL_TABS.indexOf(props.tab);
    const n = PANEL_TABS.length;
    const to =
      e.key === "ArrowRight"
        ? (i + 1) % n
        : e.key === "ArrowLeft"
          ? (i - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    const next = PANEL_TABS[to] ?? props.tab;
    props.onTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  return (
    <div
      class="panel-tabs"
      role="tablist"
      aria-label={t("client.panel.tabs")}
      data-testid="panel-tabs"
      onKeyDown={move}
    >
      {PANEL_TABS.map((name) => (
        <button
          key={name}
          type="button"
          role="tab"
          id={`tab-${name}`}
          data-tab={name}
          aria-controls={`pane-${name}`}
          aria-selected={props.tab === name}
          tabIndex={props.tab === name ? 0 : -1}
          onClick={() => props.onTab(name)}
        >
          {t(TAB_TITLE[name])}
        </button>
      ))}
    </div>
  );
}

/** Extra wait after a notice's end before re-rendering, ms (timers may fire early). */
const NOTICE_SLACK_MS = 30;

/** True while a text field has the focus (a virtual keyboard may be up). */
function typingFocused(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLElement &&
    (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
  );
}

/**
 * The layout of the window (layout.ts), again on every resize or rotation. While a text
 * field has the focus and only the height changed, it keeps the layout: that is a phone's
 * virtual keyboard, and switching layouts would hide the field being typed in.
 */
function useLayout(): Layout {
  const [state, setState] = useState(() => ({
    width: window.innerWidth,
    layout: layoutFor(window.innerWidth, window.innerHeight),
  }));
  useEffect(() => {
    const update = (): void =>
      setState((s) => {
        const width = window.innerWidth;
        if (width === s.width && typingFocused()) return s;
        const next = layoutFor(width, window.innerHeight);
        const same =
          next.id === s.layout.id &&
          next.panel === s.layout.panel &&
          next.flow === s.layout.flow &&
          next.compactHeader === s.layout.compactHeader;
        if (same && width === s.width) return s;
        return { width, layout: same ? s.layout : next };
      });
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return state.layout;
}

/**
 * Keeps the chat line above a phone's virtual keyboard. Browsers that resize the page for
 * the keyboard (interactive-widget=resizes-content, Chrome on Android) need nothing more;
 * the others (Safari on iOS) only shrink the visual viewport, so while a text field has
 * the focus the game takes the visual viewport's height (--game-height in client.css).
 */
function useKeyboardViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const root = document.documentElement;
    const update = (): void => {
      if (typingFocused() && vv.height < window.innerHeight - KEYBOARD_MIN_PX) {
        root.style.setProperty("--game-height", `${Math.round(vv.height)}px`);
        // Safari scrolls the page up under the keyboard: keep the header in view.
        window.scrollTo(0, 0);
      } else {
        root.style.removeProperty("--game-height");
      }
    };
    vv.addEventListener("resize", update);
    window.addEventListener("focusout", update);
    return () => {
      vv.removeEventListener("resize", update);
      window.removeEventListener("focusout", update);
      root.style.removeProperty("--game-height");
    };
  }, []);
}

/** Smallest drop of the visual viewport that is a virtual keyboard, CSS px. */
const KEYBOARD_MIN_PX = 120;

/** Longest report reason (balance.yaml reports.max_reason; the server checks it). */
const REPORT_REASON_MAX = 200;

/**
 * The reason form of a report (T4.1). The client only sends the reason: the server
 * attaches the context (positions and recent events) and rate limits it.
 */
function ReportForm(props: {
  t: Translate;
  target: { id: number; name: string };
  onSend(reason: string): void;
  onCancel(): void;
}) {
  const { t } = props;
  const [reason, setReason] = useState("");
  // Preact ignores autoFocus: focus the field on open, so typing the reason does not
  // walk (keys in an input are not game keys) and Escape reaches the form.
  const input = useRef<HTMLInputElement>(null);
  // Every click on a "!" makes a new target object: the field takes the focus again.
  useEffect(() => {
    input.current?.focus();
  }, [props.target]);
  return (
    <form
      class="report-form"
      data-testid="report-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim() !== "") props.onSend(reason.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          props.onCancel();
        }
      }}
    >
      <label>
        {t("client.report.title", { name: props.target.name })}
        <input
          type="text"
          value={reason}
          ref={input}
          maxLength={REPORT_REASON_MAX}
          placeholder={t("client.report.reason")}
          onInput={(e) => setReason(e.currentTarget.value)}
        />
      </label>
      <p class="hint">{t("client.report.hint")}</p>
      <div class="buttons">
        <button type="submit" disabled={reason.trim() === ""}>
          {t("client.report.send")}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t("client.report.cancel")}
        </button>
      </div>
    </form>
  );
}

/** A player can be invited unless it is in our party or we follow another leader. */
function canInvite(ui: GameUi, id: number): boolean {
  const p = ui.party;
  return !p || (p.leaderId === ui.selfId && !p.members.some((m) => m.id === id));
}

/** How long the level-up notice stays on screen, ms. */
const LEVEL_NOTICE_MS = 4000;
/** How long the voyage fade lasts (matches the .voyage animation in client.css). */
const VOYAGE_MS = 2600;

/** Display order of the skills panel: combat first, then crafts; unknown ids go last. */
const SKILL_ORDER = [
  "fist",
  "club",
  "sword",
  "axe",
  "distance",
  "shield",
  "magic",
  "fishing",
  "mining",
  "woodcutting",
  "smithing",
  "cooking",
  "alchemy",
];

const skillRank = (id: string): number => {
  const i = SKILL_ORDER.indexOf(id);
  return i < 0 ? SKILL_ORDER.length : i;
};

/**
 * A PvP mark before a name in the battle list (T5.2): its sprite as a CSS background
 * (render/marks.ts markIconStyle), or without it a dot of the mark's colour (client.css).
 */
function MarkIcon(props: {
  id: string;
  style: Record<string, string> | undefined;
  t: Translate;
}): JSX.Element {
  const label = props.t(`client.skull.${props.id}`);
  return (
    <span
      class={`skull skull-${props.id}${props.style ? " art" : ""}`}
      data-skull={props.id}
      data-art={props.style ? "" : undefined}
      style={props.style}
      title={label}
      aria-label={label}
    />
  );
}

/** Skills panel: level and progress bar of every skill the server reports. */
function SkillsPanel(props: { t: Translate; skills: GameUi["skills"] }): JSX.Element {
  const { t } = props;
  const skills = [...props.skills].sort((a, b) => skillRank(a.id) - skillRank(b.id));
  return (
    <section
      class="skills"
      data-testid="skills-panel"
      data-tutorial="skills"
      aria-label={t("client.skills.title")}
    >
      <h2>{t("client.skills.title")}</h2>
      <ul>
        {skills.map((s) => (
          <li key={s.id} data-skill={s.id}>
            <span class="sname">{t(`skill.${s.id}.name`)}</span>
            <span class="slevel">{s.level}</span>
            <span
              class="sbar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={s.percent}
              title={t("client.skills.progress", { percent: s.percent })}
            >
              <span style={{ transform: `scaleX(${s.percent / 100})` }} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
