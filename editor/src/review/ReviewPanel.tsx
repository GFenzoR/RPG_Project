// Review panel (T2.3): export the changes as a map patch, import one (merged tile by tile,
// undone in one step), and the diff against the world as loaded from disk: before/after
// switch for the canvas, the changed chunks and entries, and the conflicts of an import.
import { useRef } from "preact/hooks";
import { CHUNK_SIZE, listEntryPos } from "@rpg/map-format/ops";
import type { ListEntry, MergeList, Position } from "@rpg/map-format/ops";
import type { EditorController, EditorState } from "../state/editor.ts";

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

/** Where an entry is, in the current world or else in the loaded one. */
function entryPos(
  ctl: EditorController,
  island: string,
  list: MergeList,
  key: string,
): Position | undefined {
  for (const w of [ctl.state.world, ctl.baseline]) {
    const entries = (w.islands.get(island)?.[list] ?? []) as ListEntry[];
    const e = entries.find((x) => ("npc" in x ? x.npc : x.id) === key);
    if (e) return listEntryPos(e);
  }
  return undefined;
}

/** Downloads `text` as a file (the browser's save dialog; nothing is written to world/). */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ReviewPanel({
  ctl,
  s,
  onJump,
}: {
  ctl: EditorController;
  s: EditorState;
  onJump: (p: Position) => void;
}) {
  const t = ctl.t;
  const file = useRef<HTMLInputElement>(null);
  const diff = ctl.diff();
  const entries = diff.lists.flatMap((l) =>
    (["added", "removed", "changed"] as const).flatMap((what) =>
      l[what].map((key) => ({ ...l, key, what })),
    ),
  );

  const exportPatch = async (): Promise<void> => {
    const text = await ctl.exportPatch();
    if (text !== undefined) download(`${s.island || "world"}.rpgpatch.json`, text);
  };
  const importPatch = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    await ctl.importPatch(await f.text());
    if (file.current) file.current.value = "";
  };

  return (
    <section class="panel review" data-testid="review-panel">
      <h2>{t("editor.review.title")}</h2>
      <div class="row">
        <button data-testid="patch-export" onClick={() => void exportPatch()}>
          {t("editor.patch.export")}
        </button>
        <button data-testid="patch-import" onClick={() => file.current?.click()}>
          {t("editor.patch.import")}
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          data-testid="patch-file"
          hidden
          onChange={(e) => void importPatch(e.currentTarget.files?.[0])}
        />
      </div>
      <div class="row" role="group" aria-label={t("editor.review.side")}>
        {(["before", "after"] as const).map((side) => (
          <button
            key={side}
            data-testid={`review-${side}`}
            class={s.reviewSide === side ? "active" : ""}
            onClick={() => ctl.setReviewSide(side)}
          >
            {t(`editor.review.${side}`)}
          </button>
        ))}
      </div>

      {s.patchConflicts.length > 0 && (
        <>
          <h3 class="bad">
            {t("editor.patch.conflicts_title", { count: s.patchConflicts.length })}
          </h3>
          <ul class="diags" data-testid="patch-conflicts">
            {s.patchConflicts.slice(0, 200).map((c, i) => {
              const short = c.path.replace(/^world\/islands\//, "");
              if (c.kind === "tile")
                return (
                  <li key={i} class="error">
                    <button onClick={() => onJump(c)}>
                      {t("editor.patch.conflict_tile", { file: short, x: c.x, y: c.y, z: c.z })}
                    </button>
                  </li>
                );
              const isl = /^world\/islands\/([^/]+)\/([a-z]+)\.yaml$/.exec(c.path);
              const pos =
                c.kind === "entry" && isl
                  ? entryPos(ctl, isl[1] ?? "", isl[2] as MergeList, c.key)
                  : undefined;
              return (
                <li key={i} class="error">
                  <button disabled={!pos} onClick={() => pos && onJump(pos)}>
                    {c.kind === "entry"
                      ? t("editor.patch.conflict_entry", { file: short, id: c.key })
                      : t("editor.patch.conflict_file", { file: short, reason: c.reason })}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h3>{t("editor.review.changes", { chunks: diff.chunks.length, entries: entries.length })}</h3>
      {diff.chunks.length + entries.length === 0 ? (
        <p data-testid="review-empty">{t("editor.review.none")}</p>
      ) : (
        <ul class="changes" data-testid="review-changes">
          {diff.chunks.map((c) => (
            <li key={`${c.island}/${c.z}/${c.cx}/${c.cy}`}>
              <button
                data-testid="review-chunk"
                onClick={() =>
                  onJump({
                    x: c.bbox.x + Math.floor(c.bbox.w / 2),
                    y: c.bbox.y + Math.floor(c.bbox.h / 2),
                    z: c.z,
                  })
                }
              >
                {t("editor.review.chunk", {
                  island: c.island,
                  chunk: `z${pad(c.z, 2)}/c${pad(c.cx, 4)}_${pad(c.cy, 4)}`,
                  tiles: c.tiles.length,
                })}
              </button>
            </li>
          ))}
          {entries.map((e) => {
            const pos = entryPos(ctl, e.island, e.list, e.key);
            return (
              <li key={`${e.island}/${e.list}/${e.key}`}>
                <button
                  data-testid="review-entry"
                  disabled={!pos}
                  onClick={() => pos && onJump(pos)}
                >
                  {t(`editor.review.entry_${e.what}`, {
                    list: t(`editor.entity.${e.list}`),
                    id: e.key,
                  })}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p class="hint">{t("editor.review.hint", { size: CHUNK_SIZE })}</p>
    </section>
  );
}
