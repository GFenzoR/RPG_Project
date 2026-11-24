// The quest log, "Misiones" (docs/02 "Diario de misiones"): a window of the toolbar (L) on
// desktop, a tab of the panel on phones. Three tabs: the quests in progress (name, chapter,
// the current step's text and the kills counted), the milestones apart (docs/02 "Quests de
// hito": each one's requirements with a met or unmet mark, before it is taken too) and the
// finished ones (a task shows when it is back, a milestone the title it gave). QuestsBody has no hooks (ui/Quests.test.ts walks its tree); QuestsPanel
// keeps the open tab and ticks once a second while a task cools down.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ClientContent } from "../content-types.ts";
import type { Translate } from "../i18n/i18n.ts";
import { cooldownLeft, questTabs, timeLeft } from "../state/quests.ts";
import type { MilestoneView, QuestEntryView, QuestLogView } from "../state/quests.ts";
import { itemName } from "./Inventory.tsx";

/** The tabs of the window, in order. */
export const QUEST_TABS = ["active", "milestones", "finished"] as const;
export type QuestTab = (typeof QUEST_TABS)[number];

const TAB_KEY: Record<QuestTab, string> = {
  active: "client.quests.tab_active",
  milestones: "client.quests.tab_milestones",
  finished: "client.quests.tab_finished",
};

/** The label under a quest's name: its chapter, or a task, or a side quest. */
function questKind(t: Translate, e: QuestEntryView): string {
  if (e.milestone) return t("client.quests.milestone");
  if (e.chapter > 0) return t("client.quests.chapter", { chapter: e.chapter });
  return t(e.repeatable ? "client.quests.task" : "client.quests.side");
}

/** One requirement of a milestone with its mark (met or not, for this character). */
function Req(props: {
  t: Translate;
  met: boolean | undefined;
  text: string;
  kind: string;
}): JSX.Element {
  const { t, met } = props;
  return (
    <li
      class="quest-req"
      data-req={props.kind}
      data-met={met === undefined ? undefined : String(met)}
    >
      {met !== undefined && (
        <span class="quest-mark" aria-label={t(met ? "client.quests.met" : "client.quests.unmet")}>
          {met ? "\u2713" : "\u2717"}
        </span>
      )}
      <span>{props.text}</span>
    </li>
  );
}

/** What a milestone asks: level, gear, players (and vocations), each with its mark. */
function MilestoneReqs(props: {
  t: Translate;
  m: MilestoneView;
  content: ClientContent | undefined;
}): JSX.Element {
  const { t, m } = props;
  const gear =
    m.gearItem !== 0
      ? t(m.gearEquipped ? "client.quests.req_gear_worn" : "client.quests.req_gear", {
          item: props.content ? itemName(props.content, t, m.gearItem) : String(m.gearItem),
        })
      : m.gearWeapon !== ""
        ? t("client.quests.req_weapon", { weapon: t(`client.quests.weapon.${m.gearWeapon}`) })
        : "";
  return (
    <ul class="quest-reqs" data-testid="quest-reqs">
      <Req
        t={t}
        kind="level"
        met={m.levelMet}
        text={t("client.quests.req_level", { level: m.level })}
      />
      {gear !== "" && <Req t={t} kind="gear" met={m.gearMet} text={gear} />}
      {m.vocations.length > 0 ? (
        <Req
          t={t}
          kind="players"
          met={m.vocationMet}
          text={t("client.quests.req_vocations", {
            count: m.players,
            vocations: m.vocations.map((v) => t(`vocation.${v}.name`)).join(", "),
          })}
        />
      ) : (
        <Req
          t={t}
          kind="players"
          met={undefined}
          text={t(m.players > 1 ? "client.quests.req_players" : "client.quests.req_alone", {
            count: m.players,
          })}
        />
      )}
    </ul>
  );
}

function QuestItem(props: {
  t: Translate;
  e: QuestEntryView;
  serverNow: number;
  content: ClientContent | undefined;
  tracked: boolean;
  onTrack: ((id: string) => void) | undefined;
}): JSX.Element {
  const { t, e } = props;
  const left = cooldownLeft(e, props.serverNow);
  let status: JSX.Element;
  if (e.state === "open") {
    status = (
      <p class="quest-step" data-testid="quest-open">
        {t("client.quests.not_started")}
      </p>
    );
  } else if (e.state === "active") {
    status = (
      <>
        {e.stepText !== "" && (
          <p class="quest-step" data-testid="quest-step">
            {t(e.stepText)}
          </p>
        )}
        {e.killsNeeded > 0 && (
          <div
            class="quest-kills"
            data-testid="quest-kills"
            title={t("client.quests.kills_title", { count: e.kills, total: e.killsNeeded })}
          >
            <span class="quest-bar" aria-hidden="true">
              <span style={{ transform: `scaleX(${e.kills / e.killsNeeded})` }} />
            </span>
            <span class="quest-count">
              {t("client.quests.kills", { count: e.kills, total: e.killsNeeded })}
            </span>
          </div>
        )}
      </>
    );
  } else if (e.repeatable && left > 0) {
    const tl = timeLeft(left);
    status = (
      <p class="quest-wait" data-testid="quest-cooldown">
        {t("client.quests.available_in", { time: t(tl.key, tl.params) })}
      </p>
    );
  } else if (e.milestone) {
    status = (
      <p class="quest-done quest-title" data-testid="quest-title">
        {t("client.quests.title_earned", { title: t(e.milestone.title) })}
      </p>
    );
  } else {
    status = (
      <p class={e.repeatable ? "quest-done again" : "quest-done"} data-testid="quest-done">
        {t(e.repeatable ? "client.quests.available_again" : "client.quests.done")}
      </p>
    );
  }
  return (
    <li
      class={e.milestone ? "quest milestone" : "quest"}
      data-quest={e.id}
      data-state={e.state}
      data-ready={left > 0 ? undefined : ""}
    >
      <div class="quest-head">
        <span class="quest-name">{t(e.name)}</span>
        <span class="quest-kind">{questKind(t, e)}</span>
      </div>
      {status}
      {e.state === "active" && props.onTrack && (
        <button
          type="button"
          class="quest-track"
          data-testid="quest-track"
          aria-pressed={props.tracked}
          onClick={() => props.onTrack?.(props.tracked ? "" : e.id)}
        >
          {t(props.tracked ? "client.quests.untrack" : "client.quests.track")}
        </button>
      )}
      {e.milestone && e.state !== "done" && (
        <MilestoneReqs t={t} m={e.milestone} content={props.content} />
      )}
    </li>
  );
}

/**
 * The window's body at serverNow (server Unix ms): the tabs with their counts and the
 * quests of the open one.
 */
export function QuestsBody(props: {
  t: Translate;
  log: QuestLogView | undefined;
  tab: QuestTab;
  onTab(tab: QuestTab): void;
  serverNow: number;
  /** The client's content (a milestone's gear item by name); without it, its numeric id. */
  content?: ClientContent | undefined;
  /** The quest tracked on the minimap ("": none) and how to track one ("" stops). */
  tracked?: string | undefined;
  onTrack?: ((id: string) => void) | undefined;
}): JSX.Element {
  const { t, tab } = props;
  const tabs = questTabs(props.log, props.serverNow);
  const shown = tabs[tab];
  return (
    <section
      class="quests"
      data-testid="quests"
      data-tab={tab}
      aria-label={t("client.quests.title")}
    >
      <div class="quest-tabs" role="tablist" aria-label={t("client.quests.tabs")}>
        {QUEST_TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-quest-tab={id}
            aria-selected={tab === id}
            onClick={() => props.onTab(id)}
          >
            {t(TAB_KEY[id], { count: tabs[id].length })}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p class="empty" data-testid="quests-empty">
          {t(
            tab === "active"
              ? "client.quests.none_active"
              : tab === "milestones"
                ? "client.quests.none_milestones"
                : "client.quests.none_finished",
          )}
        </p>
      ) : (
        <ul class="quest-list" key={tab}>
          {shown.map((e) => (
            <QuestItem
              key={e.id}
              t={t}
              e={e}
              serverNow={props.serverNow}
              content={props.content}
              tracked={props.tracked === e.id}
              onTrack={props.onTrack}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A task cools down at serverNow: the window counts down. */
export const cooling = (log: QuestLogView | undefined, serverNow: number): boolean =>
  (log?.entries ?? []).some((e) => cooldownLeft(e, serverNow) > 0);

/**
 * The quest log with its open tab. clockOffset is the server's clock minus the client's
 * (Welcome.server_time): a task's countdown follows the server.
 */
export function QuestsPanel(props: {
  t: Translate;
  log: QuestLogView | undefined;
  clockOffset: number;
  content?: ClientContent | undefined;
  tracked?: string | undefined;
  onTrack?: ((id: string) => void) | undefined;
}): JSX.Element {
  const [tab, setTab] = useState<QuestTab>("active");
  const [, setTick] = useState(0);
  const serverNow = Date.now() + props.clockOffset;
  const counting = cooling(props.log, serverNow);
  useEffect(() => {
    if (!counting) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [counting]);
  return (
    <QuestsBody
      t={props.t}
      log={props.log}
      tab={tab}
      onTab={setTab}
      serverNow={serverNow}
      content={props.content}
      tracked={props.tracked}
      onTrack={props.onTrack}
    />
  );
}
