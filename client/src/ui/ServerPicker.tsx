// Desktop app only (apps/desktop): the game server under the login form, so one installer
// works against this PC (http://localhost:8080), a tunnel or the real server. Saving goes
// through the app (config.json) and restarts it; nothing renders on the web.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { Translate } from "../i18n/i18n.ts";
import {
  desktopServer,
  normalizeServerUrl,
  serverUrlError,
  setDesktopServer,
} from "../net/desktop.ts";

// Literal keys, so `make validate` sees each one.
const ERROR_KEYS: Record<string, string> = {
  invalid: "client.server.error.invalid",
  insecure: "client.server.error.insecure",
  path: "client.server.error.path",
  env_locked: "client.server.error.env_locked",
  save: "client.server.error.save",
};

export function ServerPicker(props: { t: Translate }): JSX.Element | null {
  const { t } = props;
  const server = desktopServer();
  const [url, setUrl] = useState(server?.origin ?? "");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  if (!server) return null;

  const save = async (e: Event): Promise<void> => {
    e.preventDefault();
    // A bare local address gets http:// (shown in the field before the app restarts).
    const target = normalizeServerUrl(url);
    setUrl(target);
    const problem = serverUrlError(target);
    if (problem) {
      setError(t(ERROR_KEYS[problem] ?? "client.server.error.invalid"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await setDesktopServer(target); // restarts the app on success
    } catch (err) {
      // The app answers a code (lib.rs, set_server); anything else is a save error.
      const code = typeof err === "string" && err in ERROR_KEYS ? err : "save";
      setError(t(ERROR_KEYS[code] ?? "client.server.error.save"));
      setBusy(false);
    }
  };

  return (
    <details class="server-picker" data-testid="server-picker">
      <summary>{t("client.server.current", { origin: server.origin })}</summary>
      {server.editable ? (
        <form class="server-picker-body" noValidate onSubmit={(e) => void save(e)}>
          <label>
            {t("client.server.input")}
            <input
              type="url"
              name="server"
              inputMode="url"
              autoComplete="off"
              spellcheck={false}
              value={url}
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
            <small>{t("client.server.hint")}</small>
          </label>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {t("client.server.save")}
          </button>
        </form>
      ) : (
        <p class="server-picker-body">{t("client.server.error.env_locked")}</p>
      )}
    </details>
  );
}
