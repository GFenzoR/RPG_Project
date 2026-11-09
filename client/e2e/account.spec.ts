// Account emails end to end (T2.1): sign up in the game → verification email (fake SMTP,
// e2e/fake-smtp.ts) → confirm on the website → "forgot your password?" → reset email →
// new password → every old session is gone → log in with the new one. Runs against the
// mail E2E server (HTTP API only, email on; playwright.config.ts).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mailClientURL, smtpMessagesURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });

interface Sunk {
  to: string;
  subject: string;
  text: string;
}

/** Waits for the n-th email to `to` and returns the link of its text part. */
async function linkOf(to: string, n: number, page: RegExp): Promise<{ mail: Sunk; link: string }> {
  let found: Sunk | undefined;
  await expect
    .poll(
      async () => {
        const all = (await (await fetch(smtpMessagesURL)).json()) as Sunk[];
        found = all.filter((m) => m.to === to)[n - 1];
        return found !== undefined;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const mail = found as Sunk;
  const link = new RegExp(`${mailClientURL}${page.source}\\?lang=es#token=[A-Za-z0-9_-]{43}`).exec(
    mail.text,
  )?.[0];
  expect(link, mail.text).toBeTruthy();
  return { mail, link: link ?? "" };
}

test.use({ baseURL: mailClientURL });

test("sign up, confirm the email, reset the password", async ({ page, browser }) => {
  const email = `e2e-mail-${Date.now()}@example.com`;
  const password = "e2e-password-1";
  const newPassword = "e2e-password-2";

  // Sign up in the game: the characters screen asks to confirm the email.
  await page.goto("/play/?lang=es");
  const login = page.getByTestId("login-form");
  await expect(login.getByTestId("forgot-password")).toBeVisible();
  await login.getByRole("button", { name: "¿No tienes cuenta? Regístrate" }).click();
  const reg = page.getByTestId("register-form");
  await reg.getByLabel("Email").fill(email);
  await reg.getByLabel("Contraseña").fill(password);
  await reg.getByRole("button", { name: "Crear cuenta" }).click();
  const notice = page.getByTestId("verify-notice");
  await expect(notice).toContainText(email);
  await shot(page, "account-01-verify-notice");

  const verify = await linkOf(email, 1, /\/verify/);
  expect(verify.mail.subject).toBe("Confirma tu email en RPG Project");
  expect(verify.mail.text).toContain("vence en 24 horas");

  // The website's /verify page redeems it and drops the token from the address bar.
  await page.goto(verify.link);
  await expect(page.getByTestId("verify-done")).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await shot(page, "account-02-verified");
  // A second use is refused.
  await page.goto(verify.link);
  await expect(page.getByTestId("account-error")).toContainText("ya se usó");

  await page.goto("/play/?lang=es");
  await expect(page.getByTestId("characters")).toBeVisible();
  await expect(page.getByTestId("verify-notice")).toHaveCount(0);

  // Another browser forgets the password: "forgot" link → the website's page.
  const other = await browser.newContext({ baseURL: mailClientURL });
  const p2 = await other.newPage();
  await p2.goto("/play/?lang=es");
  await p2.getByTestId("forgot-password").click();
  await expect(p2).toHaveURL(/\/forgot-password$/);
  await p2.getByLabel("Email").fill(email);
  await p2.getByRole("button", { name: "Mandar el enlace" }).click();
  await expect(p2.getByTestId("forgot-sent")).toBeVisible();
  await shot(p2, "account-03-forgot-sent");

  const reset = await linkOf(email, 2, /\/reset-password/);
  expect(reset.mail.subject).toBe("Cambia tu contraseña de RPG Project");
  await p2.goto(reset.link);
  await p2.getByLabel("Contraseña nueva").fill(newPassword);
  await p2.getByLabel("Repite la contraseña").fill("something-else");
  await p2.getByRole("button", { name: "Guardar la contraseña" }).click();
  await expect(p2.getByTestId("account-error")).toContainText("no coinciden");
  await p2.getByLabel("Repite la contraseña").fill(newPassword);
  await shot(p2, "account-04-reset-form");
  await p2.getByRole("button", { name: "Guardar la contraseña" }).click();
  await expect(p2.getByTestId("reset-done")).toBeVisible();
  await shot(p2, "account-05-reset-done");
  await other.close();

  // The first browser's session was revoked: back to the login, where the new
  // password works and the old one does not.
  await page.reload();
  await expect(login).toBeVisible();
  await login.getByLabel("Email").fill(email);
  await login.getByLabel("Contraseña").fill(password);
  await login.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(login.getByRole("alert")).toContainText("incorrectos");
  await login.getByLabel("Contraseña").fill(newPassword);
  await login.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByTestId("characters")).toBeVisible();
});

test("forgot password answers the same for an unknown email", async ({ page }) => {
  await page.goto("/forgot-password?lang=en");
  await page.getByLabel("Email").fill(`nobody-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "Send the link" }).click();
  await expect(page.getByTestId("forgot-sent")).toBeVisible();
});
