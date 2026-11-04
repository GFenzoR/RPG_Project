// Screens of the client: login, sign up, characters (list and creation) and the game.
// DOM with Preact over the canvas (client/CLAUDE.md): accessible, translatable and easy to
// drive from Playwright. Every visible text goes through t().
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { CreatureKind, DisconnectReason, FightStance } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import { Game } from "../game.ts";
import type { GameUi } from "../game.ts";
import { creatureName, formatMessage } from "../state/messages.ts";
import type { Translate } from "../i18n/i18n.ts";
import { ApiError, api } from "../net/api.ts";
import type { Character } from "../net/api.ts";
import { InventoryPanel } from "./Inventory.tsx";
import { Hotbar } from "./Hotbar.tsx";
import { ChatPanel } from "./Chat.tsx";
import { DialogWindow } from "./Dialog.tsx";

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

function Screens({ content, t, locale, languagePicker }: AppProps): JSX.Element {
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
            notice={notice}
            onDone={() => {
              setNotice(undefined);
              toCharacters();
            }}
            onSwitch={() => setScreen({ name: "register" })}
          />
        );
      case "register":
        return <AuthForm t={t} mode="register" onDone={toCharacters} onSwitch={toLogin} />;
      case "characters":
        return (
          <Characters
            t={t}
            content={content}
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
      if (mode === "register") await api.register(email, password);
      await api.login(email, password);
      props.onDone();
    } catch (err) {
      setError(errorText(t, err));
      setBusy(false);
    }
  };

  return (
    <form class="panel" data-testid={`${mode}-form`} onSubmit={(e) => void submit(e)}>
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
    </form>
  );
}

function Characters(props: {
  t: Translate;
  content: ClientContent;
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
  character: Character;
  sessionToken: string;
  onEnd(reason: DisconnectReason | undefined): void;
}): JSX.Element {
  const { t } = props;
  const host = useRef<HTMLDivElement>(null);
  const game = useRef<Game | undefined>(undefined);
  // The Game lives as long as the session; a language change reaches it through here.
  const tRef = useRef(t);
  tRef.current = t;
  const [entered, setEntered] = useState(false);
  const [ui, setUi] = useState<GameUi>({
    battle: [],
    target: undefined,
    stats: undefined,
    skills: [],
    conditions: [],
    levelUp: undefined,
    death: undefined,
    log: [],
    chat: [],
    inventory: new Map(),
    containers: [],
    hotkeys: [],
    dialog: undefined,
    shop: undefined,
  });
  const [levelNotice, setLevelNotice] = useState<number | undefined>(undefined);
  // The death screen stays until the player closes it.
  const [deathSeen, setDeathSeen] = useState<number | undefined>(undefined);
  const death = ui.death && ui.death.at !== deathSeen ? ui.death : undefined;
  const [stance, setStance] = useState(FightStance.BALANCED);
  const [chase, setChase] = useState(false);

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
      entered: () => setEntered(true),
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

  return (
    <div class="game" data-testid="game">
      <header class="hud">
        <span class="name">{props.character.name}</span>
        {ui.stats && (
          <span class="stat" data-testid="health">
            {t("client.game.health", { health: ui.stats.health, max: ui.stats.maxHealth })}
          </span>
        )}
        {ui.stats && (
          <span class="stat" data-testid="mana">
            {t("client.game.mana", { mana: ui.stats.mana, max: ui.stats.maxMana })}
          </span>
        )}
        {ui.stats && (
          <span class="stat" data-testid="level">
            {t("client.game.level", { level: ui.stats.level, percent: ui.stats.levelPercent })}
          </span>
        )}
        {ui.stats && (
          <span class="stat" data-testid="experience">
            {t("client.game.experience", { experience: ui.stats.experience })}
          </span>
        )}
        <ConditionBar t={t} conditions={ui.conditions} />
        <span class="hint">{t("client.game.controls")}</span>
        {props.languagePicker}
        <button type="button" onClick={() => game.current?.logout()}>
          {t("client.game.logout")}
        </button>
      </header>
      <div class="game-body">
        <div class="viewport" ref={host}>
          {!entered && <p class="connecting">{t("client.game.connecting")}</p>}
          {levelNotice !== undefined && (
            <div class="level-up" role="status" data-testid="level-up">
              <strong>{t("client.level_up.title")}</strong>
              <span>{t("client.characters.level", { level: levelNotice })}</span>
            </div>
          )}
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
          {entered && <Hotbar t={t} content={props.content} game={game.current} ui={ui} />}
          {entered && <DialogWindow t={t} content={props.content} game={game.current} ui={ui} />}
        </div>
        <aside class="side">
          <section class="battle" data-testid="battle-list" aria-label={t("client.battle.title")}>
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
                      disabled={c.kind !== CreatureKind.MONSTER}
                      title={t("client.battle.attack_hint")}
                      onClick={() => game.current?.attack(c.id)}
                    >
                      <span class="cname">{creatureName(c, t)}</span>
                      <span class="hp" aria-label={t("client.battle.health", { health: c.health })}>
                        <span style={{ width: `${c.health}%` }} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
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
          </section>
          <InventoryPanel t={t} content={props.content} game={game.current} ui={ui} />
          <SkillsPanel t={t} skills={ui.skills} />
          <ul class="log" data-testid="game-log" aria-live="polite">
            {ui.log.map((m, i) => (
              <li key={`${m.at}-${i}`}>{formatMessage(m, props.content, t)}</li>
            ))}
          </ul>
          <ChatPanel t={t} content={props.content} game={game.current} ui={ui} />
        </aside>
      </div>
    </div>
  );
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
};

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
    <section class="skills" data-testid="skills-panel" aria-label={t("client.skills.title")}>
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
