// E2E of the public website (T4.3): the landing in Spanish and English (desktop and phone
// widths), the highscores with a character created here, a news post, and "Play" leading
// to the login and into the game at /play/.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { databaseUrl, serverURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string, fullPage = true): Promise<Buffer> =>
  page.screenshot({ path: join(shots, `${name}.png`), fullPage });

function randomLetters(n: number): string {
  const pool = "bcdfghjklmnpqrstvwxz";
  let s = "";
  for (let i = 0; i < n; i++) s += pool[Math.floor(Math.random() * pool.length)];
  return s;
}

const email = `site-${Date.now()}-${randomLetters(6)}@example.com`;
const password = "e2e-password-1";
const name = `Champion ${randomLetters(8).replace(/^./, (c) => c.toUpperCase())}`;

/** No horizontal scroll: nothing is wider than the viewport. */
async function fitsWidth(page: Page): Promise<void> {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(width);
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test.describe.serial("public website", () => {
  // The character must exist before any page asks for the level ranking: the server caches
  // each page for a minute. Its level and experience put it first of every run so far.
  test.beforeAll(async ({ playwright }) => {
    const api = await playwright.request.newContext({ baseURL: serverURL });
    expect((await api.post("/api/auth/register", { data: { email, password } })).status()).toBe(
      201,
    );
    const login = await api.post("/api/auth/login", {
      data: { email, password, token_in_body: true },
    });
    const { token } = (await login.json()) as { token: string };
    const created = await api.post("/api/characters", {
      data: { name, vocation: "druid" },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(created.status()).toBe(201);
    await api.dispose();
    execFileSync("psql", [
      databaseUrl,
      "-c",
      `UPDATE characters SET level = 500, experience = ${Date.now()} WHERE name = '${name}'`,
    ]);
  });

  test("landing in Spanish and English, desktop and phone", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/?lang=es");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Un mundo abierto, casilla por casilla",
    );
    await expect(page).toHaveTitle("RPG Project");
    const status = page.getByTestId("status");
    await expect(status.locator("[data-state]")).toHaveText("En línea");
    await expect(status).toContainText(/jugador(es)? conectados?|Nadie conectado/);
    await expect(page.getByRole("heading", { name: "Guardián" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Druida" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Bienvenidos a RPG Project" })).toBeVisible();
    const top = page.getByTestId("top5");
    // At most 5 rows (fewer on a fresh E2E database).
    await expect(top.locator("tbody tr").first()).toBeVisible();
    expect(await top.locator("tbody tr").count()).toBeLessThanOrEqual(5);
    await expect(top.locator("tbody tr").first()).toContainText(name);
    await expect(top.locator("tbody tr").first()).toContainText("Druida");
    await expect(page.getByRole("link", { name: "Jugar" }).first()).toHaveAttribute(
      "href",
      "/play/?lang=es",
    );
    await fitsWidth(page);
    await shot(page, "site-01-landing-es");

    // Keyboard: the first Tab reaches the skip link, which moves focus to the content.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Saltar al contenido" })).toBeFocused();

    await page.getByTestId("language").selectOption("en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("An open world, tile by tile");
    await expect(status.locator("[data-state]")).toHaveText("Online");
    await expect(page.getByRole("heading", { name: "Vocations" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Welcome to RPG Project" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Play" }).first()).toHaveAttribute(
      "href",
      "/play/?lang=en",
    );
    await shot(page, "site-02-landing-en");

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/?lang=es");
    await expect(page.getByTestId("top5").locator("tbody tr").first()).toContainText(name);
    await fitsWidth(page);
    await shot(page, "site-03-landing-es-375");
    await page.goto("/?lang=en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("An open world, tile by tile");
    await fitsWidth(page);
    await shot(page, "site-04-landing-en-375", false);
    expect(errors).toEqual([]);
  });

  test("highscores: filters, paging and the new character", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/?lang=es");
    await page
      .getByRole("navigation", { name: "Secciones del sitio" })
      .getByRole("link", { name: "Ranking" })
      .click();
    await expect(page).toHaveURL(/\/highscores$/);
    await expect(page).toHaveTitle("Ranking · RPG Project");
    const table = page.getByTestId("highscores");
    await expect(table.locator("tbody tr").first()).toContainText(name);
    await expect(table.locator("thead")).toContainText("Nivel");

    // By vocation: only druids.
    await page.getByTestId("hs-vocation").selectOption("druid");
    await expect(page).toHaveURL(/vocation=druid/);
    await expect(table.locator("tbody tr").first()).toContainText(name);
    for (const voc of await table.locator("tbody td:nth-child(3)").allTextContents())
      expect(voc).toBe("Druida");

    // By skill: the column says which one.
    await page.getByTestId("hs-category").selectOption("fishing");
    await expect(page).toHaveURL(/category=fishing&vocation=druid/);
    await expect(table.locator("thead")).toContainText("Pesca");
    await expect(table.locator("tbody tr").first()).toBeVisible();
    await shot(page, "site-05-highscores-es");

    // Paging, when the E2E database has enough characters for a second page.
    await page.goto("/highscores?lang=es");
    const next = page.getByTestId("hs-next");
    await expect(table.locator("tbody tr").first()).toBeVisible();
    if (await next.isEnabled()) {
      await next.click();
      await expect(page).toHaveURL(/page=2/);
      await expect(table.locator("tbody tr").first().locator("td").first()).toHaveText("21");
    }

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/highscores?lang=en&vocation=druid");
    await expect(table.locator("tbody tr").first()).toContainText("Druid");
    await fitsWidth(page);
    await shot(page, "site-06-highscores-en-375", false);
    expect(errors).toEqual([]);
  });

  test("news: list and post", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/news?lang=es");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Noticias");
    await page.getByRole("link", { name: "Bienvenidos a RPG Project" }).click();
    await expect(page).toHaveURL(/\/news\/2026-11-01-bienvenida$/);
    const post = page.locator("article.post");
    await expect(post.getByRole("heading", { level: 1 })).toHaveText("Bienvenidos a RPG Project");
    await expect(post.locator("li")).toHaveCount(3);
    await expect(post.locator("strong").first()).toHaveText("vocaciones");
    await shot(page, "site-07-news-post-es");
    await post.getByRole("link", { name: "Volver a las noticias" }).click();
    await expect(page).toHaveURL(/\/news$/);
    // A direct load of a post (server fallback to the website page) and an unknown one.
    await page.goto("/news/2026-11-05-ranking-y-noticias?lang=en");
    await expect(page.locator("article.post h1")).toHaveText("New website: highscores and news");
    await page.goto("/news/2020-01-01-nothing?lang=en");
    await expect(page.locator("article.post h1")).toHaveText("That news post does not exist.");
    expect(errors).toEqual([]);
  });

  test("Play leads to the login and into the game", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/?lang=es");
    await page.getByTestId("play").click();
    await expect(page).toHaveURL(/\/play\/\?lang=es$/);
    const loginForm = page.getByTestId("login-form");
    await expect(loginForm).toBeVisible();
    // Without a session the game's first /api/characters answers 401 (logged by the browser).
    errors.length = 0;
    await loginForm.getByLabel("Email").fill(email);
    await loginForm.getByLabel("Contraseña").fill(password);
    await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
    const list = page.getByTestId("characters");
    await expect(list.getByText(name)).toBeVisible();
    await list.getByRole("button", { name: "Jugar" }).click();
    await page.waitForFunction(() => window.__rpgClient?.ready === true);
    await expect(page.getByTestId("game-canvas")).toBeVisible();
    await page.waitForTimeout(300); // atlas textures (served from the site root, not /play/)
    await shot(page, "site-08-play", false);

    // An old link to / shows the website even with a session; Play goes back to the game.
    await page.goto("/?lang=es");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Un mundo abierto, casilla por casilla",
    );
    await page.goto("/play");
    await expect(page).toHaveURL(/\/play$/);
    await expect(page.getByTestId("characters").getByText(name)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
