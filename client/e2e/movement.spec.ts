// Fluid movement (client/CLAUDE.md "Movimiento fluido"): a held arrow key walks several
// tiles and the own creature moves on every frame, with no stop between tiles and no
// jump back. Reads the positions the client recorded (`__rpgClient.trail`): the model's
// `WorldState.drawPos` in each `frame`, what the canvas draws from, in fractional tiles.
// Not the sprite or the camera on screen: their rounding to screen pixels is
// `render/viewport.test.ts`'s.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { serverURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });

function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
}

const KEYS = [
  { key: "ArrowRight", dx: 1, dy: 0 },
  { key: "ArrowLeft", dx: -1, dy: 0 },
  { key: "ArrowDown", dx: 0, dy: 1 },
  { key: "ArrowUp", dx: 0, dy: -1 },
] as const;

/** Waits until the own creature stands still with every step confirmed; returns where. */
async function standing(page: Page): Promise<{ x: number; y: number; z: number }> {
  let at: { x: number; y: number; z: number } | undefined;
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.__rpgClient?.self());
        at = s && !s.pending && !s.walking ? { x: s.x, y: s.y, z: s.z } : undefined;
        return at !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  if (!at) throw new Error("never stood still");
  return at;
}

test("a held arrow key walks tile after tile without stopping between them", async ({
  page,
  playwright,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  const email = `e2e-walk-${Date.now()}-${randomLetters(6)}@example.com`;
  const password = "e2e-password-1";
  const name = `Fluido ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;
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

  await page.goto("/play/?lang=es");
  const form = page.getByTestId("login-form");
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Contraseña").fill(password);
  await form.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
  errors.length = 0; // the 401 of opening the page without a session cookie

  // A straight run of 6 free tiles from where the character wakes up.
  const start = await standing(page);
  let way: (typeof KEYS)[number] | undefined;
  for (const k of KEYS) {
    const free = await page.evaluate(
      ({ s, dx, dy }) =>
        [1, 2, 3, 4, 5, 6].every(
          (i) => window.__rpgClient?.walkable(s.x + dx * i, s.y + dy * i, s.z) ?? false,
        ),
      { s: start, dx: k.dx, dy: k.dy },
    );
    if (free) {
      way = k;
      break;
    }
  }
  if (!way) throw new Error(`no straight run of 6 free tiles from ${JSON.stringify(start)}`);
  const dir = way;
  await page.waitForTimeout(300); // let the atlas textures upload

  // Hold the key ~4 steps long (500 ms each at level 1), then let go.
  const t0 = await page.evaluate(() => performance.now());
  await page.keyboard.down(dir.key);
  await page.waitForTimeout(1300);
  await page.screenshot({ path: join(shots, "96-movement-held-key.png") });
  await page.waitForTimeout(700);
  await page.keyboard.up(dir.key);
  const end = await standing(page);
  const t1 = await page.evaluate(() => performance.now());
  const tiles = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
  expect(tiles).toBeGreaterThanOrEqual(4);
  expect(tiles).toBeLessThanOrEqual(6);
  expect(end.z).toBe(start.z);

  // Every frame from leaving the first tile to reaching the last one moved along the way.
  const trail = await page.evaluate((ms) => window.__rpgClient?.trail(ms) ?? [], t1 - t0 + 500);
  const along = trail.map((s) => ({
    t: s.t,
    d: (s.x - start.x) * dir.dx + (s.y - start.y) * dir.dy,
  }));
  const first = along.findIndex((s) => s.d > 0);
  const last = along.findIndex((s) => s.d >= tiles);
  expect(first).toBeGreaterThan(0);
  expect(last).toBeGreaterThan(first);
  const walking = along.slice(first - 1, last + 1);
  let stalls = 0;
  let back = 0;
  let biggest = 0;
  for (let i = 1; i < walking.length; i++) {
    const a = walking[i - 1];
    const b = walking[i];
    if (!a || !b || b.t - a.t < 1) continue;
    const step = b.d - a.d;
    if (step <= 1e-9) stalls++;
    if (step < -1e-9) back++;
    biggest = Math.max(biggest, step);
  }
  console.log(
    `held ${dir.key}: ${tiles} tiles in ${walking.length} frames, ${stalls} still, biggest ${biggest.toFixed(3)} tile`,
  );
  expect(walking.length).toBeGreaterThan(8 * tiles); // frames were drawn (~30 a tile at 60 fps)
  expect(back).toBe(0); // never pulled back
  expect(stalls).toBe(0); // never stood still between tiles
  expect(errors).toEqual([]);
});
