// Appearance panel (T5.7): the cosmetics the account owns, by kind, and which one this
// character wears. Choosing one sends EquipCosmetic, the default choice UnequipCosmetic;
// the server answers with CosmeticsState (and everyone around sees CreatureCosmetics).
// Purchases happen on the website's /shop page, never over the game socket.
//
// No hooks: the panel renders as a plain function (ui/Appearance.test.ts walks its tree
// without a DOM). Looks only: nothing here changes a game rule (docs/02).
import type { JSX } from "preact";
import type { ClientContent, CosmeticDef, CosmeticKind } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { desktopServer, isDesktop } from "../net/desktop.ts";
import {
  COSMETIC_KINDS,
  KIND_DEFAULT_KEY,
  KIND_TITLE_KEY,
  cosmeticDescKey,
  cosmeticNameKey,
  equippedOf,
  ownedByKind,
} from "../render/cosmetics.ts";

/** The website's shop page: a link in the browser, an address to open in the desktop app. */
function ShopLink(props: { t: Translate }): JSX.Element {
  const { t } = props;
  if (isDesktop()) {
    const origin = desktopServer()?.origin ?? "";
    return (
      <p class="appearance-shop muted" data-testid="appearance-shop-desktop">
        {t("client.appearance.shop_desktop", { url: `${origin}/shop` })}
      </p>
    );
  }
  return (
    <a
      class="appearance-shop"
      href="/shop"
      target="_blank"
      rel="noopener"
      data-testid="appearance-shop"
    >
      {t("client.appearance.open_shop")}
    </a>
  );
}

function Choice(props: {
  t: Translate;
  label: string;
  hint: string;
  pressed: boolean;
  swatch?: string | undefined;
  testid: string;
  onChoose(): void;
}): JSX.Element {
  const { t } = props;
  return (
    <li>
      <button
        type="button"
        class="appearance-choice"
        aria-pressed={props.pressed}
        title={props.hint}
        data-cosmetic={props.testid}
        onClick={() => {
          if (!props.pressed) props.onChoose();
        }}
      >
        {props.swatch && (
          <span class="swatch" aria-hidden="true" style={{ background: props.swatch }} />
        )}
        <span class="cname">{props.label}</span>
        {props.pressed && <span class="badge">{t("client.appearance.equipped")}</span>}
      </button>
    </li>
  );
}

function KindSection(props: {
  t: Translate;
  game: Game | undefined;
  kind: CosmeticKind;
  owned: CosmeticDef[];
  equipped: string;
}): JSX.Element {
  const { t, kind, equipped } = props;
  const wearing = props.owned.some((c) => c.id === equipped) ? equipped : "";
  return (
    <div class="appearance-kind" data-kind={kind}>
      <h3>{t(KIND_TITLE_KEY[kind])}</h3>
      <ul>
        <Choice
          t={t}
          label={t(KIND_DEFAULT_KEY[kind])}
          hint={t("client.appearance.unequip")}
          pressed={wearing === ""}
          testid={`default-${kind}`}
          onChoose={() => props.game?.unequipCosmetic(kind)}
        />
        {props.owned.map((c) => (
          <Choice
            key={c.id}
            t={t}
            label={t(cosmeticNameKey(c.id))}
            hint={t(cosmeticDescKey(c.id))}
            pressed={wearing === c.id}
            swatch={kind === "outfit_color" ? c.tint : undefined}
            testid={c.id}
            onChoose={() => props.game?.equipCosmetic(c.id)}
          />
        ))}
      </ul>
    </div>
  );
}

export function AppearancePanel(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element {
  const { t, ui } = props;
  const state = ui.cosmetics;
  const owned = ownedByKind(state?.owned ?? [], props.content);
  const kinds = COSMETIC_KINDS.filter((k) => owned[k].length > 0);
  return (
    <section
      class="appearance"
      data-testid="appearance-panel"
      aria-label={t("client.appearance.title")}
    >
      <h2>{t("client.appearance.title")}</h2>
      {state && (
        <p class="appearance-balance" data-testid="appearance-balance">
          {t("client.appearance.balance", {
            amount: t("premium.amount", { count: state.balance }),
          })}
        </p>
      )}
      {kinds.length === 0 ? (
        <p class="empty">{t("client.appearance.empty")}</p>
      ) : (
        kinds.map((k) => (
          <KindSection
            key={k}
            t={t}
            game={props.game}
            kind={k}
            owned={owned[k]}
            equipped={equippedOf(state?.equipped, k)}
          />
        ))
      )}
      <p class="appearance-note muted">{t("client.appearance.looks_only")}</p>
      <ShopLink t={t} />
    </section>
  );
}
