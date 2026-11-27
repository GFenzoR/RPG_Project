// The mobile HUD (docs/17 "UI movil", lote 21): the game screen of phones and of upright or
// small tablets, the same gothic game as the desktop in less room. The map takes the whole
// screen above one bar of carved stone under an iron band (the desktop bar's pieces, from
// Vitals.tsx and windows.css, at phone sizes in mobile.css):
// - on its side (`row`): one slim line; the life orb in the left corner and the mana orb in
//   the right one, the experience along the top with the name plate, and between the orbs
//   the hotbar, the panel button and the menu. The pad floats over the map's corner;
// - upright (`column`): the experience with the name plate between the orbs, the hotbar's
//   arrows under it, the slots edge to edge on a line of their own, and under them the
//   console: the pad at the left thumb and the section buttons at the right one.
// The sections (battle, inventory, chat...) open in a sheet (GameView.tsx); the old plain
// header and its hamburger are gone. No hooks here except the chat log's clock: the rules
// are in mobile-hud.ts and layout.ts.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Translate } from "../i18n/i18n.ts";
import type { GameUi } from "../game.ts";
import type { ClientContent, ExperienceCurve } from "../content-types.ts";
import type { ChatLine } from "../state/world.ts";
import { formatChat } from "../state/messages.ts";
import { KIND_CLASS } from "./Chat.tsx";
import { Icon } from "./icons.tsx";
import { TAB_TITLE } from "./layout.ts";
import type { BodyFlow, PanelTab } from "./layout.ts";
import {
  GLANCE_FADE_MS,
  GLANCE_MS,
  MOBILE_TABS,
  TAB_ICON,
  glanceExpiry,
  glanceLines,
} from "./mobile-hud.ts";
import { ExperienceBar, Orb, lowHealth, orbFill } from "./Vitals.tsx";
import "./mobile.css";

/** The bar (and, upright, the console under it). */
export function MobileBar(props: {
  t: Translate;
  flow: BodyFlow;
  name: string;
  stats: GameUi["stats"];
  /** A level was just gained: the experience bar flashes. */
  levelUp: boolean;
  curve?: ExperienceCurve | undefined;
  /** The spell hotbar (ui/Hotbar.tsx). */
  hotbar: ComponentChildren;
  /** The direction pad (ui/TouchPad.tsx), when Options shows it. */
  pad: ComponentChildren;
  /** The buttons: the panel and the menu (and, upright, the sections and the zoom). */
  tools: ComponentChildren;
}): JSX.Element {
  const { t, stats } = props;
  return (
    <section
      class="hud-bar mobile-bar"
      data-testid="hud-bar"
      data-flow={props.flow}
      data-has-pad={props.pad ? "" : undefined}
      aria-label={t("client.hud.bar")}
    >
      <Orb
        kind="life"
        fill={stats ? orbFill(stats.health, stats.maxHealth) : 1}
        low={lowHealth(stats)}
        text={stats ? t("client.game.health", { health: stats.health, max: stats.maxHealth }) : ""}
        testid="health"
      />
      <div class="mbar-xp">
        <ExperienceBar
          t={t}
          name={props.name}
          stats={stats}
          levelUp={props.levelUp}
          curve={props.curve}
        />
      </div>
      <div class="mbar-hotbar">{props.hotbar}</div>
      {props.pad && <div class="touch-pad-dock">{props.pad}</div>}
      <div class="mbar-tools">{props.tools}</div>
      <Orb
        kind="mana"
        fill={stats ? orbFill(stats.mana, stats.maxMana) : 1}
        text={stats ? t("client.game.mana", { mana: stats.mana, max: stats.maxMana }) : ""}
        testid="mana"
      />
    </section>
  );
}

/**
 * The section buttons: an ARIA tablist of pixel icons (the desktop toolbar's), each a 44 px
 * touch target; the arrow keys, Home and End move between them. In the console a tap opens
 * the sheet on that section; at the top of the open sheet it switches sections.
 */
export function PanelTabs(props: {
  t: Translate;
  tab: PanelTab;
  /** The sheet is open: the chosen tab is marked. */
  open: boolean;
  onTab(tab: PanelTab): void;
  /** Sections with something new (the guild's invitations, unread chat lines). */
  badges?: ReadonlySet<PanelTab> | undefined;
}): JSX.Element {
  const { t } = props;
  const move = (e: KeyboardEvent): void => {
    const i = MOBILE_TABS.indexOf(props.tab);
    const n = MOBILE_TABS.length;
    const to =
      e.key === "ArrowRight"
        ? (i + 1) % n
        : e.key === "ArrowLeft"
          ? (i - 1 + n) % n
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    // The tabs' arrows, not the character's.
    e.stopPropagation();
    const next = MOBILE_TABS[to] ?? props.tab;
    props.onTab(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  return (
    <div
      class="panel-tabs"
      role="tablist"
      aria-label={t("client.panel.tabs")}
      data-testid="panel-tabs"
      onKeyDown={move}
    >
      {MOBILE_TABS.map((name) => {
        const chosen = props.open && props.tab === name;
        return (
          <button
            key={name}
            type="button"
            role="tab"
            class="tool"
            id={`tab-${name}`}
            data-tab={name}
            data-tutorial={name}
            aria-controls={`pane-${name}`}
            aria-selected={chosen}
            aria-label={t(TAB_TITLE[name])}
            title={t(TAB_TITLE[name])}
            tabIndex={props.tab === name ? 0 : -1}
            onClick={() => props.onTab(name)}
          >
            <Icon name={TAB_ICON[name]} />
            {props.badges?.has(name) && <span class="tool-badge" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}

/** The button that opens and closes the sheet (the bar's on its side, the sheet's own ×). */
export function PanelToggle(props: {
  t: Translate;
  open: boolean;
  /** In the bar it wears the inventory's icon; in the sheet it is the close cross. */
  place: "bar" | "sheet";
  onToggle(): void;
  badge?: boolean | undefined;
}): JSX.Element {
  const { t, open } = props;
  const label = t(open ? "client.panel.close" : "client.panel.open");
  return (
    <button
      type="button"
      class={props.place === "bar" ? "tool panel-toggle" : "close panel-toggle"}
      data-testid="panel-toggle"
      aria-expanded={open}
      aria-controls="side-panel"
      aria-label={label}
      title={label}
      onClick={() => props.onToggle()}
    >
      {props.place === "bar" ? <Icon name="inventory" /> : <span aria-hidden="true">×</span>}
      {props.badge && !open && <span class="tool-badge" aria-hidden="true" />}
    </button>
  );
}

/**
 * The menu that replaced the header's hamburger: the same things (experience, help,
 * options with the language, leaving the game) in a framed sheet over the game. A
 * <details>: its summary is the bar's button and, open, also the dark backdrop behind the
 * sheet (mobile.css), so a tap outside closes it without a line of script.
 */
export function MobileMenu(props: { t: Translate; children: ComponentChildren }): JSX.Element {
  const { t } = props;
  return (
    <details class="mmenu" data-testid="hud-menu">
      <summary class="tool" aria-label={t("client.hud.menu")} title={t("client.hud.menu")}>
        <Icon name="menu" />
      </summary>
      <div class="mmenu-body" role="group" aria-label={t("client.hud.menu")}>
        <header>
          <h2>{t("client.hud.menu")}</h2>
          <button
            type="button"
            class="close"
            data-testid="hud-menu-close"
            aria-label={t("client.mobile.menu_close")}
            title={t("client.mobile.menu_close")}
            onClick={(e) => {
              const d = e.currentTarget.closest("details");
              if (d) d.open = false;
            }}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div class="mmenu-scroll">{props.children}</div>
      </div>
    </details>
  );
}

/**
 * The compact chat over the map: the last lines said, translucent, each fading out after
 * GLANCE_MS; a tap opens the whole chat (the sheet's chat section, with its tabs and the
 * line to type). With nothing recent only its small button shows, with a dot when there
 * are lines not read yet. The speech bubbles over the heads are the canvas's and stay.
 */
export function ChatGlance(props: {
  t: Translate;
  content: ClientContent;
  chat: readonly ChatLine[];
  unread: boolean;
  onOpen(): void;
}): JSX.Element {
  const { t } = props;
  const [, tick] = useState(0);
  const now = performance.now();
  const lines = glanceLines(props.chat, now);
  const expiry = glanceExpiry(lines);
  // Re-render when the oldest line is due to go (nothing else may update the UI).
  useEffect(() => {
    if (expiry === undefined) return undefined;
    const timer = setTimeout(
      () => tick((n) => n + 1),
      Math.max(0, expiry - performance.now()) + 30,
    );
    return () => clearTimeout(timer);
  }, [expiry]);
  return (
    <button
      type="button"
      class="chat-glance"
      data-testid="chat-glance"
      data-lines={lines.length}
      aria-label={t("client.mobile.chat_open")}
      title={t("client.mobile.chat_open")}
      onClick={() => props.onOpen()}
    >
      <span class="chat-glance-icon">
        <Icon name="talk" />
        {props.unread && <span class="tool-badge" aria-hidden="true" />}
      </span>
      {lines.length > 0 && (
        <span class="chat-glance-lines chat-lines" aria-hidden="true">
          {lines.map((l, i) => (
            <span
              key={`${l.at}-${i}`}
              class={`chat-glance-line ${KIND_CLASS[l.kind] ?? ""}`}
              // The line fades over its last GLANCE_FADE_MS, wherever it is in its life
              // when it is drawn (a negative delay starts the animation part-way).
              style={{
                animationDelay: `${Math.round(GLANCE_MS - GLANCE_FADE_MS - (now - l.at))}ms`,
              }}
            >
              {formatChat(l, props.content, t)}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
