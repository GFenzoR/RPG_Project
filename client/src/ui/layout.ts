// Responsive layout of the game screen (T5.6), pure and unit-tested: the breakpoints are
// data, and App.tsx only asks which layout fits the window. client.css keys its rules off
// the `data-layout` and `data-panel` attributes this decides, so the numbers live here.

/** The layouts of the game screen. */
export type LayoutId = "desktop" | "tablet" | "phone-portrait" | "phone-landscape";

/**
 * How the side panel shows:
 * - sidebar: every section stacked in a column next to the map (desktop, as before T5.6);
 * - tabs: one section at a time under a tab bar (next to or below the map);
 * - drawer: tabs in a panel that slides over the map and is closed by default.
 */
export type PanelMode = "sidebar" | "tabs" | "drawer";

/** Where the side panel goes relative to the map. */
export type BodyFlow = "row" | "column";

export interface Layout {
  id: LayoutId;
  panel: PanelMode;
  flow: BodyFlow;
  /** The header keeps only name, health, mana and level; the rest folds into a menu. */
  compactHeader: boolean;
}

export interface Breakpoint {
  layout: Layout;
  /** Widest window (CSS px) that uses this layout; undefined = no limit. */
  maxWidth?: number;
  /** Tallest window (CSS px) that uses this layout; undefined = no limit. */
  maxHeight?: number;
  /** Only when the window is taller than wide (true) or wider than tall (false). */
  portrait?: boolean;
}

/** Narrowest window whose header fits on one line with every stat (CSS px). */
export const COMPACT_HEADER_MAX = 719;

/**
 * First match wins. The desktop app's minimum window (960 x 700) and anything wider stays
 * on the sidebar; a phone on its side is short, so height decides that one.
 */
export const BREAKPOINTS: readonly Breakpoint[] = [
  {
    layout: { id: "phone-landscape", panel: "drawer", flow: "row", compactHeader: true },
    maxWidth: 1000,
    maxHeight: 500,
    portrait: false,
  },
  {
    layout: { id: "phone-portrait", panel: "tabs", flow: "column", compactHeader: true },
    maxWidth: 599,
  },
  {
    // A portrait tablet (iPad Mini, 768 px) with 44 px touch targets cannot fit every stat
    // and button of the header on one line either: the compact header and its menu.
    layout: { id: "tablet", panel: "tabs", flow: "column", compactHeader: true },
    maxWidth: 959,
    portrait: true,
  },
  {
    layout: { id: "tablet", panel: "tabs", flow: "row", compactHeader: false },
    maxWidth: 959,
  },
  { layout: { id: "desktop", panel: "sidebar", flow: "row", compactHeader: false } },
];

/** The layout for a window of width x height CSS pixels. */
export function layoutFor(
  width: number,
  height: number,
  breakpoints: readonly Breakpoint[] = BREAKPOINTS,
): Layout {
  const portrait = height > width;
  for (const b of breakpoints) {
    if (b.maxWidth !== undefined && width > b.maxWidth) continue;
    if (b.maxHeight !== undefined && height > b.maxHeight) continue;
    if (b.portrait !== undefined && b.portrait !== portrait) continue;
    return {
      ...b.layout,
      compactHeader: b.layout.compactHeader || width <= COMPACT_HEADER_MAX,
    };
  }
  return {
    id: "desktop",
    panel: "sidebar",
    flow: "row",
    compactHeader: width <= COMPACT_HEADER_MAX,
  };
}

/** The sections of the side panel, in tab order. */
export const PANEL_TABS = [
  "battle",
  "party",
  "guild",
  "inventory",
  "skills",
  "quests",
  "appearance",
  "chat",
] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/** Title key of each tab (the same title its section shows on desktop). */
export const TAB_TITLE: Record<PanelTab, string> = {
  battle: "client.battle.title",
  party: "client.party.title",
  guild: "client.guild.title",
  inventory: "client.inventory.title",
  skills: "client.skills.title",
  quests: "client.quests.title",
  appearance: "client.appearance.title",
  chat: "client.chat.title",
};

/**
 * The tab that holds a tutorial highlight (data-tutorial value), so the step's element is
 * on screen; undefined when it is not in the panel (header, hotbar).
 */
export function tabForHighlight(highlight: string | undefined): PanelTab | undefined {
  switch (highlight) {
    case "battle":
    case "inventory":
    case "skills":
    case "chat":
      return highlight;
    default:
      return undefined;
  }
}

export interface HotbarFit {
  /** Slots shown at once. */
  visible: number;
  /** True when not every slot fits: the bar scrolls and shows its arrows. */
  slider: boolean;
}

/**
 * How many hotbar slots fit in `available` CSS px, given the width of a slot, the gap
 * between slots and the width of what sits beside the slots (edit button; the two arrows
 * count only when the slider is needed). Always at least one slot.
 */
export function hotbarFit(opts: {
  available: number;
  slot: number;
  gap: number;
  total: number;
  /** The edit button and the gaps around it. */
  fixed: number;
  /** Both arrows and their gaps, needed only when not everything fits. */
  arrows: number;
}): HotbarFit {
  const { available, slot, gap, total, fixed, arrows } = opts;
  const fits = (room: number): number =>
    slot <= 0 ? total : Math.max(0, Math.floor((room + gap) / (slot + gap)));
  if (fits(available - fixed) >= total) return { visible: total, slider: false };
  const visible = Math.max(1, Math.min(total, fits(available - fixed - arrows)));
  return { visible, slider: visible < total };
}

/**
 * Width (CSS px) the hotbar may take on a map `host` px wide (client.css and touch.css): a
 * centred bar keeps `margin` free on each side; next to the touch pad it starts after the
 * pad's `pad` px (which include the left margin) and keeps the margin on the right.
 */
export function hotbarRoom(host: number, pad: number, margin: number): number {
  return Math.max(0, pad > 0 ? host - pad - margin : host - 2 * margin);
}

/** Width (CSS px) of `n` slots in a row. */
export const slotsWidth = (n: number, slot: number, gap: number): number =>
  n <= 0 ? 0 : n * slot + (n - 1) * gap;

/**
 * Where the arrows of the hotbar slider can go, from the scroll position of the slot
 * list (scrollLeft, the width shown and the full width). A pixel of slack absorbs
 * sub-pixel rounding.
 */
export function sliderEnds(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { prev: boolean; next: boolean } {
  return { prev: scrollLeft > 1, next: scrollLeft + clientWidth < scrollWidth - 1 };
}
