// The Isla de Pruebas, the sandbox island (docs/16-probar-el-juego.md): a character of
// that town wakes up in its temple next to the instructor, and a staff /tp shows the
// hunting pens, the yard of portals and the cave under it. It runs on the main E2E server
// (start town testisle): the town set in the database stands for `make play`'s
// -start-town pruebas, which picks the same temple for a character with no town.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
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
