// The equipped backpack under the figure (docs/17 UI-5, the Diablo II style the owner asked
// for on 2026-11-18): the inventory window shows the grid of the backpack worn on the back
// below the slots, as that game shows its inventory grid, and opens it by itself. Pure.
//
// ContainerOpen does not say where a container lies, so the client remembers the window that
// answered a use of the backpack slot (`used`, then `opened`). A server that said it would
// make this exact; until then a backpack of the same kind opened from the floor at the same
// moment is the only thing that can fool it (it would show under the figure instead).
import type { ContainerState } from "./world.ts";

/** How long a use of the backpack slot waits for its ContainerOpen, ms. */
export const BACKPACK_ANSWER_MS = 3000;

/** Which open container is the equipped backpack. */
export class EquippedBackpack {
  /** The container id shown under the figure, or undefined. */
  id: number | undefined;
  /** The item a use of the slot opens, and until when its answer counts. */
  private awaiting: { itemId: number; until: number } | undefined;
  /** The window that was under the figure when its backpack left the slot (it may come back). */
  private left: number | undefined;

  /**
   * The player used the item in the backpack slot. With a window of that item open already
   * the use closes it (the server toggles): nothing to wait for.
   */
  used(itemId: number, open: readonly ContainerState[], now: number): void {
    const shown = open.some((c) => c.itemId === itemId && !c.hasParent);
    this.awaiting = shown ? undefined : { itemId, until: now + BACKPACK_ANSWER_MS };
  }

  /**
   * A ContainerOpen: the answer to the use of the slot when it is that item's, without a
   * parent, in time (another window opening meanwhile, a corpse, is not it).
   */
  opened(c: ContainerState, now: number): void {
    const a = this.awaiting;
    if (!a) return;
    if (now > a.until) this.awaiting = undefined;
    else if (c.itemId === a.itemId && !c.hasParent) {
      this.id = c.id;
      this.awaiting = undefined;
    }
  }

  /** A ContainerClose. */
  closed(id: number): void {
    if (this.id === id) this.id = undefined;
    if (this.left === id) this.left = undefined;
  }

  /**
   * The backpack slot holds `itemId` now (undefined = empty). The window under the figure
   * goes to a window of its own when its backpack leaves the slot (it can stay open on the
   * floor beside the player), and comes back under the figure when it returns.
   */
  equipped(itemId: number | undefined, open: readonly ContainerState[]): void {
    if (this.id !== undefined) {
      const docked = open.find((c) => c.id === this.id);
      if (docked && docked.itemId === itemId) return;
      this.left = this.id;
      this.id = undefined;
    }
    if (itemId === undefined || this.left === undefined) return;
    const back = open.find((c) => c.id === this.left);
    if (back && back.itemId === itemId) {
      this.id = back.id;
      this.left = undefined;
    }
  }

  /**
   * The open containers split: the backpack under the figure and the ones with a window
   * (the same list when no backpack is under the figure).
   */
  split(open: ContainerState[]): {
    backpack: ContainerState | undefined;
    others: ContainerState[];
  } {
    const backpack = this.id === undefined ? undefined : open.find((c) => c.id === this.id);
    return { backpack, others: backpack ? open.filter((c) => c !== backpack) : open };
  }
}

/** What the inventory knows when it decides whether to open the backpack by itself. */
export interface AutoOpenInput {
  /** The item in the backpack slot when it is a container. */
  equipped: number | undefined;
  /** It is open under the figure already. */
  docked: boolean;
  /** A tutorial runs (its step about opening the backpack teaches it). */
  tutorial: boolean;
  /** A window of that same item without a parent is open (a use would close it). */
  lookalike: boolean;
  /** The backpack this inventory already opened, or found open, since it showed. */
  done: number | undefined;
}

/**
 * Whether the inventory opens the equipped backpack now (docs/17 UI-5: "opened when the
 * inventory opens"), and what it remembers. Once per backpack while it shows: closing it
 * by hand keeps it closed until the inventory opens again or another backpack is worn.
 * Never during the tutorial, and never when a use would close a window instead.
 */
export function autoOpen(s: AutoOpenInput): { open: boolean; done: number | undefined } {
  if (s.equipped === undefined) return { open: false, done: undefined };
  if (s.done === s.equipped) return { open: false, done: s.done };
  if (s.docked || s.tutorial || s.lookalike) return { open: false, done: s.equipped };
  return { open: true, done: s.equipped };
}
