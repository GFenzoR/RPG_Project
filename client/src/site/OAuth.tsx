// "My account" and the pages of the OAuth flows (T2.1 2/2): /account (linked
// identities: link, unlink), /oauth/confirm (an identity whose email belongs to an
// existing account: prove its password or create another account) and /oauth/error.
// The server decides everything; these pages only show and ask.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Translate } from "../i18n/i18n.ts";
import { ApiError, accountApi, api, oauthApi } from "../net/api.ts";
import type { Account } from "../net/api.ts";
import { VerifyNotice, useProviders } from "../ui/Account.tsx";
import { SiteLogin } from "./Maps.tsx";
import { linkedProvider, oauthErrorKey } from "./routes.ts";

interface Props {
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
    <p class="error" role="alert" data-testid="oauth-page-error">
      {text === key ? props.t("error.unknown") : text}
    </p>
  );
}

const providerName = (t: Translate, p: string): string => t(`client.oauth.provider.${p}`);

export function AccountPage(props: Props & { search: string }): JSX.Element {
  const { t } = props;
  const [account, setAccount] = useState<Account | "login" | string | undefined>(undefined);
  const [round, setRound] = useState(0);
  const reload = (): void => setRound((r) => r + 1);
  useEffect(() => {
    accountApi
      .account()
      .then(setAccount, (e: unknown) =>
        setAccount(codeOf(e) === "unauthorized" ? "login" : codeOf(e)),
      );
  }, [round]);
  // Only a provider the account really has linked; the query is then dropped.
  const linked =
    account && typeof account !== "string"
      ? linkedProvider(
          props.search,
          account.identities.map((i) => i.provider),
        )
      : undefined;
  useEffect(() => {
    if (new URLSearchParams(props.search).has("linked"))
      history.replaceState(history.state, "", location.pathname);
  }, [props.search, account]);
  if (account === undefined) return <p class="muted">{t("site.maps.loading")}</p>;
  if (account === "login") return <SiteLogin t={t} onDone={reload} />;
  if (typeof account === "string") return <ErrorLine t={t} code={account} />;
  return (
    <section class="card account-page" data-testid="account-page">
      <h1>{t("site.account.title")}</h1>
      <p>
        {t("site.account.email", { email: account.email })}{" "}
        <span class="muted">
          {account.email_verified ? t("site.account.verified") : t("site.account.unverified")}
        </span>
      </p>
      <VerifyNotice t={t} lang={props.lang} />
      {linked && (
        <p class="notice" role="status" data-testid="account-linked">
          {t("site.account.linked", { provider: providerName(t, linked) })}
        </p>
      )}
      <LoginMethods t={t} account={account} reload={reload} />
      <button
        type="button"
        class="link-button"
        data-testid="account-logout"
        onClick={() => void api.logout().then(reload, reload)}
      >
        {t("site.maps.account.logout")}
      </button>
    </section>
  );
}

function LoginMethods(props: { t: Translate; account: Account; reload: () => void }): JSX.Element {
  const { t, account } = props;
  const providers = useProviders() ?? [];
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const linkedNames = account.identities.map((i) => i.provider);
  const toLink = providers.filter((p) => !linkedNames.includes(p));
  return (
    <>
      <h2>{t("site.account.methods")}</h2>
      <ul class="account-methods" data-testid="account-methods">
        <li>
          {account.has_password ? t("site.account.password_on") : t("site.account.password_off")}
        </li>
        {account.identities.map((i) => (
          <li key={i.provider} data-testid={`identity-${i.provider}`}>
            <span>
              {t("site.account.identity", {
                provider: providerName(t, i.provider),
                email: i.email || "—",
              })}
            </span>{" "}
            <button
              type="button"
              class="link-button"
              disabled={busy}
              data-testid={`unlink-${i.provider}`}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                oauthApi.unlink(i.provider).then(
                  () => {
                    setBusy(false);
                    props.reload();
                  },
                  (e: unknown) => {
                    setError(codeOf(e));
                    setBusy(false);
                  },
                );
              }}
            >
              {t("site.account.unlink")}
            </button>
          </li>
        ))}
      </ul>
      {toLink.length > 0 && (
        <form
          class="maps-form"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <p class="muted">
            {account.has_password
              ? t("site.account.link_hint")
              : t("site.account.link_hint_recent")}
          </p>
          {account.has_password && (
            <label>
              <span>{t("site.account.current_password")}</span>
              <input
                type="password"
                name="current-password"
                autoComplete="current-password"
                value={password}
                onInput={(e) => setPassword(e.currentTarget.value)}
              />
            </label>
          )}
          <div class="oauth-buttons">
            {toLink.map((p) => (
              <button
                key={p}
                type="button"
                disabled={busy}
                data-testid={`link-${p}`}
                onClick={() => {
                  setBusy(true);
                  setError(undefined);
                  oauthApi.link(p, password).then(
                    (r) => location.assign(r.url),
                    (e: unknown) => {
                      setError(codeOf(e));
                      setBusy(false);
                    },
                  );
                }}
              >
                {t("site.account.link", { provider: providerName(t, p) })}
              </button>
            ))}
          </div>
        </form>
      )}
      {error && <ErrorLine t={t} code={error} />}
    </>
  );
}

export function OAuthConfirmPage(props: Props): JSX.Element {
  const { t } = props;
  const [pending, setPending] = useState<
    { provider: string; email: string; has_password: boolean } | string | undefined
  >(undefined);
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    oauthApi.pending().then(setPending, (e: unknown) => setPending(codeOf(e)));
  }, []);
  if (pending === undefined) return <p class="muted">{t("site.maps.loading")}</p>;
  if (typeof pending === "string")
    return (
      <section class="card account-page" data-testid="oauth-confirm">
        <h1>{t("site.oauth.confirm.title")}</h1>
        <ErrorLine t={t} code={pending} />
        <a class="play-button" href={props.playHref}>
          {t("site.account.to_play")}
        </a>
      </section>
    );
  const done = (r: { return: string }): void => location.assign(r.return);
  const fail = (e: unknown): void => {
    setError(codeOf(e));
    setBusy(false);
  };
  const provider = providerName(t, pending.provider);
  return (
    <section class="card account-page" data-testid="oauth-confirm">
      <h1>{t("site.oauth.confirm.title")}</h1>
      <p>{t("site.oauth.confirm.intro", { provider, email: pending.email })}</p>
      {pending.has_password ? (
        <form
          class="maps-form"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError(undefined);
            oauthApi.confirm(password).then(done, fail);
          }}
        >
          <h2>{t("site.oauth.confirm.link_title")}</h2>
          <label>
            <span>{t("site.oauth.confirm.password", { email: pending.email })}</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </label>
          <button type="submit" disabled={busy} data-testid="oauth-confirm-link">
            {t("site.oauth.confirm.link_submit", { provider })}
          </button>
        </form>
      ) : (
        <p class="notice" data-testid="oauth-confirm-no-password">
          {t("site.oauth.confirm.no_password")}
        </p>
      )}
      <form
        class="maps-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          oauthApi.create(email).then(done, fail);
        }}
      >
        <h2>{t("site.oauth.confirm.create_title")}</h2>
        <p class="muted">{t("site.oauth.confirm.create_hint")}</p>
        <label>
          <span>{t("client.login.email")}</span>
          <input
            type="email"
            name="new-email"
            autoComplete="email"
            required
            value={email}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </label>
        <button type="submit" disabled={busy} data-testid="oauth-confirm-create">
          {t("site.oauth.confirm.create_submit")}
        </button>
      </form>
      {error && <ErrorLine t={t} code={error} />}
    </section>
  );
}

export function OAuthErrorPage(props: Props & { search: string }): JSX.Element {
  const { t } = props;
  return (
    <section class="card account-page" data-testid="oauth-error">
      <h1>{t("site.oauth.error.title")}</h1>
      <p class="error" role="alert">
        {t(oauthErrorKey(props.search))}
      </p>
      <a class="play-button" href={props.playHref}>
        {t("site.account.to_play")}
      </a>
    </section>
  );
}
