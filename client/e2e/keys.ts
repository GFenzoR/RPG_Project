// Walking one step with the keyboard or the pad in the E2E (docs/17 MOV-2): standing still,
// a quick tap toward a way the player does not face only turns it. So one step toward any
// way is what a player does: a tap to turn if it must, then a tap to walk. Each tap is
// quick (no key held across frames), so it never walks a second tile.
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** The Direction (proto/game/v1/common.proto) of each walking key and pad button. */
const DIRS: Record<string, number> = {
  ArrowUp: 1,
  KeyW: 1,
  north: 1,
  ArrowRight: 3,
  KeyD: 3,
  east: 3,
  ArrowDown: 5,
  KeyS: 5,
  south: 5,
  ArrowLeft: 7,
  KeyA: 7,
  west: 7,
};

interface Still {
  x: number;
  y: number;
  dir: number;
}

/** The own creature once it stands still: no step drawn and none waiting for the server. */
async function standStill(page: Page): Promise<Still> {
  let still: Still | undefined;
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.__rpgClient?.self());
        still = s && !s.pending && !s.walking ? { x: s.x, y: s.y, dir: s.dir } : undefined;
        return still !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  if (!still) throw new Error("no own creature");
  return still;
}

/**
 * Turns the player toward `way` (a walking key, or a pad button's direction id) without a
 * step: one quick `tap` if it faces another way (MOV-2), checking that it did not move.
 */
export async function faceToward(page: Page, way: string, tap: () => Promise<void>): Promise<void> {
  const want = DIRS[way];
  if (want === undefined) throw new Error(`not a way to walk: ${way}`);
  const before = await standStill(page);
  if (before.dir === want) return;
  await tap();
  await expect
    .poll(() => page.evaluate(() => window.__rpgClient?.self()?.dir), { timeout: 10_000 })
    .toBe(want);
  const turned = await standStill(page);
  expect({ x: turned.x, y: turned.y }).toEqual({ x: before.x, y: before.y });
}

/** One step toward `way`: a `tap` to turn if the player faces another way, and one to walk. */
export async function stepToward(page: Page, way: string, tap: () => Promise<void>): Promise<void> {
  await faceToward(page, way, tap);
  await tap();
}

/** Turns toward a walking key's way (ArrowUp, KeyD...) without a step. */
export const faceKey = (page: Page, key: string): Promise<void> =>
  faceToward(page, key, () => page.keyboard.press(key));

/** One step with a walking key (ArrowUp, KeyD...), turning first if it must. */
export const stepKey = (page: Page, key: string): Promise<void> =>
  stepToward(page, key, () => page.keyboard.press(key));
