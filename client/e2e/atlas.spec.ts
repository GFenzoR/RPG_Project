// The sprite atlas on a flaky network (docs/14 "Atlas sin reintento"): every request of
// the atlas retries on its own (@rpg/renderer retry.ts, 4 attempts), so a request that
// fails once does not leave the game on "Conectando…"; one that keeps failing shows the
// error with "Reintentar", which starts the canvas again in the same session (no reload,
// no new login). The failures come from Playwright routes. Screenshots go to
// e2e/screenshots/actual/atlas-*.png.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page, Route } from "@playwright/test";
import { serverURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });

function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
}

async function newGuardian(
  playwright: { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } },
  tag: string,
): Promise<{ email: string; password: string }> {
  const email = `e2e-${tag.toLowerCase()}-${Date.now()}-${randomLetters(6)}@example.com`;
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
  return { email, password };
}

/**
 * Logs in and presses "Jugar" (the canvas may not come up: the callers wait for it). The
 * creation form's figure (LookPreview) reads the same atlas on the characters screen: it
 * is waited for, ready or failed, and `beforePlay` runs just before "Jugar", so a test
 * counts only the canvas's requests.
 */
async function play(
  page: Page,
  email: string,
  password: string,
  beforePlay: () => void,
): Promise<void> {
  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  const playButton = page.getByTestId("characters").getByRole("button", { name: "Jugar" });
  await expect(playButton).toBeVisible();
  await expect(page.getByTestId("create-look").getByTestId("look-preview")).not.toHaveAttribute(
    "data-atlas",
    "loading",
    { timeout: 20_000 },
  );
  beforePlay();
  // Marks this page: a reload would lose it.
  await page.evaluate(() => {
    (window as unknown as { e2eSamePage?: boolean }).e2eSamePage = true;
  });
  await playButton.click();
}

const samePage = (page: Page): Promise<boolean> =>
  page.evaluate(() => (window as unknown as { e2eSamePage?: boolean }).e2eSamePage === true);

/** Whether the map's drawing buffer holds a drawn map (see mobile.spec.ts mapDrawn). */
const mapDrawn = (page: Page): Promise<boolean> =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => {
          const c = document.querySelector<HTMLCanvasElement>('[data-testid="game-canvas"]');
          const gl = c?.getContext("webgl2") ?? c?.getContext("webgl");
          if (!c || !gl) return resolve(false);
          const px = new Uint8Array(4);
          for (const fx of [0.25, 0.5, 0.75])
            for (const fy of [0.25, 0.5, 0.75]) {
              gl.readPixels(
                Math.floor(c.width * fx),
                Math.floor(c.height * fy),
                1,
                1,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                px,
              );
              if ((px[0] ?? 0) + (px[1] ?? 0) + (px[2] ?? 0) > 0) return resolve(true);
            }
          resolve(false);
        });
      }),
  );

/** The file name of an atlas request ("atlas.json", "atlas-0.json", "atlas-0.png"). */
const fileOf = (route: Route): string =>
  new URL(route.request().url()).pathname.split("/").pop() ?? "";

test("atlas: a request that fails once is retried and the game starts", async ({
  page,
  playwright,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // The first request of each atlas file the canvas fetches fails (connection refused);
  // the next ones go through. The page image counts only when PixiJS fetches it: an icon's
  // CSS background is not retried by the browser, and the canvas loads the image first.
  const hits = new Map<string, number>();
  await page.route("**/atlas/**", (route) => {
    const file = fileOf(route);
    const isImage = file.endsWith(".png");
    if (isImage && route.request().resourceType() !== "fetch") return route.continue();
    const n = (hits.get(file) ?? 0) + 1;
    hits.set(file, n);
    return n === 1 ? route.abort("connectionrefused") : route.continue();
  });
  const who = await newGuardian(playwright, "Flaky");
  await play(page, who.email, who.password, () => hits.clear());
  await page.waitForFunction(() => window.__rpgClient?.ready === true, undefined, {
    timeout: 30_000,
  });
  // The index and the first page failed once each and came on the second attempt.
  expect(hits.get("atlas.json")).toBe(2);
  expect(hits.get("atlas-0.json")).toBe(2);
  // The image too, when the browser lets the route see PixiJS's fetch (it may come from a
  // worker).
  const image = hits.get("atlas-0.png");
  if (image !== undefined) expect(image).toBe(2);
  await expect(page.getByTestId("load-failed")).toHaveCount(0);
  await expect.poll(() => mapDrawn(page)).toBe(true);
  await page.screenshot({ path: join(shots, "atlas-00-flaky.png") });
  expect(pageErrors).toEqual([]);
});

test("atlas: when it keeps failing, Reintentar starts the map in the same session", async ({
  page,
  playwright,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  // The index fails until `down` is cleared (a server that is down for a while).
  let down = true;
  let requests = 0;
  await page.route("**/atlas/atlas.json", (route) => {
    requests++;
    return down ? route.abort("connectionrefused") : route.continue();
  });
  const who = await newGuardian(playwright, "Offline");
  await play(page, who.email, who.password, () => {
    requests = 0;
  });
  // After the 4 attempts (3.5 s of waits) the error shows, with its button.
  const failed = page.getByTestId("load-failed");
  await expect(failed).toBeVisible({ timeout: 20_000 });
  expect(requests).toBe(4);
  await expect(failed).toContainText("No se pudieron cargar los gráficos del juego.");
  const retry = page.getByTestId("load-retry");
  await expect(retry).toHaveText("Reintentar");
  await expect(page.getByTestId("game-canvas")).toHaveCount(0);
  expect(await page.evaluate(() => window.__rpgClient === undefined)).toBe(true);
  // The session is open: the server's stats reach the header, and no new batch starts
  // the canvas behind the player's back (only the button does).
  await expect(page.getByTestId("health")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(requests).toBe(4);
  await expect(failed).toBeVisible();
  await expect(page.getByTestId("login-form")).toHaveCount(0);
  await page.screenshot({ path: join(shots, "atlas-01-failed.png") });

  // The network is back: the button starts the canvas without a reload or a new login.
  down = false;
  await retry.click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true, undefined, {
    timeout: 30_000,
  });
  expect(requests).toBe(5);
  await expect(failed).toHaveCount(0);
  await expect(page.getByTestId("game-canvas")).toHaveCount(1);
  expect(await samePage(page)).toBe(true);
  expect(await page.evaluate(() => window.__rpgClient?.self() !== undefined)).toBe(true);
  await expect.poll(() => mapDrawn(page)).toBe(true);
  await page.screenshot({ path: join(shots, "atlas-02-retried.png") });
  expect(pageErrors).toEqual([]);
});
