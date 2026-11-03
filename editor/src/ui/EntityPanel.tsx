// Panels for the auxiliary lists of the current island: spawns, NPCs, zones and portals.
// The form edits a draft; "apply" turns it into map-format ops through the controller
// (add, or remove + add for an edit), so every change is validated by the op, undoable and
// saved to the island's YAML like any other edit.
import { useEffect, useState } from "preact/hooks";
import { PORTAL_KINDS, ZONE_TYPES } from "@rpg/map-format/ops";
import type {
  EntityList,
  NpcPlacement,
  Portal,
  Position,
  Rect,
  Spawn,
  Zone,
} from "@rpg/map-format/ops";
import type { Entity, EditorController, EditorState } from "../state/editor.ts";
import { entityKey, entityPos } from "../state/editor.ts";
import { EDITABLE_AUX } from "../io/wire.ts";

/** Zone rects as text, one `x,y,w,h` per line. */
export const formatRects = (rects: Rect[]): string =>
  rects.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join("\n");

/** Parses `formatRects` text; undefined if a line is not four integers. */
export function parseRects(text: string): Rect[] | undefined {
  const out: Rect[] = [];
  for (const line of text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const n = line.split(/[\s,]+/).map(Number);
    if (n.length !== 4 || !n.every(Number.isInteger)) return undefined;
    const [x, y, w, h] = n as [number, number, number, number];
    out.push({ x, y, w, h });
  }
  return out;
}

/** Floors as text (`7, 8`); undefined if one is not an integer. */
export function parseFloors(text: string): number[] | undefined {
  const n = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  return n.every(Number.isInteger) ? n : undefined;
}

/** A fresh entry of `file` at `at`, with an ID not used in the world. */
export function newEntity(
  ctl: EditorController,
  file: EntityList,
  at: Position,
  firstMonster: string,
  firstNpc: string,
): Entity {
  const island = ctl.state.island;
  const used = new Set<string>();
  for (const isl of ctl.state.world.islands.values())
    for (const e of isl[file] as Entity[]) used.add(entityKey(e));
  let n = 1;
  const prefix = `${island}_${file.replace(/s$/, "")}`;
  while (used.has(`${prefix}_${n}`)) n++;
  const id = `${prefix}_${n}`;
  const pos = { ...at };
  if (file === "spawns")
    return {
      id,
      center: pos,
      radius: 2,
      monsters: [{ monster: firstMonster, count: 1 }],
      respawn_seconds: 60,
    };
  if (file === "zones")
    return { id, type: "protection", floors: [at.z], rects: [{ x: at.x, y: at.y, w: 3, h: 3 }] };
  if (file === "portals") return { id, kind: "stairs", from: pos, to: { ...at, z: at.z + 1 } };
  return { npc: firstNpc, pos };
}

function PosField({
  label,
  name,
  value,
  onChange,
  ctl,
}: {
  label: string;
  name: string;
  value: Position;
  onChange: (p: Position) => void;
  ctl: EditorController;
}) {
  const num = (k: "x" | "y" | "z", v: string): void => onChange({ ...value, [k]: Number(v) });
  return (
    <div class="field pos">
      <span>{label}</span>
      {(["x", "y", "z"] as const).map((k) => (
        <input
          key={k}
          type="number"
          data-testid={`field-${name}-${k}`}
          value={value[k]}
          onInput={(e) => num(k, e.currentTarget.value)}
        />
      ))}
      <button
        type="button"
        data-testid={`pick-${name}`}
        title={ctl.t("editor.entity.pick")}
        onClick={() => ctl.requestPick((p) => onChange(p))}
      >
        ⌖
      </button>
    </div>
  );
}

export function EntityPanel({
  ctl,
  s,
  onJump,
}: {
  ctl: EditorController;
  s: EditorState;
  onJump: (p: Position) => void;
}) {
  const t = ctl.t;
  const file = s.entityTab;
  const list = ctl.entities(file);
  const selected = list.find((e) => entityKey(e) === s.entitySel);
  /** Key being edited (undefined: a new entry) and its draft. */
  const [draft, setDraft] = useState<{ key: string | undefined; e: Entity } | undefined>();
  const [floorsText, setFloorsText] = useState("");
  const [rectsText, setRectsText] = useState("");

  const open = (key: string | undefined, e: Entity): void => {
    setDraft({ key, e: structuredClone(e) });
    if ("rects" in e) {
      setFloorsText(e.floors.join(", "));
      setRectsText(formatRects(e.rects));
    }
  };
  // Selecting an entry (list, apply or undo) opens it; the draft follows the selected
  // entry itself, not the whole world: map edits keep the list (and entry) references,
  // so painting never discards what is typed in the form.
  useEffect(() => {
    if (selected) open(entityKey(selected), selected);
    else setDraft((d) => (d && d.key === undefined ? d : undefined));
  }, [s.entitySel, file, selected]);

  const set = (patch: Partial<Spawn & Zone & Portal & NpcPlacement>): void =>
    setDraft((d) => d && { ...d, e: { ...d.e, ...patch } as Entity });

  const apply = (): void => {
    if (!draft) return;
    let e = draft.e;
    if ("rects" in e) {
      const floors = parseFloors(floorsText);
      const rects = parseRects(rectsText);
      if (!floors || !rects) {
        ctl.reportStatus(t("editor.entity.bad_rects"));
        return;
      }
      e = { ...e, floors, rects };
    }
    if (e.notes === "") delete e.notes;
    const ok =
      draft.key === undefined ? ctl.addEntity(file, e) : ctl.updateEntity(file, draft.key, e);
    if (ok) setDraft({ key: entityKey(e), e });
  };

  const create = (): void => {
    const at = s.hover ?? { ...ctl.island()?.meta.temple, z: s.floor };
    const p = { x: at.x ?? 0, y: at.y ?? 0, z: s.floor };
    ctl.selectEntity(undefined);
    open(undefined, newEntity(ctl, file, p, ctl.monsters[0] ?? "", ctl.npcs[0] ?? ""));
  };

  const d = draft?.e;
  return (
    <section class="panel entities" data-testid="entities">
      <h2>{t("editor.entities")}</h2>
      <div class="tabs">
        {EDITABLE_AUX.map((f) => (
          <button
            key={f}
            data-testid={`entity-tab-${f}`}
            class={f === file ? "active" : ""}
            onClick={() => {
              setDraft(undefined);
              ctl.setEntityTab(f);
            }}
          >
            {t(`editor.entity.${f}`)}
          </button>
        ))}
      </div>
      <ul class="entity-list">
        {list.length === 0 && <li class="empty">{t("editor.entity.none")}</li>}
        {list.map((e) => {
          const key = entityKey(e);
          return (
            <li key={key}>
              <button
                data-testid={`entity-${key}`}
                class={key === s.entitySel ? "active" : ""}
                onClick={() => {
                  ctl.selectEntity(key);
                  onJump(entityPos(e));
                }}
              >
                {key}
              </button>
            </li>
          );
        })}
      </ul>
      <div class="row">
        <button data-testid="entity-new" onClick={create}>
          {t("editor.entity.new")}
        </button>
        {selected && (
          <button
            data-testid="entity-delete"
            onClick={() => {
              setDraft(undefined);
              ctl.removeEntity(file, entityKey(selected));
            }}
          >
            {t("editor.entity.delete")}
          </button>
        )}
      </div>
      {d && (
        <form
          class="entity-form"
          data-testid="entity-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            apply();
          }}
        >
          {"npc" in d ? (
            <>
              <label class="field">
                <span>{t("editor.entity.npc")}</span>
                <select
                  data-testid="field-npc"
                  value={d.npc}
                  onChange={(e) => set({ npc: e.currentTarget.value })}
                >
                  {[...new Set([d.npc, ...ctl.npcs])].map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <PosField
                label={t("editor.entity.pos")}
                name="pos"
                value={d.pos}
                onChange={(pos) => set({ pos })}
                ctl={ctl}
              />
            </>
          ) : (
            <label class="field">
              <span>{t("editor.entity.id")}</span>
              <input
                type="text"
                data-testid="field-id"
                value={d.id}
                onInput={(e) => set({ id: e.currentTarget.value })}
              />
            </label>
          )}
          {"center" in d && (
            <>
              <PosField
                label={t("editor.entity.center")}
                name="center"
                value={d.center}
                onChange={(center) => set({ center })}
                ctl={ctl}
              />
              <label class="field">
                <span>{t("editor.entity.radius")}</span>
                <input
                  type="number"
                  data-testid="field-radius"
                  value={d.radius}
                  onInput={(e) => set({ radius: Number(e.currentTarget.value) })}
                />
              </label>
              <label class="field">
                <span>{t("editor.entity.respawn")}</span>
                <input
                  type="number"
                  data-testid="field-respawn"
                  value={d.respawn_seconds}
                  onInput={(e) => set({ respawn_seconds: Number(e.currentTarget.value) })}
                />
              </label>
              <div class="field monsters">
                <span>{t("editor.entity.monsters")}</span>
                {d.monsters.map((m, i) => (
                  <div class="monster" key={i}>
                    <select
                      data-testid={`field-monster-${i}`}
                      value={m.monster}
                      onChange={(e) =>
                        set({
                          monsters: d.monsters.map((x, j) =>
                            j === i ? { ...x, monster: e.currentTarget.value } : x,
                          ),
                        })
                      }
                    >
                      {[...new Set([m.monster, ...ctl.monsters])].map((id) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      data-testid={`field-count-${i}`}
                      value={m.count}
                      onInput={(e) =>
                        set({
                          monsters: d.monsters.map((x, j) =>
                            j === i ? { ...x, count: Number(e.currentTarget.value) } : x,
                          ),
                        })
                      }
                    />
                    <button
                      type="button"
                      title={t("editor.entity.remove_monster")}
                      onClick={() => set({ monsters: d.monsters.filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  data-testid="add-monster"
                  onClick={() =>
                    set({ monsters: [...d.monsters, { monster: ctl.monsters[0] ?? "", count: 1 }] })
                  }
                >
                  {t("editor.entity.add_monster")}
                </button>
              </div>
            </>
          )}
          {"rects" in d && (
            <>
              <label class="field">
                <span>{t("editor.entity.zone_type")}</span>
                <select
                  data-testid="field-type"
                  value={d.type}
                  onChange={(e) => set({ type: e.currentTarget.value as Zone["type"] })}
                >
                  {ZONE_TYPES.map((z) => (
                    <option key={z} value={z}>
                      {t(`editor.zone.${z}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label class="field">
                <span>{t("editor.entity.floors")}</span>
                <input
                  type="text"
                  data-testid="field-floors"
                  value={floorsText}
                  onInput={(e) => setFloorsText(e.currentTarget.value)}
                />
              </label>
              <label class="field">
                <span>{t("editor.entity.rects")}</span>
                <textarea
                  data-testid="field-rects"
                  rows={3}
                  value={rectsText}
                  onInput={(e) => setRectsText(e.currentTarget.value)}
                />
              </label>
              <button
                type="button"
                data-testid="rects-from-selection"
                disabled={!s.selection}
                onClick={() => s.selection && setRectsText(formatRects([s.selection]))}
              >
                {t("editor.entity.use_selection")}
              </button>
            </>
          )}
          {"kind" in d && (
            <>
              <label class="field">
                <span>{t("editor.entity.portal_kind")}</span>
                <select
                  data-testid="field-kind"
                  value={d.kind}
                  onChange={(e) => set({ kind: e.currentTarget.value as Portal["kind"] })}
                >
                  {PORTAL_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`editor.portal.${k}`)}
                    </option>
                  ))}
                </select>
              </label>
              <PosField
                label={t("editor.entity.from")}
                name="from"
                value={d.from}
                onChange={(from) => set({ from })}
                ctl={ctl}
              />
              <PosField
                label={t("editor.entity.to")}
                name="to"
                value={d.to}
                onChange={(to) => set({ to })}
                ctl={ctl}
              />
            </>
          )}
          <label class="field">
            <span>{t("editor.entity.notes")}</span>
            <input
              type="text"
              data-testid="field-notes"
              value={d.notes ?? ""}
              onInput={(e) => set({ notes: e.currentTarget.value })}
            />
          </label>
          <div class="row">
            <button type="submit" class="primary" data-testid="entity-apply">
              {draft?.key === undefined ? t("editor.entity.create") : t("editor.entity.apply")}
            </button>
            <button
              type="button"
              data-testid="entity-cancel"
              onClick={() => {
                setDraft(undefined);
                ctl.selectEntity(undefined);
              }}
            >
              {t("editor.entity.cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
