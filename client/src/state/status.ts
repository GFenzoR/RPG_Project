// The status tray (docs/17 "Bandeja de estados"): the player's own conditions (balance.yaml,
// T3.2) and the statuses the server adds to PlayerConditions (in_combat, pvp_locked,
// protection_zone: server/internal/session/status.go) and the party's shared experience
// bonus (party_bonus, from PartyUpdate: withPartyBonus), as the tray shows them: in a fixed
// order, each with its kind (a green frame helps, a red one harms), its seconds left and
// whether it flashes because it is about to end. Pure: the view (ui/StatusTray.tsx) only
// draws what this says, and a timer asks nextTrayChange when to draw again.
import type { ConditionView } from "./world.ts";

/** Whether a status helps (green frame) or harms (red frame). */
export type StatusKind = "buff" | "harm";

/**
 * Every condition and status the client knows, in the tray's order: what hurts first (it
 * needs an answer now), then the fight's locks and the place, then what helps. An unknown
 * id (a condition newer than the client) goes last, as a buff, with its key as its name.
 */
export const STATUS_ORDER: readonly string[] = [
  "poison",
  "burning",
  "shocked",
  "slowed",
  "in_combat",
  "pvp_locked",
  "protection_zone",
  "party_bonus",
  "hasted",
  "invisible",
  "keen_eye",
  "well_fed",
];

/** The kind of each known id (frame colour). */
export const STATUS_KIND: Readonly<Record<string, StatusKind>> = {
  poison: "harm",
  burning: "harm",
  shocked: "harm",
  slowed: "harm",
  in_combat: "harm",
  pvp_locked: "harm",
  protection_zone: "buff",
  party_bonus: "buff",
  hasted: "buff",
  invisible: "buff",
  keen_eye: "buff",
  well_fed: "buff",
};

/** The last stretch of a timed status, ms: its icon flashes (never with reduced motion). */
export const FLASH_MS = 5000;

/**
 * The part of a 32x32 ui/status/<id> sprite with the drawing: x, y, width, height in sprite
 * pixels. The same numbers as UI_STATUS_BOX in tools/spritegen/src/recipe.ts (a test checks
 * it).
 */
export const STATUS_BOX = { x: 8, y: 8, w: 16, h: 16 } as const;

/** One icon of the tray. */
export interface TrayEntry {
  id: string;
  kind: StatusKind;
  /** ms to its end, undefined for one with no end (protection_zone). */
  leftMs: number | undefined;
  /** Whole seconds left, rounded up (what the icon writes), undefined with no end. */
  seconds: number | undefined;
  /** Hits left of a damage condition (0 for the others). */
  ticks: number;
  /** The percentage it writes instead of the time (party_bonus), undefined for the others. */
  percent: number | undefined;
  /** In its last FLASH_MS and motion is not reduced. */
  flash: boolean;
}

const rank = (id: string): number => {
  const i = STATUS_ORDER.indexOf(id);
  return i < 0 ? STATUS_ORDER.length : i;
};

/**
 * What the tray shows at `now` (performance.now()): the conditions in STATUS_ORDER (unknown
 * ones last, in the server's order), without the ones whose time ran out (the server's new
 * list may come a moment later), each flashing in its last FLASH_MS unless `reduced`.
 */
export function trayEntries(
  conditions: readonly ConditionView[],
  now: number,
  reduced: boolean,
): TrayEntry[] {
  const out: TrayEntry[] = [];
  conditions.forEach((c) => {
    const leftMs = c.until === undefined ? undefined : c.until - now;
    if (leftMs !== undefined && leftMs <= 0) return;
    out.push({
      id: c.id,
      kind: STATUS_KIND[c.id] ?? "buff",
      leftMs,
      seconds: leftMs === undefined ? undefined : Math.ceil(leftMs / 1000),
      ticks: c.ticks,
      percent: c.percent,
      flash: !reduced && leftMs !== undefined && leftMs <= FLASH_MS,
    });
  });
  // A stable sort: same rank keeps the server's order.
  return out.sort((a, b) => rank(a.id) - rank(b.id));
}

/** The tray id of the party's shared experience bonus. */
export const PARTY_BONUS = "party_bonus";

/**
 * The conditions with the party bonus added while it is active (`percent` > 0, from the
 * last PartyUpdate): an endless entry that writes its percentage. The server does not send
 * it in PlayerConditions: the party window's update already says it.
 */
export function withPartyBonus(
  conditions: readonly ConditionView[],
  percent: number,
): readonly ConditionView[] {
  if (percent <= 0) return conditions;
  return [...conditions, { id: PARTY_BONUS, until: undefined, ticks: 0, percent }];
}

/**
 * ms until something the tray shows changes by itself (a second written on an icon, a
 * flash starting, an icon running out), or undefined when nothing has an end. The flash and
 * the end fall on whole seconds of the time left, so the next second covers them.
 */
export function nextTrayChange(
  conditions: readonly ConditionView[],
  now: number,
): number | undefined {
  let next: number | undefined;
  for (const c of conditions) {
    if (c.until === undefined) continue;
    const left = c.until - now;
    if (left <= 0) continue;
    const step = left % 1000 || 1000;
    next = next === undefined ? step : Math.min(next, step);
  }
  return next;
}

/** A sprite's rectangle in its page image, as the renderer's Atlas.icon gives it. */
export interface StatusIcon {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The CSS variables of a status icon: STATUS_BOX of its 32x32 sprite as a background
 * (ui/StatusTray.tsx scales it up whole). Undefined without the sprite or with one of
 * another size (an automatic placeholder): the tray then writes the name's first letter.
 */
export function statusIconStyle(icon: StatusIcon | undefined): Record<string, string> | undefined {
  if (!icon || icon.width !== 32 || icon.height !== 32) return undefined;
  return {
    "--status-icon": `url(${icon.url})`,
    "--status-pos": `-${icon.x + STATUS_BOX.x}px -${icon.y + STATUS_BOX.y}px`,
  };
}
