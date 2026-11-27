// Which finger owns an on-screen control (lote 21): every control (the pad, the stick, an
// action button) follows one pointer, the first that went down on it, and ignores the
// others until that one lifts. So a thumb walking on the pad and the other thumb tapping a
// target or a spell never steal each other's gesture, and a second contact on the pad (the
// base of the thumb, the palm) neither changes the direction nor stops the walk when it
// lifts. Pure: the components feed it pointer ids.

/** The contact size (CSS px) from which a touch is a palm or the side of the hand, not a fingertip. */
export const PALM_SIZE_PX = 70;

/**
 * True for a contact too big to be a fingertip. Browsers that do not measure the contact
 * report 1 x 1 (or 0): those are never palms.
 */
export function isPalm(width: number, height: number, limit: number = PALM_SIZE_PX): boolean {
  return Math.max(width, height) >= limit;
}

export class PointerOwner {
  private id: number | undefined;

  /** The pointer went down on the control: true if it now owns it (it was free). */
  claim(id: number): boolean {
    if (this.id !== undefined) return false;
    this.id = id;
    return true;
  }

  owns(id: number): boolean {
    return this.id === id;
  }

  /** The pointer lifted or was cancelled: true if it was the owner (the control is free again). */
  release(id: number): boolean {
    if (this.id !== id) return false;
    this.id = undefined;
    return true;
  }

  get held(): boolean {
    return this.id !== undefined;
  }

  /** Forgets the owner (the control went away, the window lost the focus). */
  reset(): void {
    this.id = undefined;
  }
}
