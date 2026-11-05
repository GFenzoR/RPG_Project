// Logs in through the UI with an account and character created by the API, enters the
// test island, walks 5 steps (keyboard and click) and saves screenshots for review.
// Any console error or uncaught exception fails the test.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
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
  await expect(backpackWindow.locator(".slot")).toHaveCount(24);
  await backpackSlot.locator("[data-item]").click({ modifiers: ["Shift"] });
  await expect(page.getByTestId("game-log")).toContainText("Ves mochila (24 lugares)");
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

/**
 * Where to wait for a wolf when none is in view: 7 tiles south of the centre of
 * testisle_wolves ((1056, 1041), radius 4, world/islands/testisle/spawns.yaml). The server
 * never respawns a monster on a tile a player sees (ViewHalfH is 6), so standing on the
 * spawn would keep it empty; from here most of it is out of view, and a respawned wolf
 * that wanders a step or two comes into view and, aggressive, comes for us.
 */
const WOLF_WAIT = { x: 1056, y: 1048 };

test("an arcanist casts a spell with F1 and by its words", async ({ page, playwright }) => {
  // Finding a wolf can take one respawn (respawn_seconds 60) when earlier tests (or
  // --repeat-each) killed them all.
  test.setTimeout(180_000);
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
  // Chase the target: a hurt wolf flees and never comes within the bolt's range on its own.
  // The player is faster than a wolf, so chasing closes in.
  await page.getByLabel("Perseguir al objetivo").check();
  const battle = page.getByTestId("battle-list");

  // The server and its world are shared by the suite (and by --repeat-each): earlier tests
  // hurt or kill testisle's 3 wolves, so the nearest one may be hurt, die to our fists
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
    await page.locator("body").click({ position: { x: 1, y: 1 } }); // keys go to the game
  };

  // F1 until the bolt flies (the wolf must be within 4 tiles and in sight), then catch
  // the projectile or its energy effect on screen. They live 250 ms and a bolt can kill the
  // wolf, so watch for them in the page rather than only right after each F1 (on a busy
  // CPU the bolt's messages can come after the next poll has seen the target gone). If the
  // target is lost with no bolt (killed by our fists, out of view), take another wolf.
  await page.evaluate(() => {
    const w = window as unknown as { e2eBolt?: boolean };
    w.e2eBolt = false;
    const watch = setInterval(() => {
      const m = window.__rpgClient?.magic(300);
      if ((m?.projectiles ?? 0) > 0 || (m?.effects ?? []).includes(13)) {
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

  await page.getByRole("button", { name: "Salir del juego" }).click();
  await expect(page.getByRole("status")).toHaveText("Saliste del juego.");
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
  execFileSync("psql", [
    databaseUrl,
    "-c",
    `INSERT INTO inventory_items (character_id, slot, item_id, count)
     SELECT id, s.slot, s.item, s.count FROM characters,
       (VALUES (3, 48, 1), (5, 89, 1), (10, 87, 30)) AS s(slot, item, count)
     WHERE name = '${rangerName}'`,
  ]);

  await page.goto("/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  errors.length = 0; // the 401 of opening the page without a session cookie

  // The creation form offers the four vocations; create the druid there.
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
  await shot(page, "19-create-druid");
  await form.getByRole("button", { name: "Crear personaje" }).click();
  const list = page.getByTestId("characters");
  await expect(list.getByText("Druida · Nivel 1")).toBeVisible();
  await expect(list.getByText("Montaraz · Nivel 1")).toBeVisible();

  // Play the druid: its spells fill the bar by level.
  await list.locator("li", { hasText: druidName }).getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  const hotbar = page.getByTestId("hotbar");
  await expect(hotbar.locator('[data-hotkey="F1"] [data-spell="frost_lance"]')).toBeVisible();
  await expect(hotbar.locator('[data-hotkey="F2"] [data-spell="verdant_mend"]')).toBeVisible();
  await expect(hotbar.locator('[data-hotkey="F3"] [data-spell="mend_other"]')).toBeVisible();
  await page.locator("body").click({ position: { x: 1, y: 1 } }); // keys go to the game

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
  await expect(shop.locator('[data-item="rope"]')).toContainText("45");
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
  // Mining 38: the iron vein's chance is at its max (0.3 + 0.02 per level over 10, up to
  // 0.85, data/items/decoration.yaml). At 0.3 a run of bad swings (each 1.5 s apart, ~3 s
  // on a loaded single core) could take longer than the test, and a wolf wandering in
  // from earlier tests gets that much longer to kill a level-1 miner.
  execFileSync("psql", [
    databaseUrl,
    "-c",
    `INSERT INTO character_skills (character_id, skill, level)
     SELECT id, 'mining', 38 FROM characters WHERE name = '${name}'
     ON CONFLICT (character_id, skill) DO UPDATE SET level = 38, tries = 0`,
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
        const hx = s.x + Math.max(-6, Math.min(6, goal.x - s.x));
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
          if (await free(hx + dx, hy + dy)) {
            const p = await toClient(hx + dx, hy + dy);
            await page.mouse.click(p.x, p.y);
            break;
          }
        }
        return `${s.x},${s.y}`;
      },
      { timeout: 40_000, intervals: [1_000] },
    )
    .toBe("there");
  let p: { x: number; y: number };

  // Right click on the pickaxe picks "use with"; the next click on the map uses it there.
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
    await pickaxe.click({ button: "right" });
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
    ],
    {
      cwd: join(import.meta.dirname, "..", "..", "server"),
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );

  async function enter(email: string): Promise<Page> {
    const page = await browser.newPage();
    await page.goto("/?lang=es");
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
  await plPage.locator(".side").screenshot({ path: join(shots, "18-gm-announce.png") });

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
  const question = (await check.locator("p").first().textContent()) ?? "";
  const color = ["rojo", "azul", "verde", "amarillo"].find((c) => question.includes(c));
  expect(color).toBeDefined();
  await check.getByRole("button", { name: new RegExp(color ?? "", "i") }).click();
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
  await again.goto("/?lang=es");
  const form = again.getByTestId("login-form");
  await form.getByLabel("Email").fill(player.email);
  await form.getByLabel("Contraseña").fill(password);
  await form.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(again.getByTestId("login-form")).toContainText("Esta cuenta está suspendida.");
  await shot(again, "21-banned-login");
});

test("T3.2: a guardian casts haste: condition badge, faster speed and steps", async ({
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
  execFileSync("psql", [
    databaseUrl,
    "-c",
    `UPDATE characters SET level = 8, experience = 4704, mana = 48 WHERE name = '${name}'`,
  ]);

  await page.goto("/?lang=es");
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
  const conditions = page.getByTestId("conditions");
  await expect(conditions.locator("[data-condition]")).toHaveCount(0);

  // Cast it by its words: the server applies the condition and the faster speed.
  const sayInput = page.getByTestId("say").getByRole("textbox");
  await sayInput.fill("pede celeri");
  await sayInput.press("Enter");
  await expect(conditions.locator('[data-condition="hasted"]')).toHaveText("Acelerado");
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
    await page.keyboard.press("ArrowRight");
    await arrived(page, start.x + i + 1, start.y);
  }
  expect(Date.now() - t0).toBeLessThan(10_000);
  await shot(page, "22-haste");
  await page.locator(".hud").screenshot({ path: join(shots, "23-conditions-hud.png") });
  expect(errors).toEqual([]);
});

test("T3.3: two players form a party from the battle list and see the panel", async ({
  browser,
  playwright,
}) => {
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

  async function enter(email: string): Promise<Page> {
    const page = await browser.newPage();
    await page.goto("/?lang=es");
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

  // Both wake up at the temple: the mate is in the leader's battle list, with "+".
  const leadPanel = leadPage.getByTestId("party-panel");
  await expect(leadPanel).toContainText("No estás en un grupo.");
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
    await expect(panel).toContainText("Experiencia compartida: apagada");
  }
  await expect(matePage.getByTestId("party-share")).toHaveCount(0);
  await leadPage.getByTestId("party-share").click();
  // On, but nobody fought yet: no sharing, and the panel says why.
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
  await leadPage.locator(".side").screenshot({ path: join(shots, "25-party-panel.png") });

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
  await matePage.locator(".side").screenshot({ path: join(shots, "37-report-form.png") });
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

  // Leaving disbands a party of two.
  await matePage.getByTestId("party-leave").click();
  await expect(leadPanel).toContainText("No estás en un grupo.");
  await expect(leadPage.getByTestId("game-log")).toContainText("El grupo se disolvió.");
  await leadPage.close();
  await matePage.close();
});

test("T3.4: cook a fish at the hearth of Farol from the station window", async ({
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
  // Stand just south of Farol's cooking hearth (3172, 6366: world/islands/puerto), with a
  // backpack (48) holding 3 raw fish (10), and cooking 30 so the grilled fish is at its
  // 97% cap (data/recipes.yaml).
  execFileSync("psql", [
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

  await page.goto("/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0;
  await arrived(page, 3172, 6367);

  // Right click on the hearth opens its recipes.
  const hearth = await page.evaluate(() => window.__rpgClient?.tileToClient(3172, 6366));
  if (!hearth) throw new Error("no canvas");
  await page.mouse.click(hearth.x, hearth.y, { button: "right" });
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
  await expect(page.getByTestId("skills-panel")).toContainText("Cocina");
  await shot(page, "17-crafting-done");
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
  execFileSync("psql", [
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'puerto', pos_x = 3201, pos_y = 6431, pos_z = 7 WHERE name = '${name}';
     WITH bp AS (
       INSERT INTO inventory_items (character_id, slot, item_id)
       SELECT id, 3, 48 FROM characters WHERE name = '${name}' RETURNING id, character_id)
     INSERT INTO inventory_items (character_id, container_id, slot, item_id, count)
     SELECT character_id, id, 0, 8, 50 FROM bp`,
  ]);

  await page.goto("/?lang=es");
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
  const route = dialog.getByRole("button", { name: /isla de pruebas/ });
  await expect(route).toBeVisible();
  await shot(page, "26-boat-routes");

  await route.click();
  await expect(page.getByTestId("voyage")).toContainText("Zarpaste hacia Isla de pruebas");
  await shot(page, "27-boat-sailing");
  await expect(dialog).toBeHidden();
  await arrived(page, 1058, 1056);
  const log = page.getByTestId("game-log");
  await expect(log).toContainText("Pagaste 30 monedas.");
  await expect(log).toContainText("Zarpaste hacia Isla de pruebas.");
  await expect(page.getByTestId("voyage")).toBeHidden({ timeout: 5000 });
  await shot(page, "28-boat-arrived");
  expect(errors).toEqual([]);
});

// Registers an account with one guardian and returns its credentials (T3.6 tests).
async function newGuardian(
  playwright: { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } },
  tag: string,
): Promise<{ email: string; password: string; name: string }> {
  const email = `e2e-${tag}-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `${tag} ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
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
  return { email, password, name };
}

async function enterGame(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
}

test("T3.6: sail to the Forest Isle after Chapter 1 and meet its ferryman", async ({
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
  execFileSync("psql", [
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
  await dialog.getByRole("button", { name: "A la Isla del Bosque (80 monedas)." }).click();
  await expect(page.getByTestId("voyage")).toContainText("Zarpaste hacia Isla del Bosque");
  await arrived(page, 4120, 6100);
  await expect(page.getByTestId("game-log")).toContainText("Pagaste 80 monedas.");
  await expect(page.getByTestId("voyage")).toBeHidden({ timeout: 5000 });
  await shot(page, "29-bosque-dock");

  // The ferryman of Raigal sells the way back.
  const ferryman = await page.evaluate(() => window.__rpgClient?.tileToClient(4122, 6100));
  if (!ferryman) throw new Error("no canvas");
  await page.mouse.click(ferryman.x, ferryman.y, { button: "right" });
  await expect(dialog).toContainText("Tavin Rema");
  await dialog.getByRole("button", { name: "Quiero viajar." }).click();
  await expect(
    dialog.getByRole("button", { name: "A la Isla del Puerto (60 monedas)." }),
  ).toBeVisible();
  await shot(page, "30-bosque-ferryman");
  expect(errors).toEqual([]);
});

test("T3.6: wake up at the temple of Raigal and talk to the druid", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { email, password, name } = await newGuardian(playwright, "Rooted");
  // Resident of the Forest Isle with no saved position: wakes up at its temple.
  execFileSync("psql", [
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'bosque', level = 15, experience = 35280 WHERE name = '${name}';
     INSERT INTO quest_state (character_id, key, value)
     SELECT id, 'quest.ch1_shipwreck', 2 FROM characters WHERE name = '${name}'`,
  ]);
  await enterGame(page, email, password);
  await arrived(page, 4150, 6105);
  await shot(page, "31-bosque-temple");
  // Out of the temple door and east across the plaza to the druid's grove, by clicks.
  for (const [x, y] of [
    [4150, 6109],
    [4156, 6109],
    [4162, 6109],
    [4169, 6110],
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
  // Headless Chromium plays to no device: spy on Web Audio to see what gets scheduled.
  await page.addInitScript(() => {
    const w = window as unknown as { __audioStarts: number };
    w.__audioStarts = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
      w.__audioStarts++;
      return start.apply(this, args);
    };
  });
  const starts = (): Promise<number> =>
    page.evaluate(() => (window as unknown as { __audioStarts: number }).__audioStarts);
  const history = (): Promise<string[]> => page.evaluate(() => window.__rpgAudio?.history() ?? []);

  const { email, password } = await newGuardian(playwright, "Hark");
  await page.goto("/?lang=es");
  // Nothing may start before a gesture (browser autoplay rules).
  expect(await page.evaluate(() => window.__rpgAudio?.unlocked())).toBe(false);
  expect(await starts()).toBe(0);

  await enterGame(page, email, password);
  errors.length = 0;
  expect(await page.evaluate(() => window.__rpgAudio?.unlocked())).toBe(true);
  // The test island plays the harbour loop and the waves (assets/sounds.yaml).
  await expect
    .poll(() => page.evaluate(() => window.__rpgAudio?.loops()))
    .toEqual({ music: "music_puerto", ambient: "amb_olas" });
  // An own step makes a sound too. The engine drops a sound whose file is still loading
  // after LATE_MS (a late sound is worse than none), so on a slow runner the first step can
  // be silent: walk back and forth until one plays (its file is cached by then).
  const start = await self(page);
  if (!start) throw new Error("no own creature");
  for (let i = 0; ; i++) {
    await page.keyboard.press("ArrowRight");
    await arrived(page, start.x + 1, start.y);
    const played = await expect
      .poll(history, { timeout: 2000 })
      .toContain("step")
      .then(
        () => true,
        () => false,
      );
    if (played || i === 4) break;
    await page.keyboard.press("ArrowLeft");
    await arrived(page, start.x, start.y);
  }
  expect(await history()).toContain("step");
  expect(await starts()).toBeGreaterThanOrEqual(3); // two loops and a step

  // Options: lower the music, mute the effects.
  await page.locator(".hud").getByTestId("options-button").click();
  const options = page.getByTestId("options");
  await expect(options.getByRole("heading")).toHaveText("Sonido");
  await options.getByTestId("volume-music").fill("20");
  await options.getByTestId("mute-sfx").check();
  await expect(options.locator(".channel").nth(1)).toContainText("Música");
  await expect(options.locator(".channel").nth(1).locator(".value")).toHaveText("20");
  await options.screenshot({ path: join(shots, "34-sound-options.png") });
  await shot(page, "35-sound-options-game");
  // Muted effects spend no voice: a step is silent now.
  await options.getByRole("button", { name: "Cerrar" }).click();
  await expect(options).toHaveCount(0);
  const before = (await history()).length;
  await page.keyboard.press("ArrowLeft");
  await arrived(page, start.x, start.y);
  expect((await history()).slice(before)).not.toContain("step");
  // Buttons sound on the interface channel, which is not muted. "Entrar" and "Jugar" may
  // have been dropped while the file loaded (see above); after the options clicks it is
  // cached, so one more button click plays.
  await page.locator(".hud").getByTestId("options-button").click();
  await expect(options).toHaveCount(1);
  await options.getByRole("button", { name: "Cerrar" }).click();
  await expect.poll(history).toContain("click");

  // Saved: after a reload the panel (on the login screen) shows the same values.
  await page.reload();
  await page.locator(".corner").getByTestId("options-button").click();
  await expect(page.getByTestId("volume-music")).toHaveValue("20");
  await expect(page.getByTestId("mute-sfx")).toBeChecked();
  await expect(page.getByTestId("volume-master")).toHaveValue("80");
  await shot(page, "36-sound-options-login");

  // The panel moves from the corner to the game's header: it must show what is in use
  // now, not what the page loaded with (no reload this time).
  await page.getByTestId("mute-ambient").check();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  await page.locator(".hud").getByTestId("options-button").click();
  const hud = page.locator(".hud").getByTestId("options");
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

test("T4.2: a new character in Puerto follows the tutorial, then skips it", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  // A brand-new character that starts in Puerto (the tutorial island) wakes up at the
  // temple of the Lantern with the first hint; testisle characters never see it.
  const { email, password, name } = await newGuardian(playwright, "Pupil");
  execFileSync("psql", [
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'puerto' WHERE name = '${name}'`,
  ]);
  await enterGame(page, email, password);
  errors.length = 0; // the 401 of opening the page without a session cookie

  const panel = page.getByTestId("tutorial-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-step", "first_steps");
  await expect(panel).toContainText("1 / 6"); // a guardian skips the spell step
  await expect(panel).toContainText("Camina 5 pasos");

  // Walking advances it: find a free direction, then step back and forth. The server
  // counts each confirmed step.
  await page.locator("body").click({ position: { x: 1, y: 1 } });
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
    await page.keyboard.press(k);
    await page.waitForTimeout(700);
    const after = await still();
    if (after.x !== before.x || after.y !== before.y) {
      key = back[k] ?? "";
      break;
    }
  }
  expect(key).not.toBe("");
  await expect(page.getByTestId("tutorial-progress")).toHaveText("Llevas 1 de 5.");
  await page.keyboard.press(key);
  await page.waitForTimeout(700);
  await still();
  await expect(page.getByTestId("tutorial-progress")).toHaveText("Llevas 2 de 5.");
  await shot(page, "40-tutorial-walk");
  await panel.screenshot({ path: join(shots, "40-tutorial-panel.png") });
  for (let i = 0; i < 3; i++) {
    key = back[key] ?? "";
    await page.keyboard.press(key);
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
  await expect(panel).toHaveAttribute("data-step", "open_backpack");
  await expect(page.locator("body")).toHaveAttribute("data-tutorial-focus", "inventory");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("dialog")).toBeHidden();
  await page.waitForTimeout(800); // a full pulse of the highlight's outline
  await shot(page, "41-tutorial-highlight");

  // Skipping ends it for good: the server confirms and the panel and highlight go away.
  await page.getByTestId("tutorial-skip").click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("game-log")).toContainText("Saltaste el tutorial.");
  await expect(page.locator("body")).not.toHaveAttribute("data-tutorial-focus", /.*/);
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
