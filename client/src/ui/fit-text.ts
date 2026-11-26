// A name on one line of the interface that never shows cut (docs/17 UI-3 "Nombres", the
// owner: "nunca se deben mostrar incompletos"). The map's labels shrink a long name
// (render/labels.ts fitName); this is the same rule for the DOM: the name plate over the
// experience bar, the compact header and the title of the action menu. When the text is
// wider than its room the font shrinks to fit, down to the readable floor of the labels
// (NAME_MIN_PX); a name that does not fit even there breaks onto more lines
// (`data-fit="wrap"`, see the style sheets) instead of losing letters. No ellipsis ever.
//
// The fitting is a pure function over the three things it needs from an element (its
// inline font size, how wide its text is and how wide its box is), so it is tested without
// a browser; `fitTextRef` is the Preact ref that runs it on a real element and again when
// its room changes.
import { NAME_MIN_PX } from "../render/label-style.ts";

/** The least font size a fitted name is drawn at, CSS px: the floor of the map's labels. */
export const FIT_MIN_PX = NAME_MIN_PX;

/** What fitText reads and writes of an element. */
export interface FitElement {
  style: { fontSize: string };
  /** Width of the text on one line, CSS px (rounded by the browser). */
  readonly scrollWidth: number;
  /** Width of the box the text has to fit in, CSS px. */
  readonly clientWidth: number;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** The passes fitText makes at most: the width of a text is nearly linear in its size. */
const MAX_PASSES = 6;

/**
 * Fits the text of `el` in its box: back to the style sheet's size (`basePx` reads it,
 * with the inline size cleared), then smaller while the text is wider than the box, never
 * under `minPx`. Returns the size it left (the base when the text fits as it is) and
 * whether the text still did not fit at the floor, in which case the element is marked
 * `data-fit="wrap"` so the style sheet lets it break onto more lines.
 */
export function fitText(
  el: FitElement,
  basePx: (el: FitElement) => number,
  minPx: number = FIT_MIN_PX,
): { fontPx: number; wrapped: boolean } {
  el.style.fontSize = "";
  el.removeAttribute("data-fit");
  let px = basePx(el);
  if (!(px > 0)) return { fontPx: 0, wrapped: false };
  for (let pass = 0; pass < MAX_PASSES && el.scrollWidth > el.clientWidth && px > minPx; pass++) {
    // Tenths of a pixel, rounded down: the browser rounds scrollWidth, so a size that fits
    // "exactly" can still be a hair too wide. At least a tenth smaller each pass.
    const scaled = Math.floor(((px * el.clientWidth) / el.scrollWidth) * 10) / 10;
    px = Math.max(minPx, Math.min(scaled, Math.round(px * 10 - 1) / 10));
    el.style.fontSize = `${px}px`;
  }
  const wrapped = el.scrollWidth > el.clientWidth;
  if (wrapped) el.setAttribute("data-fit", "wrap");
  return { fontPx: px, wrapped };
}

// ---- The browser side --------------------------------------------------------------------

const watched = new Set<HTMLElement>();
let observer: ResizeObserver | undefined;
let frame = 0;
let listening = false;

const cssFontPx = (el: FitElement): number =>
  Number.parseFloat(getComputedStyle(el as unknown as Element).fontSize);

/** Fits every watched name again; the ones that left the page are forgotten. */
function refitAll(): void {
  frame = 0;
  for (const el of watched) {
    if (!el.isConnected) {
      watched.delete(el);
      observer?.unobserve(el);
      continue;
    }
    fitText(el, cssFontPx);
  }
}

/** On the next frame, once: a ResizeObserver callback must not resize what it observes. */
function schedule(): void {
  if (frame !== 0) return;
  frame = requestAnimationFrame(refitAll);
}

function listen(): void {
  if (listening) return;
  listening = true;
  // The room of a name that already fits can grow without its own box changing (a wider
  // window): the window's resize covers what the observer cannot see.
  window.addEventListener("resize", schedule);
  // The title font arrives after the first paint, and is wider or narrower than the
  // fallback the name was first measured with.
  void document.fonts?.ready.then(schedule);
  if (typeof ResizeObserver !== "undefined") observer = new ResizeObserver(schedule);
}

/**
 * The ref of an element whose text is a name: `<span class="vname" key={name}
 * ref={fitTextRef}>`. The element is fitted at once (before the first paint) and again
 * when its box or the window changes. Key the element by its text: a new text is a new
 * element, fitted from the style sheet's size.
 */
export function fitTextRef(el: HTMLElement | null): void {
  if (!el || typeof window === "undefined") return;
  listen();
  watched.add(el);
  observer?.observe(el);
  fitText(el, cssFontPx);
}
