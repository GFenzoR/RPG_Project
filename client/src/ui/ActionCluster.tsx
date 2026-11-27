// The action buttons of the touch controls (lote 21, docs/15 "Botones de acción"): a
// cluster of round gothic buttons at the thumb that does not walk. Attack (the nearest
// monster, then the next one), the context action on the tile faced (talk, climb, open,
// loot, read, break, push, use: Game.interact), inspect (the next tap on the map looks),
// chase, and the first hotbar slots with a spell. No hooks: everything comes from GameUi.
// Each button answers any finger (ui/tap.ts), so they work while the other thumb walks.
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import type { ContextKind } from "../input/context-action.ts";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";
import { tapProps } from "./tap.ts";

/** How many hotbar slots the cluster repeats. */
export const QUICK_SLOTS = 2;

/** The icon of each context action. */
export const CONTEXT_ICON: Readonly<Record<ContextKind, IconName>> = {
  talk: "talk",
  attack: "battle",
  climb: "climb",
  open: "inventory",
  loot: "inventory",
  read: "book",
  break: "hammer",
  push: "push",
  use: "hand",
};

/** The first `count` hotbar slots that hold a spell, with their slot number (0-based). */
export function quickSlots(
  hotkeys: readonly (string | undefined)[],
  count: number = QUICK_SLOTS,
): { slot: number; spellId: string }[] {
  const out: { slot: number; spellId: string }[] = [];
  hotkeys.forEach((spellId, slot) => {
    if (spellId && out.length < count) out.push({ slot, spellId });
  });
  return out;
}

type ClusterGame = Pick<
  Game,
  "targetNext" | "interact" | "setInspect" | "setChase" | "castSpell" | "spellCooldown"
>;

export function ActionCluster(props: {
  t: Translate;
  content: Pick<ClientContent, "spells">;
  game: ClusterGame | undefined;
  ui: Pick<GameUi, "target" | "context" | "inspect" | "chase" | "hotkeys">;
}): JSX.Element {
  const { t, game, ui } = props;
  const context = ui.context;
  const attackLabel = t(
    ui.target === undefined ? "client.touch.cluster.attack" : "client.touch.cluster.next",
  );
  const contextLabel = context
    ? t(`client.touch.context.${context}`)
    : t("client.touch.context.none");
  const now = performance.now();
  return (
    <div
      class="touch-cluster"
      role="group"
      aria-label={t("client.touch.cluster.label")}
      data-testid="touch-cluster"
      onContextMenu={(e) => e.preventDefault()}
    >
      {quickSlots(ui.hotkeys).map(({ slot, spellId }) => {
        const name = t(`spell.${spellId}.name`);
        const left = game ? game.spellCooldown(spellId, now) : 0;
        return (
          <button
            key={slot}
            type="button"
            class="touch-action quick"
            data-testid={`touch-quick-${slot + 1}`}
            data-spell={spellId}
            aria-label={name}
            title={name}
            {...tapProps(() => game?.castSpell(spellId))}
          >
            <span class="quick-name" aria-hidden="true">
              {name}
            </span>
            {left > 0 && <span class="cd" style={{ height: `${Math.round(left * 100)}%` }} />}
          </button>
        );
      })}
      <button
        type="button"
        class="touch-action small"
        data-testid="touch-chase"
        aria-pressed={ui.chase}
        aria-label={t("client.fight.chase")}
        title={t("client.fight.chase")}
        {...tapProps(() => game?.setChase(!ui.chase))}
      >
        <Icon name="chase" />
      </button>
      <button
        type="button"
        class="touch-action small"
        data-testid="touch-look"
        aria-pressed={ui.inspect}
        aria-label={t("client.touch.cluster.look")}
        title={t("client.touch.cluster.look")}
        {...tapProps(() => game?.setInspect(!ui.inspect))}
      >
        <Icon name="look" />
      </button>
      <button
        type="button"
        class="touch-action context"
        data-testid="touch-interact"
        data-context={context ?? "none"}
        disabled={context === undefined}
        aria-label={contextLabel}
        title={contextLabel}
        {...tapProps(() => game?.interact())}
      >
        <Icon name={context ? CONTEXT_ICON[context] : "hand"} />
      </button>
      <button
        type="button"
        class="touch-action attack"
        data-testid="touch-attack"
        data-targeting={ui.target === undefined ? undefined : ""}
        aria-label={attackLabel}
        title={attackLabel}
        {...tapProps(() => game?.targetNext())}
      >
        <Icon name={ui.target === undefined ? "battle" : "target"} />
      </button>
    </div>
  );
}
