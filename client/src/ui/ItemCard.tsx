// The item card (docs/17 UI-6): name, type, stats, requirements, effects, description and
// marks of an item, as the right-click menu and the shop show it, and its compact form for
// the hover tooltip (`tip`, the Diablo II style the owner asked for on 2026-11-18: every line
// centred, no icon, the description last). The data is state/item-card.ts (pure); this only
// draws it. No hooks: ItemCard.test.ts walks its tree without a DOM.
import type { JSX } from "preact";
import { instanceName } from "../state/item-name.ts";
import type { Translate } from "../i18n/i18n.ts";
import type { CardEffect, CardRequirement, CardStat, ItemCardView } from "../state/item-card.ts";

/** A sprite's place in the atlas, as Game.itemIcon gives it. */
export interface IconRect {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The CSS of an atlas icon as a background (the inventory's way). */
export function iconStyle(icon: IconRect | undefined): JSX.CSSProperties {
  if (!icon) return {};
  return {
    backgroundImage: `url(${icon.url})`,
    backgroundPosition: `-${icon.x}px -${icon.y}px`,
    width: `${icon.width}px`,
    height: `${icon.height}px`,
  };
}

/**
 * The whole scale of a big icon: 2x, or with `fit` the largest whole scale (at least 1) at
 * which it fits a `fit` px square. An NPC's portrait fits 64 px: a 32 px sprite of Dungeon
 * Crawl at 2x and a 64 px LPC character at 1x take the same box (at 2x the LPC frame was
 * 128 px, and an NPC's dialog no longer fit a phone on its side). With `shrink` a sprite
 * larger than the square is scaled down to it (a fraction) instead of spilling out at 1x:
 * a boss's 96 px corpse in the menu's 64 px box.
 */
export function bigIconScale(icon: IconRect, fit?: number, shrink = false): number {
  if (fit === undefined) return 2;
  const size = Math.max(icon.width, icon.height, 1);
  if (shrink && size > fit) return fit / size;
  return Math.max(1, Math.floor(fit / size));
}

/** An atlas icon at a whole scale (a box that size; the icon scaled pixelated: client.css). */
export function BigIcon(props: {
  icon: IconRect | undefined;
  class?: string;
  /** Fit the icon in a square of this many px instead of drawing it at 2x. */
  fit?: number;
  /** With `fit`: scale a sprite larger than the square down to it. */
  shrink?: boolean;
}): JSX.Element {
  const icon = props.icon;
  const scale = icon ? bigIconScale(icon, props.fit, props.shrink) : 2;
  return (
    <span
      class={`big-icon ${props.class ?? ""}`}
      style={icon ? { width: `${icon.width * scale}px`, height: `${icon.height * scale}px` } : {}}
      aria-hidden="true"
    >
      {icon && (
        <span
          style={{ ...iconStyle(icon), ...(scale === 2 ? {} : { transform: `scale(${scale})` }) }}
        />
      )}
    </span>
  );
}

/** The item's name with its count ("arrow ×37"). */
export function cardTitle(t: Translate, card: ItemCardView): string {
  // A refined instance (the forge, docs/02 "Forja") is named with its level: "+7 sword";
  // the remains of a death after whose they are (state/item-name.ts).
  const name = instanceName(t, card.id ? { id: card.id } : undefined, card.itemId, {
    refine: card.refine?.level,
    remainsOf: card.remainsOf,
    bodyOf: card.bodyOf,
  });
  return card.count > 1 ? t("client.card.count", { name, count: card.count }) : name;
}

/** The type line: "Weapon — sword, one hand". */
export function typeText(t: Translate, card: ItemCardView): string {
  const [kind, ...rest] = card.type.map((k) => t(k));
  if (kind === undefined) return "";
  return rest.length === 0 ? kind : t("client.card.type", { kind, detail: rest.join(", ") });
}

function requirementText(t: Translate, r: CardRequirement): string {
  switch (r.id) {
    case "level":
      return t("client.card.requires.level", { level: r.level });
    case "magic":
      return t("client.card.requires.magic", { level: r.level });
    case "vocations":
      return t("client.card.requires.vocations", {
        vocations: r.vocations.map((v) => t(`vocation.${v}.name`)).join(", "),
      });
  }
}

function effectText(t: Translate, e: CardEffect): string {
  switch (e.id) {
    case "heal_hp":
      return t("client.card.effect.heal_hp", { value: e.value });
    case "heal_mp":
      return t("client.card.effect.heal_mp", { value: e.value });
    case "food":
      return t("client.card.effect.food", { seconds: e.seconds });
    case "rune":
      return t("client.card.effect.rune", { spell: t(`spell.${e.spell}.name`) });
    case "element":
      return t("client.card.effect.element", { element: t(`client.card.element.${e.element}`) });
    case "ammo":
      return t("client.card.effect.ammo", { ammo: t(`client.card.ammo.${e.ammo}`) });
    case "shoots":
      return t("client.card.effect.shoots", { ammo: t(`client.card.ammo.${e.ammo}`) });
  }
}

/**
 * The name's class: a quest item in the quest colour, money in gold (docs/17 UI-6), the rest
 * plain.
 */
export function nameClass(card: ItemCardView): string {
  return card.quest ? "card-name quest" : card.currency ? "card-name coin" : "card-name";
}

/**
 * The attribute's line (docs/02 "Atributos de items"): "+12 maximum health"; for an
 * equipable without one, that it rolls one when it is made or (the market) that each
 * piece has its own; or that the instance's attribute was retired.
 */
export function attributeText(t: Translate, card: ItemCardView): string {
  const a = card.attribute;
  if (!a) return "";
  if ("random" in a) return t("client.card.attribute_random");
  if ("any" in a) return t("client.card.attribute_any");
  if ("retired" in a) return t("client.card.attribute_retired");
  return t(a.text, { value: a.value });
}

/** The refine level's line (the forge, docs/02 "Forja"): "Refined +7: +7 attack". */
export function refineText(t: Translate, card: ItemCardView): string {
  const r = card.refine;
  if (!r) return "";
  return r.gain > 0
    ? t(`client.card.refine.${r.kind}`, { level: r.level, gain: r.gain })
    : t("client.card.refine.level", { level: r.level });
}

function RefineLine(props: { t: Translate; card: ItemCardView }): JSX.Element | null {
  if (!props.card.refine) return null;
  return (
    <p class="card-refine" data-testid="card-refine">
      {refineText(props.t, props.card)}
    </p>
  );
}

/** The attribute's line in its own colour, under the stats (both forms of the card). */
function AttributeLine(props: { t: Translate; card: ItemCardView }): JSX.Element | null {
  const a = props.card.attribute;
  if (!a) return null;
  return (
    <p
      class={"text" in a ? "card-attribute" : "card-attribute random"}
      data-testid="card-attribute"
    >
      {attributeText(props.t, props.card)}
    </p>
  );
}

/** A stat's value as the card writes it ("13", "33.00 oz", "33.00 oz (330.00 oz in total)"). */
function statValue(t: Translate, s: CardStat): string {
  if (s.id !== "weight") return String(s.value);
  const oz = t("client.card.oz", { oz: s.value });
  return s.total === undefined ? oz : `${oz} ${t("client.card.weight_total", { oz: s.total })}`;
}

export function ItemCard(props: {
  t: Translate;
  card: ItemCardView;
  /** Show the name line (the menu has it in its own header already). */
  name?: boolean | undefined;
  /** The item's icon, drawn at 2x beside the name. */
  icon?: IconRect | undefined;
  /** The hover tooltip's compact card (TipCard). */
  tip?: boolean | undefined;
}): JSX.Element {
  const { t, card } = props;
  if (props.tip) return TipCard({ t, card });
  const type = typeText(t, card);
  return (
    <div class="item-card" data-testid="item-card" data-card-item={card.id}>
      {props.name !== false && (
        <div class="card-head">
          {props.icon && <BigIcon icon={props.icon} class="card-icon" />}
          <span class={nameClass(card)}>{cardTitle(t, card)}</span>
        </div>
      )}
      {type && <p class="card-type">{type}</p>}
      {card.stats.length > 0 && (
        <dl class="card-stats">
          {card.stats.map((s) => (
            <div key={s.id} data-stat={s.id}>
              <dt>{t(`client.card.stat.${s.id}`)}</dt>
              <dd>
                {s.id === "weight" ? t("client.card.oz", { oz: s.value }) : s.value}
                {s.total !== undefined && (
                  <span class="card-total"> {t("client.card.weight_total", { oz: s.total })}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {RefineLine({ t, card })}
      {AttributeLine({ t, card })}
      {card.requires.length > 0 && (
        <ul class="card-requires">
          {card.requires.map((r) => (
            <li
              key={r.id}
              data-requirement={r.id}
              class={r.met === false ? "unmet" : r.met === true ? "met" : undefined}
            >
              {requirementText(t, r)}
            </li>
          ))}
        </ul>
      )}
      {card.effects.length > 0 && (
        <ul class="card-effects">
          {card.effects.map((e, i) => (
            <li key={`${e.id}-${i}`}>{effectText(t, e)}</li>
          ))}
        </ul>
      )}
      {card.desc && <p class="card-desc">{t(card.desc)}</p>}
      {card.marks.length > 0 && (
        <ul class="card-marks">
          {card.marks.map((m) => (
            <li key={m}>{t(m)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The card of the hover tooltip (docs/17 UI-6, the Diablo II idea): one centred line each,
 * the name coloured (plain, quest or money), the type, the stats ("Attack: 13"), the
 * requirements (red when unmet), the effects (blue), the marks and the description last,
 * muted. No icon: the item is right under it.
 */
export function TipCard(props: { t: Translate; card: ItemCardView }): JSX.Element {
  const { t, card } = props;
  const type = typeText(t, card);
  return (
    <div class="item-card tip" data-testid="item-card" data-card-item={card.id}>
      <p class={nameClass(card)}>{cardTitle(t, card)}</p>
      {type && <p class="card-type">{type}</p>}
      {card.stats.length > 0 && (
        <ul class="tip-stats">
          {card.stats.map((s) => (
            <li key={s.id} data-stat={s.id}>
              {t("client.card.stat_line", {
                stat: t(`client.card.stat.${s.id}`),
                value: statValue(t, s),
              })}
            </li>
          ))}
        </ul>
      )}
      {RefineLine({ t, card })}
      {AttributeLine({ t, card })}
      {card.requires.length > 0 && (
        <ul class="card-requires">
          {card.requires.map((r) => (
            <li
              key={r.id}
              data-requirement={r.id}
              class={r.met === false ? "unmet" : r.met === true ? "met" : undefined}
            >
              {requirementText(t, r)}
            </li>
          ))}
        </ul>
      )}
      {card.effects.length > 0 && (
        <ul class="card-effects">
          {card.effects.map((e, i) => (
            <li key={`${e.id}-${i}`}>{effectText(t, e)}</li>
          ))}
        </ul>
      )}
      {card.marks.length > 0 && (
        <ul class="card-marks">
          {card.marks.map((m) => (
            <li key={m}>{t(m)}</li>
          ))}
        </ul>
      )}
      {card.desc && <p class="card-desc">{t(card.desc)}</p>}
    </div>
  );
}
