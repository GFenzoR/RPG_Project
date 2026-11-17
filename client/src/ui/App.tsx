// Screens of the client: login, sign up, characters (list and creation) and the game.
// DOM with Preact over the canvas (client/CLAUDE.md): accessible, translatable and easy to
// drive from Playwright. Every visible text goes through t().
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { CreatureKind, DisconnectReason, FightStance } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import { Game } from "../game.ts";
import type { GameUi } from "../game.ts";
import type { AudioEngine } from "../audio/engine.ts";
import { creatureName, formatMessage } from "../state/messages.ts";
import { skullId } from "../state/pvp.ts";
import { markIconStyle } from "../render/marks.ts";
import type { Translate } from "../i18n/i18n.ts";
import { ApiError, api } from "../net/api.ts";
import type { Character } from "../net/api.ts";
import { InventoryPanel } from "./Inventory.tsx";
import { Hotbar } from "./Hotbar.tsx";
import { ChatPanel } from "./Chat.tsx";
import { DialogWindow } from "./Dialog.tsx";
import { CraftingWindow } from "./Crafting.tsx";
import { TradeWindow } from "./Trade.tsx";
import { HouseWindow } from "./House.tsx";
import { MarketWindow } from "./Market.tsx";
import { PartyInvitations, PartyPanel } from "./Party.tsx";
import { GuildInvitations, GuildPanel } from "./Guild.tsx";
import { AppearancePanel } from "./Appearance.tsx";
import { PresenceCheck } from "./Presence.tsx";
import { TutorialPanel } from "./Tutorial.tsx";
import { ServerPicker } from "./ServerPicker.tsx";
import { ForgotPasswordLink, OAuthButtons, VerifyNotice } from "./Account.tsx";
import { PANEL_TABS, TAB_TITLE, layoutFor, tabForHighlight } from "./layout.ts";
import type { Layout, PanelTab } from "./layout.ts";
import { activeNotices, nextExpiry } from "./notices.ts";
import { ActionMenu, PickBanner, paddingInsets } from "./ActionMenu.tsx";
import { LoadStatus } from "./LoadStatus.tsx";
import { PAD_RESERVE_PX, TouchPad } from "./TouchPad.tsx";
import { ZoomButtons } from "./ZoomButtons.tsx";
import { coarsePointer } from "../state/touch-prefs.ts";

type Screen =
  | { name: "loading" }
  | { name: "login" }
  | { name: "register" }
  | { name: "characters" }
  | { name: "game"; character: Character; sessionToken: string };

export interface AppProps {
  content: ClientContent;
  t: Translate;
  locale: string;
  /** The language selector: fixed in a corner, or in the game's header. */
  languagePicker?: JSX.Element;
  /** Sound (T3.7); undefined = silent. */
  audio?: AudioEngine | undefined;
  /** T5.6: show the on-screen direction pad (switched in Options, state/touch-prefs.ts). */
  touchPad?: boolean | undefined;
}

/** Translated text of an API error code (error.<code>), or a generic message. */
function errorText(t: Translate, e: unknown): string {
  const code = e instanceof ApiError ? e.code : "unknown";
  const key = `error.${code}`;
  const text = t(key);
  return text === key ? t("error.unknown") : text;
}

/** Disconnect reason → i18n key suffix (client.disconnect.<suffix>). */
function disconnectKey(reason: DisconnectReason | undefined): string {
  const name = reason === undefined ? "UNSPECIFIED" : (DisconnectReason[reason] ?? "UNSPECIFIED");
  return `client.disconnect.${name.toLowerCase()}`;
}

export function App(props: AppProps): JSX.Element {
  return <Screens {...props} />;
}

function Screens({ content, t, locale, languagePicker, audio, touchPad }: AppProps): JSX.Element {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    // A still-valid session cookie skips the login.
    api.characters().then(
      () => setScreen({ name: "characters" }),
      () => setScreen({ name: "login" }),
    );
  }, []);

  const toCharacters = (): void => setScreen({ name: "characters" });
  const toLogin = (): void => setScreen({ name: "login" });

  const view = current();
  // Outside the game the selector sits in a corner; the game puts it in its header.
  if (screen.name === "game" || !languagePicker) return view;
  return (
    <>
      <div class="corner">{languagePicker}</div>
      {view}
    </>
  );

  function current(): JSX.Element {
    switch (screen.name) {
      case "loading":
        return <p class="panel">{t("client.loading")}</p>;
      case "login":
        // A notice survives the way back to the login: a ban revokes the session too.
        return (
          <AuthForm
            t={t}
            mode="login"
            lang={locale}
            notice={notice}
            onDone={() => {
              setNotice(undefined);
              toCharacters();
            }}
            onSwitch={() => setScreen({ name: "register" })}
          />
        );
      case "register":
        return (
          <AuthForm t={t} mode="register" lang={locale} onDone={toCharacters} onSwitch={toLogin} />
        );
      case "characters":
        return (
          <Characters
            t={t}
            content={content}
            lang={locale}
            notice={notice}
            onPlay={(character, sessionToken) => {
              setNotice(undefined);
              setScreen({ name: "game", character, sessionToken });
            }}
            onLoggedOut={toLogin}
          />
        );
      case "game":
        return (
          <GameScreen
            t={t}
            content={content}
            locale={locale}
            languagePicker={languagePicker}
            audio={audio}
            touchPad={touchPad ?? false}
            character={screen.character}
            sessionToken={screen.sessionToken}
            onEnd={(reason) => {
              setNotice(t(disconnectKey(reason)));
              toCharacters();
            }}
          />
        );
    }
  }
}

function AuthForm(props: {
  t: Translate;
  mode: "login" | "register";
  /** Language of the verification email sent on sign up. */
  lang: string;
  /** Why the player is back at the login (e.g. a ban ended the game), if anything. */
  notice?: string | undefined;
  onDone(): void;
  onSwitch(): void;
}): JSX.Element {
  const { t, mode } = props;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "register") await api.register(email, password, props.lang);
      await api.login(email, password);
      props.onDone();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  };

  return (
    <div class="panel">
      <form data-testid={`${mode}-form`} onSubmit={(e) => void submit(e)}>
        <h1>{t(mode === "login" ? "client.login.title" : "client.register.title")}</h1>
        {props.notice && (
          <p class="notice" role="status">
            {props.notice}
          </p>
        )}
        <label>
          {t("client.login.email")}
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </label>
        <label>
          {t("client.login.password")}
          <input
            type="password"
            name="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
          {mode === "register" && <small>{t("client.register.password_hint")}</small>}
        </label>
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {t(mode === "login" ? "client.login.submit" : "client.register.submit")}
        </button>
        <button type="button" class="link" onClick={props.onSwitch}>
          {t(mode === "login" ? "client.login.to_register" : "client.register.to_login")}
        </button>
        {mode === "login" && <ForgotPasswordLink t={t} />}
        <OAuthButtons t={t} returnTo="/play/" />
      </form>
      {/* Outside the login form: its own form, so Enter saves the server and an invalid
          address there never blocks logging in. */}
      <ServerPicker t={t} />
    </div>
  );
}

function Characters(props: {
  t: Translate;
  content: ClientContent;
  lang: string;
  notice: string | undefined;
  onPlay(character: Character, sessionToken: string): void;
  onLoggedOut(): void;
}): JSX.Element {
  const { t, content } = props;
  const [list, setList] = useState<Character[] | undefined>(undefined);
  const [name, setName] = useState("");
  const [vocation, setVocation] = useState(content.vocations[0] ?? "");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const fail = (err: unknown): void => {
    if (err instanceof ApiError && err.code === "unauthorized") return props.onLoggedOut();
    setError(errorText(t, err));
    setBusy(false);
  };

  useEffect(() => {
    api.characters().then(setList, fail);
  }, []);

  const play = async (c: Character): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const { session_token } = await api.play(c.id);
      props.onPlay(c, session_token);
    } catch (err) {
      fail(err);
    }
  };

  const createCharacter = async (e: Event): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const c = await api.createCharacter(name.trim(), vocation);
      setList((l) => [...(l ?? []), c]);
      setName("");
    } catch (err) {
      fail(err);
    }
    setBusy(false);
  };

  const logout = async (): Promise<void> => {
    try {
      await api.logout();
    } catch {
      // the cookie is gone or the server is down: either way, back to the login
    }
    props.onLoggedOut();
  };

  return (
    <div class="panel wide" data-testid="characters">
      <h1>{t("client.characters.title")}</h1>
      <VerifyNotice t={t} lang={props.lang} />
      {props.notice && (
        <p class="notice" role="status">
          {props.notice}
        </p>
      )}
      {list === undefined ? (
        <p>{t("client.loading")}</p>
      ) : list.length === 0 ? (
        <p>{t("client.characters.empty")}</p>
      ) : (
        <ul class="characters">
          {list.map((c) => (
            <li key={c.id}>
              <span class="name">{c.name}</span>
              <span class="meta">
                {t(`vocation.${c.vocation}.name`)} ·{" "}
                {t("client.characters.level", { level: c.level })}
              </span>
              <button type="button" disabled={busy} onClick={() => void play(c)}>
                {t("client.characters.play")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form data-testid="create-character" onSubmit={(e) => void createCharacter(e)}>
        <h2>{t("client.characters.create_title")}</h2>
        <label>
          {t("client.characters.name")}
          <input
            name="name"
            required
            minLength={3}
            maxLength={20}
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <small>{t("client.characters.name_hint")}</small>
        </label>
        <label>
          {t("client.characters.vocation")}
          <select
            name="vocation"
            value={vocation}
            onChange={(e) => setVocation(e.currentTarget.value)}
          >
            {content.vocations.map((v) => (
              <option key={v} value={v}>
                {t(`vocation.${v}.name`)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          {t("client.characters.create")}
        </button>
      </form>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <button type="button" class="link" onClick={() => void logout()}>
        {t("client.characters.logout")}
      </button>
    </div>
  );
}

function GameScreen(props: {
  t: Translate;
  content: ClientContent;
  locale: string;
  languagePicker: JSX.Element | undefined;
  audio: AudioEngine | undefined;
  touchPad: boolean;
  character: Character;
  sessionToken: string;
  onEnd(reason: DisconnectReason | undefined): void;
}): JSX.Element {
  const { t } = props;
  const host = useRef<HTMLDivElement>(null);
  // .game: its padding is the safe area (client.css), which the long-press menu, fixed to
  // the screen, takes once too.
  const gameBox = useRef<HTMLDivElement>(null);
  const game = useRef<Game | undefined>(undefined);
  // The Game lives as long as the session; a language change reaches it through here.
  const tRef = useRef(t);
  tRef.current = t;
  const [entered, setEntered] = useState(false);
  // The atlas did not load after its retries: the error and its "Retry" button show.
  const [loadFailed, setLoadFailed] = useState(false);
  const [ui, setUi] = useState<GameUi>({
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
    containers: [],
    hotkeys: [],
    dialog: undefined,
    shop: undefined,
    station: undefined,
    trade: undefined,
    market: undefined,
    house: undefined,
    presence: undefined,
    tutorial: undefined,
    party: undefined,
    invitations: [],
    guild: undefined,
    guildInvitations: [],
    selfName: "",
    selfId: 0,
  });
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
  // drawer over the map) and the important server messages float over the map.
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
  // With the log out of view (tabs, drawer) every message floats, not only the important.
  const notices = activeNotices(ui.log, performance.now(), { all: tabbed });
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
  // A tutorial step that highlights a panel section brings its tab to the front.
  const highlightTab = tabForHighlight(ui.tutorial?.highlight);
  useEffect(() => {
    if (highlightTab) setTab(highlightTab);
  }, [highlightTab]);

  useEffect(() => {
    if (!host.current) return undefined;
    const g = new Game({
      host: host.current,
      content: props.content,
      t: (key, params) => tRef.current(key, params),
      locale: props.locale,
      sessionToken: props.sessionToken,
      vocation: props.character.vocation,
      storage: safeStorage(),
      audio: props.audio,
      entered: () => setEntered(true),
      loadFailed: () => setLoadFailed(true),
      ended: (reason) => props.onEnd(reason),
      update: setUi,
    });
    game.current = g;
    return () => g.destroy();
    // One Game per session token.
  }, [props.sessionToken]);

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

  const pane = (
    name: PanelTab,
    first: boolean,
  ): JSX.HTMLAttributes<HTMLDivElement> & { "data-pane": PanelTab } =>
    tabbed
      ? {
          class: "pane",
          "data-pane": name,
          role: "tabpanel",
          ...(first
            ? { id: `pane-${name}`, "aria-labelledby": `tab-${name}` }
            : { "aria-label": t(TAB_TITLE[name]) }),
          hidden: tab !== name,
        }
      : { class: "pane", "data-pane": name };
  const stats = ui.stats;
  const experience = stats && (
    <span class="stat" data-testid="experience">
      {t("client.game.experience", { experience: stats.experience })}
    </span>
  );
  const logout = (
    <button type="button" onClick={() => game.current?.logout()}>
      {t("client.game.logout")}
    </button>
  );
  // The system log: at the end of the scrolling column on desktop, atop the chat tab.
  const log = (
    <ul class="log" data-testid="game-log" aria-live="polite">
      {ui.log.map((m, i) => (
        <li key={`${m.at}-${i}`}>{formatMessage(m, props.content, t)}</li>
      ))}
    </ul>
  );
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
      <header class={layout.compactHeader ? "hud compact" : "hud"} data-tutorial="stats">
        <span class="name" title={props.character.name}>
          {props.character.name}
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
        <ConditionBar t={t} conditions={ui.conditions} />
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
            {/* Wide windows: the help is one line cut with an ellipsis that opens the whole
                text, so a long name and experience never wrap the header (that pushed the
                map down a zoom step at 1280x800). */}
            <details class="hint" data-testid="controls-hint">
              <summary>{t("client.game.controls")}</summary>
              <p>{t("client.game.controls")}</p>
            </details>
            {/* Narrow windows (the desktop app's 960 px): the help folds into a button so the
                header stays one line and the map keeps its height. CSS picks one of the two. */}
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
      <div class="game-body">
        <div class="viewport" ref={host}>
          {!entered && (
            <LoadStatus
              t={t}
              failed={loadFailed}
              retry={() => {
                setLoadFailed(false);
                game.current?.retryCanvas();
              }}
            />
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
          {/* Server notices over the map (T5.6): the newest important messages, also in
              the log. They never take a click (pointer-events: none in client.css). On
              desktop the log next to the map already announces them. */}
          <div
            class={
              ui.invitations.length > 0 || ui.guildInvitations.length > 0
                ? "notices raised"
                : "notices"
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
          {entered && (
            <Hotbar
              t={t}
              content={props.content}
              game={game.current}
              ui={ui}
              reserve={props.touchPad ? PAD_RESERVE_PX : 0}
              stacked={stackedHotbar}
            />
          )}
          {/* T5.6 touch controls, over the map and under the windows: the direction pad
              (Options), the banner of an item picked by a tap and the long-press menu. */}
          {entered && props.touchPad && (
            <div class="touch-pad-dock">
              <TouchPad t={t} game={game.current} />
            </div>
          )}
          {/* The map's zoom (pinch does the same): bottom right of the map, or in the strip
              under it in portrait with the pad (touch.css), where the banner of a picked
              item takes its place while it shows. */}
          {entered && touch && !(stackedHotbar && ui.picked) && (
            <ZoomButtons t={t} game={game.current} zoom={ui.zoom} />
          )}
          {entered && ui.picked && (
            <PickBanner t={t} content={props.content} picked={ui.picked} game={game.current} />
          )}
          {entered && <DialogWindow t={t} content={props.content} game={game.current} ui={ui} />}
          {entered && !ui.dialog && (
            <CraftingWindow t={t} content={props.content} game={game.current} ui={ui} />
          )}
          {entered && !ui.dialog && (
            <MarketWindow t={t} content={props.content} game={game.current} ui={ui} />
          )}
          {entered && !ui.dialog && !ui.market && <HouseWindow t={t} game={game.current} ui={ui} />}
          {entered && <TradeWindow t={t} content={props.content} game={game.current} ui={ui} />}
          {entered && <PartyInvitations t={t} game={game.current} ui={ui} />}
          {entered && <GuildInvitations t={t} game={game.current} ui={ui} />}
          {entered && <PresenceCheck t={t} game={game.current} ui={ui} />}
          {entered && <TutorialPanel t={t} game={game.current} ui={ui} />}
        </div>
        <aside
          class="side"
          id="side-panel"
          data-open={layout.panel === "drawer" && drawerOpen ? "" : undefined}
          inert={layout.panel === "drawer" && !drawerOpen ? true : undefined}
        >
          {tabbed && <PanelTabs t={t} tab={tab} onTab={setTab} />}
          {/* Desktop: every section but the chat scrolls in this column and the chat keeps
              its own place under it, so it never covers the inventory or the appearance
              panel (1280x800). With tabs the wrapper is display: contents. */}
          <div class="side-scroll">
            <div {...pane("battle", true)}>
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
                          onClick={() => game.current?.attack(c.id)}
                        >
                          <span class="cname">
                            {skullId(c.skull) && (
                              <MarkIcon
                                id={skullId(c.skull) ?? ""}
                                style={markIconStyle(game.current?.markIcon(c.skull))}
                                t={t}
                              />
                            )}
                            {creatureName(c, t)}
                          </span>
                          <span
                            class="hp"
                            aria-label={t("client.battle.health", { health: c.health })}
                          >
                            <span style={{ width: `${c.health}%` }} />
                          </span>
                        </button>
                        {c.kind === CreatureKind.PLAYER && canInvite(ui, c.id) && (
                          <button
                            type="button"
                            class="invite"
                            data-invite={c.id}
                            title={t("client.battle.invite")}
                            aria-label={t("client.battle.invite")}
                            onClick={() => game.current?.partyInvite(c.id)}
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
                            onClick={() => game.current?.tradeRequest(c.id)}
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
                      game.current?.reportPlayer(reporting.id, reason);
                      setReporting(undefined);
                    }}
                    onCancel={() => setReporting(undefined)}
                  />
                )}
              </section>
            </div>
            <div {...pane("party", true)}>
              <PartyPanel t={t} game={game.current} ui={ui} />
            </div>
            <div {...pane("guild", true)}>
              <GuildPanel
                t={t}
                content={props.content}
                game={game.current}
                ui={ui}
                now={performance.now()}
              />
            </div>
            {/* The fight mode sits after the guild on desktop, as before; in tabs it goes
              with the battle list. */}
            <div {...pane("battle", false)}>
              <section class="fight">
                <label>
                  {t("client.fight.stance")}
                  <select
                    value={stance}
                    onChange={(e) => {
                      const s = Number(e.currentTarget.value) as FightStance;
                      setStance(s);
                      game.current?.setFightMode(s, chase);
                    }}
                  >
                    <option value={FightStance.OFFENSIVE}>{t("client.fight.offensive")}</option>
                    <option value={FightStance.BALANCED}>{t("client.fight.balanced")}</option>
                    <option value={FightStance.DEFENSIVE}>{t("client.fight.defensive")}</option>
                  </select>
                </label>
                <label class="check">
                  <input
                    type="checkbox"
                    checked={chase}
                    onChange={(e) => {
                      const c = e.currentTarget.checked;
                      setChase(c);
                      game.current?.setFightMode(stance, c);
                    }}
                  />
                  {t("client.fight.chase")}
                </label>
                <label class="check" title={t("client.pvp.safe_mode_hint")}>
                  <input
                    type="checkbox"
                    data-testid="safe-mode"
                    checked={ui.safeMode}
                    onChange={(e) => game.current?.setSafeMode(e.currentTarget.checked)}
                  />
                  {t("client.pvp.safe_mode")}
                </label>
              </section>
            </div>
            <div {...pane("inventory", true)}>
              <InventoryPanel t={t} content={props.content} game={game.current} ui={ui} />
            </div>
            <div {...pane("skills", true)}>
              <SkillsPanel t={t} skills={ui.skills} />
            </div>
            <div {...pane("appearance", true)}>
              <AppearancePanel t={t} content={props.content} game={game.current} ui={ui} />
            </div>
            {!tabbed && log}
          </div>
          <div {...pane("chat", true)}>
            {tabbed && log}
            <ChatPanel t={t} content={props.content} game={game.current} ui={ui} />
          </div>
        </aside>
      </div>
      {entered && ui.menu && (
        <ActionMenu
          t={t}
          menu={ui.menu}
          game={game.current}
          viewport={{ width: window.innerWidth, height: window.innerHeight }}
          insets={gameBox.current ? paddingInsets(getComputedStyle(gameBox.current)) : undefined}
        />
      )}
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
        if (e.key === "Escape") props.onCancel();
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

/** localStorage, or undefined where the browser blocks it. */
function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
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

/** Skills panel: level and progress bar of every skill the server reports. */
/** Kind of each condition, for its badge colour (balance.yaml conditions, T3.2). */
const CONDITION_CLASS: Record<string, string> = {
  poison: "damage",
  burning: "damage",
  shocked: "damage",
  slowed: "debuff",
  hasted: "buff",
  invisible: "buff",
  keen_eye: "buff",
  well_fed: "buff",
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

/** The player's own conditions as named badges; the tooltip has the time left. */
function ConditionBar(props: { t: Translate; conditions: GameUi["conditions"] }): JSX.Element {
  const { t } = props;
  const now = performance.now();
  return (
    <span class="conditions" data-testid="conditions" aria-label={t("client.conditions.title")}>
      {props.conditions.map((c) => (
        <span
          key={c.id}
          class={`condition condition-${CONDITION_CLASS[c.id] ?? "buff"}`}
          data-condition={c.id}
          title={t("client.conditions.left", {
            seconds: Math.max(0, Math.ceil((c.until - now) / 1000)),
          })}
        >
          {t(`condition.${c.id}.name`)}
        </span>
      ))}
    </span>
  );
}

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
              <span style={{ width: `${s.percent}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
