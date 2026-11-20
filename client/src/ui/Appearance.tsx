// Appearance panel: "Personalizar", the character's own body (docs/02 "Apariencia": the
// pickers and the live figure; free, sent with SetLook when the player saves it, and
// everyone around sees the CreatureLook), then the cosmetics the account owns (T5.7), by
// kind, and which one this character wears. Choosing a cosmetic sends EquipCosmetic, the
// default choice UnequipCosmetic; the server answers with CosmeticsState (and everyone
// around sees CreatureCosmetics). Purchases happen on the website's /shop page, never over
// the game socket.
//
// No hooks: the panel renders as a plain function (ui/Appearance.test.ts walks its tree
// without a DOM; the figure, LookPreview, is the only part with state). The look being
// picked lives in the Game (setLookDraft). Looks only: nothing here changes a game rule.
import type { JSX } from "preact";
import type { ClientContent, CosmeticDef, CosmeticKind } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { desktopServer, isDesktop } from "../net/desktop.ts";
import { NO_EQUIPMENT, sameLook } from "../state/look.ts";
import { dressPlayer, wornFromVisible } from "../render/look.ts";
import { outfitFor } from "../render/cosmetics.ts";
import { LookPickers } from "./LookPickers.tsx";
import { LookPreview } from "./LookPreview.tsx";
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

/**
 * "Personalizar": the pickers over the look being picked (the draft, else the one the
 * server says the character has) and the figure wearing what the character wears. Saving
 * sends SetLook; undoing drops the draft. Nothing without the look choices or a look.
 */
export function Customize(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
}): JSX.Element | null {
  const { t, content, ui } = props;
  const options = content.lookOptions;
  const current = ui.look;
  if (!options || !current) return null;
  const look = ui.lookDraft ?? current;
  const changed = !sameLook(look, current);
  const outfit = outfitFor(ui.cosmetics?.equipped, content);
  // What it wears, but the head piece: a hood or a helmet would hide the hair and the
  // beard being picked (in the game it still does).
  const worn = {
    ...dressPlayer(outfit, wornFromVisible(ui.selfEquipment ?? NO_EQUIPMENT, content.items)).worn,
  };
  delete worn.head;
  return (
    <div class="appearance-customize" data-testid="appearance-customize">
      <h3>{t("client.appearance.customize")}</h3>
      <LookPreview
        t={t}
        look={look}
        worn={worn}
        tables={content.looks}
        scale={3}
        testid="appearance-preview"
      />
      {/* Under the figure, so they show without scrolling the window. */}
      <div class="appearance-actions">
        <button
          type="button"
          data-testid="look-apply"
          disabled={!changed}
          onClick={() => props.game?.applyLook()}
        >
          {t("client.appearance.apply")}
        </button>
        <button
          type="button"
          class="link"
          data-testid="look-revert"
          disabled={!changed}
          onClick={() => props.game?.setLookDraft(undefined)}
        >
          {t("client.appearance.revert")}
        </button>
      </div>
      <LookPickers
        t={t}
        options={options}
        tables={content.looks}
        look={look}
        onChange={(l) => props.game?.setLookDraft(sameLook(l, current) ? undefined : l)}
      />
      <p class="appearance-note muted">{t("client.appearance.customize_free")}</p>
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
      <Customize t={t} content={props.content} game={props.game} ui={ui} />
      <h3 class="appearance-cosmetics">{t("client.appearance.cosmetics")}</h3>
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
