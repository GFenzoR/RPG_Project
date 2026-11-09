// Pages of the emailed links (T2.1): /verify, /forgot-password and /reset-password.
// The token comes from the URL fragment (routes.ts linkToken) and goes to the API in a
// POST body; the fragment is then dropped from the address bar and the history.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Translate } from "../i18n/i18n.ts";
import { ApiError, accountApi } from "../net/api.ts";
import { linkToken } from "./routes.ts";

interface PageProps {
  t: Translate;
  lang: string;
  playHref: string;
}

function codeOf(e: unknown): string {
  return e instanceof ApiError ? e.code : "unknown";
}

function ErrorLine(props: { t: Translate; code: string }): JSX.Element {
  const key = `error.${props.code}`;
  const text = props.t(key);
  return (
    <p class="error" role="alert" data-testid="account-error">
      {text === key ? props.t("error.unknown") : text}
    </p>
  );
}

/** Reads the link's token once and removes it from the URL. */
function useLinkToken(): string | undefined {
  const [token] = useState(() => linkToken(location.hash));
  useEffect(() => {
    if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
  }, []);
  return token;
}

export function VerifyPage(props: PageProps): JSX.Element {
  const { t } = props;
  const token = useLinkToken();
  const [state, setState] = useState<"working" | "done" | string>(token ? "working" : "no_token");
  useEffect(() => {
    if (!token) return;
    accountApi.verify(token).then(
      () => setState("done"),
      (e: unknown) => setState(codeOf(e)),
    );
  }, [token]);
  return (
    <section class="card account-page" data-testid="verify-page">
      <h1>{t("site.account.verify.title")}</h1>
      {state === "working" && <p aria-live="polite">{t("site.account.verify.working")}</p>}
      {state === "done" && (
        <>
          <p class="notice" role="status" data-testid="verify-done">
            {t("site.account.verify.done")}
          </p>
          <a class="play-button" href={props.playHref}>
            {t("site.account.to_play")}
          </a>
        </>
      )}
      {state === "no_token" && <p class="error">{t("site.account.verify.no_token")}</p>}
      {state !== "working" && state !== "done" && state !== "no_token" && (
        <ErrorLine t={t} code={state} />
      )}
    </section>
  );
}

export function ForgotPage(props: PageProps): JSX.Element {
  const { t } = props;
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>("idle");
  const error = !["idle", "busy", "sent"].includes(state) ? state : undefined;
  return (
    <section class="card account-page" data-testid="forgot-page">
      <h1>{t("site.account.forgot.title")}</h1>
      {state === "sent" ? (
        <>
          <p class="notice" role="status" data-testid="forgot-sent">
            {t("site.account.forgot.sent")}
          </p>
          <p class="muted">{t("site.account.forgot.unconfirmed")}</p>
        </>
      ) : (
        <form
          class="maps-form"
          onSubmit={(e) => {
            e.preventDefault();
            setState("busy");
            accountApi.forgot(email, props.lang).then(
              () => setState("sent"),
              (err: unknown) => setState(codeOf(err)),
            );
          }}
        >
          <p class="muted">{t("site.account.forgot.hint")}</p>
          <label>
            <span>{t("client.login.email")}</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onInput={(e) => setEmail(e.currentTarget.value)}
            />
          </label>
          {error && <ErrorLine t={t} code={error} />}
          <button type="submit" disabled={state === "busy"}>
            {t("site.account.forgot.submit")}
          </button>
        </form>
      )}
    </section>
  );
}

export function ResetPage(props: PageProps): JSX.Element {
  const { t } = props;
  const token = useLinkToken();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "done" | string>("idle");
  const error = !["idle", "busy", "done"].includes(state) ? state : undefined;
  if (!token)
    return (
      <section class="card account-page" data-testid="reset-page">
        <h1>{t("site.account.reset.title")}</h1>
        <p class="error">{t("site.account.verify.no_token")}</p>
      </section>
    );
  return (
    <section class="card account-page" data-testid="reset-page">
      <h1>{t("site.account.reset.title")}</h1>
      {state === "done" ? (
        <>
          <p class="notice" role="status" data-testid="reset-done">
            {t("site.account.reset.done")}
          </p>
          <a class="play-button" href={props.playHref}>
            {t("site.account.to_play")}
          </a>
        </>
      ) : (
        <form
          class="maps-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (password !== confirm) {
              setState("mismatch");
              return;
            }
            setState("busy");
            accountApi.reset(token, password).then(
              () => setState("done"),
              (err: unknown) => setState(codeOf(err)),
            );
          }}
        >
          <label>
            <span>{t("site.account.reset.password")}</span>
            <input
              type="password"
              name="new-password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              value={password}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
            <small>{t("client.register.password_hint")}</small>
          </label>
          <label>
            <span>{t("site.account.reset.confirm")}</span>
            <input
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              required
              value={confirm}
              onInput={(e) => setConfirm(e.currentTarget.value)}
            />
          </label>
          {error === "mismatch" ? (
            <p class="error" role="alert" data-testid="account-error">
              {t("site.account.reset.mismatch")}
            </p>
          ) : (
            error && <ErrorLine t={t} code={error} />
          )}
          <button type="submit" disabled={state === "busy"}>
            {t("site.account.reset.submit")}
          </button>
        </form>
      )}
    </section>
  );
}
