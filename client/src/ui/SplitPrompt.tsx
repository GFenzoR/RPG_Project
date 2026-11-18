// Shift+drag of a stack (docs/17 UI-6): where it was dropped, a small box asks how many
// units go there (half the stack to start), the way "Move part…" of the item menu does
// for a click. Enter or "Move" sends MoveItem with that count (the server checks it like
// any move); Escape or "Cancel" leaves the stack where it was.
import { useEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import type { ClientContent } from "../content-types.ts";
import type { Game, SplitView } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { halfStack, splitCount } from "../state/items.ts";
import { mousePlacement } from "./ActionMenu.tsx";

/** The box's size for placing it beside the drop (client.css .split-prompt), CSS px. */
const SPLIT_W = 232;
const SPLIT_H = 96;

export function SplitPrompt(props: {
  t: Translate;
  content: ClientContent;
  split: SplitView;
  game: Pick<Game, "splitConfirm" | "splitCancel"> | undefined;
}): JSX.Element {
  const { t, split, game } = props;
  const def = props.content.items[split.itemId];
  const name = def ? t(`item.${def.id}.name`) : String(split.itemId);
  const input = useRef<HTMLInputElement>(null);
  // The field takes the focus: type the count and press Enter (Preact ignores autoFocus).
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const at = mousePlacement(
    split.x,
    split.y,
    window.innerWidth,
    window.innerHeight,
    SPLIT_W,
    SPLIT_H,
  );
  return (
    <form
      class="split-prompt"
      role="dialog"
      aria-labelledby="split-prompt-title"
      data-testid="split-prompt"
      style={{ left: `${at.left}px`, top: `${at.top}px` }}
      onSubmit={(e) => {
        e.preventDefault();
        game?.splitConfirm(splitCount(Number(input.current?.value ?? NaN), split.count));
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        game?.splitCancel();
      }}
    >
      <label id="split-prompt-title">
        <span>{t("client.split.title", { name, count: split.count })}</span>
        <input
          ref={input}
          type="number"
          name="count"
          min={1}
          max={Math.max(1, split.count - 1)}
          defaultValue={String(halfStack(split.count))}
          data-testid="split-prompt-count"
        />
      </label>
      <div class="buttons">
        <button type="submit" data-testid="split-prompt-ok">
          {t("client.split.move")}
        </button>
        <button type="button" onClick={() => game?.splitCancel()}>
          {t("client.split.cancel")}
        </button>
      </div>
    </form>
  );
}
