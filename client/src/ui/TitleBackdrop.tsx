// The title screen's backdrop (docs/17 "Pantalla de entrada"): decorative pictures behind the
// login, sign up and character screens, one at a time with a slow cross-fade. The rules
// (which picture, when, reduced motion) are state/title-art.ts; this file only draws them.
// Decorative: no alt text, hidden from screen readers; only opacity animates (title-art.css).
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  TITLE_ART,
  TITLE_FADE_MS,
  TITLE_HOLD_MS,
  TITLE_PRELOAD_LEAD_MS,
  titleNext,
  titlePlan,
  titleReduced,
  titleUrl,
} from "../state/title-art.ts";

/** The system's own reduced-motion request (the game's option comes as a prop). */
function systemReduced(): boolean {
  try {
    return (
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/** Starts downloading and decoding a picture; resolves when it is ready to paint (or failed). */
function preload(index: number): Promise<void> {
  const art = TITLE_ART[index];
  if (!art || typeof Image === "undefined") return Promise.resolve();
  const img = new Image();
  img.src = titleUrl(art);
  return img.decode().catch(() => undefined);
}

interface Shown {
  /** The picture on top, the one the screen is showing. */
  current: number;
  /** The one fading out underneath, until the fade ends. */
  previous: number | null;
}

export function TitleBackdrop(props: {
  /** The game's own "reduced animations" option (docs/17 UI-9). */
  reducedMotion?: boolean | undefined;
}): JSX.Element | null {
  const count = TITLE_ART.length;
  const [shown, setShown] = useState<Shown>(() => ({
    current: titlePlan(count, false, Math.random).start,
    previous: null,
  }));
  // The system's setting can change while the page is open.
  const [system, setSystem] = useState(systemReduced);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const on = (): void => setSystem(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  const reduced = titleReduced(props.reducedMotion === true, system);
  const { rotates } = titlePlan(count, reduced, () => 0);

  const currentRef = useRef(shown.current);
  currentRef.current = shown.current;
  useEffect(() => {
    if (!rotates) {
      // Reduced motion: whatever is on top stays, with nothing fading.
      setShown((s) => (s.previous === null ? s : { current: s.current, previous: null }));
      return undefined;
    }
    let dead = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (ms: number, fn: () => void): void => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };
    const schedule = (from: number): void => {
      const next = titleNext(from, count);
      // Wait, start loading the next picture a little before it is due, then swap it in
      // once it has decoded: the first paint never waits for the others.
      later(TITLE_HOLD_MS + TITLE_FADE_MS - TITLE_PRELOAD_LEAD_MS, () => {
        const ready = preload(next);
        later(TITLE_PRELOAD_LEAD_MS, () => {
          void ready.then(() => {
            if (dead) return;
            setShown({ current: next, previous: from });
            later(TITLE_FADE_MS + 100, () =>
              setShown((s) => ({ current: s.current, previous: null })),
            );
            // The next cycle counts from the start of this fade.
            schedule(next);
          });
        });
      });
    };
    schedule(currentRef.current);
    return () => {
      dead = true;
      for (const id of timers) clearTimeout(id);
    };
  }, [rotates, count]);

  const layers = [shown.previous, shown.current].filter((i): i is number => i !== null);
  return (
    <div class="title-art" aria-hidden="true" data-testid="title-art" data-rotates={rotates}>
      {layers.map((i) => {
        const art = TITLE_ART[i];
        if (!art) return null;
        const top = i === shown.current;
        return (
          <img
            key={art.id}
            src={titleUrl(art)}
            alt=""
            draggable={false}
            decoding="async"
            data-art={art.id}
            data-enter={top && shown.previous !== null ? "" : undefined}
            style={`--pos-wide:${art.wide};--pos-tall:${art.tall}`}
          />
        );
      })}
    </div>
  );
}
