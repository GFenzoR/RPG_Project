// Logs in through the UI with an account and character created by the API, enters the
// test island, walks 5 steps (keyboard and click) and saves screenshots for review.
// Any console error or uncaught exception fails the test.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { parse } from "yaml";
import { psql } from "./psql.ts";
import { stepKey } from "./keys.ts";
import { closeWindow, openWindow } from "./windows.ts";
import { databaseUrl, puertoClientURL, puertoServerURL, serverURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(shots, `${name}.png`) });

/** What shotPose keeps on window while it holds the game's frames. */
interface PoseHold {
  e2eRaf?: typeof window.requestAnimationFrame | undefined;
  e2eHeld?: FrameRequestCallback[];
}

/**
 * What shotPose saw on the frame it shot: the creatures in the pose there, and the
 * server's attack events and departures the client still kept (`__rpgClient.attacks`,
 * `departures`), read on that same frame. With them a test checks that the pose came
 * from the server's word (A9) and not from the client's guess for an older server.
 */
interface Caught {
  ids: number[];
  attacks: { id: number; kind: number; targetId: number }[];
  departures: { id: number; reason: string }[];
  /** The tile of the first creature in the pose (a falling body: where it stays). */
  at: { x: number; y: number };
}

/** A fall is shot in its last FALL_SHOT_MS (before its last 60): the hit's effect is ending. */
const FALL_SHOT_MS = 300;
/** Tiles round a fall that its close-up shows (it rises a tile over its own). */
const CLOSE_W = 9;
const CLOSE_H = 7;

/**
 * A9 (docs/17 ANI-7): waits for a creature well into an attack pose (with clipOnly, an
 * attack clip like an LPC swing, not the 250 ms lunge of a single image) or a fall, holds
 * the canvas on that frame and takes screenshot `name`. The page sees the pose on an
 * animation frame (after a third of it, before its last 60 ms), so the frame drawn last
 * is in it; holding requestAnimationFrame keeps the game from drawing the next one until
 * the shot is taken (an attack lasts 250-360 ms, a screenshot can take longer). Attack:
 * clips for the first 20 s, then any; the whole page. A fall: late in it (its last
 * FALL_SHOT_MS, when the effect of the blow that killed it is ending), and a close-up of
 * CLOSE_W x CLOSE_H tiles round it, so the body is big in the shot (a body behind a taller
 * creature also shows as a see-through copy). Returns what it saw on that frame (Caught).
 */
async function shotPose(
  page: Page,
  name: string,
  kind: "attack" | "death",
  timeout: number,
): Promise<Caught> {
  const deadline = Date.now() + timeout;
  for (const clipOnly of kind === "attack" ? [true, false] : [false]) {
    const left = deadline - Date.now();
    const handle = await page
      .waitForFunction(
        ({ k, clips, late }): Caught | false => {
          const c = window.__rpgClient;
          const p = c?.poses();
          if (!c || !p) return false;
          const list = k === "death" ? p.dying : p.attacking.filter((a) => !clips || a.of > 300);
          const from = (x: { of: number }): number =>
            k === "death" ? Math.max(x.of / 3, x.of - late) : x.of / 3;
          const posed = list.filter((x) => x.ms > from(x) && x.ms < x.of - 60);
          const first = posed[0];
          if (!first) return false;
          const ids = posed.map((x) => x.id);
          const w = window as unknown as PoseHold;
          const held: FrameRequestCallback[] = [];
          w.e2eHeld = held;
          w.e2eRaf = window.requestAnimationFrame;
          window.requestAnimationFrame = (cb) => {
            held.push(cb);
            return 0;
          };
          return {
            ids,
            attacks: c.attacks(5_000),
            departures: c.departures(5_000),
            at: { x: first.x, y: first.y },
          };
        },
        { k: kind, clips: clipOnly, late: FALL_SHOT_MS },
        { timeout: clipOnly ? Math.min(20_000, left) : left, polling: "raf" },
      )
      .catch(() => undefined);
    if (!handle) continue;
    try {
      const caught = await handle.jsonValue();
      if (caught && kind === "death") await closeShot(page, name, caught.at);
      else await shot(page, name);
      if (caught) return caught;
    } finally {
      await page.evaluate(() => {
        const w = window as unknown as PoseHold;
        const raf = w.e2eRaf;
        if (!raf) return;
        window.requestAnimationFrame = raf;
        w.e2eRaf = undefined;
        for (const cb of w.e2eHeld ?? []) window.requestAnimationFrame(cb);
        w.e2eHeld = [];
      });
    }
  }
  throw new Error(`no ${kind} pose caught on a screenshot in ${timeout} ms`);
}

/** Screenshot `name` of the CLOSE_W x CLOSE_H tiles round tile `at` (inside the page). */
async function closeShot(page: Page, name: string, at: { x: number; y: number }): Promise<void> {
  const { a, b } = await page.evaluate(({ x, y }) => {
    const c = window.__rpgClient;
    return { a: c?.tileToClient(x, y), b: c?.tileToClient(x + 1, y + 1) };
  }, at);
  const size = page.viewportSize();
  if (!a || !b || !size) throw new Error("no canvas for the close-up");
  const tw = b.x - a.x;
  const th = b.y - a.y;
  // The body rises about a tile over its own: one row more above than below.
  const x = Math.max(0, Math.round(a.x - (CLOSE_W / 2) * tw));
  const y = Math.max(0, Math.round(a.y - (CLOSE_H / 2 + 0.5) * th));
  const width = Math.min(size.width - x, Math.round(CLOSE_W * tw));
  const height = Math.min(size.height - y, Math.round(CLOSE_H * th));
  await page.screenshot({ path: join(shots, `${name}.png`), clip: { x, y, width, height } });
}

/** Random letters with no vowels, so a name never contains a reserved word. */
function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
}

/**
 * Leaves the game with "Salir del juego" right after a fight. The server refuses a logout
 * for travel.combat_block_ms (12 s) after the last blow given or taken
 * (`combat.logout_locked`, docs/02 "Bloqueo de logout en combate") and the connection
 * stays, so this asks again every 2 s until the player is out: the fight ends when the
 * wolf dies (the player keeps hitting its target) or when the player does (it wakes at the
 * temple, where the death ends the block; the death screen is closed first).
 */
async function leaveAfterFight(page: Page): Promise<void> {
  const status = page.getByRole("status");
  const out = async (): Promise<boolean> =>
    (await status.allTextContents()).some((t) => t.includes("Saliste del juego."));
  const death = page.getByTestId("death-screen");
  const leave = page.getByRole("button", { name: "Salir del juego" });
  await expect
    .poll(
      async () => {
        if (await out()) return true;
        if (await death.isVisible())
          await death
            .getByRole("button", { name: "Aceptar" })
            .click({ timeout: 1_000 })
            .catch(() => undefined);
        if (await leave.isVisible()) await leave.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 120_000, intervals: [2_000] },
    )
    .toBe(true);
  await expect(status).toHaveText("Saliste del juego.");
}

interface Self {
  x: number;
  y: number;
  z: number;
  pending: boolean;
  walking: boolean;
}

const self = (page: Page): Promise<Self | undefined> =>
  page.evaluate(() => window.__rpgClient?.self());

/**
 * Waits until the own creature stands still and confirmed on (x, y). A hop of 5-6 tiles
 * takes ~4-5 s at level 1 (base_step_ms and the vocation's start speed), which is right at
 * expect.poll's default 5 s on a slow CI runner, so allow a generous timeout: it still
 * fails if the creature never gets there.
 */
/**
 * Uses the map tile at client point (x, y) at once: Ctrl+right click (docs/17 UI-6). A plain
 * right click on a tile without a creature opens its menu with the item's card.
 */
async function useAt(page: Page, x: number, y: number): Promise<void> {
  await page.keyboard.down("Control");
  await page.mouse.click(x, y, { button: "right" });
  await page.keyboard.up("Control");
}

/**
 * Keys go to the game: the focus leaves whatever took it (a text field takes the arrow keys,
 * input/keyboard.ts takesText). Not a click: since docs/17 UI-4 the map starts at the
 * page's top left corner, and a click there walks towards that tile.
 */
async function keysToGame(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el !== document.body) el.blur();
  });
}

/**
 * Page coordinates of the centre of map tile (x, y) when the canvas is what is there, or
 * undefined: since the full-screen desktop (docs/17 A14) the battle list (top left), the
 * inventory (top right) and the chat (bottom left) float over the map, and a click on a
 * tile under one of them goes to the window.
 */
async function mapPoint(
  page: Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number } | undefined> {
  return page.evaluate(
    ({ a, b }) => {
      const p = window.__rpgClient?.tileToClient(a, b);
      const el = p && document.elementFromPoint(p.x, p.y);
      return p && el instanceof HTMLCanvasElement && el.dataset["testid"] === "game-canvas"
        ? p
        : undefined;
    },
    { a: x, b: y },
  );
}

/**
 * Waits until the own creature stands still at most `reach` tiles from (x, y): for a walk
 * to where wolves roam, one of which can take the clicked tile before the player gets there
 * (the click's path then stops next to it).
 */
async function arrivedNear(page: Page, x: number, y: number, reach: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await self(page);
        if (!s || s.pending || s.walking) return "moving";
        return Math.max(Math.abs(s.x - x), Math.abs(s.y - y)) <= reach ? "near" : `${s.x},${s.y}`;
      },
      { timeout: 20_000 },
    )
    .toBe("near");
}

async function arrived(page: Page, x: number, y: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await self(page);
        return s && !s.pending && !s.walking ? `${s.x},${s.y}` : "moving";
      },
      { timeout: 20_000 },
    )
    .toBe(`${x},${y}`);
}

test("log in, enter the world and walk 5 steps", async ({ page, playwright }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  // Account and character through the HTTP API (as the bots do).
  const email = `e2e-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Walker ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  expect(login.status()).toBe(200);
  const { token } = (await login.json()) as { token: string };
  const created = await apiCtx.post("/api/characters", {
    data: { name, vocation: "guardian" },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(created.status()).toBe(201);
  await apiCtx.dispose();

  // Login screen (Spanish by default), a look at sign-up, then log in.
  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await expect(loginForm).toBeVisible();
  await page.getByRole("button", { name: "¿No tienes cuenta? Regístrate" }).click();
  await expect(page.getByTestId("register-form")).toBeVisible();
  await shot(page, "01-register");
  await page.getByRole("button", { name: "¿Ya tienes cuenta? Entra" }).click();
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill("wrong-password");
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Email o contraseña incorrectos.");
  // The failed login answers 401, which the browser logs as a console error: expected.
  errors.length = 0;
  await loginForm.getByLabel("Contraseña").fill(password);
  await shot(page, "02-login");
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();

  // Character list → play.
  const list = page.getByTestId("characters");
  await expect(list.getByText(name)).toBeVisible();
  await expect(list.getByText("Guardián · Nivel 1")).toBeVisible();
  await shot(page, "03-characters");
  await list.getByRole("button", { name: "Jugar" }).click();

  // The world: FullMapView drawn on a pixel-perfect canvas: the largest view of the 31x21
  // window that fills the map's box at a whole scale, never less than the classic 15x11
  // (client/CLAUDE.md "Zoom del mapa").
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  const canvas = page.getByTestId("game-canvas");
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((c: HTMLCanvasElement) => ({
    width: c.width,
    height: c.height,
    css: c.getBoundingClientRect().width,
    dpr: window.devicePixelRatio,
  }));
  const scale = await page.evaluate(() => window.__rpgClient?.scale() ?? 0);
  expect(Number.isInteger(scale) && scale >= 1).toBe(true);
  expect(size.width % scale).toBe(0);
  expect(size.height % scale).toBe(0);
  const view = await page.evaluate(() => window.__rpgClient?.view());
  expect(view?.server).toEqual({ width: 31, height: 21 });
  expect(view?.shown.width ?? 0).toBeGreaterThanOrEqual(15);
  expect(view?.shown.height ?? 0).toBeGreaterThanOrEqual(11);
  expect(view?.shown.width ?? 99).toBeLessThanOrEqual(31);
  expect(view?.shown.height ?? 99).toBeLessThanOrEqual(21);
  expect(size.css * size.dpr).toBe(size.width);
  const start = await self(page);
  if (!start) throw new Error("no own creature");
  await page.waitForTimeout(300); // let the atlas textures upload before the screenshot
  await shot(page, "04-world");

  // 3 steps with the keyboard (arrow, WASD, arrow), each predicted and then confirmed.
  let { x, y } = start;
  const z = start.z;
  const walkable = (tx: number, ty: number): Promise<boolean> =>
    page.evaluate(({ a, b, c }) => window.__rpgClient?.walkable(a, b, c) ?? false, {
      a: tx,
      b: ty,
      c: z,
    });
  const keySteps: [string, number, number][] = [
    ["ArrowRight", 1, 0],
    ["KeyD", 1, 0],
    ["ArrowDown", 0, 1],
  ];
  for (const [key, dx, dy] of keySteps) {
    expect(await walkable(x + dx, y + dy)).toBe(true);
    await stepKey(page, key);
    x += dx;
    y += dy;
    await arrived(page, x, y);
  }
  await shot(page, "05-walked-keyboard");

  // 2 more by clicking a tile two columns to the right (the client's route, each step a
  // Walk).
  expect(await walkable(x + 1, y)).toBe(true);
  expect(await walkable(x + 2, y)).toBe(true);
  const target = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
    a: x + 2,
    b: y,
  });
  if (!target) throw new Error("no canvas");
  await page.mouse.click(target.x, target.y);
  x += 2;
  await arrived(page, x, y);
  expect({ x: x - start.x, y: y - start.y }).toEqual({ x: 4, y: 1 });
  await shot(page, "06-walked-click");

  // Inventory (T1.8), in the Diablo II style (docs/17 UI-5): a new character starts with an
  // equipped backpack, and the inventory opens it by itself, its grid under the figure (not
  // a window of its own). Its × closes it; a right click on it opens its menu with its card
  // (docs/17 UI-6) and "Abrir" (the default action, in bold) opens it again, under the
  // figure; shift+click looks at it, and it can be dragged onto the map and back.
  const inventory = page.getByTestId("inventory");
  const backpackSlot = inventory.getByTestId("slot-backpack");
  await expect(backpackSlot.locator("[data-item=backpack]")).toBeVisible();
  const docked = inventory.locator('[data-container-item="backpack"][data-docked]');
  await expect(docked).toBeVisible();
  await expect(docked.locator(".slot")).toHaveCount(24);
  await expect(page.getByTestId("window-container-backpack")).toHaveCount(0);
  await docked.getByRole("button", { name: "Cerrar" }).click();
  await expect(docked).toHaveCount(0);
  await backpackSlot.locator("[data-item]").click({ button: "right" });
  const itemMenu = page.getByTestId("action-menu");
  await expect(itemMenu).toBeVisible();
  await expect(itemMenu.getByTestId("item-card")).toContainText("Contenedor");
  await expect(itemMenu.getByTestId("item-card")).toContainText("Lugares");
  await expect(itemMenu.locator('[data-action="open"]')).toHaveClass(/default/);
  await shot(page, "09a-item-menu");
  await itemMenu.locator('[data-action="open"]').click();
  await expect(itemMenu).toBeHidden();
  await expect(docked).toBeVisible(); // opened from the slot: under the figure again
  await expect(page.getByTestId("window-container-backpack")).toHaveCount(0);
  // The same card, compact, shows the moment the mouse is over the item (the Diablo II
  // idea, docs/17 UI-6), beside it and never over it, and goes when the mouse leaves.
  await page.mouse.move(1, 1);
  const backpackItem = backpackSlot.locator("[data-item]");
  await backpackItem.hover();
  const tooltip = page.getByTestId("item-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("mochila");
  await expect(tooltip.getByTestId("item-card")).toHaveClass(/tip/);
  const tipBox = await tooltip.boundingBox();
  const itemBox = await backpackItem.boundingBox();
  if (!tipBox || !itemBox) throw new Error("no tooltip or item box");
  const apart =
    tipBox.y + tipBox.height <= itemBox.y + 0.5 || tipBox.y >= itemBox.y + itemBox.height - 0.5;
  expect(apart).toBe(true);
  await shot(page, "09b-item-tooltip");
  await page.mouse.move(1, 1);
  await expect(tooltip).toBeHidden();
  await backpackItem.click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("game-log")).toContainText("Ves: mochila (24 lugares)");
  await expect(inventory.getByTestId("capacity")).toContainText("Capacidad libre");
  await inventory.screenshot({ path: join(shots, "09-inventory.png") });

  const drag = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Promise<void> => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
  };
  const backpackId = await page.evaluate(() => window.__rpgClient?.itemNumber("backpack"));
  const ownTile = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
    a: x,
    b: y,
  });
  await backpackSlot.scrollIntoViewIfNeeded();
  const slotBox = await backpackSlot.boundingBox();
  if (!ownTile || !slotBox || backpackId === undefined) throw new Error("no drag points");
  const slotCenter = { x: slotBox.x + slotBox.width / 2, y: slotBox.y + slotBox.height / 2 };
  // Slot → own tile on the map: the slot empties and the tile shows the backpack on top.
  await drag(slotCenter, ownTile);
  await expect(backpackSlot.locator("[data-item]")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(({ a, b, c }) => window.__rpgClient?.tile(a, b, c)?.at(-1), {
        a: x,
        b: y,
        c: z,
      }),
    )
    .toBe(backpackId);
  // Still within reach, it stays open: no longer worn, in a window of its own.
  const backpackWindow = page.getByTestId("window-container-backpack");
  await expect(backpackWindow).toBeVisible();
  await expect(backpackWindow.locator('[data-container-item="backpack"]')).toBeVisible();
  await expect(docked).toHaveCount(0);
  await shot(page, "10-backpack-on-map");
  // Map → slot: equipped again. The client cannot tell this backpack from another of its
  // kind (ContainerOpen does not say where it lies), so its window stays a window of its
  // own: never under the figure by itself (the final review of lote 9). A use of the slot
  // closes that window (it is the worn one: the server toggles), the next one opens it
  // under the figure.
  await backpackSlot.scrollIntoViewIfNeeded();
  const emptyBox = await backpackSlot.boundingBox();
  if (!emptyBox) throw new Error("no slot");
  await drag(ownTile, { x: emptyBox.x + emptyBox.width / 2, y: emptyBox.y + emptyBox.height / 2 });
  await expect(backpackSlot.locator("[data-item=backpack]")).toBeVisible();
  await expect(backpackWindow).toBeVisible();
  await expect(docked).toHaveCount(0);
  await backpackSlot.locator("[data-item]").dblclick();
  await expect(backpackWindow).toHaveCount(0);
  await expect(docked).toHaveCount(0);
  await backpackSlot.locator("[data-item]").dblclick();
  await expect(docked).toBeVisible();
  await expect(backpackWindow).toHaveCount(0);

  // Leave the game: back to the character list with the server's reason.
  await page.getByRole("button", { name: "Salir del juego" }).click();
  await expect(page.getByRole("status")).toHaveText("Saliste del juego.");

  expect(errors).toEqual([]);
});

test("walk out of town, fight a wolf from the battle list", async ({ page, playwright }) => {
  // Leaving at the end waits out the fight's logout block (leaveAfterFight), after a
  // reload in the fight and a second login.
  test.setTimeout(330_000);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-fight-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Fighter ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  // Opening the page without a session cookie answers 401 (logged by the browser): expected.
  errors.length = 0;
  const battle = page.getByTestId("battle-list");
  // The wolves of testisle roam 11-19 tiles north of the temple: with the 31x21 view one
  // on the south edge of its spawn is already in view (11 tiles is the margin).
  await expect(
    battle
      .getByText("No hay criaturas a la vista.")
      .or(battle.getByRole("button", { name: /lobo/ }))
      .first(),
  ).toBeVisible();

  // Walk towards the wolves.
  const start = await self(page);
  if (!start) throw new Error("no own creature");
  const click = async (x: number, y: number): Promise<void> => {
    const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: x,
      b: y,
    });
    if (!p) throw new Error("no canvas");
    await page.mouse.click(p.x, p.y);
  };
  await click(start.x, start.y - 5);
  await arrived(page, start.x, start.y - 5);

  // A wolf shows up in the battle list: attack it from there. With the 31x21 view it may be
  // farther than a wolf notices us (8 tiles to the sides, 6 up and down), so chase it; from
  // here the northern rows of the spawn stay out of view, where a killed wolf respawns.
  await page.getByLabel("Perseguir al objetivo").check();
  const wolf = battle.getByRole("button", { name: /lobo/ }).first();
  await expect(wolf).toBeVisible({ timeout: 30_000 });
  await wolf.click();
  // The battle list is sorted by distance and wolves move, so `wolf` (first()) can point
  // at another wolf by now: check that exactly one entry is the target instead.
  await expect(battle.locator('button[aria-pressed="true"]')).toHaveCount(1);
  const target = await page.evaluate(() => window.__rpgClient?.target());
  expect(target).toBeDefined();

  // Blows are exchanged: the wolf's health bar or ours goes down.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const c = window.__rpgClient;
          const s = c?.stats();
          const t = c?.battle().find((b) => b.id === c.target());
          return (s !== undefined && s.health < s.maxHealth) || (t !== undefined && t.health < 100);
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  // Screenshot while a damage number is on screen (the effect shows with it).
  await expect
    .poll(() => page.evaluate(() => window.__rpgClient?.floatingTexts(200) ?? 0), {
      timeout: 15_000,
      intervals: [50],
    })
    .toBeGreaterThan(0);
  await shot(page, "07-combat");
  // A9: the server says who attacks whom (docs/17 ANI-7): a CreatureAttack of the player
  // at its wolf or of the wolf. Without those events the client still plays poses, guessed
  // from the effects and projectiles (an older server), so the poses alone prove nothing.
  await expect
    .poll(
      () =>
        page.evaluate(
          (wolf) =>
            (window.__rpgClient?.attacks(1_000) ?? []).some(
              (a) => a.id === wolf || a.targetId === wolf,
            ),
          target,
        ),
      { timeout: 15_000, intervals: [100] },
    )
    .toBe(true);
  // An attack pose, the own player's swing or the wolf's lunge, and on that same frame the
  // CreatureAttack of a creature in it, which started it.
  const swing = await shotPose(page, "07b-attack-pose", "attack", 30_000);
  expect(swing.attacks.filter((a) => swing.ids.includes(a.id))).not.toEqual([]);

  // In the middle of the fight the game cannot be left (docs/02 "Bloqueo de logout en
  // combate"): the server refuses, the notice over the map says why and the player stays.
  await page.getByRole("button", { name: "Salir del juego" }).click();
  const locked = page.getByTestId("notices").locator('[data-key="combat.logout_locked"]');
  await expect(locked).toBeVisible();
  await expect(locked).toContainText("Estás en combate");
  await expect(page.getByRole("button", { name: "Salir del juego" })).toBeVisible();
  // The lock is visible before any click (owner 2026-11-23): the "En combate" status with
  // its seconds in the tray, and the toolbar's button greyed with the countdown.
  await expect(
    page.getByTestId("conditions").locator('[data-condition="in_combat"]'),
  ).toBeVisible();
  await expect(page.getByTestId("logout")).toHaveAttribute("data-locked", "");
  await expect(page.getByTestId("logout-countdown")).toHaveText(/^\d+$/);
  await shot(page, "07c-logout-locked");

  // Every swing trains the sword (the start kit's cutlass, docs/02 "Equipo inicial"): the
  // skills window (toolbar, K) shows the progress.
  await openWindow(page, "skills");
  const skills = page.getByTestId("skills-panel");
  await expect(skills.getByText("Espada")).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__rpgClient?.skills().find((s) => s.id === "sword")?.percent ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await expect(skills.locator('[data-skill="sword"] [role="progressbar"]')).not.toHaveAttribute(
    "aria-valuenow",
    "0",
  );
  await skills.screenshot({ path: join(shots, "08-skills-panel.png") });

  // Reloading the page in the fight (the same as closing the tab: the connection closes)
  // leaves the character in the world, link-dead, while the wolf keeps biting it (docs/02
  // "Bloqueo de logout en combate"). The character list says so, and playing again takes
  // over that same character, still in its fight: the logout is still locked.
  const inCombat = page.getByTestId("conditions").locator('[data-condition="in_combat"]');
  const death = page.getByTestId("death-screen");
  // The fight must be going on when the page reloads: by now the wolf may be dead (the
  // lock ran out) or the player may have died and woken up at the temple. Go back to the
  // wolves if so, attack one if none is the target, and wait for a blow given or taken
  // within the last 1.5 s: the 12 s lock is then almost whole.
  await expect
    .poll(
      async () => {
        if (await death.isVisible()) {
          await death
            .getByRole("button", { name: "Aceptar" })
            .click({ timeout: 1_000 })
            .catch(() => undefined);
          return false;
        }
        const state = await page.evaluate(() => {
          const c = window.__rpgClient;
          const target = c?.target();
          return {
            wolves: c?.battle().length ?? 0,
            target,
            fresh:
              target !== undefined &&
              (c?.attacks(1_500) ?? []).some((a) => a.id === target || a.targetId === target),
          };
        });
        if (state.target === undefined) {
          const at = await self(page);
          if (state.wolves === 0 && at && !at.walking) await click(at.x, at.y - 5);
          await battle
            .getByRole("button", { name: /lobo/ })
            .first()
            .click({ timeout: 1_000 })
            .catch(() => undefined);
          return false;
        }
        return state.fresh && (await inCombat.isVisible());
      },
      { timeout: 90_000, intervals: [500] },
    )
    .toBe(true);

  // What the server says, not the page: how many players are in the world (GET
  // /api/status, published by the game loop on every join and leave) and when the
  // character was last saved (a character that leaves is saved at once).
  const serverCtx = await playwright.request.newContext({ baseURL: serverURL });
  const online = async (): Promise<number> =>
    ((await (await serverCtx.get("/api/status")).json()) as { players: number }).players;
  const savedAt = (): string =>
    psql(
      [
        databaseUrl,
        "-At",
        "-c",
        `SELECT coalesce(last_save_at::text, '') FROM characters WHERE name = '${name}'`,
      ],
      { encoding: "utf8" },
    ).trim();
  const onlineBefore = await online();
  const savedBefore = savedAt();
  expect(onlineBefore).toBeGreaterThan(0);

  await page.reload();
  const characters = page.getByTestId("characters");
  await expect(characters.getByRole("status")).toContainText("quedó en el mundo");
  await shot(page, "07d-stayed-in-fight");
  // The page is on the character list: its socket has been closed for a while. A server
  // that took the character out when the socket closed has one player less and a save
  // of it by now. (Either alone can happen to a character that stayed: a link-dead player
  // of an earlier test leaving, or its own autosave, every 5 minutes.)
  await page.waitForTimeout(3_000);
  const left = (await online()) < onlineBefore && savedAt() !== savedBefore;
  await serverCtx.dispose();

  await characters.getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  // Link-dead it can die too (the wolf kept biting): then it did leave the world, by
  // dying, and wakes up at the temple with the death screen and no fight.
  await expect(inCombat.or(death).first()).toBeVisible({ timeout: 10_000 });
  if (!(await death.isVisible())) {
    expect(left, "the character left the world when the page closed in a fight").toBe(false);
    await expect(page.getByTestId("logout")).toHaveAttribute("data-locked", "");
    // Link-dead, it dropped its target: hit the wolf again so the fight can end.
    await battle
      .getByRole("button", { name: /lobo/ })
      .first()
      .click({ timeout: 5_000 })
      .catch(() => undefined);
  }

  await leaveAfterFight(page);
  expect(errors).toEqual([]);
});

/**
 * Where to wait for a wolf when none is in view: 11 tiles south of the centre of
 * testisle_wolves ((1056, 1041), radius 4, world/islands/testisle/spawns.yaml). The server
 * never respawns a monster on a tile a player sees (the 31x21 view: 11 rows up and down
 * with the margin), so standing on the spawn would keep it empty; from here its 4 northern
 * rows are out of view and the other 5 in it. A wolf notices us only within the classic
 * 15x11 window (8 tiles to the sides, 6 up and down), so one in view but farther away is
 * chased ("Perseguir al objetivo").
 */
const WOLF_WAIT = { x: 1056, y: 1052 };

test("an arcanist casts a spell with F1 and by its words", async ({ page, playwright }) => {
  // Finding a wolf can take one respawn (respawn_seconds 60) when earlier tests (or
  // --repeat-each) killed them all; killing one at the end (A9) can take another, and
  // leaving after it waits out the fight's logout block (leaveAfterFight).
  test.setTimeout(450_000);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-magic-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Mage ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "arcanist" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0; // the 401 of opening the page without a session cookie

  // The bar starts with the arcanist's spells by level: F1 is the arc bolt.
  const hotbar = page.getByTestId("hotbar");
  await expect(hotbar.locator('[data-hotkey="F1"] [data-spell="arc_bolt"]')).toBeVisible();
  await expect(hotbar.locator('[data-hotkey="F1"]')).toContainText("rayo de arco");

  // Words that are no spell do nothing; a spell without a target is refused by the server.
  const sayInput = page.getByTestId("say").getByRole("textbox");
  await sayInput.fill("fulgur iacio");
  await sayInput.press("Enter");
  await expect(page.getByTestId("game-log")).toContainText("Necesitas un objetivo.");

  // Walk towards the wolves of testisle and target the first one that shows up.
  const start = await self(page);
  if (!start) throw new Error("no own creature");
  const click = async (x: number, y: number): Promise<void> => {
    const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: x,
      b: y,
    });
    if (!p) throw new Error("no canvas");
    await page.mouse.click(p.x, p.y);
  };
  await click(start.x, start.y - 5);
  await arrived(page, start.x, start.y - 5);
  await click(start.x, start.y - 9);
  // Chase the target: a hurt wolf flees and never comes within the bolt's range on its own.
  // The player is faster than a wolf, so chasing closes in.
  await page.getByLabel("Perseguir al objetivo").check();
  const battle = page.getByTestId("battle-list");

  // The server and its world are shared by the suite (and by --repeat-each): earlier tests
  // hurt or kill testisle's 3 wolves, so the nearest one may be hurt, die to our wand
  // before it is in the bolt's range, or none may be in view at all. Then every F1 is
  // refused with "you need a target" (the CI failure: target lost, empty battle list).
  // targetWolf attacks the healthiest wolf in view and, with none in view, waits for one
  // at WOLF_WAIT; a killed wolf respawns after respawn_seconds (60), so allow for one.
  const targetWolf = async (): Promise<void> => {
    await expect
      .poll(
        async () => {
          const c = await page.evaluate(() => {
            const r = window.__rpgClient;
            return {
              target: r?.target(),
              self: r?.self(),
              wolves: (r?.battle() ?? []).filter((b) => b.contentId === "wolf"),
            };
          });
          if (c.target !== undefined) return true;
          const best = c.wolves.sort((a, b) => b.health - a.health)[0];
          if (best) {
            // It may leave the list (dies, walks out of view) right now: try again then.
            await battle
              .locator(`button[data-creature="${best.id}"]`)
              .click({ timeout: 1_000 })
              .catch(() => undefined);
          } else if (c.self && !c.self.pending && !c.self.walking) {
            const dx = Math.max(-6, Math.min(6, WOLF_WAIT.x - c.self.x));
            const dy = Math.max(-4, Math.min(4, WOLF_WAIT.y - c.self.y));
            if (dx !== 0 || dy !== 0) await click(c.self.x + dx, c.self.y + dy);
          }
          return false;
        },
        { timeout: 90_000, intervals: [250] },
      )
      .toBe(true);
    await keysToGame(page);
  };

  // F1 until the bolt flies (the wolf must be within 4 tiles and in sight), then catch
  // the projectile or its energy effect on screen. They live 250 ms and a bolt can kill the
  // wolf, so watch for them in the page rather than only right after each F1 (on a busy
  // CPU the bolt's messages can come after the next poll has seen the target gone). If the
  // target is lost with no bolt (killed by the wand, out of view), take another wolf.
  // The start kit's wand (docs/02 "Equipo inicial") shoots the same energy projectile on its
  // own every round, so a projectile alone is not the spell: it counts while F1 is in the
  // cooldown the server starts when it accepts the cast (2 s for the arc bolt).
  await page.evaluate(() => {
    const w = window as unknown as { e2eBolt?: boolean };
    w.e2eBolt = false;
    const watch = setInterval(() => {
      const m = window.__rpgClient?.magic(300);
      const cast = document.querySelector('[data-testid="hotbar"] [data-hotkey="F1"] .cd') !== null;
      if (cast && ((m?.projectiles ?? 0) > 0 || (m?.effects ?? []).includes(13))) {
        w.e2eBolt = true;
        clearInterval(watch);
      }
    }, 20);
  });
  const boltSeen = (): Promise<boolean> =>
    page.evaluate(() => (window as unknown as { e2eBolt?: boolean }).e2eBolt === true);
  for (let round = 1; ; round++) {
    await targetWolf();
    let outcome = "casting";
    try {
      await expect
        .poll(
          async () => {
            if (await boltSeen()) outcome = "bolt";
            else if ((await page.evaluate(() => window.__rpgClient?.target())) === undefined) {
              // Give a bolt that killed the target time to show before calling it lost.
              await page.waitForTimeout(500);
              outcome = (await boltSeen()) ? "bolt" : "lost";
            } else await page.keyboard.press("F1");
            return outcome;
          },
          { timeout: 30_000, intervals: [250] },
        )
        .not.toBe("casting");
    } catch (e) {
      // Say why no bolt flew: the server answers every refused cast with a game-log message
      // (out of range, no sight, no mana, not ready...), so the log tells the cause.
      const state = await page.evaluate(() => {
        const c = window.__rpgClient;
        return { self: c?.self(), target: c?.target(), battle: c?.battle(), stats: c?.stats() };
      });
      const log = (await page.getByTestId("game-log").textContent())?.slice(-600);
      throw new Error(`no arc bolt within 30 s: ${JSON.stringify(state)}; game log: ${log}`, {
        cause: e,
      });
    }
    if (outcome === "bolt") break;
    if (round === 3) throw new Error("lost the target 3 times before the arc bolt flew");
  }
  await shot(page, "11-spell");
  // The cast spent mana and started the cooldown shade on F1.
  await expect(hotbar.locator('[data-hotkey="F1"] .cd')).toBeVisible();
  await hotbar.screenshot({ path: join(shots, "12-hotbar.png") });

  // A9: bolts (and the wand) until a wolf dies, and its fall on screen: the server's
  // CreatureDisappear says DEATH (docs/17 ANI-7). A lost target is replaced.
  let fell = false;
  const fall = shotPose(page, "11b-death", "death", 150_000);
  fall.then(
    () => {
      fell = true;
    },
    () => undefined, // its failure surfaces in the race below
  );
  while (!fell) {
    if ((await page.evaluate(() => window.__rpgClient?.target())) === undefined) await targetWolf();
    await page.keyboard.press("F1");
    await Promise.race([fall, page.waitForTimeout(500)]);
  }
  // It falls because its CreatureDisappear said DEATH, not because its health bar was
  // empty (the client's guess with an older server, which would fall the same).
  const dead = await fall;
  for (const id of dead.ids) expect(dead.departures).toContainEqual({ id, reason: "DEATH" });

  await leaveAfterFight(page);
  expect(errors).toEqual([]);
});

test("T3.1: create a druid in the form and heal; a ranger's arrows in the ammo slot", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-voc-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const druidName = `Druid ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const rangerName = `Ranger ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name: rangerName, vocation: "ranger" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();
  // The ranger: a backpack (48), a short bow (89) in the right hand and 30 arrows (87) in
  // the ammo slot (slots 3, 5 and 10; data/ids.lock.yaml).
  psql([
    databaseUrl,
    "-c",
    `INSERT INTO inventory_items (character_id, slot, item_id, count)
     SELECT id, s.slot, s.item, s.count FROM characters,
       (VALUES (3, 48, 1), (5, 89, 1), (10, 87, 30)) AS s(slot, item, count)
     WHERE name = '${rangerName}'`,
  ]);

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  errors.length = 0; // the 401 of opening the page without a session cookie

  // docs/02 "Cuentas": with a character the list comes first, with "Crear personaje nuevo";
  // the form has "Volver" back to it.
  const chars = page.getByTestId("characters");
  await expect(chars).toHaveAttribute("data-view", "list");
  await expect(chars.getByText("Montaraz · Nivel 1")).toBeVisible();
  await expect(page.getByTestId("create-character")).toHaveCount(0);
  await shot(page, "18b-characters-list");
  await page.getByTestId("new-character").click();
  await expect(page.getByTestId("create-back")).toBeVisible();
  await page.getByTestId("create-back").click();
  await expect(chars).toHaveAttribute("data-view", "list");
  await page.getByTestId("new-character").click();

  // The creation form offers the four vocations, each with its style and its starting gear
  // (docs/02 "Equipo inicial"); create the druid there.
  const form = page.getByTestId("create-character");
  const select = form.getByLabel("Vocación");
  await expect(select.locator("option")).toHaveText([
    "Guardián",
    "Arcanista",
    "Montaraz",
    "Druida",
  ]);
  await form.getByLabel("Nombre").fill(druidName);
  await select.selectOption({ label: "Druida" });
  await expect(form.getByTestId("vocation-style")).toHaveText(
    "Cura a sus compañeros a distancia y castiga con hielo y naturaleza.",
  );
  await expect(form.getByTestId("vocation-kit")).toContainText("vara de retoño");
  // docs/02 "Apariencia": a look picked on the form, with the live figure beside it. The
  // druid is a woman (the owner, 2026-11-20): "Mujer" is the first picker.
  const druidLook = {
    sex: "female",
    body: "slender",
    skin: "olive",
    hair: "long",
    hairColor: "red",
    beard: "none",
  };
  const pickers = form.getByTestId("look-pickers");
  for (const [part, id] of Object.entries(druidLook)) {
    const choice = pickers.locator(`[data-look="${part}:${id}"]`);
    await choice.click();
    await expect(choice).toHaveAttribute("aria-pressed", "true");
  }
  await expect(form.getByTestId("look-preview").locator("canvas")).toBeVisible();
  await expect(pickers.locator('[data-look-part="sex"] legend')).toHaveText("Sexo");
  await expect(pickers.locator('[data-look="sex:female"]')).toHaveText("Mujer");
  await shot(page, "19-create-druid");
  await form.getByRole("button", { name: "Crear personaje" }).click();
  // Back to the list, with the new character marked and its figure.
  const list = page.getByTestId("characters");
  await expect(list).toHaveAttribute("data-view", "list");
  await expect(list.getByText("Druida · Nivel 1")).toBeVisible();
  const druidRow = list.locator("li[data-created]");
  await expect(druidRow).toContainText(druidName);
  await expect(druidRow.getByTestId("character-look")).toBeVisible();
  await expect(list.getByText("Montaraz · Nivel 1")).toBeVisible();

  // Play the druid: its spells fill the bar by level.
  await list.locator("li", { hasText: druidName }).getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  // The server keeps the look it was created with and sends it in its Creature.
  const ownLook = (name: string): Promise<unknown> =>
    page.evaluate((n) => window.__rpgClient?.players().find((p) => p.name === n)?.look, name);
  // The server keeps her sex too (BodyLook.sex = female) and the canvas draws her body.
  await expect.poll(() => ownLook(druidName)).toEqual(druidLook);
  const hotbar = page.getByTestId("hotbar");
  await expect(hotbar.locator('[data-hotkey="F1"] [data-spell="frost_lance"]')).toBeVisible();
  await expect(hotbar.locator('[data-hotkey="F2"] [data-spell="verdant_mend"]')).toBeVisible();
  await expect(hotbar.locator('[data-hotkey="F3"] [data-spell="mend_other"]')).toBeVisible();
  await keysToGame(page);

  // F2 heals the druid itself: the server spends 20 mana and starts the cooldown.
  const mana = (): Promise<number | undefined> =>
    page.evaluate(() => window.__rpgClient?.stats()?.mana);
  const before = await mana();
  if (before === undefined) throw new Error("no stats");
  await page.keyboard.press("F2");
  await expect.poll(mana).toBe(before - 20);
  await expect(hotbar.locator('[data-hotkey="F2"] .cd')).toBeVisible();
  await shot(page, "20-druid-heal");

  // F3 (mend other) asks for a target with the crosshair; Escape cancels it.
  await page.keyboard.press("F3");
  await expect(page.locator("body.using-item")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("body.using-item")).toHaveCount(0);
  await hotbar.screenshot({ path: join(shots, "21-druid-hotbar.png") });
  await page.getByRole("button", { name: "Salir del juego" }).click();
  await expect(page.getByRole("status")).toHaveText("Saliste del juego.");

  // The ranger: the bow in hand and the arrows, with their count, in the ammo slot.
  await list.locator("li", { hasText: rangerName }).getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  const inventory = page.getByTestId("inventory");
  await expect(
    inventory.getByTestId("slot-right_hand").locator("[data-item=short_bow]"),
  ).toBeVisible();
  const ammo = inventory.getByTestId("slot-ammo");
  await expect(ammo.locator("[data-item=arrow]")).toBeVisible();
  await expect(ammo.locator(".count")).toHaveText("30");
  // What it shows it wears comes from the server too: the bow in its right hand (89).
  await expect
    .poll(() =>
      page.evaluate(
        (n) => window.__rpgClient?.players().find((p) => p.name === n)?.equipment.rightHand,
        rangerName,
      ),
    )
    .toBe(89);
  await expect(hotbar.locator('[data-hotkey="F1"] [data-spell="sure_shot"]')).toBeVisible();
  await inventory.screenshot({ path: join(shots, "22-ranger-inventory.png") });
  await page.getByRole("button", { name: "Salir del juego" }).click();
  await expect(page.getByRole("status")).toHaveText("Saliste del juego.");
  expect(errors).toEqual([]);
});

test("talk to NPCs: dialog options with 1–9 and a shop", async ({ page, playwright }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-npc-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Talker ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();
  // Puerto's NPCs live on Velmara (T1.16): this character's residence is Lanternby, so
  // it wakes up at that temple, next to the priestess and the provisioner. Level 9: the
  // temples bless from there on (content audit m8; novices are covered already).
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'puerto', level = 9, experience = 6912 WHERE name = '${name}'`,
  ]);

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  // Where the own tile is on the screen at the very moment the client publishes its hooks
  // (ready), before any frame is drawn: the camera was only set by the first frame, which
  // Pixi may skip on a busy page, and on CI the Shift+click on the sign right after `ready`
  // went far off the canvas and read nothing.
  await page.evaluate(() => {
    type Aim = { x: number; y: number } | null;
    let hooks: Window["__rpgClient"];
    Object.defineProperty(window, "__rpgClient", {
      configurable: true,
      get: () => hooks,
      set(v: Window["__rpgClient"]) {
        hooks = v;
        const s = v?.ready ? v.self() : undefined;
        (window as Window & { __firstAim?: Aim }).__firstAim = s
          ? (v?.tileToClient(s.x, s.y) ?? null)
          : null;
      },
    });
  });
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0; // the 401 of opening the page without a session cookie
  const firstAim = await page.evaluate(
    () => (window as Window & { __firstAim?: { x: number; y: number } | null }).__firstAim,
  );
  const canvasBox = await page.getByTestId("game-canvas").boundingBox();
  if (!firstAim || !canvasBox) throw new Error("no aim at ready or no canvas");
  expect(firstAim.x).toBeGreaterThan(canvasBox.x);
  expect(firstAim.x).toBeLessThan(canvasBox.x + canvasBox.width);
  expect(firstAim.y).toBeGreaterThan(canvasBox.y);
  expect(firstAim.y).toBeLessThan(canvasBox.y + canvasBox.height);

  const npc = async (id: string): Promise<{ id: number; x: number; y: number }> => {
    let found: { id: number; x: number; y: number } | undefined;
    await expect
      .poll(async () => {
        const list = await page.evaluate(() => window.__rpgClient?.npcs() ?? []);
        found = list.find((n) => n.contentId === id);
        return found !== undefined;
      })
      .toBe(true);
    if (!found) throw new Error(`no NPC ${id}`);
    return found;
  };
  const tileClient = async (x: number, y: number): Promise<{ x: number; y: number }> => {
    const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: x,
      b: y,
    });
    if (!p) throw new Error("no canvas");
    return p;
  };

  // The sign of Lanternby's temple stands by its east doorway (puerto_temple_sign, on the
  // texts.yaml sign of the same id): in view from the temple, Shift+click reads it.
  const sign = await tileClient(3163, 6384);
  await page.mouse.move(sign.x, sign.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(sign.x, sign.y);
  await page.keyboard.up("Shift");
  const log = page.getByTestId("game-log");
  await expect(log).toContainText(
    "Ves: cartel. Templo del Farol. Dentro de sus muros nadie puede hacerte daño.",
  );
  // The log is a tab of the chat box on desktop (docs/17 UI-10): show it for the
  // screenshot, then go back to the chat for the next shots.
  await page.locator('[data-chat-tab="log"]').click();
  await shot(page, "12b-puerto-temple-sign");
  await page.locator('[data-chat-tab="chat"]').click();

  // The priestess stands next to the temple: right click opens her dialog.
  const priest = await npc("puerto_priest");
  let p = await tileClient(priest.x, priest.y);
  await page.mouse.click(p.x, p.y, { button: "right" });
  const dialog = page.getByTestId("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Hermana Liora");
  await expect(dialog.locator("[data-option]").first()).toContainText("1");
  // Key 1 picks the first option (the blessings); the server sends the next node.
  await page.keyboard.press("Digit1");
  await expect(dialog.locator("[data-option]")).toHaveCount(6);
  await shot(page, "13-dialog");
  await dialog.screenshot({ path: join(shots, "13-dialog-window.png") });
  // A blessing costs 50 + 20 per level (230 at level 9, content audit M6): the server
  // refuses a character with no money.
  await page.keyboard.press("Digit1");
  await expect(page.getByTestId("game-log")).toContainText("No tienes suficiente dinero.");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Walk to the provisioner and open the shop.
  const prov = await npc("puerto_provisioner");
  p = await tileClient(prov.x - 2, prov.y - 1);
  await page.mouse.click(p.x, p.y);
  await arrived(page, prov.x - 2, prov.y - 1);
  p = await tileClient(prov.x, prov.y);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Quiero comerciar/ }).click();
  const shop = page.getByTestId("shop");
  await expect(shop).toBeVisible();
  await expect(page.getByTestId("shop-money")).toHaveText("Dinero: 0");
  await expect(shop.locator('[data-item="rope"]')).toContainText("45");
  await page.waitForTimeout(300); // let the icons load before the screenshot
  await shot(page, "14-shop");
  // No scroll bar: the grid pages instead (docs/17 UI-8). The window's body is what would
  // scroll: the frame is not a scroller, and its gothic corners stick out 5 px past it.
  expect(
    await shop.locator(".gwin-body").evaluate((el) => el.scrollHeight - el.clientHeight),
  ).toBeLessThanOrEqual(1);
  await shop.getByRole("tab", { name: "Vender" }).click();
  await shop.getByTestId("shop-search").fill("piel de lobo");
  await expect(shop.locator('[data-item="wolf_pelt"]')).toContainText("×0");
  await shot(page, "14b-shop-sell");

  // Walking away (keyboard: the windows cover part of the map) closes both windows.
  await keysToGame(page);
  for (let i = 0; i < 3; i++) {
    const before = await self(page);
    await stepKey(page, "ArrowLeft");
    if (before) await arrived(page, before.x - 1, before.y);
  }
  await expect(dialog).toBeHidden();
  await expect(shop).toBeHidden();

  await page.getByRole("button", { name: "Salir del juego" }).click();
  await expect(page.getByRole("status")).toHaveText("Saliste del juego.");
  expect(errors).toEqual([]);
});

test("die to a wolf: death screen and wake up at the temple", async ({ page, playwright }) => {
  // Finding a wolf can take one respawn (respawn_seconds 60) when earlier tests killed them.
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-death-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Doomed ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();
  // One hit point left, so the first wolf bite is deadly (the name is letters and a space).
  // Level 10, past the novice levels (novice_max_level 8): the backpack falls into the corpse
  // (docs/02 "Muerte", "Bolsillos").
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET health = 1, level = 10, experience = 9720 WHERE name = '${name}'`,
  ]);

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0;
  await expect(page.getByTestId("health")).toContainText("Vida 1/");

  // Walk north to the wolves (as in the fight test) and wait for them.
  const start = await self(page);
  if (!start) throw new Error("no own creature");
  const click = async (x: number, y: number): Promise<void> => {
    const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: x,
      b: y,
    });
    if (!p) throw new Error("no canvas");
    await page.mouse.click(p.x, p.y);
  };
  const screen = page.getByTestId("death-screen");
  await click(start.x, start.y - 5);
  // A roaming wolf may bite first, on the way: then the character is already back at the
  // temple and nothing else is needed.
  await expect
    .poll(
      async () => {
        if (await screen.isVisible()) return true;
        const s = await self(page);
        return s?.x === start.x && s.y === start.y - 5;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  // Then chase the nearest wolf in view (as in the fight test): with the 31x21 view it may
  // be farther than a wolf notices us, and from here the northern rows of the spawn stay
  // out of view, where a killed wolf respawns.
  if (!(await screen.isVisible())) await page.getByLabel("Perseguir al objetivo").check();
  const wolf = page.getByTestId("battle-list").getByRole("button", { name: /lobo/ }).first();
  await expect
    .poll(
      async () => {
        if (await screen.isVisible()) return true;
        const target = await page.evaluate(() => window.__rpgClient?.target());
        // It may leave the list (dies, walks out of view) right now: try again then.
        if (target === undefined && (await wolf.isVisible()))
          await wolf.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 100_000, intervals: [500] },
    )
    .toBe(true);
  await expect(screen).toContainText("Has muerto");
  await page.waitForTimeout(300);
  await shot(page, "13-death");

  // Awake at the temple (where a new character starts) with full health.
  await expect
    .poll(async () => {
      const s = await self(page);
      return s ? Math.max(Math.abs(s.x - start.x), Math.abs(s.y - start.y)) <= 3 : false;
    })
    .toBe(true);
  await expect(page.getByTestId("health")).not.toContainText("Vida 1/");
  await screen.getByRole("button", { name: "Aceptar" }).click();
  await expect(screen).toBeHidden();
  // docs/02 "Bolsillos": no death gives a backpack any more. The character wakes up with an
  // empty backpack slot and its four pockets, empty too (what they held fell with the
  // backpack), under the figure of the inventory.
  const inventory = page.getByTestId("inventory");
  await expect(inventory.getByTestId("slot-backpack").locator("[data-item]")).toHaveCount(0);
  await expect(inventory.getByTestId("pockets").locator('[data-drop="pocket"]')).toHaveCount(4);
  await expect(inventory.getByTestId("pockets").locator("[data-item]")).toHaveCount(0);
  expect(await page.evaluate(() => window.__rpgClient?.pockets())).toEqual({
    capacity: 4,
    items: [],
  });
  await page.waitForTimeout(300);
  await shot(page, "14-respawn");
  expect(errors).toEqual([]);
});

test("mine an iron vein with a pickaxe", async ({ page, playwright }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-mine-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Miner ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();
  // A backpack (48) and a pickaxe (38) in the right hand (data/ids.lock.yaml slots 3 and 5).
  psql([
    databaseUrl,
    "-c",
    `INSERT INTO inventory_items (character_id, slot, item_id)
     SELECT id, s.slot, s.item FROM characters, (VALUES (3, 48), (5, 38)) AS s(slot, item)
     WHERE name = '${name}'`,
  ]);
  // Mining 38: the iron vein's chance is at its max (0.3 + 0.02 per level over 10, up to
  // 0.85, data/items/decoration.yaml). At 0.3 a run of bad swings (each 1.5 s apart, ~3 s
  // on a loaded single core) could take longer than the test, and a wolf wandering in
  // from earlier tests gets that much longer to kill a level-1 miner.
  psql([
    databaseUrl,
    "-c",
    `INSERT INTO character_skills (character_id, skill, level)
     SELECT id, 'mining', 38 FROM characters WHERE name = '${name}'
     ON CONFLICT (character_id, skill) DO UPDATE SET level = 38, tries = 0`,
  ]);

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0;

  const toClient = async (x: number, y: number): Promise<{ x: number; y: number }> => {
    const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: x,
      b: y,
    });
    if (!p) throw new Error("no canvas");
    return p;
  };
  // The iron veins of testisle are at (1068, 1054) and (1069, 1054), east of the temple.
  const veins = [
    { x: 1068, y: 1054 },
    { x: 1069, y: 1054 },
  ];
  // Walk next to the veins by clicking on the map. The view shows 7 tiles on each side, so
  // it takes hops. The server and its world are shared by the suite (and by
  // --repeat-each): a wolf hurt by an earlier test flees into town and hovers around, on
  // and off the tiles on our way. The client finds no path to a tile with a creature on
  // it and sends nothing (the CI failure: still on the spawn after 20 s), and the server
  // walks around a creature or stops short. So, like a player would, whenever standing
  // still short of the goal, click again on a free tile towards it (or on the goal).
  const me = await self(page);
  if (!me) throw new Error("no own creature");
  const goal = { x: 1068, y: 1055 };
  const free = (x: number, y: number): Promise<boolean> =>
    page.evaluate(({ a, b, c }) => window.__rpgClient?.walkable(a, b, c) ?? false, {
      a: x,
      b: y,
      c: me.z,
    });
  await expect
    .poll(
      async () => {
        const s = await self(page);
        if (!s || s.pending || s.walking) return "moving";
        if (s.x === goal.x && s.y === goal.y) return "there";
        // 5 columns at most: at 1280x800 the inventory floats over the 6th to the east.
        const hx = s.x + Math.max(-5, Math.min(5, goal.x - s.x));
        const hy = s.y + Math.max(-4, Math.min(4, goal.y - s.y));
        const near = hx === goal.x && hy === goal.y;
        const tries = near
          ? [[0, 0]]
          : [
              [0, 0],
              [-1, 0],
              [0, -1],
              [0, 1],
              [-1, -1],
              [-1, 1],
              [-2, 0],
            ];
        for (const [dx = 0, dy = 0] of tries) {
          if (!(await free(hx + dx, hy + dy))) continue;
          const p = await mapPoint(page, hx + dx, hy + dy);
          if (!p) continue; // under a window
          await page.mouse.click(p.x, p.y);
          break;
        }
        return `${s.x},${s.y}`;
      },
      { timeout: 40_000, intervals: [1_000] },
    )
    .toBe("there");
  let p: { x: number; y: number };

  // A double click on the pickaxe does its default action, "use with" (docs/17 UI-6); the
  // next click on the map uses it there.
  // A vein is spent after 4 good swings and grows back 5 minutes after its last one
  // (data/items/decoration.yaml). The world is shared by the suite and by --repeat-each,
  // so earlier miners may have spent the first vein: swinging at it again only answers
  // "agotado" and leaves us standing among the wolves for nothing (the failure under
  // load: half the swings wasted, then killed by a wolf before a good one). Mine the first
  // vein until it says it is spent, then the second one. The log keeps its last lines, so
  // an old "agotado" stays visible: switch once and never back.
  const pickaxe = page.getByTestId("slot-right_hand").locator("[data-item=pickaxe]");
  const log = page.getByTestId("game-log");
  let vein = 0;
  for (let i = 0; i < 16; i++) {
    await pickaxe.dblclick();
    await expect(page.locator("body")).toHaveClass(/using-item/);
    const v = veins[vein];
    if (!v) throw new Error("no vein");
    p = await toClient(v.x, v.y);
    await page.mouse.click(p.x, p.y);
    await expect(page.locator("body")).not.toHaveClass(/using-item/);
    await page.waitForTimeout(350); // the answer arrives; its effect lasts 600 ms
    const text = (await log.textContent()) ?? "";
    if (text.includes("Conseguiste")) break;
    if (vein === 0 && text.includes("agotado")) vein = 1;
    await page.waitForTimeout(1300); // gathering.use_interval_ms
  }
  // The item's name, not the raw {item} placeholder.
  await expect(log).toContainText(/Conseguiste [^{}]+\./);
  await shot(page, "15-mining");
  expect(errors).toEqual([]);
});

test("chat on the local and global channels, then switch the language", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-chat-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Talker ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0; // the 401 of opening the page without a session cookie

  // Markup typed by a player shows as text: no element is created from it.
  const chat = page.getByTestId("chat-log");
  const sayInput = page.getByTestId("say").getByRole("textbox");
  await sayInput.fill("<b>hola</b> {name}");
  await sayInput.press("Enter");
  await expect(chat).toContainText(`${name} dice: <b>hola</b> {name}`);
  await expect(chat.locator("b")).toHaveCount(0);
  // docs/17 UI-11: what is said nearby also shows over the speaker's head, as plain text.
  const bubbleSaid = (style: string, text: string) =>
    page.waitForFunction(
      ([s, x]) =>
        (window.__rpgClient?.bubbles() ?? []).some((b) => b.style === s && b.lines.join(" ") === x),
      [style, text] as const,
    );
  await bubbleSaid("say", "<b>hola</b> {name}");

  await page.getByTestId("chat-channel").selectOption({ label: "Gritar" });
  await sayInput.fill("hay alguien");
  await sayInput.press("Enter");
  await expect(chat).toContainText(`${name} grita: hay alguien`);
  await bubbleSaid("yell", "hay alguien");
  await shot(page, "16a-chat-bubble");

  await page.getByTestId("chat-channel").selectOption({ label: "Global" });
  await sayInput.fill("hola a todos");
  await sayInput.press("Enter");
  await expect(chat).toContainText(`[Global] ${name}: hola a todos`);
  // The global channel is heard from anywhere: no bubble over the head.
  expect(
    (await page.evaluate(() => window.__rpgClient?.bubbles() ?? [])).some((b) =>
      b.lines.join(" ").includes("hola a todos"),
    ),
  ).toBe(false);
  // The global channel waits between two messages (balance.yaml chat.global_interval_ms).
  await sayInput.fill("otra vez");
  await sayInput.press("Enter");
  await expect(page.getByTestId("game-log")).toContainText(
    "para volver a escribir en el canal global.",
  );
  // The chat floats over the map (docs/17 UI-10): its window.
  await page.locator('.gwin[data-window="chat"]').screenshot({ path: join(shots, "16-chat.png") });

  // Windows resize from their four corners (docs/17 UI-5, the owner's request of
  // 2026-11-23): dragging the chat's top left corner up and left moves its left and top and
  // keeps its bottom right where it was. No move button is left in any title bar.
  const chatWindow = page.locator('.gwin[data-window="chat"]');
  await expect(page.locator(".gwin-move")).toHaveCount(0);
  await expect(chatWindow.locator(".gwin-resize")).toHaveCount(4);
  const before = await chatWindow.boundingBox();
  const grip = await chatWindow.locator('.gwin-resize[data-corner="nw"]').boundingBox();
  if (!before || !grip) throw new Error("no chat box");
  const gripAt = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await page.mouse.move(gripAt.x, gripAt.y);
  await page.mouse.down();
  await page.mouse.move(gripAt.x - 40, gripAt.y - 90, { steps: 8 });
  await page.mouse.up();
  const after = await chatWindow.boundingBox();
  if (!after) throw new Error("no chat box");
  // The bottom right stays (to the px); the top left moved (the magnet may take up to
  // SNAP_PX of it, an edge of another window or of the screen).
  expect(Math.abs(after.x + after.width - (before.x + before.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(after.y + after.height - (before.y + before.height))).toBeLessThanOrEqual(1);
  expect(before.x - after.x).toBeGreaterThanOrEqual(30);
  expect(before.y - after.y).toBeGreaterThanOrEqual(80);
  await expect(chatWindow).toHaveAttribute("data-sized", "");
  await expect(page.locator("body")).not.toHaveClass(/resizing-window/);
  await shot(page, "16b-chat-resized-top-left");

  // Switching the language (the Options window of the toolbar) translates every screen at
  // once, the running game included.
  await openWindow(page, "options");
  await page.getByTestId("options").getByTestId("language").selectOption("en");
  await expect(chat).toContainText(`${name} says: <b>hola</b> {name}`);
  await expect(chat).toContainText(`[Global] ${name}: hola a todos`);
  await expect(page.getByRole("button", { name: "Leave game" })).toBeVisible();
  await expect(page.getByTestId("chat-channel")).toContainText("Yell");
  await shot(page, "17-language-en");

  // The choice is remembered: without ?lang= the next visit opens in English.
  await page.goto("/play/");
  await expect(page.getByTestId("characters").getByRole("button", { name: "Play" })).toBeVisible();
  await expect(page.getByTestId("language")).toHaveValue("en");
  expect(errors).toEqual([]);
});

test("a GM announces, a player cannot use staff commands, and a ban disconnects", async ({
  browser,
  playwright,
}) => {
  const password = "e2e-password-1";
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  /** Registers an account with one guardian and returns its email and character name. */
  async function account(prefix: string, title: string): Promise<{ email: string; name: string }> {
    const email = `e2e-${prefix}-${Date.now()}-${randomLetters(6)}@example.com`;
    const name = `${title} ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
    expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
      201,
    );
    const login = await apiCtx.post("/api/auth/login", {
      data: { email, password, token_in_body: true },
    });
    const { token } = (await login.json()) as { token: string };
    const created = await apiCtx.post("/api/characters", {
      data: { name, vocation: "guardian" },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(created.status()).toBe(201);
    return { email, name };
  }
  const gm = await account("gm", "Warden");
  const player = await account("pl", "Rover");
  await apiCtx.dispose();
  // Roles are only granted by the operator's tool (make set-role), never from the game.
  execFileSync(
    "go",
    [
      "run",
      "./cmd/gameserver",
      "admin",
      "set-role",
      "-email",
      gm.email,
      "-role",
      "gm",
      "-note",
      "e2e",
      // The e2e accounts never confirm their email (lote 16: set-role refuses that).
      "-allow-unverified",
    ],
    {
      cwd: join(import.meta.dirname, "..", "..", "server"),
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );

  async function enter(email: string): Promise<Page> {
    const page = await browser.newPage();
    await page.goto("/play/?lang=es");
    const form = page.getByTestId("login-form");
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Contraseña").fill(password);
    await form.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
    await page.waitForFunction(() => window.__rpgClient?.ready === true);
    return page;
  }
  const gmPage = await enter(gm.email);
  const plPage = await enter(player.email);
  const type = async (page: Page, text: string): Promise<void> => {
    const input = page.getByTestId("say").getByRole("textbox");
    await input.fill(text);
    await input.press("Enter");
  };

  // A player gets the same answer for a staff command as for any unknown command.
  await type(plPage, `/kick ${gm.name}`);
  await expect(plPage.getByTestId("game-log")).toContainText("Comando desconocido.");
  await expect(plPage.getByTestId("chat-log")).not.toContainText("/kick");

  // The announcement reaches everyone with its translated label; the GM's text as is.
  await type(gmPage, "/announce Reinicio en 5 minutos");
  const line = `[Anuncio] ${gm.name}: Reinicio en 5 minutos`;
  await expect(plPage.getByTestId("chat-log")).toContainText(line);
  await expect(gmPage.getByTestId("chat-log")).toContainText(line);
  await plPage
    .locator('.gwin[data-window="chat"]')
    .screenshot({ path: join(shots, "18-gm-announce.png") });

  // T4.1: a GM asks the player a presence check; any answer gets the same reply. It is
  // only asked to someone playing: the player says something first.
  await type(plPage, "hola");
  await type(gmPage, `/presence ${player.name}`);
  await expect(gmPage.getByTestId("game-log")).toContainText(
    `chequeo de presencia a ${player.name} en cuanto se pueda`,
  );
  const check = plPage.getByTestId("presence-check");
  await expect(check).toContainText("Chequeo de presencia");
  await expect(check.getByRole("button")).toHaveCount(4);
  await shot(plPage, "38-presence-check");
  // The question names no color (lote 16): it shows a swatch, read here by its hue as a
  // person would; no text of the question matches an option.
  const question = (await check.locator("p").first().textContent()) ?? "";
  expect(["rojo", "azul", "verde", "amarillo"].some((c) => question.includes(c))).toBe(false);
  const bg = await check
    .getByTestId("presence-swatch")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  const color = colorOfSwatch(bg);
  await check.getByRole("button", { name: new RegExp(color, "i") }).click();
  await expect(check).toHaveCount(0);
  await expect(plPage.getByTestId("game-log")).toContainText("Gracias por responder.");

  // The ban disconnects the player with its own message.
  await type(gmPage, `/ban ${player.name} 1h e2e`);
  await expect(gmPage.getByTestId("game-log")).toContainText(
    `Suspendiste la cuenta de ${player.name}.`,
  );
  await expect(plPage.getByRole("status")).toContainText("Tu cuenta fue suspendida");
  await shot(gmPage, "19-gm-ban");
  await shot(plPage, "20-banned");

  // And the next login is refused.
  const again = await browser.newPage();
  await again.goto("/play/?lang=es");
  const form = again.getByTestId("login-form");
  await form.getByLabel("Email").fill(player.email);
  await form.getByLabel("Contraseña").fill(password);
  await form.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(again.getByTestId("login-form")).toContainText("Esta cuenta está suspendida.");
  await shot(again, "21-banned-login");
  // Close them, like every test with pages of its own: left open, the GM's game kept
  // running beside every later test of the suite.
  for (const p of [gmPage, plPage, again]) await p.close();
});

test("T3.2: a guardian casts haste: its icon in the status tray, faster speed and steps", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-haste-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Swift ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();
  // Haste (swift_stride) needs level 8: 4704 experience on balance.yaml's curve, and the
  // guardian's 48 mana at that level.
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET level = 8, experience = 4704, mana = 48 WHERE name = '${name}'`,
  ]);

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0;

  const speed = async (): Promise<number> =>
    page.evaluate(() => window.__rpgClient?.stats()?.speed ?? 0);
  await expect.poll(speed).toBeGreaterThan(0);
  const before = await speed();
  // The status tray (docs/17 "Bandeja de estados"): bottom left over the life orb, left
  // of the chat. The temple may be a protection zone (a status too); no haste yet.
  const conditions = page.getByTestId("conditions");
  const hasted = conditions.locator('[data-condition="hasted"]');
  await expect(hasted).toHaveCount(0);

  // Cast it by its words: the server applies the condition and the faster speed.
  const sayInput = page.getByTestId("say").getByRole("textbox");
  await sayInput.fill("pede celeri");
  await sayInput.press("Enter");
  // Its own icon in a green frame (a buff), the seconds left on it, and its name and time
  // for screen readers; the tooltip says what it does.
  await expect(hasted).toBeVisible();
  await expect(hasted).toHaveAttribute("data-kind", "buff");
  await expect(hasted).toHaveAttribute("aria-label", /^Prisa, Quedan \d+ s$/);
  await expect(hasted.locator(".status-left")).toHaveText(/^\d+$/);
  await expect(hasted.locator(".status-icon")).toHaveCount(1); // its sprite, not the letter
  const tray = await conditions.boundingBox();
  const chat = await page.getByTestId("window-chat").boundingBox();
  const bar = await page.getByTestId("hud-bar").boundingBox();
  if (!tray || !chat || !bar) throw new Error("no tray, chat or bar");
  expect(tray.x + tray.width).toBeLessThanOrEqual(chat.x); // beside the chat, not under it
  expect(tray.y + tray.height).toBeLessThanOrEqual(bar.y); // over the bar
  await expect.poll(speed).toBeGreaterThan(before);
  const after = await speed();
  // balance.yaml: hasted is +35 %.
  expect(after).toBe(Math.floor((before * 135) / 100));

  // Steps take less: the client animates with the speed the server sent.
  await sayInput.blur();
  const start = await self(page);
  if (!start) throw new Error("no own creature");
  const t0 = Date.now();
  for (let i = 0; i < 3; i++) {
    await stepKey(page, "ArrowRight");
    await arrived(page, start.x + i + 1, start.y);
  }
  expect(Date.now() - t0).toBeLessThan(10_000);
  // The tooltip of the haste icon over the tray, in the full shot.
  await hasted.hover();
  await expect(hasted.locator(".status-tip")).toBeVisible();
  await expect(hasted.locator(".status-tip")).toContainText("Caminas más rápido.");
  await shot(page, "22-haste");
  await page.mouse.move(640, 300);
  // The bottom left of the screen: the tray over the life orb and the name plate (name and
  // level) on the experience bar, the percent on the bar (docs/17 "Placa del nombre").
  const shown = await conditions.boundingBox();
  if (!shown) throw new Error("no tray");
  await page.screenshot({
    path: join(shots, "23-conditions-hud.png"),
    clip: {
      x: 0,
      y: shown.y - 8,
      width: bar.x + bar.width,
      height: bar.y + bar.height - shown.y + 8,
    },
  });
  expect(errors).toEqual([]);
});

test("T3.3: two players form a party from the battle list and see the panel", async ({
  browser,
  playwright,
}) => {
  // The hunt for the party bonus waits for the wolves, and leaving waits out the fight.
  test.setTimeout(360_000);
  const password = "e2e-password-1";
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  async function account(prefix: string, title: string): Promise<{ email: string; name: string }> {
    const email = `e2e-${prefix}-${Date.now()}-${randomLetters(6)}@example.com`;
    const name = `${title} ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
    expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
      201,
    );
    const login = await apiCtx.post("/api/auth/login", {
      data: { email, password, token_in_body: true },
    });
    const { token } = (await login.json()) as { token: string };
    const created = await apiCtx.post("/api/characters", {
      data: { name, vocation: "guardian" },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(created.status()).toBe(201);
    return { email, name };
  }
  const lead = await account("party-a", "Leader");
  const mate = await account("party-b", "Mate");
  await apiCtx.dispose();
  // Level 8 guardians (243 health: 145 + 7 × 14, data/vocations.yaml; 4704 experience on
  // balance.yaml's curve): at level 1 the wolves of the hunt below could kill one before
  // the bonus showed, and the death screen covered the party window's screenshots.
  for (const who of [lead, mate])
    psql([
      databaseUrl,
      "-c",
      `UPDATE characters SET level = 8, experience = 4704, health = 243, mana = 48
         WHERE name = '${who.name}'`,
    ]);

  async function enter(email: string): Promise<Page> {
    const page = await browser.newPage();
    await page.goto("/play/?lang=es");
    const form = page.getByTestId("login-form");
    await form.getByLabel("Email").fill(email);
    await form.getByLabel("Contraseña").fill(password);
    await form.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
    await page.waitForFunction(() => window.__rpgClient?.ready === true);
    return page;
  }
  const leadPage = await enter(lead.email);
  const matePage = await enter(mate.email);

  // Both wake up at the temple: the mate is in the leader's battle list, with "+". The
  // party window (toolbar, P) floats beside the battle list.
  for (const page of [leadPage, matePage]) await openWindow(page, "party");
  const leadPanel = leadPage.getByTestId("party-panel");
  await expect(leadPanel).toContainText("No estás en un grupo.");
  // The help line says what a party gives.
  await expect(leadPage.getByTestId("party-help")).toContainText(
    "Cazar en grupo da más experiencia",
  );
  const invite = leadPage
    .getByTestId("battle-list")
    .locator("li", { hasText: mate.name })
    .getByRole("button", { name: "Invitar al grupo" });
  await invite.click();
  await expect(leadPage.getByTestId("game-log")).toContainText(`Invitaste a ${mate.name}`);

  const invitation = matePage.getByTestId("party-invitation");
  await expect(invitation).toContainText(`${lead.name} te invita a su grupo.`);
  await shot(matePage, "24-party-invitation");
  await invitation.getByRole("button", { name: "Aceptar" }).click();
  await expect(invitation).toHaveCount(0);

  // Both see the two members; the leader has the leader tag and the leader's buttons.
  for (const page of [leadPage, matePage]) {
    const panel = page.getByTestId("party-panel");
    await expect(panel.locator("li[data-member]")).toHaveCount(2);
    await expect(panel).toContainText(lead.name);
    await expect(panel).toContainText(mate.name);
    await expect(panel).toContainText("Líder");
    // Shared experience is on from the start (docs/02 "Grupos"), but nobody fought yet:
    // no sharing, no bonus, and the panel says why.
    await expect(page.getByTestId("party-shared")).toContainText(
      "Experiencia compartida: activada, sin reparto",
    );
    await expect(page.getByTestId("party-bonus")).toHaveCount(0);
    await expect(page.getByTestId("game-log")).toContainText("El grupo comparte la experiencia");
  }
  // Only the leader turns it off and on again.
  await expect(matePage.getByTestId("party-share")).toHaveCount(0);
  await leadPage.getByTestId("party-share").click();
  await expect(matePage.getByTestId("party-shared")).toContainText(
    "Experiencia compartida: apagada",
  );
  await leadPage.getByTestId("party-share").click();
  await expect(matePage.getByTestId("party-shared")).toContainText(
    "Experiencia compartida: activada, sin reparto",
  );
  await expect(matePage.getByTestId("game-log")).toContainText(
    "El líder activó la experiencia compartida.",
  );

  // Party chat.
  await matePage.getByTestId("chat-channel").selectOption({ label: "Grupo" });
  const input = matePage.getByTestId("say").getByRole("textbox");
  await input.fill("vamos a cazar");
  await input.press("Enter");
  await expect(leadPage.getByTestId("chat-log")).toContainText(
    `[Grupo] ${mate.name}: vamos a cazar`,
  );
  await leadPage
    .locator('.gwin[data-window="party"]')
    .screenshot({ path: join(shots, "25-party-panel.png") });

  // Both hunt the wolves north of the temple (as in "fight a wolf"): once both fought, the
  // party shares with its bonus (+5 % for two), the panel says it and who shares, and the
  // status tray shows the party bonus icon with its percentage.
  for (const [i, page] of [leadPage, matePage].entries()) {
    const me = await self(page);
    if (!me) throw new Error("no own creature");
    const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: me.x + i,
      b: me.y - 5,
    });
    if (!p) throw new Error("no canvas");
    await page.mouse.click(p.x, p.y);
    // A wolf can take the tile first: next to it is just as good for the hunt.
    await arrivedNear(page, me.x + i, me.y - 5, 1);
    await page.getByLabel("Perseguir al objetivo").check();
  }
  const bonusShown = async (page: Page): Promise<boolean> => {
    if ((await page.getByTestId("party-bonus").count()) > 0) return true;
    // Attack (again) the nearest wolf: one may have died or run off.
    if (
      (await page.locator('[data-testid="battle-list"] button[aria-pressed="true"]').count()) === 0
    ) {
      const wolf = page.getByTestId("battle-list").getByRole("button", { name: /lobo/ }).first();
      if (await wolf.isVisible()) await wolf.click({ timeout: 1_000 }).catch(() => undefined);
    }
    return false;
  };
  // Both pages every time (no short-circuit): while the leader waits for the bonus, the
  // mate must still pick a new wolf when its own dies, or the leader fights alone.
  await expect
    .poll(async () => [await bonusShown(leadPage), await bonusShown(matePage)].every(Boolean), {
      timeout: 120_000,
      intervals: [1_000],
    })
    .toBe(true);
  for (const page of [leadPage, matePage]) {
    await expect(page.getByTestId("party-bonus")).toContainText(
      "Bonus de grupo: +5 % de experiencia (2 comparten)",
    );
    await expect(page.getByTestId("party-panel").locator(".tag.sharing")).toHaveCount(2);
    const tray = page.locator('[data-testid="conditions"] [data-condition="party_bonus"]');
    await expect(tray.first()).toBeVisible();
    await expect(tray.first().locator(".status-left")).toHaveText("5%");
  }
  await leadPage
    .locator('.gwin[data-window="party"]')
    .screenshot({ path: join(shots, "25b-party-bonus.png") });
  await shot(leadPage, "25c-party-bonus-tray");

  // T4.1: the mate reports the leader from the battle list; the server answers.
  await matePage
    .getByTestId("battle-list")
    .locator("li", { hasText: lead.name })
    .getByRole("button", { name: "Reportar al equipo del juego" })
    .click();
  const report = matePage.getByTestId("report-form");
  await expect(report).toContainText(`Reportar a ${lead.name}`);
  // The field has the focus: typing goes to it, not to the game (WASD would walk).
  await expect(report.getByRole("textbox")).toBeFocused();
  const before = await self(matePage);
  await matePage.keyboard.type("prueba de reporte E2E");
  await expect(report.getByRole("textbox")).toHaveValue("prueba de reporte E2E");
  expect(await self(matePage)).toEqual(before);
  await matePage
    .locator('.gwin[data-window="battle"]')
    .screenshot({ path: join(shots, "37-report-form.png") });
  await report.getByRole("button", { name: "Enviar reporte" }).click();
  await expect(report).toHaveCount(0);
  await expect(matePage.getByTestId("game-log")).toContainText(
    `Tu reporte sobre ${lead.name} llegó al equipo del juego.`,
  );
  // Escape closes the form (the field has the focus).
  await matePage
    .getByTestId("battle-list")
    .locator("li", { hasText: lead.name })
    .getByRole("button", { name: "Reportar al equipo del juego" })
    .click();
  await expect(report.getByRole("textbox")).toBeFocused();
  // Clicking a "!" again with the form open gives the field the focus back.
  await matePage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(report.getByRole("textbox")).not.toBeFocused();
  await matePage
    .getByTestId("battle-list")
    .locator("li", { hasText: lead.name })
    .getByRole("button", { name: "Reportar al equipo del juego" })
    .click();
  await expect(report.getByRole("textbox")).toBeFocused();
  const still = await self(matePage);
  await matePage.keyboard.type("wasd");
  expect(await self(matePage)).toEqual(still);
  await matePage.keyboard.press("Escape");
  await expect(report).toHaveCount(0);

  // Leaving disbands a party of two: the bonus and its icon go.
  await matePage.getByTestId("party-leave").click();
  await expect(leadPanel).toContainText("No estás en un grupo.");
  await expect(leadPage.getByTestId("game-log")).toContainText("El grupo se disolvió.");
  await expect(leadPage.locator('[data-condition="party_bonus"]')).toHaveCount(0);
  for (const page of [leadPage, matePage]) {
    await page.getByLabel("Perseguir al objetivo").uncheck();
    await leaveAfterFight(page);
  }
  await leadPage.close();
  await matePage.close();
});

test("party: the window's Invitar button invites a player by its name", async ({
  browser,
  playwright,
}) => {
  const lead = await newGuardian(playwright, "Caller");
  const mate = await newGuardian(playwright, "Guest");
  const errors: string[] = [];
  const enter = async (who: { email: string; password: string }): Promise<Page> => {
    const page = await browser.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await enterGame(page, who.email, who.password);
    return page;
  };
  const leadPage = await enter(lead);
  const matePage = await enter(mate);
  errors.length = 0; // the 401 of opening the page without a session cookie
  await openWindow(leadPage, "party");
  const panel = leadPage.getByTestId("party-panel");
  const log = leadPage.getByTestId("game-log");
  const prompt = leadPage.getByTestId("party-invite-prompt");
  const field = leadPage.getByTestId("party-invite-name");

  // Without a party the button is there; it opens the prompt with the field focused.
  await leadPage.getByTestId("party-invite").click();
  await expect(field).toBeFocused();
  // Escape closes the prompt, not the window around it.
  await field.press("Escape");
  await expect(prompt).toHaveCount(0);
  await expect(panel).toBeVisible();

  // A name nobody online has: the server says so, with the name as typed. Typing in the
  // field moves nobody and opens no window (the name has the keys of both).
  const before = await self(leadPage);
  await leadPage.getByTestId("party-invite").click();
  await field.pressSequentially("Wasd Pibe");
  await expect(field).toHaveValue("Wasd Pibe");
  await field.press("Enter");
  await expect(prompt).toHaveCount(0);
  await expect(log).toContainText("No hay ningún jugador en línea llamado Wasd Pibe.");
  await expect(panel).toBeVisible();
  const after = await self(leadPage);
  expect([after?.x, after?.y]).toEqual([before?.x, before?.y]);

  // The other player, by its name in another case: it gets the usual invitation.
  await leadPage.getByTestId("party-invite").click();
  await field.fill(mate.name.toUpperCase());
  await leadPage
    .locator('.gwin[data-window="party"]')
    .screenshot({ path: join(shots, "24b-party-invite-prompt.png") });
  await shot(leadPage, "24c-party-invite-prompt-page");
  await leadPage.getByTestId("party-invite-send").click();
  await expect(prompt).toHaveCount(0);
  await expect(log).toContainText(`Invitaste a ${mate.name}`);
  const invitation = matePage.getByTestId("party-invitation");
  await expect(invitation).toContainText(`${lead.name} te invita a su grupo.`);
  await invitation.getByRole("button", { name: "Aceptar" }).click();
  await openWindow(matePage, "party");
  for (const page of [leadPage, matePage]) {
    const members = page.getByTestId("party-panel").locator("li[data-member]");
    await expect(members).toHaveCount(2);
  }
  // The leader keeps the button; a member that does not lead has none.
  await expect(leadPage.getByTestId("party-invite")).toBeVisible();
  await expect(matePage.getByTestId("party-invite")).toHaveCount(0);
  await leadPage
    .locator('.gwin[data-window="party"]')
    .screenshot({ path: join(shots, "24d-party-invite-leader.png") });
  expect(errors).toEqual([]);
  await leadPage.close();
  await matePage.close();
});

test("T3.4: cook a fish at the hearth of Lanternby from the station window", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-cook-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Cook ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();
  // Stand just south of Lanternby's cooking hearth (3172, 6366: world/islands/puerto), with a
  // backpack (48) holding 3 raw fish (10), and cooking 30 so the grilled fish is at its
  // 97% cap (data/recipes.yaml).
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'puerto', pos_x = 3172, pos_y = 6367, pos_z = 7 WHERE name = '${name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, 0, 10, 3 FROM bp;
     INSERT INTO character_skills (character_id, skill, level)
     SELECT id, 'cooking', 30 FROM characters WHERE name = '${name}'
     ON CONFLICT (character_id, skill) DO UPDATE SET level = 30, tries = 0`,
  ]);

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0;
  await arrived(page, 3172, 6367);

  // A right click on the hearth opens its menu (docs/17 UI-6) with its card; "Usar",
  // first and in bold, opens its recipes.
  const hearth = await page.evaluate(() => window.__rpgClient?.tileToClient(3172, 6366));
  if (!hearth) throw new Error("no canvas");
  await page.mouse.click(hearth.x, hearth.y, { button: "right" });
  const hearthMenu = page.getByTestId("action-menu");
  await expect(hearthMenu.locator('[data-action="use"]')).toHaveClass(/default/);
  await expect(hearthMenu.getByTestId("item-card")).toBeVisible();
  await expect(hearthMenu.locator('[data-action="move"]')).toHaveCount(0); // a fixture
  await hearthMenu.locator('[data-action="use"]').click();
  const win = page.getByTestId("crafting");
  await expect(win).toBeVisible();
  await expect(win.locator("h2")).toHaveText("fogón");
  const fish = win.locator("[data-recipe=cook_grilled_fish]");
  await expect(fish).toHaveClass(/ready/);
  await expect(fish.getByTestId("chance")).toContainText("97 %");
  // The stew lacks meat and seaweed, and needs cooking 6 (we have 30).
  await expect(win.locator("[data-recipe=cook_harbour_stew]")).toContainText("faltan");
  await shot(page, "16-crafting-window");

  // Cook until it works (3% failure); the window refreshes with the fish left.
  const log = page.getByTestId("game-log");
  for (let i = 0; i < 3; i++) {
    await fish.getByRole("button", { name: "Hacer" }).click();
    await page.waitForTimeout(400);
    if (((await log.textContent()) ?? "").includes("Has hecho")) break;
    await page.waitForTimeout(1800); // the recipe's time_ms
  }
  await expect(log).toContainText(/Has hecho [^{}]+\./);
  await openWindow(page, "skills");
  await expect(page.getByTestId("skills-panel")).toContainText("Cocina");
  await shot(page, "17-crafting-done");
  // Escape closes the station first (the Game's own key), whatever window is on top.
  await page.keyboard.press("Escape");
  await expect(win).toBeHidden();
  expect(errors).toEqual([]);
});

test("T3.5: sail from Puerto's dock to the test island with the harbor master", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-sail-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Sailor ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();
  // On the dock next to the harbor master (3201, 6433), with a backpack (48) holding 50
  // copper coins (8). The route is client/e2e/fixtures/boat_routes.yaml (30 coins).
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'puerto', pos_x = 3201, pos_y = 6431, pos_z = 7 WHERE name = '${name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, 0, 8, 50 FROM bp`,
  ]);

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0;
  await arrived(page, 3201, 6431);

  const master = await page.evaluate(() => window.__rpgClient?.tileToClient(3201, 6433));
  if (!master) throw new Error("no canvas");
  await page.mouse.click(master.x, master.y, { button: "right" });
  const dialog = page.getByTestId("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Quiero viajar." }).click();
  const route = dialog.getByRole("button", { name: /islote de ensayo/ });
  await expect(route).toBeVisible();
  await shot(page, "26-boat-routes");

  await route.click();
  await expect(page.getByTestId("voyage")).toContainText("Zarpaste hacia Pellwick");
  await shot(page, "27-boat-sailing");
  await expect(dialog).toBeHidden();
  await arrived(page, 1058, 1056);
  const log = page.getByTestId("game-log");
  await expect(log).toContainText("Pagaste 30 monedas.");
  await expect(log).toContainText("Zarpaste hacia Pellwick.");
  await expect(page.getByTestId("voyage")).toBeHidden({ timeout: 5000 });
  await shot(page, "28-boat-arrived");
  expect(errors).toEqual([]);
});

// Registers an account with one guardian and returns its credentials (T3.6 tests).
async function newGuardian(
  playwright: { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } },
  tag: string,
  base = serverURL,
): Promise<{ email: string; password: string; name: string }> {
  const email = `e2e-${tag}-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `${tag} ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: base });
  expect((await apiCtx.post("/api/auth/register", { data: { email, password } })).status()).toBe(
    201,
  );
  const login = await apiCtx.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();
  return { email, password, name };
}

async function enterGame(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
}

test("T3.6: sail to Selvaine after Chapter 1 and meet its ferryman", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const { email, password, name } = await newGuardian(playwright, "Rover");
  // Level 10 (9720 XP), Chapter 1 completed, on Puerto's dock with 100 copper coins (8)
  // in a backpack (48). The route asks for both and costs 80.
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'puerto', level = 10, experience = 9720, pos_x = 3201, pos_y = 6431, pos_z = 7 WHERE name = '${name}';
     INSERT INTO quest_state (character_id, key, value)
     SELECT id, 'quest.ch1_shipwreck', 2 FROM characters WHERE name = '${name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, 0, 8, 100 FROM bp`,
  ]);
  await enterGame(page, email, password);
  errors.length = 0;
  await arrived(page, 3201, 6431);

  const master = await page.evaluate(() => window.__rpgClient?.tileToClient(3201, 6433));
  if (!master) throw new Error("no canvas");
  await page.mouse.click(master.x, master.y, { button: "right" });
  const dialog = page.getByTestId("dialog");
  await dialog.getByRole("button", { name: "Quiero viajar." }).click();
  await dialog.getByRole("button", { name: "A Selvaine (80 monedas)." }).click();
  await expect(page.getByTestId("voyage")).toContainText("Zarpaste hacia Selvaine");
  await arrived(page, 4120, 6100);
  await expect(page.getByTestId("game-log")).toContainText("Pagaste 80 monedas.");
  await expect(page.getByTestId("voyage")).toBeHidden({ timeout: 5000 });
  await shot(page, "29-bosque-dock");

  // The ferryman of Ivernel sells the way back.
  const ferryman = await page.evaluate(() => window.__rpgClient?.tileToClient(4122, 6100));
  if (!ferryman) throw new Error("no canvas");
  await page.mouse.click(ferryman.x, ferryman.y, { button: "right" });
  await expect(dialog).toContainText("Tavin Rema");
  await dialog.getByRole("button", { name: "Quiero viajar." }).click();
  await expect(dialog.getByRole("button", { name: "A Velmara (60 monedas)." })).toBeVisible();
  await shot(page, "30-bosque-ferryman");
  expect(errors).toEqual([]);
});

test("T3.6: wake up at the temple of Ivernel and talk to the druid", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { email, password, name } = await newGuardian(playwright, "Rooted");
  // Resident of Selvaine with no saved position: wakes up at its temple.
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'bosque', level = 15, experience = 35280 WHERE name = '${name}';
     INSERT INTO quest_state (character_id, key, value)
     SELECT id, 'quest.ch1_shipwreck', 2 FROM characters WHERE name = '${name}'`,
  ]);
  await enterGame(page, email, password);
  await arrived(page, 4150, 6105);
  await shot(page, "31-bosque-temple");
  // Out of the temple door and east across the plaza to the druid's grove, by clicks: 5
  // columns at most, since at 1280x800 the inventory floats over the 6th to the east.
  for (const [x, y] of [
    [4150, 6109],
    [4155, 6109],
    [4160, 6109],
    [4165, 6109],
    [4170, 6110],
    [4175, 6110],
  ] as const) {
    const tile = await page.evaluate(({ tx, ty }) => window.__rpgClient?.tileToClient(tx, ty), {
      tx: x,
      ty: y,
    });
    if (!tile) throw new Error("no canvas");
    await page.mouse.click(tile.x, tile.y);
    await arrived(page, x, y);
  }
  await shot(page, "32-bosque-plaza");
  const druid = await page.evaluate(() => window.__rpgClient?.tileToClient(4178, 6112));
  if (!druid) throw new Error("no canvas");
  await page.mouse.click(druid.x, druid.y, { button: "right" });
  const dialog = page.getByTestId("dialog");
  await expect(dialog).toContainText("Velia Musgo");
  await dialog.getByRole("button", { name: "Vengo siguiendo un bote sin bandera." }).click();
  await expect(dialog.getByRole("button", { name: "Acepto." })).toBeVisible();
  await shot(page, "33-bosque-druid");
  expect(errors).toEqual([]);
});

test("T3.7: sound starts after the first gesture, follows the island, and volumes persist", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  // Headless Chromium plays to no device: spy on Web Audio to see what gets scheduled, and
  // on the media elements the music streams on (the second each one starts from). An
  // element with no file is the engine's play-and-pause within the first gesture (WebKit
  // lets it play later: StreamLike.bless), not a track starting.
  await page.addInitScript(() => {
    const w = window as unknown as { __audioStarts: number; __musicFrom: number[] };
    w.__audioStarts = 0;
    w.__musicFrom = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      w.__audioStarts++;
      return start.apply(this, args);
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (this.getAttribute("src") !== null) w.__musicFrom.push(this.currentTime);
      return play.call(this);
    };
  });
  const starts = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __audioStarts: number }).__audioStarts);
  const musicFrom = (): Promise<number[]> =>
    page.evaluate(() => (window as unknown as { __musicFrom: number[] }).__musicFrom);
  const history = (): Promise<string[]> => page.evaluate(() => window.__rpgAudio?.history() ?? []);

  const { email, password } = await newGuardian(playwright, "Hark");
  await page.goto("/play/?lang=es");
  // Nothing may start before a gesture (browser autoplay rules).
  expect(await page.evaluate(() => window.__rpgAudio?.unlocked())).toBe(false);
  expect(await starts()).toBe(0);
  expect(await musicFrom()).toEqual([]);
  // The first gesture starts the title screen's music (a track of the pool the owner picked
  // in assets/sounds.yaml music.title, through the music director), and no ambience.
  // Polling what plays proves its file arrived. The gesture is a click on the empty page: a
  // modifier key alone is no user activation for Chromium, and the context stays suspended.
  const sounds = parse(
    readFileSync(join(import.meta.dirname, "..", "..", "assets", "sounds.yaml"), "utf8"),
  ) as {
    music: { title?: string; islands: Record<string, string>; pools: Record<string, string[]> };
  };
  const pool = (id: string | undefined): string[] => sounds.music.pools[id ?? ""] ?? [];
  await page.mouse.click(4, 796);
  await expect
    .poll(async () => {
      const l = await page.evaluate(() => window.__rpgAudio?.loops());
      return l && l.ambient === undefined && pool(sounds.music.title).includes(l.music ?? "");
    })
    .toBe(true);

  await enterGame(page, email, password);
  errors.length = 0;
  expect(await page.evaluate(() => window.__rpgAudio?.unlocked())).toBe(true);
  // The test island plays a track of the harbour's pool, and under it the ambience of what
  // is around the player (livingworld/README.md "Ambiente"): its temple stands in a
  // meadow, so the soft breeze over the grass, and no sea (it is more than ten tiles off).
  await expect
    .poll(async () => {
      const l = await page.evaluate(() => window.__rpgAudio?.loops());
      return (
        l &&
        l.ambience.includes("amb_desert_wind") &&
        !l.ambience.includes("amb_waves") &&
        pool(sounds.music.islands["testisle"]).includes(l.music ?? "")
      );
    })
    .toBe(true);
  // Each track started at one of its entry points, never at its first second.
  await expect.poll(async () => (await musicFrom()).length).toBeGreaterThanOrEqual(1);
  for (const from of await musicFrom()) expect(from).toBeGreaterThan(0);
  // An own step makes a sound too. The engine drops a sound whose file is still loading
  // after LATE_MS (a late sound is worse than none), so on a slow runner the first step can
  // be silent: walk back and forth until one plays (its file is cached by then).
  const start = await self(page);
  if (!start) throw new Error("no own creature");
  for (let i = 0; ; i++) {
    await stepKey(page, "ArrowRight");
    await arrived(page, start.x + 1, start.y);
    const played = await expect
      .poll(history, { timeout: 2000 })
      .toContain("step")
      .then(
        () => true,
        () => false,
      );
    if (played || i === 4) break;
    await stepKey(page, "ArrowLeft");
    await arrived(page, start.x, start.y);
  }
  expect(await history()).toContain("step");
  expect(await starts()).toBeGreaterThanOrEqual(2); // the ambience and a step

  // Options (the toolbar's gear, docs/17 UI-5): lower the music, mute the effects.
  await page.getByTestId("options-button").click();
  const options = page.getByTestId("options");
  await expect(options.locator("h3").first()).toHaveText("Sonido");
  // T5.6: the controls section follows with the on-screen pad switch (off with a mouse).
  await expect(options.locator("h3").nth(1)).toHaveText("Controles");
  await expect(options.getByTestId("touch-pad-toggle")).not.toBeChecked();
  await options.getByTestId("volume-music").fill("20");
  await options.getByTestId("mute-sfx").check();
  await expect(options.locator(".channel").nth(1)).toContainText("Música");
  await expect(options.locator(".channel").nth(1).locator(".value")).toHaveText("20");
  await options.screenshot({ path: join(shots, "34-sound-options.png") });
  await shot(page, "35-sound-options-game");
  // docs/17 A1: the credits of the art and fonts, on the website in another tab.
  await expect(options.getByTestId("credits-link")).toHaveAttribute("href", "/credits");
  await expect(options.getByTestId("credits-link")).toHaveAttribute("target", "_blank");
  // Muted effects spend no voice: a step is silent now. The window closes with its ×
  // ("Cerrar Opciones").
  await options.getByRole("button", { name: "Cerrar" }).click();
  await expect(options).toHaveCount(0);
  const before = (await history()).length;
  await stepKey(page, "ArrowLeft");
  await arrived(page, start.x, start.y);
  expect((await history()).slice(before)).not.toContain("step");
  // Buttons sound on the interface channel, which is not muted. "Entrar" and "Jugar" may
  // have been dropped while the file loaded (see above); after the options clicks it is
  // cached, so one more button click plays.
  await page.getByTestId("options-button").click();
  await expect(options).toHaveCount(1);
  await options.getByRole("button", { name: "Cerrar" }).click();
  await expect.poll(history).toContain("click");

  // Saved: after a reload the panel (on the login screen) shows the same values.
  await page.reload();
  await page.locator(".corner").getByTestId("options-button").click();
  await expect(page.getByTestId("volume-music")).toHaveValue("20");
  await expect(page.getByTestId("mute-sfx")).toBeChecked();
  await expect(page.getByTestId("volume-master")).toHaveValue("80");
  await expect(page.locator(".corner").getByTestId("credits-link")).toHaveAttribute(
    "href",
    "/credits",
  );
  await shot(page, "36-sound-options-login");

  // The panel moves from the corner to the game's Options window: it must show what is in
  // use now, not what the page loaded with (no reload this time).
  await page.getByTestId("mute-ambient").check();
  // Closed first: the creation form's figure and pickers (lote 13) make the page taller
  // than 800 px, and the scrolled "Jugar" ends up under the corner's open panel.
  await page
    .locator(".corner")
    .getByTestId("options")
    .getByRole("button", { name: "Cerrar" })
    .click();
  await expect(page.getByTestId("options")).toHaveCount(0);
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  await page.getByTestId("options-button").click();
  const hud = page.getByTestId("options");
  await expect(hud.getByTestId("mute-ambient")).toBeChecked();
  await expect(hud.getByTestId("volume-music")).toHaveValue("20");
  await expect(hud.getByTestId("mute-sfx")).toBeChecked();
  // A change here keeps the others as they are, in the engine and in storage.
  await hud.getByTestId("volume-ui").fill("50");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("rpg.audio") ?? "{}"));
  expect(saved).toMatchObject({
    volume: { music: 0.2, ui: 0.5, master: 0.8 },
    muted: { sfx: true, ambient: true, music: false },
  });
  expect(errors).toEqual([]);
});

test.describe("T4.2 tutorial (server whose start island is Puerto)", () => {
  test.use({ baseURL: puertoClientURL });

  test("a new character in Puerto follows the tutorial, then skips it", async ({
    page,
    playwright,
  }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));

    // A brand-new character, created like any other (no town: it wakes up on the start
    // island, Puerto on this server), gets the first hint at the temple of the Lantern.
    const { email, password } = await newGuardian(playwright, "Pupil", puertoServerURL);
    await enterGame(page, email, password);
    errors.length = 0; // the 401 of opening the page without a session cookie

    const panel = page.getByTestId("tutorial-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-step", "first_steps");
    await expect(panel).toContainText("1 / 6"); // a guardian skips the spell step
    await expect(panel).toContainText("Camina 5 pasos");

    // Walking advances it: find a free direction, then step back and forth. The server
    // counts each confirmed step.
    await keysToGame(page);
    const still = async (): Promise<Self> => {
      let s: Self | undefined;
      await expect
        .poll(async () => {
          s = await self(page);
          return s !== undefined && !s.pending && !s.walking;
        })
        .toBe(true);
      if (!s) throw new Error("no self");
      return s;
    };
    const back: Record<string, string> = {
      ArrowLeft: "ArrowRight",
      ArrowRight: "ArrowLeft",
      ArrowUp: "ArrowDown",
      ArrowDown: "ArrowUp",
    };
    let key = "";
    for (const k of Object.keys(back)) {
      const before = await still();
      await stepKey(page, k);
      await page.waitForTimeout(700);
      const after = await still();
      if (after.x !== before.x || after.y !== before.y) {
        key = back[k] ?? "";
        break;
      }
    }
    expect(key).not.toBe("");
    await expect(page.getByTestId("tutorial-progress")).toHaveText("Llevas 1 de 5.");
    await stepKey(page, key);
    await page.waitForTimeout(700);
    await still();
    await expect(page.getByTestId("tutorial-progress")).toHaveText("Llevas 2 de 5.");
    await shot(page, "40-tutorial-walk");
    await panel.screenshot({ path: join(shots, "40-tutorial-panel.png") });
    for (let i = 0; i < 3; i++) {
      key = back[key] ?? "";
      await stepKey(page, key);
      await page.waitForTimeout(700);
      await still();
    }
    await expect(panel).toHaveAttribute("data-step", "meet_priestess");
    await expect(panel).toContainText("2 / 6");

    // Talking to the priestess advances it (the server sees the conversation start) and
    // the next hint highlights the equipment panel.
    let priest: { id: number; x: number; y: number } | undefined;
    await expect
      .poll(async () => {
        const list = await page.evaluate(() => window.__rpgClient?.npcs() ?? []);
        priest = list.find((n) => n.contentId === "puerto_priest");
        return priest !== undefined;
      })
      .toBe(true);
    if (!priest) throw new Error("no priestess");
    const at = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: priest.x,
      b: priest.y,
    });
    if (!at) throw new Error("no canvas");
    await page.mouse.click(at.x, at.y, { button: "right" });
    await expect(page.getByTestId("dialog")).toBeVisible();
    await expect(panel).toBeHidden(); // out of the way of the dialog
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("dialog")).toBeHidden();
    await expect(panel).toHaveAttribute("data-step", "open_backpack");
    await expect(page.getByTestId("inventory")).toHaveAttribute("data-tutorial-active", "");
    await page.waitForTimeout(300); // the highlight is drawn
    await shot(page, "41-tutorial-highlight");

    // At the desktop app's minimum width the shop reaches the top right corner: the panel
    // hides while it is open and comes back after.
    await page.setViewportSize({ width: 960, height: 700 });
    // No header on desktop (docs/17 UI-4): the controls help is the toolbar's "?" window,
    // which floats over the map without moving it.
    await expect(page.locator("header.hud")).toHaveCount(0);
    // The canvas follows the new size from its ResizeObserver, at the page's next rendering
    // (after setViewportSize returns): until then it keeps the 1280x800 size, centred on the
    // smaller box, 50 px above the page (the e2e of lote 10 measured it then). Measure the
    // map once it fits the page.
    let mapTop = -1;
    await expect
      .poll(async () => {
        const box = await page.getByTestId("game-canvas").boundingBox();
        mapTop = box?.y ?? -1;
        return box !== null && box.y >= 0 && box.y + box.height <= 700 && box.width <= 960;
      })
      .toBe(true);
    await openWindow(page, "help");
    const help = page.getByTestId("controls-help");
    await expect(help.locator("p.controls-text")).toContainText("Camina con las flechas");
    await expect(help.locator("p.help-windows")).toContainText("Ventanas");
    await shot(page, "44-controls-help-960");
    // The help (the controls and the windows' paragraph) wraps inside its window, and the
    // window stays inside the screen.
    const fits = await help
      .locator("p")
      .evaluateAll((ps) =>
        ps.map(
          (p) => p.scrollWidth <= p.clientWidth && p.getBoundingClientRect().right <= innerWidth,
        ),
      );
    expect(fits).toEqual([true, true]);
    expect((await page.getByTestId("game-canvas").boundingBox())?.y).toBe(mapTop);
    await closeWindow(page, "help");
    let prov: { id: number; x: number; y: number } | undefined;
    await expect
      .poll(async () => {
        const list = await page.evaluate(() => window.__rpgClient?.npcs() ?? []);
        prov = list.find((n) => n.contentId === "puerto_provisioner");
        return prov !== undefined;
      })
      .toBe(true);
    if (!prov) throw new Error("no provisioner");
    const tile = async (x: number, y: number): Promise<{ x: number; y: number }> => {
      const c = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
        a: x,
        b: y,
      });
      if (!c) throw new Error("no canvas");
      return c;
    };
    let c = await tile(prov.x - 2, prov.y - 1);
    await page.mouse.click(c.x, c.y);
    await arrived(page, prov.x - 2, prov.y - 1);
    c = await tile(prov.x, prov.y);
    await page.mouse.click(c.x, c.y, { button: "right" });
    await page
      .getByTestId("dialog")
      .getByRole("button", { name: /Quiero comerciar/ })
      .click();
    await expect(page.getByTestId("shop")).toBeVisible();
    await expect(panel).toBeHidden();
    await page.waitForTimeout(300); // let the icons load before the screenshot
    await shot(page, "43-tutorial-shop-960");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("shop")).toBeHidden();
    await expect(panel).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(help).toBeHidden();

    // Skipping ends it for good: the server confirms and the panel and highlight go away.
    await page.getByTestId("tutorial-skip").click();
    await expect(panel).toBeHidden();
    await expect(page.getByTestId("game-log")).toContainText("Saltaste el tutorial.");
    await expect(page.locator("[data-tutorial-active]")).toHaveCount(0);
    await shot(page, "42-tutorial-skipped");

    await page.getByRole("button", { name: "Salir del juego" }).click();
    await expect(page.getByRole("status")).toHaveText("Saliste del juego.");
    // Back in: still no tutorial.
    await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
    await page.waitForFunction(() => window.__rpgClient?.ready === true);
    await page.waitForTimeout(500);
    await expect(panel).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test("T5.1: two players found a guild, invite, talk on its channel and see its name", async ({
  browser,
  playwright,
}) => {
  const founder = await newGuardian(playwright, "Founder");
  const mate = await newGuardian(playwright, "Fellow");
  // The founder needs level 18 (62424 XP) and the founding cost (2000 copper coins, 8) in
  // a backpack (48): data/balance.yaml guild.
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET level = 18, experience = 62424 WHERE name = '${founder.name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${founder.name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, s, 8, 100 FROM bp, generate_series(0, 19) AS s`,
  ]);
  const guildName = `Faro ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const errors: string[] = [];
  async function enter(email: string): Promise<Page> {
    const page = await browser.newPage();
    // The login screen's session check answers 401 before signing in: listen after it.
    await enterGame(page, email, founder.password);
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  const lead = await enter(founder.email);
  const mateP = await enter(mate.email);

  // Found it from the guild window (the toolbar's G, docs/17 UI-7).
  for (const page of [lead, mateP]) await openWindow(page, "guild");
  const panel = lead.getByTestId("guild-panel");
  await expect(panel).toContainText("No estás en un gremio.");
  await expect(panel).toContainText("Cuesta 2000 monedas de cobre y pide nivel 18.");
  await panel.getByLabel("Nombre del gremio").fill(guildName);
  await panel.getByRole("button", { name: "Fundar" }).click();
  await expect(lead.getByTestId("game-log")).toContainText(`Fundaste el gremio ${guildName}.`);
  await expect(panel.locator("h2")).toContainText(guildName);
  await expect(panel.locator("h2")).toContainText("Líder");

  // Invite the mate by name (the Invite button); the invitation shows over the mate's map.
  await panel.locator('[data-guild-tab="invite"]').click();
  await panel.getByLabel("Nombre del personaje").fill(mate.name);
  await panel.getByRole("button", { name: "Invitar" }).click();
  await expect(lead.getByTestId("game-log")).toContainText(`Invitaste a ${mate.name} a tu gremio.`);
  await expect(panel).toContainText(`${mate.name} (vence en 36 horas)`);
  const invitation = mateP.getByTestId("guild-invitation");
  await expect(invitation).toContainText(`Te invitan al gremio ${guildName}.`);
  await shot(mateP, "45-guild-invitation");
  await invitation.getByRole("button", { name: "Aceptar" }).click();
  await expect(invitation).toHaveCount(0);

  for (const page of [lead, mateP]) {
    const p = page.getByTestId("guild-panel");
    await p.locator('[data-guild-tab="members"]').click();
    await expect(p.locator("li[data-member]")).toHaveCount(2);
    await expect(p).toContainText("Miembros (2 en línea de 2)");
  }
  // Leaving is on the summary; the message of the day has its own button.
  await mateP.getByTestId("guild-panel").locator('[data-guild-tab="summary"]').click();
  await expect(mateP.getByTestId("guild-leave")).toBeVisible();
  await panel.locator('[data-guild-tab="ranks"]').click();
  await expect(panel.getByTestId("guild-ranks")).toContainText(mate.name);
  await panel.locator('[data-guild-tab="motd"]').click();
  await panel.getByPlaceholder("Mensaje del día").fill("Cacería al amanecer");
  await panel.getByRole("button", { name: "Cambiar" }).click();
  await expect(mateP.getByTestId("guild-motd")).toHaveText("Cacería al amanecer");

  // Guild chat.
  await mateP.getByTestId("chat-channel").selectOption({ label: "Gremio" });
  const input = mateP.getByTestId("say").getByRole("textbox");
  await input.fill("hola gremio");
  await input.press("Enter");
  await expect(lead.getByTestId("chat-log")).toContainText(`[Gremio] ${mate.name}: hola gremio`);
  await lead
    .locator('.gwin[data-window="guild"]')
    .screenshot({ path: join(shots, "46-guild-panel.png") });
  // The guild window floats over the map: out of the way of the Shift+click below.
  for (const page of [lead, mateP]) await closeWindow(page, "guild");

  // The founder looks at the mate (Shift+click on its tile) and sees the guild.
  const at = await self(mateP);
  if (!at) throw new Error("no mate position");
  const tile = await lead.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
    a: at.x,
    b: at.y,
  });
  if (!tile) throw new Error("mate not on screen");
  await lead.mouse.move(tile.x, tile.y);
  await lead.keyboard.down("Shift");
  await lead.mouse.click(tile.x, tile.y);
  await lead.keyboard.up("Shift");
  await expect(lead.getByTestId("game-log")).toContainText(
    `Ves a ${mate.name}, Guardián de nivel 1. Es Miembro del gremio ${guildName}.`,
  );
  // Both names carry the guild under them on the map.
  await shot(lead, "47-guild-name-on-map");

  // The public site lists it once the database has the change (written off the loop).
  await expect
    .poll(() =>
      psql([
        databaseUrl,
        "-tAc",
        `SELECT count(*) FROM guild_members m JOIN guilds g ON g.id = m.guild_id WHERE g.name = '${guildName}'`,
      ])
        .toString()
        .trim(),
    )
    .toBe("2");
  const site = await browser.newPage();
  await site.goto("/guilds?lang=es");
  const row = site.getByTestId("guilds").locator("tr", { hasText: guildName });
  await expect(row).toContainText(founder.name);
  await row.getByRole("link", { name: guildName }).click();
  const members = site.getByTestId("guild-members");
  await expect(members.locator("tbody tr")).toHaveCount(2);
  await expect(members).toContainText("Líder");
  await expect(members).toContainText("Miembro");
  await expect(site.getByTestId("guild-page")).not.toContainText("Cacería");
  await shot(site, "48-site-guild");
  await site.close();

  expect(errors).toEqual([]);
  await lead.close();
  await mateP.close();
});

test("T5.2: an attack in the no_pvp zone is refused; outside it the attacker gets a skull", async ({
  browser,
  playwright,
}) => {
  const hunter = await newGuardian(playwright, "Hunter");
  const prey = await newGuardian(playwright, "Prey");
  // Level 25 (172800 XP: over balance pvp.min_level 20), standing side by side inside the
  // test island's no_pvp zone (x 1046-1051, y 1053-1059), west of the temple.
  for (const [who, x] of [
    [hunter, 1048],
    [prey, 1049],
  ] as const) {
    psql([
      databaseUrl,
      "-c",
      `UPDATE characters SET level = 25, experience = 172800, health = 400,
         pos_x = ${x}, pos_y = 1057, pos_z = 7 WHERE name = '${who.name}'`,
    ]);
  }
  // The prey wields an iron sword (13, data/ids.lock.yaml) in its right hand (slot 5): the
  // hunter sees it on its figure (docs/05 "Apariencia y equipo visible").
  psql([
    databaseUrl,
    "-c",
    `INSERT INTO inventory_items (character_id, slot, item_id, count)
     SELECT id, 5, 13, 1 FROM characters WHERE name = '${prey.name}'`,
  ]);
  const errors: string[] = [];
  async function enter(email: string): Promise<Page> {
    const page = await browser.newPage();
    await enterGame(page, email, hunter.password);
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  const hunterP = await enter(hunter.email);
  const preyP = await enter(prey.email);
  // Another player's visible equipment: the hunter's client knows the prey's sword.
  await expect
    .poll(() =>
      hunterP.evaluate(
        (n) => window.__rpgClient?.players().find((p) => p.name === n)?.equipment.rightHand,
        prey.name,
      ),
    )
    .toBe(13);

  // The safe mode starts on; the hunter turns it off.
  const safe = hunterP.getByTestId("safe-mode");
  await expect(safe).toBeChecked();
  await safe.uncheck();
  await expect(hunterP.getByTestId("game-log")).toContainText("Modo seguro desactivado");

  // In the no_pvp zone the server refuses the attack.
  const battle = hunterP.getByTestId("battle-list");
  await battle.getByRole("button", { name: prey.name }).click();
  await expect(hunterP.getByTestId("game-log")).toContainText(
    "Aquí no se puede pelear contra otros jugadores.",
  );
  await expect.poll(() => hunterP.evaluate(() => window.__rpgClient?.target())).toBeFalsy();
  await shot(hunterP, "49-pvp-no-pvp-refused");

  // Both walk three tiles south, out of the zone (y 1060).
  for (const page of [hunterP, preyP]) {
    const me = await self(page);
    if (!me) throw new Error("no position");
    for (let i = 0; i < 3; i++) {
      await stepKey(page, "ArrowDown");
      await arrived(page, me.x, me.y + i + 1);
    }
  }

  // Now the attack goes through and the hunter is marked as an aggressor for everyone.
  await battle.getByRole("button", { name: prey.name }).click();
  const preyBattle = preyP.getByTestId("battle-list");
  await expect(
    preyBattle.getByRole("button", { name: hunter.name }).locator('[data-skull="aggressor"]'),
  ).toBeVisible({ timeout: 10_000 });
  await expect(preyBattle.locator('[data-skull="aggressor"]')).toHaveAttribute("title", "agresor");
  // The mark is its sprite from the atlas (ui/marks/aggressor), not the fallback dot.
  await expect(preyBattle.locator('[data-skull="aggressor"]')).toHaveAttribute("data-art", "");
  // The prey, in safe mode, may defend itself against a marked attacker. The client sets
  // its target at once, so wait for the server: a refusal (pvp.safe_mode) would clear it
  // and log the reason; the hunter's health bar dropping is the server's own answer.
  await preyBattle.getByRole("button", { name: hunter.name }).click();
  const hunterHp = async (): Promise<number | undefined> =>
    (await preyP.evaluate(() => window.__rpgClient?.battle()))?.find((c) => c.health < 100)?.health;
  await expect.poll(hunterHp, { timeout: 15_000 }).toBeDefined();
  await expect(preyP.getByTestId("game-log")).not.toContainText("El modo seguro no te deja");
  expect(await preyP.evaluate(() => window.__rpgClient?.target())).toBeTruthy();
  // The attacker cannot log out in the middle of the fight.
  await hunterP.getByRole("button", { name: "Salir del juego" }).click();
  await expect(hunterP.getByTestId("game-log")).toContainText(
    "Peleaste contra un jugador hace poco: podrás salir del juego en",
  );
  await expect(hunterP.getByTestId("battle-list")).toBeVisible();
  await shot(preyP, "50-pvp-aggressor-skull");
  await preyP
    .locator('.gwin[data-window="battle"]')
    .screenshot({ path: join(shots, "51-pvp-battle-list.png") });

  expect(errors).toEqual([]);
  await hunterP.close();
  await preyP.close();
});

test("T5.3: two players trade, one posts a market offer, the other buys it, the gold is withdrawn", async ({
  browser,
  playwright,
}) => {
  const seller = await newGuardian(playwright, "Mercader");
  const buyer = await newGuardian(playwright, "Cliente");
  // Both stand next to Puerto's market board (3168, 6382: world/islands/puerto), each with
  // a backpack (48): the seller with 20 raw fish (10), the buyer with two stacks of 50
  // copper coins (8).
  const seed = (name: string, x: number, y: number, items: string): string =>
    `UPDATE characters SET town = 'puerto', pos_x = ${x}, pos_y = ${y}, pos_z = 7 WHERE name = '${name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, s, i, c FROM bp, (VALUES ${items}) AS v(s, i, c);`;
  psql([
    databaseUrl,
    "-c",
    seed(seller.name, 3167, 6382, "(0, 10, 20)") +
      seed(buyer.name, 3167, 6383, "(0, 8, 50), (1, 8, 50)"),
  ]);
  const errors: string[] = [];
  async function enter(email: string): Promise<Page> {
    const page = await browser.newPage();
    await enterGame(page, email, seller.password);
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  const a = await enter(seller.email);
  const b = await enter(buyer.email);
  await arrived(a, 3167, 6382);
  await arrived(b, 3167, 6383);
  // docs/17 UI-5: the inventory opens the equipped backpack by itself, under the figure,
  // but not during the tutorial, whose step teaches it (a new character of Puerto follows
  // it). So it stays closed, and a double click on the slot opens it under the figure (on
  // an open one it would close it). The trade offers what lies in it.
  for (const page of [a, b]) {
    const docked = page
      .getByTestId("inventory")
      .locator('[data-container-item="backpack"][data-docked]');
    await expect(page.getByTestId("tutorial-panel")).toBeVisible();
    await expect(docked).toHaveCount(0);
    await page
      .getByTestId("inventory")
      .getByTestId("slot-backpack")
      .locator("[data-item]")
      .dblclick();
    await expect(docked).toBeVisible();
    await expect(page.getByTestId("window-container-backpack")).toHaveCount(0);
  }

  // Trade: the seller invites from the battle list, the buyer joins; fish for 50 coins.
  await a.getByTestId("battle-list").locator("[data-trade]").first().click();
  const invite = b.getByTestId("trade-invitation");
  await expect(invite).toContainText(`${seller.name} quiere intercambiar contigo.`);
  await b.getByTestId("trade-join").click();
  const ta = a.getByTestId("trade");
  const tb = b.getByTestId("trade");
  await ta.locator("[data-trade-add=raw_fish]").click();
  await tb.locator("[data-trade-add=copper_coin]").first().click();
  await expect(ta.getByTestId("trade-partner")).toContainText("50");
  await expect(tb.getByTestId("trade-partner")).toContainText("20");
  await ta.getByTestId("trade-accept").click();
  await expect(tb.getByTestId("trade-partner-state")).toHaveText("(confirmó)");
  await shot(b, "52-trade-window");
  await tb.getByTestId("trade-accept").click();
  for (const page of [a, b]) {
    await expect(page.getByTestId("game-log")).toContainText("Intercambio completado.");
    await expect(page.getByTestId("trade")).toHaveCount(0);
  }

  // Market: the seller (now with the coins) opens the board and browses the fish first.
  const boardA = await a.evaluate(() => window.__rpgClient?.tileToClient(3168, 6382));
  if (!boardA) throw new Error("no canvas");
  await useAt(a, boardA.x, boardA.y);
  const ma = a.getByTestId("market");
  await ma.getByTestId("market-search").getByRole("combobox").fill("pescado crudo");
  await ma.getByTestId("market-search").getByRole("button", { name: "Buscar" }).click();
  await expect(ma.getByTestId("market-browse")).toHaveAttribute("data-item", "raw_fish");

  // The buyer (now with the fish) uses the board and posts 8 fish at 6 coins.
  const board = await b.evaluate(() => window.__rpgClient?.tileToClient(3168, 6382));
  if (!board) throw new Error("no canvas");
  await useAt(b, board.x, board.y);
  const mb = b.getByTestId("market");
  await expect(mb).toBeVisible();
  await mb.getByTestId("market-search").getByRole("combobox").fill("pescado crudo");
  await mb.getByTestId("market-search").getByRole("button", { name: "Buscar" }).click();
  await expect(mb.getByTestId("market-browse")).toHaveAttribute("data-item", "raw_fish");
  const create = mb.getByTestId("market-create");
  await create.getByLabel("Cantidad").fill("8");
  await create.getByLabel("Precio por unidad").fill("6");
  await create.getByRole("button", { name: "Publicar" }).click();
  await expect(b.getByTestId("game-log")).toContainText(
    /Publicaste una oferta de .+ Comisión: 5 monedas\./,
  );
  await expect(mb.getByTestId("market-own").locator("li")).toHaveCount(1);
  await shot(b, "53-market-offer-posted");

  // The seller (now with the coins) saw the offer appear in its open window without
  // searching again (live refresh), and buys 3 of them from the listing.
  // Earlier runs against the same database may have left offers: pick this one.
  const offer = ma.getByTestId("market-sells").locator("li", { hasText: buyer.name });
  await expect(offer).toContainText("8 unidades");
  await offer.getByLabel("Cantidad").fill("3");
  await offer.getByRole("button", { name: "Comprar" }).click();
  await expect(a.getByTestId("game-log")).toContainText(/Compraste .+ por 18 monedas\./);
  await expect(offer).toContainText("5 unidades");
  // One sale is one vote: the reference needs 3 votes from 2 seller accounts in 5 days
  // (content audit m13), which earlier runs against the same database may have left.
  await expect(ma.getByTestId("market-reference")).toContainText(
    /Precio de referencia: 6 c\/u|Sin precio de referencia/,
  );
  await expect(ma.getByTestId("market-history")).toContainText("Compraste");
  await shot(a, "54-market-bought");

  // The first one is told and withdraws the 18 coins from the mailbox.
  await expect(b.getByTestId("game-log")).toContainText(/Mercado: se cerró parte de tu oferta/);
  await expect(mb.getByTestId("market-mailbox-gold")).toHaveText("Oro: 18 monedas");
  await mb.getByTestId("market-withdraw").click();
  await expect(b.getByTestId("game-log")).toContainText("Retiraste 18 monedas del buzón.");
  await expect(mb.getByTestId("market-mailbox-gold")).toHaveText("Oro: 0 monedas");
  await expect(mb.getByTestId("market-money")).toHaveText("Dinero: 63");
  await shot(b, "55-market-withdrawn");

  // The database has it: the offer with 5 left, written with the snapshots.
  await expect
    .poll(() =>
      psql([
        databaseUrl,
        "-tAc",
        `SELECT o.amount FROM market_offers o JOIN characters c ON c.id = o.character_id WHERE c.name = '${buyer.name}'`,
      ])
        .toString()
        .trim(),
    )
    .toBe("5");
  // ...and the withdrawal too: the mailbox's gold is 0 in the database.
  await expect
    .poll(() =>
      psql([
        databaseUrl,
        "-tAc",
        `SELECT g.gold FROM market_mail_gold g JOIN characters c ON c.id = g.character_id WHERE c.name = '${buyer.name}'`,
      ])
        .toString()
        .trim(),
    )
    .toBe("0");
  expect(errors).toEqual([]);
  await a.close();
  await b.close();
});

test("T5.4: a player rents a house, leaves an item inside, invites another; a third cannot enter", async ({
  browser,
  playwright,
}) => {
  // Three game pages at once, each drawing its map: on the CI runner (2 CPUs, WebGL in
  // software) the walk to the door alone took the whole default 90 s. The site's house list
  // may then take up to its cache TTL (60 s) to show the rent: budget both.
  test.setTimeout(240_000);
  const owner = await newGuardian(playwright, "Inquilino");
  const guest = await newGuardian(playwright, "Visita");
  const stranger = await newGuardian(playwright, "Extrano");
  const house = "puerto_house_net"; // world/islands/puerto/houses.yaml: door 3153,6401
  const query = (sql: string): string => psql([databaseUrl, "-tAc", sql]).toString().trim();
  // An earlier run against the same database may have left the house rented: a gm frees it
  // (the server owns the houses in memory, so it goes through the game, audited).
  if (query(`SELECT count(*) FROM house_owners WHERE house_id = '${house}'`) !== "0") {
    const gm = await newGuardian(playwright, "Guardia");
    query(`UPDATE accounts SET role = 'gm' WHERE email = lower('${gm.email}')`);
    const page = await browser.newPage();
    await enterGame(page, gm.email, gm.password);
    const say = page.getByTestId("say").getByRole("textbox");
    await say.fill(`/houseevict ${house}`);
    await say.press("Enter");
    await expect(page.getByTestId("game-log")).toContainText(`Liberaste la casa ${house}`);
    await page.close();
  }
  // Level 15 (35280 XP, min_level 12), a backpack (48) with 20 x 100 copper coins (8) and
  // 5 raw fish (10) for the owner (the rent is 32 tiles × 60 = 1920, content audit M6);
  // the others just a backpack. In Puerto, south of the door.
  const seed = (name: string, x: number, items: string): string =>
    `UPDATE characters SET town = 'puerto', level = 15, experience = 35280, pos_x = ${x}, pos_y = 6403, pos_z = 7
       WHERE name = '${name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, s, i, c FROM bp, (VALUES ${items}) AS v(s, i, c);`;
  psql([
    databaseUrl,
    "-c",
    seed(
      owner.name,
      3153,
      "(0, 10, 5)" + [...Array(20).keys()].map((s) => `, (${s + 1}, 8, 100)`).join(""),
    ) +
      seed(guest.name, 3152, "(0, 8, 1)") +
      seed(stranger.name, 3154, "(0, 8, 1)"),
  ]);
  const errors: string[] = [];
  async function enter(email: string, height = 800): Promise<Page> {
    // The owner's page is taller: its backpack window must not sit under the chat.
    const page = await browser.newPage({ viewport: { width: 1280, height } });
    await enterGame(page, email, owner.password);
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  const a = await enter(owner.email, 1100);
  const b = await enter(guest.email);
  const c = await enter(stranger.email);
  await arrived(a, 3153, 6403);
  await arrived(b, 3152, 6403);
  await arrived(c, 3154, 6403);
  const step = async (page: Page, key: string, x: number, y: number): Promise<void> => {
    await keysToGame(page);
    await stepKey(page, key);
    await arrived(page, x, y);
  };
  const openDoor = async (page: Page): Promise<void> => {
    const door = await page.evaluate(() => window.__rpgClient?.tileToClient(3153, 6401));
    if (!door) throw new Error("no canvas");
    await useAt(page, door.x, door.y);
    await expect(page.getByTestId("house")).toBeVisible();
  };

  // Looking at the door says it is free and its rent; using it opens the window.
  await step(a, "ArrowUp", 3153, 6402);
  const doorA = await a.evaluate(() => window.__rpgClient?.tileToClient(3153, 6401));
  if (!doorA) throw new Error("no canvas");
  await a.keyboard.down("Shift");
  await a.mouse.click(doorA.x, doorA.y);
  await a.keyboard.up("Shift");
  await expect(a.getByTestId("game-log")).toContainText(
    "Casa de la Red Tendida: libre. Alquiler: 1920 monedas cada 7 días (32 m²).",
  );
  await openDoor(a);
  const win = a.getByTestId("house");
  await expect(win.getByTestId("house-name")).toHaveText("Casa de la Red Tendida");
  await expect(win.getByTestId("house-owner")).toHaveText("Libre.");
  await shot(a, "56-house-free");
  await win.getByTestId("house-rent").click();
  await expect(a.getByTestId("game-log")).toContainText(
    "Alquilaste Casa de la Red Tendida por 7 días (1920 monedas).",
  );
  await expect(win.getByTestId("house-owner")).toHaveText(`La alquila ${owner.name}.`);
  await expect(win.getByTestId("house-paid")).toContainText("(7 días)");
  await shot(a, "57-house-rented");
  await win.getByRole("button", { name: "Cerrar la ventana de la casa" }).click();

  // The owner walks in and drops its backpack (with the fish and the coins) on the floor of
  // the house: the equipment slot is always in view (a container window may sit under the
  // chat on a short screen).
  await step(a, "ArrowUp", 3153, 6401);
  await step(a, "ArrowUp", 3153, 6400);
  await step(a, "ArrowUp", 3153, 6399);
  const slot = a.getByTestId("inventory").getByTestId("slot-backpack");
  const bagId = await a.evaluate(() => window.__rpgClient?.itemNumber("backpack"));
  const onFloor = (): Promise<number | undefined> =>
    a.evaluate(() => window.__rpgClient?.tile(3154, 6398, 7)?.at(-1));
  for (let attempt = 0; attempt < 3 && (await onFloor()) !== bagId; attempt++) {
    await slot.scrollIntoViewIfNeeded();
    const from = await slot.boundingBox();
    const to = await a.evaluate(() => window.__rpgClient?.tileToClient(3154, 6398));
    if (!from || !to) throw new Error("no drag points");
    await a.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await a.mouse.down();
    await a.mouse.move(to.x, to.y, { steps: 8 });
    await a.mouse.up();
    await expect
      .poll(onFloor, { timeout: 2000 })
      .toBe(bagId)
      .catch(() => undefined);
  }
  expect(await onFloor()).toBe(bagId);
  await expect(slot.locator("[data-item]")).toHaveCount(0);
  // Written with the owner's inventory, in one transfer.
  await expect
    .poll(() => query(`SELECT count(*) FROM house_items WHERE house_id = '${house}'`))
    .toBe("1");
  await shot(a, "58-house-item-inside");

  // Back next to the door, the owner invites the guest.
  await step(a, "ArrowDown", 3153, 6400);
  await openDoor(a);
  await win.getByTestId("house-guest-name").fill(guest.name);
  await win.getByTestId("house-guest-add").click();
  await expect(a.getByTestId("game-log")).toContainText(
    `${guest.name} ahora puede entrar a tu casa.`,
  );
  await expect(win.getByTestId("house-guests")).toContainText(guest.name);
  await shot(a, "59-house-guest-invited");
  await win.getByRole("button", { name: "Cerrar la ventana de la casa" }).click();
  await step(a, "ArrowRight", 3154, 6400);

  // The guest walks in through the door; the stranger cannot.
  await step(b, "ArrowRight", 3153, 6403);
  await step(b, "ArrowUp", 3153, 6402);
  await step(b, "ArrowUp", 3153, 6401);
  await step(b, "ArrowUp", 3153, 6400);
  await step(c, "ArrowLeft", 3153, 6403);
  await step(c, "ArrowUp", 3153, 6402);
  await keysToGame(c);
  await stepKey(c, "ArrowUp");
  await expect(c.getByTestId("game-log")).toContainText(
    "La puerta de esta casa no se abre para ti.",
  );
  await arrived(c, 3153, 6402);
  await shot(b, "60-house-guest-inside");
  await shot(c, "61-house-stranger-refused");
  // The game is done: its three pages stop drawing before the site's part.
  for (const page of [a, b, c]) await page.close();

  // The public list shows the house rented by the owner (and nothing private).
  const site = await browser.newPage();
  await site.goto("/houses?lang=es");
  const row = site.getByTestId("houses-puerto").locator(`[data-house="${house}"]`);
  await expect(row).toContainText(`Alquilada por ${owner.name}`, { timeout: 70_000 });
  await shot(site, "62-site-houses");
  await site.close();

  expect(errors).toEqual([]);
});

test("T5.5: sail from Selvaine to Karvask and meet its captain", async ({ page, playwright }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const { email, password, name } = await newGuardian(playwright, "Ashsail");
  // Level 25 (172800 XP) on Ivernel's dock with 200 copper coins (8) in a backpack (48).
  // The route asks for level 25 and costs 150.
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'bosque', level = 25, experience = 172800, pos_x = 4120, pos_y = 6100, pos_z = 7 WHERE name = '${name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, 0, 8, 100 FROM bp UNION ALL SELECT character_id, id, 1, 8, 100 FROM bp`,
  ]);
  await enterGame(page, email, password);
  errors.length = 0;
  await arrived(page, 4120, 6100);

  const ferryman = await page.evaluate(() => window.__rpgClient?.tileToClient(4122, 6100));
  if (!ferryman) throw new Error("no canvas");
  await page.mouse.click(ferryman.x, ferryman.y, { button: "right" });
  const dialog = page.getByTestId("dialog");
  await dialog.getByRole("button", { name: "Quiero viajar." }).click();
  await dialog.getByRole("button", { name: "A Karvask (150 monedas)." }).click();
  await expect(page.getByTestId("voyage")).toContainText("Zarpaste hacia Karvask");
  await arrived(page, 3617, 5795);
  await expect(page.getByTestId("game-log")).toContainText("Pagaste 150 monedas.");
  await expect(page.getByTestId("voyage")).toBeHidden({ timeout: 5000 });
  await shot(page, "63-volcan-dock");

  // The captain of Cinderstead sells the way back to both islands.
  const captain = await page.evaluate(() => window.__rpgClient?.tileToClient(3615, 5794));
  if (!captain) throw new Error("no canvas");
  await page.mouse.click(captain.x, captain.y, { button: "right" });
  await expect(dialog).toContainText("Nerea Vado");
  await dialog.getByRole("button", { name: "Quiero viajar." }).click();
  await expect(dialog.getByRole("button", { name: "A Selvaine (100 monedas)." })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "A Velmara (140 monedas)." })).toBeVisible();
  await shot(page, "64-volcan-captain");
  expect(errors).toEqual([]);
});

test("T5.5: wake up at the temple of Cinderstead and start Chapter 3 with the keeper", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { email, password, name } = await newGuardian(playwright, "Stoker");
  // Resident of Karvask at level 30 (302760 XP) who found the ember root in
  // Chapter 2: the flag, and the root (132) in a backpack (48).
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'volcan', level = 30, experience = 302760 WHERE name = '${name}';
     INSERT INTO quest_state (character_id, key, value)
     SELECT id, 'flag.ember_root_found', 1 FROM characters WHERE name = '${name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, 0, 132, 1 FROM bp`,
  ]);
  await enterGame(page, email, password);
  await arrived(page, 3642, 5789);
  await shot(page, "65-volcan-temple");
  // Out of the temple door and east across the plaza into the keeper's archive, by clicks.
  // Outside the door, the sign of the temple (T5.5) is read with Shift+click.
  const door = await page.evaluate(() => window.__rpgClient?.tileToClient(3642, 5793));
  if (!door) throw new Error("no canvas");
  await page.mouse.click(door.x, door.y);
  await arrived(page, 3642, 5793);
  const sign = await page.evaluate(() => window.__rpgClient?.tileToClient(3641, 5793));
  if (!sign) throw new Error("no canvas");
  await page.mouse.move(sign.x, sign.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(sign.x, sign.y);
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("game-log")).toContainText(
    "Ves: cartel. Templo de la Llama Quieta, en Cinderstead.",
  );
  await shot(page, "65b-volcan-temple-sign");
  // 5 columns at most: at 1280x800 the inventory floats over the 6th to the east.
  for (const [x, y] of [
    [3647, 5794],
    [3652, 5794],
    [3657, 5794],
    [3662, 5794],
    [3662, 5796],
  ] as const) {
    const tile = await page.evaluate(({ tx, ty }) => window.__rpgClient?.tileToClient(tx, ty), {
      tx: x,
      ty: y,
    });
    if (!tile) throw new Error("no canvas");
    await page.mouse.click(tile.x, tile.y);
    await arrived(page, x, y);
  }
  const keeper = await page.evaluate(() => window.__rpgClient?.tileToClient(3662, 5798));
  if (!keeper) throw new Error("no canvas");
  await page.mouse.click(keeper.x, keeper.y, { button: "right" });
  const dialog = page.getByTestId("dialog");
  await expect(dialog).toContainText("Casia Hollín");
  await dialog
    .getByRole("button", { name: "Traigo una raíz de piedra tallada que está templada." })
    .click();
  await dialog.getByRole("button", { name: "Acepto." }).click();
  await expect(page.getByTestId("game-log")).toContainText(
    "Nueva misión: Capítulo 3: Fuego bajo la piedra.",
  );
  await shot(page, "66-volcan-keeper");
  expect(errors).toEqual([]);
});

test("keyed doors: the forge gate opens with the ember key, does not lock on a stray, and opens from inside", async ({
  browser,
  playwright,
}) => {
  const holder = await newGuardian(playwright, "Llavero");
  const stray = await newGuardian(playwright, "Rezagado");
  // Residents of Karvask at level 30 (302760 XP) on floor 8 of its mine, just north
  // of the forge gate (3692,5832; docs/02 "Puertas con llave"), each with a backpack (48):
  // the key holder carries the ember key (142), the stray a coin (8). The stray stands right
  // north of the gate: the client's paths never cut a blocked corner.
  const seed = (name: string, x: number, item: number): string =>
    `UPDATE characters SET town = 'volcan', level = 30, experience = 302760,
       pos_x = ${x}, pos_y = 5831, pos_z = 8 WHERE name = '${name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, 0, ${item}, 1 FROM bp;`;
  psql([databaseUrl, "-c", seed(holder.name, 3691, 142) + seed(stray.name, 3692, 8)]);
  const errors: string[] = [];
  async function enter(email: string): Promise<Page> {
    const page = await browser.newPage();
    await enterGame(page, email, holder.password);
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  const a = await enter(holder.email);
  const b = await enter(stray.email);
  await arrived(a, 3691, 5831);
  await arrived(b, 3692, 5831);
  const ids = await a.evaluate(() => ({
    shut: window.__rpgClient?.itemNumber("forge_gate"),
    open: window.__rpgClient?.itemNumber("forge_gate_open"),
  }));
  if (ids.shut === undefined || ids.open === undefined) throw new Error("no gate items");
  const gateOn = (page: Page): Promise<number | undefined> =>
    page.evaluate(() => window.__rpgClient?.tile(3692, 5832, 8)?.at(-1));
  const useGate = async (page: Page): Promise<void> => {
    const gate = await page.evaluate(() => window.__rpgClient?.tileToClient(3692, 5832));
    if (!gate) throw new Error("no canvas");
    await useAt(page, gate.x, gate.y);
  };
  const walkTo = async (page: Page, x: number, y: number): Promise<void> => {
    const tile = await page.evaluate(({ tx, ty }) => window.__rpgClient?.tileToClient(tx, ty), {
      tx: x,
      ty: y,
    });
    if (!tile) throw new Error("no canvas");
    await page.mouse.click(tile.x, tile.y);
    await arrived(page, x, y);
  };

  // Shut: looking at it names it, and without the key it does not open.
  expect(await gateOn(a)).toBe(ids.shut);
  const gate = await a.evaluate(() => window.__rpgClient?.tileToClient(3692, 5832));
  if (!gate) throw new Error("no canvas");
  await a.keyboard.down("Shift");
  await a.mouse.click(gate.x, gate.y);
  await a.keyboard.up("Shift");
  await expect(a.getByTestId("game-log")).toContainText("puerta de la forja");
  await useGate(b);
  await expect(b.getByTestId("game-log")).toContainText("Está cerrada con llave.");
  await shot(a, "69-forge-gate-locked");

  // The ember key in the backpack opens it for everyone; the stray walks into the forge.
  await useGate(a);
  await expect(a.getByTestId("game-log")).toContainText("La puerta se abre con tu llave de ascua.");
  await expect.poll(() => gateOn(a)).toBe(ids.open);
  await expect.poll(() => gateOn(b)).toBe(ids.open);
  await walkTo(b, 3692, 5833);
  await shot(a, "70-forge-gate-open");
  await useGate(a);
  await expect(a.getByTestId("game-log")).toContainText(
    "Alguien sin la llave quedaría encerrado: la puerta no se cierra con llave.",
  );
  expect(await gateOn(a)).toBe(ids.open);

  // The stray walks deeper into the forge and leaves the game there: the gate locks. Every
  // use next to a door, refused or not, starts the user's inventory.door_cooldown_ms (500
  // ms, 10 ticks), so the holder's next use has to come one cooldown after the refusal in
  // server time. The stray's three steps are paced by the server (about 10 ticks each at
  // level 30 on dirt): at least two whole steps lie between the two uses, however fast the
  // browser goes. It used to be the stray's page closing: 0.15-0.25 s without a trace (CI's
  // first attempt) and 0.6-1.8 s while Playwright saved one (local runs), so the lock got
  // "Espera un momento antes de mover la puerta otra vez." or passed, by speed alone.
  await walkTo(b, 3692, 5836);
  await expect(a.getByTestId("battle-list")).toContainText(stray.name);
  await b.getByRole("button", { name: "Salir del juego" }).click();
  await expect(b.getByRole("status")).toHaveText("Saliste del juego.");
  await expect(a.getByTestId("battle-list")).not.toContainText(stray.name);
  await useGate(a);
  await expect(a.getByTestId("game-log")).toContainText("Cierras la puerta con tu llave de ascua.");
  await expect.poll(() => gateOn(a)).toBe(ids.shut);

  // Back in (same page, as a player would), it walks to the gate and lets itself out.
  await b.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await b.waitForFunction(() => window.__rpgClient?.ready === true);
  await arrived(b, 3692, 5836);
  await walkTo(b, 3692, 5833);
  expect(await gateOn(b)).toBe(ids.shut);
  await shot(b, "71-forge-gate-shut-inside");
  await useGate(b);
  await expect(b.getByTestId("game-log")).toContainText(
    "Descorres el cerrojo desde adentro: la puerta se abre.",
  );
  await expect.poll(() => gateOn(b)).toBe(ids.open);
  await walkTo(b, 3692, 5831);
  await shot(b, "72-forge-gate-unbarred");

  // The holder locks it again (long after its last use): the next run, a --repeat-each or a
  // retry finds the gate as this one did.
  await useGate(a);
  await expect.poll(() => gateOn(a)).toBe(ids.shut);

  expect(errors).toEqual([]);
  for (const page of [a, b]) await page.close();
});

test("milestones: two strangers hold the plates of Thalorn together and land in its reward room", async ({
  browser,
  playwright,
}) => {
  const first = await newGuardian(playwright, "Escudo");
  const second = await newGuardian(playwright, "Mano");
  // Two level 20 residents of the Forest Isle (86640 XP; docs/02 "Quests de hito"), not in a
  // party, in the crypt of Thalorn on floor 8, one tile south of each plate (4207,6090 and
  // 4213,6090), with ms_thalorn_oath in progress on its plates step (quest_state 1, step 0).
  const seed = (name: string, x: number): string =>
    `UPDATE characters SET town = 'bosque', level = 20, experience = 86640,
       pos_x = ${x}, pos_y = 6091, pos_z = 8 WHERE name = '${name}';
     INSERT INTO quest_state (character_id, key, value)
     SELECT id, 'quest.ms_thalorn_oath', 1 FROM characters WHERE name = '${name}';`;
  psql([databaseUrl, "-c", seed(first.name, 4207) + seed(second.name, 4213)]);
  const errors: string[] = [];
  async function enter(email: string): Promise<Page> {
    const page = await browser.newPage();
    await enterGame(page, email, first.password);
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  const a = await enter(first.email);
  const b = await enter(second.email);
  await arrived(a, 4207, 6091);
  await arrived(b, 4213, 6091);
  const walkTo = async (page: Page, x: number, y: number): Promise<void> => {
    const tile = await page.evaluate(({ tx, ty }) => window.__rpgClient?.tileToClient(tx, ty), {
      tx: x,
      ty: y,
    });
    if (!tile) throw new Error("no canvas");
    await page.mouse.click(tile.x, tile.y);
  };

  // The quest log lists it among the milestones, with what it asks.
  await openWindow(a, "quests");
  await a.locator('[data-quest-tab="milestones"]').click();
  const entry = a.locator('.quest[data-quest="ms_thalorn_oath"]');
  await expect(entry).toHaveAttribute("data-state", "active");
  await expect(entry.getByTestId("quest-reqs")).toContainText("Nivel 20 o más");
  await shot(a, "99-milestone-quest-log");
  await closeWindow(a, "quests");

  // One on its plate: the plates wait for the other.
  await walkTo(a, 4207, 6090);
  await arrived(a, 4207, 6090);
  await expect(a.getByTestId("game-log")).toContainText("1 de 2 ocupadas");
  await shot(a, "99b-milestone-one-plate");

  // The second one steps on the other plate: both land in the reward room, done.
  await walkTo(b, 4213, 6090);
  await expect(a.getByTestId("game-log")).toContainText("Hito alcanzado");
  await expect(b.getByTestId("game-log")).toContainText("Hito alcanzado");
  for (const page of [a, b])
    await expect
      .poll(async () => {
        const s = await self(page);
        return s !== undefined && s.x >= 4222 && s.x <= 4228 && s.y >= 6089 && s.y <= 6093;
      })
      .toBe(true);
  await shot(b, "99c-milestone-reward-room");

  // The finished tab shows the title it gave.
  await openWindow(b, "quests");
  await b.locator('[data-quest-tab="finished"]').click();
  await expect(b.getByTestId("quest-title")).toContainText("Testigo del Juramento");
  await shot(b, "99d-milestone-title");

  expect(errors).toEqual([]);
  for (const page of [a, b]) await page.close();
});

test("portals: a path goes round the volcanic mine stairs; down them to floor 8 and back up", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const { email, password, name } = await newGuardian(playwright, "Minero");
  // A resident of Karvask at level 30 (302760 XP) on the cinder path two tiles west
  // of the mine stairs (3692,5796; docs/03 "Islas actuales"). Below them, floor 8 lands on
  // 3692,5797; the stairs up (3692,5796,8) land on 3692,5797,7, next to the stairs down.
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'volcan', level = 30, experience = 302760,
       pos_x = 3690, pos_y = 5796, pos_z = 7 WHERE name = '${name}';`,
  ]);
  await enterGame(page, email, password);
  errors.length = 0; // the 401 of opening the page without a session cookie
  const standsOn = async (x: number, y: number, z: number): Promise<void> => {
    await expect
      .poll(
        async () => {
          const s = await self(page);
          return s && !s.pending && !s.walking ? `${s.x},${s.y},${s.z}` : "moving";
        },
        { timeout: 20_000 },
      )
      .toBe(`${x},${y},${z}`);
  };
  await standsOn(3690, 5796, 7);
  const ids = await page.evaluate(() => ({
    down: window.__rpgClient?.itemNumber("stairs_down"),
    up: window.__rpgClient?.itemNumber("stairs_up"),
  }));
  if (ids.down === undefined || ids.up === undefined) throw new Error("no stairs items");
  const topOf = (x: number, y: number, z: number): Promise<number | undefined> =>
    page.evaluate(({ a, b, c }) => window.__rpgClient?.tile(a, b, c)?.at(-1), { a: x, b: y, c: z });
  expect(await topOf(3692, 5796, 7)).toBe(ids.down);
  await page.waitForTimeout(300); // let the atlas textures upload before the screenshot
  await shot(page, "73-volcan-mine-stairs");

  // A click past the stairs walks round them: a path never crosses a portal on its way.
  expect(await page.evaluate(() => window.__rpgClient?.walkable(3693, 5796, 7) ?? false)).toBe(
    true,
  );
  const past = await page.evaluate(() => window.__rpgClient?.tileToClient(3693, 5796));
  if (!past) throw new Error("no canvas");
  await page.mouse.click(past.x, past.y);
  await standsOn(3693, 5796, 7);

  // One step west, onto the stairs: down to the mine, whose floor the client now draws.
  await stepKey(page, "ArrowLeft");
  await standsOn(3692, 5797, 8);
  await expect.poll(() => topOf(3692, 5796, 8)).toBe(ids.up);
  await page.waitForTimeout(300);
  await shot(page, "74-volcan-mine-floor-8");

  // One step north, onto the stairs up: back on the surface, south of the stairs down.
  await stepKey(page, "ArrowUp");
  await standsOn(3692, 5797, 7);
  await expect.poll(() => topOf(3692, 5796, 7)).toBe(ids.down);
  await page.waitForTimeout(300);
  await shot(page, "75-volcan-mine-back-up");
  expect(errors).toEqual([]);
});

/** The color name (Spanish option text) of a presence swatch, by its lightness and hue (lote 16). */
function colorOfSwatch(css: string): string {
  // server/internal/presence ColorOf: white or black by lightness, else blue or yellow by hue.
  const [r = 0, g = 0, b = 0] = (css.match(/\d+/g) ?? []).slice(0, 3).map((v) => Number(v) / 255);
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const light = (hi + lo) / 2;
  if (light > 0.75) return "blanco";
  if (light < 0.25) return "negro";
  const d = hi - lo;
  let h = 0;
  if (d > 0) {
    if (hi === r) h = (((g - b) / d) % 6) * 60;
    else if (hi === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  if (h < 0) h += 360;
  const dist = (c: number) => Math.min(Math.abs(h - c), 360 - Math.abs(h - c));
  return dist(220) < dist(52) ? "azul" : "amarillo";
}

test("account stash: one character stores fish, the other online one takes it out", async ({
  browser,
  playwright,
}) => {
  // One account, two characters (docs/02 "Baúl de la cuenta"): the second is made with the
  // same token. Both stand by Puerto's stash chest (3170, 6382, next to the market board).
  const owner = await newGuardian(playwright, "Baulero");
  const alt = `Baulera ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
  const apiCtx = await playwright.request.newContext({ baseURL: serverURL });
  const login = await apiCtx.post("/api/auth/login", {
    data: { email: owner.email, password: owner.password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await apiCtx.post("/api/characters", {
        data: { name: alt, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await apiCtx.dispose();
  const seed = (name: string, x: number, y: number, items: string): string =>
    `UPDATE characters SET town = 'puerto', pos_x = ${x}, pos_y = ${y}, pos_z = 7 WHERE name = '${name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, s, i, c FROM bp, (VALUES ${items}) AS v(s, i, c);`;
  psql([
    databaseUrl,
    "-c",
    seed(owner.name, 3171, 6381, "(0, 10, 20)") + seed(alt, 3171, 6383, "(0, 8, 5)"),
  ]);
  const errors: string[] = [];
  async function enter(name: string): Promise<Page> {
    const page = await browser.newPage();
    await page.goto("/play/?lang=es");
    const form = page.getByTestId("login-form");
    await form.getByLabel("Email").fill(owner.email);
    await form.getByLabel("Contraseña").fill(owner.password);
    await form.getByRole("button", { name: "Entrar", exact: true }).click();
    await page
      .getByTestId("characters")
      .locator("li", { hasText: name })
      .getByRole("button", { name: "Jugar" })
      .click();
    await page.waitForFunction(() => window.__rpgClient?.ready === true);
    // The login screen's session check answers 401 before signing in: listen after it.
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    return page;
  }
  const a = await enter(owner.name);
  const b = await enter(alt);
  await arrived(a, 3171, 6381);
  await arrived(b, 3171, 6383);
  for (const page of [a, b]) {
    const docked = page
      .getByTestId("inventory")
      .locator('[data-container-item="backpack"][data-docked]');
    if ((await docked.count()) === 0)
      await page
        .getByTestId("inventory")
        .getByTestId("slot-backpack")
        .locator("[data-item]")
        .dblclick();
    await expect(docked).toBeVisible();
  }
  const open = async (page: Page): Promise<void> => {
    const chest = await page.evaluate(() => window.__rpgClient?.tileToClient(3170, 6382));
    if (!chest) throw new Error("no canvas");
    await useAt(page, chest.x, chest.y);
    await expect(page.getByTestId("stash")).toBeVisible();
  };
  await open(a);
  await open(b);
  const sa = a.getByTestId("stash");
  const sb = b.getByTestId("stash");
  await sa.locator("[data-stash-store=raw_fish]").click();
  // The other character's window follows at once.
  await expect(sb.getByTestId("stash-cells")).toContainText("20");
  await shot(b, "stash-01-shared");
  await sb.locator("[data-stash-take]").first().click();
  await expect(sa.getByTestId("stash-cells")).toContainText("El baúl está vacío.");
  await expect(
    b.getByTestId("inventory").locator('[data-container-item="backpack"] [data-item="raw_fish"]'),
  ).toBeVisible();
  await shot(b, "stash-02-taken");
  expect(errors).toEqual([]);
});

// Lote 17 (docs/05 "Token de cuenta"): the characters screen's "Cuenta y seguridad" panel.
// A password change takes the account's other session out of the game; "sign out
// everywhere" ends this one too and the login comes back with only the email filled in;
// the new password then works.
test("account security: change password, sign out everywhere, email prefill", async ({
  page,
  browser,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const { email, password } = await newGuardian(playwright, "Secure");
  const newPassword = "e2e-password-2";

  // Another browser in the game with the same account.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await enterGame(otherPage, email, password);

  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByTestId("characters")).toBeVisible();

  const panel = page.getByTestId("account-security");
  await panel.getByText("Cuenta y seguridad").click();
  const form = panel.getByTestId("change-password");
  await expect(form).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await shot(page, "03c-account-security");

  // A wrong current password is refused and changes nothing.
  await form.getByLabel("Contraseña actual").fill("not-the-password");
  await form.getByLabel("Contraseña nueva").fill(newPassword);
  await form.getByRole("button", { name: "Cambiar contraseña" }).click();
  await expect(panel.getByRole("alert")).toHaveText("La contraseña actual no es correcta.");
  errors.length = 0; // the refused change answers 401, which the browser logs: expected

  await form.getByLabel("Contraseña actual").fill(password);
  await form.getByLabel("Contraseña nueva").fill(newPassword);
  await form.getByRole("button", { name: "Cambiar contraseña" }).click();
  await expect(panel.getByTestId("password-changed")).toBeVisible();
  // The other session's character left the game with PASSWORD_CHANGED.
  await expect(otherPage.getByTestId("login-form")).toBeVisible({ timeout: 20_000 });
  await expect(otherPage.getByText("Se cambió la contraseña de la cuenta")).toBeVisible();
  await other.close();
  await shot(page, "03d-password-changed");

  // This session survived the change; "sign out everywhere" ends it as well.
  await panel.getByTestId("logout-all-button").click();
  await panel.getByTestId("logout-all-confirm").click();
  await expect(loginForm).toBeVisible();
  await expect(loginForm.getByLabel("Email")).toHaveValue(email);
  await expect(loginForm.getByLabel("Contraseña")).toHaveValue("");
  await shot(page, "03e-login-prefill");

  // The old password no longer works; the new one does.
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Email o contraseña incorrectos.");
  errors.length = 0; // the refused login's 401: expected
  await loginForm.getByLabel("Contraseña").fill(newPassword);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByTestId("characters")).toBeVisible();
  expect(errors).toEqual([]);
});
