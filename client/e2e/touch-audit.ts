// The touch audit (docs/08 "Auditoría táctil", docs/15): measures what a finger can reach on
// the screen a page shows right now. Used by make ui-preview (--audit, every scene at the
// phone and tablet sizes, no server) and by the mobile flows of e2e/mobile-qa.spec.ts.
//
// What it reports:
// - tap:      an interactive element whose hit area is under 44x44 CSS px (docs/15). The
//             hit area is measured with hit tests around the element, not with its box, so
//             a small glyph with a padded label or a pseudo-element around it counts as
//             what the finger really gets.
// - covered:  (opt-in) a big enough element that another one covers in part.
// - clip:     a button, tab, label or heading whose text does not fit its box.
// - offscreen: an interactive element that sticks out of the viewport.
// - overflow: the page scrolls sideways.
// - unsafe:   an interactive element under a notch or the home bar (the insets given).
import type { Page } from "@playwright/test";

export const MIN_TAP_PX = 44;

export interface TouchFinding {
  kind: "tap" | "covered" | "clip" | "offscreen" | "overflow" | "unsafe";
  /** A short selector-like description: tag, test id, class and text. */
  what: string;
  /** The measured size (tap: the hit area; clip: what the text needs against its box). */
  detail: string;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface AuditOptions {
  /** Findings whose description matches one of these are dropped: say why beside each. */
  allow?: RegExp[];
  /** The safe-area insets emulated on the page, if any. */
  insets?: Insets | undefined;
  /**
   * Also report a big enough element that something else covers in part ("covered"). Off
   * by default: a sheet over the HUD covers buttons on purpose. Turn it on to hunt overlaps.
   */
  covered?: boolean;
  /** Smallest hit area accepted; MIN_TAP_PX by default. */
  min?: number;
}

/** Runs in the page: no closures, everything it needs comes in `arg`. */
function collect(arg: { min: number; insets: Insets | null; covered: boolean }): TouchFinding[] {
  const { min, insets, covered } = arg;
  const out: TouchFinding[] = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const describe = (el: Element): string => {
    const id = el.getAttribute("data-testid");
    const cls = typeof el.className === "string" ? el.className.split(/\s+/)[0] : "";
    const text = (el.getAttribute("aria-label") ?? el.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 28);
    return (
      el.tagName.toLowerCase() +
      (id ? `[${id}]` : cls ? `.${cls}` : "") +
      (text ? ` "${text}"` : "")
    );
  };
  /** Whether a touch at (x, y) reaches `el`: itself, its content, or the label around it. */
  const reaches = (el: Element, x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return false;
    if (hit === el || el.contains(hit)) return true;
    const label = hit.closest("label");
    if (label && (label.contains(el) || (el.id !== "" && label.htmlFor === el.id))) return true;
    // A pseudo-element or padding of a wrapper whose only control is this one.
    const wrap = hit.closest("[data-tap-area]");
    return wrap !== null && wrap.contains(el);
  };
  /** How far the hit area runs from (cx, cy) along one axis, up to min/2 each way. */
  const extent = (el: Element, cx: number, cy: number, dx: number, dy: number): number => {
    let n = 0;
    for (let d = 1; d <= min / 2; d++) {
      if (!reaches(el, cx + dx * d, cy + dy * d)) break;
      n = d;
    }
    return n;
  };
  const selector =
    "button, a[href], input:not([type=hidden]), select, textarea, summary, " +
    "[role=button], [role=tab], [role=slider], [role=switch], [role=checkbox], " +
    "[role=menuitem], [role=option], [tabindex]:not([tabindex='-1'])";
  for (const el of Array.from(document.querySelectorAll(selector))) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    if (style.pointerEvents === "none") continue;
    if ((el as HTMLButtonElement).disabled) continue;
    // A checkbox or a radio is pressed through its label: the label is what is measured.
    const box = el.matches("input[type=checkbox], input[type=radio]")
      ? (el.closest("label") ?? el)
      : el;
    const r = box.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Covered by something else, or scrolled out of its list: not on this screen.
    if (!reaches(el, cx, cy)) continue;
    // A focusable scroll region or a text field's own container is not a tap target.
    if (el.matches("[tabindex]") && !el.matches("button, a, input, select, textarea, summary")) {
      const role = el.getAttribute("role");
      if (!role || role === "dialog" || role === "region" || role === "log" || role === "tabpanel")
        continue;
    }
    const w = extent(el, cx, cy, -1, 0) + extent(el, cx, cy, 1, 0) + 1;
    const h = extent(el, cx, cy, 0, -1) + extent(el, cx, cy, 0, 1) + 1;
    // The walk stops at min/2 each way: a full target measures min + 1. One px of grace:
    // boxes sit on fractions of a pixel under a CSS zoom or a 2.6x screen.
    const small = w < min - 1 || h < min - 1;
    const boxSmall = r.width < min - 1 || r.height < min - 1;
    /** Cut by the edge of a list it scrolls in: the rest is a swipe away. */
    const cut = ((): boolean => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (!/(auto|scroll|hidden|clip)/.test(o.overflowX + o.overflowY)) continue;
        const b = p.getBoundingClientRect();
        if (
          r.left < b.left - 1 ||
          r.top < b.top - 1 ||
          r.right > b.right + 1 ||
          r.bottom > b.bottom + 1
        )
          return true;
      }
      return false;
    })();
    if (small && !cut && (boxSmall || covered))
      out.push({
        kind: boxSmall ? "tap" : "covered",
        what: describe(el),
        detail: `hit ${w}x${h}, box ${Math.round(r.width)}x${Math.round(r.height)}`,
      });
    const pageScrolls = document.documentElement.scrollHeight > vh + 1;
    const outside =
      r.left < -1 || r.right > vw + 1 || (!pageScrolls && (r.top < -1 || r.bottom > vh + 1));
    if (outside) {
      // Inside a scroller the rest is a swipe away: only what nothing scrolls counts.
      let scrolls = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p);
        if (/(auto|scroll)/.test(o.overflowX + o.overflowY)) {
          scrolls = true;
          break;
        }
      }
      if (!scrolls)
        out.push({
          kind: "offscreen",
          what: describe(el),
          detail: `${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in ${vw}x${vh}`,
        });
    }
    if (insets) {
      const under =
        cy < insets.top || cy > vh - insets.bottom || cx < insets.left || cx > vw - insets.right;
      if (under)
        out.push({
          kind: "unsafe",
          what: describe(el),
          detail: `centre ${Math.round(cx)},${Math.round(cy)} inside the insets`,
        });
    }
  }
  const texts = "button, [role=tab], label, h1, h2, h3, h4, summary, th, legend";
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(texts))) {
    if (el.childElementCount > 0 && !el.matches("button, [role=tab], summary")) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) continue;
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const wide = el.scrollWidth - el.clientWidth;
    const tall = el.scrollHeight - el.clientHeight;
    // A scroller is meant to hold more than it shows.
    if (/(auto|scroll)/.test(style.overflowX + style.overflowY)) continue;
    if (wide > 1 || tall > 2)
      out.push({
        kind: "clip",
        what: describe(el),
        detail: `needs ${el.scrollWidth}x${el.scrollHeight}, has ${el.clientWidth}x${el.clientHeight}`,
      });
  }
  const doc = document.documentElement;
  if (doc.scrollWidth > vw + 1)
    out.push({ kind: "overflow", what: "html", detail: `${doc.scrollWidth} wide in ${vw}` });
  return out;
}

/** The findings of the screen as it is now, without the allowed ones. */
export async function touchAudit(page: Page, options: AuditOptions = {}): Promise<TouchFinding[]> {
  const found = await page.evaluate(collect, {
    min: options.min ?? MIN_TAP_PX,
    insets: options.insets ?? null,
    covered: options.covered ?? false,
  });
  const allow = options.allow ?? [];
  const seen = new Set<string>();
  return found.filter((f) => {
    const line = `${f.kind} ${f.what}`;
    if (seen.has(line)) return false;
    seen.add(line);
    return !allow.some((re) => re.test(line));
  });
}

/** One line per finding, for an assertion message or a report. */
export function formatFindings(findings: TouchFinding[]): string {
  return findings.map((f) => `${f.kind}: ${f.what}: ${f.detail}`).join("\n");
}
