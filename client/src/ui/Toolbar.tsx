// The toolbar of the desktop game screen (docs/17 UI-5): icon buttons, Tibia-like, in the
// bottom bar (ui/HudBar.tsx, two rows of six beside the hotbar, one row on wide screens),
// that open and close the windows (ui/windows.ts), plus the market and leaving the game.
// Each button names its window and key in its tooltip and in aria-keyshortcuts.
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";
import { WINDOW_KEY_LABEL, WINDOW_TITLE } from "./windows.ts";
import type { WindowId, WindowsState } from "./windows.ts";

/** The windows of the toolbar, in order, with their icons. */
export const TOOLBAR: readonly { id: WindowId; icon: IconName }[] = [
  { id: "inventory", icon: "inventory" },
  { id: "skills", icon: "skills" },
  { id: "quests", icon: "journal" },
  { id: "battle", icon: "battle" },
  { id: "party", icon: "party" },
  { id: "guild", icon: "guild" },
  { id: "appearance", icon: "appearance" },
  { id: "options", icon: "options" },
  { id: "help", icon: "help" },
];

/** The icon of a window (its title bar shows it too; the chat has no button: a speech one). */
export function windowIcon(id: WindowId): IconName {
  if (id === "chat") return "talk";
  return TOOLBAR.find((b) => b.id === id)?.icon ?? "help";
}

/** "Inventario (I)": the tooltip of a toolbar button. */
export function buttonHint(t: Translate, id: WindowId): string {
  const key = WINDOW_KEY_LABEL[id];
  return t("client.toolbar.hint", {
    title: t(WINDOW_TITLE[id]),
    key: key === "Escape" ? t("client.toolbar.key_escape") : key,
  });
}

export function Toolbar(props: {
  t: Translate;
  windows: WindowsState;
  onToggle(id: WindowId): void;
  /** The market window is open (it opens from a market board, never from here). */
  marketOpen: boolean;
  onCloseMarket(): void;
  /** Guild invitations wait for an answer: the guild button shows a dot. */
  guildBadge: boolean;
  onLogout(): void;
}): JSX.Element {
  const { t } = props;
  const market = props.marketOpen
    ? t("client.toolbar.market_close")
    : t("client.toolbar.market_hint");
  return (
    <nav class="toolbar" data-testid="toolbar" aria-label={t("client.toolbar.title")}>
      {TOOLBAR.map(({ id, icon }) => {
        const open = props.windows.win[id].open;
        const hint = buttonHint(t, id);
        const key = WINDOW_KEY_LABEL[id];
        return (
          <button
            key={id}
            type="button"
            class="tool"
            data-window-button={id}
            data-testid={id === "options" ? "options-button" : `toolbar-${id}`}
            aria-pressed={open}
            aria-label={t(WINDOW_TITLE[id])}
            aria-keyshortcuts={key}
            title={hint}
            onClick={() => props.onToggle(id)}
          >
            <Icon name={icon} />
            {id === "guild" && props.guildBadge && <span class="tool-badge" aria-hidden="true" />}
          </button>
        );
      })}
      <button
        type="button"
        class="tool"
        data-testid="toolbar-market"
        aria-pressed={props.marketOpen}
        aria-disabled={!props.marketOpen}
        aria-label={t("client.market.title")}
        aria-keyshortcuts="M"
        title={market}
        onClick={() => {
          if (props.marketOpen) props.onCloseMarket();
        }}
      >
        <Icon name="market" />
      </button>
      <button
        type="button"
        class="tool tool-logout"
        data-testid="logout"
        aria-label={t("client.game.logout")}
        title={t("client.game.logout")}
        onClick={() => props.onLogout()}
      >
        <Icon name="logout" />
      </button>
    </nav>
  );
}
