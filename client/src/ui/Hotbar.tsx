// Spell hotkey bar F1–F12 (T1.9): click or press the key to cast, pick a spell per slot
// in edit mode. The dimmed part of a slot is the cooldown left (own or group).
// T5.6: on a narrow map it shows only the slots that fit whole, and the rest scroll in
// with the arrows or a swipe (native horizontal scroll with snapping). Every slot stays in
// the DOM, so F1–F12 and the tests see all of them.
// Portrait with the touch pad (`stacked`): the bar sits right of the pad, the slots on one
// line along the bottom and the arrows and the edit button on a line above them, so a
// 412 px phone shows four slots without taking height from the map.
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { hotbarFit, hotbarRoom, sliderEnds, slotsWidth } from "./layout.ts";
import type { HotbarFit } from "./layout.ts";

/** Repaint interval of the cooldown shades, ms. */
const COOLDOWN_REFRESH_MS = 100;
/** Width of each slider arrow (CSS px; .hotbar .page in client.css): a touch target. */
const ARROW_PX = 44;
/** Room left free on each side of the bar (max-width: calc(100% - 1rem) in client.css). */
const SIDE_MARGIN_PX = 8;

interface Measure {
  fit: HotbarFit;
  slot: number;
  gap: number;
}

export function Hotbar(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  /** CSS px kept free on the map's left for the touch pad (T5.6); 0 = none. */
  reserve?: number;
  /** Arrows and edit button on their own line above the slots (portrait with the pad). */
  stacked?: boolean;
}): JSX.Element {
  const { t, game } = props;
  const reserve = props.reserve ?? 0;
  const stacked = props.stacked === true;
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [measure, setMeasure] = useState<Measure | undefined>(undefined);
  const [ends, setEnds] = useState({ prev: false, next: false });
  const total = props.ui.hotkeys.length;
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), COOLDOWN_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // How many slots fit: measured from the map's width and the slot size client.css gives
  // (it changes with the layout), again whenever the map resizes.
  useEffect(() => {
    const el = root.current;
    const host = el?.parentElement;
    if (!el || !host || typeof ResizeObserver === "undefined") return undefined;
    const update = (): void => {
      const ol = list.current;
      const li = ol?.querySelector("li");
      if (!ol || !li) return;
      const gap = parseFloat(getComputedStyle(ol).columnGap) || 0;
      const barGap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const slot = li.getBoundingClientRect().width;
      const edit = el.querySelector<HTMLElement>(".edit")?.getBoundingClientRect().width ?? 0;
      // Stacked, the arrows and the edit button have a line of their own.
      const fit = hotbarFit({
        available: hotbarRoom(host.clientWidth, reserve, SIDE_MARGIN_PX),
        slot,
        gap,
        total,
        fixed: stacked ? 0 : edit + barGap,
        arrows: stacked ? 0 : 2 * (ARROW_PX + barGap),
      });
      setMeasure((m) =>
        m && m.slot === slot && m.gap === gap && m.fit.visible === fit.visible
          ? m
          : { fit, slot, gap },
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(host);
    update();
    return () => observer.disconnect();
  }, [total, reserve, stacked]);

  const slider = measure?.fit.slider === true;
  const onScroll = (): void => {
    const ol = list.current;
    if (ol) setEnds(sliderEnds(ol.scrollLeft, ol.clientWidth, ol.scrollWidth));
  };
  // The arrows follow the scroll position, also right after the slider appears.
  useEffect(onScroll, [slider, measure?.fit.visible, editing]);
  const page = (dir: 1 | -1): void => {
    const ol = list.current;
    if (!ol || !measure) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    ol.scrollBy({
      left: dir * measure.fit.visible * (measure.slot + measure.gap),
      behavior: reduce ? "auto" : "smooth",
    });
  };

  const name = (id: string): string => t(`spell.${id}.name`);
  const prev = slider && (
    <button
      type="button"
      class="page"
      data-testid="hotbar-prev"
      disabled={!ends.prev}
      aria-label={t("client.hotbar.prev")}
      onClick={() => page(-1)}
    >
      ‹
    </button>
  );
  const next = slider && (
    <button
      type="button"
      class="page"
      data-testid="hotbar-next"
      disabled={!ends.next}
      aria-label={t("client.hotbar.next")}
      onClick={() => page(1)}
    >
      ›
    </button>
  );
  const edit = (
    <button
      type="button"
      class="edit"
      aria-pressed={editing}
      title={t("client.hotbar.title")}
      aria-label={t("client.hotbar.title")}
      onClick={() => setEditing(!editing)}
    >
      ✎
    </button>
  );
  const slots = (
    <ol
      ref={list}
      onScroll={onScroll}
      style={
        slider && measure
          ? { maxWidth: `${slotsWidth(measure.fit.visible, measure.slot, measure.gap)}px` }
          : undefined
      }
    >
      {props.ui.hotkeys.map((id, i) => {
        const key = `F${i + 1}`;
        const left = id && game ? game.spellCooldown(id, now) : 0;
        return (
          <li key={key} data-hotkey={key}>
            {editing ? (
              <select
                aria-label={t("client.hotbar.assign", { key })}
                value={id ?? ""}
                onChange={(e) => game?.setHotkey(i, e.currentTarget.value || undefined)}
              >
                <option value="">{t("client.hotbar.none")}</option>
                {props.content.spells.map((s) => (
                  <option key={s.id} value={s.id}>
                    {name(s.id)}
                  </option>
                ))}
              </select>
            ) : (
              <button
                type="button"
                disabled={!id}
                data-spell={id}
                title={
                  id
                    ? left > 0
                      ? t("client.hotbar.cooldown", { name: name(id) })
                      : name(id)
                    : undefined
                }
                onClick={() => id && game?.castSpell(id)}
              >
                <span class="key">{key}</span>
                <span class="spell">{id ? name(id) : t("client.hotbar.empty")}</span>
                {left > 0 && <span class="cd" style={{ height: `${Math.round(left * 100)}%` }} />}
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
  const classes = ["hotbar", slider && "slider", stacked && "stacked"].filter(Boolean).join(" ");
  return (
    <section
      ref={root}
      class={classes}
      data-testid="hotbar"
      data-tutorial="hotbar"
      aria-label={t("client.hotbar.title")}
    >
      {stacked ? (
        <>
          <div class="hotbar-controls">
            {prev}
            {next}
            {edit}
          </div>
          {slots}
        </>
      ) : (
        <>
          {prev}
          {slots}
          {next}
          {edit}
        </>
      )}
    </section>
  );
}
