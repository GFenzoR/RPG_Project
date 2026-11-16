// E2E for the game client: starts the game server (Go) on the compiled test map
// (world/ → build/world.bin, island testisle) against Postgres, and the client's Vite dev
// server proxying /api and /ws to it. Postgres must be running (make db-up); the server
// applies migrations itself. Screenshots go to e2e/screenshots/actual/ (git-ignored).
//
// Two projects: "chromium" runs every spec as before; "webkit-mobile" runs the touch tests
// of e2e/mobile.spec.ts whose title says "(webkit)" (iPhone and iPad, as Safari on iOS
// would). WebKit needs `pnpm exec playwright install webkit` (make setup does it; on Linux
// add --with-deps); without it, or with CLIENT_E2E_WEBKIT=0, the project is left out
// with a note and Chromium runs alone.
import { existsSync } from "node:fs";
import { defineConfig, devices, webkit } from "@playwright/test";
import type { Project } from "@playwright/test";

const serverPort = Number(process.env["CLIENT_E2E_SERVER_PORT"] ?? 18080);
const clientPort = Number(process.env["CLIENT_E2E_PORT"] ?? 5176);
export const databaseUrl =
  process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432/rpg";
// Go servers listen on loopback only (-http 127.0.0.1:PORT): a server on every interface
// makes the Windows firewall ask again after each `go run`, which builds a new exe path.
export const serverURL = `http://127.0.0.1:${serverPort}`;
// A second server whose start island is Puerto, like production (T4.2: a new character
// starts there with no town and gets the tutorial), with its own Vite.
const puertoServerPort = Number(process.env["CLIENT_E2E_PUERTO_SERVER_PORT"] ?? 18081);
const puertoClientPort = Number(process.env["CLIENT_E2E_PUERTO_PORT"] ?? 5177);
export const puertoServerURL = `http://127.0.0.1:${puertoServerPort}`;
export const puertoClientURL = `http://localhost:${puertoClientPort}`;
// Account emails (T2.1): a server with email on (HTTP API only, no world), its own Vite
// and a fake SMTP server (e2e/fake-smtp.ts) whose messages are read over HTTP.
const mailServerPort = Number(process.env["CLIENT_E2E_MAIL_SERVER_PORT"] ?? 18082);
const mailClientPort = Number(process.env["CLIENT_E2E_MAIL_PORT"] ?? 5178);
const smtpPort = Number(process.env["CLIENT_E2E_SMTP_PORT"] ?? 18025);
const smtpHttpPort = Number(process.env["CLIENT_E2E_SMTP_HTTP_PORT"] ?? 18026);
export const mailClientURL = `http://localhost:${mailClientPort}`;
export const smtpMessagesURL = `http://127.0.0.1:${smtpHttpPort}/messages`;
// OAuth (T2.1 2/2): the same server logs in with a fake Google and Discord
// (server/cmd/fakeoauth); POST <fakeOAuthURL>/test/next picks who logs in next.
const fakeOAuthPort = Number(process.env["CLIENT_E2E_FAKE_OAUTH_PORT"] ?? 18027);
export const fakeOAuthURL = `http://127.0.0.1:${fakeOAuthPort}`;

/** Tests of the WebKit project carry this in their title (mobile.spec.ts). */
const WEBKIT_TITLE = /\(webkit\)/;

/** The WebKit project, when its browser is installed and not switched off. */
function webkitProject(): Project[] {
  if (process.env["CLIENT_E2E_WEBKIT"] === "0") return [];
  const installed = ((): boolean => {
    try {
      return existsSync(webkit.executablePath());
    } catch {
      return false;
    }
  })();
  if (!installed) {
    console.warn(
      "client e2e: WebKit is not installed (pnpm exec playwright install webkit): " +
        "the (webkit) touch tests are left out.",
    );
    return [];
  }
  return [
    {
      name: "webkit-mobile",
      testMatch: /mobile\.spec\.ts$/,
      grep: WEBKIT_TITLE,
      // Each describe of mobile.spec.ts sets its device (viewport, touch, scale).
      use: { browserName: "webkit" },
    },
  ];
}

/**
 * On CI (GitHub sets CI=true): an ubuntu runner with 2 CPUs and no GPU, so every page draws
 * WebGL in software and the suite runs a few times slower than on a PC. A failed test runs
 * once more and the report marks it "flaky" if it then passes: a flake is visible, not
 * hidden, and does not sink the job. The first attempt records no trace (a trace films the
 * page, which costs CPU the runner does not have); it keeps a screenshot and the error
 * context, and the retry records the whole trace. Locally: no retries, a trace of every
 * failure. A `test.only` left behind fails on CI.
 */
const ci = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: "e2e",
  outputDir: "../test-results/client",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  retries: ci ? 1 : 0,
  forbidOnly: ci,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${clientPort}`,
    viewport: { width: 1280, height: 800 },
    trace: ci ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      grepInvert: WEBKIT_TITLE,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        // Headless Chromium on Windows draws WebGL in software (SwiftShader), which makes
        // PixiJS pages several times slower than on Linux: use the GPU through ANGLE/D3D11.
        ...(process.platform === "win32" && {
          launchOptions: {
            args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"],
          },
        }),
      },
    },
    ...webkitProject(),
  ],
  webServer: [
    {
      // mapcompile first, so `pnpm --filter @rpg/client e2e` works on its own too.
      command:
        // -dev: the sandbox island (dev-only) is in the map, for e2e/sandbox.spec.ts.
        "go run ./cmd/mapcompile -root .. -out ../build/world.bin -dev && " +
        // Every test registers and logs in from 127.0.0.1: raise the per-IP auth burst so the
        // suite does not depend on how fast it runs (production keeps the default).
        // -cookie-secure=false: Playwright's WebKit drops a Secure cookie on http://localhost
        // (Chromium keeps it), so the (webkit) tests could not stay logged in; production and
        // the other servers here keep the flag.
        `go run ./cmd/gameserver -http 127.0.0.1:${serverPort} -world ../build/world.bin -seed 1 -auth-rate-burst 1000 -cookie-secure=false -start-town testisle -boat-routes ../client/e2e/fixtures/boat_routes.yaml`,
      cwd: `${import.meta.dirname}/../server`,
      url: `${serverURL}/healthz`,
      reuseExistingServer: false,
      timeout: 240_000,
      // T5.7: the cosmetic shop with the fake payment provider (refused in production).
      env: { DATABASE_URL: databaseUrl, RPG_ENV: "development", PAYMENTS_PROVIDER: "fake" },
      stdout: "pipe",
    },
    {
      command: `pnpm exec vite --port ${clientPort} --strictPort`,
      cwd: import.meta.dirname,
      url: `http://localhost:${clientPort}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { RPG_SERVER: serverURL },
    },
    {
      // Its own world.bin: both servers compile the map at the same time.
      command:
        "go run ./cmd/mapcompile -root .. -out ../build/world-puerto.bin && " +
        `go run ./cmd/gameserver -http 127.0.0.1:${puertoServerPort} -world ../build/world-puerto.bin -seed 1 -auth-rate-burst 1000 -start-town puerto -metrics-addr ""`,
      cwd: `${import.meta.dirname}/../server`,
      url: `${puertoServerURL}/healthz`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { DATABASE_URL: databaseUrl },
      stdout: "pipe",
    },
    {
      command: `pnpm exec vite --port ${puertoClientPort} --strictPort`,
      cwd: import.meta.dirname,
      url: `${puertoClientURL}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { RPG_SERVER: puertoServerURL },
    },
    {
      command: `node --experimental-strip-types e2e/fake-smtp.ts ${smtpPort} ${smtpHttpPort}`,
      cwd: import.meta.dirname,
      url: `http://127.0.0.1:${smtpHttpPort}/`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `go run ./cmd/fakeoauth -addr 127.0.0.1:${fakeOAuthPort}`,
      cwd: `${import.meta.dirname}/../server`,
      url: `${fakeOAuthURL}/`,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command: `go run ./cmd/gameserver -http 127.0.0.1:${mailServerPort} -world "" -seed 1 -auth-rate-burst 1000 -metrics-addr ""`,
      cwd: `${import.meta.dirname}/../server`,
      url: `http://127.0.0.1:${mailServerPort}/healthz`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        DATABASE_URL: databaseUrl,
        PUBLIC_URL: mailClientURL,
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtpPort),
        SMTP_SECURITY: "none",
        SMTP_FROM: "Neque's Realm <noreply@rpg.test>",
        GOOGLE_CLIENT_ID: "fake-client-id",
        GOOGLE_CLIENT_SECRET: "fake-client-secret",
        GOOGLE_AUTH_URL: `${fakeOAuthURL}/google/authorize`,
        GOOGLE_TOKEN_URL: `${fakeOAuthURL}/google/token`,
        GOOGLE_JWKS_URL: `${fakeOAuthURL}/google/jwks`,
        GOOGLE_ISSUER: `${fakeOAuthURL}/google`,
        DISCORD_CLIENT_ID: "fake-client-id",
        DISCORD_CLIENT_SECRET: "fake-client-secret",
        DISCORD_AUTH_URL: `${fakeOAuthURL}/discord/authorize`,
        DISCORD_TOKEN_URL: `${fakeOAuthURL}/discord/token`,
        DISCORD_API_URL: `${fakeOAuthURL}/discord/api`,
      },
      stdout: "pipe",
    },
    {
      command: `pnpm exec vite --port ${mailClientPort} --strictPort`,
      cwd: import.meta.dirname,
      url: `${mailClientURL}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { RPG_SERVER: `http://127.0.0.1:${mailServerPort}` },
    },
  ],
});
