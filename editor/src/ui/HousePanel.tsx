// House panel (T5.4 houses.yaml, docs/04 "Casas en el editor"): the houses of the current
// island, and a form for the one being created or edited. Tiles, doors and the exit are
// drawn on the map with the house tool (H); the form holds the id, the names, the rent and
// the notes, and lists what is wrong while you draw. "Create"/"Apply" turns the draft into
// add_house / set_house through the controller (validated, undoable, saved to houses.yaml
// and the names to i18n/<lang>/world.yaml).
import { houseNameKey, houseSize, tilesToRects } from "@rpg/map-format/ops";
import type { Position } from "@rpg/map-format/ops";
import { HOUSE_MODES, housePos, issueText } from "../houses/draft.ts";
import { MAX_NAME_LENGTH } from "../io/wire.ts";
import type { EditorController, EditorState } from "../state/editor.ts";

export function HousePanel({
  ctl,
  s,
  onJump,
}: {
  ctl: EditorController;
  s: EditorState;
  onJump: (p: Position) => void;
}) {
  const t = ctl.t;
  const list = ctl.houses();
  const d = s.houseDraft;
  const issues = d ? ctl.houseIssues() : [];
  const sel = s.houseSel;
  return (
    <section class="panel houses" data-testid="houses">
      <h2>{t("editor.houses")}</h2>
      <ul class="entity-list">
        {list.length === 0 && <li class="empty">{t("editor.house.none")}</li>}
        {list.map((h) => (
          <li key={h.id}>
            <button
              data-testid={`house-${h.id}`}
              class={h.id === sel ? "active" : ""}
              onClick={() => {
                ctl.selectHouse(h.id);
                const p = housePos(h);
                if (p) onJump(p);
              }}
            >
              {t("editor.house.item", { id: h.id, size: houseSize(h) })}
            </button>
          </li>
        ))}
      </ul>
      <div class="row">
        <button data-testid="house-new" onClick={() => ctl.newHouse()}>
          {t("editor.house.new")}
        </button>
        {sel !== undefined && (
          <button data-testid="house-delete" onClick={() => ctl.removeHouse(sel)}>
            {t("editor.house.delete")}
          </button>
        )}
      </div>
      {d && (
        <form
          class="entity-form"
          data-testid="house-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            ctl.applyHouse();
          }}
        >
          <label class="field">
            <span>{t("editor.entity.id")}</span>
            <input
              type="text"
              data-testid="house-id"
              value={d.id}
              disabled={d.key !== undefined}
              title={d.key === undefined ? "" : t("editor.house.id_fixed")}
              onInput={(e) => ctl.editHouse({ id: e.currentTarget.value })}
            />
          </label>
          <p class="hint" data-testid="house-name-key">
            {t("editor.house.name_key", { key: houseNameKey(d.id) })}
          </p>
          {ctl.languages.map((lang) => (
            <label class="field" key={lang}>
              <span>{t("editor.house.name", { lang })}</span>
              <input
                type="text"
                data-testid={`house-name-${lang}`}
                maxLength={MAX_NAME_LENGTH}
                value={d.names[lang] ?? ""}
                onInput={(e) => ctl.editHouse({ names: { [lang]: e.currentTarget.value } })}
              />
            </label>
          ))}
          <label class="field">
            <span>{t("editor.house.rent")}</span>
            <input
              type="number"
              data-testid="house-rent"
              min={1}
              value={Number.isFinite(d.rent) ? d.rent : ""}
              onInput={(e) => ctl.editHouse({ rent: Number(e.currentTarget.value || NaN) })}
            />
          </label>
          <div class="field">
            <span>{t("editor.house.mode")}</span>
            <div class="tabs">
              {HOUSE_MODES.map((m) => (
                <button
                  type="button"
                  key={m}
                  data-testid={`house-mode-${m}`}
                  class={s.tool === "house" && s.houseMode === m ? "active" : ""}
                  onClick={() => ctl.setHouseMode(m)}
                >
                  {t(`editor.house.mode.${m}`)}
                </button>
              ))}
            </div>
          </div>
          <p class="hint">{t(`editor.house.hint.${s.houseMode}`)}</p>
          <button
            type="button"
            data-testid="house-from-selection"
            disabled={!s.selection}
            onClick={() => ctl.houseFromSelection()}
          >
            {t("editor.house.from_selection")}
          </button>
          <p class="summary" data-testid="house-summary">
            {t("editor.house.summary", {
              tiles: d.tiles.length,
              rects: tilesToRects(d.tiles).length,
              doors: d.doors.length,
            })}
          </p>
          <p class="summary" data-testid="house-exit">
            {d.exit
              ? t("editor.house.exit_at", { x: d.exit.x, y: d.exit.y, z: d.exit.z })
              : t("editor.house.exit_none")}
          </p>
          <label class="field">
            <span>{t("editor.entity.notes")}</span>
            <input
              type="text"
              data-testid="house-notes"
              value={d.notes}
              onInput={(e) => ctl.editHouse({ notes: e.currentTarget.value })}
            />
          </label>
          {issues.length === 0 ? (
            <p class="good" data-testid="house-ok">
              {t("editor.house.ok")}
            </p>
          ) : (
            <ul class="diags" data-testid="house-issues">
              {issues.map((i, n) => (
                <li key={n} class={i.severity}>
                  <button
                    type="button"
                    data-testid="house-issue"
                    disabled={!("pos" in i && i.pos)}
                    onClick={() => "pos" in i && i.pos && onJump(i.pos)}
                  >
                    {issueText(t, i)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div class="row">
            <button type="submit" class="primary" data-testid="house-apply">
              {d.key === undefined ? t("editor.entity.create") : t("editor.entity.apply")}
            </button>
            <button type="button" data-testid="house-cancel" onClick={() => ctl.closeHouse()}>
              {t("editor.entity.cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
