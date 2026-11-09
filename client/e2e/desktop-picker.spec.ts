// The desktop app's server picker on the login screen (client/src/ui/ServerPicker.tsx),
// in a browser that pretends to be the Tauri webview: `isTauri` and a fake
// `__TAURI_INTERNALS__.invoke` that records every command. The real app (Rust side, the
// restart) is covered by apps/desktop's cargo tests and `make desktop-smoke`.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

declare global {
  interface Window {
    __calls?: Call[];
  }
}

async function fakeDesktop(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: Call[] = [];
    const w = window as unknown as Record<string, unknown>;
    w["__calls"] = calls;
    w["isTauri"] = true;
    w["__TAURI_INTERNALS__"] = {
      invoke: (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
        calls.push({ cmd, args });
        if (cmd === "server_info")
          return Promise.resolve({
            origin: "http://localhost:8080",
            ws_url: "ws://localhost:8080/ws",
            editable: true,
          });
        // set_server restarts the app in reality: here it just resolves.
        if (cmd === "set_server") return Promise.resolve(null);
        return Promise.resolve({ status: 401, body: null }); // every API call: no session
      },
      transformCallback: () => 0,
    };
  });
}

const calls = (page: Page, cmd: string): Promise<Call[]> =>
  page.evaluate((c) => (window.__calls ?? []).filter((x) => x.cmd === c), cmd);

test.describe("desktop server picker", () => {
  test.beforeEach(async ({ page }) => {
    await fakeDesktop(page);
    await page.setViewportSize({ width: 960, height: 700 });
    await page.goto("/play/?lang=es");
    await expect(page.getByTestId("login-form")).toBeVisible();
  });

  test("Enter saves the server, a bare LAN address gets http://", async ({ page }) => {
    const picker = page.getByTestId("server-picker");
    await expect(picker.locator("summary")).toHaveText("Servidor: http://localhost:8080");
    await picker.locator("summary").click();
    const input = picker.getByLabel("Dirección del servidor");
    await input.fill("192.168.1.20:8080");
    await input.press("Enter");
    await expect
      .poll(() => calls(page, "set_server"))
      .toEqual([{ cmd: "set_server", args: { url: "http://192.168.1.20:8080" } }]);
    await expect(input).toHaveValue("http://192.168.1.20:8080");
    // Enter in the picker never submits the login form.
    expect(await calls(page, "api")).not.toContainEqual(
      expect.objectContaining({ args: expect.objectContaining({ path: "/api/auth/login" }) }),
    );
  });

  test("an invalid address shows the translated error and saves nothing", async ({ page }) => {
    const picker = page.getByTestId("server-picker");
    await picker.locator("summary").click();
    await picker.getByLabel("Dirección del servidor").fill("http://juego.example.com");
    await picker.getByRole("button", { name: "Guardar y reiniciar" }).click();
    await expect(picker.getByRole("alert")).toHaveText(
      "http:// solo sirve para este PC o tu red local; para otro servidor usa https://.",
    );
    await page.screenshot({ path: "e2e/screenshots/actual/45-desktop-server-picker.png" });
    await picker.getByLabel("Dirección del servidor").fill("http://localhost:8080/play/");
    await picker.getByRole("button", { name: "Guardar y reiniciar" }).click();
    await expect(picker.getByRole("alert")).toHaveText(
      "Escribe solo la dirección del servidor, sin rutas como /play/.",
    );
    expect(await calls(page, "set_server")).toEqual([]);
  });

  test("the login form still submits while the picker holds an invalid value", async ({ page }) => {
    const picker = page.getByTestId("server-picker");
    await picker.locator("summary").click();
    await picker.getByLabel("Dirección del servidor").fill("not a url");
    await picker.locator("summary").click(); // collapsed again, like a player would leave it
    const login = page.getByTestId("login-form");
    await login.getByLabel("Email").fill("someone@example.com");
    await login.getByLabel("Contraseña").fill("some-password-1");
    await login.getByRole("button", { name: "Entrar", exact: true }).click();
    // The fake API answers 401 without a body: the form shows an error, so it was sent.
    await expect(login.getByRole("alert")).toBeVisible();
    expect(await calls(page, "api")).toContainEqual(
      expect.objectContaining({ args: expect.objectContaining({ path: "/api/auth/login" }) }),
    );
    expect(await calls(page, "set_server")).toEqual([]);
  });
});
