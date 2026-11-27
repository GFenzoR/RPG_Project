// Responsive layout of the game screen (T5.6, redone for the mobile HUD of lote 21), pure
// and unit-tested: the breakpoints are data, and GameView.tsx only asks which layout fits
// the window. client.css, windows.css and mobile.css key their rules off the `data-layout`,
// `data-panel` and `data-flow` attributes this decides, so the numbers live here.
//
// The breakpoints (CSS px, first match wins; docs/17 "UI movil"):
//
//   window                                  layout           panel    flow    screen
//   --------------------------------------  ---------------  -------  ------  -----------------
//   wider than tall, <= 1000 x <= 500       phone-landscape  drawer   row     mobile HUD
//   <= 599 wide                             phone-portrait   sheet    column  mobile HUD
//   <= 959 wide, taller than wide           tablet           sheet    column  mobile HUD
//   <= 959 wide, wider than tall            tablet           drawer   row     mobile HUD
//   >= 960 wide (and not a phone on its     desktop          sidebar  row     floating windows
//   side)
//
// Tablets, per orientation: upright (iPad Mini 768 x 1024, iPad 810 x 1080, iPad Air
// 820 x 1180) they are narrower than 960 px and take the mobile HUD with the bottom sheet;
// on their side (1024 x 768 and wider) they are at least DESKTOP_MIN_WIDTH wide and take
// the desktop's full screen map with floating windows, which a touch screen scales to its
// fingers (windows.css `.game[data-ui="windows"][data-touch]`: 44 px buttons, a taller
// bar). A small tablet on its side (under 960 px wide) keeps the mobile HUD with the
// drawer. 960 is the desktop app's minimum window: nothing narrower ever gets windows.

/** The layouts of the game screen. */
export type LayoutId = "desktop" | "tablet" | "phone-portrait" | "phone-landscape";

/**
 * How the sections (battle, inventory, chat...) show:
 * - sidebar: the desktop screen, each section a floating window (the name is from before
 *   the full screen HUD, when they were a column next to the map);
 * - sheet: the mobile HUD upright; one section at a time in a sheet that slides up over
 *   the console and the lower part of the map, closed by default;
 * - drawer: the mobile HUD on its side; the same sheet as a drawer over the right of the
 *   map, above the bar, closed by default.
 */
export type PanelMode = "sidebar" | "sheet" | "drawer";

/**
 * The shape of the mobile HUD: `column` stacks the map, the bar and the console (the pad
 * and the section buttons) down the screen; `row` keeps one slim bar under the map, with
 * the pad over the map's corner.
 */
export type BodyFlow = "row" | "column";

export interface Layout {
  id: LayoutId;
  panel: PanelMode;
  flow: BodyFlow;
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

/** Narrowest window (CSS px) that gets the desktop's floating windows. */
export const DESKTOP_MIN_WIDTH = 960;

/**
 * First match wins. The desktop app's minimum window (960 x 700) and anything wider gets
 * the floating windows; a phone on its side is short, so height decides that one.
 */
export const BREAKPOINTS: readonly Breakpoint[] = [
  {
    layout: { id: "phone-landscape", panel: "drawer", flow: "row" },
    maxWidth: 1000,
    maxHeight: 500,
    portrait: false,
  },
  { layout: { id: "phone-portrait", panel: "sheet", flow: "column" }, maxWidth: 599 },
  {
    layout: { id: "tablet", panel: "sheet", flow: "column" },
    maxWidth: DESKTOP_MIN_WIDTH - 1,
    portrait: true,
  },
  { layout: { id: "tablet", panel: "drawer", flow: "row" }, maxWidth: DESKTOP_MIN_WIDTH - 1 },
  { layout: { id: "desktop", panel: "sidebar", flow: "row" } },
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
    return b.layout;
  }
  return { id: "desktop", panel: "sidebar", flow: "row" };
}

/** True for the mobile HUD (phones and upright or small tablets), false for the desktop. */
export const isMobile = (layout: Layout): boolean => layout.panel !== "sidebar";

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

/**
 * The sizes of the mobile HUD (mobile.css keeps the same numbers), CSS px. Every button is
 * a 44 px touch target at least.
 */
export const MOBILE_HUD = {
  /** A hotbar slot and the gap between two. */
  slot: 48,
  slotGap: 4,
  /** The hotbar's arrows and its edit button, and the gap beside each. */
  arrow: 44,
  edit: 44,
  barGap: 4,
  /** The bar's padding on each side. */
  pad: 6,
  /** The column of each orb in the one-row bar of a screen on its side. */
  orbCol: 68,
  /** A button of the bar (the panel, the menu) and the gap between two. */
  tool: 44,
  toolGap: 4,
  /** Buttons right of the hotbar in the one-row bar: the panel and the menu. */
  rowTools: 2,
} as const;

/**
 * The hotbar of the mobile HUD on a screen `width` CSS px wide (less its safe area).
 * Upright (`column`) the slots have a line of their own, edge to edge, with the arrows and
 * the edit button on the line above, between the orbs. On its side (`row`) the bar is one
 * line: orb, slots with their arrows and the edit button, the two buttons, orb.
 */
export function mobileHotbarFit(width: number, flow: BodyFlow, total = 12): HotbarFit {
  const m = MOBILE_HUD;
  if (flow === "column")
    return hotbarFit({
      available: width - 2 * m.pad,
      slot: m.slot,
      gap: m.slotGap,
      total,
      fixed: 0,
      arrows: 0,
    });
  const tools = m.rowTools * (m.tool + m.toolGap);
  return hotbarFit({
    available: width - 2 * m.orbCol - tools - 2 * m.pad,
    slot: m.slot,
    gap: m.slotGap,
    total,
    fixed: m.edit + m.barGap,
    arrows: 2 * (m.arrow + m.barGap),
  });
}

/**
 * Columns of the section buttons in the console of an upright screen: beside the pad when
 * it shows (`padWidth` CSS px with its margin, 0 without), as many 44 px buttons as fit.
 */
export function consoleColumns(width: number, padWidth: number, count: number): number {
  const m = MOBILE_HUD;
  const room = width - 2 * m.pad - (padWidth > 0 ? padWidth + m.pad : 0);
  const fits = Math.floor((room + m.toolGap) / (m.tool + m.toolGap));
  return Math.max(1, Math.min(count, fits));
}
