// Screens of the client: login, sign up, characters (list and creation) and the game.
// DOM with Preact over the canvas (client/CLAUDE.md): accessible, translatable and easy to
// drive from Playwright. Every visible text goes through t().
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { DisconnectReason } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import { Game } from "../game.ts";
import type { GameUi } from "../game.ts";
import type { AudioEngine } from "../audio/engine.ts";
import type { Translate } from "../i18n/i18n.ts";
import { ApiError, api } from "../net/api.ts";
import type { Character } from "../net/api.ts";
import { ServerPicker } from "./ServerPicker.tsx";
import { ForgotPasswordLink, OAuthButtons, VerifyNotice } from "./Account.tsx";
import { GameView, emptyGameUi } from "./GameView.tsx";
import { loadControls } from "../state/controls.ts";
import type { GameSettings } from "./GameView.tsx";

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
  /** The language selector: fixed in a corner, or in the phone's menu. */
  languagePicker?: JSX.Element;
  /** Sound (T3.7); undefined = silent. */
  audio?: AudioEngine | undefined;
  /** T5.6: show the on-screen direction pad (switched in Options, state/touch-prefs.ts). */
  touchPad?: boolean | undefined;
  /** The desktop game's Options window (docs/17 UI-5): language, sound, controls. */
  settings?: GameSettings | undefined;
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

function Screens({
  content,
  t,
  locale,
  languagePicker,
  audio,
  touchPad,
  settings,
}: AppProps): JSX.Element {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    // A still-valid session cookie skips the login.
    api.characters().then(
      () => setScreen({ name: "characters" }),
      () => setScreen({ name: "login" }),
    );
  }, []);

  // Outside the game the menus play the title screen's loop (assets/sounds.yaml
  // music.title), and no ambient bed; the game sets its own loops from its first batch.
  // Leaving the game silences it first (Game.destroy) and this starts the title again.
  const inGame = screen.name === "game";
  useEffect(() => {
    if (!inGame) audio?.setLoops(content.sounds.music.title, undefined);
  }, [inGame, audio, content]);

  const toCharacters = (): void => setScreen({ name: "characters" });
  const toLogin = (): void => setScreen({ name: "login" });

  const view = current();
  if (screen.name === "game") return view;
  // Outside the game the selector sits in a corner (the game has its own place for it),
  // and the game's name in gothic letters crowns the panel (docs/17 UI-3).
  return (
    <>
      {languagePicker && <div class="corner">{languagePicker}</div>}
      <p class="brand" aria-hidden="true">
        {t("client.title")}
      </p>
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
            settings={settings}
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
  settings: GameSettings | undefined;
  audio: AudioEngine | undefined;
  touchPad: boolean;
  character: Character;
  sessionToken: string;
  onEnd(reason: DisconnectReason | undefined): void;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const game = useRef<Game | undefined>(undefined);
  // The Game lives as long as the session; a language change reaches it through here.
  const tRef = useRef(props.t);
  tRef.current = props.t;
  const [entered, setEntered] = useState(false);
  // The atlas did not load after its retries: the error and its "Retry" button show.
  const [loadFailed, setLoadFailed] = useState(false);
  const [ui, setUi] = useState<GameUi>(emptyGameUi);
  const [storage] = useState(safeStorage);
  // Options → Controls (docs/17 UI-6) reaches the Game, which reads it at each click.
  const controls = useRef(props.settings?.controlsMode);
  controls.current = props.settings?.controlsMode;

  useEffect(() => {
    if (!host.current) return undefined;
    const g = new Game({
      host: host.current,
      content: props.content,
      t: (key, params) => tRef.current(key, params),
      locale: props.locale,
      sessionToken: props.sessionToken,
      vocation: props.character.vocation,
      storage,
      controls: () => controls.current ?? loadControls(storage),
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

  return (
    <GameView
      t={props.t}
      content={props.content}
      languagePicker={props.languagePicker}
      settings={props.settings}
      touchPad={props.touchPad}
      characterName={props.character.name}
      ui={ui}
      game={game.current}
      entered={entered}
      loadFailed={loadFailed}
      onRetry={() => {
        setLoadFailed(false);
        game.current?.retryCanvas();
      }}
      host={host}
      storage={storage}
    />
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
