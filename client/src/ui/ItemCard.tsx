// The item card (docs/17 UI-6): name, type, stats, requirements, effects, description and
// marks of an item, as the right-click menu, the hover tooltip and the shop show it. The
// data is state/item-card.ts (pure); this only draws it. No hooks: ItemCard.test.ts walks
// its tree without a DOM.
import type { JSX } from "preact";
import type { Translate } from "../i18n/i18n.ts";
import type { CardEffect, CardRequirement, ItemCardView } from "../state/item-card.ts";

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

/** An atlas icon at 2x (a box twice its size; the icon scaled pixelated: client.css). */
export function BigIcon(props: { icon: IconRect | undefined; class?: string }): JSX.Element {
  const icon = props.icon;
  return (
    <span
      class={`big-icon ${props.class ?? ""}`}
      style={icon ? { width: `${icon.width * 2}px`, height: `${icon.height * 2}px` } : {}}
      aria-hidden="true"
    >
      {icon && <span style={iconStyle(icon)} />}
    </span>
  );
}

/** The item's name with its count ("arrow ×37"). */
export function cardTitle(t: Translate, card: ItemCardView): string {
  const name = card.id ? t(`item.${card.id}.name`) : String(card.itemId);
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

export function ItemCard(props: {
  t: Translate;
  card: ItemCardView;
  /** Show the name line (the menu has it in its own header already). */
  name?: boolean | undefined;
  /** The item's icon, drawn at 2x beside the name. */
  icon?: IconRect | undefined;
}): JSX.Element {
  const { t, card } = props;
  const type = typeText(t, card);
  return (
    <div class="item-card" data-testid="item-card" data-card-item={card.id}>
      {props.name !== false && (
        <div class="card-head">
          {props.icon && <BigIcon icon={props.icon} class="card-icon" />}
          <span class="card-name">{cardTitle(t, card)}</span>
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
