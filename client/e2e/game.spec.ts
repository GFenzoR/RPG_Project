// Logs in through the UI with an account and character created by the API, enters the
// test island, walks 5 steps (keyboard and click) and saves screenshots for review.
// Any console error or uncaught exception fails the test.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { databaseUrl, serverURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(shots, `${name}.png`) });

/** Random letters with no vowels, so a name never contains a reserved word. */
function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
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
  await page.goto("/?lang=es");
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

  // The world: FullMapView drawn on a pixel-perfect canvas.
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
  expect(size.width).toBe(15 * 32 * scale);
  expect(size.height).toBe(11 * 32 * scale);
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
    await page.keyboard.press(key);
    x += dx;
    y += dy;
    await arrived(page, x, y);
  }
  await shot(page, "05-walked-keyboard");

  // 2 more by clicking a tile two columns to the right (WalkPath).
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

  // Inventory (T1.8): a new character starts with an equipped backpack. Right click opens
  // it, shift+click looks at it, and it can be dragged onto the map and back.
  const inventory = page.getByTestId("inventory");
  const backpackSlot = inventory.getByTestId("slot-backpack");
  await expect(backpackSlot.locator("[data-item=backpack]")).toBeVisible();
  await backpackSlot.locator("[data-item]").click({ button: "right" });
  const backpackWindow = inventory.locator('[data-container-item="backpack"]');
  await expect(backpackWindow).toBeVisible();
  await expect(backpackWindow.locator(".slot")).toHaveCount(20);
  await backpackSlot.locator("[data-item]").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("game-log")).toContainText("Ves mochila (20 lugares)");
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
  await expect(backpackWindow).toBeVisible(); // still within reach: the window stays open
  await shot(page, "10-backpack-on-map");
  // Map → slot: equipped again.
  await drag(ownTile, slotCenter);
  await expect(backpackSlot.locator("[data-item=backpack]")).toBeVisible();

  // Leave the game: back to the character list with the server's reason.
  await page.getByRole("button", { name: "Salir del juego" }).click();
  await expect(page.getByRole("status")).toHaveText("Saliste del juego.");

  expect(errors).toEqual([]);
});

test("walk out of town, fight a wolf from the battle list", async ({ page, playwright }) => {
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

  await page.goto("/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  // Opening the page without a session cookie answers 401 (logged by the browser): expected.
  errors.length = 0;
  const battle = page.getByTestId("battle-list");
  await expect(battle.getByText("No hay criaturas a la vista.")).toBeVisible();

  // The wolves of testisle roam 11-19 tiles north of the temple: walk towards them.
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

  // A wolf shows up in the battle list (and comes for us): attack it from there.
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

  // Every swing trains fists (no weapon yet): the skills panel shows the progress.
  const skills = page.getByTestId("skills-panel");
  await expect(skills.getByText("Puños")).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__rpgClient?.skills().find((s) => s.id === "fist")?.percent ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  await expect(skills.locator('[data-skill="fist"] [role="progressbar"]')).not.toHaveAttribute(
    "aria-valuenow",
    "0",
  );
  await skills.screenshot({ path: join(shots, "08-skills-panel.png") });

  await page.getByRole("button", { name: "Salir del juego" }).click();
  await expect(page.getByRole("status")).toHaveText("Saliste del juego.");
  expect(errors).toEqual([]);
});

test("an arcanist casts a spell with F1 and by its words", async ({ page, playwright }) => {
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

  await page.goto("/?lang=es");
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
  // Chase the target: the nearest wolf may be one hurt by an earlier test (the server and
  // its world are shared by the suite), and a hurt wolf flees and never comes within the
  // bolt's range on its own. The player is faster than a wolf, so chasing closes in.
  await page.getByLabel("Perseguir al objetivo").check();
  const battle = page.getByTestId("battle-list");
  const wolf = battle.getByRole("button", { name: /lobo/ }).first();
  await expect(wolf).toBeVisible({ timeout: 30_000 });
  await wolf.click();
  // The battle list is sorted by distance and wolves move, so `wolf` (first()) can point
  // at another wolf by now: check that exactly one entry is the target instead.
  await expect(battle.locator('button[aria-pressed="true"]')).toHaveCount(1);

  // F1 until the bolt flies (the wolf must be within 4 tiles and in sight), then catch
  // the projectile or its energy effect on screen.
  await page.locator("body").click({ position: { x: 1, y: 1 } }); // focus out of the say line
  await expect
    .poll(
      async () => {
        await page.keyboard.press("F1");
        await page.waitForTimeout(60);
        const m = await page.evaluate(() => window.__rpgClient?.magic(300));
        return (m?.projectiles ?? 0) > 0 || (m?.effects ?? []).includes(13);
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
  await shot(page, "11-spell");
  // The cast spent mana and started the cooldown shade on F1.
  await expect(hotbar.locator('[data-hotkey="F1"] .cd')).toBeVisible();
  await hotbar.screenshot({ path: join(shots, "12-hotbar.png") });

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
  // Puerto's NPCs live on Isla del Puerto (T1.16): this character's residence is Farol, so
  // it wakes up at that temple, next to the priestess and the provisioner.
  execFileSync("psql", [
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'puerto' WHERE name = '${name}'`,
  ]);

  await page.goto("/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0; // the 401 of opening the page without a session cookie

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
  // Blessings cost 200 coins: the server refuses a new character.
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
  await expect(shop.locator('[data-item="rope"]')).toContainText("50");
  await page.waitForTimeout(300); // let the icons load before the screenshot
  await shot(page, "14-shop");
  await shop.getByRole("tab", { name: "Vender" }).click();
  await expect(shop.locator('[data-item="wolf_pelt"]')).toContainText("Tienes 0");

  // Walking away (keyboard: the windows cover part of the map) closes both windows.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  for (let i = 0; i < 3; i++) {
    const before = await self(page);
    await page.keyboard.press("ArrowLeft");
    if (before) await arrived(page, before.x - 1, before.y);
  }
  await expect(dialog).toBeHidden();
  await expect(shop).toBeHidden();

  await page.getByRole("button", { name: "Salir del juego" }).click();
  await expect(page.getByRole("status")).toHaveText("Saliste del juego.");
  expect(errors).toEqual([]);
});

test("die to a wolf: death screen and wake up at the temple", async ({ page, playwright }) => {
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
  execFileSync("psql", [
    databaseUrl,
    "-c",
    `UPDATE characters SET health = 1 WHERE name = '${name}'`,
  ]);

  await page.goto("/?lang=es");
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
  // temple and the second click is not needed.
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
  if (!(await screen.isVisible())) await click(start.x, start.y - 9);

  await expect(screen).toBeVisible({ timeout: 60_000 });
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
  execFileSync("psql", [
    databaseUrl,
    "-c",
    `INSERT INTO inventory_items (character_id, slot, item_id)
     SELECT id, s.slot, s.item FROM characters, (VALUES (3, 48), (5, 38)) AS s(slot, item)
     WHERE name = '${name}'`,
  ]);

  await page.goto("/?lang=es");
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
  // Two hops: the view only shows 7 tiles on each side.
  let p = await toClient(1062, 1055);
  await page.mouse.click(p.x, p.y);
  await arrived(page, 1062, 1055);
  p = await toClient(1067, 1055);
  await page.mouse.click(p.x, p.y);
  await arrived(page, 1067, 1055);
  p = await toClient(1068, 1055);
  await page.mouse.click(p.x, p.y);
  await arrived(page, 1068, 1055);

  // Right click on the pickaxe picks "use with"; the next click on the map uses it there.
  const pickaxe = page.getByTestId("slot-right_hand").locator("[data-item=pickaxe]");
  const log = page.getByTestId("game-log");
  for (let i = 0; i < 16; i++) {
    await pickaxe.click({ button: "right" });
    await expect(page.locator("body")).toHaveClass(/using-item/);
    const v = veins[i % 2];
    if (!v) throw new Error("no vein");
    p = await toClient(v.x, v.y);
    await page.mouse.click(p.x, p.y);
    await expect(page.locator("body")).not.toHaveClass(/using-item/);
    await page.waitForTimeout(350); // the answer arrives; its effect lasts 600 ms
    if ((await log.textContent())?.includes("Conseguiste")) break;
    await page.waitForTimeout(1300); // gathering.use_interval_ms
  }
  await expect(log).toContainText("Conseguiste");
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

  await page.goto("/?lang=es");
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

  await page.getByTestId("chat-channel").selectOption({ label: "Gritar" });
  await sayInput.fill("hay alguien");
  await sayInput.press("Enter");
  await expect(chat).toContainText(`${name} grita: hay alguien`);

  await page.getByTestId("chat-channel").selectOption({ label: "Global" });
  await sayInput.fill("hola a todos");
  await sayInput.press("Enter");
  await expect(chat).toContainText(`[Global] ${name}: hola a todos`);
  // The global channel waits between two messages (balance.yaml chat.global_interval_ms).
  await sayInput.fill("otra vez");
  await sayInput.press("Enter");
  await expect(page.getByTestId("game-log")).toContainText(
    "para volver a escribir en el canal global.",
  );
  await page.locator(".side").screenshot({ path: join(shots, "16-chat.png") });

  // Switching the language translates every screen at once, the running game included.
  await page.getByTestId("language").selectOption("en");
  await expect(chat).toContainText(`${name} says: <b>hola</b> {name}`);
  await expect(chat).toContainText(`[Global] ${name}: hola a todos`);
  await expect(page.getByRole("button", { name: "Leave game" })).toBeVisible();
  await expect(page.getByTestId("chat-channel")).toContainText("Yell");
  await shot(page, "17-language-en");

  // The choice is remembered: without ?lang= the next visit opens in English.
  await page.goto("/");
  await expect(page.getByTestId("characters").getByRole("button", { name: "Play" })).toBeVisible();
  await expect(page.getByTestId("language")).toHaveValue("en");
  expect(errors).toEqual([]);
});
