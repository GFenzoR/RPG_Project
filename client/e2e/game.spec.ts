// Logs in through the UI with an account and character created by the API, enters the
// test island, walks 5 steps (keyboard and click) and saves screenshots for review.
// Any console error or uncaught exception fails the test.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { serverURL } from "../playwright.config.ts";

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

/** Waits until the own creature stands still and confirmed on (x, y). */
async function arrived(page: Page, x: number, y: number): Promise<void> {
  await expect
    .poll(async () => {
      const s = await self(page);
      return s && !s.pending && !s.walking ? `${s.x},${s.y}` : "moving";
    })
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

  // Leave the game: back to the character list with the server's reason.
  await page.getByRole("button", { name: "Salir del juego" }).click();
  await expect(page.getByRole("status")).toHaveText("Saliste del juego.");

  expect(errors).toEqual([]);
});
