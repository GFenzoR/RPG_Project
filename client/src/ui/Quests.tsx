// The quest log, "Misiones" (docs/02 "Diario de misiones"): a window of the toolbar (L) on
// desktop, a tab of the panel on phones. Two tabs: the quests in progress (name, chapter,
// the current step's text and the kills counted) and the finished ones (a task shows when
// it is back). QuestsBody has no hooks (ui/Quests.test.ts walks its tree); QuestsPanel
// keeps the open tab and ticks once a second while a task cools down.
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Translate } from "../i18n/i18n.ts";
import { cooldownLeft, questTabs, timeLeft } from "../state/quests.ts";
import type { QuestEntryView, QuestLogView } from "../state/quests.ts";

/** The tabs of the window, in order. */
export const QUEST_TABS = ["active", "finished"] as const;
export type QuestTab = (typeof QUEST_TABS)[number];

const TAB_KEY: Record<QuestTab, string> = {
  active: "client.quests.tab_active",
  finished: "client.quests.tab_finished",
};

/** The label under a quest's name: its chapter, or a task, or a side quest. */
function questKind(t: Translate, e: QuestEntryView): string {
  if (e.chapter > 0) return t("client.quests.chapter", { chapter: e.chapter });
  return t(e.repeatable ? "client.quests.task" : "client.quests.side");
}

function QuestItem(props: { t: Translate; e: QuestEntryView; serverNow: number }): JSX.Element {
  const { t, e } = props;
  const left = cooldownLeft(e, props.serverNow);
  let status: JSX.Element;
  if (e.state === "active") {
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
  } else {
    status = (
      <p class={e.repeatable ? "quest-done again" : "quest-done"} data-testid="quest-done">
        {t(e.repeatable ? "client.quests.available_again" : "client.quests.done")}
      </p>
    );
  }
  return (
    <li class="quest" data-quest={e.id} data-state={e.state} data-ready={left > 0 ? undefined : ""}>
      <div class="quest-head">
        <span class="quest-name">{t(e.name)}</span>
        <span class="quest-kind">{questKind(t, e)}</span>
      </div>
      {status}
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
}): JSX.Element {
  const { t, tab } = props;
  const tabs = questTabs(props.log, props.serverNow);
  const shown = tab === "active" ? tabs.active : tabs.finished;
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
            {t(TAB_KEY[id], { count: (id === "active" ? tabs.active : tabs.finished).length })}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p class="empty" data-testid="quests-empty">
          {t(tab === "active" ? "client.quests.none_active" : "client.quests.none_finished")}
        </p>
      ) : (
        <ul class="quest-list" key={tab}>
          {shown.map((e) => (
            <QuestItem key={e.id} t={t} e={e} serverNow={props.serverNow} />
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
  return <QuestsBody t={props.t} log={props.log} tab={tab} onTab={setTab} serverNow={serverNow} />;
}
