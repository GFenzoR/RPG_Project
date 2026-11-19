// The forge window (docs/02 "Forja"): a tab of the anvil's station window. The player picks
// one of its items it sees (equipped or in an open container), and the window shows the
// level now and next, what that level adds, the success chance in big text, the stones,
// the gold and, where a failure can break the item, the protection toggle; from there the
// attempt asks to confirm, with the risk in red. The result of the last attempt stays on
// top. ForgeBody is a plain function (no hooks: ui/Forge.test.ts walks its tree); ForgePanel
// keeps the choice. The server checks everything again on Refine.
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { ClientContent, ForgeRules } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import {
  attemptStep,
  chosenPiece,
  forgeCandidates,
  forgeView,
  refineInFlight,
  refinedName,
  resultKey,
  sameLoc,
} from "../state/forge.ts";
import type { ForgeCandidate, ForgeView, RefineState } from "../state/forge.ts";
import { tipMods } from "../state/mods.ts";
import { locKey as placeKey } from "../state/items.ts";
import type { StationState } from "../state/recipes.ts";
import { BigIcon } from "./ItemCard.tsx";

/** How long the result of an attempt stays on top of the window (ms). */
export const RESULT_MS = 8000;

interface BodyProps {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  candidates: readonly ForgeCandidate[];
  selected: ForgeCandidate | undefined;
  view: ForgeView | undefined;
  /** The toggle's state (what the attempt does is view.protect). */
  protect: boolean;
  confirming: boolean;
  /** An attempt was sent and its answer has not come (refineInFlight): no other one goes. */
  busy: boolean;
  /** The last attempt, when it is still fresh. */
  result: RefineState | undefined;
  onPick: (c: ForgeCandidate) => void;
  onProtect: (on: boolean) => void;
  onAttempt: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

function itemName(t: Translate, content: ClientContent, itemId: number, level?: number): string {
  const def = content.items[itemId];
  return refinedName(t, def ? t(`item.${def.id}.name`) : String(itemId), level);
}

function SmallIcon(props: { game: Game | undefined; itemId: number }): JSX.Element {
  const icon = props.game?.itemIcon(props.itemId);
  const style: JSX.CSSProperties = icon
    ? {
        backgroundImage: `url(${icon.url})`,
        backgroundPosition: `-${icon.x}px -${icon.y}px`,
        width: `${icon.width}px`,
        height: `${icon.height}px`,
      }
    : {};
  return <span class={icon ? "item" : "item missing"} style={style} aria-hidden="true" />;
}

/** The forge window's content. */
export function ForgeBody(p: BodyProps): JSX.Element {
  const { t, content, game, view, selected } = p;
  const stat = view ? t(`client.forge.gain.${view.gain.kind}`) : "";
  return (
    <div class="forge" data-testid="forge">
      {p.result && (
        <p
          class={`forge-result ${p.result.outcome}`}
          data-testid="forge-result"
          data-outcome={p.result.outcome}
          role="status"
        >
          <strong>{t(resultKey(p.result))}</strong>{" "}
          {t(`client.forge.result.${p.result.outcome}_line`, {
            item: itemName(t, content, p.result.itemId, p.result.from),
            level: p.result.level,
          })}
        </p>
      )}
      <div class="forge-top">
        <div class="forge-slot" data-testid="forge-slot" data-empty={selected ? undefined : ""}>
          {selected ? (
            <span
              data-tip-item={selected.itemId}
              data-tip-count={1}
              data-tip-mods={tipMods(selected.mods)}
            >
              <BigIcon icon={game?.itemIcon(selected.itemId)} fit={64} />
            </span>
          ) : (
            <span class="forge-slot-hint">{t("client.forge.slot")}</span>
          )}
        </div>
        {selected && view ? (
          <div class="forge-head">
            <strong class="forge-name">{itemName(t, content, selected.itemId, view.level)}</strong>
            {view.level >= view.top ? (
              <p class="forge-levels" data-testid="forge-levels">
                {t("client.forge.top", { level: view.top })}
              </p>
            ) : (
              <>
                <p class="forge-levels" data-testid="forge-levels">
                  {t("client.forge.levels", { from: view.level, to: view.next })}
                </p>
                <p class="forge-gain" data-testid="forge-gain">
                  {t("client.forge.gain", { stat, now: view.gain.now, next: view.gain.next })}
                </p>
              </>
            )}
          </div>
        ) : (
          <p class="forge-head empty">{t("client.forge.pick")}</p>
        )}
        {view && view.level < view.top && (
          <div
            class={view.risky ? "forge-chance risky" : "forge-chance"}
            data-testid="forge-chance"
          >
            <span class="pct">{t("client.forge.chance_pct", { pct: view.chance })}</span>
            <span class="label">
              {view.bonus > 0
                ? t("client.forge.chance_bonus", { bonus: view.bonus })
                : t("client.forge.chance")}
            </span>
          </div>
        )}
      </div>
      {view && view.level < view.top && (
        <>
          <ul class="forge-cost" data-testid="forge-cost">
            <li class={view.stone.have < view.stone.need ? "lacking" : undefined} data-cost="stone">
              <SmallIcon game={game} itemId={view.stone.itemId} />
              {t("client.forge.stones", {
                count: view.stone.need,
                item: itemName(t, content, view.stone.itemId),
                have: view.stone.have,
              })}
            </li>
            <li class={view.money < view.gold ? "lacking" : undefined} data-cost="gold">
              {t("client.forge.gold", { price: view.gold, have: view.money })}
            </li>
          </ul>
          {view.risky && view.protection.have > 0 && (
            <label class="forge-protect" data-testid="forge-protect">
              <input
                type="checkbox"
                checked={p.protect}
                onChange={(e) => p.onProtect((e.currentTarget as HTMLInputElement).checked)}
              />
              <SmallIcon game={game} itemId={view.protection.itemId} />
              {t("client.forge.protect", {
                item: itemName(t, content, view.protection.itemId),
                have: view.protection.have,
              })}
            </label>
          )}
          {view.risky && (
            <p
              class={view.protect ? "forge-risk protected" : "forge-risk"}
              data-testid="forge-risk"
            >
              {view.protect ? t("client.forge.risk_protected") : t("client.forge.risk")}
            </p>
          )}
          {p.confirming ? (
            <div class="forge-confirm" role="alertdialog" data-testid="forge-confirm">
              <p class="danger">
                {view.protect
                  ? t("client.forge.confirm_protected", {
                      item: itemName(t, content, view.itemId, view.level),
                      chance: view.chance,
                    })
                  : t("client.forge.confirm", {
                      item: itemName(t, content, view.itemId, view.level),
                      chance: view.chance,
                    })}
              </p>
              <div class="forge-actions">
                <button
                  type="button"
                  class="danger"
                  data-testid="forge-go"
                  disabled={p.busy}
                  onClick={p.onConfirm}
                >
                  {t("client.forge.go", { level: view.next })}
                </button>
                <button type="button" data-testid="forge-cancel" onClick={p.onCancel}>
                  {t("client.forge.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <div class="forge-actions">
              <button
                type="button"
                data-testid="forge-attempt"
                disabled={view.blocks.length > 0 || p.busy}
                aria-busy={p.busy}
                onClick={p.onAttempt}
              >
                {t("client.forge.attempt", { level: view.next })}
              </button>
            </div>
          )}
        </>
      )}
      <div class="forge-pick">
        <p class="forge-pick-title">{t("client.forge.yours")}</p>
        {p.candidates.length === 0 ? (
          <p class="empty">{t("client.forge.none")}</p>
        ) : (
          <ul>
            {p.candidates.map((c) => {
              const on = selected !== undefined && sameLoc(c.loc, selected.loc);
              return (
                <li key={locKey(c)}>
                  <button
                    type="button"
                    class={on ? "forge-item on" : "forge-item"}
                    aria-pressed={on}
                    aria-label={itemName(t, content, c.itemId, c.mods?.refine)}
                    data-forge-item={c.itemId}
                    data-tip-item={c.itemId}
                    data-tip-count={1}
                    data-tip-mods={tipMods(c.mods)}
                    onClick={() => p.onPick(c)}
                  >
                    <SmallIcon game={game} itemId={c.itemId} />
                    {(c.mods?.refine ?? 0) > 0 && (
                      <span class="forge-plus">
                        {t("client.forge.plus", { level: c.mods?.refine ?? 0 })}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A stable key of a candidate's place. */
export function locKey(c: ForgeCandidate): string {
  return placeKey(c.loc);
}

/** The forge tab of the anvil's window: the choice, the toggle and the confirm step. */
export function ForgePanel(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
  rules: ForgeRules;
  station: StationState;
}): JSX.Element {
  const { t, content, game, ui, rules, station } = props;
  const [pick, setPick] = useState<ForgeCandidate | undefined>(undefined);
  const [protect, setProtect] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // When the last attempt went (performance.now(); 0: none): its answer ends the wait.
  const [sentAt, setSentAt] = useState(0);
  // When the first attempt on this choice went (0: none yet): the results since then move
  // the chosen piece's level, or let it go when it broke.
  const [since, setSince] = useState(0);
  const containers = ui.backpack ? [ui.backpack, ...ui.containers] : ui.containers;
  const candidates = forgeCandidates(content, ui.inventory, containers, ui.pockets.items);
  // The chosen piece, as it is now (moved, broken or replaced in its place: none).
  const selected = chosenPiece(candidates, pick, ui.refine, since);
  const smithing = ui.skills.find((s) => s.id === rules.smithingBonus.skill)?.level ?? 0;
  const view = selected
    ? forgeView(rules, content, station, selected, smithing, protect)
    : undefined;
  const now = performance.now();
  const result =
    ui.refine && ui.refine.at >= sentAt && now - ui.refine.at < RESULT_MS ? ui.refine : undefined;
  // One attempt at a time: with lag, a second click before the result (after a break the
  // piece is gone) would name a piece the player may not have meant (docs/02 "Forja").
  const busy = refineInFlight(sentAt, ui.refine, ui.log, now);
  const send = (): void => {
    if (!selected || !view || view.blocks.length > 0 || busy) return;
    const at = performance.now();
    setConfirming(false);
    setSentAt(at);
    if (since === 0) setSince(at);
    game?.refine(selected, view.protect);
  };
  return (
    <ForgeBody
      t={t}
      content={content}
      game={game}
      candidates={candidates}
      selected={selected}
      view={view}
      protect={protect}
      confirming={confirming && view !== undefined && view.risky}
      busy={busy}
      result={result}
      onPick={(c) => {
        setPick(c);
        setSince(0);
        setConfirming(false);
      }}
      onProtect={setProtect}
      onAttempt={() => {
        if (view && attemptStep(view) === "confirm") setConfirming(true);
        else send();
      }}
      onConfirm={send}
      onCancel={() => setConfirming(false)}
    />
  );
}
