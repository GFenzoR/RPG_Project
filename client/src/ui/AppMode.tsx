// "Pantalla completa" and "Instalar como app" (owner, 2026-11-24; docs/15): the buttons of
// the login and character screens, of Options and of the in-game menu, the iOS steps sheet
// and the "new version" prompt. What shows on each platform is decided by the pure rules of
// state/install.ts; ui/app-mode.ts holds the page's one store and talks to the browser.
import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import { fullscreenOffer, fullscreenReoffer, installOffer } from "../state/install.ts";
import type { AppModeState } from "../state/install.ts";
import {
  appMode,
  appUpdateReady,
  dismissInstall,
  enterFullscreen,
  exitFullscreen,
  forgetFullscreen,
  promptInstall,
  subscribeAppMode,
} from "./app-mode.ts";
import { Icon } from "./icons.tsx";

/** The store's state, again on each of its changes. */
export function useAppMode(): { mode: AppModeState; update: boolean } {
  const [, bump] = useState(0);
  useEffect(() => subscribeAppMode(() => bump((n) => n + 1)), []);
  return { mode: appMode(), update: appUpdateReady() };
}

/** The steps to install on iPhone and iPad, where only Safari's Share menu can do it. */
export function IosSteps(props: { t: Translate; onClose(): void }): JSX.Element {
  const { t } = props;
  return (
    <div
      class="app-sheet-layer"
      onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <section
        class="app-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("client.app.install")}
        data-testid="install-steps"
      >
        <h2>{t("client.app.install")}</h2>
        <ol class="app-steps">
          <li>
            <span class="app-step-icon" aria-hidden="true">
              <Icon name="share" />
            </span>
            {t("client.app.ios.step_share")}
          </li>
          <li>
            <span class="app-step-icon" aria-hidden="true">
              <Icon name="addhome" />
            </span>
            {t("client.app.ios.step_add")}
          </li>
          <li>
            <span class="app-step-icon" aria-hidden="true">
              <Icon name="fullscreen" />
            </span>
            {t("client.app.ios.step_open")}
          </li>
        </ol>
        <button type="button" data-testid="install-steps-close" onClick={() => props.onClose()}>
          {t("client.app.close")}
        </button>
      </section>
    </div>
  );
}

/**
 * The two buttons. `where`: "screen" (login and characters: the install offer can be
 * dismissed and stays so) or "options" (always there while it applies).
 */
export function AppModeButtons(props: {
  t: Translate;
  where: "screen" | "options";
  /**
   * Beside a "screen" set of buttons (the Options panel of the corner and of the phone
   * menu): only the install button, and only once the screen's offer was dismissed, so
   * nothing shows twice.
   */
  fallback?: boolean;
}): JSX.Element | null {
  const { t, where } = props;
  const { mode, update: updateReady } = useAppMode();
  const [steps, setSteps] = useState(false);
  const fallback = props.fallback === true;
  if (fallback && !mode.memory.installDismissed) return null;
  const update = updateReady && !fallback;
  const full = fallback ? "none" : fullscreenOffer(mode);
  const install = installOffer(mode, where);
  // Where a page cannot go fullscreen (iPhone), the install steps are the way to lose the
  // address bar: the hint opens them instead of a button that would do nothing.
  const hint = full === "install-hint" && installOffer(mode, "options") === "ios-steps";
  return (
    <div class="app-mode" data-testid="app-mode" data-where={where} data-platform={mode.platform}>
      {update && (
        <p class="app-update" role="status" data-testid="app-update">
          {t("client.app.update")}{" "}
          <button type="button" data-testid="app-update-reload" onClick={() => location.reload()}>
            {t("client.app.reload")}
          </button>
        </p>
      )}
      {(full === "enter" || full === "exit") && (
        <button
          type="button"
          class="app-button"
          data-testid="fullscreen-button"
          data-reoffer={fullscreenReoffer(mode) ? "" : undefined}
          aria-pressed={full === "exit"}
          onClick={() => (full === "exit" ? exitFullscreen() : enterFullscreen())}
        >
          <Icon name="fullscreen" />
          {t(full === "exit" ? "client.app.fullscreen_exit" : "client.app.fullscreen")}
        </button>
      )}
      {hint && where === "options" && (
        <p class="app-hint" data-testid="fullscreen-hint">
          {t("client.app.fullscreen_ios")}
        </p>
      )}
      {install !== "none" && (
        <span class="app-install">
          <button
            type="button"
            class="app-button"
            data-testid="install-button"
            data-install={install}
            onClick={() => (install === "prompt" ? promptInstall() : setSteps(true))}
          >
            <Icon name="install" />
            {t("client.app.install")}
          </button>
          {where === "screen" && (
            <button
              type="button"
              class="app-dismiss"
              data-testid="install-dismiss"
              aria-label={t("client.app.install_dismiss")}
              title={t("client.app.install_dismiss")}
              onClick={() => dismissInstall()}
            >
              <span aria-hidden="true">×</span>
            </button>
          )}
        </span>
      )}
      {steps && <IosSteps t={t} onClose={() => setSteps(false)} />}
    </div>
  );
}

/**
 * In the game, over the map: fullscreen offered again after the browser left it (a
 * rotation, the back gesture). One tap enters; × stops offering.
 */
export function FullscreenReoffer(props: { t: Translate }): JSX.Element | null {
  const { t } = props;
  const { mode } = useAppMode();
  if (!fullscreenReoffer(mode)) return null;
  return (
    <div class="fullscreen-reoffer" data-testid="fullscreen-reoffer">
      <button type="button" class="app-button" onClick={() => enterFullscreen()}>
        <Icon name="fullscreen" />
        {t("client.app.fullscreen")}
      </button>
      <button
        type="button"
        class="app-dismiss"
        aria-label={t("client.app.close")}
        title={t("client.app.close")}
        onClick={() => forgetFullscreen()}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
