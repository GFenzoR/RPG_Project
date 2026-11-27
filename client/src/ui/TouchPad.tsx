// T5.6: the on-screen direction pad (optional, switched in Options) and its switch. A finger
// on the pad holds the direction it points at from the centre (sliding changes it); holding
// keeps walking one step after another at the walking speed, like a held arrow key. From
// the keyboard each button is one step. No hooks: the held direction lives in the Game and
// the highlight is a data attribute on the pad.
import { Direction } from "@rpg/protocol";
import type { JSX } from "preact";
import type { Game } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { DPAD_CELLS, directionId, dpadDirection } from "../input/dpad.ts";
import { PointerOwner, isPalm } from "../input/pointers.ts";
import "./touch.css";

/**
 * Width the docked pad takes on the map's left, CSS px (3 cells of 44 px, gaps, padding and
 * the 8 px margin, as in touch.css): the hotbar starts after it.
 */
export const PAD_RESERVE_PX = 162;

/** Share of the pad's width around the centre where a finger holds no direction. */
export const PAD_DEADZONE = 0.12;

/** Arrow of each direction (decoration: the buttons are labelled by aria-label). */
const ARROWS: Partial<Record<Direction, string>> = {
  [Direction.NORTH_WEST]: "↖",
  [Direction.NORTH]: "↑",
  [Direction.NORTH_EAST]: "↗",
  [Direction.WEST]: "←",
  [Direction.EAST]: "→",
  [Direction.SOUTH_WEST]: "↙",
  [Direction.SOUTH]: "↓",
  [Direction.SOUTH_EAST]: "↘",
};

type PadGame = Pick<Game, "padPress" | "padRelease" | "padStep">;

/**
 * Lote 21: the finger that owns the pad (one pad on screen at a time). A second contact on
 * it (the base of the thumb) neither changes the direction nor stops the walk when it lifts.
 */
const owner = new PointerOwner();
/** The Game the owning finger walks, to stop it if the pad goes away under the finger. */
let walking: PadGame | undefined;

/**
 * The ref of the pad's element (a stable function: Preact calls a new one with null on
 * every render). With null the pad left the tree: the layout changed or the phone turned
 * with the thumb on it, and its pointerup will never reach the handlers, so the held
 * direction is dropped here or the character would walk on alone.
 */
export function padUnmounted(el: HTMLElement | null): void {
  if (el || !owner.held) return;
  owner.reset();
  walking?.padRelease();
  walking = undefined;
}

/** Frees an owner whose pointer the element no longer holds (the pad was redrawn elsewhere). */
export function staleOwner(o: PointerOwner, el: HTMLElement): void {
  const id = o.current;
  if (id !== undefined && !el.hasPointerCapture(id)) o.reset();
}

/** The direction a pointer on the pad element points at, or undefined at the centre. */
function pointed(el: HTMLElement, e: PointerEvent): Direction | undefined {
  const r = el.getBoundingClientRect();
  return dpadDirection(
    e.clientX - (r.left + r.width / 2),
    e.clientY - (r.top + r.height / 2),
    r.width * PAD_DEADZONE,
  );
}

function hold(game: PadGame | undefined, el: HTMLElement, dir: Direction | undefined): void {
  if (dir === undefined) {
    game?.padRelease();
    delete el.dataset["held"];
  } else {
    game?.padPress(dir);
    el.dataset["held"] = directionId(dir);
  }
}

export function TouchPad(props: { t: Translate; game: PadGame | undefined }): JSX.Element {
  const { t, game } = props;
  const release = (e: PointerEvent): void => {
    if (owner.release(e.pointerId)) hold(game, e.currentTarget as HTMLElement, undefined);
  };
  return (
    <div
      class="touch-pad"
      role="group"
      aria-label={t("client.touch.dpad.label")}
      data-testid="touch-pad"
      ref={padUnmounted}
      onPointerDown={(e) => {
        const el = e.currentTarget;
        e.preventDefault(); // no focus ring, no text selection, no emulated mouse
        staleOwner(owner, el);
        if (isPalm(e.width, e.height) || !owner.claim(e.pointerId)) return;
        walking = game;
        el.setPointerCapture(e.pointerId);
        hold(game, el, pointed(el, e));
      }}
      onPointerMove={(e) => {
        const el = e.currentTarget;
        if (owner.owns(e.pointerId) && el.hasPointerCapture(e.pointerId))
          hold(game, el, pointed(el, e));
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      {DPAD_CELLS.map((dir, i) =>
        dir === undefined ? (
          <span key={i} class="touch-pad-centre" aria-hidden="true" />
        ) : (
          <button
            key={i}
            type="button"
            class="touch-pad-button"
            data-dir={directionId(dir)}
            aria-label={t(`client.touch.dpad.${directionId(dir)}`)}
            onClick={(e) => {
              // A pointer already walked through the pad's handlers; detail 0 = keyboard.
              if (e.detail === 0) game?.padStep(dir);
            }}
          >
            <span aria-hidden="true">{ARROWS[dir]}</span>
          </button>
        ),
      )}
    </div>
  );
}

/** The Options switch of the pad (saved with state/touch-prefs.ts by the caller). */
export function TouchPadToggle(props: {
  t: Translate;
  on: boolean;
  onChange(on: boolean): void;
}): JSX.Element {
  return (
    <label class="check touch-pad-toggle">
      <input
        type="checkbox"
        data-testid="touch-pad-toggle"
        checked={props.on}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      {props.t("client.touch.dpad_option")}
    </label>
  );
}
