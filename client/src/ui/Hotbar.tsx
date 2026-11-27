// Spell hotkey bar F1–F12 (T1.9): click or press the key to cast, pick a spell per slot
// in edit mode. The dimmed part of a slot is the cooldown left (own or group).
// T5.6: on a narrow map it shows only the slots that fit whole, and the rest scroll in
// with the arrows or a swipe (native horizontal scroll with snapping). Every slot stays in
// the DOM, so F1–F12 and the tests see all of them.
// Upright on the mobile HUD (`stacked`, docs/17 "UI movil"): the slots on one
// line edge to edge and the arrows and the edit button on a line above them, so a
// 390 px phone shows seven slots (layout.ts mobileHotbarFit).
// On the desktop it lives in the bottom bar (ui/HudBar.tsx, docs/17 UI-4), which the
// interface scale zooms: it measures its slots in its own CSS px (cssZoom).
import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { hotbarFit, hotbarRoom, sliderEnds, slotsWidth } from "./layout.ts";
import type { HotbarFit } from "./layout.ts";
import { tapProps } from "./tap.ts";

/** Repaint interval of the cooldown shades, ms. */
const COOLDOWN_REFRESH_MS = 100;
/** How long after a use the slot keeps its flash in the DOM (it plays 150 ms), ms. */
export const FLASH_MS = 400;

/**
 * docs/17 UI-9: whether the slot of `spellId` flashes at `now` (its spell was just used:
 * its key or a click). The flash element plays once; it stays a little in the DOM.
 */
export function flashes(
  cast: { spellId: string; at: number } | undefined,
  spellId: string,
  now: number,
): boolean {
  return cast !== undefined && cast.spellId === spellId && Math.abs(now - cast.at) < FLASH_MS;
}
/** Width of each slider arrow (CSS px; .hotbar .page in client.css): a touch target. */
const ARROW_PX = 44;
/** Room left free on each side of the bar (max-width: calc(100% - 1rem) in client.css). */
const SIDE_MARGIN_PX = 8;

/**
 * The zoom an element is drawn at (CSS `zoom` of its ancestors: the bottom bar takes the
 * interface scale). getBoundingClientRect is in screen px, clientWidth and computed styles
 * in the element's own: divide the first by this to compare them.
 */
export function cssZoom(el: HTMLElement): number {
  const z = (el as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof z === "number" && z > 0) return z;
  const w = el.offsetWidth;
  return w > 0 ? el.getBoundingClientRect().width / w : 1;
}

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
  /** CSS px kept free on each side (none in the desktop bar, which has its own gaps). */
  margin?: number;
}): JSX.Element {
  const { t, game } = props;
  const reserve = props.reserve ?? 0;
  const stacked = props.stacked === true;
  const margin = props.margin ?? SIDE_MARGIN_PX;
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(() => performance.now());
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [measure, setMeasure] = useState<Measure | undefined>(undefined);
  const [ends, setEnds] = useState({ prev: false, next: false });
  const total = props.ui.hotkeys.length;
  const cast = props.ui.cast;
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
      const bar = getComputedStyle(el);
      const barGap = parseFloat(bar.columnGap) || 0;
      // The bar's own padding and border (the desktop belt, docs/17): room the slots lack.
      const frame =
        (parseFloat(bar.paddingLeft) || 0) +
        (parseFloat(bar.paddingRight) || 0) +
        (parseFloat(bar.borderLeftWidth) || 0) +
        (parseFloat(bar.borderRightWidth) || 0);
      // Screen px to the bar's own (the desktop bar is zoomed by the interface scale).
      const k = cssZoom(el);
      const slot = li.getBoundingClientRect().width / k;
      const edit = (el.querySelector<HTMLElement>(".edit")?.getBoundingClientRect().width ?? 0) / k;
      // Stacked, the arrows and the edit button have a line of their own.
      const fit = hotbarFit({
        available: hotbarRoom(host.clientWidth, reserve, margin) - frame,
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
  }, [total, reserve, stacked, margin]);

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
  // What a cast costs (data/spells.yaml): on the slot, in its tooltip and in the picker.
  const manaOf = (id: string): number => props.content.spells.find((s) => s.id === id)?.mana ?? 0;
  const withMana = (id: string): string => {
    const mana = manaOf(id);
    return mana > 0 ? t("client.hotbar.mana", { name: name(id), mana }) : name(id);
  };
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
                    {withMana(s.id)}
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
                      : withMana(id)
                    : undefined
                }
                // Any finger casts (lote 21): the other thumb may be walking on the pad.
                {...tapProps(() => {
                  if (id) game?.castSpell(id);
                })}
              >
                <span class="key">{key}</span>
                {id && manaOf(id) > 0 && (
                  <span class="mana" data-mana={manaOf(id)}>
                    {manaOf(id)}
                  </span>
                )}
                <span class="spell">{id ? name(id) : t("client.hotbar.empty")}</span>
                {left > 0 && <span class="cd" style={{ height: `${Math.round(left * 100)}%` }} />}
                {id && flashes(cast, id, now) && (
                  <span class="flash" key={cast?.at} data-flash="" aria-hidden="true" />
                )}
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
