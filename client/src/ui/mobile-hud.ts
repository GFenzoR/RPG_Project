// The rules of the mobile HUD (docs/17 "UI movil", lote 21), pure and unit-tested: which
// icon opens each section, where the section buttons live, and the lines of the compact
// chat log over the map. MobileHud.tsx draws them; the sizes are in layout.ts (MOBILE_HUD).
import type { IconName } from "./icons.tsx";
import { PANEL_TABS } from "./layout.ts";
import type { Layout, PanelTab } from "./layout.ts";

/** The pixel icon of each section: the ones of the desktop toolbar (ui/Toolbar.tsx). */
export const TAB_ICON: Readonly<Record<PanelTab, IconName>> = {
  battle: "battle",
  party: "party",
  guild: "guild",
  inventory: "inventory",
  skills: "skills",
  quests: "journal",
  appearance: "appearance",
  chat: "talk",
};

/**
 * The order of the section buttons on a phone: what a thumb reaches for most comes first
 * (the tablist's arrow keys follow the same order).
 */
export const MOBILE_TABS: readonly PanelTab[] = [
  "inventory",
  "battle",
  "skills",
  "quests",
  "party",
  "guild",
  "appearance",
  "chat",
];

/** True when MOBILE_TABS holds every section once (checked by the tests). */
export const tabsComplete = (): boolean =>
  MOBILE_TABS.length === PANEL_TABS.length && PANEL_TABS.every((t) => MOBILE_TABS.includes(t));

/**
 * Where the section buttons (the tablist) show:
 * - `console`: upright, always in the console under the sheet, one tap away (the sheet
 *   opens above the console, so they also switch sections while it is open);
 * - `sheet`: on its side with the drawer open, along the drawer's top;
 * - `none`: on its side with the drawer closed (the bar's panel button opens it).
 */
export function tabsPlace(layout: Layout, open: boolean): "console" | "sheet" | "none" {
  if (layout.flow === "column") return "console";
  return open ? "sheet" : "none";
}

/**
 * Where the button that opens and closes the sheet shows: on its side it stays in the bar
 * (the drawer ends above the bar); upright it is the sheet's own close button, and the
 * section buttons of the console open it.
 */
export function togglePlace(layout: Layout, open: boolean): "bar" | "sheet" | "none" {
  if (layout.flow === "row") return "bar";
  return open ? "sheet" : "none";
}

/** How long a line stays in the compact chat log over the map, ms. */
export const GLANCE_MS = 12_000;
/** The last part of GLANCE_MS, in which the line fades out (mobile.css chat-glance-out). */
export const GLANCE_FADE_MS = 2000;
/** Lines the compact chat log shows at most. */
export const GLANCE_LINES = 3;

/**
 * The lines of the compact chat log at `now` (the clock of ChatLine.at): the newest
 * GLANCE_LINES said in the last GLANCE_MS, oldest first.
 */
export function glanceLines<L extends { at: number }>(
  chat: readonly L[],
  now: number,
  max: number = GLANCE_LINES,
  ttl: number = GLANCE_MS,
): L[] {
  const fresh = chat.filter((l) => l.at <= now && now - l.at < ttl);
  return max > 0 ? fresh.slice(-max) : [];
}

/** When the oldest line shown leaves (same clock), or undefined with none. */
export function glanceExpiry<L extends { at: number }>(
  lines: readonly L[],
  ttl: number = GLANCE_MS,
): number | undefined {
  if (lines.length === 0) return undefined;
  return Math.min(...lines.map((l) => l.at)) + ttl;
}
