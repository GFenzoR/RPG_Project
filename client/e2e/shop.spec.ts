// T5.7: the cosmetic shop end to end against the fake payment provider (the main E2E
// server runs with RPG_ENV=development and PAYMENTS_PROVIDER=fake, playwright.config.ts).
// A player signs in on /shop, buys a pack through the fake checkout (a POST with the
// buyer's own session), buys an outfit, enters the game, buys a name effect on the site while online (the game pushes the new
// state), equips both in the Appearance panel, and a second player in another browser
// context sees them on the first player's creature.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { serverURL } from "../playwright.config.ts";

const shots = join(import.meta.dirname, "screenshots", "actual");
mkdirSync(shots, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> =>
  page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });

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

async function enterGame(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/play/?lang=es");
  const loginForm = page.getByTestId("login-form");
  await loginForm.getByLabel("Email").fill(email);
  await loginForm.getByLabel("Contraseña").fill(password);
  await loginForm.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByTestId("characters").getByRole("button", { name: "Jugar" }).click();
  await page.waitForFunction(() => window.__rpgClient?.ready === true);
}

interface ShopJSON {
  enabled: boolean;
  balance: number;
  cosmetics: { id: string; owned: boolean }[];
  history: { kind: string; amount: number; cosmetic_id?: string; pack_id?: string }[];
}

test("T5.7: buy nacre through the fake checkout, buy cosmetics, equip them and be seen", async ({
  browser,
  playwright,
}) => {
  const buyer = await newGuardian(playwright, "Buyer");
  const watcher = await newGuardian(playwright, "Watcher");
  const errors: string[] = [];
  const watch = (page: Page): void => {
    page.on("console", (m) => {
      // The refused purchase (insufficient balance) is an expected 409.
      if (m.type() === "error" && !m.text().includes("409 (Conflict)")) errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(e.message));
  };
  const contexts: BrowserContext[] = [];
  const context = async (): Promise<BrowserContext> => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.push(c);
    return c;
  };

  // ---- The site: sign in on /shop (the nav links it: the server takes payments). ----
  const site = await (await context()).newPage();
  await site.goto("/shop?lang=es");
  await expect(site.getByRole("link", { name: "Tienda" })).toBeVisible();
  const login = site.locator(".maps-login");
  await expect(login).toContainText("Entra con tu cuenta para ver la tienda.");
  await login.getByLabel("Email").fill(buyer.email);
  await login.getByLabel("Contraseña").fill(buyer.password);
  await login.getByRole("button", { name: "Entrar", exact: true }).click();
  watch(site); // after the sign-in check's expected 401
  await expect(site.getByTestId("shop-page")).toBeVisible();
  await expect(site.getByTestId("shop-balance")).toHaveText("0 de nácar");
  await expect(site.getByTestId("shop-history")).toHaveCount(0);

  // A pack through the fake checkout: the page posts it with the buyer's session (a GET or
  // another account pays nothing) and comes back paid, like from a real provider.
  const checkoutPost = site.waitForRequest(
    (r) => r.url().includes("/api/shop/fake-checkout/") && r.method() === "POST",
  );
  await site.getByTestId("buy-pack-pack_medium").click();
  const fakeCheckout = new URL((await checkoutPost).url()).pathname;
  await expect(site.getByTestId("shop-return")).toHaveAttribute("data-checkout", "success");
  await expect(site.getByTestId("shop-return")).toContainText("Pago recibido.");
  await expect(site.getByTestId("shop-balance")).toHaveText("550 de nácar");
  // Following the checkout link (a GET) pays nothing, and the watcher cannot use it.
  await site.request.get(fakeCheckout);
  const stranger = await playwright.request.newContext({ baseURL: serverURL });
  const strangerLogin = await stranger.post("/api/auth/login", {
    data: { email: watcher.email, password: watcher.password, token_in_body: true },
  });
  const { token: strangerToken } = (await strangerLogin.json()) as { token: string };
  const stolen = await stranger.post(`${fakeCheckout}?status=refunded`, {
    headers: { Authorization: `Bearer ${strangerToken}` },
  });
  expect(stolen.status()).toBe(404);
  await stranger.dispose();
  await site.reload();
  await expect(site.getByTestId("shop-balance")).toHaveText("550 de nácar");

  // The sailor outfit for 300.
  site.once("dialog", (d) => {
    expect(d.message()).toBe("¿Comprar Marinero por 300 de nácar?");
    void d.accept();
  });
  await site.getByTestId("buy-outfit_sailor").click();
  await expect(site.getByTestId("shop-done")).toContainText("Marinero ya es tuyo");
  await expect(site.locator('[data-cosmetic="outfit_sailor"]')).toHaveAttribute("data-owned", "");
  await expect(site.getByTestId("shop-balance")).toHaveText("250 de nácar");
  // Declining the confirmation buys nothing.
  site.once("dialog", (d) => void d.dismiss());
  await site.getByTestId("buy-outfit_noble").click();
  await expect(site.getByTestId("shop-balance")).toHaveText("250 de nácar");
  // The noble outfit (600) is more than the balance: the server refuses it.
  site.once("dialog", (d) => void d.accept());
  await site.getByTestId("buy-outfit_noble").click();
  await expect(site.getByTestId("shop-error")).toHaveText(
    "No te alcanza el nácar. Compra un paquete primero.",
  );
  await expect(site.getByTestId("shop-history").locator("li")).toHaveCount(2);
  await shot(site, "63-shop-desktop");
  await site.setViewportSize({ width: 375, height: 812 });
  await shot(site, "64-shop-phone");
  const width = await site.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
  await site.setViewportSize({ width: 1280, height: 800 });

  // ---- The game: the watcher first, then the buyer next to them (same start temple). ----
  const other = await (await context()).newPage();
  await enterGame(other, watcher.email, watcher.password);
  watch(other);
  const game = await (await context()).newPage();
  await enterGame(game, buyer.email, buyer.password);
  watch(game);
  await game.waitForFunction(() => window.__rpgClient?.cosmetics() !== undefined);
  expect(await game.evaluate(() => window.__rpgClient?.cosmetics())).toEqual({
    owned: ["outfit_sailor"],
    balance: 250,
    equipped: { outfit: "", color: "", nameEffect: "" },
  });
  const panel = game.getByTestId("appearance-panel");
  await expect(panel.getByTestId("appearance-balance")).toHaveText("Saldo: 250 de nácar");
  await expect(panel.locator('[data-cosmetic="default-outfit"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // A purchase on the site while the buyer plays reaches the game (CosmeticsState push).
  site.once("dialog", (d) => void d.accept());
  await site.getByTestId("buy-name_frost").click();
  await expect(site.getByTestId("shop-balance")).toHaveText("0 de nácar");
  await expect(panel.locator('[data-cosmetic="name_frost"]')).toBeVisible();
  await expect(panel.getByTestId("appearance-balance")).toHaveText("Saldo: 0 de nácar");

  // The API agrees with the page.
  const state = (await (await site.request.get("/api/shop")).json()) as ShopJSON;
  expect(state.enabled).toBe(true);
  expect(state.balance).toBe(0);
  expect(state.cosmetics.filter((c) => c.owned).map((c) => c.id)).toEqual([
    "outfit_sailor",
    "name_frost",
  ]);
  expect(state.history.map((h) => [h.kind, h.amount])).toEqual([
    ["purchase", -250],
    ["purchase", -300],
    ["pack", 550],
  ]);

  // Equip both from the Appearance panel.
  await panel.locator('[data-cosmetic="outfit_sailor"]').click();
  await panel.locator('[data-cosmetic="name_frost"]').click();
  await expect(panel.locator('[data-cosmetic="outfit_sailor"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(panel.locator('[data-cosmetic="name_frost"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() => game.evaluate(() => window.__rpgClient?.cosmetics()?.equipped))
    .toEqual({ outfit: "outfit_sailor", color: "", nameEffect: "name_frost" });
  // The chat stays at the bottom of the side column: bring the whole panel above it.
  await panel.evaluate((e) => e.scrollIntoView({ block: "start" }));
  await expect(panel.getByTestId("appearance-shop")).toHaveAttribute("href", "/shop");
  await panel.screenshot({ path: join(shots, "65-appearance-panel.png") });

  // The watcher sees the buyer's new look on its creature.
  await expect
    .poll(() =>
      other.evaluate(
        (name) => window.__rpgClient?.players().find((p) => p.name === name)?.cosmetics,
        buyer.name,
      ),
    )
    .toEqual({ outfit: "outfit_sailor", color: "", nameEffect: "name_frost" });
  await game.screenshot({ path: join(shots, "66-shop-buyer.png") });
  await other.screenshot({ path: join(shots, "67-shop-watcher.png") });

  // Back to the default outfit: the watcher sees that too.
  await panel.locator('[data-cosmetic="default-outfit"]').click();
  await expect
    .poll(() =>
      other.evaluate(
        (name) => window.__rpgClient?.players().find((p) => p.name === name)?.cosmetics.outfit,
        buyer.name,
      ),
    )
    .toBe("");

  // On a phone the panel is one more tab under the map (T5.6 layout).
  await game.setViewportSize({ width: 412, height: 915 });
  const tab = game.getByTestId("panel-tabs").locator('[data-tab="appearance"]');
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(panel).toBeVisible();
  const box = await panel.locator('[data-cosmetic="outfit_sailor"]').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await shot(game, "68-appearance-phone");

  expect(errors).toEqual([]);
  for (const c of contexts) await c.close();
});
