// The virtual analog stick (lote 21, Options → Controls; docs/15 "Controles táctiles"): the
// other shape of the on-screen movement control. A thumb anywhere on its base drags the
// knob; past the dead zone it holds one of the eight directions (input/joystick.ts) through
// the same Game.padPress / padRelease as the pad, so a tap turns, holding walks and walking
// into a boulder pushes it, exactly like the pad and the keys. One finger owns it
// (input/pointers.ts): a second contact on the base, or a palm, changes nothing.
import type { Direction } from "@rpg/protocol";
import type { JSX } from "preact";
import type { Game } from "../game.ts";
import type { Translate } from "../i18n/i18n.ts";
import { directionId } from "../input/dpad.ts";
import { stickState } from "../input/joystick.ts";
import { PointerOwner, isPalm } from "../input/pointers.ts";
import { staleOwner } from "./TouchPad.tsx";
import "./touch.css";

type PadGame = Pick<Game, "padPress" | "padRelease">;

/** One stick on screen at a time: its finger and the direction it holds. */
const owner = new PointerOwner();
let held: Direction | undefined;
/** The Game the owning finger walks, to stop it if the stick goes away under the finger. */
let walking: PadGame | undefined;

/**
 * The ref of the stick's element (stable, see padUnmounted in TouchPad.tsx): with null the
 * stick left the tree with a finger on it, so the owner, the held direction and the walk
 * are dropped; otherwise the next stick would skip its first padPress (same direction as
 * the stale one) and the character would walk on alone.
 */
export function stickUnmounted(el: HTMLElement | null): void {
  if (el || (!owner.held && held === undefined)) return;
  owner.reset();
  held = undefined;
  walking?.padRelease();
  walking = undefined;
}

function knobOf(el: HTMLElement): HTMLElement | null {
  return el.querySelector<HTMLElement>(".touch-stick-knob");
}

function move(game: PadGame | undefined, el: HTMLElement, e: PointerEvent): void {
  const r = el.getBoundingClientRect();
  const radius = r.width / 2;
  const s = stickState(
    e.clientX - (r.left + radius),
    e.clientY - (r.top + r.height / 2),
    radius,
    held,
  );
  const knob = knobOf(el);
  // The base may be scaled (the size option, the faded state): the knob moves in its own px.
  const k = el.offsetWidth > 0 ? el.offsetWidth / r.width : 1;
  if (knob) knob.style.transform = `translate(${Math.round(s.x * k)}px, ${Math.round(s.y * k)}px)`;
  if (s.dir === held) return;
  held = s.dir;
  if (s.dir === undefined) {
    game?.padRelease();
    delete el.dataset["held"];
  } else {
    game?.padPress(s.dir);
    el.dataset["held"] = directionId(s.dir);
  }
}

function release(game: PadGame | undefined, el: HTMLElement, pointerId: number): void {
  if (!owner.release(pointerId)) return;
  held = undefined;
  game?.padRelease();
  delete el.dataset["held"];
  const knob = knobOf(el);
  if (knob) knob.style.transform = "";
}

export function TouchStick(props: { t: Translate; game: PadGame | undefined }): JSX.Element {
  const { t, game } = props;
  const end = (e: JSX.TargetedPointerEvent<HTMLDivElement>): void =>
    release(game, e.currentTarget, e.pointerId);
  return (
    <div
      class="touch-stick"
      role="group"
      aria-label={t("client.touch.stick.label")}
      data-testid="touch-stick"
      ref={stickUnmounted}
      onPointerDown={(e) => {
        const el = e.currentTarget;
        e.preventDefault(); // no focus ring, no text selection, no emulated mouse
        staleOwner(owner, el);
        if (isPalm(e.width, e.height) || !owner.claim(e.pointerId)) return;
        walking = game;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // The pointer is gone already: the lostpointercapture path releases it.
        }
        move(game, el, e);
      }}
      onPointerMove={(e) => {
        if (owner.owns(e.pointerId)) move(game, e.currentTarget, e);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span class="touch-stick-ring" aria-hidden="true" />
      <span class="touch-stick-knob" aria-hidden="true" />
    </div>
  );
}
