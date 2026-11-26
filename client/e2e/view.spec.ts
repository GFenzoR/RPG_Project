// The wide view (docs/00, client/CLAUDE.md "Zoom del mapa"): the server keeps the client up
// to date with 31x21 tiles around the player (Welcome.view_width/height). On the desktop the
// map is full screen (docs/17 UI-4): its box is the screen above the bottom bar, and the
// fitted view is the largest one that covers it at a whole scale; Ctrl+wheel down zooms out
// to the whole window at 1x, a tile 15 to the side and 10 up on the canvas. At 1920x1080
// and 1280x800: screenshots 97, 97b, 98 and 98b (phones: mobile.spec.ts).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { serverURL } from "../playwright.config.ts";
import { characterName } from "./names.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });

function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
}

/** The scale drawn, the server's window and the tiles the canvas shows. */
async function viewOf(page: Page): Promise<{
  scale: number;
  server: { width: number; height: number };
  shown: { width: number; height: number };
}> {
  const v = await page.evaluate(() => {
    const c = window.__rpgClient;
    return c ? { scale: c.scale(), ...c.view() } : undefined;
  });
  if (!v) throw new Error("no canvas");
  return v;
}

/** Whether the centre of tile (x, y) is on the canvas, in page coordinates. */
async function onCanvas(page: Page, x: number, y: number): Promise<boolean> {
  const at = await page.evaluate(({ a, b }) => window.__rpgClient?.tileToClient(a, b), {
    a: x,
    b: y,
  });
  const box = await page.getByTestId("game-canvas").boundingBox();
  if (!at || !box) return false;
  return at.x > box.x && at.x < box.x + box.width && at.y > box.y && at.y < box.y + box.height;
}

test("the wide view at 1920x1080 and 1280x800: more of the map, and out to 31x21", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-view-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = characterName("Vista");
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

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/play/?lang=es");
  const form = page.getByTestId("login-form");
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Contraseña").fill(password);
  await form.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0; // the 401 of opening the page without a session cookie

  // 1920x1080, the fitted view: the bar (88 px) leaves a 1920x992 box. 2x covers it with
  // 30x15.5 tiles of the window.
  const fitted = await viewOf(page);
  expect(fitted.scale).toBe(2);
  expect(await page.evaluate(() => window.__rpgClient?.zoom())).toEqual({
    scale: 2,
    min: 1,
    fit: 2,
    max: 6,
  });
  expect(fitted.server).toEqual({ width: 31, height: 21 });
  expect(fitted.shown.width).toBeGreaterThan(23);
  expect(fitted.shown.height).toBeGreaterThan(15);
  expect(fitted.shown.width).toBeLessThanOrEqual(31);
  expect(fitted.shown.height).toBeLessThanOrEqual(21);
  const me = await page.evaluate(() => window.__rpgClient?.self());
  if (!me) throw new Error("no own creature");
  for (const [dx, dy] of [
    [11, 0],
    [-11, 0],
    [0, 7],
    [0, -7],
  ] as const)
    expect(await onCanvas(page, me.x + dx, me.y + dy)).toBe(true);
  await page.waitForTimeout(500); // let the atlas textures upload before the screenshot
  await page.screenshot({ path: join(shots, "97-view-1920x1080.png") });

  // Ctrl+wheel down zooms out to 1x: the whole window, 992x672 device px, 15 tiles to each
  // side and 10 up and down (17 to the side is beyond it).
  const canvas = await page.getByTestId("game-canvas").boundingBox();
  if (!canvas) throw new Error("no canvas");
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  const wheel = async (deltaY: number): Promise<void> => {
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, deltaY);
    await page.keyboard.up("Control");
  };
  await wheel(100);
  await expect.poll(async () => (await viewOf(page)).scale).toBe(1);
  expect((await viewOf(page)).shown).toEqual({ width: 31, height: 21 });
  const size = await page
    .getByTestId("game-canvas")
    .evaluate((c: HTMLCanvasElement) => ({ width: c.width, height: c.height }));
  expect(size).toEqual({ width: 31 * 32, height: 21 * 32 });
  for (const [dx, dy] of [
    [15, 0],
    [-15, 0],
    [0, 10],
    [0, -10],
    [15, -10],
  ] as const)
    expect(await onCanvas(page, me.x + dx, me.y + dy)).toBe(true);
  expect(await onCanvas(page, me.x + 17, me.y)).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("rpg.zoom"))).toBe("1");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "97b-view-1920x1080-1x.png") });
  // Back to the fitted view: nothing remembered.
  await wheel(-100);
  await expect.poll(async () => (await viewOf(page)).scale).toBe(2);
  expect(await page.evaluate(() => localStorage.getItem("rpg.zoom"))).toBeNull();

  // 1280x800 (the size of the other desktop tests): a 1280x712 box, 2x with 20 columns and
  // a little more than 11 rows; 1x out shows the whole window, 31x21.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await viewOf(page)).shown.width).toBeLessThan(fitted.shown.width);
  const small = await viewOf(page);
  expect(small.scale).toBe(2);
  expect(small.shown.width).toBeGreaterThanOrEqual(15);
  expect(small.shown.height).toBeGreaterThan(11);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "98-view-1280x800.png") });
  const map = await page.getByTestId("game-canvas").boundingBox();
  if (!map) throw new Error("no canvas");
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  await wheel(100);
  await expect.poll(async () => (await viewOf(page)).scale).toBe(1);
  const box = await page.locator(".viewport").boundingBox();
  if (!box) throw new Error("no map box");
  expect((await viewOf(page)).shown).toEqual({
    width: Math.min(31, Math.round(box.width) / 32),
    height: 21,
  });
  expect(await onCanvas(page, me.x + 14, me.y - 10)).toBe(true);
  expect(await onCanvas(page, me.x - 14, me.y + 10)).toBe(true);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "98b-view-1280x800-1x.png") });
  await wheel(-100);
  await expect.poll(async () => (await viewOf(page)).scale).toBe(2);
  expect(errors).toEqual([]);
});
