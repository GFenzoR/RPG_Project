// The link to the website's /credits page (docs/17 A1): the art and font licences ask the
// game to show who made what. A link in the browser (another tab, the game stays open);
// in the desktop app, which has no website inside, the address to open in a browser.
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import { desktopServer, isDesktop } from "../net/desktop.ts";

export function CreditsLink(props: { t: Translate }): JSX.Element {
  const { t } = props;
  if (isDesktop()) {
    const origin = desktopServer()?.origin ?? "";
    return (
      <p class="credits-link muted" data-testid="credits-desktop">
        {t("client.options.credits_desktop", { url: `${origin}/credits` })}
      </p>
    );
  }
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
