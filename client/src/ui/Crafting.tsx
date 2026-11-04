// Crafting station window (T3.4): the recipes of the station the player used, with the
// inputs it lacks, the level and tool they need and the success chance at the player's
// skill. The server checks everything again (distance, inputs, room, time) on Craft.
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, GameUi } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { stationRecipes } from "../state/recipes.ts";
import type { RecipeView } from "../state/recipes.ts";

interface Props {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  ui: GameUi;
}

export function CraftingWindow({ t, content, game, ui }: Props): JSX.Element | null {
  const st = ui.station;
  if (!st) return null;
  const def = content.items[st.itemId];
  const title = def ? t(`item.${def.id}.name`) : t("client.craft.title");
  const views = stationRecipes(content.recipes, st, ui.skills);
  return (
    <section class="crafting" data-testid="crafting" role="dialog" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          class="close"
          aria-label={t("client.dialog.close")}
          title={t("client.dialog.close")}
          onClick={() => game?.closeStation()}
        >
          ×
        </button>
      </header>
      {views.length === 0 ? (
        <p class="empty">{t("client.craft.empty")}</p>
      ) : (
        <ul>
          {views.map((v) => (
            <RecipeRow key={v.recipe.id} t={t} content={content} game={game} view={v} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecipeRow(props: {
  t: Translate;
  content: ClientContent;
  game: Game | undefined;
  view: RecipeView;
}): JSX.Element {
  const { t, content, game, view } = props;
  const r = view.recipe;
  const name = (id: number): string => {
    const d = content.items[id];
    return d ? t(`item.${d.id}.name`) : String(id);
  };
  const icon = game?.itemIcon(r.output.itemId);
  const style: JSX.CSSProperties = icon
    ? {
        backgroundImage: `url(${icon.url})`,
        backgroundPosition: `-${icon.x}px -${icon.y}px`,
        width: `${icon.width}px`,
        height: `${icon.height}px`,
      }
    : {};
  const missing = new Map(view.missing.map((m) => [m.itemId, m.count]));
  return (
    <li class={view.ready ? "recipe ready" : "recipe"} data-recipe={r.id}>
      <span class={icon ? "item" : "item missing"} style={style} aria-hidden="true">
        {!icon && name(r.output.itemId).slice(0, 2)}
      </span>
      <div class="recipe-body">
        <strong>
          {r.output.count > 1 ? t("client.craft.count", { count: r.output.count }) : ""}
          {name(r.output.itemId)}
        </strong>
        <ul class="inputs">
          {r.inputs.map((i) => (
            <li key={i.itemId} class={missing.has(i.itemId) ? "lacking" : undefined}>
              {t("client.craft.input", { count: i.count, item: name(i.itemId) })}
              {missing.has(i.itemId) &&
                ` ${t("client.craft.lacking", { count: missing.get(i.itemId) ?? 0 })}`}
            </li>
          ))}
        </ul>
        <p class="needs">
          <span class={view.hasLevel ? undefined : "lacking"}>
            {t("client.craft.level", { skill: t(`skill.${r.craft}.name`), level: r.level })}
          </span>
          {r.tool !== "" && (
            <span class={view.hasTool ? undefined : "lacking"}>
              {" · "}
              {t(`client.craft.tool.${r.tool}`)}
            </span>
          )}
          <span data-testid="chance">
            {" · "}
            {t("client.craft.chance", { pct: Math.round(view.chance * 100) })}
          </span>
        </p>
      </div>
      <button type="button" disabled={!view.ready} onClick={() => game?.craft(r.id)}>
        {t("client.craft.make")}
      </button>
    </li>
  );
}
