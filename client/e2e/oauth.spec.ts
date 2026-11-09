// OAuth end to end (T2.1 2/2) against a fake Google and Discord (server/cmd/fakeoauth):
// a new account through Google, linking Discord and unlinking from "My account" (never
// the last way in), an existing email that must prove its password before linking, and
// a denied login. Runs on the mail E2E server (playwright.config.ts).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { fakeOAuthURL, mailClientURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });

/** Who the fake provider signs in next. */
async function next(
  provider: string,
  user: { sub?: string; email?: string; verified?: boolean; deny?: boolean },
): Promise<void> {
  const res = await fetch(`${fakeOAuthURL}/test/next`, {
    method: "POST",
    body: JSON.stringify({ provider, ...user }),
  });
  expect(res.status).toBe(204);
}

test.use({ baseURL: mailClientURL });

test("new account with Google, link and unlink Discord", async ({ page }) => {
  const id = Date.now();
  await next("google", { sub: `g-${id}`, email: `oauth-${id}@example.com`, verified: true });
  await page.goto("/play/?lang=es");
  const login = page.getByTestId("login-form");
  await expect(login.getByTestId("oauth-google")).toHaveText("Continuar con Google");
  await expect(login.getByTestId("oauth-discord")).toBeVisible();
  await shot(page, "oauth-01-login-buttons");
  await login.getByTestId("oauth-google").click();
  // Back in the game, signed in: the characters screen.
  await expect(page).toHaveURL(/\/play\/$/);
  await expect(page.getByTestId("characters")).toBeVisible();

  await page.goto("/account");
  await expect(page.getByTestId("account-page")).toContainText(`oauth-${id}@example.com`);
  await expect(page.getByTestId("identity-google")).toBeVisible();
  await expect(page.getByTestId("account-page")).toContainText("(confirmado)");
  // No password: linking works because the login was a moment ago.
  await next("discord", { sub: `d-${id}`, email: `oauth-${id}@example.com`, verified: true });
  await page.getByTestId("link-discord").click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByTestId("account-linked")).toContainText("vinculaste Discord");
  await expect(page.getByTestId("identity-discord")).toBeVisible();
  await shot(page, "oauth-02-account-linked");

  await page.getByTestId("unlink-google").click();
  await expect(page.getByTestId("identity-google")).toHaveCount(0);
  await page.getByTestId("unlink-discord").click();
  await expect(page.getByTestId("oauth-page-error")).toContainText("única forma de entrar");
  await expect(page.getByTestId("identity-discord")).toBeVisible();
  await shot(page, "oauth-03-last-method");
});

test("an existing email must prove its password before linking", async ({ page, request }) => {
  const id = Date.now();
  const email = `owner-${id}@example.com`;
  expect(
    (
      await request.post("/api/auth/register", { data: { email, password: "owner-password-1" } })
    ).status(),
  ).toBe(201);
  await next("discord", { sub: `intruder-${id}`, email, verified: true });
  await page.goto("/play/?lang=es");
  await page.getByTestId("oauth-discord").click();
  await expect(page).toHaveURL(/\/oauth\/confirm$/);
  const confirm = page.getByTestId("oauth-confirm");
  await expect(confirm).toContainText(email);
  await shot(page, "oauth-04-confirm");
  await confirm.getByLabel(`Contraseña de la cuenta ${email}`).fill("wrong-password-1");
  await confirm.getByTestId("oauth-confirm-link").click();
  await expect(page.getByTestId("oauth-page-error")).toContainText("incorrectos");
  await confirm.getByLabel(`Contraseña de la cuenta ${email}`).fill("owner-password-1");
  await confirm.getByTestId("oauth-confirm-link").click();
  await expect(page).toHaveURL(/\/play\/$/);
  await expect(page.getByTestId("characters")).toBeVisible();
  await page.goto("/account");
  await expect(page.getByTestId("identity-discord")).toBeVisible();
});

test("a denied login shows a clean page", async ({ page }) => {
  await next("google", { deny: true });
  await page.goto("/play/?lang=es");
  await page.getByTestId("oauth-google").click();
  await expect(page).toHaveURL(/\/oauth\/error\?code=denied$/);
  await expect(page.getByTestId("oauth-error")).toContainText("Cancelaste el acceso");
  await shot(page, "oauth-05-denied");
});
