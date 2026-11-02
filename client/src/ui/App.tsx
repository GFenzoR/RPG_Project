// Screens of the client: login, sign up, characters (list and creation) and the game.
// DOM with Preact over the canvas (client/CLAUDE.md): accessible, translatable and easy to
// drive from Playwright. Every visible text goes through t().
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { DisconnectReason } from "@rpg/protocol";
import type { ClientContent } from "../content-types.ts";
import { Game } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { ApiError, api } from "../net/api.ts";
import type { Character } from "../net/api.ts";

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

export function App({ content, t, locale }: AppProps): JSX.Element {
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

  switch (screen.name) {
    case "loading":
      return <p class="panel">{t("client.loading")}</p>;
    case "login":
      return (
        <AuthForm
          t={t}
          mode="login"
          onDone={toCharacters}
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

function AuthForm(props: {
  t: Translate;
  mode: "login" | "register";
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
  character: Character;
  sessionToken: string;
  onEnd(reason: DisconnectReason | undefined): void;
}): JSX.Element {
  const { t } = props;
  const host = useRef<HTMLDivElement>(null);
  const game = useRef<Game | undefined>(undefined);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!host.current) return undefined;
    const g = new Game({
      host: host.current,
      content: props.content,
      t,
      locale: props.locale,
      sessionToken: props.sessionToken,
      entered: () => setEntered(true),
      ended: (reason) => props.onEnd(reason),
    });
    game.current = g;
    return () => g.destroy();
    // One Game per session token.
  }, [props.sessionToken]);

  return (
    <div class="game" data-testid="game">
      <header class="hud">
        <span class="name">{props.character.name}</span>
        <span class="hint">{t("client.game.controls")}</span>
        <button type="button" onClick={() => game.current?.logout()}>
          {t("client.game.logout")}
        </button>
      </header>
      <div class="viewport" ref={host}>
        {!entered && <p class="connecting">{t("client.game.connecting")}</p>}
      </div>
    </div>
  );
}
