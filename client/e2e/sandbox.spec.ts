// The Isla de Pruebas, the sandbox island (docs/16-probar-el-juego.md): a character of
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
import { databaseUrl, serverURL } from "../playwright.config.ts";

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
  const name = `${tag} ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
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

  // The temple of the Isla de Pruebas (world/islands/pruebas/island.yaml), the instructor
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
