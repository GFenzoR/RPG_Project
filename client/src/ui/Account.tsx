// Account pieces shared by the game's screens and the website (T2.1): the "confirm your
// email" notice and the "forgot your password?" link. Both only show when the server
// sends emails, so nobody is offered something that cannot work (docs/05).
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Translate } from "../i18n/i18n.ts";
import { ApiError, accountApi, authConfig, emailEnabled, oauthApi } from "../net/api.ts";
import type { Account, AuthConfig } from "../net/api.ts";
import { desktopServer, isDesktop } from "../net/desktop.ts";

/** Whether the server sends emails; undefined while asking. Asked once per page. */
export function useEmailEnabled(): boolean | undefined {
  const [on, setOn] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void emailEnabled().then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}

/**
 * "Forgot your password?" → the website's /forgot-password page. In the desktop app the
 * page is not the website, so it shows the address to open in a browser instead (plain,
 * selectable text: the app does not open external links).
 */
export function ForgotPasswordLink(props: { t: Translate }): JSX.Element | null {
  const on = useEmailEnabled();
  if (!on) return null;
  if (isDesktop()) {
    const origin = desktopServer()?.origin;
    if (!origin) return null;
    return (
      <p class="forgot-link muted" data-testid="forgot-password-desktop">
        {props.t("client.login.forgot_desktop", { url: `${origin}/forgot-password` })}
      </p>
    );
  }
  return (
    <a class="forgot-link" href="/forgot-password" data-testid="forgot-password">
      {props.t("client.login.forgot")}
    </a>
  );
}

/** The signed-in account's "confirm your email" notice with a resend button. */
export function VerifyNotice(props: { t: Translate; lang: string }): JSX.Element | null {
  const { t } = props;
  const [account, setAccount] = useState<Account | undefined>(undefined);
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>("idle");
  useEffect(() => {
    let live = true;
    accountApi.account().then(
      (a) => live && setAccount(a),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  if (!account?.email_enabled || account.email_verified) return null;
  const error = state !== "idle" && state !== "busy" && state !== "sent" ? state : undefined;
  return (
    <div class="verify-notice" role="status" data-testid="verify-notice">
      <p>{t("client.verify.notice", { email: account.email })}</p>
      {state === "sent" ? (
        <p class="notice">{t("client.verify.sent")}</p>
      ) : (
        <button
          type="button"
          class="link"
          disabled={state === "busy"}
          data-testid="verify-resend"
          onClick={() => {
            setState("busy");
            accountApi.resend(props.lang).then(
              () => setState("sent"),
              (e: unknown) => setState(e instanceof ApiError ? e.code : "unknown"),
            );
          }}
        >
          {t("client.verify.resend")}
        </button>
      )}
      {error && (
        <p class="error" role="alert">
          {t(`error.${error}`) === `error.${error}` ? t("error.unknown") : t(`error.${error}`)}
        </p>
      )}
    </div>
  );
}

/** The server's account features (T2.1); undefined while asking. */
export function useAuthConfig(): AuthConfig | undefined {
  const [cfg, setCfg] = useState<AuthConfig | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void authConfig().then((c) => live && setCfg(c));
    return () => {
      live = false;
    };
  }, []);
  return cfg;
}

/** The OAuth providers of the server (T2.1); undefined while asking. */
export function useProviders(): string[] | undefined {
  return useAuthConfig()?.providers;
}

/**
 * "Sign in with Google / Discord". The browser leaves for the provider and comes back
 * to `returnTo` (the server only accepts a few fixed pages). Not in the desktop app: it
 * shows where to do it in a browser instead (the app cannot receive the provider's
 * redirect; docs/05).
 */
export function OAuthButtons(props: { t: Translate; returnTo: string }): JSX.Element | null {
  const { t } = props;
  const cfg = useAuthConfig();
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const providers = cfg?.providers;
  if (!cfg || !providers || providers.length === 0) return null;
  if (isDesktop()) {
    const origin = desktopServer()?.origin;
    return origin ? (
      <p class="oauth-hint muted" data-testid="oauth-desktop">
        {t("client.oauth.desktop", { url: origin })}
        {cfg.email && ` ${t("client.oauth.desktop_password")}`}
      </p>
    ) : null;
  }
  // The provider sends the browser back to PUBLIC_URL only, and the binding cookie is
  // this origin's: from any other address (a LAN or Tailscale IP) the login cannot work.
  if (cfg.publicOrigin && cfg.publicOrigin !== location.origin) {
    return (
      <p class="oauth-hint muted" data-testid="oauth-other-origin">
        {t("client.oauth.other_origin", { url: cfg.publicOrigin })}
      </p>
    );
  }
  return (
    <div class="oauth-buttons" data-testid="oauth-buttons">
      {providers.map((p) => (
        <button
          key={p}
          type="button"
          class={`oauth-button oauth-${p}`}
          data-testid={`oauth-${p}`}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            oauthApi.start(p, props.returnTo).then(
              (r) => location.assign(r.url),
              (e: unknown) => {
                setError(e instanceof ApiError ? e.code : "unknown");
                setBusy(false);
              },
            );
          }}
        >
          {t("client.oauth.continue", { provider: t(`client.oauth.provider.${p}`) })}
        </button>
      ))}
      {error && (
        <p class="error" role="alert">
          {t(`error.${error}`) === `error.${error}` ? t("error.unknown") : t(`error.${error}`)}
        </p>
      )}
    </div>
  );
}
