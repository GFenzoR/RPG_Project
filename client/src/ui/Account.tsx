// Account pieces shared by the game's screens and the website (T2.1): the "confirm your
// email" notice and the "forgot your password?" link. Both only show when the server
// sends emails, so nobody is offered something that cannot work (docs/05).
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Translate } from "../i18n/i18n.ts";
import { ApiError, accountApi } from "../net/api.ts";
import type { Account } from "../net/api.ts";
import { isDesktop } from "../net/desktop.ts";

/** Whether the server sends emails; undefined while asking. Asked once per page. */
let emailConfig: Promise<boolean> | undefined;
export function useEmailEnabled(): boolean | undefined {
  const [on, setOn] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    emailConfig ??= accountApi.config().then(
      (c) => c.email,
      () => false,
    );
    let live = true;
    void emailConfig.then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}

/**
 * "Forgot your password?" → the website's /forgot-password page. Not in the desktop
 * app: its pages are not the website's, and the link would open inside the app.
 */
export function ForgotPasswordLink(props: { t: Translate }): JSX.Element | null {
  const on = useEmailEnabled();
  if (!on || isDesktop()) return null;
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
          {t(`error.${error}`)}
        </p>
      )}
    </div>
  );
}
