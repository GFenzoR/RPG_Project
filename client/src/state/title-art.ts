// The title screen's backdrop (docs/17 "Pantalla de entrada"): full-screen pictures behind the
// login, sign up and character screens, shown one at a time with a slow cross-fade. Pure:
// which picture, when, and what changes with reduced motion; ui/TitleBackdrop.tsx draws it.

/** One backdrop picture: a file of assets/title/ (served at /title/<file>, vite/title-art.ts). */
export interface TitleArt {
  id: string;
  file: string;
  /**
   * CSS `object-position` of the cover crop, so the interesting part stays in view: on a
   * wide screen (`wide`) and on a tall one (`tall`, a phone in portrait).
   */
  wide: string;
  tall: string;
}

/** The pictures, in the order the rotation walks them (the first shown is a random one). */
export const TITLE_ART: readonly TitleArt[] = [
  // Harbour: the lantern and the town sit at the right edge, the calm sea at the left.
  { id: "harbour", file: "harbour.webp", wide: "70% 50%", tall: "86% 50%" },
  // Shore: the wreck and the lantern bearer sit at the right, the moon at the left.
  { id: "shore", file: "shore.webp", wide: "60% 50%", tall: "80% 50%" },
  // Cave: the arch opening on the sea sits in the right half; the dark left is empty.
  { id: "cave", file: "cave.webp", wide: "62% 50%", tall: "76% 50%" },
];

/** How long a picture stays, from the end of its fade in to the start of the next one (ms). */
export const TITLE_HOLD_MS = 14000;
/** The cross-fade (ms): only opacity moves. title-art.css repeats it as --title-fade. */
export const TITLE_FADE_MS = 3000;
/** The next picture starts to download this long before it is shown (ms). */
export const TITLE_PRELOAD_LEAD_MS = 6000;

/** The picture the title starts with: a random one (`rand` in [0, 1), like Math.random). */
export function titleStart(count: number, rand: () => number): number {
  if (count <= 1) return 0;
  const r = rand();
  const i = Math.floor(Number.isFinite(r) ? r * count : 0);
  return Math.min(count - 1, Math.max(0, i));
}

/** The picture after `index`, wrapping around. */
export function titleNext(index: number, count: number): number {
  return count <= 0 ? 0 : (index + 1) % count;
}

export interface TitlePlan {
  /** The picture shown first. */
  start: number;
  /** Whether the pictures take turns; false = the one fixed picture, no fade, no timers. */
  rotates: boolean;
}

/**
 * What the title does: with reduced motion (the game's own option or the system's), one
 * fixed random picture and no fade; otherwise it starts at a random picture and rotates,
 * when there is more than one.
 */
export function titlePlan(count: number, reduced: boolean, rand: () => number): TitlePlan {
  return { start: titleStart(count, rand), rotates: !reduced && count > 1 };
}

/** The reduced-motion state: the game's option (`data-motion` on <html>) or the system's. */
export function titleReduced(gameOption: boolean, systemQuery: boolean): boolean {
  return gameOption || systemQuery;
}

/** The URL of a picture. */
export function titleUrl(art: TitleArt): string {
  return `/title/${art.file}`;
}
