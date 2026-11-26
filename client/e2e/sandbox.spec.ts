// Thimblewick, the sandbox island (docs/16-probar-el-juego.md): a character of
// that town wakes up in its temple next to the instructor, and a staff /tp shows the
// hunting pens, the yard of portals and the cave under it. It runs on the main E2E server
// (start town testisle): the town set in the database stands for `make play`'s
// -start-town pruebas, which picks the same temple for a character with no town.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { stepKey } from "./keys.ts";
import { psql } from "./psql.ts";
import { closeWindow, openWindow } from "./windows.ts";
import { databaseUrl, serverURL } from "../playwright.config.ts";
import { characterName } from "./names.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });

/** A page load (Vite serves every module) or a push through the game server. */
const SLOW = { timeout: 30_000 };

function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
}

async function newGuardian(
  playwright: { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } },
  tag: string,
): Promise<{ email: string; password: string; name: string }> {
  const email = `e2e-${tag}-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = characterName(tag);
  const api = await playwright.request.newContext({ baseURL: serverURL });
  expect((await api.post("/api/auth/register", { data: { email, password } })).status()).toBe(201);
  const login = await api.post("/api/auth/login", {
    data: { email, password, token_in_body: true },
  });
  const { token } = (await login.json()) as { token: string };
  expect(
    (
      await api.post("/api/characters", {
        data: { name, vocation: "guardian" },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(201);
  await api.dispose();
  return { email, password, name };
}

async function enterGame(
  page: Page,
  who: { email: string; password: string; name: string },
): Promise<void> {
  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await expect(loginForm).toBeVisible(SLOW);
  await loginForm.getByLabel("Email").fill(who.email);
  await loginForm.getByLabel("Contraseña").fill(who.password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  const list = page.getByTestId("characters");
  await expect(list.getByText(who.name)).toBeVisible(SLOW);
  await list.getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true, undefined, SLOW);
}

test("music: the island's track, then the caves' through an equal-power crossfade, with no errors", async ({
  page,
  playwright,
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const who = await newGuardian(playwright, "Musico");
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'pruebas' WHERE name = '${who.name}';
     UPDATE accounts SET role = 'gm' WHERE email = lower('${who.email}');`,
  ]);
  await enterGame(page, who); // its clicks are the gesture that unlocks the audio
  errors.length = 0; // the login page's own requests (a 401 before signing in) are not ours
  const music = () => page.evaluate(() => window.__rpgAudio?.music());
  // The sandbox island plays the harbour's pool (assets/sounds.yaml): after the title's fade,
  // one track alone, on its own element, at full gain.
  await expect
    .poll(
      async () => {
        const m = await music();
        const v = m?.voices ?? [];
        return m?.pool === "town_puerto" && v.length === 1 && v[0]?.playing && v[0].gain > 0.99;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const island = (await music())?.voices[0];
  expect(island?.position).toBeGreaterThan(0); // from an entry point, not its first second

  // Down to the cave of the sandbox (floor 8): after the dwell, the caves' pool crossfades
  // in. Every sample in between keeps the power: out² + in² = 1, on the director's
  // envelopes and on the gains the nodes really have (`heard`: what the ramps did).
  const say = page.getByTestId("say").getByRole("textbox");
  await say.fill("/tp 2118 2092 8");
  await say.press("Enter");
  const both: {
    out: number;
    into: number;
    heardOut: number | undefined;
    heardIn: number | undefined;
  }[] = [];
  const deadline = Date.now() + 30_000;
  for (;;) {
    const m = await music();
    const v = m?.voices ?? [];
    const out = v.find((x) => x.pool === "town_puerto");
    const into = v.find((x) => x.pool === "cave");
    if (out && into && out.gain < 0.999 && into.gain > 0.001)
      both.push({ out: out.gain, into: into.gain, heardOut: out.heard, heardIn: into.heard });
    if (m?.pool === "cave" && v.length === 1 && v[0]?.playing && v[0].gain > 0.99) break;
    if (Date.now() > deadline) throw new Error(`no crossfade into the caves: ${JSON.stringify(m)}`);
    await page.waitForTimeout(150);
  }
  expect(both.length).toBeGreaterThan(3); // a 5 s fade sampled every ~150 ms
  for (const s of both) expect(s.out ** 2 + s.into ** 2).toBeCloseTo(1, 2);
  // The nodes are read a render quantum apart at most: a looser bound.
  for (const s of both) expect((s.heardOut ?? 0) ** 2 + (s.heardIn ?? 0) ** 2).toBeCloseTo(1, 1);
  // The old track faded out while the new one faded in.
  expect(both.at(-1)?.out ?? 1).toBeLessThan(both[0]?.out ?? 0);
  expect(both.at(-1)?.into ?? 0).toBeGreaterThan(both[0]?.into ?? 1);
  expect(both.at(-1)?.heardOut ?? 1).toBeLessThan(both[0]?.heardOut ?? 0);
  const cave = (await music())?.voices[0];
  expect(cave?.sound).toMatch(/^music_cueva/);
  expect(cave?.position).toBeGreaterThan(0);
  expect(cave?.heard ?? 0).toBeGreaterThan(0.95);
  // Its element plays, and where the director thinks the track is (it seeked to the entry).
  expect(Math.abs((cave?.time ?? 0) - (cave?.position ?? 0))).toBeLessThan(1.5);
  await page.waitForTimeout(300);
  await shot(page, "93b-music-cave");
  expect(errors).toEqual([]);
});

test("sandbox island: wake up in its temple, then /tp to the pens, the yard of portals and the cave", async ({
  page,
  playwright,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const who = await newGuardian(playwright, "Probador");
  // A resident of the sandbox island with no saved position (a new character): the server
  // puts it on its temple. A gm, for /tp.
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'pruebas' WHERE name = '${who.name}';
     UPDATE accounts SET role = 'gm' WHERE email = lower('${who.email}');`,
  ]);
  await enterGame(page, who);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const standsOn = async (x: number, y: number, z: number): Promise<void> => {
    await expect
      .poll(
        async () => {
          const s = await page.evaluate(() => window.__rpgClient?.self());
          return s && !s.pending && !s.walking ? `${s.x},${s.y},${s.z}` : "moving";
        },
        { timeout: 20_000 },
      )
      .toBe(`${x},${y},${z}`);
  };
  const topOf = (x: number, y: number, z: number): Promise<number | undefined> =>
    page.evaluate(({ a, b, c }) => window.__rpgClient?.tile(a, b, c)?.at(-1), { a: x, b: y, c: z });
  const item = (id: string): Promise<number | undefined> =>
    page.evaluate((i) => window.__rpgClient?.itemNumber(i), id);

  // The temple of Thimblewick (world/islands/pruebas/island.yaml), the instructor
  // beside it.
  await standsOn(2095, 2086, 7);
  await expect
    .poll(() => page.evaluate(() => window.__rpgClient?.npcs().map((n) => n.contentId) ?? []))
    .toContain("pruebas_trainer");
  await page.waitForTimeout(300); // let the atlas textures upload before the screenshot
  await shot(page, "90-sandbox-temple");

  const say = page.getByTestId("say").getByRole("textbox");
  const tp = async (x: number, y: number, z: number): Promise<void> => {
    await say.fill(`/tp ${x} ${y} ${z}`);
    await say.press("Enter");
    await standsOn(x, y, z);
    await page.waitForTimeout(300);
  };

  // The hunting trail, below the pens of the rats and the wolves (log walls, open south).
  await tp(2083, 2081, 7);
  expect(await topOf(2078, 2079, 7)).toBe(await item("wooden_wall")); // pen 1, beside its gate
  expect(await topOf(2088, 2079, 7)).toBe(await item("dirt")); // pen 2's gate: no wall
  await shot(page, "91-sandbox-pens");

  // The yard of portals: stairs, the trapdoor of the ladder and the hole.
  await tp(2118, 2093, 7);
  expect(await topOf(2121, 2090, 7)).toBe(await item("stairs_down"));
  expect(await topOf(2116, 2090, 7)).toBe(await item("ladder_down"));
  expect(await topOf(2119, 2094, 7)).toBe(await item("hole"));
  await shot(page, "92-sandbox-portals");

  // The cave under it: the ladder up, the light under the hole and the teleport.
  await tp(2118, 2092, 8);
  expect(await topOf(2121, 2090, 8)).toBe(await item("stairs_up"));
  expect(await topOf(2116, 2090, 8)).toBe(await item("ladder_up"));
  expect(await topOf(2119, 2094, 8)).toBe(await item("rope_spot"));
  await shot(page, "93-sandbox-cave");
  expect(errors).toEqual([]);
});

// The fixes of the sandbox playtest (docs/16): M1, the client knows walls block (a click
// beyond the temple wall walks around it); M3, the arrows walk after a checkbox or a select
// of the side panel took the focus; M2, the provisioner's shop scrolls inside the window at
// 1280x800 and its last line (the spare backpack) is bought; m8, a count over the limit
// shows the limit.
test("sandbox playtest: walls block clicks, arrows after the panel, the shop scrolls (M1-M3)", async ({
  page,
  playwright,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const who = await newGuardian(playwright, "Revisor");
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'pruebas' WHERE name = '${who.name}';
     UPDATE accounts SET role = 'admin' WHERE email = lower('${who.email}');`,
  ]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await enterGame(page, who);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const at = async (): Promise<string> => {
    const s = await page.evaluate(() => window.__rpgClient?.self());
    return s && !s.pending && !s.walking ? `${s.x},${s.y},${s.z}` : "moving";
  };
  const standsOn = async (x: number, y: number, z: number): Promise<void> => {
    await expect.poll(at, { timeout: 20_000 }).toBe(`${x},${y},${z}`);
  };
  const clickTile = async (x: number, y: number): Promise<void> => {
    const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: x,
      b: y,
    });
    if (!p) throw new Error("no canvas");
    // The windows float over the map (docs/17 A14): a click there would not reach it.
    const hit = await page.evaluate(
      ({ a, b }) => document.elementFromPoint(a, b)?.getAttribute("data-testid") ?? "",
      { a: p.x, b: p.y },
    );
    expect(hit, `tile ${x},${y} is under a window`).toBe("game-canvas");
    await page.mouse.click(p.x, p.y);
  };
  await standsOn(2095, 2086, 7);

  // M1: the temple's stone wall blocks for the client too, so a click on the other side of
  // it walks around through the door (it used to take one step into the wall and stop).
  // (Not 2092,2089 first: at 1280x800 the chat floats over that tile, 3 down and 3 left.)
  expect(await page.evaluate(() => window.__rpgClient?.walkable(2090, 2088, 7))).toBe(false);
  await clickTile(2092, 2088);
  await standsOn(2092, 2088, 7);
  await clickTile(2091, 2093);
  await standsOn(2091, 2093, 7);
  await shot(page, "94-sandbox-around-the-wall");

  // M3: after a click on a checkbox of the panel, and with a select focused, the arrows
  // walk and the select keeps its option.
  const chase = page.getByRole("checkbox", { name: "Perseguir al objetivo" });
  await chase.click();
  await expect(chase).toBeFocused();
  await stepKey(page, "ArrowDown");
  await standsOn(2091, 2094, 7);
  const stance = page.getByRole("combobox", { name: "Modo de combate" });
  const before = await stance.inputValue();
  await stance.focus();
  await stepKey(page, "ArrowRight");
  await standsOn(2092, 2094, 7);
  expect(await stance.inputValue()).toBe(before);

  // M2: the provisioner's shop at 1280x800 stays on the screen; since docs/17 UI-8 its
  // grid pages instead of scrolling, the search finds the backpack and the bar buys it.
  // The map never scrolls.
  const say = page.getByTestId("say").getByRole("textbox");
  await say.fill("/item gold_coin 1");
  await say.press("Enter");
  await expect(page.getByTestId("game-log")).toContainText("Creaste");
  await say.fill("/tp 2088 2098 7");
  await say.press("Enter");
  await standsOn(2088, 2098, 7);
  // The camera follows the teleport on the next frame: tileToClient before it would point
  // at the old view.
  await page.waitForTimeout(300);
  const merchant = await page.evaluate(() =>
    window.__rpgClient?.npcs().find((n) => n.contentId === "pruebas_merchant"),
  );
  if (!merchant) throw new Error("no provisioner in view");
  const m = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
    a: merchant.x,
    b: merchant.y,
  });
  if (!m) throw new Error("no canvas");
  await page.mouse.click(m.x, m.y, { button: "right" });
  const dialog = page.getByTestId("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Quiero comerciar/ }).click();
  const shop = page.getByTestId("shop");
  await expect(shop).toBeVisible();
  await expect(page.getByTestId("shop-money")).toHaveText("Dinero: 10.000");
  const box = await shop.boundingBox();
  if (!box) throw new Error("no shop box");
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  // docs/17 UI-8: the whole shop fits; its grid pages instead of scrolling. The merchant
  // sells more than a page: the arrows go to the next one. The window's body is what would
  // scroll: the frame is not a scroller, and its gothic corners stick out 5 px past it.
  const sizes = await shop
    .locator(".gwin-body")
    .evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
  await expect(shop.getByTestId("shop-next")).toBeEnabled();
  await shop.getByTestId("shop-next").click();
  await expect(shop.getByTestId("shop-prev")).toBeEnabled();
  // The search finds the backpack wherever it is; a click picks it for the bar below.
  await shop.getByTestId("shop-search").fill("mochila");
  const cell = shop.locator('[data-item="backpack"]');
  await expect(cell).toHaveCount(1);
  await cell.getByRole("button").click();
  const bar = shop.getByTestId("shop-bar");
  await expect(bar).toContainText("mochila");
  // m8: a count over the limit shows the limit (100), not what was typed.
  const count = bar.getByTestId("shop-count");
  await count.fill("250");
  await expect(count).toHaveValue("100");
  await count.fill("1");
  await expect(bar.getByTestId("shop-total")).toContainText("20");
  await bar.getByTestId("shop-act").click();
  await expect(page.getByTestId("game-log")).toContainText("Compraste mochila por 20 monedas.");
  expect(await page.locator(".viewport").evaluate((el) => el.scrollTop)).toBe(0);
  await page.waitForTimeout(300);
  await shot(page, "95-sandbox-shop-scrolled");
  expect(errors).toEqual([]);
});

// The quest log (docs/02 "Diario de misiones") and the books and chests of the temple's
// north-east corner (docs/16 4c, docs/02 "Libros y cofres"). The character comes with
// Chapter 1 at its wolves (2 of 6) and the sandbox's task done a moment ago, still cooling
// down: the window "Misiones" shows one active quest with its kills and, in "Terminadas",
// the countdown. Then the lectern opens the reading window, and the reward chest gives once.
test("sandbox: the quest log, a lectern's book and a reward chest that gives once", async ({
  page,
  playwright,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const who = await newGuardian(playwright, "Lector");
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'pruebas' WHERE name = '${who.name}';
     INSERT INTO quest_state (character_id, key, value)
     SELECT c.id, v.key, v.value FROM characters c, (VALUES
       ('quest.ch1_shipwreck', 1::bigint),
       ('quest.ch1_shipwreck.kills', 2::bigint),
       ('quest.pruebas_rats', 2::bigint),
       ('quest.pruebas_rats.done_at', extract(epoch from now())::bigint)) AS v(key, value)
     WHERE c.name = '${who.name}';`,
  ]);
  await enterGame(page, who);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const standsOn = async (x: number, y: number, z: number): Promise<void> => {
    await expect
      .poll(
        async () => {
          const s = await page.evaluate(() => window.__rpgClient?.self());
          return s && !s.pending && !s.walking ? `${s.x},${s.y},${s.z}` : "moving";
        },
        { timeout: 20_000 },
      )
      .toBe(`${x},${y},${z}`);
  };
  const tileClient = async (x: number, y: number): Promise<{ x: number; y: number }> => {
    const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: x,
      b: y,
    });
    if (!p) throw new Error("no canvas");
    return p;
  };
  const item = (id: string): Promise<number | undefined> =>
    page.evaluate((i) => window.__rpgClient?.itemNumber(i), id);
  await standsOn(2095, 2086, 7);

  // The quest log of the login: Chapter 1 in progress at 2/6 wolves, the task cooling down.
  await openWindow(page, "quests");
  const quests = page.getByTestId("quests");
  await expect(quests.locator('[data-quest-tab="active"]')).toHaveText("Activas (1)");
  await expect(quests.locator('[data-quest-tab="finished"]')).toHaveText("Terminadas (1)");
  const ch1 = quests.locator('.quest[data-quest="ch1_shipwreck"]');
  await expect(ch1.getByTestId("quest-kills")).toContainText("2/6");
  await expect(ch1.getByTestId("quest-step")).not.toBeEmpty();
  await page.waitForTimeout(300); // let the atlas textures upload before the screenshot
  await shot(page, "96-sandbox-quests");
  // The minimap (docs/02 "Minimapa"): track the chapter. Its wolves are far from the
  // sandbox, so the estimate is an arrow on the minimap's edge with a rough distance; the
  // temple around the player is explored, the rest black.
  const minimap = page.getByTestId("minimap");
  await expect(minimap).toBeVisible();
  for (const side of ["top", "right", "bottom", "left"])
    await expect(minimap.getByTestId(`minimap-${side}`)).not.toBeEmpty();
  await ch1.getByTestId("quest-track").click();
  await expect(ch1.getByTestId("quest-track")).toHaveAttribute("aria-pressed", "true");
  await expect(minimap).toHaveAttribute("data-tracked", "ch1_shipwreck");
  await expect(minimap.getByTestId("minimap-hint")).toHaveAttribute("data-kind", /area|arrow/);
  await minimap.screenshot({ path: join(shots, "96c-minimap-tracked.png") });
  await shot(page, "96d-minimap-hud");
  await quests.locator('[data-quest-tab="finished"]').click();
  const rats = quests.locator('.quest[data-quest="pruebas_rats"]');
  await expect(rats.getByTestId("quest-cooldown")).toContainText("Disponible otra vez en");
  await page.locator('.gwin[data-window="quests"]').screenshot({
    path: join(shots, "96b-sandbox-quests-finished.png"),
  });
  await closeWindow(page, "quests");

  // Next to the lectern (2099,2084) and the chest (2098,2084), inside the temple.
  const lectern = await item("book_lantern_rowers");
  const chest = await item("chest_pruebas");
  expect(await page.evaluate(() => window.__rpgClient?.tile(2099, 2084, 7)?.at(-1))).toBe(lectern);
  expect(await page.evaluate(() => window.__rpgClient?.tile(2098, 2084, 7)?.at(-1))).toBe(chest);
  let p = await tileClient(2099, 2085);
  await page.mouse.click(p.x, p.y);
  await standsOn(2099, 2085, 7);

  // A right click on the lectern: "Leer", in bold, opens the reading window at page 1 of 3.
  p = await tileClient(2099, 2084);
  await page.mouse.click(p.x, p.y, { button: "right" });
  const menu = page.getByTestId("action-menu");
  await expect(menu.locator('[data-action="read"]')).toHaveClass(/default/);
  await menu.locator('[data-action="read"]').click();
  const book = page.getByTestId("book");
  await expect(book).toBeVisible();
  expect(await page.evaluate(() => window.__rpgClient?.book())).toBe(lectern);
  await expect(book.getByTestId("book-page-number")).toHaveText("Página 1 de 3");
  await expect(book.getByTestId("book-prev")).toBeDisabled();
  const first = await book.getByTestId("book-page").textContent();
  await book.getByTestId("book-next").click();
  await expect(book.getByTestId("book-page-number")).toHaveText("Página 2 de 3");
  await expect(book.getByTestId("book-page")).not.toHaveText(first ?? "");
  await shot(page, "97-sandbox-book");
  await page.keyboard.press("Escape");
  await expect(book).toBeHidden();
  expect(await page.evaluate(() => window.__rpgClient?.book())).toBeUndefined();

  // The chest: "Abrir" gives its rewards once (an iron sword among them); again, nothing.
  const log = page.getByTestId("game-log");
  await page.locator('[data-chat-tab="log"]').click();
  p = await tileClient(2098, 2084);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await expect(menu.locator('[data-action="open"]')).toHaveClass(/default/);
  await menu.locator('[data-action="open"]').click();
  await expect(log).toContainText("Abres el cofre y encuentras:", SLOW);
  await expect(log).toContainText("espada de hierro");
  await page.mouse.click(p.x, p.y, { button: "right" });
  await menu.locator('[data-action="open"]').click();
  await expect(log).toContainText("El cofre está vacío", SLOW);
  await shot(page, "98-sandbox-chest");
  expect(errors).toEqual([]);
});

// The living world's corner of Thimblewick (lote 17, livingworld/README.md), north of the
// temple between the coast and the pens: vines cut by hand open the garden, and two
// boulders pushed onto their plates raise the portcullis. No console error and no
// disconnection on the way (PushObject is ClientMessage field 39).
test("sandbox living world: cut the vines by hand, push both boulders, the portcullis opens", async ({
  page,
  playwright,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const who = await newGuardian(playwright, "Rompedor");
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'pruebas' WHERE name = '${who.name}';
     UPDATE accounts SET role = 'gm' WHERE email = lower('${who.email}');`,
  ]);
  await enterGame(page, who);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const standsOn = async (x: number, y: number, z: number): Promise<void> => {
    await expect
      .poll(
        async () => {
          const s = await page.evaluate(() => window.__rpgClient?.self());
          return s && !s.pending && !s.walking ? `${s.x},${s.y},${s.z}` : "moving";
        },
        { timeout: 20_000 },
      )
      .toBe(`${x},${y},${z}`);
  };
  const topOf = (x: number, y: number): Promise<number | undefined> =>
    page.evaluate(({ a, b }) => window.__rpgClient?.tile(a, b, 7)?.at(-1), { a: x, b: y });
  const item = (id: string): Promise<number | undefined> =>
    page.evaluate((i) => window.__rpgClient?.itemNumber(i), id);
  const walkable = (x: number, y: number): Promise<boolean | undefined> =>
    page.evaluate(({ a, b }) => window.__rpgClient?.walkable(a, b, 7), { a: x, b: y });
  const say = page.getByTestId("say").getByRole("textbox");
  const tp = async (x: number, y: number): Promise<void> => {
    await say.fill(`/tp ${x} ${y} 7`);
    await say.press("Enter");
    await standsOn(x, y, 7);
    await page.waitForTimeout(300);
  };

  // The area as the reviewed render shows it.
  await tp(2096, 2071);
  expect(await topOf(2096, 2070)).toBe(await item("thorny_vines"));
  expect(await topOf(2105, 2068)).toBe(await item("portcullis_closed"));
  expect(await topOf(2101, 2070)).toBe(await item("mossy_boulder"));
  expect(await topOf(2105, 2071)).toBe(await item("mossy_boulder"));
  expect(await topOf(2108, 2070)).toBe(await item("heavy_crate"));
  expect(await topOf(2088, 2071)).toBe(await item("cracked_rock"));
  await shot(page, "97-living-garden");

  // Bare hands on the vines (Ctrl+right click: use), at the pace of the trades, until cut. From
  // the tile diagonal to them: from right below, the player's own sprite covers the vines'
  // tile and takes the click.
  await tp(2095, 2071);
  const cut = await item("cut_vines");
  for (let i = 0; i < 12 && (await topOf(2096, 2070)) !== cut; i++) {
    const at = await page.evaluate(() => window.__rpgClient?.tileToClient(2096, 2070));
    if (!at) throw new Error("no client position for the vines");
    // Ctrl+right uses the top item at once in both controls modes (input/mouse.ts).
    await page.keyboard.down("Control");
    await page.mouse.click(at.x, at.y, { button: "right" });
    await page.keyboard.up("Control");
    await page.waitForTimeout(1200);
  }
  expect(await topOf(2096, 2070)).toBe(cut);
  expect(await walkable(2096, 2070)).toBe(true);
  await shot(page, "98-living-vines-cut");

  // The portcullis: the west boulder east onto its plate, the south one north onto its.
  const boulder = await item("mossy_boulder");
  // A tap of a walking key into a pushable object pushes it (Game.pushAhead, at most once
  // per PUSH_EVERY_MS); a tap may first only turn the player (MOV-2), so tap until it moves.
  const pushToward = async (key: string, x: number, y: number): Promise<void> => {
    await say.blur(); // /tp left the focus in the chat: the arrows would move its caret
    for (let i = 0; i < 6 && (await topOf(x, y)) !== boulder; i++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(600);
    }
    expect(await topOf(x, y)).toBe(boulder);
  };
  await tp(2100, 2070);
  await pushToward("ArrowRight", 2102, 2070);
  await tp(2105, 2072);
  await pushToward("ArrowUp", 2105, 2070);
  await expect
    .poll(() => topOf(2105, 2068), { timeout: 10_000 })
    .toBe(await item("portcullis_open"));
  expect(await walkable(2105, 2068)).toBe(true);
  await page.waitForTimeout(300);
  await shot(page, "99-living-portcullis-open");

  // Still in the game: the pushes never closed the connection.
  expect(await page.evaluate(() => window.__rpgClient?.ready)).toBe(true);
  await expect(page.getByTestId("login-form")).toHaveCount(0);
  expect(errors).toEqual([]);
});

// docs/17 UI-3 (owner, 2026-11-23 and 2026-11-25): the names over creatures are drawn at
// the screen's own resolution (a font size in device pixels per zoom, never a blown-up
// raster), a little smaller than the 2x pixel font of lote 19, in colours that read on the
// black outline; an NPC shows what it does on a second line under its name, never "…";
// and ART-3: a wall piece just south of the own player fades, the player keeps its colours
// (no pale copy over the map).
test("sandbox: sharp names at 1x, 2x and 4x, NPCs with their role on a second line; a wall in front of the player fades", async ({
  page,
  playwright,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const who = await newGuardian(playwright, "Rotulo");
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'pruebas' WHERE name = '${who.name}';
     UPDATE accounts SET role = 'gm' WHERE email = lower('${who.email}');`,
  ]);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await enterGame(page, who);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const standsOn = async (x: number, y: number, z: number): Promise<void> => {
    await expect
      .poll(
        async () => {
          const s = await page.evaluate(() => window.__rpgClient?.self());
          return s && !s.pending && !s.walking ? `${s.x},${s.y},${s.z}` : "moving";
        },
        { timeout: 20_000 },
      )
      .toBe(`${x},${y},${z}`);
  };
  const labels = () => page.evaluate(() => window.__rpgClient?.labels());
  const scale = async (): Promise<number> =>
    (await page.evaluate(() => window.__rpgClient?.zoom()))?.scale ?? 0;
  const canvas = await page.getByTestId("game-canvas").boundingBox();
  if (!canvas) throw new Error("no canvas");
  const wheel = async (deltaY: number): Promise<void> => {
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 3);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, deltaY);
    await page.keyboard.up("Control");
  };
  const zoomTo = async (want: number): Promise<void> => {
    for (let i = 0; i < 8 && (await scale()) !== want; i++) {
      await wheel((await scale()) < want ? -100 : 100);
      await page.waitForTimeout(150);
    }
    await expect.poll(scale).toBe(want);
    await page.waitForTimeout(300);
  };
  const say = page.getByTestId("say").getByRole("textbox");
  const tp = async (x: number, y: number, z: number): Promise<void> => {
    await say.fill(`/tp ${x} ${y} ${z}`);
    await say.press("Enter");
    await standsOn(x, y, z);
    await say.blur();
    await page.waitForTimeout(400);
  };
  /** The label of the first creature from `list` with that content id. */
  const labelOf = async (list: "npcs" | "monsters", contentId: string) => {
    const ids = await page.evaluate(
      ({ l, c }) =>
        (l === "npcs" ? window.__rpgClient?.npcs() : window.__rpgClient?.monsters())
          ?.filter((n) => n.contentId === c)
          .map((n) => n.id) ?? [],
      { l: list, c: contentId },
    );
    const shown = (await labels())?.shown ?? [];
    return shown.find((s) => ids.includes(s.id));
  };

  // The temple, by the instructor (an NPC), at 2x: a 15 px name drawn 1:1 (the page's
  // devicePixelRatio is 1 here) and, under it, what she does, smaller.
  await standsOn(2095, 2086, 7);
  await zoomTo(2);
  await expect.poll(async () => (await labelOf("npcs", "pruebas_trainer"))?.fontPx).toBe(15);
  const npc2 = await labelOf("npcs", "pruebas_trainer");
  expect(npc2?.fill).toBe(0xc79bff); // render/label-style.ts LABEL_COLORS.npc
  expect(npc2?.scale).toBe(1); // rasterised at its size, not scaled
  expect(npc2?.text).not.toContain("…");
  expect(npc2?.text).not.toContain(",");
  expect(npc2?.role ?? "").not.toBe("");
  expect(npc2?.role).not.toContain("…");
  expect(npc2?.roleFontPx ?? 99).toBeLessThan(npc2?.fontPx ?? 0);
  // The label's top (where a speech bubble would sit) is above both lines.
  expect(npc2?.top ?? 0).toBeLessThanOrEqual((npc2?.y ?? 0) + 4);
  expect((await labels())?.dpr).toBe(1);
  await shot(page, "100-names-2x-npc");
  const close = async (name: string, x: number, y: number): Promise<void> => {
    const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: x,
      b: y,
    });
    const k = await scale();
    if (!p) throw new Error("no tile on screen");
    await page.screenshot({
      path: join(shots, `${name}.png`),
      clip: {
        x: Math.max(0, p.x - 4 * 32 * k),
        y: Math.max(0, p.y - 3 * 32 * k),
        width: 9 * 32 * k,
        height: 5 * 32 * k,
      },
    });
  };
  // Cut round the instructor: the letters' edges, to judge the sharpness.
  await close("100a-names-2x-npc-close", 2093, 2085);

  // 1x: 12 px, smaller with the map.
  await zoomTo(1);
  await expect.poll(async () => (await labelOf("npcs", "pruebas_trainer"))?.fontPx).toBe(12);
  const npc1 = await labelOf("npcs", "pruebas_trainer");
  expect(npc1?.height ?? 0).toBeLessThan(npc2?.height ?? 0);
  expect(npc1?.role.split(/\s+/).join(" ")).toBe(npc2?.role.split(/\s+/).join(" "));
  await shot(page, "100b-names-1x-npc");
  await close("100c-names-1x-npc-close", 2093, 2085);

  // The square, between the temple's instructor and the merchant at her stall: the town
  // with its NPCs at 1x and at 2x.
  const square = await page.evaluate(() => {
    const c = window.__rpgClient;
    for (let y = 2093; y <= 2097; y++)
      for (let x = 2088; x <= 2093; x++) if (c?.walkable(x, y, 7)) return { x, y };
    return undefined;
  });
  if (square) {
    await tp(square.x, square.y, 7);
    await expect
      .poll(async () => (await labelOf("npcs", "pruebas_merchant"))?.role ?? "", {
        timeout: 20_000,
      })
      .not.toBe("");
    await shot(page, "100d-names-1x-town");
    await zoomTo(2);
    await shot(page, "100e-names-2x-town");
    await close("100f-names-2x-merchant-close", 2086, 2100);
  }

  // The rats' pen (weak: they cannot kill the guardian meanwhile): monster names, one line,
  // at 2x and at 4x (21 px).
  await zoomTo(2);
  await tp(2080, 2081, 7);
  await expect
    .poll(async () => (await labelOf("monsters", "bilge_rat"))?.fill, { timeout: 20_000 })
    .toBe(0xff4f5e); // LABEL_COLORS.monster
  expect((await labelOf("monsters", "bilge_rat"))?.role).toBe("");
  await shot(page, "101-names-2x-monsters");
  await zoomTo(4);
  await expect.poll(async () => (await labels())?.fontPx).toBe(21);
  await shot(page, "101b-names-4x-monsters");

  // Options → Interface → "Name size": normal at 4x is 16 px.
  await openWindow(page, "options");
  await page.getByTestId("name-size").selectOption("normal");
  await closeWindow(page, "options");
  await expect.poll(async () => (await labels())?.fontPx).toBe(16);
  expect(await page.evaluate(() => localStorage.getItem("rpg.name-size"))).toBe("normal");
  await shot(page, "101c-names-normal-4x-monsters");
  await page.evaluate(() => localStorage.removeItem("rpg.name-size"));

  // ART-3: just north of the temple's south wall (its piece at 2092,2091), the piece
  // fades; a piece of the same wall far away does not.
  await zoomTo(2);
  await tp(2092, 2090, 7);
  expect(await page.evaluate(() => window.__rpgClient?.walkable(2092, 2091, 7))).toBe(false);
  await expect
    .poll(async () => {
      const f = await page.evaluate(() => window.__rpgClient?.wallFade(2092, 2091));
      return f && f.alphas.length > 0 && f.alphas.every((a) => a < 0.5);
    })
    .toBe(true);
  const far = await page.evaluate(() => window.__rpgClient?.wallFade(2099, 2091));
  expect(far?.alphas.every((a) => a === 1)).toBe(true);
  await shot(page, "102-wall-fade-own-player");
  const me = await page.evaluate(() => window.__rpgClient?.tileToClient(2092, 2090));
  if (!me) throw new Error("no canvas");
  await page.screenshot({
    path: join(shots, "102b-wall-fade-own-player-close.png"),
    clip: { x: me.x - 192, y: me.y - 192, width: 384, height: 320 },
  });
  expect(errors).toEqual([]);
});

// Day and night (livingworld/README.md "Día y noche"): a gm stops the world clock at noon
// (short shadows under the feet, no tint) and at a full-moon night (silvery blue, the
// temple's lamps glowing, a faint moon shadow), with the cast shadows drawn under every
// creature in view; then the low sun of the morning and of the afternoon, the dusk, a
// new-moon night and the dawn after it. It leaves the clock stopped at noon, as the E2E
// servers start it.
// Owner, 2026-11-25: every object with height casts its own shadow in the sun's pose (the
// temple's walls, the plaza's oaks, the bushes, the sign), and a creature that casts one has
// no contact ellipse; inside the temple there is no sun: the ellipse, and no cast shadow.
test("sandbox day and night: noon and a full-moon night, with cast shadows", async ({
  page,
  playwright,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  const who = await newGuardian(playwright, "Relojero");
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'pruebas' WHERE name = '${who.name}';
     UPDATE accounts SET role = 'gm' WHERE email = lower('${who.email}');`,
  ]);
  await enterGame(page, who);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const say = page.getByTestId("say").getByRole("textbox");
  const time = async (args: string): Promise<void> => {
    await say.fill(`/time ${args}`);
    await say.press("Enter");
    await page.waitForTimeout(300);
  };
  const sky = () => page.evaluate(() => window.__rpgClient?.sky());
  const tp = async (x: number, y: number): Promise<void> => {
    await say.fill(`/tp ${x} ${y} 7`);
    await say.press("Enter");
    await expect
      .poll(async () => {
        const s = await page.evaluate(() => window.__rpgClient?.self());
        return s ? `${s.x},${s.y}` : "";
      }, SLOW)
      .toBe(`${x},${y}`);
    await say.blur();
    await page.waitForTimeout(400);
  };

  // The E2E servers keep the time stopped at noon (-world-time noon in
  // playwright.config.ts); put it back however this test ends, so the specs after it are
  // not shot at night.
  try {
    await time("speed 0");
    await time("noon");
    await expect.poll(async () => (await sky())?.phase, { timeout: 10_000 }).toBe("day");
    // Where a new character wakes: inside the temple. No sun under a roof: the own player
    // stands on its contact ellipse and casts nothing, while the objects outside do.
    await say.blur();
    await expect.poll(async () => (await sky())?.selfContact, { timeout: 10_000 }).toBe(true);
    expect((await sky())?.casters).toBeGreaterThan(0);
    await shot(page, "99a-daynight-indoors");

    // Out on the plaza, south of the temple's doorway, between its two oaks.
    await tp(2095, 2095);
    await expect.poll(async () => (await sky())?.selfContact, { timeout: 10_000 }).toBe(false);
    const noon = await sky();
    expect(noon?.ambient).toBe(0xffffff);
    expect(noon?.shadows).toBeGreaterThan(0); // the own player at least
    expect(noon?.casters).toBeGreaterThan(0);
    expect(noon?.objectShadows).toBeGreaterThan(0);
    expect(Math.abs(noon?.shadowX ?? 1)).toBeLessThan(0.05); // straight under the sun
    await shot(page, "99b-daynight-noon");

    await time("moon 4");
    await time("night");
    await expect.poll(async () => (await sky())?.phase, { timeout: 10_000 }).toBe("night");
    const night = await sky();
    expect(night?.lamps).toBe(1);
    expect(night?.moon).toBeCloseTo(1);
    expect(night?.ambient).not.toBe(0xffffff);
    expect(night?.shadowAlpha).toBeGreaterThan(0);
    // The moon casts for the objects too, and the feet stand on that shadow.
    expect(night?.casters).toBeGreaterThan(0);
    expect(night?.selfContact).toBe(false);
    await say.blur();
    await page.waitForTimeout(300);
    await shot(page, "99c-daynight-night");

    // The rest of the day, for the eye (docs/17): long shadows to the west under a low
    // morning sun, the orange dusk, a new moon (the darkest night, no moon shadow) and a
    // dawn: the same day's (/time sets the hour of the current day), the one before that
    // night, still under the moon of the night before it (phase 7).
    await time("morning");
    await expect.poll(async () => (await sky())?.phase, { timeout: 10_000 }).toBe("day");
    const morning = await sky();
    expect(morning?.shadows).toBeGreaterThan(0);
    expect(morning?.shadowX).toBeLessThan(0); // to the west
    expect(morning?.casters).toBeGreaterThan(0);
    expect(morning?.selfContact).toBe(false);
    await say.blur();
    await page.waitForTimeout(300);
    await shot(page, "99d-daynight-morning");

    await time("afternoon");
    await expect
      .poll(async () => (await sky())?.shadowX ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect((await sky())?.casters).toBeGreaterThan(0);
    await say.blur();
    await page.waitForTimeout(300);
    await shot(page, "99d2-daynight-afternoon");

    await time("dusk");
    await expect.poll(async () => (await sky())?.phase, { timeout: 10_000 }).toBe("dusk");
    await say.blur();
    await page.waitForTimeout(300);
    await shot(page, "99e-daynight-dusk");

    await time("moon 0");
    await time("night");
    await expect.poll(async () => (await sky())?.moon, { timeout: 10_000 }).toBeCloseTo(0);
    expect((await sky())?.phase).toBe("night");
    // No moon, no cast shadow of anything: the contact ellipse is back under the feet.
    const dark = await sky();
    expect(dark?.shadowAlpha).toBe(0);
    expect(dark?.casters).toBe(0);
    expect(dark?.selfContact).toBe(true);
    await say.blur();
    await page.waitForTimeout(300);
    await shot(page, "99f-daynight-new-moon");

    await time("dawn");
    await expect.poll(async () => (await sky())?.phase, { timeout: 10_000 }).toBe("dawn");
    await say.blur();
    await page.waitForTimeout(300);
    await shot(page, "99g-daynight-dawn");
  } finally {
    await time("noon");
    await time("speed 0");
  }
  expect(await page.evaluate(() => window.__rpgClient?.ready)).toBe(true);
  expect(errors).toEqual([]);
});

// Footprints under the feet (livingworld/README.md "Huellas"): on the beach of Thimblewick
// the own player's prints are dropped by the walk drawn, one per footfall, alternating
// either side of the path and a stride apart, straight and on a diagonal. The screenshots
// are cut round the player, mid-walk and at the end of each trail.
test("sandbox footprints: one print per footfall on sand, both feet, straight and diagonal; the wind and a wave erase them", async ({
  page,
  playwright,
}) => {
  test.setTimeout(480_000);
  const errors: string[] = [];
  const who = await newGuardian(playwright, "Caminante");
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'pruebas' WHERE name = '${who.name}';
     UPDATE accounts SET role = 'gm' WHERE email = lower('${who.email}');`,
  ]);
  await enterGame(page, who);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const say = page.getByTestId("say").getByRole("textbox");
  const standing = async (): Promise<{ x: number; y: number }> => {
    let at = { x: 0, y: 0 };
    await expect
      .poll(
        async () => {
          const s = await page.evaluate(() => window.__rpgClient?.self());
          if (s && !s.pending && !s.walking) at = { x: s.x, y: s.y };
          return s !== undefined && !s.pending && !s.walking;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    return at;
  };
  const tp = async (x: number, y: number): Promise<void> => {
    await say.fill(`/tp ${x} ${y} 7`);
    await say.press("Enter");
    await expect.poll(async () => (await standing()).x, { timeout: 20_000 }).toBe(x);
    await say.blur();
    await page.waitForTimeout(400);
  };
  const falls = () => page.evaluate(() => window.__rpgClient?.footfalls());
  /** A screenshot cut round tile (x, y): the trail next to the character. */
  const around = async (name: string, x: number, y: number): Promise<void> => {
    const p = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
      a: x,
      b: y,
    });
    const scale = (await page.evaluate(() => window.__rpgClient?.scale())) ?? 1;
    if (!p) throw new Error("no tile on screen");
    const t = 32 * scale;
    await page.screenshot({
      path: join(shots, `${name}.png`),
      clip: {
        x: Math.max(0, p.x - 5 * t),
        y: Math.max(0, p.y - 4 * t),
        width: 11 * t,
        height: 8 * t,
      },
    });
  };

  // The beach west of the dock: the sand tiles the client knows there, and the longest
  // runs of them east and along a diagonal.
  await tp(2084, 2129);
  const runs = await page.evaluate(() => {
    const c = window.__rpgClient;
    const sand = c?.itemNumber("sand");
    const ok = (x: number, y: number): boolean =>
      c?.tile(x, y, 7)?.[0] === sand && c?.walkable(x, y, 7) === true;
    const best = (dx: number, dy: number): { x: number; y: number; n: number } => {
      let top = { x: 0, y: 0, n: 0 };
      for (let y = 2118; y <= 2136; y++)
        for (let x = 2070; x <= 2100; x++) {
          let n = 0;
          while (n < 8 && ok(x + dx * n, y + dy * n)) n++;
          if (n > top.n) top = { x, y, n };
        }
      return top;
    };
    return {
      east: best(1, 0),
      diagonals: [
        { keys: ["ArrowDown", "ArrowRight"], dx: 1, dy: 1, ...best(1, 1) },
        { keys: ["ArrowUp", "ArrowRight"], dx: 1, dy: -1, ...best(1, -1) },
      ],
    };
  });
  expect(runs.east.n, "a run of sand to walk east on").toBeGreaterThanOrEqual(4);

  // East along the beach: hold the key, shoot mid-walk, let go, shoot the trail.
  await tp(runs.east.x, runs.east.y);
  const before = (await falls())?.total ?? 0;
  await page.keyboard.down("ArrowRight");
  await expect
    .poll(async () => (await page.evaluate(() => window.__rpgClient?.self()))?.x, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(runs.east.x + 2);
  await around("99h-footprints-east-walking", runs.east.x + 2, runs.east.y);
  await expect
    .poll(async () => (await page.evaluate(() => window.__rpgClient?.self()))?.x, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(runs.east.x + runs.east.n - 1);
  await page.keyboard.up("ArrowRight");
  const end = await standing();
  await around("99i-footprints-east-trail", end.x, end.y);
  const east = await falls();
  const own = east?.own ?? [];
  const fresh = (east?.total ?? 0) - before;
  expect(fresh).toBeGreaterThanOrEqual(4);
  expect(east?.footprints ?? 0).toBeGreaterThanOrEqual(4);
  // The feet alternate, each print half a tile (a stride) after the one before, a little
  // to its own side of the path.
  const walked = own.slice(-fresh).filter((f) => f.x > (runs.east.x + 0.5) * 32);
  for (let i = 1; i < walked.length; i++) {
    const a = walked[i - 1];
    const b = walked[i];
    if (!a || !b) continue;
    expect(b.side).toBe(-a.side);
    expect(Math.abs(b.x - a.x - 16)).toBeLessThan(1.5); // drawn on whole device pixels
    expect(Math.sign(b.y - a.y)).toBe(b.side);
    expect(Math.abs(b.y - a.y)).toBeLessThan(4);
  }

  // A diagonal, where the beach has one: both keys held.
  const d = runs.diagonals.sort((a, b) => b.n - a.n)[0];
  if (d && d.n >= 3) {
    await tp(d.x, d.y);
    const from = (await falls())?.own.at(-1);
    for (const k of d.keys) await page.keyboard.down(k);
    await expect
      .poll(async () => (await page.evaluate(() => window.__rpgClient?.self()))?.x, {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(d.x + d.n - 1);
    for (const k of d.keys) await page.keyboard.up(k);
    const stop = await standing();
    await around("99j-footprints-diagonal-trail", stop.x, stop.y);
    const after = (await falls())?.own ?? [];
    expect(after.at(-1)).not.toEqual(from);
    // The strides inside the run only. The keys come up some time after the last tile of
    // the run is reached, and a slow machine fits another step in between: past the run
    // the diagonal may be closed, the walk slides along one key, and the last two prints
    // are a straight stride.
    const start = from
      ? after.findLastIndex((f) => f.x === from.x && f.y === from.y && f.side === from.side)
      : -1;
    const inRun = (f: { x: number }): boolean =>
      f.x > (d.x + 0.5) * 32 && f.x < (d.x + d.n - 0.5) * 32;
    let strides = 0;
    for (let i = start + 2; i < after.length; i++) {
      const prev = after[i - 1];
      const last = after[i];
      if (!prev || !last || !inRun(prev) || !inRun(last)) continue;
      strides++;
      // A stride on a diagonal: 8 px across and 8 down, give or take the feet's stance.
      expect(last.side).toBe(-prev.side);
      expect(Math.abs(Math.abs(last.x - prev.x) - 8)).toBeLessThan(5);
      expect(Math.abs(Math.abs(last.y - prev.y) - 8)).toBeLessThan(5);
    }
    expect(strides).toBeGreaterThan(0);
  } else console.log(`no diagonal run of sand on the beach (${JSON.stringify(runs.diagonals)})`);

  // Standing still leaves nothing more.
  const still = (await falls())?.total;
  await page.waitForTimeout(800);
  expect((await falls())?.total).toBe(still);

  // Both feet (owner, 2026-11-25): the left foot and the right each sounded, on the
  // sand's own sample, a little apart in pitch; and each left its mark.
  const heard = (await falls())?.own ?? [];
  for (const side of [-1, 1]) {
    const foot = heard.filter((f) => f.side === side);
    expect(foot.length, `footfalls of side ${side}`).toBeGreaterThanOrEqual(2);
    for (const f of foot) expect(f.sound).toMatch(/^step\.self\.[a-z_]+$/);
  }
  expect(heard.some((f) => f.sound === "step.self.sand")).toBe(true);
  expect(new Set(heard.map((f) => f.rate.toFixed(3))).size).toBeGreaterThan(2);

  // What erases the prints (livingworld/README.md "Huellas: qué las borra"): no clock of
  // their own. A fresh trail on the dry sand, shot, and shot again once the wind's gusts
  // have worn it (the beach is open: it takes a gust or two, and a gust comes every 45 s
  // or so: between two of them the prints stay as they are).
  await tp(runs.east.x, runs.east.y);
  await standing();
  await page.keyboard.down("ArrowRight");
  await expect
    .poll(async () => (await page.evaluate(() => window.__rpgClient?.self()))?.x, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(runs.east.x + runs.east.n - 1);
  await page.keyboard.up("ArrowRight");
  const trailEnd = await standing();
  const dry = async (): Promise<{ side: number; wear: number }[]> =>
    ((await falls())?.prints ?? []).filter((p) => p.surface === "sand");
  const fresh0 = await dry();
  expect(fresh0.some((p) => p.side === 1)).toBe(true);
  expect(fresh0.some((p) => p.side === -1)).toBe(true);
  await around("99k-footprints-before-gust", trailEnd.x - 2, trailEnd.y);
  const worn = (list: { wear: number }[]): number =>
    list.reduce((a, q) => a + q.wear, 0) + (fresh0.length - list.length);
  await expect
    .poll(async () => worn(await dry()), { timeout: 240_000, intervals: [500] })
    .toBeGreaterThan(fresh0.length * 0.5);
  await around("99l-footprints-after-gust", trailEnd.x - 2, trailEnd.y);

  // Wet sand by the water: the next wave that runs that far wipes the prints.
  const shore = await page.evaluate(
    ({ x0, y0 }) => {
      const c = window.__rpgClient;
      const wet = c?.itemNumber("wet_sand");
      const water = [c?.itemNumber("water_shallow"), c?.itemNumber("water_shoal")];
      const isWet = (x: number, y: number): boolean =>
        c?.tile(x, y, 7)?.[0] === wet && c?.walkable(x, y, 7) === true;
      const isWater = (x: number, y: number): boolean => water.includes(c?.tile(x, y, 7)?.[0]);
      for (let y = y0 - 8; y <= y0 + 8; y++)
        for (let x = x0 - 12; x <= x0 + 12; x++) {
          if (!isWet(x, y) || !isWet(x + 1, y) || !isWet(x + 2, y)) continue;
          if (isWater(x + 1, y + 1) || isWater(x + 1, y - 1)) return { x, y };
        }
      return undefined;
    },
    { x0: runs.east.x, y0: runs.east.y },
  );
  // The beach has one (three tiles of wet sand with the sea south of them, west of the
  // dock): without it this half of the test would pass without having looked.
  if (!shore) throw new Error("no run of wet sand by the water near the beach");
  await tp(shore.x, shore.y);
  await standing();
  await page.keyboard.down("ArrowRight");
  await expect
    .poll(async () => (await page.evaluate(() => window.__rpgClient?.self()))?.x, {
      timeout: 15_000,
    })
    .toBeGreaterThanOrEqual(shore.x + 2);
  await page.keyboard.up("ArrowRight");
  const wetEnd = await standing();
  const wetPrints = async (): Promise<number> =>
    ((await falls())?.prints ?? []).filter((p) => p.surface === "wet_sand" && p.wear < 0.5).length;
  // The walk was on wet sand: its footfalls sounded like it, and printed.
  const wetFalls = ((await falls())?.own ?? []).filter((f) => /wet_sand/.test(String(f.sound)));
  expect(wetFalls.length).toBeGreaterThanOrEqual(2);
  console.log(`wet sand: ${wetFalls.length} footfalls, ${await wetPrints()} prints after the walk`);
  // A wave may already be on its way: the shot is right after the walk.
  await around("99m-wet-sand-before-wave", wetEnd.x - 1, wetEnd.y);
  // A wave every 7.7 s; one that reaches the first tile from the water comes soon.
  await expect.poll(wetPrints, { timeout: 60_000, intervals: [250] }).toBe(0);
  await around("99n-wet-sand-after-wave", wetEnd.x - 1, wetEnd.y);
  expect(errors).toEqual([]);
});

// The shadows of lamps and fires (docs/17 "Sombras de las luces", owner 2026-11-26): under a
// roof there is no sun shadow, whatever is in view; by a brazier indoors, by a torch
// underground and by a lamp post at night the own player casts a shadow away from the light
// and has no contact ellipse; where no light reaches (the temple of Thimblewick, which has
// no lamps) the ellipse stays, much fainter.
test("sandbox light shadows: indoors, underground and by a lamp at night", async ({
  page,
  playwright,
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  const who = await newGuardian(playwright, "Farolero");
  psql([
    databaseUrl,
    "-c",
    `UPDATE characters SET town = 'pruebas', level = 200, health = 1000000 WHERE name = '${who.name}';
     UPDATE accounts SET role = 'gm' WHERE email = lower('${who.email}');`,
  ]);
  await enterGame(page, who);
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const say = page.getByTestId("say").getByRole("textbox");
  const command = async (text: string): Promise<void> => {
    await say.fill(text);
    await say.press("Enter");
    await page.waitForTimeout(300);
  };
  const lit = () => page.evaluate(() => window.__rpgClient?.lightShadows());
  const tp = async (x: number, y: number, z: number): Promise<void> => {
    await command(`/tp ${x} ${y} ${z}`);
    await expect
      .poll(async () => {
        const s = await page.evaluate(() => window.__rpgClient?.self());
        return s ? `${s.x},${s.y},${s.z}` : "";
      }, SLOW)
      .toBe(`${x},${y},${z}`);
    await say.blur();
    await page.waitForTimeout(500);
  };

  try {
    await command("/time speed 0");
    await command("/time noon");
    await say.blur();
    // The temple of Thimblewick has no lamps: under its roof, no shadow at all and the
    // faint ellipse under the feet.
    await expect.poll(async () => (await lit())?.selfIndoor, { timeout: 10_000 }).toBe(true);
    const unlit = await lit();
    expect(unlit?.shadows).toBe(0);
    expect(unlit?.selfContact).toBeGreaterThan(0);
    expect(unlit?.selfContact).toBeLessThan(0.5);
    await shot(page, "99h-light-temple-unlit");

    // From the square the temple is only half in view: its floor must show no sun shadow
    // (pending 1 of lote 20b). Looked at in the screenshot.
    await tp(2095, 2095, 7);
    await shot(page, "99i-light-temple-from-square");

    // The temple of Puerto, between its two braziers, at noon: a shadow from the braziers
    // and no ellipse.
    await tp(3160, 6386, 7);
    await expect
      .poll(async () => (await lit())?.shadows ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const temple = await lit();
    expect(temple?.selfIndoor).toBe(true);
    expect(temple?.selfContact).toBe(0);
    await shot(page, "99j-light-temple-braziers");

    // Underground, by a wall torch of the cellars of Puerto.
    await tp(3134, 6315, 8);
    await expect
      .poll(async () => (await lit())?.shadows ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect((await lit())?.selfContact).toBe(0);
    await shot(page, "99k-light-underground-torch");

    // The square of Puerto at night, by a lamp post.
    await tp(3167, 6391, 7);
    // Noon: lamps cast nothing under the sun. Only the own player is asked: `shadows` also
    // counts whoever stands under a roof in the server's window (the priestess between the
    // temple's braziers, past the left edge of the screen), lit at any hour.
    await expect.poll(async () => (await lit())?.selfLit, { timeout: 10_000 }).toBe(false);
    expect((await lit())?.selfIndoor).toBe(false);
    await command("/time moon 4");
    await command("/time night");
    await say.blur();
    await expect.poll(async () => (await lit())?.selfLit, { timeout: 10_000 }).toBe(true);
    expect((await lit())?.selfContact).toBe(0);
    await shot(page, "99l-light-square-night-lamp");
  } finally {
    await command("/time noon");
    await command("/time speed 0");
  }
  expect(errors).toEqual([]);
});
