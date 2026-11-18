// The credits in Options (docs/17 A1): the art and font licences ask the game to show who
// made what. In the browser, a link to the website's /credits page (another tab, the game
// stays open). In the desktop app, which has no website inside, a button that opens the same
// page in a window over the game: its data (virtual:rpg-credits) is imported only then, and
// its addresses are text, since a link would open inside the app. The window is rendered in
// its own element of <body>: Options may sit in a moved (transformed) window, and a fixed
// box inside it would be placed against that window, not the screen.
import { render } from "preact";
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Credits } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { desktopServer, isDesktop } from "../net/desktop.ts";
import { CreditsPage } from "../site/Credits.tsx";

export function CreditsLink(props: { t: Translate; desktop?: boolean }): JSX.Element {
  const { t } = props;
  if (props.desktop ?? isDesktop()) return <CreditsButton t={t} />;
  return (
    <a
      class="credits-link"
      href="/credits"
      target="_blank"
      rel="noopener"
      data-testid="credits-link"
    >
      {t("client.options.credits")}
    </a>
  );
}

/** What the credits window shows: loading, the credits, or that they could not be read. */
export type CreditsLoad =
  | { state: "loading" }
  | { state: "ready"; credits: Credits }
  | {
      state: "failed";
    };

/**
 * The credits window of the desktop app (no hooks: tests walk its tree). The website's
 * address stays at the bottom, for a browser.
 */
export function CreditsWindow(props: {
  t: Translate;
  load: CreditsLoad;
  site: string;
  onClose(): void;
}): JSX.Element {
  const { t, load } = props;
  return (
    <div
      class="credits-overlay"
      data-testid="credits-window"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        class="credits-window"
        role="dialog"
        aria-modal="true"
        aria-label={t("site.credits.title")}
      >
        <button
          type="button"
          class="credits-close"
          data-testid="credits-close"
          onClick={props.onClose}
        >
          {t("client.options.close")}
        </button>
        {load.state === "ready" ? (
          <CreditsPage t={t} credits={load.credits} plain />
        ) : (
          <p class="muted" role="status">
            {t(load.state === "loading" ? "client.credits.loading" : "client.credits.failed")}
          </p>
        )}
        {props.site !== "" && (
          <p class="credits-link muted" data-testid="credits-desktop">
            {t("client.options.credits_desktop", { url: `${props.site}/credits` })}
          </p>
        )}
      </div>
    </div>
  );
}

/** The import of the credits, shared by every opening (a failed one is tried again). */
let pending: Promise<Credits> | undefined;
const importCredits = (): Promise<Credits> =>
  (pending ??= import("virtual:rpg-credits").then(
    (m) => m.default,
    (err: unknown) => {
      pending = undefined;
      throw err;
    },
  ));

function CreditsButton(props: { t: Translate }): JSX.Element {
  const { t } = props;
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<CreditsLoad>({ state: "loading" });
  const [host, setHost] = useState<HTMLElement | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const el = document.createElement("div");
    document.body.appendChild(el);
    setHost(el);
    setLoad({ state: "loading" });
    importCredits().then(
      (credits) => live && setLoad({ state: "ready", credits }),
      () => live && setLoad({ state: "failed" }),
    );
    // Escape closes the credits before the game sees it (it would open or close Options).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      live = false;
      window.removeEventListener("keydown", onKey, true);
      render(null, el);
      el.remove();
      setHost(undefined);
    };
  }, [open]);
  useEffect(() => {
    if (!host) return;
    render(
      <CreditsWindow
        t={t}
        load={load}
        site={desktopServer()?.origin ?? ""}
        onClose={() => setOpen(false)}
      />,
      host,
    );
  }, [host, load, t]);
  return (
    <button
      type="button"
      class="credits-link"
      data-testid="credits-open"
      aria-haspopup="dialog"
      onClick={() => setOpen(true)}
    >
      {t("client.options.credits")}
    </button>
  );
}
